/** Viewport, media emulation, drag, page find and element read. */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { makeEnv, refFor, startFixture, type Env, type Fixture } from "./helpers/hound.ts";

describe("browser extras 2: viewport, emulate, drag, find, read", () => {
  let env: Env;
  let fx: Fixture;
  const IA = "x2-ia"; // interact
  const RD = "x2-rd"; // read, opened as a 375x812 mobile phone at 2x
  const on = (name: string) => (args: string[], opts?: { input?: string }) => env.hound(args.concat("--session-name", name), opts);
  const ia = on(IA);
  const rd = on(RD);

  before(async () => {
    env = await makeEnv();
    fx = await startFixture();
    const opened = await Promise.all([env.open(IA, ["--actions", "interact"]), env.open(RD, ["--viewport", "375x812", "--device-scale-factor", "2", "--mobile"])]);
    for (const o of opened) assert.equal(o.exitCode, 0, o.stderr);
  });
  after(async () => {
    await env.cleanup();
    await fx.close();
  });

  async function go(run: typeof ia, path: string): Promise<void> {
    assert.equal((await run(["page", "navigate", "--url", fx.url(path)])).exitCode, 0);
  }
  async function snap(run: typeof ia): Promise<string> {
    return (await run(["page", "snapshot", "--limit-chars", "200000"])).json.data.snapshot as string;
  }
  /** The text of the status/log element of the current page. */
  async function readout(run: typeof ia, role: "status" | "log"): Promise<string> {
    return (await snap(run)).split("\n").find((l) => new RegExp(`- ${role}\\b`).test(l)) ?? "";
  }
  async function waitText(run: typeof ia, text: string): Promise<void> {
    const w = await run(["page", "wait", "--for", "text", "--value", text, "--timeout", "10"]);
    assert.equal(w.exitCode, 0, `${text}: ${w.stdout}`);
  }

  describe("viewport", () => {
    it("browser open --viewport/--device-scale-factor/--mobile is reflected by the page and by status", async () => {
      await go(rd, "/media");
      await waitText(rd, "w:375");
      const line = await readout(rd, "status");
      assert.match(line, /w:375 /);
      assert.match(line, /touch:true/);
      assert.match(line, /dpr:2/);
      const status = await rd(["browser", "status"]);
      assert.deepEqual(status.json.data.viewport, { width: 375, height: 812 });
      assert.equal(status.json.data.deviceScaleFactor, 2);
      assert.equal(status.json.data.mobile, true);
      const plain = await ia(["browser", "status"]);
      assert.deepEqual(plain.json.data.viewport, { width: 1280, height: 720 }, "default viewport is reported too");
      assert.equal("mobile" in plain.json.data, false);
    });

    it("browser open data shows the viewport; bad shapes and out-of-range sizes are INVALID_ARGUMENT (declared in --schema)", async () => {
      const opened = await env.open("x2-vp", ["--viewport", "800x600"]);
      assert.equal(opened.exitCode, 0, opened.stderr);
      assert.deepEqual(opened.json.data.viewport, { width: 800, height: 600 });
      assert.match(opened.json.summary, /viewport 800x600/);
      for (const bad of ["abc", "375", "375x", "99x700", "375x812x2"]) {
        const r = await env.hound(["browser", "open", "--session-name", "x2-bad", "--viewport", bad]);
        assert.equal(r.exitCode, 2, bad);
        assert.equal(r.json.error.code, "INVALID_ARGUMENT", bad);
        assert.equal(r.json.error.field, "viewport", bad);
      }
      for (const big of ["199x700", "8000x700", "700x4400"]) {
        const r = await env.hound(["browser", "open", "--session-name", "x2-bad", "--viewport", big]);
        assert.equal(r.exitCode, 2, big);
        assert.equal(r.json.error.code, "INVALID_ARGUMENT", big);
        assert.match(r.json.error.message, /out of range/);
      }
      const dsf = await env.hound(["browser", "open", "--session-name", "x2-bad", "--device-scale-factor", "5"]);
      assert.equal(dsf.exitCode, 2);
      assert.equal(dsf.json.error.field, "device-scale-factor");
      const schema = JSON.parse((await env.raw(["browser", "open", "--schema"])).stdout);
      assert.match(schema.input.properties.viewport.pattern, /\[0-9\]/);
      assert.equal(schema.input.properties["device-scale-factor"].maximum, 4);
      assert.equal(schema.input.properties.mobile.type, "boolean");
      await env.hound(["browser", "close", "--session-name", "x2-vp"]);
    });

    it("page resize changes the active tab's viewport and returns the new size (read level)", async () => {
      const r = await rd(["page", "resize", "--viewport", "600x500"]);
      assert.equal(r.exitCode, 0, r.stderr);
      assert.deepEqual(r.json.data.viewport, { width: 600, height: 500 });
      await waitText(rd, "w:600");
      assert.deepEqual((await rd(["browser", "status"])).json.data.viewport, { width: 600, height: 500 });
      const bad = await rd(["page", "resize", "--viewport", "100x100"]);
      assert.equal(bad.exitCode, 2);
      assert.equal(bad.json.error.code, "INVALID_ARGUMENT");
      const missing = await rd(["page", "resize"]);
      assert.equal(missing.json.error.code, "MISSING_REQUIRED_FLAG");
      assert.equal((await rd(["page", "resize", "--viewport", "375x812"])).exitCode, 0);
    });
  });

  describe("emulate", () => {
    it("dark + reduced motion, then print, are seen by the page; settings accumulate", async () => {
      await go(rd, "/media");
      const dark = await rd(["page", "emulate", "--color-scheme", "dark", "--reduced-motion", "reduce"]);
      assert.equal(dark.exitCode, 0, dark.stderr);
      assert.deepEqual(dark.json.data, { colorScheme: "dark", media: "default", reducedMotion: "reduce" });
      await waitText(rd, "dark:true");
      assert.match(await readout(rd, "status"), /dark:true print:false reduce:true/);
      const print = await rd(["page", "emulate", "--media", "print"]);
      assert.deepEqual(print.json.data, { colorScheme: "dark", media: "print", reducedMotion: "reduce" });
      await waitText(rd, "print:true");
      assert.match(await readout(rd, "status"), /dark:true print:true reduce:true/);
    });

    it("a tab opened afterwards inherits the settings; --reset clears them for the active tab and for later tabs", async () => {
      const tab = await rd(["page", "tabs", "--action", "new", "--url", fx.url("/media")]);
      assert.equal(tab.exitCode, 0, tab.stderr);
      assert.match(await readout(rd, "status"), /dark:true print:true reduce:true/, "the new tab inherited the emulation");
      const reset = await rd(["page", "emulate", "--reset"]);
      assert.deepEqual(reset.json.data, { colorScheme: "default", media: "default", reducedMotion: "default" });
      await waitText(rd, "dark:false");
      assert.match(await readout(rd, "status"), /dark:false print:false reduce:false/);
      assert.equal((await rd(["page", "tabs", "--action", "new", "--url", fx.url("/media")])).exitCode, 0);
      assert.match(await readout(rd, "status"), /dark:false print:false reduce:false/, "nothing inherited after the reset");
    });

    it("needs at least one flag (declared: any_of in --schema), --reset excludes the others, enums are checked", async () => {
      const none = await rd(["page", "emulate"]);
      assert.equal(none.exitCode, 2);
      assert.equal(none.json.error.code, "MISSING_REQUIRED_FLAG");
      assert.match(none.json.error.message, /at least one/i);
      assert.match(none.json.suggested_fix.command, /^hound page emulate .*--color-scheme/);
      const mix = await rd(["page", "emulate", "--reset", "--media", "print"]);
      assert.equal(mix.exitCode, 2);
      assert.equal(mix.json.error.code, "INVALID_ARGUMENT");
      const badEnum = await rd(["page", "emulate", "--color-scheme", "darkk"]);
      assert.equal(badEnum.json.error.code, "INVALID_ENUM");
      assert.equal(badEnum.json.error.allowed.includes("dark"), true);
      const schema = JSON.parse((await env.raw(["page", "emulate", "--schema"])).stdout);
      assert.deepEqual(schema.input.any_of, [["color-scheme", "media", "reduced-motion", "reset"]]);
      assert.equal(schema.kind, "read");
    });
  });

  describe("drag", () => {
    it("HTML5 drag and drop: the page sees dragstart and drop; the request mark covers the request it started", async () => {
      await go(ia, "/drag");
      const s = await snap(ia);
      const card = refFor(s, /button "Card A"/);
      const zone = refFor(s, /button "Drop zone"/);
      const r = await ia(["element", "drag", "--ref", card, "--to-ref", zone, "--timeout", "20", "--dialog", "accept"]);
      assert.equal(r.exitCode, 0, r.stderr);
      assert.equal(r.json.command, "element.drag");
      assert.equal(r.json.data.ref, card);
      assert.equal(r.json.data.toRef, zone);
      assert.equal(typeof r.json.data.tabs, "number");
      await waitText(ia, "moved");
      assert.match(await readout(ia, "log"), /dragstart;drop:Card A>zone;moved/);
      const wait = await ia(["page", "wait", "--for", "request", "--value", "/api/data", "--timeout", "10"]);
      assert.equal(wait.exitCode, 0, "the drop's request is after the mark set when the drag started");
      const dialogs = await ia(["diag", "dialogs"]);
      assert.ok(dialogs.json.data.entries.some((e: any) => e.message === "Move card?" && e.action === "accept"));
    });

    it("a drag without --dialog dismisses the confirm; pointer-based handlers see down and up", async () => {
      await go(ia, "/drag");
      const s = await snap(ia);
      const r = await ia(["element", "drag", "--ref", refFor(s, /button "Card A"/), "--to-ref", refFor(s, /button "Drop zone"/)]);
      assert.equal(r.exitCode, 0, r.stderr);
      await waitText(ia, "kept");
      const p = await ia(["element", "drag", "--ref", refFor(s, /button "Handle"/), "--to-ref", refFor(s, /button "Slot"/)]);
      assert.equal(p.exitCode, 0, p.stderr);
      assert.match(await readout(ia, "log"), /pointer:handle>slot/);
    });

    it("read level: ACTION_BLOCKED; stale ref: REF_NOT_FOUND; same ref and --dialog-text rules are usage errors", async () => {
      await go(rd, "/drag");
      const s = await snap(rd);
      const blocked = await rd(["element", "drag", "--ref", refFor(s, /button "Card A"/), "--to-ref", refFor(s, /button "Drop zone"/)]);
      assert.equal(blocked.exitCode, 1);
      assert.equal(blocked.json.error.code, "ACTION_BLOCKED");
      assert.match(blocked.json.suggested_fix.command, /--actions interact/);
      assert.doesNotMatch(await readout(rd, "log"), /drop/);
      const stale = await ia(["element", "drag", "--ref", "e9999", "--to-ref", "e9998"]);
      assert.equal(stale.json.error.code, "REF_NOT_FOUND");
      const same = await ia(["element", "drag", "--ref", "e1", "--to-ref", "e1"]);
      assert.equal(same.json.error.code, "INVALID_ARGUMENT");
      const missing = await ia(["element", "drag", "--ref", "e1"]);
      assert.equal(missing.json.error.code, "MISSING_REQUIRED_FLAG");
      assert.equal(missing.json.error.field, "to-ref");
      const text = await ia(["element", "drag", "--ref", "e1", "--to-ref", "e2", "--dialog", "dismiss", "--dialog-text", "x"]);
      assert.equal(text.exitCode, 2);
      const schema = JSON.parse((await env.raw(["element", "drag", "--schema"])).stdout);
      assert.equal(schema.kind, "write");
      assert.deepEqual(schema.input.required.sort(), ["ref", "session-name", "to-ref"]);
    });
  });

  describe("page find", () => {
    it("--text is case-insensitive, returns line numbers and refs; the refs work with element click", async () => {
      await go(rd, "/find");
      const r = await rd(["page", "find", "--text", "ABOUT US"]);
      assert.equal(r.exitCode, 0, r.stderr);
      assert.equal(r.json.command, "page.find");
      const d = r.json.data;
      assert.equal(d.total, 1);
      assert.equal(d.truncated, false);
      assert.equal(d.matches.length, 1);
      assert.equal(typeof d.matches[0].line, "number");
      assert.match(d.matches[0].text, /link "About us"/);
      assert.match(d.matches[0].ref, /^(?:[a-z]+\d+)+$/);
      assert.match(r.json.next_actions[0].command, new RegExp(`element click .*--ref ${d.matches[0].ref}`));
      const click = await rd(["element", "click", "--ref", d.matches[0].ref]);
      assert.equal(click.exitCode, 0, click.stderr);
      assert.match(click.json.data.url, /\/about$/);
    });

    it("--regex (/pattern/flags or bare), --limit truncation with the snapshot file, --context lines", async () => {
      await go(rd, "/find");
      const rx = await rd(["page", "find", "--regex", '/^\\s*- link "item 1\\d"/i', "--limit", "3"]);
      assert.equal(rx.exitCode, 0, rx.stderr);
      assert.equal(rx.json.data.total, 10);
      assert.equal(rx.json.data.matches.length, 3);
      assert.equal(rx.json.data.truncated, true);
      assert.match(rx.json.data.snapshotFile, /snapshot-.*\.yml$/);
      assert.match(rx.json.summary, /3 shown/);
      const bare = await rd(["page", "find", "--regex", 'button "Checkout']);
      assert.equal(bare.json.data.total, 1);
      assert.equal(bare.json.data.snapshotFile, undefined, "no file when nothing was cut");
      const all = await rd(["page", "find", "--text", 'link "item', "--limit", "200"]);
      assert.equal(all.json.data.total, 40);
      assert.equal(all.json.data.matches.length, 40);
      const def = await rd(["page", "find", "--text", 'link "item']);
      assert.equal(def.json.data.matches.length, 30, "default --limit 30");
      assert.equal(def.json.data.truncated, true);
      const ctx = await rd(["page", "find", "--text", "Checkout now", "--context", "1"]);
      const m = ctx.json.data.matches[0];
      assert.equal(m.before.length, 1);
      assert.equal(m.after.length, 1);
      assert.match(m.before[0], /\/url: \/about/, "the line before the button is the link target");
      const noCtx = await rd(["page", "find", "--text", "Checkout now"]);
      assert.equal("before" in noCtx.json.data.matches[0], false);
    });

    it("invalid and catastrophic regexes are INVALID_ARGUMENT; ranges, exactly-one-of and no-match are handled", async () => {
      await go(rd, "/find");
      for (const bad of ["([a", "/abc/x", "/abc/ii", "/(/"]) {
        const r = await rd(["page", "find", "--regex", bad]);
        assert.equal(r.exitCode, 2, bad);
        assert.equal(r.json.error.code, "INVALID_ARGUMENT", bad);
        assert.equal(r.json.error.field, "regex", bad);
      }
      const long = await rd(["page", "find", "--regex", "a".repeat(201)]);
      assert.equal(long.exitCode, 2);
      assert.equal(long.json.error.field, "regex");
      const t0 = Date.now();
      const evil = await rd(["page", "find", "--regex", "(a+)+b"]);
      assert.equal(evil.exitCode, 2);
      assert.equal(evil.json.error.code, "INVALID_ARGUMENT");
      assert.match(evil.json.error.message, /took longer|backtracking/);
      assert.ok(Date.now() - t0 < 20_000, "the scan was cancelled");
      const after = await rd(["page", "find", "--text", "Checkout"]);
      assert.equal(after.exitCode, 0, "the session survives a cancelled scan");
      for (const [flag, value] of [["--limit", "201"], ["--limit", "0"], ["--context", "4"]] as const) {
        const r = await rd(["page", "find", "--text", "x", flag, value]);
        assert.equal(r.exitCode, 2, `${flag} ${value}`);
        assert.equal(r.json.error.field, flag.slice(2));
      }
      const none = await rd(["page", "find"]);
      assert.equal(none.exitCode, 2);
      assert.equal(none.json.error.code, "MISSING_REQUIRED_FLAG");
      const both = await rd(["page", "find", "--text", "a", "--regex", "b"]);
      assert.equal(both.exitCode, 2);
      const empty = await rd(["page", "find", "--text", "zzz-not-on-the-page"]);
      assert.equal(empty.exitCode, 0);
      assert.equal(empty.json.data.total, 0);
      assert.deepEqual(empty.json.data.matches, []);
      assert.match(empty.json.next_actions[0].command, /page snapshot/);
      const schema = JSON.parse((await env.raw(["page", "find", "--schema"])).stdout);
      assert.deepEqual(schema.input.one_of, [["text", "regex"]]);
      assert.equal(schema.input.properties.limit.maximum, 200);
      assert.equal(schema.input.properties.regex.maxLength, 200);
    });
  });

  describe("element read", () => {
    let snapshot = "";
    before(async () => {
      await go(rd, "/reads");
      snapshot = await snap(rd);
    });

    it("returns innerText by default (with chars/truncated) and truncates at --limit-chars", async () => {
      const para = await rd(["element", "read", "--ref", refFor(snapshot, /paragraph.*Hello/)]);
      assert.equal(para.exitCode, 0, para.stderr);
      assert.equal(para.json.data.text, "Hello brave world");
      assert.equal(para.json.data.chars, 17);
      assert.equal(para.json.data.truncated, false);
      assert.equal("attr" in para.json.data, false);
      const long = await rd(["element", "read", "--ref", refFor(snapshot, /paragraph.*word word/), "--limit-chars", "100"]);
      assert.equal(long.json.data.text.length, 100);
      assert.ok(long.json.data.chars > 2000);
      assert.equal(long.json.data.truncated, true);
      const dflt = await rd(["element", "read", "--ref", refFor(snapshot, /paragraph.*word word/)]);
      assert.equal(dflt.json.data.text.length, 2000, "default --limit-chars 2000");
      const range = await rd(["element", "read", "--ref", "e1", "--limit-chars", "20001"]);
      assert.equal(range.exitCode, 2);
    });

    it("reads one attribute; URL attributes lose query and fragment; tokens are masked; a missing attribute is null", async () => {
      const link = refFor(snapshot, /link "Docs link"/);
      const href = await rd(["element", "read", "--ref", link, "--attr", "href"]);
      assert.equal(href.exitCode, 0, href.stderr);
      assert.equal(href.json.data.attr, "href");
      assert.equal(href.json.data.value, "/about");
      assert.doesNotMatch(href.stdout, /QUERYSECRET1|frag/);
      const redirect = await rd(["element", "read", "--ref", refFor(snapshot, /link "Redirect link"/), "--attr", "data-redirect-url"]);
      assert.equal(redirect.json.data.value, "https://example.test/cb");
      assert.doesNotMatch(redirect.stdout, /XYZSECRET2/);
      const src = await rd(["element", "read", "--ref", refFor(snapshot, /img "Logo"/), "--attr", "src"]);
      assert.equal(src.json.data.value, "/logo.png");
      assert.doesNotMatch(src.stdout, /SIGSECRET3/);
      const missing = await rd(["element", "read", "--ref", link, "--attr", "data-nope"]);
      assert.equal(missing.json.data.value, null);
      assert.equal(missing.json.data.chars, 0);
      const key = await rd(["element", "read", "--ref", refFor(snapshot, /paragraph.*Key:/)]);
      assert.match(key.json.data.text, /^Key: \[token\] end$/);
      assert.doesNotMatch(key.stdout, /ghp_abc/);
      const badAttr = await rd(["element", "read", "--ref", link, "--attr", "bad attr!"]);
      assert.equal(badAttr.exitCode, 2);
      assert.equal(badAttr.json.error.field, "attr");
    });

    it("--attr value returns a text field's current value", async () => {
      const name = refFor(snapshot, /textbox "Name field"/);
      const v = await rd(["element", "read", "--ref", name, "--attr", "value"]);
      assert.equal(v.json.data.value, "initial");
    });

    it("password fields: no text, no value, no unknown attributes (ACTION_BLOCKED); descriptive attributes are fine; the secret never appears", async () => {
      const pass = refFor(snapshot, /textbox "Pass field"/);
      const outputs: string[] = [];
      for (const args of [["element", "read", "--ref", pass], ["element", "read", "--ref", pass, "--attr", "value"], ["element", "read", "--ref", pass, "--attr", "data-anything"]]) {
        const r = await rd(args);
        outputs.push(r.stdout + r.stderr);
        assert.equal(r.exitCode, 1, args.join(" "));
        assert.equal(r.json.error.code, "ACTION_BLOCKED", args.join(" "));
        assert.equal(r.json.retryable, false);
      }
      const ok = await rd(["element", "read", "--ref", pass, "--attr", "placeholder"]);
      assert.equal(ok.exitCode, 0, ok.stderr);
      assert.equal(ok.json.data.value, "your secret");
      outputs.push(ok.stdout);
      const type = await rd(["element", "read", "--ref", pass, "--attr", "type"]);
      assert.equal(type.json.data.value, "password");
      for (const o of outputs) assert.doesNotMatch(o, /hunter2/);
    });

    it("stale ref: REF_NOT_FOUND with a snapshot fix; schema declares the ranges", async () => {
      const r = await rd(["element", "read", "--ref", "e9999"]);
      assert.equal(r.json.error.code, "REF_NOT_FOUND");
      assert.match(r.json.suggested_fix.command, /page snapshot/);
      const schema = JSON.parse((await env.raw(["element", "read", "--schema"])).stdout);
      assert.equal(schema.kind, "read");
      assert.equal(schema.input.properties["limit-chars"].maximum, 20000);
      assert.equal(schema.input.properties["limit-chars"].default, 2000);
      assert.match(schema.input.properties.attr.pattern, /a-zA-Z/);
    });
  });
});
