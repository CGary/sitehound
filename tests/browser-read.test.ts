/** Browser sessions at the default `read` level: lifecycle, navigation, snapshot refs, blocked actions. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { isAlive, makeEnv, refFor, startFixture, type Env, type Fixture } from "./helpers/hound.ts";

const S = "read1";

describe("browser session (read level)", () => {
  let env: Env;
  let fx: Fixture;
  let pid = 0;
  before(async () => {
    env = await makeEnv();
    fx = await startFixture();
  });
  after(async () => {
    await env.cleanup(); // closes every session even if a test failed
    await fx.close();
  });

  it("open: session info, private state dir, daemon alive", async () => {
    const r = await env.open(S);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.json.command, "browser.open");
    assert.equal(r.json.data.session, S);
    assert.equal(r.json.data.actions, "read");
    assert.equal(r.json.data.display, "headless");
    assert.equal(r.json.data.trace, "off");
    pid = r.json.data.pid;
    assert.ok(isAlive(pid));
    assert.ok(existsSync(join(env.home, "sessions", S)));
  });

  it("double open: SESSION_EXISTS, and the first session is untouched", async () => {
    const r = await env.hound(["browser", "open", "--session-name", S]);
    assert.equal(r.exitCode, 1);
    assert.equal(r.json.error.code, "SESSION_EXISTS");
    assert.match(r.json.suggested_fix.command, /browser status/);
    assert.ok(isAlive(pid));
  });

  it("status and list report the session", async () => {
    const status = await env.hound(["browser", "status", "--session-name", S]);
    assert.equal(status.exitCode, 0);
    assert.equal(status.json.data.alive, true);
    assert.equal(status.json.data.pid, pid);
    assert.equal(status.json.data.actions, "read");
    const list = await env.hound(["browser", "list"]);
    assert.equal(list.json.data.count, 1);
    assert.equal(list.json.data.sessions[0].session, S);
    assert.equal(list.json.data.sessions[0].alive, true);
  });

  it("navigate returns a stripped URL; status follows the page", async () => {
    const r = await env.hound(["page", "navigate", "--session-name", S, "--url", `${fx.url("/")}?token=SECRET#frag`]);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.json.data.url, fx.url("/"));
    assert.equal(r.json.data.title, "Fixture Home");
    assert.equal(r.json.data.status, 200);
    assert.doesNotMatch(r.stdout, /SECRET/);
    const status = await env.hound(["browser", "status", "--session-name", S]);
    assert.equal(status.json.data.url, fx.url("/"));
  });

  it("navigate rejects non-http(s) URLs", async () => {
    const r = await env.hound(["page", "navigate", "--session-name", S, "--url", "file:///etc/hostname"]);
    assert.equal(r.exitCode, 2);
    assert.equal(r.json.error.code, "INVALID_ARGUMENT");
    assert.equal(r.json.error.field, "url");
  });

  it("snapshot has refs, and a click on a plain link works at read level", async () => {
    const snap = await env.hound(["page", "snapshot", "--session-name", S]);
    assert.equal(snap.exitCode, 0, snap.stderr);
    assert.ok(snap.json.data.refs >= 3);
    assert.equal(snap.json.data.truncated, false);
    assert.match(snap.json.data.snapshot, /heading "Fixture Home"/);
    const link = refFor(snap.json.data.snapshot, /link "About page"/);

    const click = await env.hound(["element", "click", "--session-name", S, "--ref", link]);
    assert.equal(click.exitCode, 0, click.stderr);
    assert.equal(click.json.data.url, fx.url("/about"));
    assert.equal(click.json.data.title, "About");
  });

  it("history works: back, forward, reload", async () => {
    const back = await env.hound(["page", "back", "--session-name", S]);
    assert.equal(back.json.data.moved, true);
    assert.equal(back.json.data.url, fx.url("/"));
    const fwd = await env.hound(["page", "forward", "--session-name", S]);
    assert.equal(fwd.json.data.url, fx.url("/about"));
    const rel = await env.hound(["page", "reload", "--session-name", S]);
    assert.equal(rel.exitCode, 0);
  });

  it("form actions are ACTION_BLOCKED with a reopen suggestion", async () => {
    await env.hound(["page", "navigate", "--session-name", S, "--url", fx.url("/form")]);
    const snap = await env.hound(["page", "snapshot", "--session-name", S]);
    const submit = refFor(snap.json.data.snapshot, /button "Send it"/);
    const name = refFor(snap.json.data.snapshot, /textbox "Name"/);
    const color = refFor(snap.json.data.snapshot, /combobox "Color"/);

    const click = await env.hound(["element", "click", "--session-name", S, "--ref", submit]);
    assert.equal(click.exitCode, 1);
    assert.equal(click.json.error.code, "ACTION_BLOCKED");
    assert.equal(click.json.error.field, "actions");
    assert.deepEqual(click.json.error.allowed, ["interact"]);
    assert.match(click.json.suggested_fix.command, /browser open --session-name read1 --actions interact/);

    const fill = await env.hound(["element", "fill", "--session-name", S, "--ref", name, "--value", "SECRET_FILL"]);
    assert.equal(fill.exitCode, 1);
    assert.equal(fill.json.error.code, "ACTION_BLOCKED");
    assert.doesNotMatch(fill.stdout + fill.stderr, /SECRET_FILL/, "the value is never echoed");

    assert.equal((await env.hound(["element", "select", "--session-name", S, "--ref", color, "--option", "g"])).json.error.code, "ACTION_BLOCKED");
    assert.equal((await env.hound(["element", "press", "--session-name", S, "--key", "Enter"])).json.error.code, "ACTION_BLOCKED");

    // Still on the form page: nothing was submitted.
    const status = await env.hound(["browser", "status", "--session-name", S]);
    assert.equal(status.json.data.url, fx.url("/form"));
  });

  it("close removes the daemon and the session dir; SESSION_NOT_FOUND afterwards", async () => {
    const close = await env.hound(["browser", "close", "--session-name", S]);
    assert.equal(close.exitCode, 0);
    assert.deepEqual(close.json.data, { session: S, closed: true });
    assert.ok(!isAlive(pid), "daemon pid is gone");
    assert.ok(!existsSync(join(env.home, "sessions", S)));

    const status = await env.hound(["browser", "status", "--session-name", S]);
    assert.equal(status.exitCode, 1);
    assert.equal(status.json.error.code, "SESSION_NOT_FOUND");
    const nav = await env.hound(["page", "navigate", "--session-name", S, "--url", fx.url("/")]);
    assert.equal(nav.json.error.code, "SESSION_NOT_FOUND");

    const again = await env.hound(["browser", "close", "--session-name", S]);
    assert.equal(again.exitCode, 0, "close is idempotent");
    assert.equal(again.json.data.closed, false);
    assert.equal((await env.hound(["browser", "list"])).json.data.count, 0);
  });
});
