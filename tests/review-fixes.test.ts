/** Regressions for the adversarial review: trace redaction of prompt answers, sensitive reads, beforeunload, ReDoS, late dialogs, upload deny-list. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { link, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { resolveUploadFiles } from "../packages/core/src/browserd/upload.ts";
import { readZipEntry, readZipIndex } from "../packages/core/src/zip.ts";
import { makeEnv, refFor, startFixture, type Env, type Fixture } from "./helpers/hound.ts";

describe("review fixes", () => {
  let env: Env;
  let fx: Fixture;
  const IA = "rf-ia"; // interact, trace on
  const RD = "rf-rd"; // read
  const on = (name: string) => (args: string[]) => env.hound(args.concat("--session-name", name));
  const ia = on(IA);
  const rd = on(RD);

  before(async () => {
    env = await makeEnv();
    fx = await startFixture();
    const opened = await Promise.all([env.open(IA, ["--actions", "interact", "--trace", "on"]), env.open(RD)]);
    for (const o of opened) assert.equal(o.exitCode, 0, o.stderr);
  });
  after(async () => {
    await env.cleanup();
    await fx.close();
  });

  const go = async (run: typeof ia, path: string) => assert.equal((await run(["page", "navigate", "--url", fx.url(path)])).exitCode, 0);
  const snap = async (run: typeof ia) => (await run(["page", "snapshot", "--limit-chars", "200000"])).json.data.snapshot as string;
  const readout = async (run: typeof ia, role: string) => (await snap(run)).split("\n").find((l) => new RegExp(`- ${role}\\b`).test(l)) ?? "";
  async function waitText(run: typeof ia, text: string, timeout = 10) {
    const w = await run(["page", "wait", "--for", "text", "--value", text, "--timeout", String(timeout)]);
    assert.equal(w.exitCode, 0, `${text}: ${w.stdout}`);
  }

  it("1. a --dialog-text answer never reaches steps.json or the trace zip", async () => {
    await go(ia, "/dialogs");
    const ask = refFor(await snap(ia), /button "Ask name"/);
    const answer = "PromptAnswerMark77";
    const click = await ia(["element", "click", "--ref", ask, "--dialog", "accept", "--dialog-text", answer]);
    assert.equal(click.exitCode, 0, click.stderr);
    assert.match(await readout(ia, "status"), new RegExp(`name:${answer}`), "sanity: the page received the answer");
    const exported = await ia(["diag", "trace", "--action", "export"]);
    assert.equal(exported.exitCode, 0, exported.stderr);
    const { file, steps, actions } = exported.json.data;
    assert.ok(actions > 0);
    assert.doesNotMatch(readFileSync(steps, "utf8"), new RegExp(answer));
    const zip = readFileSync(file);
    const entries = readZipIndex(zip);
    assert.ok(entries.length > 0);
    for (const e of entries) assert.doesNotMatch(readZipEntry(zip, e).toString("latin1"), new RegExp(answer), `${e.name} holds the prompt answer`);
    assert.doesNotMatch(exported.stdout, new RegExp(answer));
  });

  it("2. element read refuses card, CVV, OTP, show-password and label-hinted fields (value and text), allows plain ones", async () => {
    await go(rd, "/sensitive");
    const s = await snap(rd);
    const labels = ["Pay number", "Security code", "Code box", "Shown secret", "Card number"];
    const outputs: string[] = [];
    for (const label of labels) {
      const line = s.split("\n").find((l) => l.includes(`"${label}"`));
      assert.ok(line, `${label} is in the snapshot`);
      const ref = /\[ref=([a-z0-9]+)\]/i.exec(line!)![1]!;
      for (const args of [["element", "read", "--ref", ref, "--attr", "value"], ["element", "read", "--ref", ref]]) {
        const r = await rd(args);
        outputs.push(r.stdout + r.stderr);
        assert.equal(r.json.error?.code, "ACTION_BLOCKED", `${label} ${args.join(" ")}`);
      }
    }
    for (const o of outputs) assert.doesNotMatch(o, /4111|123|482913|hunter2shown|4242/);
    const plain = await rd(["element", "read", "--ref", refFor(s, /textbox "Plain field"/), "--attr", "value"]);
    assert.equal(plain.json.data.value, "plain-value");
    const type = await rd(["element", "read", "--ref", refFor(s, /textbox "Shown secret"/), "--attr", "name"]);
    assert.equal(type.json.data.value, "pwd", "descriptive attributes stay readable");
  });

  it("3. beforeunload: a dismissed one cannot wedge the session; navigate and reload accept it and report it", async () => {
    await go(rd, "/unload");
    const leave = refFor(await snap(rd), /link "Leave page"/);
    const click = await rd(["element", "click", "--ref", leave]);
    assert.equal(click.exitCode, 0, click.stderr);
    assert.match(click.json.data.url, /\/unload$/, "the click's beforeunload was dismissed: still on the page");
    assert.equal(click.json.data.dialogs?.[0]?.type, "beforeunload");
    assert.equal(click.json.data.dialogs?.[0]?.action, "dismiss");
    const reload = await rd(["page", "reload", "--timeout", "15"]);
    assert.equal(reload.exitCode, 0, reload.stdout);
    assert.equal(reload.json.data.dialogs?.[0]?.type, "beforeunload");
    assert.equal(reload.json.data.dialogs?.[0]?.action, "accept");
    await go(rd, "/unload");
    await rd(["element", "click", "--ref", refFor(await snap(rd), /link "Leave page"/)]);
    const nav = await rd(["page", "navigate", "--url", fx.url("/about"), "--timeout", "15"]);
    assert.equal(nav.exitCode, 0, nav.stdout);
    assert.match(nav.json.data.url, /\/about$/);
    assert.equal(nav.json.data.dialogs?.[0]?.action, "accept");
  });

  it("4+10. page wait --for request: a catastrophic regex is cancelled (daemon stays alive); /api/ids is a substring, not a regex", async () => {
    await go(ia, "/redos");
    await waitText(ia, "redos done");
    const t0 = Date.now();
    const evil = await ia(["page", "wait", "--for", "request", "--value", "/(a+)+b/", "--since-index", "0", "--timeout", "20"]);
    assert.equal(evil.json.error?.code, "INVALID_ARGUMENT", evil.stdout);
    assert.equal(evil.json.error.field, "value");
    assert.ok(Date.now() - t0 < 15_000, "cancelled by the time budget");
    assert.equal((await ia(["browser", "status"])).exitCode, 0, "the daemon still answers");
    const long = await ia(["page", "wait", "--for", "request", "--value", `/${"a".repeat(201)}/`, "--timeout", "2"]);
    assert.equal(long.json.error?.code, "INVALID_ARGUMENT");
    const bad = await ia(["page", "wait", "--for", "request", "--value", "/(/", "--timeout", "2"]);
    assert.equal(bad.json.error?.code, "INVALID_ARGUMENT");
    const ok = await ia(["page", "wait", "--for", "request", "--value", "/API\\/DATA$/i", "--since-index", "0", "--timeout", "5"]);
    assert.equal(ok.exitCode, 0, ok.stdout);
    assert.match(ok.json.data.url, /\/api\/data$/);
    const substring = await ia(["page", "wait", "--for", "request", "--value", "/api/ids", "--since-index", "0", "--timeout", "2"]);
    assert.equal(substring.json.error?.code, "TIMEOUT", "treated as the substring /api/ids, which no request has");
  });

  it("5. a per-action --dialog override still applies to a confirm raised by a timer after the click returned", async () => {
    await go(ia, "/late");
    const btn = refFor(await snap(ia), /button "Late confirm"/);
    const click = await ia(["element", "click", "--ref", btn, "--dialog", "accept"]);
    assert.equal(click.exitCode, 0, click.stderr);
    await waitText(ia, "late-yes");
    const diag = await ia(["diag", "dialogs", "--limit", "5"]);
    const entry = diag.json.data.entries.find((e: any) => e.message === "Later?");
    assert.equal(entry.action, "accept");
    assert.equal(entry.op, "click", "attributed to the op whose override applied");
    await go(ia, "/late");
    await ia(["element", "click", "--ref", refFor(await snap(ia), /button "Late confirm"/)]);
    await waitText(ia, "late-no");
    const plain = (await ia(["diag", "dialogs", "--limit", "1"])).json.data.entries[0];
    assert.equal(plain.action, "dismiss");
    assert.equal("op" in plain, false, "no override, no attribution");
  });

  it("8. text-gone / ref-hidden say when the text or ref was never there; a vanished --within counts as gone", async () => {
    await go(rd, "/waits");
    const gone = await rd(["page", "wait", "--for", "text-gone", "--value", "never on this page zzz", "--timeout", "3"]);
    assert.equal(gone.exitCode, 0, gone.stdout);
    assert.equal(gone.json.data.wasPresent, false);
    assert.match(gone.json.summary, /not present/);
    const hidden = await rd(["page", "wait", "--for", "ref-hidden", "--value", "e9999", "--timeout", "3"]);
    assert.equal(hidden.json.data.wasPresent, false);
    const within = await rd(["page", "wait", "--for", "text-gone", "--value", "x", "--within", "e9999", "--timeout", "3"]);
    assert.equal(within.exitCode, 0, within.stdout);
  });

  it("9. suggested_fix drops flags the rules forbid for the combination", async () => {
    const r = await rd(["page", "wait", "--for", "text", "--method", "GET"]);
    assert.equal(r.exitCode, 2);
    assert.equal(r.json.error.code, "MISSING_REQUIRED_FLAG");
    assert.doesNotMatch(r.json.suggested_fix.command, /--method/);
    assert.match(r.json.suggested_fix.command, /--value/);
  });

  it("12. /url: lines of snapshot and find lose their query strings", async () => {
    await go(rd, "/find");
    const s = await snap(rd);
    assert.match(s, /- \/url: \/about\n/);
    assert.doesNotMatch(s, /utm=1|\?i=\d/);
    const found = await rd(["page", "find", "--text", "/url:", "--limit", "5"]);
    assert.doesNotMatch(found.stdout, /utm=1|\?i=\d/);
    assert.match(found.json.data.matches[0].text, /^- \/url: \/about$/);
  });

  describe("6+7. upload deny-list (resolveUploadFiles)", () => {
    let scratch = "";
    let home = "";
    let savedHome: string | undefined;
    before(async () => {
      scratch = await mkdtemp(join(tmpdir(), "hound-rf-"));
      home = join(scratch, "home");
      await mkdir(home, { recursive: true });
      savedHome = process.env.HOME;
      process.env.HOME = home;
    });
    after(async () => {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      await rm(scratch, { recursive: true, force: true });
    });
    const blocked = async (path: string, why: string) => {
      await assert.rejects(resolveUploadFiles([path]), (e: any) => e.code === "ACTION_BLOCKED", why);
    };

    it("refuses credential files by name, wherever they are", async () => {
      const names = [
        ".npmrc", ".pypirc", ".git-credentials", ".vault-token", ".envrc", "prod.env", ".env.local", "vault.kdbx", "service-account-prod.json", "credentials.json",
        ".bash_history", ".zsh_history", "fish_history", ".python_history", ".node_repl_history", ".psql_history", "debug-trace.zip", "trace.zip", "session-trace.zip", "capture.har", "id_ed25519",
      ];
      for (const n of names) {
        const f = join(scratch, n);
        await writeFile(f, "x");
        await blocked(f, n);
      }
      const fine = join(scratch, "report.txt");
      await writeFile(fine, "ok");
      assert.deepEqual((await resolveUploadFiles([fine])).map((f) => f.name), ["report.txt"]);
    });

    it("refuses everything under credential, cloud and browser-profile directories of the home dir, and /proc", async () => {
      for (const d of [".docker", ".kube", ".azure", ".terraform.d", ".password-store", ".mozilla", ".config/gh", ".config/google-chrome", ".config/chromium", ".config/BraveSoftware", ".local/share/keyrings", ".ssh", ".aws"]) {
        const dir = join(home, d);
        await mkdir(dir, { recursive: true });
        const f = join(dir, "data.txt");
        await writeFile(f, "x");
        await blocked(f, d);
      }
      await blocked("/proc/self/environ", "/proc");
    });

    it("refuses a hard-linked file", async () => {
      const a = join(scratch, "orig.txt");
      const b = join(scratch, "alias.txt");
      await writeFile(a, "x");
      await link(a, b);
      await assert.rejects(resolveUploadFiles([b]), (e: any) => e.code === "INVALID_ARGUMENT" && /hard-linked/.test(e.message));
    });
  });
});
