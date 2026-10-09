/** element drag: the pointer-path fallback for libraries that need intermediate moves (a fixture with mouse events only). */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { makeEnv, refFor, startFixture, type Env, type Fixture } from "./helpers/hound.ts";

describe("element drag --method auto|html5|mouse and --steps", () => {
  let env: Env;
  let fx: Fixture;
  const IA = "dm-ia";
  const ia = (args: string[]) => env.hound(args.concat("--session-name", IA));

  before(async () => {
    env = await makeEnv();
    fx = await startFixture();
    assert.equal((await env.open(IA, ["--actions", "interact"])).exitCode, 0);
  });
  after(async () => {
    await env.cleanup();
    await fx.close();
  });

  async function setup(path: string, from: RegExp, to: RegExp): Promise<{ ref: string; toRef: string }> {
    assert.equal((await ia(["page", "navigate", "--url", fx.url(path)])).exitCode, 0);
    const s = (await ia(["page", "snapshot", "--limit-chars", "100000"])).json.data.snapshot as string;
    return { ref: refFor(s, from), toRef: refFor(s, to) };
  }
  const log = async (): Promise<string> => {
    const s = (await ia(["page", "snapshot", "--limit-chars", "100000"])).json.data.snapshot as string;
    return s.split("\n").find((l) => /- log\b/.test(l)) ?? "";
  };

  it("--method html5 (dragTo only) does not move a handler that needs several pointer moves", async () => {
    const t = await setup("/drag-pointer", /button "Chip"/, /button "Bin"/);
    const r = await ia(["element", "drag", "--ref", t.ref, "--to-ref", t.toRef, "--method", "html5"]);
    assert.equal(r.exitCode, 0, r.stdout);
    assert.equal(r.json.data.method, "html5");
    assert.equal("fellBack" in r.json.data, false);
    assert.doesNotMatch(await log(), /dropped/);
  });

  it("auto (the default): dragTo has no effect, so the pointer path runs and the page sees the drop", async () => {
    const t = await setup("/drag-pointer", /button "Chip"/, /button "Bin"/);
    const r = await ia(["element", "drag", "--ref", t.ref, "--to-ref", t.toRef]);
    assert.equal(r.exitCode, 0, r.stdout);
    assert.equal(r.json.data.method, "mouse");
    assert.equal(r.json.data.fellBack, true);
    assert.match(r.json.summary, /mouse/);
    const m = /dropped:(\d+);/.exec(await log());
    assert.ok(m, "the drop was seen");
    assert.ok(Number(m![1]) >= 10, `default 10 steps: ${m![1]} moves`);
  });

  it("--method mouse with --steps sets the number of pointer moves; the dragTo step is skipped", async () => {
    const t = await setup("/drag-pointer", /button "Chip"/, /button "Bin"/);
    const r = await ia(["element", "drag", "--ref", t.ref, "--to-ref", t.toRef, "--method", "mouse", "--steps", "25"]);
    assert.equal(r.exitCode, 0, r.stdout);
    assert.equal(r.json.data.method, "mouse");
    assert.equal("fellBack" in r.json.data, false, "asked for, not a fallback");
    const m = /dropped:(\d+);/.exec(await log());
    assert.ok(m && Number(m[1]) >= 25 && Number(m[1]) <= 27, `25 steps: ${m?.[1]} moves`);
  });

  it("auto keeps dragTo when the page reacted: HTML5 drag-and-drop and a pointer handler that logs on dragTo", async () => {
    const t = await setup("/drag", /button "Card A"/, /button "Drop zone"/);
    const r = await ia(["element", "drag", "--ref", t.ref, "--to-ref", t.toRef]);
    assert.equal(r.exitCode, 0, r.stdout);
    assert.equal(r.json.data.method, "html5");
    assert.equal("fellBack" in r.json.data, false);
    assert.match(await log(), /dragstart;drop:Card A>zone/);
    const p = await setup("/drag", /button "Handle"/, /button "Slot"/);
    const r2 = await ia(["element", "drag", "--ref", p.ref, "--to-ref", p.toRef]);
    assert.equal(r2.json.data.method, "html5");
    assert.match(await log(), /pointer:handle>slot/);
  });

  it("flags are declared in --schema and checked before anything runs", async () => {
    const schema = JSON.parse((await env.raw(["element", "drag", "--schema"])).stdout);
    assert.deepEqual(schema.input.properties.method.enum, ["auto", "html5", "mouse"]);
    assert.equal(schema.input.properties.method.default, "auto");
    assert.equal(schema.input.properties.steps.minimum, 1);
    assert.equal(schema.input.properties.steps.maximum, 50);
    assert.equal(schema.input.properties.steps.default, 10);
    for (const steps of ["0", "51"]) {
      const r = await ia(["element", "drag", "--ref", "e1", "--to-ref", "e2", "--steps", steps]);
      assert.equal(r.exitCode, 2, steps);
      assert.equal(r.json.error.field, "steps");
    }
    const bad = await ia(["element", "drag", "--ref", "e1", "--to-ref", "e2", "--method", "teleport"]);
    assert.equal(bad.exitCode, 2);
    assert.equal(bad.json.error.code, "INVALID_ENUM");
  });
});
