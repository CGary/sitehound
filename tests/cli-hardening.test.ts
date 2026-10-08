/** CLI hardening: scrubbing, envelope guarantee, schema = validation, enum fixes, placeholders, profile login, --output, flag parsing. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { HoundError } from "../packages/core/src/errors.ts";
import { scrubSecret } from "../packages/cli/src/commands/browser-shared.ts";
import { readFileAction } from "../packages/cli/src/commands/shared.ts";
import { REPO_ROOT, makeEnv, parseSingleJson, startFixture, writeSyntheticProfile, type Env, type Fixture } from "./helpers/hound.ts";

const schemaOf = async (env: Env, cmd: string[]) => JSON.parse((await env.raw([...cmd, "--schema"])).stdout);

describe("scrubSecret", () => {
  const boom = (message: string, suggestedFix?: string) => new HoundError("REF_NOT_FOUND", message, { suggestedFix, received: message });
  const scrub = (err: unknown, secret: string): HoundError => {
    try {
      scrubSecret(err, secret);
    } catch (e) {
      return e as HoundError;
    }
    throw new Error("scrubSecret must throw");
  };

  it("scrubs values of 8+ chars everywhere", () => {
    const e = scrub(boom("bad hunter2hunter2 here", "hound x --value hunter2hunter2"), "hunter2hunter2");
    assert.equal(e.message, "bad [redacted] here");
    assert.equal(e.details.suggestedFix, "hound x --value [redacted]");
    assert.equal(e.details.received, "bad [redacted] here");
  });

  it("never touches words when the value is short", () => {
    for (const secret of ["a", "e", "ref", "in", "1234567"]) {
      const original = boom("The ref e12 is not in the snapshot; take a new one", "hound page snapshot --session-name demo --json");
      const e = scrub(original, secret);
      assert.equal(e, original, `secret "${secret}"`);
      assert.equal(e.message, "The ref e12 is not in the snapshot; take a new one");
      assert.equal(e.details.suggestedFix, "hound page snapshot --session-name demo --json");
    }
  });

  it("rethrows non-Hound errors untouched", () => {
    const plain = new Error("x");
    assert.equal(scrub(plain, "longsecret123") as unknown, plain);
  });
});

describe("next actions never suggest cat on big files", () => {
  it("small file: cat; big file: head -c 20000 with a size note", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hound-cat-"));
    const small = join(dir, "small.yml");
    const big = join(dir, "big file.yml");
    await writeFile(small, "x".repeat(100));
    await writeFile(big, "y".repeat(50_000));
    assert.equal(readFileAction(small, "r").command, `cat ${small}`);
    const a = readFileAction(big, "Read it.");
    assert.equal(a.command, `head -c 20000 '${big}'`);
    assert.match(a.reason, /50 KB/);
    assert.ok(!/^cat /.test(a.command));
  });
});

describe("envelope guarantee", () => {
  let env: Env;
  let fx: Fixture;
  let dir: string;
  const SCRIPTS: Record<string, string> = {
    exit3: `export default async ({ page, url }) => {
  await page.goto(url);
  process.exit(3);
};
`,
    exitCaught: `export default async ({ page, url }) => {
  await page.goto(url);
  try { process.exit(0); } catch (e) { console.log("swallowed", e.message); }
  return { summary: "survived" };
};
`,
    lateThrow: `export default async ({ page, url }) => {
  await page.goto(url);
  setTimeout(() => { throw new Error("late boom in a timer"); }, 100);
  await new Promise((r) => setTimeout(r, 5000));
  return { summary: "should not get here" };
};
`,
    lateExit: `export default async ({ page, url }) => {
  await page.goto(url);
  setTimeout(() => process.exit(0), 100);
  await new Promise((r) => setTimeout(r, 5000));
};
`,
    rejection: `export default async ({ page, url }) => {
  await page.goto(url);
  setTimeout(() => { Promise.reject(new Error("unhandled boom")); }, 100);
  await new Promise((r) => setTimeout(r, 5000));
};
`,
    sleeper: `export default async ({ page, url }) => {
  await page.goto(url);
  console.log("READY-TO-BE-KILLED");
  await new Promise((r) => setTimeout(r, 60000));
};
`,
  };
  before(async () => {
    env = await makeEnv();
    fx = await startFixture();
    dir = join(env.cwd, "scripts");
    await mkdir(dir);
    for (const [name, src] of Object.entries(SCRIPTS)) await writeFile(join(dir, `${name}.mjs`), src);
  });
  after(async () => {
    await fx.close();
    await env.cleanup();
  });

  const run = (name: string) => env.hound(["script", "run", "--file", join(dir, `${name}.mjs`), "--url", fx.url("/")], { timeoutMs: 60_000 });

  it("process.exit(3) in a script: one RUN_ERROR envelope, exit 1, run dir in data", async () => {
    const r = await run("exit3");
    assert.equal(r.exitCode, 1, r.stderr);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.error.code, "RUN_ERROR");
    assert.match(r.json.data.error.message, /script called process\.exit\(3\)/);
    assert.ok(existsSync(r.json.data.runDir));
  });

  it("process.exit swallowed by the script cannot kill the CLI (restored afterwards)", async () => {
    const r = await run("exitCaught");
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.json.ok, true);
  });

  it("a late throw in a timer: exactly one JSON envelope, exit 1", async () => {
    const r = await run("lateThrow");
    assert.equal(r.exitCode, 1, r.stderr);
    assert.equal(parseSingleJson(r.stdout).ok, false);
    assert.equal(r.json.error.code, "RUN_ERROR");
    assert.match(r.json.error.message, /late boom in a timer/);
    assert.ok(r.json.data.runDir && existsSync(r.json.data.runDir), "run dir path in data");
    assert.equal(r.stdout.trim().split("\n").length, 1);
  });

  it("a process.exit from a timer is intercepted into one envelope too", async () => {
    const r = await run("lateExit");
    assert.equal(r.exitCode, 1, r.stderr);
    assert.equal(r.json.error.code, "RUN_ERROR");
    assert.match(r.json.error.message, /process\.exit\(0\)/);
  });

  it("an unhandled rejection: one envelope, exit 1", async () => {
    const r = await run("rejection");
    assert.equal(r.exitCode, 1, r.stderr);
    assert.equal(r.json.error.code, "RUN_ERROR");
    assert.match(r.json.error.message, /unhandled boom/);
  });

  it("SIGTERM during a run: one RUN_ERROR envelope, exit 1 (never 143 or 130)", async () => {
    const child = spawn(process.execPath, [join(REPO_ROOT, "packages", "cli", "src", "index.ts"), "script", "run", "--file", join(dir, "sleeper.mjs"), "--url", fx.url("/")], {
      cwd: env.cwd,
      env: { ...process.env, HOUND_HOME: env.home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (c: string) => (stdout += c));
    const ready = new Promise<void>((ok, bad) => {
      const timer = setTimeout(() => bad(new Error(`script never became ready\n${stderr.slice(-500)}`)), 50_000);
      child.stderr.setEncoding("utf8").on("data", (c: string) => {
        stderr += c;
        if (stderr.includes("READY-TO-BE-KILLED")) {
          clearTimeout(timer);
          ok();
        }
      });
    });
    const closed = new Promise<number | null>((ok) => child.on("close", (code) => ok(code)));
    try {
      await ready;
    } catch (err) {
      child.kill("SIGKILL");
      throw err;
    }
    child.kill("SIGTERM");
    const code = await closed;
    assert.equal(code, 1, stderr.slice(-500));
    const env1 = parseSingleJson(stdout);
    assert.equal(env1.ok, false);
    assert.equal(env1.error.code, "RUN_ERROR");
    assert.match(env1.error.message, /SIGTERM/);
    assert.ok(env1.data.runDir);
    assert.ok(!existsSync(join(env1.data.runDir, ".raw")), "no raw trace left behind");
  });
});

describe("schema = validation", () => {
  let env: Env;
  before(async () => {
    env = await makeEnv();
  });
  after(async () => {
    await env.cleanup();
  });

  it("--schema declares ranges, patterns and maxLength", async () => {
    const snap = await schemaOf(env, ["page", "snapshot"]);
    assert.deepEqual([snap.input.properties["limit-chars"].minimum, snap.input.properties["limit-chars"].maximum, snap.input.properties["limit-chars"].default], [1, 200000, 8000]);
    assert.deepEqual([snap.input.properties.depth.minimum, snap.input.properties.depth.maximum], [0, 1000]);
    assert.deepEqual(snap.input.properties["if-exists"].enum, ["error", "overwrite"]);
    assert.equal(snap.input.properties["if-exists"].default, "error");
    const session = snap.input.properties["session-name"];
    assert.equal(session.pattern, "^[a-z0-9][a-z0-9._-]{0,63}$");
    assert.equal(session.pattern_flags, "i");
    assert.equal(session.maxLength, 64);
    const open = await schemaOf(env, ["browser", "open"]);
    assert.deepEqual([open.input.properties["idle-timeout"].minimum, open.input.properties["idle-timeout"].maximum], [1, 1440]);
    assert.equal(open.input.properties.profile.pattern, "^[a-z0-9][a-z0-9._-]{0,63}$");
    for (const cmd of [["diag", "console"], ["diag", "network"]]) {
      const s = await schemaOf(env, cmd);
      assert.deepEqual([s.input.properties.limit.minimum, s.input.properties.limit.maximum], [1, 500]);
    }
    const click = await schemaOf(env, ["element", "click"]);
    assert.ok(click.input.properties.ref.pattern);
    assert.match(click.input.properties.ref.description, /e12 or f3e4/);
  });

  it("--schema declares conditional requirements and one-of groups", async () => {
    const shot = await schemaOf(env, ["page", "screenshot"]);
    assert.deepEqual(shot.input.conditional[0], { when: { scope: "element" }, require: ["ref"] });
    const wait = await schemaOf(env, ["page", "wait"]);
    assert.ok(wait.input.conditional.some((r: any) => r.require?.includes("value") && r.when.for.join() === "text,url,ref"));
    const tabs = await schemaOf(env, ["page", "tabs"]);
    assert.ok(tabs.input.conditional.some((r: any) => r.when.action === "new" && r.require.includes("url")));
    assert.ok(tabs.input.conditional.some((r: any) => Array.isArray(r.when.action) && r.when.action.join() === "select,close" && r.require.includes("tab-index")));
    const del = await schemaOf(env, ["profile", "delete"]);
    assert.deepEqual(del.input.one_of, [["dry-run", "yes"]]);
    const fill = await schemaOf(env, ["element", "fill"]);
    assert.deepEqual(fill.input.one_of, [["value", "value-file"]]);
    const select = await schemaOf(env, ["element", "select"]);
    assert.ok(select.input.required.includes("option"));
    assert.equal(select.input.properties.option.type, "array");
  });

  // Every violation must fail with exit 2 BEFORE any daemon call: the session does not exist, so a daemon call would be exit 1.
  const violations: [string, string[], string, string][] = [
    ["limit-chars 0", ["page", "snapshot", "--limit-chars", "0"], "INVALID_ARGUMENT", "limit-chars"],
    ["limit-chars too big", ["page", "snapshot", "--limit-chars", "200001"], "INVALID_ARGUMENT", "limit-chars"],
    ["depth 1001", ["page", "snapshot", "--depth", "1001"], "INVALID_ARGUMENT", "depth"],
    ["depth negative", ["page", "snapshot", "--depth=-1"], "INVALID_ARGUMENT", "depth"],
    ["limit 0", ["diag", "console", "--limit", "0"], "INVALID_ARGUMENT", "limit"],
    ["limit 501", ["diag", "network", "--limit", "501"], "INVALID_ARGUMENT", "limit"],
    ["scope element without ref", ["page", "screenshot", "--scope", "element"], "MISSING_REQUIRED_FLAG", "ref"],
    ["ref with viewport scope", ["page", "screenshot", "--ref", "e1"], "INVALID_ARGUMENT", "ref"],
    ["wait text without value", ["page", "wait", "--for", "text"], "MISSING_REQUIRED_FLAG", "value"],
    ["wait load with bad value", ["page", "wait", "--for", "load", "--value", "soon"], "INVALID_ENUM", "value"],
    ["tabs new without url", ["page", "tabs", "--action", "new"], "MISSING_REQUIRED_FLAG", "url"],
    ["tabs select without index", ["page", "tabs", "--action", "select"], "MISSING_REQUIRED_FLAG", "tab-index"],
    ["tabs close without index", ["page", "tabs", "--action", "close"], "MISSING_REQUIRED_FLAG", "tab-index"],
    ["select without option", ["element", "select", "--ref", "e1"], "MISSING_REQUIRED_FLAG", "option"],
    ["fill without value", ["element", "fill", "--ref", "e1"], "MISSING_REQUIRED_FLAG", "value|value-file"],
    ["ref not a ref", ["element", "click", "--ref", "button"], "INVALID_ARGUMENT", "ref"],
    ["bad session name", ["page", "reload", "--session-name", "Bad Name!"], "INVALID_ARGUMENT", "session-name"],
    ["session name too long", ["page", "reload", "--session-name", "a".repeat(65)], "INVALID_ARGUMENT", "session-name"],
  ];
  for (const [label, args, code, field] of violations) {
    it(`violation exits 2 before the daemon: ${label}`, async () => {
      const full = args.some((a) => a.startsWith("--session-name")) ? args : [...args.slice(0, 2), "--session-name", "ghost", ...args.slice(2)];
      const r = await env.hound(full);
      assert.equal(r.exitCode, 2, r.stdout);
      assert.equal(r.json.error.code, code);
      assert.equal(r.json.error.field, field);
    });
  }

  it("idle-timeout range and the name pattern message", async () => {
    for (const v of ["0", "1441"]) {
      const r = await env.hound(["browser", "open", "--session-name", "demo", "--idle-timeout", v]);
      assert.equal(r.exitCode, 2);
      assert.equal(r.json.error.field, "idle-timeout");
      assert.match(r.json.error.message, /between 1 and 1440/);
    }
    const bad = await env.hound(["browser", "open", "--session-name", "-x"]);
    assert.equal(bad.exitCode, 2);
    const name = await env.hound(["browser", "open", "--session-name", "UPPER lower"]);
    assert.equal(name.exitCode, 2);
    assert.match(name.json.error.message, /\^\[a-z0-9\]\[a-z0-9\._-\]\{0,63\}\$/);
    assert.match(name.json.error.message, /case-insensitive/);
    const profile = await env.hound(["profile", "check", "--profile", "../etc"]);
    assert.equal(profile.exitCode, 2);
    assert.equal(profile.json.error.field, "profile");
  });

  it("profile delete needs exactly one of --dry-run | --yes (CONFIRMATION_REQUIRED, exit 2)", async () => {
    const none = await env.hound(["profile", "delete", "--profile", "ghost"]);
    assert.equal(none.exitCode, 2);
    assert.equal(none.json.error.code, "CONFIRMATION_REQUIRED");
    assert.equal(none.json.data.alternatives.length, 2);
    const both = await env.hound(["profile", "delete", "--profile", "ghost", "--yes", "--dry-run"]);
    assert.equal(both.exitCode, 2);
    assert.equal(both.json.error.code, "INVALID_ARGUMENT");
  });

  it("valid values pass validation (the daemon is reached: SESSION_NOT_FOUND, exit 1)", async () => {
    const r = await env.hound(["page", "snapshot", "--session-name", "ghost", "--limit-chars", "200000", "--depth", "0"]);
    assert.equal(r.exitCode, 1);
    assert.equal(r.json.error.code, "SESSION_NOT_FOUND");
  });
});

describe("INVALID_ENUM suggests the nearest value", () => {
  let env: Env;
  before(async () => {
    env = await makeEnv();
  });
  after(async () => {
    await env.cleanup();
  });

  it("interactive -> interact (not the default)", async () => {
    const r = await env.hound(["browser", "open", "--session-name", "demo", "--actions", "interactive"]);
    assert.equal(r.exitCode, 2);
    assert.equal(r.json.error.code, "INVALID_ENUM");
    assert.deepEqual(r.json.error.allowed, ["read", "interact"]);
    assert.match(r.json.suggested_fix.command, /--actions interact --json$/);
    assert.ok(!/--actions read/.test(r.json.suggested_fix.command));
  });

  it("typos: networkidl -> networkidle, ful -> full", async () => {
    const nav = await env.hound(["page", "navigate", "--session-name", "demo", "--url", "https://example.com", "--wait-until", "networkidl"]);
    assert.match(nav.json.suggested_fix.command, /--wait-until networkidle/);
    const shot = await env.hound(["page", "screenshot", "--session-name", "demo", "--scope", "ful"]);
    assert.match(shot.json.suggested_fix.command, /--scope full/);
  });

  it("nothing close (left): lists the allowed values and suggests no command", async () => {
    const r = await env.hound(["page", "scroll", "--session-name", "demo", "--direction", "left", "--amount", "page"]);
    assert.equal(r.exitCode, 2);
    assert.equal(r.json.error.code, "INVALID_ENUM");
    assert.deepEqual(r.json.error.allowed, ["up", "down"]);
    assert.equal(r.json.suggested_fix, undefined);
  });
});

describe("shell-safe placeholders and NO_TTY", () => {
  let env: Env;
  let fx: Fixture;
  before(async () => {
    env = await makeEnv();
    fx = await startFixture();
  });
  after(async () => {
    await fx.close();
    await env.cleanup();
  });

  it("suggested fixes quote placeholders in double quotes", async () => {
    const r = await env.hound(["element", "click", "--session-name", "demo"]);
    assert.equal(r.json.error.code, "MISSING_REQUIRED_FLAG");
    assert.match(r.json.suggested_fix.command, /--ref "<ref>"/);
    const wait = await env.hound(["page", "wait", "--session-name", "demo", "--for", "text"]);
    assert.match(wait.json.suggested_fix.command, /--value "<value>"/);
    assert.ok(!/ <[a-z]/.test(wait.json.suggested_fix.command), "no bare <placeholder>");
  });

  it("next_actions placeholders are quoted and the reason says to replace them", async () => {
    const r = await env.hound(["profile", "list"]);
    const a = r.json.next_actions[0];
    assert.match(a.command, /--profile "<profile>" --url "<url>"/);
    assert.match(a.reason, /replace/i);
    const t = await env.hound(["task", "list"]);
    assert.match(t.json.next_actions[0].command, /--url "<url>"/);
    assert.match(t.json.next_actions[0].reason, /replace/i);
  });

  it("profile login without a TTY: NO_TTY, not retryable, no command to retry, message carries the human command", async () => {
    const r = await env.hound(["profile", "login", "--profile", "work", "--url", fx.url("/login")]);
    assert.equal(r.exitCode, 1);
    assert.equal(r.json.error.code, "NO_TTY");
    assert.equal(r.json.retryable, false);
    assert.equal(r.json.suggested_fix, undefined);
    assert.equal(r.json.error.message, `A human must run this in a terminal: hound profile login --profile work --url ${fx.url("/login")}`);
  });
});

describe("profile login on an existing profile, and legacy forget", () => {
  let env: Env;
  let fx: Fixture;
  before(async () => {
    env = await makeEnv();
    fx = await startFixture();
    await writeSyntheticProfile(env.home, "synth", fx.url("/"));
  });
  after(async () => {
    await fx.close();
    await env.cleanup();
  });

  it("without an explicit --mode: CONFIRMATION_REQUIRED (exit 2) with extend as the fix and both options", async () => {
    const r = await env.hound(["profile", "login", "--profile", "synth", "--url", fx.url("/login")]);
    assert.equal(r.exitCode, 2);
    assert.equal(r.json.error.code, "CONFIRMATION_REQUIRED");
    assert.equal(r.json.error.field, "mode");
    assert.match(r.json.error.message, /extend/);
    assert.match(r.json.error.message, /replace/);
    assert.match(r.json.suggested_fix.command, /--mode extend/);
    const alts: string[] = r.json.data.alternatives;
    assert.equal(alts.length, 2);
    assert.ok(alts.some((c) => /--mode extend/.test(c)) && alts.some((c) => /--mode replace/.test(c)));
  });

  it("with an explicit --mode it moves on (no TTY here: NO_TTY, nothing changed)", async () => {
    for (const mode of ["extend", "replace"]) {
      const r = await env.hound(["profile", "login", "--profile", "synth", "--url", fx.url("/login"), "--mode", mode]);
      assert.equal(r.exitCode, 1);
      assert.equal(r.json.error.code, "NO_TTY");
    }
    assert.ok(existsSync(join(env.home, "profiles", "synth.json")));
  });

  it("legacy `forget <name>` only previews; --yes deletes", async () => {
    const dry = await env.hound(["forget", "synth"]);
    assert.equal(dry.exitCode, 0, dry.stderr);
    assert.equal(dry.json.data.dry_run, true);
    assert.match(dry.stderr, /only previews/);
    assert.ok(existsSync(join(env.home, "profiles", "synth.json")), "still there");
    const real = await env.hound(["forget", "synth", "--yes"]);
    assert.equal(real.exitCode, 0, real.stderr);
    assert.equal(real.json.data.dry_run, false);
    assert.ok(!existsSync(join(env.home, "profiles", "synth.json")));
  });
});

describe("--output / --if-exists", () => {
  let env: Env;
  before(async () => {
    env = await makeEnv();
    await writeFile(join(env.cwd, "exists.yml"), "keep me");
    await mkdir(join(env.cwd, "adir"));
    await symlink(join(env.cwd, "exists.yml"), join(env.cwd, "link.yml"));
  });
  after(async () => {
    await env.cleanup();
  });

  const snap = (out: string, extra: string[] = []) => env.hound(["page", "snapshot", "--session-name", "ghost", "--output", out, ...extra]);

  it("--if-exists is in the schema with default error", async () => {
    const s = await schemaOf(env, ["page", "snapshot"]);
    assert.equal(s.input.properties["if-exists"].default, "error");
  });

  it("existing file: CONFLICT (exit 1) with an overwrite fix, resolved against the cwd; file untouched", async () => {
    const r = await snap("exists.yml");
    assert.equal(r.exitCode, 1);
    assert.equal(r.json.error.code, "CONFLICT");
    assert.equal(r.json.error.received, join(env.cwd, "exists.yml"));
    assert.match(r.json.suggested_fix.command, /--if-exists overwrite/);
    assert.equal(readFileSync(join(env.cwd, "exists.yml"), "utf8"), "keep me");
  });

  it("--if-exists overwrite passes the check (the daemon is reached: SESSION_NOT_FOUND)", async () => {
    const r = await snap("exists.yml", ["--if-exists", "overwrite"]);
    assert.equal(r.json.error.code, "SESSION_NOT_FOUND");
  });

  it("a new path passes the check", async () => {
    const r = await snap("fresh.yml");
    assert.equal(r.json.error.code, "SESSION_NOT_FOUND");
  });

  it("page screenshot --output applies the same rules", async () => {
    const base = ["page", "screenshot", "--session-name", "ghost", "--output"];
    const exists = await env.hound([...base, "exists.yml"]);
    assert.equal(exists.json.error.code, "CONFLICT");
    const dir = await env.hound([...base, "adir"]);
    assert.equal(dir.exitCode, 2);
    const ok = await env.hound([...base, "new.png"]);
    assert.equal(ok.json.error.code, "SESSION_NOT_FOUND");
  });

  it("a directory is refused, even with overwrite", async () => {
    for (const extra of [[], ["--if-exists", "overwrite"]]) {
      const r = await snap("adir", extra);
      assert.equal(r.exitCode, 2);
      assert.equal(r.json.error.code, "INVALID_ARGUMENT");
      assert.match(r.json.error.message, /directory/);
    }
  });

  it("a symlink at the final path is refused, even with overwrite", async () => {
    for (const extra of [[], ["--if-exists", "overwrite"]]) {
      const r = await snap("link.yml", extra);
      assert.equal(r.exitCode, 2);
      assert.equal(r.json.error.code, "INVALID_ARGUMENT");
      assert.match(r.json.error.message, /symlink/);
    }
    assert.equal(readFileSync(join(env.cwd, "exists.yml"), "utf8"), "keep me");
  });
});

describe("flag parsing", () => {
  let env: Env;
  before(async () => {
    env = await makeEnv();
  });
  after(async () => {
    await env.cleanup();
  });

  it("`--value -h` is a value problem, not a help request", async () => {
    const r = await env.raw(["element", "fill", "--session-name", "demo", "--ref", "e1", "--value", "-h", "--json"]);
    assert.equal(r.exitCode, 2);
    assert.ok(!/Flags:/.test(r.stdout), "help text must not be printed");
    const json = parseSingleJson(r.stdout);
    assert.equal(json.error.field, "value");
    assert.match(json.error.message, /--value=/);
  });

  it("a flag followed by a dash-token fails with the --flag=value form in the fix", async () => {
    const r = await env.hound(["page", "wait", "--session-name", "demo", "--for", "text", "--value", "-5%"]);
    assert.equal(r.exitCode, 2);
    assert.equal(r.json.error.code, "INVALID_ARGUMENT");
    assert.equal(r.json.error.field, "value");
    assert.match(r.json.suggested_fix.command, /--value "<value>"|--value=/);
    const arg = await env.hound(["task", "run", "--task", "snapshot", "--url", "https://example.com", "--arg", "-x=1"]);
    assert.equal(arg.exitCode, 2);
    assert.match(arg.json.suggested_fix.command, /--arg=-x=1/);
  });

  it("--flag=-value is accepted as a value", async () => {
    const r = await env.hound(["page", "wait", "--session-name", "ghost", "--for", "text", "--value=-5%"]);
    assert.equal(r.exitCode, 1);
    assert.equal(r.json.error.code, "SESSION_NOT_FOUND");
  });

  it("a flag followed by another flag says it needs a value", async () => {
    const r = await env.hound(["page", "navigate", "--session-name", "demo", "--url", "--json"]);
    assert.equal(r.exitCode, 2);
    assert.equal(r.json.error.field, "url");
  });

  it("a bare `-` still means stdin for --value-file", async () => {
    const r = await env.hound(["element", "fill", "--session-name", "ghost", "--ref", "e1", "--value-file", "-"], { input: "text" });
    assert.equal(r.json.error.code, "SESSION_NOT_FOUND");
  });

  it("-h and --help still print help", async () => {
    for (const h of ["-h", "--help"]) {
      const r = await env.raw(["page", "snapshot", h]);
      assert.equal(r.exitCode, 0);
      assert.match(r.stdout, /Flags:/);
    }
  });
});

describe("help wording", () => {
  let env: Env;
  before(async () => {
    env = await makeEnv();
  });
  after(async () => {
    await env.cleanup();
  });

  it("refs are e12 or f3e4 and the read level is described accurately", async () => {
    const click = (await env.raw(["element", "click", "--help"])).stdout;
    assert.match(click, /e12 or f3e4/);
    assert.match(click, /http\(s\) links and <summary>/);
    assert.match(click, /\/logout/);
    const open = (await env.raw(["browser", "open", "--help"])).stdout;
    assert.match(open, /real http\(s\) links and <summary>/);
    assert.match(open, /not detected/);
  });
});
