/** hound batch: several session steps in one call, validated up front, with $prev / $steps[i] references. */
import assert from "node:assert/strict";
import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { makeEnv, startFixture, type Env, type Fixture } from "./helpers/hound.ts";

const SECRET = "TOPSECRET-batch-4711";

describe("batch (no browser)", () => {
  let env: Env;
  before(async () => {
    env = await makeEnv();
  });
  after(async () => {
    await env.cleanup();
  });
  const batch = (steps: unknown, extra: string[] = []) => env.hound(["batch", "--session-name", "nobody", "--file", "-", ...extra, "--json"], { input: JSON.stringify(steps) });

  it("is a top-level command with help, schema (step format + reference syntax) and typo suggestions", async () => {
    const schema = JSON.parse((await env.raw(["batch", "--schema"])).stdout);
    assert.equal(schema.command, "batch");
    assert.deepEqual(schema.input.required.sort(), ["file", "session-name"]);
    assert.equal(schema.input.properties["max-steps"].maximum, 200);
    assert.ok(schema.input.file_format.items.properties.command.enum.includes("element click"));
    assert.ok(!schema.input.file_format.items.properties.command.enum.includes("browser open"));
    assert.deepEqual(schema.input.file_format.references.syntax, ["$prev.<path>", "$steps[<i>].<path>"]);
    const typo = await env.hound(["bacth"]);
    assert.equal(typo.exitCode, 2);
    assert.match(typo.json.error.message, /Did you mean "batch"/);
    assert.match(typo.json.suggested_fix.command, /^hound batch /);
  });

  it("validates every step before running any: usage errors exit 2 with steps[i].args.<flag>", async () => {
    const r = await batch([
      { command: "page navigate", args: { url: "https://example.com" } },
      { command: "page find", args: { text: "x" } },
      { command: "page wait", args: { for: "txt", value: "a" } },
    ]);
    assert.equal(r.exitCode, 2);
    assert.equal(r.json.error.code, "INVALID_ENUM");
    assert.equal(r.json.error.field, "steps[2].args.for");
    assert.equal(r.json.suggested_fix.command, "hound page wait --schema --json");

    const missing = await batch([{ command: "page wait", args: { for: "text" } }]);
    assert.equal(missing.json.error.code, "MISSING_REQUIRED_FLAG");
    assert.equal(missing.json.error.field, "steps[0].args.value");
    const range = await batch([{ command: "page find", args: { text: "x", limit: 999 } }]);
    assert.equal(range.json.error.field, "steps[0].args.limit");
    const unknown = await batch([{ command: "page find", args: { txt: "x" } }]);
    assert.equal(unknown.exitCode, 2);
    assert.equal(unknown.json.error.field, "steps[0].args.txt");
    assert.match(unknown.json.error.message, /Did you mean "text"/);
    const session = await batch([{ command: "page find", args: { "session-name": "other", text: "x" } }]);
    assert.equal(session.json.error.field, "steps[0].args.session-name");
    const universal = await batch([{ command: "page find", args: { text: "x", json: true } }]);
    assert.equal(universal.json.error.field, "steps[0].args.json");
    const stdin = await batch([{ command: "element fill", args: { ref: "e1", "value-file": "-" } }]);
    assert.equal(stdin.json.error.field, "steps[0].args.value-file");
  });

  it("refuses forbidden and unknown commands, bad references, bad JSON and too many steps", async () => {
    for (const command of ["profile list", "browser open", "batch", "script run", "task run"]) {
      const r = await batch([{ command, args: {} }]);
      assert.equal(r.exitCode, 2, command);
      assert.equal(r.json.error.field, "steps[0].command", command);
    }
    const typo = await batch([{ command: "element clik", args: { ref: "e1" } }]);
    assert.equal(typo.json.error.code, "UNKNOWN_COMMAND");
    assert.match(typo.json.error.message, /Did you mean "element click"/);
    const prev0 = await batch([{ command: "element click", args: { ref: "$prev.matches.0.ref" } }]);
    assert.equal(prev0.exitCode, 2);
    assert.equal(prev0.json.error.field, "steps[0].args.ref");
    const forward = await batch([{ command: "page find", args: { text: "x" } }, { command: "element click", args: { ref: "$steps[1].ref" } }]);
    assert.equal(forward.json.error.field, "steps[1].args.ref");
    const malformed = await batch([{ command: "page find", args: { text: "x" } }, { command: "element click", args: { ref: "$prev..ref" } }]);
    assert.equal(malformed.json.error.field, "steps[1].args.ref");
    const notJson = await env.hound(["batch", "--session-name", "x", "--file", "-", "--json"], { input: `[{"command": "page find", "args": {"value": "${SECRET}"` });
    assert.equal(notJson.exitCode, 2);
    assert.equal(notJson.json.error.field, "file");
    assert.ok(!notJson.stdout.includes(SECRET));
    const many = await batch(Array.from({ length: 3 }, () => ({ command: "page find", args: { text: "x" } })), ["--max-steps", "2"]);
    assert.equal(many.json.error.field, "max-steps");
    const big = await batch([], ["--max-steps", "201"]);
    assert.equal(big.json.error.field, "max-steps");
  });

  it("never echoes sensitive values in usage errors", async () => {
    const r = await batch([{ command: "element fill", args: { ref: "not a ref!", value: SECRET } }]);
    assert.equal(r.exitCode, 2);
    assert.equal(r.json.error.field, "steps[0].args.ref");
    const d = await batch([{ command: "element click", args: { ref: "e1", dialog: "dismiss", "dialog-text": SECRET } }]);
    assert.equal(d.exitCode, 2);
    for (const out of [r.stdout + r.stderr, d.stdout + d.stderr]) assert.ok(!out.includes(SECRET));
  });
});

