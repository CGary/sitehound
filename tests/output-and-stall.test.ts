/**
 * Safe --output writes for page snapshot / page screenshot (shared with element download and diag request), and a click
 * or download whose navigation never gets an answer must not leave the page blocked for the next ops.
 */
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { placeFile, writeOutputSafe } from "../packages/core/src/browserd/output.ts";
import { makeEnv, refFor, startFixture, type Env, type Fixture } from "./helpers/hound.ts";

const mode = (p: string) => statSync(p).mode & 0o777;
const partials = (dir: string) => readdirSync(dir).filter((f) => f.startsWith(".hound-partial") || f.startsWith(".partial"));

describe("writeOutputSafe / placeFile (unit)", () => {
  let dir = "";
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "hound-out-unit-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("exclusive by default: an existing file or a symlink is CONFLICT and stays untouched", async () => {
    const existing = join(dir, "a.txt");
    writeFileSync(existing, "KEEP");
    await assert.rejects(writeOutputSafe(existing, "NEW", false), (e: any) => e.code === "CONFLICT");
    assert.equal(readFileSync(existing, "utf8"), "KEEP");
    const victim = join(dir, "victim.txt");
    writeFileSync(victim, "VICTIM");
    const link = join(dir, "link.txt");
    symlinkSync(victim, link);
    await assert.rejects(writeOutputSafe(link, "NEW", false), (e: any) => e.code === "CONFLICT");
    assert.equal(readFileSync(victim, "utf8"), "VICTIM");
    assert.ok(lstatSync(link).isSymbolicLink());
    assert.deepEqual(partials(dir), []);
  });

  it("overwrite replaces the link itself, never its target; the result is 0600", async () => {
    const victim = join(dir, "victim2.txt");
    writeFileSync(victim, "VICTIM");
    const link = join(dir, "link2.txt");
    symlinkSync(victim, link);
    await writeOutputSafe(link, "NEW", true);
    assert.equal(readFileSync(victim, "utf8"), "VICTIM");
    assert.ok(!lstatSync(link).isSymbolicLink());
    assert.equal(readFileSync(link, "utf8"), "NEW");
    assert.equal(mode(link), 0o600);
    assert.deepEqual(partials(dir), []);
  });

  it("a missing directory is FILE_NOT_FOUND, a directory is INVALID_ARGUMENT; no temp files stay", async () => {
    await assert.rejects(writeOutputSafe(join(dir, "nope", "x.txt"), "x", false), (e: any) => e.code === "FILE_NOT_FOUND");
    mkdirSync(join(dir, "sub"));
    await assert.rejects(writeOutputSafe(join(dir, "sub"), "x", true), (e: any) => e.code === "INVALID_ARGUMENT" || e.code === "CONFLICT" || e.code === "PERMISSION_DENIED");
    assert.deepEqual(partials(dir), []);
  });

  it("placeFile publishes a staged file with the same guarantees (the caller removes whatever is left of it)", async () => {
    const staged = join(dir, "staged");
    writeFileSync(staged, "STAGED", { mode: 0o600 });
    const out = join(dir, "placed.txt");
    assert.equal(await placeFile(staged, out, false), out);
    assert.equal(readFileSync(out, "utf8"), "STAGED");
    await assert.rejects(placeFile(staged, out, false), (e: any) => e.code === "CONFLICT");
    const victim = join(dir, "victim3.txt");
    writeFileSync(victim, "VICTIM");
    const link = join(dir, "link3.txt");
    symlinkSync(victim, link);
    await placeFile(staged, link, true);
    assert.equal(readFileSync(victim, "utf8"), "VICTIM");
    assert.equal(readFileSync(link, "utf8"), "STAGED");
    assert.ok(!existsSync(staged), "an overwrite moves the staged file into place");
    assert.deepEqual(partials(dir), []);
  });
});

