/**
 * Real idle timeout: a session opened with the smallest allowed --idle-timeout (1 minute; the CLI, the client and the daemon
 * all enforce it and there is no test override) closes itself and leaves nothing behind. Kept in its own file because it waits
 * a full minute; node:test runs files in parallel, so it does not lengthen the suite. Runs in-process against an isolated
 * HOUND_HOME that is set before core is imported. Erasable TypeScript only.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type * as CoreTypes from "../packages/core/src/index.ts";
import { isAlive } from "./helpers/hound.ts";

const HOME = mkdtempSync(join(tmpdir(), "hound-idle-"));
process.env.HOUND_HOME = HOME;
delete process.env.DEBUG;
const core: typeof CoreTypes = await import("../packages/core/src/index.ts");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("idle timeout (real wait)", () => {
  after(async () => {
    await core.closeBrowserSession("idle-gap").catch(() => {});
    rmSync(HOME, { recursive: true, force: true });
  });

  it("a session idles out by itself: gone from list/status, socket, session dir and trace tmp dir removed, daemon exited", { timeout: 120_000 }, async () => {
    // 1 minute is the smallest value the CLI, the client and the daemon accept (no test override exists), so this waits it out.
    const name = "idle-gap";
    const info = await core.openBrowserSession({ name, actions: "read", display: "headless", trace: "off", idleTimeoutMinutes: 1 });
    assert.equal(info.idleTimeoutMinutes, 1);
    const dir = core.browserSessionDir(name);
    const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as { pid: number; socket: string };
    assert.ok(existsSync(state.socket), "socket exists while running");
    assert.ok(existsSync(dir));
    const tracesRoot = join(HOME, "tmp", "traces");
    const tracesOf = (pid: number) => (existsSync(tracesRoot) ? readdirSync(tracesRoot).filter((d) => existsSync(join(tracesRoot, d, "pid")) && readFileSync(join(tracesRoot, d, "pid"), "utf8").trim() === String(pid)) : []);
    assert.equal(tracesOf(state.pid).length, 1, "the daemon owns one raw trace dir while running");
    assert.ok(isAlive(state.pid));

    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline && (await core.listBrowserSessions()).some((s) => s.name === name)) await sleep(300);
    assert.ok(!(await core.listBrowserSessions()).some((s) => s.name === name), "gone from the session list");
    while (Date.now() < deadline && isAlive(state.pid)) await sleep(200);
    assert.ok(!isAlive(state.pid), "daemon process exited");
    assert.ok(!existsSync(dir), "session dir removed");
    assert.ok(!existsSync(state.socket), "socket removed");
    assert.equal(tracesOf(state.pid).length, 0, "per-session trace tmp dir removed");
    await assert.rejects(core.browserSessionStatus(name), (e: unknown) => e instanceof core.HoundError && e.code === "SESSION_NOT_FOUND");
    assert.deepEqual(await core.closeBrowserSession(name), { closed: false }, "closing it afterwards is an idempotent no-op");
  });
});
