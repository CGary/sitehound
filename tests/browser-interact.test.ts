/** Browser sessions at the `interact` level: fill/select/press, diagnostics, timeouts, refs, trace export. */
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { readZipEntry, readZipIndex } from "../packages/core/src/zip.ts";
import { isAlive, makeEnv, refFor, startFixture, type Env, type Fixture } from "./helpers/hound.ts";

const S = "act1";
const mode = (p: string) => statSync(p).mode & 0o777;

describe("browser session (interact level)", () => {
  let env: Env;
  let fx: Fixture;
  let pid = 0;
  const refs: Record<string, string> = {};

  before(async () => {
    env = await makeEnv();
    fx = await startFixture();
    const open = await env.open(S, ["--actions", "interact", "--trace", "on"]);
    assert.equal(open.exitCode, 0, open.stderr);
    assert.equal(open.json.data.actions, "interact");
    assert.equal(open.json.data.trace, "on");
    pid = open.json.data.pid;
  });
  after(async () => {
    await env.cleanup(); // closes the session even when a test failed, then asserts no daemon/session dir is left
    await fx.close();
  });

  const run = (args: string[], opts?: { input?: string }) => env.hound(args.concat("--session-name", S), opts);

  it("fill via --value-file - (stdin): value never echoed, trailing newline dropped", async () => {
    await run(["page", "navigate", "--url", `${fx.url("/form")}?token=SECRET`]);
    const snap = await run(["page", "snapshot"]);
    refs.name = refFor(snap.json.data.snapshot, /textbox "Name"/);
    refs.pw = refFor(snap.json.data.snapshot, /textbox "Password"/);
    refs.color = refFor(snap.json.data.snapshot, /combobox "Color"/);
    refs.submit = refFor(snap.json.data.snapshot, /button "Send it"/);

    const fill = await run(["element", "fill", "--ref", refs.name!, "--value-file", "-"], { input: "SECRET_FILL\n" });
    assert.equal(fill.exitCode, 0, fill.stderr);
    assert.equal(fill.json.data.chars, "SECRET_FILL".length);
    assert.doesNotMatch(fill.stdout + fill.stderr, /SECRET_FILL/);

    const pw = await run(["element", "fill", "--ref", refs.pw!, "--value-file", "-"], { input: "SECRET_FILL" });
    assert.equal(pw.exitCode, 0, pw.stderr);

    const missing = await run(["element", "fill", "--ref", refs.name!]);
    assert.equal(missing.exitCode, 2, "--value or --value-file is required");
    assert.equal(missing.json.error.code, "MISSING_REQUIRED_FLAG");
  });

  it("select: valid value and label work", async () => {
    const byValue = await run(["element", "select", "--ref", refs.color!, "--option", "g"]);
    assert.equal(byValue.exitCode, 0, byValue.stderr);
    assert.deepEqual(byValue.json.data.selected, ["g"]);
    const byLabel = await run(["element", "select", "--ref", refs.color!, "--option", "Blue"]);
    assert.deepEqual(byLabel.json.data.selected, ["b"]);
  });

  it("select: a nonexistent option fails fast with INVALID_ARGUMENT and the allowed values", async () => {
    const t0 = Date.now();
    const r = await run(["element", "select", "--ref", refs.color!, "--option", "purple"]);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 3000, `took ${elapsed} ms (must not wait out the 10 s action timeout)`);
    assert.equal(r.exitCode, 2);
    assert.equal(r.json.error.code, "INVALID_ARGUMENT");
    assert.equal(r.json.error.field, "option");
    assert.deepEqual(r.json.error.received, ["purple"]);
    assert.deepEqual(r.json.error.allowed, ["r", "g", "b"]);
    assert.equal(r.json.retryable, true);

    const mixed = await run(["element", "select", "--ref", refs.color!, "--option", "r", "--option", "nope"]);
    assert.equal(mixed.json.error.code, "INVALID_ARGUMENT");
    assert.deepEqual(mixed.json.error.received, ["nope"], "only the missing option is reported");
  });

  it("select on a non-select element: INVALID_ARGUMENT on ref, not an internal error", async () => {
    const r = await run(["element", "select", "--ref", refs.name!, "--option", "x"]);
    assert.equal(r.exitCode, 2);
    assert.equal(r.json.error.code, "INVALID_ARGUMENT");
    assert.equal(r.json.error.field, "ref");
  });

  it("press Enter in the input triggers the page handler", async () => {
    const press = await run(["element", "press", "--ref", refs.name!, "--key", "Enter"]);
    assert.equal(press.exitCode, 0, press.stderr);
    assert.equal(press.json.data.key, "Enter");
    const wait = await run(["page", "wait", "--for", "text", "--value", "Pressed Enter"]);
    assert.equal(wait.exitCode, 0, wait.stderr);
  });

  it("scroll and tabs respond", async () => {
    const scroll = await run(["page", "scroll", "--direction", "down", "--amount", "page"]);
    assert.equal(scroll.exitCode, 0, scroll.stderr);
    assert.equal(typeof scroll.json.data.scrollY, "number");
    const tabs = await run(["page", "tabs", "--action", "list"]);
    assert.equal(tabs.exitCode, 0, tabs.stderr);
    assert.equal(tabs.json.data.tabs.length, 1);
  });

  it("a stale or unknown ref: REF_NOT_FOUND with a snapshot suggestion", async () => {
    await run(["page", "navigate", "--url", fx.url("/about")]);
    for (const ref of [refs.submit!, "e999"]) {
      const r = await run(["element", "click", "--ref", ref]);
      assert.equal(r.exitCode, 1, `ref ${ref}`);
      assert.equal(r.json.error.code, "REF_NOT_FOUND");
      assert.equal(r.json.error.field, "ref");
      assert.equal(r.json.retryable, true);
      assert.match(r.json.suggested_fix.command, /^hound page snapshot --session-name act1/);
    }
    const bad = await run(["element", "click", "--ref", "not a ref!"]);
    assert.equal(bad.exitCode, 2);
    assert.equal(bad.json.error.code, "INVALID_ARGUMENT");
  });

  it("console and network show the page error and the 404 (URLs without query)", async () => {
    await run(["page", "navigate", "--url", `${fx.url("/broken")}?token=SECRET`]);
    await run(["page", "wait", "--for", "load", "--value", "networkidle"]);

    const con = await run(["diag", "console"]);
    assert.equal(con.exitCode, 0, con.stderr);
    const texts = con.json.data.entries.map((e: { text: string }) => e.text);
    assert.ok(texts.some((t: string) => t.includes("fixture-console-error")), JSON.stringify(texts));
    const err = con.json.data.entries.find((e: { text: string }) => e.text.includes("fixture-console-error"));
    assert.equal(err.level, "error");
    assert.equal(err.source, "console");

    const net = await run(["diag", "network"]);
    const failed = net.json.data.entries.find((e: { url: string }) => e.url === fx.url("/missing-resource"));
    assert.ok(failed, JSON.stringify(net.json.data.entries));
    assert.equal(failed.status, 404);
    assert.equal(failed.method, "GET");
    assert.doesNotMatch(net.stdout + con.stdout, /SECRET/);

    const all = await run(["diag", "network", "--state", "all", "--limit", "2"]);
    assert.ok(all.json.data.entries.length <= 2);
    assert.ok(all.json.data.total >= all.json.data.entries.length);
  });

  it("wait timeout says what was waited for, retryable, no page content", async () => {
    const t0 = Date.now();
    const r = await run(["page", "wait", "--for", "text", "--value", "Checkout", "--timeout", "3"]);
    const elapsed = Date.now() - t0;
    assert.equal(r.exitCode, 1);
    assert.equal(r.json.error.code, "TIMEOUT");
    assert.equal(r.json.error.message, 'Timed out after 3s waiting for text "Checkout".');
    assert.equal(r.json.error.field, "value");
    assert.equal(r.json.error.received, "Checkout");
    assert.equal(r.json.retryable, true);
    assert.doesNotMatch(r.stdout, /Broken page|fixture-console-error/, "no page content in the error");
    assert.ok(elapsed < 8000, `took ${elapsed} ms`);

    const url = await run(["page", "wait", "--for", "url", "--value", "**/never", "--timeout", "2"]);
    assert.equal(url.json.error.code, "TIMEOUT");
    assert.match(url.json.error.message, /^Timed out after 2s waiting for url "\*\*\/never"\.$/);
    assert.equal(url.json.error.field, "value");
  });

  it("other op timeouts name the op target: navigate to a slow page", async () => {
    const r = await run(["page", "navigate", "--url", `${fx.url("/slow")}?token=SECRET`, "--timeout", "2"]);
    assert.equal(r.exitCode, 1);
    assert.equal(r.json.error.code, "TIMEOUT");
    assert.equal(r.json.error.message, `Timed out after 2s waiting for "${fx.url("/slow")}" to load; it may still have been applied; run page snapshot before retrying.`);
    assert.equal(r.json.error.field, "url");
    assert.equal(r.json.retryable, false, "state-changing ops are not blindly retryable");
    assert.doesNotMatch(r.stdout, /SECRET/);
    // The session survives a timed-out navigation.
    const next = await run(["page", "navigate", "--url", fx.url("/about")]);
    assert.equal(next.exitCode, 0, next.stderr);
  });

  it("screenshot writes a private PNG under the isolated home", async () => {
    const r = await run(["page", "screenshot"]);
    assert.equal(r.exitCode, 0, r.stderr);
    const file: string = r.json.data.file;
    assert.ok(file.startsWith(join(env.home, "runs", "browser", S)), file);
    assert.ok(existsSync(file));
    assert.equal(mode(file), 0o600);
    assert.deepEqual([...readFileSync(file).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    const full = await run(["page", "screenshot", "--scope", "full"]);
    assert.equal(full.json.data.scope, "full");
  });

  it("trace export: files exist, private, and contain none of the typed secrets", async () => {
    const r = await run(["diag", "trace", "--action", "export"]);
    assert.equal(r.exitCode, 0, r.stderr);
    const { file, steps, dir, actions } = r.json.data;
    assert.ok(actions > 0);
    for (const f of [file, steps]) {
      assert.ok(existsSync(f), `missing ${f}`);
      assert.equal(mode(f), 0o600);
    }
    assert.ok(file.startsWith(dir) && file.endsWith("debug-trace.zip"));

    const needles = [/SECRET_FILL/, /SECRET/, /token=/];
    const stepsText = readFileSync(steps, "utf8");
    JSON.parse(stepsText);
    for (const n of needles) assert.doesNotMatch(stepsText, n, `steps.json matches ${n}`);

    const zip = readFileSync(file);
    const entries = readZipIndex(zip);
    assert.ok(entries.length > 0);
    const readable = entries.map((e) => readZipEntry(zip, e).toString("latin1")).join("\n");
    assert.match(readable, /Fixture Home|Form|127\.0\.0\.1/, "sanity: the trace holds readable page data, so the secret scan is meaningful");
    for (const entry of entries) {
      const body = readZipEntry(zip, entry).toString("latin1");
      for (const n of needles) assert.doesNotMatch(body, n, `${entry.name} matches ${n}`);
    }
    assert.doesNotMatch(r.stdout, /SECRET/);

    // Tracing restarted: a second export still works.
    const again = await run(["diag", "trace", "--action", "export"]);
    assert.equal(again.exitCode, 0, again.stderr);
  });

  it("trace export on a session opened without --trace on: INVALID_ARGUMENT", async () => {
    const name = "act-notrace";
    await env.open(name, ["--actions", "interact"]);
    const r = await env.hound(["diag", "trace", "--action", "export", "--session-name", name]);
    assert.equal(r.exitCode, 2);
    assert.equal(r.json.error.code, "INVALID_ARGUMENT");
    assert.equal(r.json.error.field, "trace");
    assert.match(r.json.suggested_fix.command, /--trace on/);
  });

  it("closing leaves no daemon and no session dir", async () => {
    for (const name of [S, "act-notrace"]) {
      const dir = join(env.home, "sessions", name);
      assert.ok(existsSync(dir));
      assert.equal((await env.hound(["browser", "close", "--session-name", name])).json.data.closed, true);
      assert.ok(!existsSync(dir), `${name} dir removed`);
    }
    assert.ok(!isAlive(pid));
    assert.equal((await env.hound(["browser", "list"])).json.data.count, 0);
  });
});
