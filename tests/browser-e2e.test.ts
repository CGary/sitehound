/** E2E gaps found on a real ERP: dialogs, element upload, page wait (text-gone, ref-hidden, within, request), click options. */
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { makeEnv, refFor, startFixture, type Env, type Fixture } from "./helpers/hound.ts";

describe("browser e2e: dialogs, upload, waits, click options", () => {
  let env: Env;
  let fx: Fixture;
  let scratch = "";
  const IA = "e2e-ia"; // interact, dialogs dismissed by default
  const ACC = "e2e-acc"; // interact, dialogs accepted by default
  const RD = "e2e-rd"; // read
  const on = (name: string) => (args: string[], opts?: { input?: string }) => env.hound(args.concat("--session-name", name), opts);
  const ia = on(IA);
  const acc = on(ACC);
  const rd = on(RD);

  before(async () => {
    env = await makeEnv();
    fx = await startFixture();
    scratch = await mkdtemp(join(tmpdir(), "hound-e2e-"));
    const opened = await Promise.all([env.open(IA, ["--actions", "interact"]), env.open(ACC, ["--actions", "interact", "--dialog", "accept"]), env.open(RD)]);
    for (const o of opened) assert.equal(o.exitCode, 0, o.stderr);
  });
  after(async () => {
    await env.cleanup();
    await fx.close();
    await rm(scratch, { recursive: true, force: true });
  });

  /** Opens `path`, returns the page's refs by regex. */
  async function refs(run: typeof ia, path: string, wanted: Record<string, RegExp>): Promise<Record<string, string>> {
    assert.equal((await run(["page", "navigate", "--url", fx.url(path)])).exitCode, 0);
    const snap = await run(["page", "snapshot"]);
    return Object.fromEntries(Object.entries(wanted).map(([k, re]) => [k, refFor(snap.json.data.snapshot, re)]));
  }
  /** The text of the `status`/`log` element of the current page. */
  async function readout(run: typeof ia, role: "status" | "log"): Promise<string> {
    const snap = (await run(["page", "snapshot"])).json.data.snapshot as string;
    return snap.split("\n").find((l) => new RegExp(`- ${role}\\b`).test(l)) ?? "";
  }
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  describe("dialogs", () => {
    let r: Record<string, string> = {};
    const DIALOG_PAGE = { del: /button "Delete record"/, ask: /button "Ask name"/, say: /button "Say saved"/, later: /button "Alert later"/, popup: /button "Open popup"/, field: /textbox "Confirm field"/ };

    it("default dismiss: a confirm never hangs and is reported in data.dialogs", async () => {
      r = await refs(ia, "/dialogs", DIALOG_PAGE);
      const click = await ia(["element", "click", "--ref", r.del!, "--timeout", "20"]);
      assert.equal(click.exitCode, 0, click.stderr);
      assert.deepEqual(
        click.json.data.dialogs.map((d: any) => ({ type: d.type, message: d.message, action: d.action })),
        [{ type: "confirm", message: "¿Seguro que desea eliminar?", action: "dismiss" }],
      );
      assert.match(click.json.summary, /1 dialog\(s\) handled \(confirm dismiss\)/);
      assert.match(await readout(ia, "status"), /kept/);
    });

    it("--dialog accept on one action confirms it (page reflects deleted); a click without dialogs has no data.dialogs", async () => {
      const click = await ia(["element", "click", "--ref", r.del!, "--dialog", "accept"]);
      assert.equal(click.exitCode, 0, click.stderr);
      assert.equal(click.json.data.dialogs[0].action, "accept");
      assert.match(await readout(ia, "status"), /deleted/);
      const h = await refs(ia, "/", { link: /link "About page"/ });
      const plain = await ia(["element", "click", "--ref", h.link!]);
      assert.equal("dialogs" in plain.json.data, false);
      r = await refs(ia, "/dialogs", DIALOG_PAGE);
    });

    it("session default accept (browser open --dialog accept); a per-action dismiss overrides it", async () => {
      const a = await refs(acc, "/dialogs", DIALOG_PAGE);
      const status = await acc(["browser", "status"]);
      assert.equal(status.json.data.dialog, "accept");
      const click = await acc(["element", "click", "--ref", a.del!]);
      assert.equal(click.json.data.dialogs[0].action, "accept");
      assert.match(await readout(acc, "status"), /deleted/);
      const dismissed = await acc(["element", "click", "--ref", a.del!, "--dialog", "dismiss"]);
      assert.equal(dismissed.json.data.dialogs[0].action, "dismiss");
      assert.match(await readout(acc, "status"), /kept/);
    });

    it("prompt: --dialog-text answers it and is never echoed; no text uses the default value; dismiss gives null", async () => {
      const text = "Ana Pérez-Marker";
      const click = await ia(["element", "click", "--ref", r.ask!, "--dialog", "accept", "--dialog-text", text]);
      assert.equal(click.exitCode, 0, click.stderr);
      assert.equal(click.json.data.dialogs[0].type, "prompt");
      assert.doesNotMatch(click.stdout + click.stderr, /Marker/);
      assert.match(await readout(ia, "status"), /name:Ana Pérez-Marker/);
      await ia(["element", "click", "--ref", r.ask!, "--dialog", "accept"]);
      assert.match(await readout(ia, "status"), /name:anon/);
      await ia(["element", "click", "--ref", r.ask!]);
      assert.match(await readout(ia, "status"), /name:null/);
      const diag = await ia(["diag", "dialogs"]);
      assert.doesNotMatch(diag.stdout, /Marker/, "the answer is never recorded");
    });

    it("an alert raised during an op is reported in that op's data.dialogs; press Enter honours --dialog accept", async () => {
      const say = await ia(["element", "click", "--ref", r.say!]);
      assert.deepEqual(say.json.data.dialogs.map((d: any) => [d.type, d.message, d.action]), [["alert", "Saved ok", "dismiss"]]);
      assert.match(await readout(ia, "status"), /alerted/);
      assert.equal(typeof say.json.data.dialogs[0].time, "string");
      const press = await ia(["element", "press", "--ref", r.field!, "--key", "Enter", "--dialog", "accept"]);
      assert.equal(press.exitCode, 0, press.stderr);
      assert.equal(press.json.data.dialogs[0].message, "Submit it?");
      assert.match(await readout(ia, "status"), /submitted/);
    });

    it("a dialog outside any op, and one in a popup tab, are handled with the session default (diag dialogs)", async () => {
      assert.equal((await ia(["element", "click", "--ref", r.later!])).exitCode, 0);
      assert.equal((await ia(["page", "wait", "--for", "text", "--value", "late done", "--timeout", "10"])).exitCode, 0, "the page was not left blocked by the late alert");
      assert.equal((await ia(["element", "click", "--ref", r.popup!])).exitCode, 0);
      let titles = "";
      for (let i = 0; i < 40 && !titles.includes("popup done"); i++) {
        await sleep(150);
        titles = JSON.stringify((await ia(["page", "tabs", "--action", "list"])).json.data.tabs);
      }
      assert.match(titles, /popup done/, "the popup's alert did not freeze the tab");
      const diag = await ia(["diag", "dialogs", "--limit", "500"]);
      const messages = diag.json.data.entries.map((e: any) => e.message);
      assert.ok(messages.includes("late notice") && messages.includes("popup says hi"));
      assert.ok(diag.json.data.entries.filter((e: any) => e.message === "late notice").every((e: any) => e.action === "dismiss"));
      assert.equal(diag.json.data.total, diag.json.data.entries.length + diag.json.data.truncated);
      const one = await ia(["diag", "dialogs", "--limit", "1"]);
      assert.equal(one.json.data.entries.length, 1);
      assert.ok(one.json.data.truncated > 0);
      assert.equal(one.json.data.entries[0].message, "popup says hi", "newest last");
    });

    it("accepting needs --actions interact: a rule on browser open, ACTION_BLOCKED for a per-action override on a read session", async () => {
      const open = await env.hound(["browser", "open", "--session-name", "e2e-bad", "--dialog", "accept"]);
      assert.equal(open.exitCode, 2);
      assert.equal(open.json.error.field, "actions");
      assert.match(open.json.error.message, /interact/);
      const schema = JSON.parse((await env.raw(["browser", "open", "--schema"])).stdout);
      assert.deepEqual(schema.input.properties.dialog.enum, ["accept", "dismiss"]);
      assert.equal(schema.input.properties.dialog.default, "dismiss");
      assert.deepEqual(schema.input.conditional, [{ when: { dialog: "accept" }, restrict: { actions: ["interact"] } }]);

      const link = await refs(rd, "/", { about: /link "About page"/ });
      const blocked = await rd(["element", "click", "--ref", link.about!, "--dialog", "accept"]);
      assert.equal(blocked.exitCode, 1);
      assert.equal(blocked.json.error.code, "ACTION_BLOCKED");
      assert.match(blocked.json.error.message, /interact/);
      const dismiss = await rd(["element", "click", "--ref", link.about!, "--dialog", "dismiss"]);
      assert.equal(dismiss.exitCode, 0, "dismissing is always allowed");
    });

    it("--dialog-text needs an accepting action, and the flags are declared in --schema of every action that can open a dialog", async () => {
      const bad = await ia(["element", "click", "--ref", "e1", "--dialog", "dismiss", "--dialog-text", "x"]);
      assert.equal(bad.exitCode, 2);
      assert.equal(bad.json.error.field, "dialog-text");
      assert.doesNotMatch(bad.json.suggested_fix?.command ?? "", /dialog-text x/);
      for (const cmd of [["element", "click"], ["element", "press"], ["element", "select"], ["element", "type"], ["element", "download"], ["element", "upload"], ["page", "navigate"], ["page", "back"], ["page", "forward"], ["page", "reload"]]) {
        const s = JSON.parse((await env.raw([...cmd, "--schema"])).stdout);
        assert.deepEqual(s.input.properties.dialog.enum, ["accept", "dismiss"], cmd.join(" "));
        assert.equal(s.input.properties["dialog-text"].sensitive, true, cmd.join(" "));
        assert.equal(s.input.properties["dialog-text"].maxLength, 1000, cmd.join(" "));
      }
    });
  });

  describe("element upload", () => {
    let r: Record<string, string> = {};
    let a = "";
    let b = "";
    before(() => {
      a = join(scratch, "a.txt");
      b = join(scratch, "b.txt");
      writeFileSync(a, "hello");
      writeFileSync(b, "world!!!");
    });

    it("sets files on an <input type=file> (single and multiple); returns names and sizes only", async () => {
      r = await refs(ia, "/upload", { one: /button "Photo"/, many: /button "Docs"/, pick: /button "Choose file"/, nope: /button "Not a picker"/ });
      const one = await ia(["element", "upload", "--ref", r.one!, "--file", a]);
      assert.equal(one.exitCode, 0, one.stderr);
      assert.deepEqual(one.json.data, { ref: r.one, files: [{ name: "a.txt", bytes: 5 }] });
      assert.doesNotMatch(one.stdout, new RegExp(scratch), "no full paths in the output");
      assert.match(await readout(ia, "status"), /one:a\.txt=5/);

      const many = await ia(["element", "upload", "--ref", r.many!, "--file", a, "--file", b]);
      assert.equal(many.exitCode, 0, many.stderr);
      assert.deepEqual(many.json.data.files, [{ name: "a.txt", bytes: 5 }, { name: "b.txt", bytes: 8 }]);
      assert.match(await readout(ia, "status"), /many:a\.txt=5,b\.txt=8/);

      const tooMany = await ia(["element", "upload", "--ref", r.one!, "--file", a, "--file", b]);
      assert.equal(tooMany.json.error.code, "INVALID_ARGUMENT");
      assert.match(tooMany.json.error.message, /single file/);
    });

    it("a button that opens the file chooser is clicked and answered; a non-picker times out without holding the queue", async () => {
      const viaChooser = await ia(["element", "upload", "--ref", r.pick!, "--file", b]);
      assert.equal(viaChooser.exitCode, 0, viaChooser.stderr);
      assert.match(await readout(ia, "status"), /hid:b\.txt=8/);
      const nope = await ia(["element", "upload", "--ref", r.nope!, "--file", a, "--timeout", "3"]);
      assert.equal(nope.json.error.code, "TIMEOUT");
      assert.equal(nope.json.retryable, false);
      assert.equal((await ia(["page", "snapshot"])).exitCode, 0, "the session still answers");
    });

    it("refuses sitehound data, secrets and key material with ACTION_BLOCKED, before touching the page", async () => {
      const hound = join(scratch, "proj", ".hound", "profiles");
      mkdirSync(hound, { recursive: true });
      const files: Record<string, string> = {
        envFile: join(scratch, ".env"),
        envLocal: join(scratch, ".env.production"),
        har: join(scratch, "session.HAR"),
        trace: join(scratch, "trace-abc.zip"),
        rsa: join(scratch, "id_rsa"),
        ed: join(scratch, "id_ed25519.pub"),
        pem: join(scratch, "cert.pem"),
        key: join(scratch, "server.key"),
        profile: join(hound, "work.json"),
        homeData: join(env.home, "note.txt"),
      };
      for (const f of Object.values(files)) writeFileSync(f, "secret-content");
      symlinkSync(files.envFile!, join(scratch, "innocent.txt"));
      const home = homedir();
      const absent = [join(home, ".ssh", "config"), join(home, ".aws", "credentials"), join(home, ".gnupg", "pubring.kbx"), join(home, ".config", "gcloud", "credentials.db")];
      for (const f of [...Object.values(files), join(scratch, "innocent.txt"), ...absent]) {
        const out = await ia(["element", "upload", "--ref", r.one!, "--file", f]);
        assert.equal(out.exitCode, 1, f);
        assert.equal(out.json.error.code, "ACTION_BLOCKED", f);
        assert.equal(out.json.error.field, "file");
        assert.equal(out.json.retryable, false);
        assert.doesNotMatch(out.stdout, /secret-content/);
        assert.doesNotMatch(out.json.error.message, new RegExp(`${scratch}|${env.home}`), "the message names the file, not its path");
      }
      assert.match(await readout(ia, "status"), /hid:b\.txt=8/, "nothing was attached by the refused calls");
      // One refused file in a list refuses the whole call.
      const mixed = await ia(["element", "upload", "--ref", r.many!, "--file", a, "--file", files.envFile!]);
      assert.equal(mixed.json.error.code, "ACTION_BLOCKED");
    });

    it("size cap (declared), file count, missing files, directories, and the read level", async () => {
      const schema = JSON.parse((await env.raw(["element", "upload", "--schema"])).stdout);
      assert.equal(schema.input.properties.file.type, "array");
      assert.deepEqual(schema.input.required.sort(), ["file", "ref", "session-name"]);
      assert.match(schema.description, /50 MiB/);
      assert.match(schema.description, /20 regular files/);
      const big1 = join(scratch, "big1.bin");
      const big2 = join(scratch, "big2.bin");
      writeFileSync(big1, "");
      writeFileSync(big2, "");
      truncateSync(big1, 26 * 1024 * 1024);
      truncateSync(big2, 26 * 1024 * 1024);
      const one = await ia(["element", "upload", "--ref", r.one!, "--file", big1]);
      assert.equal(one.exitCode, 0, "26 MiB is under the cap");
      const over = await ia(["element", "upload", "--ref", r.many!, "--file", big1, "--file", big2]);
      assert.equal(over.json.error.code, "INVALID_ARGUMENT");
      assert.match(over.json.error.message, /50 MiB/);
      const missing = await ia(["element", "upload", "--ref", r.one!, "--file", join(scratch, "nope.txt")]);
      assert.equal(missing.json.error.code, "FILE_NOT_FOUND");
      const dir = await ia(["element", "upload", "--ref", r.one!, "--file", scratch]);
      assert.equal(dir.json.error.code, "INVALID_ARGUMENT");
      const noFile = await ia(["element", "upload", "--ref", r.one!]);
      assert.equal(noFile.exitCode, 2);
      assert.equal(noFile.json.error.code, "MISSING_REQUIRED_FLAG");
      const many = Array.from({ length: 21 }, () => ["--file", a]).flat();
      const count = await ia(["element", "upload", "--ref", r.many!, ...many]);
      assert.equal(count.json.error.code, "INVALID_ARGUMENT");
      const rdUpload = await rd(["element", "upload", "--ref", "e1", "--file", a]);
      assert.equal(rdUpload.json.error.code, "ACTION_BLOCKED");
      assert.equal(rdUpload.json.error.field, "actions");
    });
  });

  describe("page wait", () => {
    it("text-gone and ref-hidden wait for a spinner to disappear", async () => {
      let r = await refs(ia, "/waits", { load: /button "Load data"/, spinner: /progressbar "Spinner"/ });
      assert.equal((await ia(["element", "click", "--ref", r.load!])).exitCode, 0);
      const gone = await ia(["page", "wait", "--for", "text-gone", "--value", "Cargando", "--timeout", "10"]);
      assert.equal(gone.exitCode, 0, gone.stderr);
      assert.equal(gone.json.data.for, "text-gone");
      assert.doesNotMatch(await readout(ia, "status"), /Cargando/);

      r = await refs(ia, "/waits", { load: /button "Load data"/, spinner: /progressbar "Spinner"/ });
      const early = await ia(["page", "wait", "--for", "ref-hidden", "--value", r.spinner!, "--timeout", "1"]);
      assert.equal(early.json.error.code, "TIMEOUT", "still visible");
      assert.equal((await ia(["element", "click", "--ref", r.load!])).exitCode, 0);
      const hidden = await ia(["page", "wait", "--for", "ref-hidden", "--value", r.spinner!, "--timeout", "10"]);
      assert.equal(hidden.exitCode, 0, hidden.stderr);
      const absent = await ia(["page", "wait", "--for", "ref-hidden", "--value", "e9999", "--timeout", "3"]);
      assert.equal(absent.exitCode, 0, "a ref that is not on the page counts as hidden");
      const badRef = await ia(["page", "wait", "--for", "ref-hidden", "--value", "not a ref", "--timeout", "3"]);
      assert.equal(badRef.json.error.code, "INVALID_ARGUMENT");
    });

    it("--within scopes text and text-gone to one element", async () => {
      const r = await refs(ia, "/waits", { load: /button "Load data"/, panel: /region "Panel"/ });
      const anywhere = await ia(["page", "wait", "--for", "text", "--value", "Listo", "--timeout", "3"]);
      assert.equal(anywhere.exitCode, 0, "the footer already says Listo");
      const scoped = await ia(["page", "wait", "--for", "text", "--value", "Listo", "--within", r.panel!, "--timeout", "1"]);
      assert.equal(scoped.json.error.code, "TIMEOUT", "the panel is still empty");
      const goneAnywhere = await ia(["page", "wait", "--for", "text-gone", "--value", "Listo", "--timeout", "1"]);
      assert.equal(goneAnywhere.json.error.code, "TIMEOUT");
      const goneScoped = await ia(["page", "wait", "--for", "text-gone", "--value", "Listo", "--within", r.panel!, "--timeout", "3"]);
      assert.equal(goneScoped.exitCode, 0);
      assert.equal((await ia(["element", "click", "--ref", r.load!])).exitCode, 0);
      const filled = await ia(["page", "wait", "--for", "text", "--value", "Listo (panel)", "--within", r.panel!, "--timeout", "10"]);
      assert.equal(filled.exitCode, 0, filled.stderr);
      const ghost = await ia(["page", "wait", "--for", "text", "--value", "x", "--within", "e9999", "--timeout", "3"]);
      assert.equal(ghost.json.error.code, "REF_NOT_FOUND");
      assert.equal(ghost.json.error.field, "within");
    });

    it("--for request matches a request that finished after the last state-changing action started (a fast one is not missed)", async () => {
      const r = await refs(ia, "/reqs", { ping: /button "Ping"/, post: /button "Post it"/, later: /button "Ping later"/ });
      assert.equal((await ia(["element", "click", "--ref", r.ping!])).exitCode, 0);
      await sleep(400); // the request is long finished by the time the wait starts
      const hit = await ia(["page", "wait", "--for", "request", "--value", "/api/data", "--timeout", "5"]);
      assert.equal(hit.exitCode, 0, hit.stderr);
      const d = hit.json.data;
      assert.deepEqual(Object.keys(d).sort(), ["for", "index", "method", "sinceIndex", "status", "url", "waitedMs"]);
      assert.equal(d.method, "GET");
      assert.equal(d.status, 200);
      assert.equal(d.url, fx.url("/api/data"), "no query string");
      assert.ok(d.index > d.sinceIndex);
      assert.match(hit.json.next_actions[0].command, new RegExp(`^hound diag request --session-name ${IA} --index ${d.index} --part response-body --json$`));
      const network = await ia(["diag", "network", "--state", "all", "--limit", "50"]);
      assert.ok(network.json.data.entries.some((e: any) => e.index === d.index && e.url === d.url));

      const noPost = await ia(["page", "wait", "--for", "request", "--value", "/api/form", "--method", "POST", "--timeout", "1"]);
      assert.equal(noPost.json.error.code, "TIMEOUT");
      assert.equal((await ia(["element", "click", "--ref", r.post!])).exitCode, 0);
      const post = await ia(["page", "wait", "--for", "request", "--value", "/api/form", "--method", "POST", "--timeout", "5"]);
      assert.equal(post.exitCode, 0, post.stderr);
      assert.equal(post.json.data.method, "POST");
      assert.ok(post.json.data.index > d.index);
      const wrongMethod = await ia(["page", "wait", "--for", "request", "--value", "/api/form", "--method", "GET", "--timeout", "1"]);
      assert.equal(wrongMethod.json.error.code, "TIMEOUT");

      // The mark moved with the last action: the earlier /api/data request is not matched any more, unless --since-index says so.
      const moved = await ia(["page", "wait", "--for", "request", "--value", "/api/data", "--timeout", "1"]);
      assert.equal(moved.json.error.code, "TIMEOUT");
      const since = await ia(["page", "wait", "--for", "request", "--value", "/api/data", "--since-index", "0", "--timeout", "5"]);
      assert.equal(since.exitCode, 0, since.stderr);
      assert.equal(since.json.data.index, d.index, "the first match after the given index");
      assert.equal(since.json.data.sinceIndex, 0);
      const future = await ia(["page", "wait", "--for", "request", "--value", "/api/data", "--since-index", String(post.json.data.index), "--timeout", "1"]);
      assert.equal(future.json.error.code, "TIMEOUT");
    });

    it("a request that starts after the click is waited for; regex values work", async () => {
      const r = await refs(ia, "/reqs", { later: /button "Ping later"/ });
      assert.equal((await ia(["element", "click", "--ref", r.later!])).exitCode, 0);
      const t0 = Date.now();
      const hit = await ia(["page", "wait", "--for", "request", "--value", "/\\/API\\/da.a$/i", "--method", "GET", "--timeout", "10"]);
      assert.equal(hit.exitCode, 0, hit.stderr);
      assert.ok(hit.json.data.waitedMs >= 0 && Date.now() - t0 < 10_000);
      assert.equal(hit.json.data.url, fx.url("/api/data"));
      const bad = await ia(["page", "wait", "--for", "request", "--value", "/(/", "--timeout", "3"]);
      assert.equal(bad.json.error.code, "INVALID_ARGUMENT");
      assert.equal(bad.json.error.field, "value");
    });

    it("the enum, the options and their rules are declared and checked before anything runs", async () => {
      const schema = JSON.parse((await env.raw(["page", "wait", "--schema"])).stdout);
      assert.deepEqual(schema.input.properties.for.enum, ["text", "text-gone", "url", "ref", "ref-hidden", "request", "load"]);
      assert.deepEqual(schema.input.properties.method.enum, ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
      assert.equal(schema.input.properties["since-index"].minimum, 0);
      assert.equal(schema.input.properties.within.pattern, "^(?:[a-z]+[0-9]+)+$");
      assert.ok(schema.input.conditional.length >= 4);
      const noValue = await ia(["page", "wait", "--for", "request"]);
      assert.equal(noValue.exitCode, 2);
      assert.equal(noValue.json.error.code, "MISSING_REQUIRED_FLAG");
      const within = await ia(["page", "wait", "--for", "url", "--value", "x", "--within", "e1"]);
      assert.equal(within.exitCode, 2);
      assert.equal(within.json.error.field, "within");
      const method = await ia(["page", "wait", "--for", "text", "--value", "x", "--method", "GET"]);
      assert.equal(method.exitCode, 2);
      assert.equal(method.json.error.field, "method");
      const since = await ia(["page", "wait", "--for", "ref", "--value", "e1", "--since-index", "3"]);
      assert.equal(since.exitCode, 2);
      const enumErr = await ia(["page", "wait", "--for", "text-gon", "--value", "x"]);
      assert.equal(enumErr.json.error.code, "INVALID_ENUM");
      assert.match(enumErr.json.suggested_fix.command, /--for text-gone/);
    });
  });

  describe("element click options", () => {
    let r: Record<string, string> = {};
    it("--count 2/3 are double and triple clicks the page observes", async () => {
      r = await refs(ia, "/clicks", { t: /button "Target"/, link: /link "Plain link"/ });
      const dbl = await ia(["element", "click", "--ref", r.t!, "--count", "2"]);
      assert.equal(dbl.exitCode, 0, dbl.stderr);
      assert.equal(dbl.json.data.count, 2);
      assert.match(await readout(ia, "log"), /click1;click2;dblclick;/);
      r = await refs(ia, "/clicks", { t: /button "Target"/ });
      const triple = await ia(["element", "click", "--ref", r.t!, "--count", "3"]);
      assert.equal(triple.exitCode, 0, triple.stderr);
      assert.match(await readout(ia, "log"), /click1;click2;dblclick;click3;/);
    });

    it("--button right fires contextmenu, middle fires auxclick; --modifiers are held", async () => {
      r = await refs(ia, "/clicks", { t: /button "Target"/ });
      const right = await ia(["element", "click", "--ref", r.t!, "--button", "right"]);
      assert.equal(right.exitCode, 0, right.stderr);
      assert.equal(right.json.data.button, "right");
      assert.match(await readout(ia, "log"), /contextmenu;/);
      assert.equal((await ia(["element", "click", "--ref", r.t!, "--button", "middle"])).exitCode, 0);
      assert.match(await readout(ia, "log"), /middle;/);
      const mod = await ia(["element", "click", "--ref", r.t!, "--modifiers", "Shift,Control"]);
      assert.equal(mod.exitCode, 0, mod.stderr);
      assert.deepEqual(mod.json.data.modifiers, ["Shift", "Control"]);
      assert.match(await readout(ia, "log"), /click1\+shift\+ctrl;/);
      const plain = await ia(["element", "click", "--ref", r.t!]);
      assert.deepEqual(Object.keys(plain.json.data).sort(), ["ref", "tabs", "title", "url"], "a plain click keeps its output shape");
    });

    it("read level: a plain single left click on a link passes; any option needs interact", async () => {
      const l = await refs(rd, "/clicks", { link: /link "Plain link"/ });
      for (const opts of [["--count", "2"], ["--button", "right"], ["--modifiers", "Shift"]]) {
        const out = await rd(["element", "click", "--ref", l.link!, ...opts]);
        assert.equal(out.exitCode, 1, opts.join(" "));
        assert.equal(out.json.error.code, "ACTION_BLOCKED", opts.join(" "));
        assert.match(out.json.error.message, /--count, --button and --modifiers need interact/);
      }
      const plain = await rd(["element", "click", "--ref", l.link!]);
      assert.equal(plain.exitCode, 0, plain.stderr);
      assert.equal((await readout(rd, "log")).match(/link clicked/g)?.length, 1, "only the plain click reached the page");
    });

    it("the options are declared in --schema and validated before anything runs", async () => {
      const schema = JSON.parse((await env.raw(["element", "click", "--schema"])).stdout);
      assert.equal(schema.input.properties.count.minimum, 1);
      assert.equal(schema.input.properties.count.maximum, 3);
      assert.deepEqual(schema.input.properties.button.enum, ["left", "right", "middle"]);
      assert.match(schema.input.properties.modifiers.pattern, /ControlOrMeta/);
      assert.match(schema.input.properties.modifiers.description, /Alt, Control, ControlOrMeta, Meta, Shift/);
      const count = await ia(["element", "click", "--ref", "e1", "--count", "4"]);
      assert.equal(count.exitCode, 2);
      assert.equal(count.json.error.field, "count");
      assert.match(count.json.suggested_fix.command, /--count 3/);
      const button = await ia(["element", "click", "--ref", "e1", "--button", "righ"]);
      assert.equal(button.json.error.code, "INVALID_ENUM");
      assert.match(button.json.suggested_fix.command, /--button right/);
      for (const bad of ["Bogus", "Shift,", "shift", "Shift,,Alt"]) {
        const out = await ia(["element", "click", "--ref", "e1", `--modifiers=${bad}`]);
        assert.equal(out.exitCode, 2, bad);
        assert.equal(out.json.error.field, "modifiers", bad);
      }
    });
  });

  it("every new command and flag shows in help and next_actions are runnable", async () => {
    const element = await env.raw(["element", "--help"]);
    assert.match(element.stdout, /element upload/);
    const diag = await env.raw(["diag", "--help"]);
    assert.match(diag.stdout, /diag dialogs/);
    const typo = await env.hound(["element", "uplaod"]);
    assert.equal(typo.json.error.code, "UNKNOWN_COMMAND");
    assert.match(typo.json.error.message, /Did you mean "element upload"/);
    const ok = await ia(["diag", "dialogs"]);
    for (const a of ok.json.next_actions) assert.match(a.command, /^hound .* --json$/);
  });
});
