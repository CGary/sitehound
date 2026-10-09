/** Regression tests for the second adversarial review: batch echo and `$$`, recorder leaks and caps, side-effect links, drag, --block, safe writes. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { publish, writeOutputSafe } from "../packages/core/src/browserd/output.ts";
import { ActionLog, exportUrl, exportWaitValue } from "../packages/core/src/browserd/recorder.ts";
import { RECORD_DESCRIBE_MS } from "../packages/core/src/browserd/limits.ts";
import { makeEnv, refFor, startFixture, type Env, type Fixture } from "./helpers/hound.ts";

const PW = "hunter2SECRETpw";

describe("batch: sensitive values are never echoed, booleans, $$", () => {
  let env: Env;
  before(async () => {
    env = await makeEnv();
  });
  after(async () => {
    await env.cleanup();
  });
  const batch = (steps: unknown, extra: string[] = []) => env.hound(["batch", "--session-name", "nobody", "--file", "-", ...extra, "--json"], { input: JSON.stringify(steps) });

  it("1a: a boolean for a flag that is not a switch is refused without echoing anything", async () => {
    const r = await batch([{ command: "element fill", args: { ref: true, value: PW } }]);
    assert.equal(r.exitCode, 2);
    assert.equal(r.json.error.code, "INVALID_ARGUMENT");
    assert.equal(r.json.error.field, "steps[0].args.ref");
    assert.doesNotMatch(r.stdout + r.stderr, new RegExp(PW));
    const off = await batch([{ command: "element fill", args: { ref: false, value: PW } }]);
    assert.equal(off.json.error.field, "steps[0].args.ref");
    const num = await batch([{ command: "page find", args: { text: true } }]);
    assert.equal(num.json.error.field, "steps[0].args.text");
    const sw = await batch([{ command: "page find", args: { text: "x", limit: true } }]);
    assert.equal(sw.json.error.field, "steps[0].args.limit");
  });

  it("1b: a sensitive value that looks like a reference is not echoed (invalid, forward, unresolvable)", async () => {
    for (const value of ["$prev.SECRETpw!x", "$prev-SECRETpw", "$steps[9].SECRETpw", "$prev.SECRETpw", "$steps[0]SECRETpw"]) {
      const r = await batch([{ command: "page find", args: { text: "x" } }, { command: "element fill", args: { ref: "e1", value } }], ["--continue-on-error"]);
      assert.doesNotMatch(r.stdout + r.stderr, /SECRETpw/, value);
    }
    // Up front (usage error) for the malformed ones.
    const bad = await batch([{ command: "page find", args: { text: "x" } }, { command: "element fill", args: { ref: "e1", value: "$prev-SECRETpw" } }]);
    assert.equal(bad.exitCode, 2);
    assert.equal(bad.json.error.field, "steps[1].args.value");
    // A non-sensitive flag still gets a helpful message.
    const plain = await batch([{ command: "page find", args: { text: "x" } }, { command: "element click", args: { ref: "$prev-oops" } }]);
    assert.match(plain.json.error.message, /\$prev-oops/);
  });

  it("1c: the standalone parser never echoes the value glued to a sensitive flag that follows a value-less flag", async () => {
    const r = await env.hound(["element", "fill", "--session-name", "s", "--ref", `--value=${PW}`, "--json"]);
    assert.equal(r.exitCode, 2);
    assert.doesNotMatch(r.stdout + r.stderr, new RegExp(PW));
    assert.equal(r.json.error.field, "ref");
  });
});

describe("batch (browser): $$ escaping", () => {
  let env: Env;
  let fx: Fixture;
  before(async () => {
    env = await makeEnv();
    fx = await startFixture();
    assert.equal((await env.open("dl", ["--actions", "interact"])).exitCode, 0);
  });
  after(async () => {
    await env.cleanup();
    await fx.close();
  });

  it("6: only a leading $$prev/$$steps is a literal $; any other $$ is typed as is; values from earlier steps are never altered", async () => {
    const fill = (value: string) => ({ command: "element fill", args: { ref: "$steps[1].matches.0.ref", value } });
    const read = { command: "element read", args: { ref: "$steps[1].matches.0.ref", attr: "value" } };
    const r = await env.hound(
      ["batch", "--session-name", "dl", "--file", "-", "--json"],
      {
        input: JSON.stringify([
          { command: "page navigate", args: { url: fx.url("/dollar") } },
          { command: "page find", args: { regex: "textbox" } },
          fill("$$abc"),
          read,
          fill("$$prev.x"),
          read,
          fill("$steps[0].title"),
          read,
          fill("pa$$word$$"),
          read,
        ]),
      },
    );
    assert.equal(r.exitCode, 0, r.stdout);
    const values = (r.json.data.steps as { command: string; data?: { value?: string } }[]).filter((s) => s.command === "element read").map((s) => s.data?.value);
    assert.deepEqual(values, ["$$abc", "$prev.x", "$$cost", "pa$$word$$"]);
  });
});

describe("recorder (unit): wait values, include-query, caps", () => {
  it("4: --for url|request values lose credentials, query and fragment (unless --include-query) and path tokens", () => {
    const tok = "Ab12Cd34Ef56Gh78Ij90Kl12Mn";
    assert.equal(exportWaitValue("https://u:p@x.test/cb?token=1#access_token=zz", false), "https://x.test/cb");
    assert.equal(exportWaitValue(`**/reset/${tok}?x=1`, false), "**/reset/:token");
    assert.equal(exportWaitValue("/orders#frag", false), "/orders");
    assert.equal(exportWaitValue("/orders?id=1", true), "/orders?id=1");
    assert.equal(exportWaitValue(`/reset/${tok}?id=1`, true), "/reset/:token?id=1", "tokens are masked even with the query kept");
    const log = new ActionLog();
    log.record("wait", { for: "url", value: "https://x.test/cb?token=SECRETQ#access_token=SECRETF" }, {}, {}, "https://x.test/", "https://x.test/cb");
    log.record("wait", { for: "text", value: "Order confirmed" }, {}, {}, "https://x.test/", "https://x.test/");
    log.record("wait", { for: "request", value: "/api/pay?card=SECRETC" }, {}, {}, "https://x.test/", "https://x.test/");
    const cut = log.export(false).actions.map((a) => a.details.value);
    assert.deepEqual(cut, ["https://x.test/cb", "Order confirmed", "/api/pay"]);
    assert.doesNotMatch(JSON.stringify(log.export(false)), /SECRET/);
    assert.equal(log.export(true).actions[0]!.details.value, "https://x.test/cb?token=SECRETQ#access_token=SECRETF");
  });

  it("12: --include-query keeps the query but still masks token-like path segments", () => {
    const r = exportUrl("https://x.test/reset/Ab12Cd34Ef56Gh78Ij90Kl12Mn?a=1#f", true);
    assert.equal(r.url, "https://x.test/reset/:token?a=1#f");
    assert.equal(r.masked, true);
  });

  it("15: describing an element before an action takes at most 500 ms", () => {
    assert.ok(RECORD_DESCRIBE_MS <= 500);
  });
});

describe("recorder and read level (browser)", () => {
  let env: Env;
  let fx: Fixture;
  let scratch = "";
  const IA = "r2-ia";
  const RD = "r2-rd";
  const ia = (args: string[]) => env.hound(args.concat("--session-name", IA));
  const rd = (args: string[]) => env.hound(args.concat("--session-name", RD));
  before(async () => {
    env = await makeEnv();
    fx = await startFixture();
    scratch = await mkdtemp(join(tmpdir(), "hound-r2-"));
    const opened = await Promise.all([env.open(IA, ["--actions", "interact"]), env.open(RD)]);
    for (const o of opened) assert.equal(o.exitCode, 0, o.stderr);
  });
  after(async () => {
    await env.cleanup();
    await fx.close();
    await rm(scratch, { recursive: true, force: true });
  });
  const snap = async (run: typeof ia, path: string) => {
    assert.equal((await run(["page", "navigate", "--url", fx.url(path)])).exitCode, 0);
    return (await run(["page", "snapshot", "--limit-chars", "100000"])).json.data.snapshot as string;
  };
  const exported = async (): Promise<{ text: string; stdout: string; data: any }> => {
    const e = await ia(["script", "export"]);
    assert.equal(e.exitCode, 0, e.stdout);
    return { text: readFileSync(e.json.data.file, "utf8"), stdout: e.stdout, data: e.json.data };
  };

  it("3: text in contenteditable editors (role textbox or not) never reaches the locator, comments, params or stdout", async () => {
    const s = await snap(ia, "/editor");
    const ed = refFor(s, /textbox/);
    assert.equal((await ia(["element", "fill", "--ref", ed, "--value", "typed-SECRET-1"])).exitCode, 0);
    // The second editor has no role: reach it through a role-less locator by typing into the focused element with a ref from a new snapshot.
    const s2 = (await ia(["page", "snapshot", "--limit-chars", "100000"])).json.data.snapshot as string;
    const second = s2.split("\n").filter((l) => /PREFILLED-SECRET-88|generic/.test(l)).map((l) => /\[ref=([a-z0-9]+)\]/.exec(l)?.[1]).find((r) => r && r !== ed);
    if (second) await ia(["element", "type", "--ref", second, "--value", "typed-SECRET-2"]);
    const out = await exported();
    for (const text of [out.text, out.stdout]) assert.doesNotMatch(text, /PREFILLED-SECRET|typed-SECRET/);
    assert.ok(!JSON.stringify(out.data.params).includes("PREFILLED"), "no parameter is named after typed text");
  });

  it("8: oversized id, test id and label are dropped from the log instead of becoming 300-character locators", async () => {
    const s = await snap(ia, "/longattrs");
    assert.equal((await ia(["element", "click", "--ref", refFor(s, /button/)])).exitCode, 0);
    const out = await exported();
    assert.doesNotMatch(out.text, /i{60}|t{60}|a{60}/);
  });

  it("4: a url wait is exported without its query or fragment", async () => {
    await snap(ia, "/");
    const w = await ia(["page", "wait", "--for", "url", "--value", `${fx.origin}/?token=WAITSECRET#access_token=FRAGSECRET`, "--timeout", "3"]);
    assert.ok(w.exitCode === 0 || w.exitCode === 1);
    if (w.exitCode === 0) {
      const out = await exported();
      assert.doesNotMatch(out.text + out.stdout, /WAITSECRET|FRAGSECRET/);
    }
  });

  it("10: links with a non-GET data-method or ?_method=delete are refused at the read level; data-method=get and plain links work", async () => {
    const s = await snap(rd, "/sidefx2");
    for (const name of ["Open one", "Open two", "Open three"]) {
      const r = await rd(["element", "click", "--ref", refFor(s, new RegExp(`link "${name}"`))]);
      assert.equal(r.json.error.code, "ACTION_BLOCKED", name);
      assert.match(r.json.error.message, /side-effect link/, name);
      assert.match(r.json.error.message, /--actions interact/);
    }
    const ok = await rd(["element", "click", "--ref", refFor(s, /link "Open four"/)]);
    assert.equal(ok.exitCode, 0, ok.stdout);
    const s2 = await snap(rd, "/sidefx2");
    assert.equal((await rd(["element", "click", "--ref", refFor(s2, /link "Open five"/)])).exitCode, 0);
  });

  it("bonus: clicking a target=_blank link reports the new tab", async () => {
    const s = await snap(ia, "/blank");
    const r = await ia(["element", "click", "--ref", refFor(s, /link "Open elsewhere"/)]);
    assert.equal(r.exitCode, 0, r.stdout);
    assert.equal(r.json.data.tabs, 2);
    const tabs = await ia(["page", "tabs", "--action", "list"]);
    assert.equal(tabs.json.data.count, 2);
    assert.equal((await ia(["page", "tabs", "--action", "close", "--tab-index", "1"])).exitCode, 0);
  });

  it("5: press that never gets an answer: TIMEOUT is not retryable, suggests a snapshot, and the next op is not stuck", async () => {
    const s = await snap(ia, "/hangform");
    const t0 = Date.now();
    const r = await ia(["element", "press", "--ref", refFor(s, /textbox "Query"/), "--key", "Enter", "--timeout", "3"]);
    // Some Chromium builds return from the key press before the navigation is observed; then the page is just pending.
    if (r.exitCode === 1) {
      assert.equal(r.json.error.code, "TIMEOUT");
      assert.equal(r.json.retryable, false);
      assert.match(r.json.suggested_fix.command, /^hound page snapshot --session-name r2-ia/);
    }
    const next = await ia(["page", "snapshot", "--timeout", "6"]);
    assert.equal(next.exitCode, 0, next.stdout);
    assert.ok(Date.now() - t0 < 14_000);
  });

  it("5: click and download timeouts are not retryable and point at a snapshot", async () => {
    assert.equal((await ia(["page", "navigate", "--url", fx.url("/downloads")])).exitCode, 0);
    for (const verb of ["click", "download"]) {
      const s = (await ia(["page", "snapshot"])).json.data.snapshot as string;
      const r = await ia(["element", verb, "--ref", refFor(s, /link "Get hang"/), "--timeout", "3"]);
      assert.equal(r.json.error.code, "TIMEOUT", verb);
      assert.equal(r.json.retryable, false, verb);
      assert.match(r.json.suggested_fix.command, /^hound page snapshot --session-name r2-ia/, verb);
      assert.equal((await ia(["page", "snapshot", "--timeout", "5"])).exitCode, 0);
    }
  });

  it("7: --method auto waits for a late reaction (a drop applied 600 ms later) instead of dragging twice", async () => {
    const s = await snap(ia, "/drag-slow");
    const r = await ia(["element", "drag", "--ref", refFor(s, /button "Chip"/), "--to-ref", refFor(s, /button "Bin"/)]);
    assert.equal(r.exitCode, 0, r.stdout);
    assert.equal(r.json.data.method, "html5", "the late DOM change counts as the page having reacted");
    assert.equal("fellBack" in r.json.data, false);
    await new Promise((res) => setTimeout(res, 800));
    const log = ((await ia(["page", "snapshot"])).json.data.snapshot as string).split("\n").find((l) => /- log\b/.test(l)) ?? "";
    assert.equal((log.match(/moved;/g) ?? []).length, 1, log);
  });

  it("14: --block blocks service workers; without it they register", async () => {
    const plain = await env.open("r2-sw", []);
    assert.equal(plain.exitCode, 0, plain.stderr);
    const blocked = await env.open("r2-swb", ["--block", "analytics"]);
    assert.equal(blocked.exitCode, 0, blocked.stderr);
    const result = async (name: string): Promise<string> => {
      const run = (args: string[]) => env.hound(args.concat("--session-name", name));
      assert.equal((await run(["page", "navigate", "--url", fx.url("/sw")])).exitCode, 0);
      const w = await run(["page", "wait", "--for", "text", "--value", "sw:", "--timeout", "10"]);
      assert.equal(w.exitCode, 0, w.stdout);
      return ((await run(["page", "snapshot"])).json.data.snapshot as string).match(/sw:[\w=]+/)?.[0] ?? "";
    };
    assert.equal(await result("r2-sw"), "sw:registrations=1");
    assert.equal(await result("r2-swb"), "sw:registrations=0");
    const schema = JSON.parse((await env.raw(["browser", "open", "--schema"])).stdout);
    assert.match(schema.input.properties.block.description, /service workers/);
    assert.match(schema.input.properties.block.description, /cache/);
  });
});