describe("--output for page snapshot and page screenshot, and stuck navigations", () => {
  let env: Env;
  let fx: Fixture;
  let scratch = "";
  const IA = "out-ia";
  const RD = "out-rd";
  const ia = (args: string[]) => env.hound(args.concat("--session-name", IA));
  const rd = (args: string[]) => env.hound(args.concat("--session-name", RD));

  before(async () => {
    env = await makeEnv();
    fx = await startFixture();
    scratch = await mkdtemp(join(tmpdir(), "hound-out-e2e-"));
    const opened = await Promise.all([env.open(IA, ["--actions", "interact"]), env.open(RD)]);
    for (const o of opened) assert.equal(o.exitCode, 0, o.stderr);
    assert.equal((await ia(["page", "navigate", "--url", fx.url("/")])).exitCode, 0);
  });
  after(async () => {
    await env.cleanup();
    await fx.close();
    await rm(scratch, { recursive: true, force: true });
  });

  it("snapshot --output: written 0600; an existing file is CONFLICT until --if-exists overwrite", async () => {
    const out = join(scratch, "page.yml");
    const ok = await ia(["page", "snapshot", "--output", out]);
    assert.equal(ok.exitCode, 0, ok.stderr);
    assert.equal(ok.json.data.file, out);
    assert.equal(mode(out), 0o600);
    assert.match(readFileSync(out, "utf8"), /Fixture Home/);
    const conflict = await ia(["page", "snapshot", "--output", out]);
    assert.equal(conflict.json.error.code, "CONFLICT");
    assert.match(conflict.json.suggested_fix.command, /--if-exists overwrite/);
    assert.equal((await ia(["page", "snapshot", "--output", out, "--if-exists", "overwrite"])).exitCode, 0);
    assert.deepEqual(partials(scratch), []);
  });

  it("screenshot --output: PNG 0600; CONFLICT until --if-exists overwrite", async () => {
    const out = join(scratch, "shot.png");
    const ok = await ia(["page", "screenshot", "--output", out]);
    assert.equal(ok.exitCode, 0, ok.stderr);
    assert.equal(mode(out), 0o600);
    assert.equal(readFileSync(out).subarray(1, 4).toString(), "PNG");
    const conflict = await ia(["page", "screenshot", "--output", out]);
    assert.equal(conflict.json.error.code, "CONFLICT");
    assert.equal((await ia(["page", "screenshot", "--output", out, "--if-exists", "overwrite"])).exitCode, 0);
    assert.deepEqual(partials(scratch), []);
  });

  it("a symlink that appears after the CLI check is never followed (daemon level): exclusive -> CONFLICT, overwrite -> the link is replaced", async () => {
    process.env.HOUND_HOME = env.home;
    const { callBrowserSession } = await import("../packages/core/src/index.ts");
    for (const [op, params] of [["snapshot", {}], ["screenshot", { scope: "viewport" }]] as const) {
      const victim = join(scratch, `${op}-victim.txt`);
      writeFileSync(victim, "VICTIM");
      const link = join(scratch, `${op}-link`);
      symlinkSync(victim, link);
      const call = (extra: Record<string, unknown>) => callBrowserSession(IA, op, { ...params, output: link, ...extra });

      await assert.rejects(call({ ifExists: "error" }), (e: any) => e.code === "CONFLICT", `${op} exclusive`);
      await assert.rejects(call({}), (e: any) => e.code === "CONFLICT", `${op}: no ifExists means exclusive`);
      assert.equal(readFileSync(victim, "utf8"), "VICTIM");
      assert.ok(lstatSync(link).isSymbolicLink(), "untouched");

      await call({ ifExists: "overwrite" });
      assert.equal(readFileSync(victim, "utf8"), "VICTIM", `${op}: never written through the link`);
      assert.ok(!lstatSync(link).isSymbolicLink(), "replaced by a regular file");
      assert.equal(mode(link), 0o600);
      assert.ok(readFileSync(link).length > 0);
    }
    assert.deepEqual(partials(scratch), [], "no temp files left");
  });

  it("the CLI still refuses a symlink or directory --output up front", async () => {
    const victim = join(scratch, "cli-victim.txt");
    writeFileSync(victim, "VICTIM");
    const link = join(scratch, "cli-link.yml");
    symlinkSync(victim, link);
    for (const extra of [[], ["--if-exists", "overwrite"]]) {
      const r = await ia(["page", "snapshot", "--output", link, ...extra]);
      assert.equal(r.json.error.code, "INVALID_ARGUMENT");
      assert.match(r.json.error.message, /symlink/);
    }
    assert.equal(readFileSync(victim, "utf8"), "VICTIM");
  });

  it("element download --output to another file system keeps the guarantees (skipped when /dev/shm is on the same one)", async (t) => {
    const shm = "/dev/shm";
    if (!existsSync(shm) || statSync(shm).dev === statSync(env.home).dev) return t.skip("no second file system available");
    const dir = await mkdtemp(join(shm, "hound-xdev-"));
    try {
      assert.equal((await ia(["page", "navigate", "--url", fx.url("/downloads")])).exitCode, 0);
      const s = (await ia(["page", "snapshot"])).json.data.snapshot as string;
      const link = refFor(s, /link "Get report"/);
      const victim = join(dir, "victim.txt");
      writeFileSync(victim, "VICTIM");
      const out = join(dir, "out.txt");
      symlinkSync(victim, out);
      const refused = await ia(["element", "download", "--ref", link, "--output", out, "--if-exists", "overwrite"]);
      assert.equal(refused.json.error.code, "INVALID_ARGUMENT", "the CLI refuses symlinks");
      const plain = join(dir, "plain.txt");
      const ok = await ia(["element", "download", "--ref", link, "--output", plain]);
      assert.equal(ok.exitCode, 0, ok.stderr);
      assert.equal(readFileSync(plain, "utf8"), "hello report");
      assert.equal(mode(plain), 0o600);
      assert.equal(readFileSync(victim, "utf8"), "VICTIM");
      assert.deepEqual(partials(dir), []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  describe("a click whose request never gets an answer", () => {
    const stuckThenSnapshot = async (run: typeof ia, verb: "click" | "download") => {
      assert.equal((await run(["page", "navigate", "--url", fx.url("/downloads")])).exitCode, 0);
      const s = (await run(["page", "snapshot"])).json.data.snapshot as string;
      const t0 = Date.now();
      const r = await run(["element", verb, "--ref", refFor(s, /link "Get hang"/), "--timeout", "3"]);
      assert.equal(r.exitCode, 1, r.stdout);
      assert.equal(r.json.error.code, "TIMEOUT");
      assert.equal(r.json.retryable, false, "the click may have been applied");
      assert.ok(Date.now() - t0 < 9000, `took ${Date.now() - t0} ms`);
      const t1 = Date.now();
      const next = await run(["page", "snapshot", "--timeout", "5"]);
      assert.equal(next.exitCode, 0, `the next op is answered, not stuck behind the pending navigation: ${next.stdout}`);
      assert.ok(Date.now() - t1 < 4000, `next op took ${Date.now() - t1} ms`);
      const hover = await run(["page", "tabs", "--action", "list", "--timeout", "5"]);
      assert.equal(hover.exitCode, 0);
      assert.match(next.json.data.url, /\/downloads$/, "the page that was showing stays");
    };

    it("element download: TIMEOUT, then the next snapshot answers within its own timeout", async () => {
      await stuckThenSnapshot(ia, "download");
    });
    it("element click (interact level): same", async () => {
      await stuckThenSnapshot(ia, "click");
    });
    it("element click (read level, a plain link): same", async () => {
      await stuckThenSnapshot(rd, "click");
    });
  });
});
