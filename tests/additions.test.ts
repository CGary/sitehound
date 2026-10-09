/** snapshot --ref/--diff, browser open --block/--locale/--timezone/--geolocation, element check/uncheck, page pdf. */
import assert from "node:assert/strict";
import { readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { blockedCategory } from "../packages/core/src/browserd/block.ts";
import {
  BLOCK_PATTERN, isValidLocale, isValidTimezone, parseBlockList, parseGeolocation,
} from "../packages/core/src/browserd/limits.ts";
import { diffSnapshots } from "../packages/core/src/browserd/snapdiff.ts";
import { makeEnv, refFor, startFixture, type Env, type Fixture } from "./helpers/hound.ts";

const mode = (file: string): number => statSync(file).mode & 0o777;

describe("snapdiff / block / validators (unit)", () => {
  it("diffSnapshots: unified hunks with context, counts, refs kept, empty when equal", () => {
    const a = ["- main [ref=e1]:", "  - heading \"A\" [ref=e2]", "  - button \"One\" [ref=e3]", "  - button \"Two\" [ref=e4]", "- footer [ref=e5]"].join("\n");
    const b = ["- main [ref=e1]:", "  - heading \"A2\" [ref=e2]", "  - button \"One\" [ref=e3]", "  - button \"Two\" [ref=e4]", "  - button \"Three\" [ref=e6]", "- footer [ref=e5]"].join("\n");
    assert.deepEqual(diffSnapshots(a, a), { text: "", added: 0, removed: 0 });
    const d = diffSnapshots(a, b, 1);
    assert.equal(d.added, 2);
    assert.equal(d.removed, 1);
    assert.match(d.text, /^@@ -1,5 \+1,6 @@$/m, "the two changes are within each other's context: one hunk");
    assert.match(d.text, /^- {2}- heading "A" \[ref=e2\]$/m);
    assert.match(d.text, /^\+ {2}- heading "A2" \[ref=e2\]$/m);
    assert.match(d.text, /^\+ {2}- button "Three" \[ref=e6\]$/m);
    assert.deepEqual(diffSnapshots("- a [active] [ref=e1]\n- b [ref=e2]", "- a [ref=e1]\n- b [active] [ref=e2]"), { text: "", added: 0, removed: 0 }, "focus moves are not changes");
    assert.deepEqual(diffSnapshots("x\ny", "x\ny\nz", 0), { text: "@@ -3,0 +3,1 @@\n+z", added: 1, removed: 0 });
  });

  it("diffSnapshots: far-apart changes make separate hunks; a huge middle block falls back to a per-line comparison", () => {
    const base = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    const changed = base.map((l, i) => (i === 2 || i === 17 ? `${l} changed` : l));
    const d = diffSnapshots(base.join("\n"), changed.join("\n"), 1);
    assert.equal(d.text.split("\n").filter((l) => l.startsWith("@@")).length, 2);
    const big = Array.from({ length: 2500 }, (_, i) => `row ${i}`);
    const big2 = ["new first", ...big.slice(1), "new last"];
    const f = diffSnapshots(["old first", ...big.slice(1), "old last"].join("\n"), big2.join("\n"), 1);
    assert.equal(f.removed, 2);
    assert.equal(f.added, 2);
  });

  it("blockedCategory: type categories by resource type, hosts by suffix, the Facebook pixel by path", () => {
    assert.equal(blockedCategory("https://x.test/a.png", "image", ["images"]), "images");
    assert.equal(blockedCategory("https://x.test/a.png", "image", ["fonts", "media"]), undefined);
    assert.equal(blockedCategory("https://x.test/f.woff2", "font", ["fonts"]), "fonts");
    assert.equal(blockedCategory("https://x.test/v.mp4", "media", ["media"]), "media");
    assert.equal(blockedCategory("https://www.google-analytics.com/g/collect", "image", ["analytics"]), "analytics");
    assert.equal(blockedCategory("https://www.googletagmanager.com/gtm.js?id=GTM-1", "script", ["analytics"]), "analytics");
    assert.equal(blockedCategory("https://static.hotjar.com/c/hotjar-1.js", "script", ["analytics"]), "analytics");
    assert.equal(blockedCategory("https://cdn.segment.com/analytics.js/v1/x/analytics.min.js", "script", ["analytics"]), "analytics");
    assert.equal(blockedCategory("https://www.clarity.ms/tag/x", "script", ["analytics"]), "analytics");
    assert.equal(blockedCategory("https://analytics.tiktok.com/i18n/pixel/events.js", "script", ["analytics"]), "analytics");
    assert.equal(blockedCategory("https://connect.facebook.net/en_US/fbevents.js", "script", ["analytics"]), "analytics");
    assert.equal(blockedCategory("https://www.facebook.com/tr/?id=1", "image", ["analytics"]), "analytics");
    assert.equal(blockedCategory("https://www.facebook.com/login", "document", ["analytics"]), undefined, "only the pixel path of facebook.com");
    assert.equal(blockedCategory("https://securepubads.g.doubleclick.net/gampad/ads", "script", ["ads"]), "ads");
    assert.equal(blockedCategory("https://pagead2.googlesyndication.com/x.js", "script", ["analytics", "ads"]), "ads");
    assert.equal(blockedCategory("https://pagead2.googlesyndication.com/x.js", "script", ["analytics"]), undefined);
    assert.equal(blockedCategory("https://notgoogle-analytics.com/x", "script", ["analytics"]), undefined, "a host matches itself and its subdomains only");
    assert.equal(blockedCategory("https://example.com/", "document", ["analytics", "ads", "images", "media", "fonts"]), undefined);
    assert.equal(blockedCategory("not a url", "script", ["ads"]), undefined);
  });

  it("parseBlockList / pattern, locale, timezone and geolocation validators", () => {
    assert.deepEqual(parseBlockList("fonts,images,images,ads"), ["ads", "images", "fonts"]);
    assert.equal(parseBlockList("ads,video"), undefined);
    assert.ok(new RegExp(BLOCK_PATTERN).test("analytics,ads"));
    assert.ok(!new RegExp(BLOCK_PATTERN).test("analytics,"));
    assert.ok(isValidLocale("es-AR") && isValidLocale("en") && isValidLocale("zh-Hant-TW"));
    assert.ok(!isValidLocale("en-US-US") && !isValidLocale("e") && !isValidLocale("en_US"));
    assert.ok(isValidTimezone("America/Argentina/Buenos_Aires") && isValidTimezone("UTC") && isValidTimezone("Europe/Madrid"));
    assert.ok(!isValidTimezone("Mars/Olympus") && !isValidTimezone("+01:00") && !isValidTimezone("Europe/../x"));
    assert.deepEqual(parseGeolocation("-34.6037,-58.3816"), { latitude: -34.6037, longitude: -58.3816 });
    assert.deepEqual(parseGeolocation("40,3.5,25.5"), { latitude: 40, longitude: 3.5, accuracy: 25.5 });
    assert.equal(parseGeolocation("91,0"), undefined);
    assert.equal(parseGeolocation("0,181"), undefined);
    assert.equal(parseGeolocation("0,0,200000"), undefined);
    assert.equal(parseGeolocation("1;2"), undefined);
  });
});

describe("page snapshot --ref and --diff", () => {
  let env: Env;
  let fx: Fixture;
  const S = "ad-snap";
  const snap = (extra: string[] = []) => env.hound(["page", "snapshot", "--session-name", S, "--limit-chars", "100000", ...extra]);

  before(async () => {
    env = await makeEnv();
    fx = await startFixture();
    assert.equal((await env.open(S, ["--actions", "interact"])).exitCode, 0);
  });
  after(async () => {
    await env.cleanup();
    await fx.close();
  });

  /** A tab with no snapshot history on /diffy (the old tabs are closed): baselines belong to a tab, and navigating keeps them. */
  const goDiffy = async () => {
    const n = (await env.hound(["page", "tabs", "--session-name", S, "--action", "list"])).json.data.count as number;
    assert.equal((await env.hound(["page", "tabs", "--session-name", S, "--action", "new", "--url", fx.url("/diffy")])).exitCode, 0);
    for (let i = 0; i < n; i++) assert.equal((await env.hound(["page", "tabs", "--session-name", S, "--action", "close", "--tab-index", "0"])).exitCode, 0);
  };
  const click = async (text: RegExp) => {
    const full = (await snap()).json.data.snapshot as string;
    const r = await env.hound(["element", "click", "--session-name", S, "--ref", refFor(full, text)]);
    assert.equal(r.exitCode, 0, r.stdout);
  };

  it("--ref reads only that subtree, with the same refs a full snapshot gives, and they work for element commands", async () => {
    await goDiffy();
    const full = (await snap()).json.data.snapshot as string;
    const mainRef = refFor(full, /main "Work area"/);
    const sub = await snap(["--ref", mainRef]);
    assert.equal(sub.exitCode, 0, sub.stdout);
    const text = sub.json.data.snapshot as string;
    assert.match(text, /^- main "Work area"/);
    assert.match(text, /Order one/);
    assert.doesNotMatch(text, /Footer text|About page|navigation/);
    assert.ok(text.length < full.length);
    assert.equal(refFor(text, /button "Add order"/), refFor(full, /button "Add order"/));
    assert.ok(sub.json.data.refs < (await snap()).json.data.refs);
    assert.match(sub.json.summary, new RegExp(`${mainRef} on `));
    // A ref from the subtree snapshot clicks the right element.
    const add = await env.hound(["element", "click", "--session-name", S, "--ref", refFor(text, /button "Add order"/)]);
    assert.equal(add.exitCode, 0, add.stdout);
    assert.match(((await snap(["--ref", mainRef])).json.data.snapshot as string), /Order 3/);
  });

  it("--ref with an unknown ref is REF_NOT_FOUND; the ref flag is declared with a pattern", async () => {
    const r = await snap(["--ref", "e9999"]);
    assert.equal(r.exitCode, 1);
    assert.equal(r.json.error.code, "REF_NOT_FOUND");
    const bad = await snap(["--ref", "not a ref"]);
    assert.equal(bad.exitCode, 2);
    assert.equal(bad.json.error.field, "ref");
    const schema = JSON.parse((await env.raw(["page", "snapshot", "--schema"])).stdout);
    assert.equal(schema.input.properties.diff.type, "boolean");
    assert.equal(typeof schema.input.properties.ref.pattern, "string");
  });

  it("--diff: the first call has no baseline and returns the full snapshot; later calls return only what changed", async () => {
    await goDiffy();
    const first = await snap(["--diff"]);
    assert.equal(first.exitCode, 0, first.stdout);
    assert.equal(first.json.data.baseline, false);
    assert.equal(first.json.data.diff, "");
    assert.equal(first.json.data.added > 10, true, "added counts the lines of the full snapshot");
    assert.equal(first.json.data.removed, 0);
    assert.match(first.json.data.snapshot, /Footer text/);
    assert.match(first.json.summary, /no earlier snapshot/);

    const none = await snap(["--diff"]);
    assert.equal(none.json.data.baseline, true);
    assert.equal(none.json.data.added + none.json.data.removed, 0);
    assert.equal(none.json.data.diff, "");
    assert.equal("snapshot" in none.json.data, false);
    assert.match(none.json.summary, /No changes/);

    await click(/button "Add order"/);
    const added = await snap(["--diff"]);
    const d = added.json.data;
    assert.equal(d.baseline, true);
    assert.ok(d.added >= 1 && d.removed === 0, JSON.stringify([d.added, d.removed]));
    assert.match(d.diff, /^@@ /m);
    assert.match(d.diff, /^\+.*Order 3/m);
    assert.doesNotMatch(d.diff, /Footer text|About page/);
    assert.ok(d.totalChars < first.json.data.totalChars / 2, "far smaller than the full snapshot");
    assert.ok(d.refs >= 1, "refs counts the whole page");

    await click(/button "Rename"/);
    const renamed = (await snap(["--diff"])).json.data;
    assert.match(renamed.diff, /^-.*heading "Orders"/m);
    assert.match(renamed.diff, /^\+.*heading "Orders \(renamed\)"/m);
    assert.doesNotMatch(renamed.diff, /Order 3/, "already in the baseline");

    await click(/button "Drop first"/);
    const dropped = (await snap(["--diff"])).json.data;
    assert.match(dropped.diff, /^-.*Order one/m);
    assert.ok(dropped.removed >= 1);
  });

  it("every snapshot becomes the baseline; --ref keeps its own baseline", async () => {
    await goDiffy();
    await snap();
    assert.equal((await snap(["--diff"])).json.data.baseline, true, "a plain snapshot is a baseline");
    const mainRef = refFor((await snap()).json.data.snapshot, /main "Work area"/);
    const scoped = await snap(["--diff", "--ref", mainRef]);
    assert.equal(scoped.json.data.baseline, false, "no baseline for this ref yet");
    assert.match(scoped.json.data.snapshot, /^- main "Work area"/);
    await click(/button "Add order"/);
    const after = (await snap(["--diff", "--ref", mainRef])).json.data;
    assert.equal(after.baseline, true);
    assert.match(after.diff, /^\+.*Order/m);
    assert.doesNotMatch(after.diff, /Footer/);
    const other = (await snap(["--diff", "--depth", "2"])).json.data;
    assert.equal(other.baseline, false, "another depth has its own baseline");
  });

  it("navigating inside a tab keeps its baseline (a diff across pages shows what the new page changed)", async () => {
    await goDiffy();
    await snap();
    assert.equal((await env.hound(["page", "navigate", "--session-name", S, "--url", fx.url("/about")])).exitCode, 0);
    const d = (await snap(["--diff"])).json.data;
    assert.equal(d.baseline, true);
    assert.match(d.diff, /^\+.*About/m);
    assert.match(d.diff, /^-.*Diffy/m);
  });

  it("the baseline is per tab", async () => {
    await goDiffy();
    await snap();
    const open = await env.hound(["page", "tabs", "--session-name", S, "--action", "new", "--url", fx.url("/about")]);
    assert.equal(open.exitCode, 0, open.stdout);
    assert.equal((await snap(["--diff"])).json.data.baseline, false, "the new tab has no baseline");
    assert.equal((await env.hound(["page", "tabs", "--session-name", S, "--action", "select", "--tab-index", "0"])).exitCode, 0);
    assert.equal((await snap(["--diff"])).json.data.baseline, true, "the first tab kept its own");
    assert.equal((await env.hound(["page", "tabs", "--session-name", S, "--action", "close", "--tab-index", "1"])).exitCode, 0);
  });

  it("--limit-chars, --output and the saved file hold the diff; URLs lose their query as in a plain snapshot", async () => {
    await goDiffy();
    await snap(["--diff"]);
    assert.equal((await env.hound(["page", "navigate", "--session-name", S, "--url", fx.url("/find")])).exitCode, 0);
    const r = await env.hound(["page", "snapshot", "--session-name", S, "--diff", "--limit-chars", "300"]);
    assert.equal(r.exitCode, 0, r.stdout);
    const d = r.json.data;
    assert.equal(d.baseline, true);
    assert.equal(d.truncated, true);
    assert.ok(d.diff.length <= 300);
    assert.ok(d.file, "the full diff goes to a file");
    assert.equal(mode(d.file), 0o600);
    const saved = readFileSync(d.file, "utf8");
    assert.equal(saved.length, d.totalChars);
    assert.match(saved, /^@@ /);
    assert.match(saved, /\/url: \/about/);
    assert.doesNotMatch(saved, /utm=|\?i=/, "queries are stripped");

    const out = join(env.cwd, "diff.txt");
    await snap();
    writeFileSync(join(env.cwd, "keep.txt"), "x");
    const w = await env.hound(["page", "snapshot", "--session-name", S, "--diff", "--output", out]);
    assert.equal(w.exitCode, 0, w.stdout);
    assert.equal(w.json.data.file, out);
    assert.equal(readFileSync(out, "utf8"), "");
    assert.equal(mode(out), 0o600);
    const again = await env.hound(["page", "snapshot", "--session-name", S, "--diff", "--output", out]);
    assert.equal(again.json.error.code, "CONFLICT");
  });
});

describe("browser open --block", () => {
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

  const netAll = async (s: string) => (await env.hound(["diag", "network", "--session-name", s, "--state", "all", "--limit", "100"])).json.data.entries as any[];
  const pic = async (s: string) => {
    const r = await env.hound(["page", "wait", "--session-name", s, "--for", "text", "--value", "pic:"]);
    assert.equal(r.exitCode, 0, r.stdout);
    const f = await env.hound(["page", "find", "--session-name", s, "--text", "pic:"]);
    return /pic:(\d+)/.exec(f.json.data.matches[0].text)![1];
  };

  it("blocks images, fonts, media and trackers; blocked requests are marked and are not failures", async () => {
    const S = "ad-block";
    const open = await env.open(S, ["--block", "fonts,images,analytics,media"]);
    assert.equal(open.exitCode, 0, open.stdout);
    assert.deepEqual(open.json.data.block, ["analytics", "images", "media", "fonts"]);
    assert.match(open.json.summary, /blocking analytics\+images\+media\+fonts/);
    assert.deepEqual((await env.hound(["browser", "status", "--session-name", S])).json.data.block, ["analytics", "images", "media", "fonts"]);
    assert.equal((await env.hound(["page", "navigate", "--session-name", S, "--url", fx.url("/blockme?trackers=1")])).exitCode, 0);
    assert.equal(await pic(S), "0", "the image never loaded");
    const all = await netAll(S);
    const by = (re: RegExp) => all.find((e) => re.test(e.url));
    assert.equal(by(/pic\.png/).blocked, "images");
    assert.equal(by(/pic\.png/).failure, "blocked");
    assert.equal(by(/t\.woff2/).blocked, "fonts");
    assert.equal(by(/a\.mp3/).blocked, "media");
    assert.equal(by(/google-analytics\.com/).blocked, "analytics");
    assert.equal(by(/doubleclick\.net/).blocked, "analytics");
    assert.equal(by(/\/blockme$/).status, 200, "the page itself is not blocked");
    const failed = (await env.hound(["diag", "network", "--session-name", S])).json.data;
    assert.ok(failed.entries.every((e: any) => !e.blocked), "blocked requests are not failures");
    const plain = await env.raw(["diag", "network", "--session-name", S, "--state", "all", "--plain"]);
    assert.match(plain.stdout, /blocked image .*pic\.png/);
    // The daemon log never gets URLs, and the request op explains a blocked request.
    const idx = by(/pic\.png/).index;
    const body = await env.hound(["diag", "request", "--session-name", S, "--index", String(idx), "--part", "response-body"]);
    assert.equal(body.exitCode, 1);
    assert.match(body.json.error.message, /blocked by --block images/);
  });

  it("only the blocked categories are refused; without --block nothing is", async () => {
    const S1 = "ad-img";
    assert.equal((await env.open(S1, ["--block", "images"])).exitCode, 0);
    assert.equal((await env.hound(["page", "navigate", "--session-name", S1, "--url", fx.url("/blockme")])).exitCode, 0);
    assert.equal(await pic(S1), "0");
    const all = await netAll(S1);
    assert.equal(all.find((e) => /t\.woff2/.test(e.url)).status, 200, "fonts were not in the list");
    assert.equal(all.find((e) => /pic\.png/.test(e.url)).blocked, "images");

    const S2 = "ad-none";
    const open = await env.open(S2);
    assert.equal("block" in open.json.data, false);
    assert.equal("locale" in open.json.data, false);
    assert.equal((await env.hound(["page", "navigate", "--session-name", S2, "--url", fx.url("/blockme")])).exitCode, 0);
    assert.equal(await pic(S2), "1", "the 1x1 image loaded");
    const rest = await netAll(S2);
    assert.ok(rest.every((e) => !e.blocked));
    assert.equal(rest.find((e) => /pic\.png/.test(e.url)).status, 200);
    // wait --for request sees a blocked request too (it is finished)
    const w = await env.hound(["page", "wait", "--session-name", S1, "--for", "request", "--value", "/assets/pic.png", "--since-index", "0"]);
    assert.equal(w.exitCode, 0, w.stdout);
    assert.equal(w.json.data.failure, "blocked");
  });

  it("--block is declared in --schema and checked before anything starts", async () => {
    const schema = JSON.parse((await env.raw(["browser", "open", "--schema"])).stdout);
    assert.equal(schema.input.properties.block.pattern, BLOCK_PATTERN);
    assert.match(schema.input.properties.block.description, /analytics.*ads.*images.*media.*fonts/s);
    for (const bad of ["ads,video", "analytics,", "Images", "x"]) {
      const r = await env.hound(["browser", "open", "--session-name", "ad-bad", "--block", bad]);
      assert.equal(r.exitCode, 2, bad);
      assert.equal(r.json.error.code, "INVALID_ARGUMENT");
      assert.equal(r.json.error.field, "block");
    }
    assert.equal((await env.hound(["browser", "list"])).json.data.sessions.some((s: any) => s.session === "ad-bad"), false);
  });
});

describe("browser open --locale, --timezone and --geolocation", () => {
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

  it("the page sees the language, the time zone and the fixed position (the permission is granted)", async () => {
    const S = "ad-env";
    const open = await env.open(S, ["--locale", "es-AR", "--timezone", "Asia/Tokyo", "--geolocation=-34.6037,-58.3816,50"]);
    assert.equal(open.exitCode, 0, open.stdout);
    assert.equal(open.json.data.locale, "es-AR");
    assert.equal(open.json.data.timezone, "Asia/Tokyo");
    assert.deepEqual(open.json.data.geolocation, { latitude: -34.6037, longitude: -58.3816, accuracy: 50 });
    const status = (await env.hound(["browser", "status", "--session-name", S])).json.data;
    assert.equal(status.locale, "es-AR");
    assert.equal(status.timezone, "Asia/Tokyo");
    assert.equal(status.geolocation.latitude, -34.6037);
    assert.equal((await env.hound(["page", "navigate", "--session-name", S, "--url", fx.url("/env")])).exitCode, 0);
    assert.equal((await env.hound(["page", "wait", "--session-name", S, "--for", "text", "--value", "geo:-34"])).exitCode, 0);
    const find = async (t: string) => (await env.hound(["page", "find", "--session-name", S, "--text", t])).json.data.matches[0].text as string;
    assert.match(await find("lang:"), /lang:es-AR num:1\.234,5/);
    assert.match(await find("tz:"), /tz:Asia\/Tokyo/);
    assert.match(await find("geo:"), /geo:-34\.6037,-58\.3816,50/);
    // A new tab keeps them.
    assert.equal((await env.hound(["page", "tabs", "--session-name", S, "--action", "new", "--url", fx.url("/env")])).exitCode, 0);
    assert.match(await find("tz:"), /tz:Asia\/Tokyo/);
  });

  it("a position without --geolocation is not granted; defaults leave the keys out", async () => {
    const S = "ad-noenv";
    const open = await env.open(S);
    for (const k of ["locale", "timezone", "geolocation"]) assert.equal(k in open.json.data, false, k);
    assert.equal((await env.hound(["page", "navigate", "--session-name", S, "--url", fx.url("/env")])).exitCode, 0);
    assert.equal((await env.hound(["page", "wait", "--session-name", S, "--for", "text", "--value", "geo-error"])).exitCode, 0);
    const lang = (await env.hound(["page", "find", "--session-name", S, "--text", "lang:"])).json.data.matches[0].text as string;
    assert.match(lang, /lang:en-US/);
  });

  it("formats are declared in --schema; bad values are usage errors before any browser starts", async () => {
    const props = JSON.parse((await env.raw(["browser", "open", "--schema"])).stdout).input.properties;
    for (const k of ["locale", "timezone", "geolocation"]) assert.equal(typeof props[k].pattern, "string", k);
    assert.match(props.geolocation.description, /latitude -90\.\.90/);
    const cases: [string[], string][] = [
      [["--locale", "e"], "locale"],
      [["--locale", "en-US-US"], "locale"],
      [["--timezone", "Mars/Olympus"], "timezone"],
      [["--timezone", "+01:00"], "timezone"],
      [["--geolocation", "abc"], "geolocation"],
      [["--geolocation", "91,0"], "geolocation"],
      [["--geolocation", "0,181"], "geolocation"],
      [["--geolocation", "0,0,1000000"], "geolocation"],
    ];
    for (const [flags, field] of cases) {
      const r = await env.hound(["browser", "open", "--session-name", "ad-bad", ...flags]);
      assert.equal(r.exitCode, 2, flags.join(" "));
      assert.equal(r.json.error.code, "INVALID_ARGUMENT", flags.join(" "));
      assert.equal(r.json.error.field, field, flags.join(" "));
    }
    assert.equal((await env.hound(["browser", "list"])).json.data.sessions.some((s: any) => s.session === "ad-bad"), false);
  });
});

describe("element check / uncheck", () => {
  let env: Env;
  let fx: Fixture;
  const IA = "ad-chk";
  const RD = "ad-chk-rd";
  const ia = (args: string[]) => env.hound(args.concat("--session-name", IA));
  let snapshot = "";

  before(async () => {
    env = await makeEnv();
    fx = await startFixture();
    assert.equal((await env.open(IA, ["--actions", "interact"])).exitCode, 0);
    assert.equal((await env.open(RD)).exitCode, 0);
  });
  after(async () => {
    await env.cleanup();
    await fx.close();
  });

  const reload = async () => {
    assert.equal((await ia(["page", "navigate", "--url", fx.url("/checks")])).exitCode, 0);
    snapshot = (await ia(["page", "snapshot", "--limit-chars", "100000"])).json.data.snapshot as string;
  };
  const line = async (re: RegExp) => ((await ia(["page", "snapshot", "--limit-chars", "100000"])).json.data.snapshot as string).split("\n").find((l) => re.test(l)) ?? "";
  const ref = (re: RegExp) => refFor(snapshot, re);

  it("check is idempotent: it clicks once, then reports changed false", async () => {
    await reload();
    assert.doesNotMatch(await line(/Newsletter/), /\[checked\]/);
    const first = await ia(["element", "check", "--ref", ref(/checkbox "Newsletter"/)]);
    assert.equal(first.exitCode, 0, first.stdout);
    assert.deepEqual({ ...first.json.data }, { ref: ref(/checkbox "Newsletter"/), checked: true, changed: true });
    assert.equal(first.json.command, "element.check");
    assert.match(first.json.summary, /Checked/);
    assert.match(await line(/Newsletter/), /\[checked\]/);
    // The state-changing mark: the request fired by the change handler is found by a wait that starts after the check returned.
    const w = await ia(["page", "wait", "--for", "request", "--value", "/api/data"]);
    assert.equal(w.exitCode, 0, w.stdout);
    const again = await ia(["element", "check", "--ref", ref(/checkbox "Newsletter"/)]);
    assert.deepEqual({ ...again.json.data }, { ref: ref(/checkbox "Newsletter"/), checked: true, changed: false });
    assert.match(again.json.summary, /already checked/);
  });

  it("uncheck sets a pre-checked box off, and is a no-op when it already is", async () => {
    await reload();
    const terms = ref(/checkbox "Terms"/);
    const r = await ia(["element", "uncheck", "--ref", terms]);
    assert.deepEqual({ ...r.json.data }, { ref: terms, checked: false, changed: true });
    assert.equal(r.json.command, "element.uncheck");
    assert.doesNotMatch(await line(/Terms/), /\[checked\]/);
    const again = await ia(["element", "uncheck", "--ref", terms]);
    assert.deepEqual({ ...again.json.data }, { ref: terms, checked: false, changed: false });
    assert.match(again.json.summary, /already unchecked/);
  });

  it("radio buttons can be checked (the group follows) but not unchecked; ARIA switches and checkboxes work", async () => {
    await reload();
    const small = ref(/radio "Small"/);
    const on = await ia(["element", "check", "--ref", small]);
    assert.equal(on.json.data.changed, true);
    assert.match(await line(/radio "Small"/), /\[checked\]/);
    assert.doesNotMatch(await line(/radio "Large"/), /\[checked\]/);
    const off = await ia(["element", "uncheck", "--ref", small]);
    assert.equal(off.exitCode, 2, "INVALID_ARGUMENT is a usage code");
    assert.equal(off.json.error.code, "INVALID_ARGUMENT");
    assert.match(off.json.error.message, /radio button/);
    const noop = await ia(["element", "uncheck", "--ref", ref(/radio "Large"/)]);
    assert.equal(noop.json.data.changed, false, "already unchecked");

    const dark = await ia(["element", "check", "--ref", ref(/switch "Dark mode"/)]);
    assert.deepEqual([dark.json.data.checked, dark.json.data.changed], [true, true]);
    const agree = await ia(["element", "uncheck", "--ref", ref(/checkbox "Agree"/)]);
    assert.deepEqual([agree.json.data.checked, agree.json.data.changed], [false, true]);
    assert.equal((await ia(["element", "check", "--ref", ref(/switch "Dark mode"/)])).json.data.changed, false);
  });

  it("--dialog accept answers the confirm a change handler raises", async () => {
    await reload();
    const r = await ia(["element", "check", "--ref", ref(/checkbox "Delete all"/), "--dialog", "accept"]);
    assert.equal(r.exitCode, 0, r.stdout);
    assert.equal(r.json.data.changed, true);
    assert.equal(r.json.data.dialogs[0].type, "confirm");
    assert.equal(r.json.data.dialogs[0].action, "accept");
    assert.match(r.json.summary, /dialog\(s\) handled/);
    const out = await ia(["page", "find", "--text", "confirmed"]);
    assert.equal(out.json.data.total >= 1, true);
    const bad = await ia(["element", "check", "--ref", "e1", "--dialog", "dismiss", "--dialog-text", "x"]);
    assert.equal(bad.exitCode, 2, "--dialog-text is for an accepted dialog");
  });

  it("refuses what is not a checkbox, a box the page will not toggle, and a stale ref", async () => {
    await reload();
    const btn = await ia(["element", "check", "--ref", ref(/button "Plain button"/)]);
    assert.equal(btn.exitCode, 2);
    assert.equal(btn.json.error.code, "INVALID_ARGUMENT");
    assert.match(btn.json.error.message, /not a checkbox, radio button or switch/);
    const stuck = await ia(["element", "check", "--ref", ref(/checkbox "Stuck"/), "--timeout", "8"]);
    assert.equal(stuck.exitCode, 1, stuck.stdout);
    assert.equal(stuck.json.error.code, "CONFLICT");
    const stale = await ia(["element", "uncheck", "--ref", "e9999"]);
    assert.equal(stale.json.error.code, "REF_NOT_FOUND");
  });

  it("the read level refuses both verbs", async () => {
    assert.equal((await env.hound(["page", "navigate", "--session-name", RD, "--url", fx.url("/checks")])).exitCode, 0);
    const s = (await env.hound(["page", "snapshot", "--session-name", RD, "--limit-chars", "100000"])).json.data.snapshot as string;
    for (const verb of ["check", "uncheck"]) {
      const r = await env.hound(["element", verb, "--session-name", RD, "--ref", refFor(s, /checkbox "Newsletter"/)]);
      assert.equal(r.exitCode, 1, verb);
      assert.equal(r.json.error.code, "ACTION_BLOCKED", verb);
      assert.match(r.json.suggested_fix.command, /--actions interact/);
    }
    assert.doesNotMatch(
      ((await env.hound(["page", "snapshot", "--session-name", RD, "--limit-chars", "100000"])).json.data.snapshot as string).split("\n").find((l) => /Newsletter/.test(l)) ?? "",
      /\[checked\]/,
    );
  });

  it("typos get a suggestion and --schema lists the shared flags", async () => {
    const typo = await env.hound(["element", "chek", "--session-name", IA]);
    assert.equal(typo.exitCode, 2);
    assert.match(typo.json.error.message, /Did you mean "element check"/);
    const schema = JSON.parse((await env.raw(["element", "uncheck", "--schema"])).stdout);
    assert.deepEqual(schema.input.required.sort(), ["ref", "session-name"]);
    assert.deepEqual(schema.input.properties.dialog.enum, ["accept", "dismiss"]);
  });
});

describe("page pdf", () => {
  let env: Env;
  let fx: Fixture;
  const S = "ad-pdf";
  const pdf = (extra: string[] = []) => env.hound(["page", "pdf", "--session-name", S, ...extra]);

  before(async () => {
    env = await makeEnv();
    fx = await startFixture();
    assert.equal((await env.open(S)).exitCode, 0);
    assert.equal((await env.hound(["page", "navigate", "--session-name", S, "--url", fx.url("/print")])).exitCode, 0);
  });
  after(async () => {
    await env.cleanup();
    await fx.close();
  });

  it("writes a PDF (0600) under the session's runs directory and reports bytes and pages", async () => {
    const r = await pdf();
    assert.equal(r.exitCode, 0, r.stdout);
    const d = r.json.data;
    assert.equal(r.json.command, "page.pdf");
    assert.match(d.file, /page-.*\.pdf$/);
    const buf = readFileSync(d.file);
    assert.equal(buf.subarray(0, 5).toString("latin1"), "%PDF-");
    assert.equal(d.bytes, buf.length);
    assert.equal(mode(d.file), 0o600);
    assert.ok(d.pages >= 3, `pages: ${d.pages}`);
    assert.equal(d.format, "A4");
    assert.equal(d.landscape, false);
    assert.equal(d.background, false);
    assert.equal(d.url, fx.url("/print"));
    assert.equal(r.json.next_actions.length <= 3, true);
  });

  it("--format, --landscape and --background change the output", async () => {
    const portrait = await pdf(["--format", "Letter"]);
    const land = await pdf(["--format", "Legal", "--landscape", "--background"]);
    assert.equal(land.exitCode, 0, land.stdout);
    assert.deepEqual([land.json.data.format, land.json.data.landscape, land.json.data.background], ["Legal", true, true]);
    assert.notEqual(land.json.data.bytes, portrait.json.data.bytes);
    assert.notEqual(land.json.data.file, portrait.json.data.file, "each call writes its own file");
    assert.equal(readFileSync(land.json.data.file).subarray(0, 4).toString("latin1"), "%PDF");
  });

  it("--output uses the safe write: CONFLICT unless --if-exists overwrite, never through a symlink, 0600", async () => {
    const out = join(env.cwd, "page.pdf");
    const first = await pdf(["--output", out]);
    assert.equal(first.exitCode, 0, first.stdout);
    assert.equal(first.json.data.file, out);
    assert.equal(mode(out), 0o600);
    assert.equal(readFileSync(out).subarray(0, 4).toString("latin1"), "%PDF");
    const again = await pdf(["--output", out]);
    assert.equal(again.exitCode, 1);
    assert.equal(again.json.error.code, "CONFLICT");
    assert.match(again.json.suggested_fix.command, /--if-exists overwrite/);
    assert.equal((await pdf(["--output", out, "--if-exists", "overwrite"])).exitCode, 0);
    const target = join(env.cwd, "victim.txt");
    writeFileSync(target, "keep");
    const link = join(env.cwd, "link.pdf");
    symlinkSync(target, link);
    const viaLink = await pdf(["--output", link, "--if-exists", "overwrite"]);
    assert.equal(viaLink.exitCode, 2);
    assert.equal(readFileSync(target, "utf8"), "keep");
    const dir = await pdf(["--output", env.cwd]);
    assert.equal(dir.exitCode, 2);
  });

  it("declares its flags, and a bad paper size is a usage error", async () => {
    const schema = JSON.parse((await env.raw(["page", "pdf", "--schema"])).stdout);
    assert.deepEqual(schema.input.properties.format.enum, ["A4", "Letter", "Legal"]);
    assert.equal(schema.input.properties.format.default, "A4");
    assert.equal(schema.input.properties.landscape.type, "boolean");
    assert.equal(schema.kind, "read");
    const bad = await pdf(["--format", "A5"]);
    assert.equal(bad.exitCode, 2);
    assert.equal(bad.json.error.code, "INVALID_ENUM");
    const typo = await env.hound(["page", "pfd", "--session-name", S]);
    assert.match(typo.json.error.message, /Did you mean "page pdf"/);
  });
});
