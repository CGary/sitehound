/**
 * Core / browser-daemon hardening, exercised through the core API (no CLI) against an isolated
 * HOUND_HOME: pid-reuse safety, timeouts vs the op queue, read-level click policy, clamps, input
 * errors, redaction and HOUND_HOME bootstrap. Erasable TypeScript only (run natively by Node).
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import type * as CoreTypes from "../packages/core/src/index.ts";
import { isAlive, refFor } from "./helpers/hound.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_SRC = resolve(HERE, "..", "packages", "core", "src");
const HOME = mkdtempSync(join(tmpdir(), "hound-core-hardening-"));
process.env.HOUND_HOME = HOME;
delete process.env.DEBUG;

const core: typeof CoreTypes = await import("../packages/core/src/index.ts");
const { HoundError } = core;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const code = (c: string, extra: (e: CoreTypes.HoundError) => boolean = () => true) => (e: unknown) =>
  e instanceof HoundError && e.code === c && extra(e);

// ---------------------------------------------------------------------------------------------
// Local fixture
// ---------------------------------------------------------------------------------------------

const html = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

let server: Server;
let origin = "";
const bigTitle = "T".repeat(3_000_000);

before(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://fx").pathname;
    const send = (body: string) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(body);
    };
    if (path === "/slow") {
      setTimeout(() => send(html("Slow", "<h1>Slow</h1>")), 8000).unref();
      return;
    }
    if (path === "/bigtitle") return send(html(bigTitle, "<h1>Big</h1>"));
    if (path === "/policy") {
      return send(
        html(
          "Policy",
          `<h1 id="top">Policy</h1>
<a href="java&#9;script:document.title='pwned'">Tabbed script link</a>
<div role="link" tabindex="0" onclick="document.getElementById('f').submit()">Div link</div>
<a href="#top">Hash link</a>
<a href="/policy#section">Same page hash link</a>
<a href="mailto:a@b.co">Mail link</a>
<button type="button">Plain button</button>
<details><summary>More</summary><p>Hidden text</p></details>
<form id="f" action="/submitted" method="get"><a href="/about">Link in form</a></form>
<a href="/about">Normal link</a>`,
        ),
      );
    }
    if (path === "/about") return send(html("About", "<h1>About</h1>"));
    if (path === "/form") return send(html("Form", `<input type="number" id="n" aria-label="Quantity"><input type="text" aria-label="Name">`));
    if (path === "/other") return send(html("Other", "<h1>Other</h1>"));
    if (path === "/submitted") return send(html("Submitted", "<h1>Submitted</h1>"));
    if (path.startsWith("/a/a")) return send(html("Long URL", "<h1>Long</h1>"));
    send(html("Home", "<h1>Home</h1>"));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

const sessionPids = new Set<number>();
const extraProcs: ChildProcess[] = [];

async function openSession(name: string, actions: "read" | "interact" = "read") {
  const info = await core.openBrowserSession({ name, actions, display: "headless", idleTimeoutMinutes: 10, trace: "off" });
  sessionPids.add(info.pid);
  return info;
}

after(async () => {
  for (const name of readdirSync(join(HOME, "sessions")).filter((n) => !n.startsWith("."))) {
    await core.closeBrowserSession(name).catch(() => {});
  }
  for (const pid of sessionPids) {
    if (isAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
  for (const p of extraProcs) p.kill("SIGKILL");
  await new Promise<void>((ok) => {
    server.closeAllConnections();
    server.close(() => ok());
  });
  rmSync(HOME, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------
// 1. pid reuse
// ---------------------------------------------------------------------------------------------

describe("pid reuse: a pid in state.json is never signalled on its own", () => {
  function startSleeper(): ChildProcess {
    const p = spawn("sleep", ["600"], { stdio: "ignore" });
    extraProcs.push(p);
    return p;
  }
  function forge(name: string, pid: number, opts: { pidFileOnly?: boolean; old?: boolean } = {}): string {
    const dir = join(HOME, "sessions", name);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (opts.pidFileOnly) writeFileSync(join(dir, "pid"), String(pid), { mode: 0o600 });
    else {
      const state = { name, actions: "read", display: "headless", trace: "off", idleTimeoutMinutes: 10, pid, startedAt: new Date().toISOString(), socket: join(dir, "browserd.sock") };
      writeFileSync(join(dir, "state.json"), JSON.stringify(state), { mode: 0o600 });
    }
    if (opts.old) {
      const past = new Date(Date.now() - 10 * 60_000);
      utimesSync(dir, past, past);
    }
    return dir;
  }

  it("list / status / close clean a forged dir without killing the pid", async () => {
    const sleeper = startSleeper();
    const pid = sleeper.pid!;

    const dir1 = forge("forged1", pid);
    assert.deepEqual(await core.listBrowserSessions(), []);
    assert.ok(isAlive(pid), "list must not kill");
    assert.equal(existsSync(dir1), false, "list removes the dead dir");

    const dir2 = forge("forged2", pid);
    await assert.rejects(core.browserSessionStatus("forged2"), code("SESSION_NOT_FOUND"));
    assert.ok(isAlive(pid), "status must not kill");
    assert.equal(existsSync(dir2), false);

    const dir3 = forge("forged3", pid);
    assert.deepEqual(await core.closeBrowserSession("forged3"), { closed: false });
    assert.ok(isAlive(pid), "close must not kill");
    assert.equal(existsSync(dir3), false);

    const dir4 = forge("forged4", pid, { pidFileOnly: true, old: true });
    assert.deepEqual(await core.listBrowserSessions(), []);
    assert.ok(isAlive(pid), "a stale pid file must not kill");
    assert.equal(existsSync(dir4), false);

    sleeper.kill("SIGKILL");
  });

  it("open on a forged name succeeds after cleaning, and leaves the pid alone", async () => {
    const sleeper = startSleeper();
    const pid = sleeper.pid!;
    forge("forged5", pid);
    const info = await openSession("forged5");
    assert.notEqual(info.pid, pid);
    assert.ok(isAlive(pid), "open must not kill the forged pid");
    assert.ok(isAlive(info.pid));
    assert.deepEqual(await core.closeBrowserSession("forged5"), { closed: true });
    assert.ok(isAlive(pid));
    assert.equal(isAlive(info.pid), false);
    sleeper.kill("SIGKILL");
  });

  it("a real session passes the identity check: double open is SESSION_EXISTS", async () => {
    const info = await openSession("real1");
    await assert.rejects(openSession("real1"), code("SESSION_EXISTS"));
    assert.ok(isAlive(info.pid));
    const status = await core.browserSessionStatus("real1");
    assert.equal(status.pid, info.pid);
    await core.closeBrowserSession("real1");
    assert.equal(isAlive(info.pid), false);
  });
});

// ---------------------------------------------------------------------------------------------
// 2, 3, 4, 5: one read session and one interact session
// ---------------------------------------------------------------------------------------------

describe("browser daemon: timeouts, queue, click policy, clamps, input errors", () => {
  const R = "hard-read";
  const I = "hard-int";
  const call = <T = any>(name: string, op: CoreTypes.BrowserOp, params: Record<string, unknown> = {}, timeoutMs?: number) =>
    core.callBrowserSession<T>(name, op, params, timeoutMs ? { timeoutMs } : {});

  before(async () => {
    await openSession(R, "read");
    await openSession(I, "interact");
  });

  it("2. a request whose client timed out while queued never runs; the URL stays put", async () => {
    await call(R, "navigate", { url: `${origin}/` });
    // Blocker holds the queue for ~4 s; the navigate's client gives up at ~3 s (1 s + margin).
    const blocker = call(R, "wait", { for: "text", value: "never-appears", timeoutMs: 4000 }).catch((e) => e);
    await sleep(200);
    const t0 = Date.now();
    await assert.rejects(
      call(R, "navigate", { url: `${origin}/about` }, 1000),
      code("TIMEOUT", (e) => e.details.retryable === false && /within 1s/.test(e.message) && /run page snapshot before retrying/.test(e.message)),
    );
    assert.ok(Date.now() - t0 < 6000);
    const b = await blocker;
    assert.ok(b instanceof HoundError && b.code === "TIMEOUT", "the blocker times out on its own");
    await sleep(500); // give a wrongly-queued navigate the chance to run
    const status = await core.browserSessionStatus(R);
    assert.equal(status.currentUrl, `${origin}/`, "the skipped navigate must not have changed the URL");
    const log = readFileSync(join(HOME, "sessions", R, "daemon.log"), "utf8");
    assert.match(log, /op=navigate skipped/);
  });

  it("2. a request whose time ran out in the queue (client still there) is not started", async () => {
    await call(R, "navigate", { url: `${origin}/` });
    const blocker = call(R, "wait", { for: "text", value: "never-appears", timeoutMs: 2500 }).catch((e) => e);
    await sleep(200);
    await assert.rejects(
      call(R, "navigate", { url: `${origin}/about` }, 1000),
      code("TIMEOUT", (e) => /not started/.test(e.message) && e.details.retryable === true),
    );
    await blocker;
    assert.equal((await core.browserSessionStatus(R)).currentUrl, `${origin}/`);
  });

  it("2. an in-flight op ends by the client's timeout and the message quotes the user's value", async () => {
    const t0 = Date.now();
    await assert.rejects(
      call(R, "navigate", { url: `${origin}/slow` }, 1500),
      code("TIMEOUT", (e) => /^Timed out after 1\.5s waiting for/.test(e.message) && e.details.retryable === false && /snapshot/.test(e.message)),
    );
    assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
    // A read op keeps retryable: true and quotes the timeout too.
    await assert.rejects(
      call(R, "wait", { for: "text", value: "never-appears" }, 2000),
      code("TIMEOUT", (e) => /after 2s/.test(e.message) && e.details.retryable === true),
    );
    // The session survives.
    await call(R, "navigate", { url: `${origin}/about` });
  });

  it("3. read level: only http(s) links and <summary> can be clicked", async () => {
    await call(R, "navigate", { url: `${origin}/policy` });
    const { snapshot } = await call<{ snapshot: string }>(R, "snapshot", { limitChars: 50000 });
    const blockedLabels = [/Tabbed script link/, /Div link/, /Hash link/, /Same page hash link/, /Mail link/, /Plain button/, /Link in form/];
    for (const re of blockedLabels) {
      const ref = refFor(snapshot, re);
      await assert.rejects(call(R, "click", { ref }), code("ACTION_BLOCKED"), `${re} should be blocked`);
    }
    assert.equal((await core.browserSessionStatus(R)).currentUrl, `${origin}/policy`, "no blocked click navigated");
    await call(R, "click", { ref: refFor(snapshot, /^\s*- summary|More/) }).catch((e) => {
      assert.fail(`summary should be clickable: ${e instanceof Error ? e.message : String(e)}`);
    });
    const ok = await call(R, "click", { ref: refFor(snapshot, /Normal link/) });
    assert.equal(ok.url, `${origin}/about`);
    // Typing and forms stay blocked at read level.
    await assert.rejects(call(R, "fill", { ref: "e1", value: "x" }), code("ACTION_BLOCKED"));
  });

  it("4. page-controlled strings are clamped (3 MB title, 5 kB path)", async () => {
    const nav = await call(R, "navigate", { url: `${origin}/bigtitle` });
    assert.ok(nav.title.length <= 200, `navigate title ${nav.title.length}`);
    const tabs = await call(R, "tabs", { action: "list" });
    assert.ok(tabs.tabs.every((t: { title: string }) => t.title.length <= 200));
    const snap = await call(R, "snapshot", {});
    assert.ok(snap.title.length <= 200);
    assert.ok(JSON.stringify(snap).length < 100_000);

    const long = await call(R, "navigate", { url: `${origin}${"/a".repeat(2500)}` });
    assert.ok(long.url.length <= 2000, `url ${long.url.length}`);
    const status = await core.browserSessionStatus(R);
    assert.ok((status.currentUrl ?? "").length <= 2000);
  });

  it("4. daemon-side ranges: limit-chars, depth, limit, idle-timeout", async () => {
    const bad = (field: string) => code("INVALID_ARGUMENT", (e) => e.details.field === field);
    await assert.rejects(call(R, "snapshot", { limitChars: 0 }), bad("limit-chars"));
    await assert.rejects(call(R, "snapshot", { limitChars: 200_001 }), bad("limit-chars"));
    await assert.rejects(call(R, "snapshot", { depth: -1 }), bad("depth"));
    await assert.rejects(call(R, "snapshot", { depth: 1001 }), bad("depth"));
    await assert.rejects(call(R, "console", { limit: 0 }), bad("limit"));
    await assert.rejects(call(R, "console", { limit: 501 }), bad("limit"));
    await assert.rejects(call(R, "network", { limit: 501 }), bad("limit"));
    await call(R, "snapshot", { limitChars: 200_000, depth: 0 });
    for (const bogus of [0, 0.5, 1441, Number.NaN]) {
      await assert.rejects(
        core.openBrowserSession({ name: "idle-bad", actions: "read", display: "headless", idleTimeoutMinutes: bogus, trace: "off" }),
        bad("idle-timeout"),
      );
    }
    assert.equal(existsSync(join(HOME, "sessions", "idle-bad")), false);
  });

  it("5. filling a number input with text is INVALID_ARGUMENT (field value), never echoed", async () => {
    await call(I, "navigate", { url: `${origin}/form` });
    const { snapshot } = await call<{ snapshot: string }>(I, "snapshot", {});
    const ref = refFor(snapshot, /Quantity/);
    const secret = "NOT-A-NUMBER-xyzzy";
    let err: unknown;
    try {
      await call(I, "fill", { ref, value: secret }, 5000);
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof HoundError, "fill must fail");
    assert.equal(err.code, "INVALID_ARGUMENT");
    assert.equal(err.details.field, "value");
    assert.match(err.message, /type="number"/);
    assert.doesNotMatch(JSON.stringify(err.toJSON()), /xyzzy/);
    // A valid value still works.
    assert.deepEqual(await call(I, "fill", { ref, value: "42" }), { ref, chars: 2 });
  });

  it("5. --output pointing at an existing directory is INVALID_ARGUMENT (field output)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hound-out-dir-"));
    try {
      await assert.rejects(call(R, "snapshot", { output: dir }), code("INVALID_ARGUMENT", (e) => e.details.field === "output"));
      await assert.rejects(call(R, "screenshot", { output: dir }), code("INVALID_ARGUMENT", (e) => e.details.field === "output"));
      const file = join(dir, "snap.yml");
      const r = await call(R, "snapshot", { output: file });
      assert.equal(r.file, file);
      assert.equal(statSync(file).mode & 0o777, 0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("9. wording: ref and name errors state the rule", async () => {
    await assert.rejects(
      call(R, "click", { ref: "not a ref!" }),
      code("INVALID_ARGUMENT", (e) => e.message.includes("a ref from the latest page snapshot (e.g. e12 or f3e4)")),
    );
    await assert.rejects(call(R, "hover", { ref: "e99999" }), code("REF_NOT_FOUND", (e) => e.message.includes("e.g. e12 or f3e4")));
    const rule = "1-64 chars, letters/digits/._-, must start with a letter or digit";
    assert.throws(() => core.browserSessionDir("../x"), code("INVALID_ARGUMENT", (e) => e.message.includes(rule)));
    assert.throws(() => core.profilePath("-bad"), code("INVALID_ARGUMENT", (e) => e.message.includes(rule)));
  });

  it("6. a missing Chromium points at the absolute repo root", () => {
    const err = core.missingBrowserError();
    assert.equal(err.details.suggestedFix, `pnpm --dir ${core.REPO_ROOT} browsers`);
    assert.equal(err.details.retryable, false);
    assert.ok(core.isMissingBrowser("browserType.launch: Executable doesn't exist at /x/chrome"));
  });
});

// ---------------------------------------------------------------------------------------------
// 7. redaction
// ---------------------------------------------------------------------------------------------

describe("redact: secret-looking key/value pairs", () => {
  it("redactText scrubs key=value, key: value and JSON pairs", () => {
    const { redactText } = core;
    assert.equal(redactText("password=hunter2&next=1"), "password=[redacted]&next=1");
    assert.equal(redactText("login failed, passwd: s3cr3t ok"), "login failed, passwd: [redacted] ok");
    assert.equal(redactText('{"api_key":"sk-live-1","name":"bob"}'), '{"api_key":"[redacted]","name":"bob"}');
    assert.equal(redactText("session_id = 'abc123'"), "session_id = '[redacted]'");
    assert.equal(redactText("Authorization: Bearer abc.def.ghi"), "Authorization: [redacted]");
    assert.equal(redactText("cookie: a=1; b=2\nnext line"), "cookie: [redacted]\nnext line");
    assert.equal(redactText("client-secret=top&x-auth-token: t0k"), "client-secret=[redacted]&x-auth-token: [redacted]");
    assert.equal(redactText("credentials: user:pw"), "credentials: [redacted]");
    assert.equal(redactText("nothing to hide here, count: 3"), "nothing to hide here, count: 3");
  });

  it("redactData scrubs strings deeply but leaves non-secret keys and values alone", () => {
    const out = core.redactData({ a: "token=abc", list: ["secret: x", "fine"], n: 1, session: "kept-as-is" }) as Record<string, unknown>;
    assert.equal(out.a, "token=[redacted]");
    assert.deepEqual(out.list, ["secret: [redacted]", "fine"]);
    assert.equal(out.n, 1);
    assert.equal(out.session, "kept-as-is", "object keys are not treated as pairs, only text is");
  });

  it("is bounded: 1 MB of adversarial input stays well under a second", () => {
    const inputs = ["a".repeat(1_000_000), "token=x ".repeat(125_000), "a.-".repeat(333_333) + "password", `${"password".repeat(125_000)}`, "= ".repeat(500_000)];
    for (const text of inputs) {
      const t0 = Date.now();
      const out = core.redactText(text, 10_000_000);
      const ms = Date.now() - t0;
      assert.ok(ms < 1000, `took ${ms} ms`);
      assert.ok(out.length < 400_000, "input is capped at ~100 KB before expansion");
      const t1 = Date.now();
      core.redactData({ text });
      assert.ok(Date.now() - t1 < 1000);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 8. paths: .env before HOUND_HOME, and the HOUND_HOME .gitignore
// ---------------------------------------------------------------------------------------------

describe("paths", () => {
  /** A throwaway "repo" holding copies of paths.ts + errors.ts, so REPO_ROOT (and its .env) is ours. */
  function fakeRepo(envFile?: string): { root: string; script: string } {
    const root = mkdtempSync(join(tmpdir(), "hound-fake-repo-"));
    const src = join(root, "packages", "core", "src");
    mkdirSync(src, { recursive: true });
    for (const f of ["paths.ts", "errors.ts"]) copyFileSync(join(CORE_SRC, f), join(src, f));
    if (envFile !== undefined) writeFileSync(join(root, ".env"), envFile);
    const script = join(root, "print.ts");
    writeFileSync(script, `import { HOUND_HOME, REPO_ROOT } from "./packages/core/src/paths.ts";\nconsole.log(JSON.stringify({ HOUND_HOME, REPO_ROOT }));\n`);
    return { root, script };
  }
  function printHome(script: string, env: Record<string, string>): { HOUND_HOME: string; REPO_ROOT: string } {
    const clean: NodeJS.ProcessEnv = { ...process.env, ...env };
    if (!("HOUND_HOME" in env)) delete clean.HOUND_HOME;
    const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", script], { env: clean, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  }

  it("HOUND_HOME from <repo>/.env is honoured (relative values resolve against the repo)", () => {
    const { root, script } = fakeRepo("HOUND_HOME=from-dotenv\n");
    try {
      const out = printHome(script, {});
      assert.equal(out.HOUND_HOME, join(root, "from-dotenv"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a variable already set in the environment wins over .env", () => {
    const { root, script } = fakeRepo("HOUND_HOME=from-dotenv\n");
    try {
      const real = mkdtempSync(join(tmpdir(), "hound-env-wins-"));
      const out = printHome(script, { HOUND_HOME: real });
      assert.equal(out.HOUND_HOME, real);
      rmSync(real, { recursive: true, force: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a missing .env is fine and falls back to <repo>/.hound", () => {
    const { root, script } = fakeRepo();
    try {
      assert.equal(printHome(script, {}).HOUND_HOME, join(root, ".hound"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ensurePrivateDir creates .gitignore with `*`, appends when missing the line, never overwrites", async () => {
    const ignore = join(core.HOUND_HOME, ".gitignore");
    rmSync(ignore, { force: true });
    await core.ensurePrivateDir(join(core.HOUND_HOME, "gi-a"));
    assert.equal(readFileSync(ignore, "utf8"), "*\n");

    // exists with `*` among other lines: untouched
    writeFileSync(ignore, "# mine\n*\nkeep-me\n");
    await core.ensurePrivateDir(join(core.HOUND_HOME, "gi-b"));
    assert.equal(readFileSync(ignore, "utf8"), "# mine\n*\nkeep-me\n");

    // exists without it (no trailing newline): `*` appended on its own line
    writeFileSync(ignore, "node_modules");
    await core.ensurePrivateDir(join(core.HOUND_HOME, "gi-c"));
    assert.equal(readFileSync(ignore, "utf8"), "node_modules\n*\n");

    // `*.log` is not `*`
    writeFileSync(ignore, "*.log\n");
    await core.ensurePrivateDir(join(core.HOUND_HOME, "gi-d"));
    assert.equal(readFileSync(ignore, "utf8"), "*.log\n*\n");

    // idempotent
    await core.ensurePrivateDir(join(core.HOUND_HOME, "gi-e"));
    assert.equal(readFileSync(ignore, "utf8"), "*.log\n*\n");
  });
});