describe("batch (browser)", () => {
  let env: Env;
  let fx: Fixture;
  before(async () => {
    env = await makeEnv();
    fx = await startFixture();
    assert.equal((await env.open("b")).exitCode, 0);
    assert.equal((await env.open("bi", ["--actions", "interact"])).exitCode, 0);
  });
  after(async () => {
    await env.cleanup();
    await fx.close();
  });
  const batch = (session: string, steps: unknown, extra: string[] = []) => env.hound(["batch", "--session-name", session, "--file", "-", ...extra, "--json"], { input: JSON.stringify(steps) });
  const url = async (session: string) => (await env.hound(["browser", "status", "--session-name", session, "--json"])).json.data.url as string;

  it("runs find -> click with $prev and a wait in one call (stdin)", async () => {
    const r = await batch("b", [
      { command: "page navigate", args: { url: fx.url("/") } },
      { command: "page find", args: { text: "About page" } },
      { command: "element click", args: { ref: "$prev.matches.0.ref" } },
      { command: "page wait", args: { for: "url", value: "/about", timeout: 10 } },
      { command: "element read", args: { ref: "$steps[1].matches[0].ref" } },
    ]);
    assert.equal(r.exitCode, 1, "the last step's ref is gone after the navigation");
    assert.equal(r.json.error.code, "PARTIAL_SUCCESS");
    assert.equal(r.json.data.completed, 4);
    assert.equal(r.json.data.steps[2].ok, true);
    assert.match(r.json.data.steps[2].data.url, /\/about$/);
    assert.equal(r.json.data.steps[4].error.code, "REF_NOT_FOUND");
    assert.equal(r.json.error.field, "steps[4].args.ref");

    const ok = await batch("b", [
      { command: "page navigate", args: { url: fx.url("/") } },
      { command: "page find", args: { text: "About page" } },
      { command: "element read", args: { ref: "$prev.matches.0.ref", attr: "href" } },
      { command: "browser status" },
    ]);
    assert.equal(ok.exitCode, 0, ok.stdout);
    assert.equal(ok.json.ok, true);
    assert.deepEqual(ok.json.data.steps.map((s: { ok: boolean }) => s.ok), [true, true, true, true]);
    assert.equal(ok.json.data.steps[2].data.value, "/about");
    assert.equal(ok.json.data.completed, 4);
    assert.equal(ok.json.data.failed, 0);
    assert.ok(ok.json.next_actions.length >= 1);
  });

  it("a usage error in step 3 runs nothing", async () => {
    await env.hound(["page", "navigate", "--session-name", "b", "--url", fx.url("/"), "--json"]);
    const r = await batch("b", [
      { command: "page navigate", args: { url: fx.url("/about") } },
      { command: "page snapshot" },
      { command: "page scroll", args: { direction: "sideways", amount: "page" } },
    ]);
    assert.equal(r.exitCode, 2);
    assert.equal(r.json.error.field, "steps[2].args.direction");
    assert.match(await url("b"), /\/$/, "step 0 did not navigate");
  });

  it("stops at the first failure unless --continue-on-error; an unresolvable reference fails only its step", async () => {
    const steps = [
      { command: "page navigate", args: { url: fx.url("/") } },
      { command: "element click", args: { ref: "e999" } },
      { command: "page navigate", args: { url: fx.url("/about") } },
    ];
    const stop = await batch("b", steps);
    assert.equal(stop.exitCode, 1);
    assert.equal(stop.json.ok, false);
    assert.equal(stop.json.error.code, "PARTIAL_SUCCESS");
    assert.equal(stop.json.retryable, false);
    assert.deepEqual([stop.json.data.completed, stop.json.data.failed, stop.json.data.skipped], [1, 1, 1]);
    assert.equal(stop.json.data.steps[1].error.code, "REF_NOT_FOUND");
    assert.match(await url("b"), /\/$/);

    const go = await batch("b", steps, ["--continue-on-error"]);
    assert.equal(go.exitCode, 1);
    assert.deepEqual([go.json.data.completed, go.json.data.failed, go.json.data.skipped], [2, 1, 0]);
    assert.match(await url("b"), /\/about$/);

    const unresolved = await batch("b", [
      { command: "page find", args: { text: "no such text anywhere" } },
      { command: "element click", args: { ref: "$prev.matches.0.ref" } },
    ]);
    assert.equal(unresolved.exitCode, 1);
    assert.equal(unresolved.json.data.steps[1].error.code, "INVALID_ARGUMENT");
    assert.equal(unresolved.json.data.steps[1].error.field, "steps[1].args.ref");
  });

  it("never echoes sensitive values from failing steps; reads a steps file", async () => {
    const steps = [
      { command: "page navigate", args: { url: fx.url("/form") } },
      { command: "page find", args: { text: 'textbox "Name"' } },
      { command: "element fill", args: { ref: "$prev.matches.0.ref", value: SECRET } },
    ];
    const file = join(env.cwd, "steps.json");
    writeFileSync(file, JSON.stringify(steps));
    const r = await env.hound(["batch", "--session-name", "b", "--file", file, "--json"]);
    assert.equal(r.exitCode, 1);
    assert.equal(r.json.data.steps[2].error.code, "ACTION_BLOCKED", "fill needs interact");
    assert.ok(!r.stdout.includes(SECRET) && !r.stderr.includes(SECRET));

    const ok = await batch("bi", [
      { command: "page navigate", args: { url: fx.url("/form") } },
      { command: "page find", args: { text: "textbox \"Name\"" } },
      { command: "element fill", args: { ref: "$prev.matches.0.ref", value: SECRET } },
    ]);
    assert.equal(ok.exitCode, 0, ok.stdout);
    assert.deepEqual(ok.json.data.steps[2].data, { ref: ok.json.data.steps[1].data.matches[0].ref, chars: SECRET.length });
    assert.ok(!ok.stdout.includes(SECRET) && !ok.stderr.includes(SECRET));
  });

  it("caps the inline output: later step data keeps only file fields, the full results go to a 0600 file", async () => {
    const snap = { command: "page snapshot", args: { "limit-chars": 60000 } };
    const r = await batch("b", [{ command: "page navigate", args: { url: fx.url("/print") } }, snap, snap, snap]);
    assert.equal(r.exitCode, 0, r.stdout.slice(0, 300));
    const omitted = r.json.data.steps.filter((s: { dataOmitted?: number }) => s.dataOmitted !== undefined);
    assert.ok(omitted.length >= 1);
    assert.equal(omitted[0].data.snapshot, undefined);
    assert.ok(r.stdout.length < 200_000);
    assert.equal(statSync(r.json.data.file).mode & 0o777, 0o600);
    assert.ok(r.json.next_actions.some((a: { command: string }) => a.command.includes(r.json.data.file)));
  });
});
