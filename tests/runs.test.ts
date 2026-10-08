/** task / script commands against a local fixture: result contract, file modes, trace on-failure, redaction. */
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { makeEnv, startFixture, type Env, type Fixture } from "./helpers/hound.ts";

const mode = (p: string) => statSync(p).mode & 0o777;

const SCRIPTS = {
  pass: `export default async ({ page, url, check }) => {
  await page.goto(url);
  check("h1 present", (await page.locator("h1").count()) > 0);
  return { summary: "script ok", data: { ok: true } };
};
`,
  failing: `export default async ({ page, url, check }) => {
  await page.goto(url);
  check("h1 says Nope", false, "expected Nope");
};
`,
  throwing: `export default async ({ page, url }) => {
  await page.goto(url);
  throw new Error("boom");
};
`,
};

describe("task and script runs", () => {
  let env: Env;
  let fx: Fixture;
  let dir: string;
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

  it("task list names the built-in tasks", async () => {
    const r = await env.hound(["task", "list"]);
    assert.equal(r.exitCode, 0);
    const names = r.json.data.tasks.map((t: { name: string }) => t.name);
    assert.ok(names.includes("snapshot") && names.includes("component"), names.join(","));
    assert.equal(r.json.data.count, names.length);
  });

  it("task run snapshot: ok, files exist, private modes, query string stripped everywhere", async () => {
    const r = await env.hound(["task", "run", "--task", "snapshot", "--url", `${fx.url("/")}?token=SECRET`]);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.command, "task.run");
    const data = r.json.data;
    assert.equal(data.status, "pass");
    assert.equal(data.url, fx.url("/"));
    assert.ok(data.runDir.startsWith(env.home), "run dir lives under the isolated HOUND_HOME");
    assert.ok(data.files.length >= 5);
    for (const f of data.files) {
      assert.ok(existsSync(f), `missing ${f}`);
      assert.equal(mode(f), 0o600, `${f} mode`);
    }
    assert.equal(mode(data.runDir), 0o700);
    assert.equal(mode(data.resultFile), 0o600);
    assert.doesNotMatch(r.stdout, /SECRET|token=/);
    const result = readFileSync(data.resultFile, "utf8");
    assert.doesNotMatch(result, /SECRET|token=/);
    assert.equal(JSON.parse(result).status, "pass");
    assert.ok(data.files.includes(data.resultFile));
  });

  it("task run with an unknown task: TASK_NOT_FOUND lists the allowed tasks", async () => {
    const r = await env.hound(["task", "run", "--task", "nope", "--url", fx.url("/")]);
    assert.equal(r.exitCode, 1);
    assert.equal(r.json.error.code, "TASK_NOT_FOUND");
    assert.ok(r.json.error.allowed.includes("snapshot"));
  });

  it("script run passing, with --trace on-failure, leaves no debug-trace.zip", async () => {
    const r = await env.hound(["script", "run", "--file", join(dir, "pass.mjs"), "--url", `${fx.url("/")}?token=SECRET`, "--trace", "on-failure"]);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.json.data.status, "pass");
    assert.equal(r.json.data.summary, "script ok");
    assert.equal(r.json.data.trace, undefined);
    assert.ok(!existsSync(join(r.json.data.runDir, "debug-trace.zip")));
    assert.ok(!r.json.data.files.some((f: string) => f.endsWith(".zip")));
    assert.doesNotMatch(readFileSync(r.json.data.resultFile, "utf8"), /SECRET|token=/);
  });

  it("script run with a failing check: RUN_FAILED, exit 1, run result in data, trace kept", async () => {
    const r = await env.hound(["script", "run", "--file", join(dir, "failing.mjs"), "--url", `${fx.url("/")}?token=SECRET`, "--trace", "on-failure"]);
    assert.equal(r.exitCode, 1);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.error.code, "RUN_FAILED");
    assert.equal(r.json.retryable, false);
    const data = r.json.data;
    assert.equal(data.status, "fail");
    assert.deepEqual(data.checks.map((c: { name: string; ok: boolean }) => [c.name, c.ok]), [["h1 says Nope", false]]);
    const zip = join(data.runDir, "debug-trace.zip");
    assert.ok(existsSync(zip), "debug-trace.zip is written on failure");
    assert.equal(mode(zip), 0o600);
    assert.ok(existsSync(join(data.runDir, "steps.json")));
    assert.equal(data.trace.file, zip);
    assert.match(r.json.suggested_fix.command, /steps\.json/);
    assert.doesNotMatch(r.stdout, /SECRET|token=/);
    assert.doesNotMatch(readFileSync(data.resultFile, "utf8"), /SECRET|token=/);
  });

  it("script run that throws: RUN_ERROR, exit 1, redacted error in data", async () => {
    const r = await env.hound(["script", "run", "--file", join(dir, "throwing.mjs"), "--url", fx.url("/"), "--trace", "on-failure"]);
    assert.equal(r.exitCode, 1);
    assert.equal(r.json.error.code, "RUN_ERROR");
    assert.equal(r.json.data.status, "error");
    assert.equal(r.json.data.error.message, "boom");
    assert.ok(existsSync(join(r.json.data.runDir, "debug-trace.zip")));
    assert.equal(r.json.error.message.includes("boom"), false, "error message points at result.json instead of echoing the raw error");
  });

  it("script run without --trace never writes a trace, even on failure", async () => {
    const r = await env.hound(["script", "run", "--file", join(dir, "failing.mjs"), "--url", fx.url("/")]);
    assert.equal(r.json.error.code, "RUN_FAILED");
    assert.ok(!existsSync(join(r.json.data.runDir, "debug-trace.zip")));
    assert.equal(r.json.data.trace, undefined);
  });

  it("script run input errors: FILE_NOT_FOUND, bad extension, bad --arg", async () => {
    const missing = await env.hound(["script", "run", "--file", "./nope.mjs", "--url", fx.url("/")]);
    assert.equal(missing.exitCode, 1);
    assert.equal(missing.json.error.code, "FILE_NOT_FOUND");
    await writeFile(join(dir, "notes.txt"), "not a script");
    const ext = await env.hound(["script", "run", "--file", join(dir, "notes.txt"), "--url", fx.url("/")]);
    assert.equal(ext.exitCode, 2);
    assert.equal(ext.json.error.code, "INVALID_ARGUMENT");
    assert.equal(ext.json.error.field, "file");
    const arg = await env.hound(["script", "run", "--file", "scripts/pass.mjs", "--url", fx.url("/"), "--arg", "novalue"]);
    assert.equal(arg.exitCode, 2);
    assert.equal(arg.json.error.code, "INVALID_ARGUMENT");
    assert.equal(arg.json.error.field, "arg");
  });

  it("relative --file resolves against the caller's cwd", async () => {
    const r = await env.hound(["script", "run", "--file", "scripts/pass.mjs", "--url", fx.url("/")]);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.json.data.status, "pass");
  });
});
