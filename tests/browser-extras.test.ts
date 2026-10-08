/** element type, element download and diag request: end to end against the local fixture server. */
import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { makeEnv, refFor, startFixture, type Env, type Fixture } from "./helpers/hound.ts";

const mode = (p: string) => statSync(p).mode & 0o777;

describe("element type, download and diag request", () => {
  let env: Env;
  let fx: Fixture;
  let scratch = "";
  const IA = "ext-interact";
  const RD = "ext-read";
  const ia = (args: string[], opts?: { input?: string }) => env.hound(args.concat("--session-name", IA), opts);
  const rd = (args: string[], opts?: { input?: string }) => env.hound(args.concat("--session-name", RD), opts);

  before(async () => {
    env = await makeEnv();
    fx = await startFixture();
    scratch = await mkdtemp(join(tmpdir(), "hound-extras-"));
    const [a, b] = await Promise.all([env.open(IA, ["--actions", "interact"]), env.open(RD)]);
    assert.equal(a.exitCode, 0, a.stderr);
    assert.equal(b.exitCode, 0, b.stderr);
  });
  after(async () => {
    await env.cleanup();
    await fx.close();
    await rm(scratch, { recursive: true, force: true });
  });

  async function refs(run: typeof ia, path: string, wanted: Record<string, RegExp>): Promise<Record<string, string>> {
    assert.equal((await run(["page", "navigate", "--url", fx.url(path)])).exitCode, 0);
    const snap = await run(["page", "snapshot"]);
    return Object.fromEntries(Object.entries(wanted).map(([k, re]) => [k, refFor(snap.json.data.snapshot, re)]));
  }

  describe("element type", () => {
    let r: Record<string, string> = {};
    it("fires key events: fill alone does not trigger the keyup handler, type does", async () => {
      r = await refs(ia, "/type", { q: /textbox "Search"/, notes: /textbox "Notes"/, box: /textbox "Keys box"/ });
      const fill = await ia(["element", "fill", "--ref", r.q!, "--value", "zzz"]);
      assert.equal(fill.exitCode, 0, fill.stderr);
      const snap = await ia(["page", "snapshot"]);
      assert.doesNotMatch(snap.json.data.snapshot, /keyup:/, "fill fires no key events");

      const typed = await ia(["element", "type", "--ref", r.q!, "--value", "xqzmar", "--clear"]);
      assert.equal(typed.exitCode, 0, typed.stderr);
      assert.deepEqual(typed.json.data, { ref: r.q, chars: 6 });
      assert.match(typed.json.summary, /6 chars/);
      assert.doesNotMatch(typed.stdout + typed.stderr, /xqzmar/, "the value is never echoed");
      const wait = await ia(["page", "wait", "--for", "text", "--value", "keyup:xqzmar keydowns:", "--timeout", "5"]);
      assert.equal(wait.exitCode, 0, "keyup fired for the typed text only (--clear removed 'zzz' without key events)");
    });

    it("--value-file - reads stdin; no --clear appends", async () => {
      const t = await ia(["element", "type", "--ref", r.q!, "--value-file", "-", "--delay-ms", "0"], { input: "!!\n" });
      assert.equal(t.exitCode, 0, t.stderr);
      assert.equal(t.json.data.chars, 2);
      const wait = await ia(["page", "wait", "--for", "text", "--value", "keyup:xqzmar!! keydowns:", "--timeout", "5"]);
      assert.equal(wait.exitCode, 0);
    });

    it("--clear works on contenteditable and on a non-input focusable element", async () => {
      const ce = await ia(["element", "type", "--ref", r.notes!, "--value", "new", "--clear"]);
      assert.equal(ce.exitCode, 0, ce.stderr);
      const mirror = await ia(["page", "wait", "--for", "text", "--value", "notes:new", "--timeout", "5"]);
      assert.equal(mirror.exitCode, 0, "the old text was removed, then 'new' typed");

      const box = await ia(["element", "type", "--ref", r.box!, "--value", "ab", "--clear", "--delay-ms", "5"]);
      assert.equal(box.exitCode, 0, box.stderr);
      const wait = await ia(["page", "wait", "--for", "text", "--value", "[Backspace][a][b]", "--timeout", "5"]);
      assert.equal(wait.exitCode, 0, "select-all + Backspace, then the typed keys");
    });

    it("the typing budget and the file-content cap are declared in --schema and enforced before any work", async () => {
      const schema = JSON.parse((await env.raw(["element", "type", "--schema"])).stdout);
      assert.equal(schema.input.properties["value-file"].maxChars, 5000);
      const [rule] = schema.input.cost_rules;
      assert.deepEqual({ text: rule.text, perChar: rule.perChar, extraMs: rule.extraMs, baseMs: rule.baseMs, maxMs: rule.maxMs }, { text: ["value", "value-file"], perChar: "delay-ms", extraMs: 5, baseMs: 10000, maxMs: 600000 });
      assert.match(rule.formula, /10000 \+ chars/);
      // 2000 chars: 10 s + 2000 x (delay + 5 ms) is over 600 s from delay 291 on.
      const over = await ia(["element", "type", "--ref", r.q!, "--value", "x".repeat(2000), "--delay-ms", "300"]);
      assert.equal(over.exitCode, 2);
      assert.equal(over.json.error.field, "delay-ms");
      assert.match(over.json.suggested_fix.command, /--delay-ms 290/);
      const fileTooLong = await env.hound(["element", "type", "--session-name", "ghost", "--ref", "e1", "--value-file", "-"], { input: "y".repeat(5001) });
      assert.equal(fileTooLong.exitCode, 2, "checked before the session is even looked up");
      assert.equal(fileTooLong.json.error.code, "INVALID_ARGUMENT");
      assert.equal(fileTooLong.json.error.field, "value-file");
      assert.doesNotMatch(fileTooLong.stdout, /yyyy/);
    });

    it("validation is declared and checked before anything runs", async () => {
      const schema = JSON.parse((await env.raw(["element", "type", "--schema"])).stdout);
      assert.equal(schema.input.properties.value.maxLength, 5000);
      assert.equal(schema.input.properties["delay-ms"].default, 30);
      assert.equal(schema.input.properties["delay-ms"].minimum, 0);
      assert.equal(schema.input.properties["delay-ms"].maximum, 1000);
      assert.equal(schema.input.properties.clear.type, "boolean");
      const missing = await ia(["element", "type", "--ref", r.q!]);
      assert.equal(missing.exitCode, 2);
      assert.equal(missing.json.error.code, "MISSING_REQUIRED_FLAG");
      const fast = await ia(["element", "type", "--ref", r.q!, "--value", "x", "--delay-ms", "5000"]);
      assert.equal(fast.exitCode, 2);
      assert.equal(fast.json.error.field, "delay-ms");
      const long = await ia(["element", "type", "--ref", r.q!, "--value", "x".repeat(5001)]);
      assert.equal(long.exitCode, 2);
      assert.equal(long.json.error.field, "value");
      const slow = await ia(["element", "type", "--ref", r.q!, "--value", "x".repeat(1000), "--delay-ms", "1000"]);
      assert.equal(slow.exitCode, 2, "chars x delay beyond 600 s");
      assert.equal(slow.json.error.field, "delay-ms");
      const ghost = await ia(["element", "type", "--ref", "e999", "--value", "x"]);
      assert.equal(ghost.json.error.code, "REF_NOT_FOUND");
    });
  });

  describe("element download", () => {
    let ia$: Record<string, string> = {};
    it("link: saves under the session downloads dir, 0600, sanitized name, never overwrites", async () => {
      ia$ = await refs(ia, "/downloads", { link: /link "Get report"/, evil: /link "Get evil"/, leak: /link "Get leak"/, stuck: /link "Get stuck"/, button: /button "Export PDF"/, none: /button "Do nothing"/ });
      const first = await ia(["element", "download", "--ref", ia$.link!]);
      assert.equal(first.exitCode, 0, first.stderr);
      const d = first.json.data;
      assert.deepEqual(Object.keys(d).sort(), ["bytes", "file", "suggestedFilename", "url"]);
      assert.equal(d.suggestedFilename, "report.txt");
      assert.equal(d.bytes, 12);
      assert.equal(d.url, fx.url("/files/report.txt"));
      const dir = join(env.home, "runs", "browser", IA, "downloads");
      assert.equal(d.file, join(dir, "report.txt"));
      assert.equal(mode(d.file), 0o600);
      assert.equal(mode(dir), 0o700);
      assert.equal(readFileSync(d.file, "utf8"), "hello report");
      assert.doesNotMatch(first.stdout, /hello report/, "contents are never returned");

      const second = await ia(["element", "download", "--ref", ia$.link!]);
      assert.equal(second.exitCode, 0, second.stderr);
      assert.equal(second.json.data.file, join(dir, "report-2.txt"));
      assert.equal(readFileSync(d.file, "utf8"), "hello report");
    });

    it("a path-traversal filename is sanitized and stays inside the downloads dir", async () => {
      const r = await ia(["element", "download", "--ref", ia$.evil!]);
      assert.equal(r.exitCode, 0, r.stderr);
      assert.ok(!r.json.data.suggestedFilename.includes("/"), r.json.data.suggestedFilename);
      assert.equal(dirname(r.json.data.file), join(env.home, "runs", "browser", IA, "downloads"));
      assert.match(basename(r.json.data.file), /evil\.txt$/);
    });

    it("button + --output: saved there (0600); an existing file is CONFLICT until --if-exists overwrite", async () => {
      const out = join(scratch, "export.txt");
      const ok = await ia(["element", "download", "--ref", ia$.button!, "--output", out]);
      assert.equal(ok.exitCode, 0, ok.stderr);
      assert.equal(ok.json.data.file, out);
      assert.equal(mode(out), 0o600);
      assert.equal(readFileSync(out, "utf8"), "hello report");

      const conflict = await ia(["element", "download", "--ref", ia$.button!, "--output", out]);
      assert.equal(conflict.exitCode, 1);
      assert.equal(conflict.json.error.code, "CONFLICT");
      assert.match(conflict.json.suggested_fix.command, /--if-exists overwrite/);

      const over = await ia(["element", "download", "--ref", ia$.button!, "--output", out, "--if-exists", "overwrite"]);
      assert.equal(over.exitCode, 0, over.stderr);

      const dirOut = await ia(["element", "download", "--ref", ia$.button!, "--output", scratch]);
      assert.equal(dirOut.json.error.code, "INVALID_ARGUMENT");
      const missingDir = await ia(["element", "download", "--ref", ia$.button!, "--output", join(scratch, "nope", "x.txt")]);
      assert.equal(missingDir.json.error.code, "FILE_NOT_FOUND");
    });

    it("no download within the timeout: TIMEOUT, not retryable, suggests a snapshot", async () => {
      const t0 = Date.now();
      const r = await ia(["element", "download", "--ref", ia$.none!, "--timeout", "2"]);
      assert.equal(r.exitCode, 1);
      assert.equal(r.json.error.code, "TIMEOUT");
      assert.match(r.json.error.message, /No download started within 2s/);
      assert.equal(r.json.retryable, false);
      assert.match(r.json.suggested_fix.command, /^hound page snapshot --session-name ext-interact/);
      assert.ok(Date.now() - t0 < 9000);
      const ghost = await ia(["element", "download", "--ref", "e999"]);
      assert.equal(ghost.json.error.code, "REF_NOT_FOUND");
    });

    it("a suggested name holding an e-mail address or token is masked everywhere", async () => {
      const r = await ia(["element", "download", "--ref", ia$.leak!]);
      assert.equal(r.exitCode, 0, r.stderr);
      assert.doesNotMatch(r.stdout, /jane|example\.com|A1b2C3d4/);
      assert.match(basename(r.json.data.file), /\.txt$/);
      assert.doesNotMatch(r.json.data.file, /jane|example\.com|A1b2C3d4/);
    });

    it("a download that never finishes: TIMEOUT, the daemon queue is not blocked, nothing is left behind", async () => {
      const t0 = Date.now();
      const r = await ia(["element", "download", "--ref", ia$.stuck!, "--timeout", "3"]);
      assert.equal(r.exitCode, 1);
      assert.equal(r.json.error.code, "TIMEOUT");
      assert.equal(r.json.retryable, false);
      assert.ok(Date.now() - t0 < 12_000, `took ${Date.now() - t0} ms`);
      const t1 = Date.now();
      const next = await ia(["page", "snapshot", "--timeout", "10"]);
      assert.equal(next.exitCode, 0, "the next op is answered, not queued behind the stuck download");
      assert.ok(Date.now() - t1 < 5000, `next op took ${Date.now() - t1} ms`);
      const dir = join(env.home, "runs", "browser", IA, "downloads");
      assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith(".partial")), []);
      assert.ok(!readdirSync(dir).some((f) => /stuck/.test(f)));
    });

    it("downloads land in a private per-session directory that goes away with the session", async () => {
      const dir = join(env.home, "sessions", IA, "pw-downloads");
      assert.ok(existsSync(dir));
      assert.equal(mode(dir), 0o700);
    });

    it("read level: a real link downloads, a button is ACTION_BLOCKED", async () => {
      const r = await refs(rd, "/downloads", { link: /link "Get report"/, button: /button "Export PDF"/ });
      const ok = await rd(["element", "download", "--ref", r.link!]);
      assert.equal(ok.exitCode, 0, ok.stderr);
      assert.ok(ok.json.data.file.startsWith(join(env.home, "runs", "browser", RD, "downloads")));
      const blocked = await rd(["element", "download", "--ref", r.button!]);
      assert.equal(blocked.exitCode, 1);
      assert.equal(blocked.json.error.code, "ACTION_BLOCKED");
      assert.match(blocked.json.suggested_fix.command, /--actions interact/);
    });

    it("read level blocks type", async () => {
      const r = await refs(rd, "/type", { q: /textbox "Search"/ });
      const blocked = await rd(["element", "type", "--ref", r.q!, "--value", "abc"]);
      assert.equal(blocked.exitCode, 1);
      assert.equal(blocked.json.error.code, "ACTION_BLOCKED");
    });
  });

  describe("diag request", () => {
    type Entry = { index: number; method: string; url: string; status?: number };
    let entries: Entry[] = [];
    const find = (method: string, path: string, status?: number): number => {
      const e = entries.find((x) => x.method === method && x.url === fx.url(path) && (status === undefined || x.status === status));
      assert.ok(e, `no ${method} ${path} in ${JSON.stringify(entries)}`);
      return e.index;
    };
    const req = (index: number, part: string, extra: string[] = []) => rd(["diag", "request", "--index", String(index), "--part", part, ...extra]);
    const SECRETS = /hunter2|TOK-SECRET|KEY123|AUTHHEADER|Bearer|pw-SECRET|zzz|topsecret|FILEBODY|SESS-SECRET|COOKIE-SECRET|ACCESS-SECRET|access=ABC/;

    before(async () => {
      await rd(["page", "navigate", "--url", fx.url("/net")]);
      const w = await rd(["page", "wait", "--for", "text", "--value", "net done"]);
      assert.equal(w.exitCode, 0, w.stderr);
      const net = await rd(["diag", "network", "--state", "all", "--limit", "100"]);
      entries = net.json.data.entries;
    });

    it("diag network exposes unique increasing indexes and points at diag request", async () => {
      const idx = entries.map((e) => e.index);
      assert.ok(idx.length >= 6);
      assert.ok(idx.every((n) => Number.isInteger(n) && n >= 1));
      assert.equal(new Set(idx).size, idx.length);
      assert.deepEqual([...idx].sort((a, b) => a - b), idx);
      const net = await rd(["diag", "network", "--state", "all"]);
      assert.ok(net.json.next_actions.some((a: { command: string }) => /^hound diag request --session-name ext-read --index \d+ --part request-body --json$/.test(a.command)), JSON.stringify(net.json.next_actions));
    });

    it("JSON request body: nested secrets redacted, other values and shape kept, no headers", async () => {
      const r = await req(find("POST", "/api/login"), "request-body");
      assert.equal(r.exitCode, 0, r.stderr);
      const d = r.json.data;
      assert.deepEqual(Object.keys(d).sort(), ["bytes", "body", "contentType", "format", "index", "method", "part", "redacted", "totalChars", "truncated", "url"].sort());
      assert.equal(d.method, "POST");
      assert.equal(d.url, fx.url("/api/login"));
      assert.equal(d.contentType, "application/json");
      assert.equal(d.redacted, true);
      assert.equal(d.format, "json");
      assert.equal(d.truncated, false);
      assert.ok(d.bytes > 50);
      const body = JSON.parse(d.body);
      assert.equal(body.user, "ann");
      assert.equal(body.password, "[redacted]");
      assert.equal(body.profile.token, "[redacted]");
      assert.equal(body.profile.name, "Ann");
      assert.equal(body.items[0].api_key, "[redacted]");
      assert.equal(body.items[1].note, "see https://x.test/p");
      assert.doesNotMatch(r.stdout + r.stderr, SECRETS, "no secret, header or cookie value anywhere in the output");
      assert.doesNotMatch(r.stdout, /authorization|set-cookie|"headers"/i);
    });

    it("form-urlencoded request body", async () => {
      const r = await req(find("POST", "/api/form"), "request-body");
      assert.equal(r.json.data.format, "form");
      assert.equal(r.json.data.contentType, "application/x-www-form-urlencoded");
      assert.equal(r.json.data.body, "name=ann\npassword=[redacted]\ncsrf_token=[redacted]\ncity=Madrid");
      assert.doesNotMatch(r.stdout, SECRETS);
    });

    it("multipart request body: part names and sizes, no file contents", async () => {
      const r = await req(find("POST", "/api/upload"), "request-body");
      assert.equal(r.json.data.format, "multipart");
      assert.equal(r.json.data.contentType, "multipart/form-data");
      assert.match(r.json.data.body, /title: 5 bytes, value "Hello"/);
      assert.match(r.json.data.body, /secret_note: 9 bytes, value "\[redacted\]"/);
      assert.match(r.json.data.body, /file: file, 16 bytes/);
      assert.doesNotMatch(r.stdout, SECRETS);
    });

    it("JSON response body: secrets redacted, status reported, cookies never present", async () => {
      const login = await req(find("POST", "/api/login"), "response-body");
      assert.equal(login.exitCode, 0, login.stderr);
      assert.equal(login.json.data.status, 200);
      const body = JSON.parse(login.json.data.body);
      assert.equal(body.session, "[redacted]");
      assert.deepEqual(body.user, { name: "Ann", email: "a@x.test" });
      const data = await req(find("GET", "/api/data", 200), "response-body");
      assert.equal(JSON.parse(data.json.data.body).auth, "[redacted]");
      assert.deepEqual(JSON.parse(data.json.data.body).items, [1, 2, 3]);
      assert.doesNotMatch(login.stdout + data.stdout, SECRETS);
    });

    it("binary response: no content, only type and size", async () => {
      const r = await req(find("GET", "/api/bin"), "response-body");
      assert.equal(r.exitCode, 0, r.stderr);
      assert.equal(r.json.data.contentType, "application/octet-stream");
      assert.equal(r.json.data.bytes, 256);
      assert.equal(r.json.data.omitted, "binary");
      assert.equal(r.json.data.body, undefined);
      assert.equal(r.json.data.file, undefined);
    });

    it("redirect, missing body and unknown index give clear errors", async () => {
      const redirect = await req(find("GET", "/api/redirect", 302), "response-body");
      assert.equal(redirect.exitCode, 2);
      assert.equal(redirect.json.error.code, "INVALID_ARGUMENT");
      assert.match(redirect.json.error.message, /redirect/);

      const blob = await req(find("POST", "/api/blob"), "request-body");
      assert.equal(blob.json.error.code, "INVALID_ARGUMENT");
      assert.match(blob.json.error.message, /not available/);

      const none = await req(find("GET", "/api/data", 200), "request-body");
      assert.equal(none.json.error.code, "INVALID_ARGUMENT");
      assert.match(none.json.error.message, /no request body/);

      const unknown = await req(999999, "request-body");
      assert.equal(unknown.exitCode, 2);
      assert.equal(unknown.json.error.code, "INVALID_ARGUMENT");
      assert.equal(unknown.json.error.field, "index");
      assert.equal(unknown.json.retryable, true);
      assert.match(unknown.json.suggested_fix.command, /^hound diag network --session-name ext-read/);

      const bad = await rd(["diag", "request", "--index", "0", "--part", "request-body"]);
      assert.equal(bad.exitCode, 2);
      const noPart = await rd(["diag", "request", "--index", "1"]);
      assert.equal(noPart.json.error.code, "MISSING_REQUIRED_FLAG");
    });

    it("--limit-chars truncates inline and saves the full redacted text; --output follows CONFLICT rules", async () => {
      const idx = find("POST", "/api/login");
      const cut = await req(idx, "request-body", ["--limit-chars", "20"]);
      assert.equal(cut.json.data.truncated, true);
      assert.equal(cut.json.data.body.length, 20);
      const file: string = cut.json.data.file;
      assert.ok(file.startsWith(join(env.home, "runs", "browser", RD)), file);
      assert.equal(mode(file), 0o600);
      const full = readFileSync(file, "utf8");
      assert.equal(full.length, cut.json.data.totalChars);
      assert.equal(JSON.parse(full).password, "[redacted]");
      assert.doesNotMatch(full, SECRETS);

      const out = join(scratch, "body.json");
      const ok = await req(idx, "request-body", ["--output", out]);
      assert.equal(ok.json.data.file, out);
      assert.equal(mode(out), 0o600);
      const conflict = await req(idx, "request-body", ["--output", out]);
      assert.equal(conflict.json.error.code, "CONFLICT");
      assert.equal((await req(idx, "request-body", ["--output", out, "--if-exists", "overwrite"])).exitCode, 0);
    });

    it("a 300 000 character body is reported as truncated and saved whole", async () => {
      const idx = find("GET", "/api/big");
      const r = await req(idx, "response-body");
      assert.equal(r.json.data.truncated, true);
      assert.equal(r.json.data.totalChars, 300_000);
      assert.equal(r.json.data.body.length, 8000);
      assert.equal(readFileSync(r.json.data.file, "utf8").length, 300_000);
      const max = await req(idx, "response-body", ["--limit-chars", "200000"]);
      assert.equal(max.json.data.body.length, 200_000, "the documented maximum is reachable");
      assert.equal(max.json.data.truncated, true);
    });

    it("--output never follows or overwrites a link that appeared after the CLI check (daemon level)", async () => {
      process.env.HOUND_HOME = env.home;
      const { callBrowserSession } = await import("../packages/core/src/index.ts");
      const idx = find("POST", "/api/form");
      const victim = join(scratch, "victim.txt");
      writeFileSync(victim, "VICTIM");
      const link = join(scratch, "link.txt");
      symlinkSync(victim, link);
      const call = (extra: Record<string, unknown>) => callBrowserSession<{ file: string }>(RD, "request", { index: idx, part: "request-body", ...extra });

      await assert.rejects(call({ output: link, ifExists: "error" }), (e: any) => e.code === "CONFLICT");
      assert.equal(readFileSync(victim, "utf8"), "VICTIM");
      assert.ok(lstatSync(link).isSymbolicLink(), "untouched");

      await call({ output: link, ifExists: "overwrite" });
      assert.equal(readFileSync(victim, "utf8"), "VICTIM", "the link target is never written through");
      assert.ok(!lstatSync(link).isSymbolicLink(), "the link itself was replaced by the new file");
      assert.equal(mode(link), 0o600);
      assert.match(readFileSync(link, "utf8"), /name=ann/);

      const existing = join(scratch, "existing.txt");
      writeFileSync(existing, "KEEP");
      await assert.rejects(call({ output: existing }), (e: any) => e.code === "CONFLICT", "no ifExists means exclusive");
      assert.equal(readFileSync(existing, "utf8"), "KEEP");
      assert.deepEqual(readdirSync(scratch).filter((f) => f.startsWith(".hound-partial")), [], "no temp files left");
    });

    it("the request buffer is bounded: after 520 requests the oldest index is gone", async () => {
      const first = find("GET", "/api/data", 200);
      assert.equal((await req(first, "response-body")).exitCode, 0, "still available before the buffer overflows");
      await rd(["page", "navigate", "--url", fx.url("/many")]);
      const w = await rd(["page", "wait", "--for", "text", "--value", "many done", "--timeout", "30"]);
      assert.equal(w.exitCode, 0, w.stderr);
      const gone = await req(first, "request-body");
      assert.equal(gone.json.error.code, "INVALID_ARGUMENT");
      assert.match(gone.json.error.message, /older than the last 500/);
      const net = await rd(["diag", "network", "--state", "all", "--limit", "500"]);
      assert.equal(net.json.data.total, 500, "the network list is bounded at the same size");
      const recent = net.json.data.entries[net.json.data.entries.length - 1].index;
      assert.equal((await req(recent, "response-body")).exitCode, 0);
    });
  });
});
