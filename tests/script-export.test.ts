/** script export: a session's actions become a script run test (stable locators, --arg parameters, checks). */
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { paramName, renderScript } from "../packages/cli/src/commands/script-export.ts";
import { exportUrl } from "../packages/core/src/browserd/recorder.ts";
import { makeEnv, refFor, startFixture, type Env, type Fixture } from "./helpers/hound.ts";

const mode = (file: string): number => statSync(file).mode & 0o777;
const NAME_VALUE = "Jane Q Secretvalue";
const CODE_VALUE = "hunter2-SECRET-code";

describe("script export helpers (unit)", () => {
  it("exportUrl keeps origin + path (token-like segments masked) unless the query is asked for; never credentials", () => {
    assert.deepEqual(exportUrl("https://u:p@x.test/a/b?token=1#f", false), { url: "https://x.test/a/b", path: "/a/b", masked: false });
    assert.deepEqual(exportUrl("https://u:p@x.test/a/b?token=1#f", true), { url: "https://x.test/a/b?token=1#f", path: "/a/b", masked: false });
    const masked = exportUrl("https://x.test/reset/Ab12Cd34Ef56Gh78Ij90Kl12Mn", false);
    assert.equal(masked.masked, true);
    assert.equal(masked.url, "https://x.test/reset/:token");
    assert.deepEqual(exportUrl("about:blank", false), { url: "about:blank", path: "", masked: false });
  });

  it("paramName makes --arg keys from field names", () => {
    assert.equal(paramName("E-mail address"), "e_mail_address");
    assert.equal(paramName("Contraseña"), "contrasena");
    assert.equal(paramName("  ¿?  "), "");
  });

  it("renderScript: no values, unique params, TODO for ambiguous and undescribed elements", () => {
    const u = (path: string) => ({ url: `https://x.test${path}`, path, masked: false });
    const r = renderScript(
      {
        session: { name: "s", actions: "interact", dialog: "dismiss" },
        recorded: 4,
        dropped: 0,
        actions: [
          { seq: 1, op: "navigate", before: { url: "about:blank", path: "", masked: false }, after: u("/f"), goto: u("/f"), details: {} },
          { seq: 2, op: "fill", before: u("/f"), after: u("/f"), target: { kind: "label", value: "Email", hint: 'textbox "Email"' }, details: {} },
          { seq: 3, op: "fill", before: u("/f"), after: u("/f"), target: { kind: "role", role: "textbox", value: "Email", nth: 1, ambiguous: true, hint: 'textbox "Email"' }, details: {} },
          { seq: 4, op: "click", before: u("/f"), after: u("/done"), target: { kind: "none", ambiguous: true, hint: "element e9" }, details: { dialog: "accept", dialogText: true } },
        ],
      },
      { name: "t", file: "/tmp/x.ts", generatedAt: "2026-01-01T00:00:00.000Z" },
    );
    assert.deepEqual(r.params.map((p) => p.name), ["email", "email_2", "dialog_text"]);
    assert.equal(r.ambiguous, 2);
    assert.match(r.code, /getByRole\("textbox", \{ name: "Email", exact: true \}\)\.nth\(1\)/);
    assert.match(r.code, /TODO verify locator: element e9 could not be described/);
    assert.match(r.code, /withDialog\("accept", arg\("dialog_text"\)/);
    assert.match(r.code, /ctx\.check\("step 4: url path is \/done", await pathIs\("\/done"\)\)/);
    assert.match(r.runCommand, /--arg 'email=<email>' --arg 'email_2=<email_2>' --arg 'dialog_text=<dialog_text>'/);
  });
});

describe("script export (browser)", () => {
  let env: Env;
  let fx: Fixture;
  before(async () => {
    env = await makeEnv();
    fx = await startFixture();
  });
  after(async () => {
    await env.cleanup();
    await fx.close();
  });

  it("exports a flow that script run replays with --arg values; no typed value in the file; 0600; TODO for the ambiguous button", async () => {
    const s = "exp";
    assert.equal((await env.open(s, ["--actions", "interact"])).exitCode, 0);
    const h = (args: string[], input?: string) => env.hound([...args, "--session-name", s, "--json"], input === undefined ? {} : { input });
    assert.equal((await h(["page", "navigate", "--url", fx.url("/flow")])).exitCode, 0);
    const snap = (await h(["page", "snapshot"])).json.data.snapshot as string;
    const name = refFor(snap, /textbox "Full name"/);
    const code = refFor(snap, /textbox "Secret code"/);
    const plan = refFor(snap, /combobox "Plan"/);
    const agree = refFor(snap, /checkbox "I agree"/);
    const go = refFor(snap, /button "Continue"/);
    const add = refFor(snap, /button "Add"/);
    const filled = await h(["element", "fill", "--ref", name, "--value", NAME_VALUE]);
    assert.equal(filled.exitCode, 0, filled.stdout);
    const typed = await h(["element", "fill", "--ref", code, "--value-file", "-"], CODE_VALUE);
    assert.equal(typed.exitCode, 0, typed.stdout);
    for (const args of [
      ["element", "select", "--ref", plan, "--option", "pro"],
      ["element", "check", "--ref", agree],
      ["element", "click", "--ref", add],
      ["element", "click", "--ref", go],
      ["page", "wait", "--for", "text", "--value", "All set"],
    ]) {
      const r = await h(args);
      assert.equal(r.exitCode, 0, `${args.join(" ")}: ${r.stdout}`);
    }
    const snap2 = (await h(["page", "snapshot"])).json.data.snapshot as string;
    assert.equal((await h(["element", "click", "--ref", refFor(snap2, /link "About page"/)])).exitCode, 0);

    const out = join(env.cwd, "flow.test.ts");
    const exp = await h(["script", "export", "--output", out, "--name", "flow-test"]);
    assert.equal(exp.exitCode, 0, exp.stdout);
    const data = exp.json.data;
    assert.equal(data.file, out);
    assert.equal(data.startUrl, fx.url("/flow"));
    assert.equal(data.steps, 9);
    assert.ok(data.ambiguous >= 1, "the two identical Add buttons give an ambiguous locator");
    assert.deepEqual(data.params, ["full_name", "secret_code"]);
    assert.match(exp.json.next_actions[0].command, /^hound script run --file .* --url .*\/flow --arg 'full_name=<full_name>' --arg 'secret_code=<secret_code>' --json$/);
    assert.equal(mode(out), 0o600);
    const text = readFileSync(out, "utf8");
    assert.ok(!text.includes(NAME_VALUE) && !text.includes(CODE_VALUE), "typed values never reach the script");
    assert.ok(!exp.stdout.includes(NAME_VALUE) && !exp.stdout.includes(CODE_VALUE));
    assert.match(text, /TODO verify locator: button "Add" matched more than one element/);
    assert.match(text, /getByRole\("button", \{ name: "Add", exact: true \}\)\.nth\(0\)/);
    assert.match(text, /\.fill\(arg\("full_name"\)\)/);
    assert.match(text, /selectOption\(\["pro"\]\)/);
    assert.match(text, /setChecked\(true\)/);
    assert.match(text, /text \\"All set\\" visible/);
    assert.match(text, /final url path is \/about/);

    // Default location: the session's runs dir, 0600; --output refuses an existing file.
    const dflt = await h(["script", "export"]);
    assert.equal(dflt.exitCode, 0, dflt.stdout);
    assert.ok(dflt.json.data.file.startsWith(join(env.home, "runs", "browser", s, "export-")));
    assert.equal(mode(dflt.json.data.file), 0o600);
    const again = await h(["script", "export", "--output", out]);
    assert.equal(again.exitCode, 1);
    assert.equal(again.json.error.code, "CONFLICT");
    const badExt = await h(["script", "export", "--output", join(env.cwd, "x.js")]);
    assert.equal(badExt.exitCode, 2);
    assert.equal(badExt.json.error.field, "output");

    // The replay passes with the parameters, and fails (RUN_ERROR) without them.
    const run = await env.hound(["script", "run", "--file", out, "--url", fx.url("/flow"), "--arg", "full_name=Someone", "--arg", "secret_code=x", "--json"], { timeoutMs: 120_000 });
    assert.equal(run.exitCode, 0, run.stdout);
    assert.equal(run.json.data.status, "pass");
    const checks = run.json.data.checks as { name: string; ok: boolean }[];
    assert.ok(checks.some((c) => /All set/.test(c.name) && c.ok));
    assert.ok(checks.some((c) => c.name === "final url path is /about" && c.ok));
    const missing = await env.hound(["script", "run", "--file", out, "--url", fx.url("/flow"), "--json"], { timeoutMs: 120_000 });
    assert.equal(missing.exitCode, 1);
    assert.equal(missing.json.error.code, "RUN_ERROR");
  });

  it("refuses to export an empty log", async () => {
    const s = "exp-empty";
    assert.equal((await env.open(s)).exitCode, 0);
    const r = await env.hound(["script", "export", "--session-name", s, "--json"]);
    assert.equal(r.exitCode, 1);
    assert.equal(r.json.error.code, "VALIDATION_FAILED");
  });
});
