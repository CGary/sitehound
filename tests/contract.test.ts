/** CLI contract: schema, layered help, usage errors, output modes. No browser needed. */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { makeEnv, type Env } from "./helpers/hound.ts";

/** The final command catalog (docs/cli contract). Every one must be registered. */
const CATALOG = [
  "browser open", "browser close", "browser list", "browser status",
  "page navigate", "page snapshot", "page find", "page screenshot", "page pdf", "page wait", "page back", "page forward", "page reload", "page scroll", "page tabs", "page resize", "page emulate",
  "element click", "element drag", "element check", "element uncheck", "element read", "element hover", "element fill", "element select", "element press", "element type", "element download", "element upload",
  "diag console", "diag network", "diag request", "diag dialogs", "diag trace",
  "profile list", "profile check", "profile login", "profile delete",
  "task list", "task run", "script run", "script export",
  "batch",
];
const DOMAINS = ["browser", "page", "element", "diag", "profile", "task", "script", "batch"];
/** Top-level commands without a verb: `hound batch --help` is the command's own help. */
const SOLO = new Set(["batch"]);

describe("cli contract", () => {
  let env: Env;
  before(async () => {
    env = await makeEnv();
  });
  after(async () => {
    await env.cleanup();
  });

  it("registers every catalog command in its domain help", async () => {
    const found: string[] = [];
    for (const domain of DOMAINS) {
      const r = await env.raw([domain, "--help"]);
      assert.equal(r.exitCode, 0);
      if (SOLO.has(domain)) {
        assert.match(r.stdout, new RegExp(`^hound ${domain} — `), `${domain} --help is its command help`);
        found.push(domain);
        continue;
      }
      for (const line of r.stdout.split("\n")) {
        const m = new RegExp(`^  (${domain} [a-z-]+)\\s`).exec(line);
        if (m) found.push(m[1]!);
      }
    }
    for (const name of CATALOG) assert.ok(found.includes(name), `missing command: ${name}`);
  });

  it("--schema is valid JSON with the required keys for every command", async () => {
    const results = await Promise.all(CATALOG.map(async (name) => ({ name, r: await env.raw([...name.split(" "), "--schema"]) })));
    for (const { name, r } of results) {
      assert.equal(r.exitCode, 0, `${name}: exit ${r.exitCode}`);
      const schema = JSON.parse(r.stdout);
      assert.equal(schema.command, name.replace(" ", "."), name);
      assert.equal(typeof schema.description, "string", name);
      assert.ok(["read", "write", "session"].includes(schema.kind), `${name}: kind ${schema.kind}`);
      assert.ok(Array.isArray(schema.input.required), `${name}: input.required`);
      assert.equal(typeof schema.input.properties, "object", `${name}: input.properties`);
      for (const req of schema.input.required) assert.ok(req in schema.input.properties, `${name}: required ${req} has a property`);
      for (const prop of Object.values<any>(schema.input.properties)) {
        assert.equal(typeof prop.type, "string");
        assert.equal(typeof prop.description, "string");
      }
      assert.deepEqual(schema.output.required, ["ok", "command", "summary", "data"], name);
      assert.equal(schema.examples.length, 3, `${name}: 3 examples`);
      for (const ex of schema.examples) assert.match(ex, /^(hound |printf .*\| hound )/, `${name}: example is a runnable hound command`);
    }
  });

  it("--schema exposes enums, defaults and required flags", async () => {
    const wait = JSON.parse((await env.raw(["page", "wait", "--schema"])).stdout);
    assert.deepEqual(wait.input.required.sort(), ["for", "session-name"]);
    assert.deepEqual(wait.input.properties.for.enum, ["text", "text-gone", "url", "ref", "ref-hidden", "request", "load"]);
    const open = JSON.parse((await env.raw(["browser", "open", "--schema"])).stdout);
    assert.equal(open.kind, "session");
    assert.deepEqual(open.input.properties.actions.enum, ["read", "interact"]);
    assert.equal(open.input.properties.actions.default, "read");
    const select = JSON.parse((await env.raw(["element", "select", "--schema"])).stdout);
    assert.equal(select.input.properties.option.type, "array");
  });

  it("--help is layered: root, domain, command", async () => {
    const root = await env.raw(["--help"]);
    assert.equal(root.exitCode, 0);
    for (const d of DOMAINS) assert.match(root.stdout, new RegExp(`^  ${d}\\s`, "m"), `root help lists ${d}`);
    assert.match(root.stdout, /--schema/);

    const domain = await env.raw(["page", "--help"]);
    assert.match(domain.stdout, /page navigate/);
    assert.match(domain.stdout, /page wait/);
    assert.doesNotMatch(domain.stdout, /element click/, "domain help lists only its own verbs");

    const cmd = await env.raw(["page", "wait", "--help"]);
    assert.match(cmd.stdout, /--session-name/);
    assert.match(cmd.stdout, /--for <text\|text-gone\|url\|ref\|ref-hidden\|request\|load>/);
    const examples = cmd.stdout.split("Examples:")[1]!.split("\n").filter((l) => l.trim());
    assert.equal(examples.length, 3);
    assert.ok(cmd.stdout.length < root.stdout.length * 3, "command help stays short");
  });

  it("unknown command: UNKNOWN_COMMAND, exit 2, with a suggestion for a typo", async () => {
    const typo = await env.hound(["page", "naviagte"]);
    assert.equal(typo.exitCode, 2);
    assert.equal(typo.json.ok, false);
    assert.equal(typo.json.error.code, "UNKNOWN_COMMAND");
    assert.match(typo.json.error.message, /Did you mean "page navigate"/);
    assert.match(typo.json.suggested_fix.command, /^hound page navigate /);
    assert.equal(typo.json.retryable, true);

    const nonsense = await env.hound(["zzzzzzzzzz"]);
    assert.equal(nonsense.exitCode, 2);
    assert.equal(nonsense.json.error.code, "UNKNOWN_COMMAND");
    assert.deepEqual(nonsense.json.error.allowed, DOMAINS);
  });

  it("usage errors exit 2 with structured fields", async () => {
    const missing = await env.hound(["page", "wait", "--session-name", "x"]);
    assert.equal(missing.exitCode, 2);
    assert.equal(missing.json.error.code, "MISSING_REQUIRED_FLAG");
    assert.equal(missing.json.error.field, "for");
    assert.ok(missing.json.suggested_fix.command.startsWith("hound page wait"));

    const badEnum = await env.hound(["page", "wait", "--session-name", "x", "--for", "bogus"]);
    assert.equal(badEnum.exitCode, 2);
    assert.equal(badEnum.json.error.code, "INVALID_ENUM");
    assert.equal(badEnum.json.error.field, "for");
    assert.equal(badEnum.json.error.received, "bogus");
    assert.deepEqual(badEnum.json.error.allowed, ["text", "text-gone", "url", "ref", "ref-hidden", "request", "load"]);

    const badInt = await env.hound(["page", "snapshot", "--session-name", "x", "--limit-chars", "abc"]);
    assert.equal(badInt.exitCode, 2);
    assert.equal(badInt.json.error.code, "INVALID_ARGUMENT");
    assert.equal(badInt.json.error.field, "limit-chars");

    const unsafe = await env.hound(["browser", "close", "--session-name", "../escape"]);
    assert.equal(unsafe.exitCode, 2);
    assert.equal(unsafe.json.error.code, "INVALID_ARGUMENT");
    assert.equal(unsafe.json.error.field, "session-name");
  });

  it("non-TTY stdout defaults to exactly one JSON envelope (no --json needed)", async () => {
    const r = await env.hound(["browser", "list"]);
    assert.equal(r.exitCode, 0);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.command, "browser.list");
    assert.equal(typeof r.json.summary, "string");
    assert.deepEqual(r.json.data, { count: 0, sessions: [] });
    assert.ok(Array.isArray(r.json.next_actions) && r.json.next_actions.length <= 3);
    for (const a of r.json.next_actions) assert.match(a.command, /^hound .* --json$/);
  });

  it("--plain output is short human text, not JSON", async () => {
    const r = await env.raw(["task", "list", "--plain"]);
    assert.equal(r.exitCode, 0);
    assert.throws(() => JSON.parse(r.stdout));
    assert.match(r.stdout, /snapshot/);

    const list = await env.raw(["browser", "list", "--plain"]);
    assert.equal(list.stdout.split("\n")[0], "No browser sessions running.");
    assert.throws(() => JSON.parse(list.stdout));
  });

  it("--plain errors go to stderr and keep the exit code", async () => {
    const r = await env.raw(["page", "wait", "--session-name", "x", "--plain"]);
    assert.equal(r.exitCode, 2);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /MISSING_REQUIRED_FLAG/);
  });

  it("--version prints the version and legacy aliases warn on stderr only", async () => {
    const v = await env.raw(["--version"]);
    assert.match(v.stdout.trim(), /^\d+\.\d+\.\d+/);
    const legacy = await env.hound(["tasks"]);
    assert.equal(legacy.exitCode, 0);
    assert.equal(legacy.json.command, "task.list");
    assert.match(legacy.stderr, /deprecated/);
    const quiet = await env.hound(["tasks", "--quiet"]);
    assert.doesNotMatch(quiet.stderr, /deprecated/);
  });
});