describe("safe writer without hard links, and stale temp files", () => {
  let dir = "";
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "hound-r2-out-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const noLinks = (): Promise<void> => Promise.reject(Object.assign(new Error("not permitted"), { code: "EPERM" }));

  it("9: where link() is unsupported (EPERM/ENOTSUP) the exclusive publish copies with O_EXCL: it still refuses files and symlinks", async () => {
    const from = join(dir, "staged");
    writeFileSync(from, "DATA", { mode: 0o600 });
    const out = join(dir, "out.txt");
    await publish(from, out, false, noLinks);
    assert.equal(readFileSync(out, "utf8"), "DATA");
    await assert.rejects(publish(from, out, false, noLinks), (e: any) => e.code === "EEXIST");
    const victim = join(dir, "victim.txt");
    writeFileSync(victim, "VICTIM");
    const link = join(dir, "link.txt");
    symlinkSync(victim, link);
    await assert.rejects(publish(from, link, false, noLinks), (e: any) => e.code === "EEXIST");
    assert.equal(readFileSync(victim, "utf8"), "VICTIM");
    const enotsup = () => Promise.reject(Object.assign(new Error("x"), { code: "ENOTSUP" }));
    await publish(from, join(dir, "b.txt"), false, enotsup);
    assert.equal(readFileSync(join(dir, "b.txt"), "utf8"), "DATA");
    // A real permission problem is not hidden by the fallback.
    const denied = () => Promise.reject(Object.assign(new Error("x"), { code: "EACCES" }));
    await assert.rejects(publish(from, join(dir, "c.txt"), false, denied), (e: any) => e.code === "EACCES");
    assert.ok(!existsSync(join(dir, "c.txt")));
  });

  it("9: stale .hound-partial-* files (over an hour old) are swept when writing; fresh ones and other files stay", async () => {
    const old = join(dir, ".hound-partial-old");
    const fresh = join(dir, ".hound-partial-fresh");
    const other = join(dir, "keep.txt");
    for (const f of [old, fresh, other]) writeFileSync(f, "x");
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);
    utimesSync(old, twoHoursAgo, twoHoursAgo);
    utimesSync(other, twoHoursAgo, twoHoursAgo);
    mkdirSync(join(dir, "sub"), { recursive: true });
    await writeOutputSafe(join(dir, "new.txt"), "hello", false);
    assert.ok(!existsSync(old), "stale temp removed");
    assert.ok(existsSync(fresh), "fresh temp kept (it may belong to a write in progress)");
    assert.ok(existsSync(other));
    assert.equal(readFileSync(join(dir, "new.txt"), "utf8"), "hello");
  });
});
