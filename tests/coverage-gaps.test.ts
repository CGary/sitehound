/**
 * Coverage gaps: profile login (pty + core), headed display, real idle timeout, tab switching, task component,
 * deprecated `hound mcp`, and `snapshot --ref` keeping other refs valid. Every CLI test runs against an isolated
 * HOUND_HOME (makeEnv); the in-process core tests set HOUND_HOME before core is imported. Erasable TypeScript only.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type * as CoreTypes from "../packages/core/src/index.ts";
import { snapshotSubtree } from "../packages/core/src/browserd/snapdiff.ts";
import { HOUND_BIN, isAlive, makeEnv, refFor, startFixture, writeSyntheticProfile, type Env, type Fixture } from "./helpers/hound.ts";

const CORE_HOME = mkdtempSync(join(tmpdir(), "hound-gaps-core-"));
process.env.HOUND_HOME = CORE_HOME;
delete process.env.DEBUG;
const core: typeof CoreTypes = await import("../packages/core/src/index.ts");

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const mode = (p: string): number => statSync(p).mode & 0o777;
const hasDisplay = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
const NO_DISPLAY = "no $DISPLAY/$WAYLAND_DISPLAY: headed Chromium needs a display";
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** Runs `hound <args>` on a pseudo-terminal (util-linux `script`) and presses Enter when the prompt shows up. */
function runOnPty(env: Env, args: string[], timeoutMs = 60_000): Promise<{ exitCode: number; json: any; text: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("script", ["-qec", [HOUND_BIN, ...args].map(shq).join(" "), "/dev/null"], {
      cwd: env.cwd,
      env: { ...process.env, SHELL: "/bin/sh", HOUND_HOME: env.home, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let text = "";
    let pressed = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`pty run timed out; output so far: ${text.replace(ANSI, "").slice(-400)}`));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      text += chunk.toString("utf8");
      if (!pressed && /press Enter here/.test(text)) {
        pressed = true;
        child.stdin.write("\n");
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.stdin.on("error", () => {});
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const line = text.replace(ANSI, "").split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith('{"ok"'));
      resolve({ exitCode: code ?? -1, json: line ? JSON.parse(line) : undefined, text });
    });
  });
}

// Groups and tests run one after the other: they share sessions and profiles, and many Chromiums at once starve the rest of the suite (screenshots fail under load).
const SEQ = { concurrency: 1 } as const;

describe("coverage gaps", SEQ, () => {
  // ---------------------------------------------------------------------------------------------
  // 1. profile login
  // ---------------------------------------------------------------------------------------------
  describe("profile login: core save (headless, in-process)", SEQ, () => {
    let fx: Fixture;
    const profilesDir = join(CORE_HOME, "profiles");
    before(async () => {
      fx = await startFixture();
    });
    after(async () => {
      await fx.close();
    });

    /** What the CLI does after the human presses Enter: save the storage state, then the meta. */
    async function login(name: string, loginUrl: string, landing: string, loadProfile?: string): Promise<CoreTypes.ProfileMeta & { storage: any }> {
      const session = await core.openSession({ headless: true, ...(loadProfile ? { profile: loadProfile } : {}) });
      try {
        const page = await session.context.newPage();
        await page.goto(new URL("/api/data", landing).href); // the fixture API sets a cookie for this host
        await page.goto(landing);
        await page.evaluate((key) => localStorage.setItem(key, "kept"), `ls-${new URL(landing).hostname}`);
        const path = await core.saveProfile(session.context, name);
        assert.equal(path, join(profilesDir, `${name}.json`));
        const meta = await core.saveProfileMeta(name, loginUrl, page.url(), loadProfile ? "extend" : "replace");
        return { ...meta, storage: JSON.parse(readFileSync(path, "utf8")) };
      } finally {
        await session.close();
      }
    }
    const hostsOf = (storage: any): string[] => (storage.cookies as { domain: string }[]).map((c) => c.domain).sort();
    const originsOf = (storage: any): string[] => (storage.origins as { origin: string }[]).map((o) => o.origin).sort();

    it("replace: saves cookies + localStorage, 0600 files in a 0700 dir, meta URLs without query or fragment", async () => {
      const m = await login("gap-a", fx.url("/login?next=/private&token=LOGINSECRET#frag"), fx.url("/about?session=LANDSECRET#x"));
      assert.equal(mode(profilesDir), 0o700);
      assert.equal(mode(join(profilesDir, "gap-a.json")), 0o600);
      assert.equal(mode(join(profilesDir, "gap-a.meta.json")), 0o600);
      assert.ok(m.storage.cookies.length >= 1, "the cookie of the visited host is saved");
      assert.deepEqual(originsOf(m.storage), [fx.origin], "localStorage of the visited origin is saved");
      const raw = readFileSync(join(profilesDir, "gap-a.meta.json"), "utf8");
      assert.doesNotMatch(raw, /LOGINSECRET|LANDSECRET|[?#]/, "no query or fragment in the meta file");
      const meta = JSON.parse(raw);
      assert.equal(meta.name, "gap-a");
      assert.equal(meta.sites.length, 1);
      assert.equal(meta.sites[0].loginUrl, fx.url("/login"));
      assert.equal(meta.sites[0].landingUrl, fx.url("/about"));
      assert.match(meta.sites[0].savedAt, /^\d{4}-\d\d-\d\dT/);
      assert.deepEqual(core.readProfileMeta("gap-a")?.sites.map((s) => s.landingUrl), [fx.url("/about")]);
    });

    it("saving over a looser existing profile file tightens it to 0600", async () => {
      const { chmodSync } = await import("node:fs");
      chmodSync(join(profilesDir, "gap-a.json"), 0o644);
      chmodSync(join(profilesDir, "gap-a.meta.json"), 0o644);
      await login("gap-a", fx.url("/login"), fx.url("/about"));
      assert.equal(mode(join(profilesDir, "gap-a.json")), 0o600);
      assert.equal(mode(join(profilesDir, "gap-a.meta.json")), 0o600);
    });

    it("extend keeps the earlier site's cookies and meta and adds a second origin; the same origin is updated in place", async () => {
      const otherOrigin = fx.origin.replace("127.0.0.1", "localhost");
      const ext = await login("gap-a", `${otherOrigin}/login`, `${otherOrigin}/about`, "gap-a");
      assert.deepEqual(ext.sites.map((s) => new URL(s.landingUrl).hostname), ["127.0.0.1", "localhost"]);
      assert.deepEqual(hostsOf(ext.storage).filter((d, i, a) => a.indexOf(d) === i), ["127.0.0.1", "localhost"], "cookies of both sites");
      assert.deepEqual(originsOf(ext.storage), [otherOrigin, fx.origin].sort(), "localStorage of both sites");
      const first = ext.sites[0]!.savedAt;
      await sleep(15);
      const again = await login("gap-a", fx.url("/login"), fx.url("/form"), "gap-a");
      assert.equal(again.sites.length, 2, "same login origin: updated, not duplicated");
      assert.equal(again.sites[0]!.landingUrl, fx.url("/form"));
      assert.notEqual(again.sites[0]!.savedAt, first);
      assert.equal(again.sites[1]!.landingUrl, `${otherOrigin}/about`);
    });

    it("replace discards the earlier sites (meta and storage)", async () => {
      const otherOrigin = fx.origin.replace("127.0.0.1", "localhost");
      const rep = await login("gap-a", `${otherOrigin}/login`, `${otherOrigin}/about`);
      assert.equal(rep.sites.length, 1);
      assert.equal(new URL(rep.sites[0]!.landingUrl).hostname, "localhost");
      assert.ok(!hostsOf(rep.storage).includes("127.0.0.1"), "the old site's cookies are gone");
      assert.deepEqual(originsOf(rep.storage), [otherOrigin]);
      assert.deepEqual((await core.listProfiles()).sort(), ["gap-a"]);
    });

    it("an unsafe name or a .meta suffix is rejected before anything is written", async () => {
      assert.throws(() => core.profilePath("../x"), (e: unknown) => e instanceof core.HoundError && e.code === "INVALID_ARGUMENT");
      assert.throws(() => core.profilePath("x.meta"), (e: unknown) => e instanceof core.HoundError && e.code === "INVALID_ARGUMENT");
      await assert.rejects(core.saveProfileMeta("../x", "http://a.test/", "http://a.test/"), (e: unknown) => e instanceof core.HoundError);
      assert.ok(!existsSync(join(profilesDir, "..", "x.json")));
    });
  });

  describe("profile login: through a pseudo-terminal (CLI)", { ...SEQ, skip: hasDisplay && existsSync("/usr/bin/script") ? false : hasDisplay ? "util-linux `script` not found" : NO_DISPLAY }, () => {
    let env: Env;
    let fx: Fixture;
    before(async () => {
      env = await makeEnv();
      fx = await startFixture();
    });
    after(async () => {
      await fx.close();
      await env.cleanup();
    });

    it("replace on a new profile: human presses Enter, session saved (0600/0700), URLs stripped, profile check is valid", async (t) => {
      const r = await runOnPty(env, ["profile", "login", "--profile", "pty-a", "--url", fx.url("/about?secret=PTYSECRET#f"), "--json"]);
      if (r.json?.error?.code === "BROWSER_CRASHED") return t.skip(`headed Chromium cannot start here: ${r.json.error.message}`);
      assert.equal(r.exitCode, 0, r.text.replace(ANSI, "").slice(-500));
      assert.equal(r.json.ok, true);
      assert.equal(r.json.command, "profile.login");
      assert.equal(r.json.data.mode, "replace");
      assert.deepEqual(r.json.data.sites.map((s: any) => s.origin), [fx.origin]);
      assert.doesNotMatch(r.text, /PTYSECRET/, "the query string never reaches the output");
      const file = join(env.home, "profiles", "pty-a.json");
      assert.equal(r.json.data.path, file);
      assert.equal(mode(join(env.home, "profiles")), 0o700);
      assert.equal(mode(file), 0o600);
      assert.equal(mode(join(env.home, "profiles", "pty-a.meta.json")), 0o600);
      const meta = JSON.parse(readFileSync(join(env.home, "profiles", "pty-a.meta.json"), "utf8"));
      assert.equal(meta.sites[0].loginUrl, fx.url("/about"));
      assert.doesNotMatch(JSON.stringify(meta), /PTYSECRET|#/);
      const check = await env.hound(["profile", "check", "--profile", "pty-a"]);
      assert.equal(check.json.data.state, "valid");
    });

    it("extend onto an existing profile adds a second site; replace afterwards leaves only the new one", async (t) => {
      await writeSyntheticProfile(env.home, "pty-b", fx.url("/about"));
      const other = fx.origin.replace("127.0.0.1", "localhost");
      const ext = await runOnPty(env, ["profile", "login", "--profile", "pty-b", "--url", `${other}/about`, "--mode", "extend", "--json"]);
      if (ext.json?.error?.code === "BROWSER_CRASHED") return t.skip(`headed Chromium cannot start here: ${ext.json.error.message}`);
      assert.equal(ext.exitCode, 0, ext.text.replace(ANSI, "").slice(-500));
      assert.deepEqual(ext.json.data.sites.map((s: any) => s.origin), [fx.origin, other]);
      assert.equal(mode(join(env.home, "profiles", "pty-b.json")), 0o600);
      const rep = await runOnPty(env, ["profile", "login", "--profile", "pty-b", "--url", fx.url("/about"), "--mode", "replace", "--json"]);
      assert.equal(rep.exitCode, 0, rep.text.replace(ANSI, "").slice(-500));
      assert.deepEqual(rep.json.data.sites.map((s: any) => s.origin), [fx.origin]);
      assert.equal((await env.hound(["profile", "list"])).json.data.profiles.find((p: any) => p.name === "pty-b").sites.length, 1);
    });

    it("extend without an existing profile is PROFILE_NOT_FOUND (on a TTY), and an existing profile still needs an explicit --mode", async () => {
      const missing = await runOnPty(env, ["profile", "login", "--profile", "pty-none", "--url", fx.url("/about"), "--mode", "extend", "--json"]);
      assert.equal(missing.exitCode, 1);
      assert.equal(missing.json.error.code, "PROFILE_NOT_FOUND");
      assert.ok(!existsSync(join(env.home, "profiles", "pty-none.json")));
      const noMode = await runOnPty(env, ["profile", "login", "--profile", "pty-a", "--url", fx.url("/about"), "--json"]);
      assert.equal(noMode.exitCode, 2);
      assert.equal(noMode.json.error.code, "CONFIRMATION_REQUIRED");
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 2. headed display
  // ---------------------------------------------------------------------------------------------
  describe("headed display", { ...SEQ, skip: hasDisplay ? false : NO_DISPLAY }, () => {
    let env: Env;
    let fx: Fixture;
    before(async () => {
      env = await makeEnv();
      fx = await startFixture();
    });
    after(async () => {
      await fx.close();
      await env.cleanup();
    });

    it("browser open --display headed: navigate, snapshot, list shows headed, pdf is CONFLICT (field display), close", async (t) => {
      const S = "headed";
      const open = await env.open(S, ["--display", "headed"]);
      if (open.exitCode !== 0 && open.json.error?.code === "BROWSER_CRASHED") return t.skip(`headed Chromium cannot start here: ${open.json.error.message}`);
      assert.equal(open.exitCode, 0, open.stdout);
      assert.equal(open.json.data.display, "headed");
      const nav = await env.hound(["page", "navigate", "--session-name", S, "--url", fx.url("/about")]);
      assert.equal(nav.exitCode, 0, nav.stdout);
      assert.equal(nav.json.data.title, "About");
      const snap = await env.hound(["page", "snapshot", "--session-name", S]);
      assert.match(snap.json.data.snapshot, /heading "About"/);
      assert.equal((await env.hound(["browser", "status", "--session-name", S])).json.data.display, "headed");
      const pdf = await env.hound(["page", "pdf", "--session-name", S]);
      assert.equal(pdf.exitCode, 1);
      assert.equal(pdf.json.error.code, "CONFLICT");
      assert.equal(pdf.json.error.field, "display");
      assert.equal(pdf.json.error.received, "headed");
      assert.deepEqual(pdf.json.error.allowed, ["headless"]);
      assert.equal(pdf.json.retryable, false);
      assert.match(pdf.json.suggested_fix.command, /--display headless/);
      assert.equal((await env.hound(["page", "pdf", "--session-name", S, "--output", join(env.cwd, "x.pdf")])).json.error.code, "CONFLICT");
      assert.ok(!existsSync(join(env.cwd, "x.pdf")));
      const close = await env.hound(["browser", "close", "--session-name", S]);
      assert.equal(close.json.data.closed, true);
      assert.equal((await env.hound(["browser", "list"])).json.data.count, 0);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 3. real idle timeout
  // ---------------------------------------------------------------------------------------------
  // The real wait (the 1 minute minimum) lives in tests/idle-timeout.test.ts so this file stays fast.
  describe("idle timeout bounds", SEQ, () => {
    it("the CLI declares the idle bounds (1..1440) and rejects values outside them before opening anything", async () => {
      const env = await makeEnv();
      try {
        for (const bad of ["0", "1441"]) {
          const r = await env.hound(["browser", "open", "--session-name", "idle-bad", "--idle-timeout", bad]);
          assert.equal(r.exitCode, 2, r.stdout);
          assert.equal(r.json.error.field, "idle-timeout");
        }
        assert.equal((await env.hound(["browser", "list"])).json.data.count, 0);
      } finally {
        await env.cleanup();
      }
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 4. tabs
  // ---------------------------------------------------------------------------------------------
  describe("tabs", SEQ, () => {
    let env: Env;
    let fx: Fixture;
    const S = "tabs";
    const tabs = async (...extra: string[]) => (await env.hound(["page", "tabs", "--session-name", S, ...extra])).json;
    const snap = async () => (await env.hound(["page", "snapshot", "--session-name", S])).json.data.snapshot as string;
    before(async () => {
      env = await makeEnv();
      fx = await startFixture();
      assert.equal((await env.open(S)).exitCode, 0);
    });
    after(async () => {
      await fx.close();
      await env.cleanup();
    });

    it("a target=_blank link opens a popup tab (read level); list/select switch the active tab and refs belong to their own tab", async () => {
      assert.equal((await env.hound(["page", "navigate", "--session-name", S, "--url", fx.url("/popups")])).exitCode, 0);
      const first = await snap();
      const blank = refFor(first, /link "Open about in a new tab"/);
      const sameTab = refFor(first, /link "Same tab form"/);
      const click = await env.hound(["element", "click", "--session-name", S, "--ref", blank]);
      assert.equal(click.exitCode, 0, click.stdout);
      let list = await tabs("--action", "list");
      for (let i = 0; i < 20 && list.data.count < 2; i++) {
        await sleep(100);
        list = await tabs("--action", "list");
      }
      assert.equal(list.data.count, 2, "the popup is a second tab");
      assert.equal(list.data.active, 0, "the opener stays active");
      assert.deepEqual(list.data.tabs.map((t: any) => [t.index, new URL(t.url).pathname, t.active]), [[0, "/popups", true], [1, "/about", false]]);

      const sel = await tabs("--action", "select", "--tab-index", "1");
      assert.equal(sel.data.active, 1);
      assert.equal(sel.data.tabs[1].active, true);
      assert.equal(sel.data.tabs[0].active, false);
      // Commands now act on the popup, and the refs of its own snapshot work there.
      const popup = await snap();
      assert.match(popup, /heading "About"/);
      assert.doesNotMatch(popup, /Open about in a new tab/);
      const back = await env.hound(["element", "click", "--session-name", S, "--ref", refFor(popup, /link "Back home"/)]);
      assert.equal(back.exitCode, 0, back.stdout);
      assert.equal(back.json.data.title, "Fixture Home");
      // The first tab keeps its own refs and page.
      assert.equal((await tabs("--action", "select", "--tab-index", "0")).data.active, 0);
      const go = await env.hound(["element", "click", "--session-name", S, "--ref", sameTab]);
      assert.equal(go.exitCode, 0, go.stdout);
      assert.equal(go.json.data.title, "Form");
      assert.equal((await tabs("--action", "list")).data.tabs[1].title, "Fixture Home", "the other tab was left alone");
    });

    it("closing: the active tab falls back to the tab that takes its place or the previous one; a lower close keeps the active page", async () => {
      // Tabs now: 0 Form, 1 Fixture Home. Add 2 About.
      const added = await tabs("--action", "new", "--url", fx.url("/about"));
      assert.equal(added.data.count, 3);
      assert.equal(added.data.active, 2, "a new tab becomes active");
      assert.match(await snap(), /heading "About"/);
      // Close the active last tab: the previous one takes over.
      let r = await tabs("--action", "close", "--tab-index", "2");
      assert.equal(r.data.count, 2);
      assert.equal(r.data.active, 1);
      assert.equal(r.data.tabs[1].title, "Fixture Home");
      assert.match(await snap(), /heading "Fixture Home"/, "commands follow the new active tab");
      // Close the active middle tab of three: the tab that slides into its index becomes active.
      assert.equal((await tabs("--action", "new", "--url", fx.url("/about"))).data.count, 3); // 0 Form, 1 Home, 2 About (active)
      assert.equal((await tabs("--action", "select", "--tab-index", "1")).data.active, 1);
      r = await tabs("--action", "close", "--tab-index", "1");
      assert.deepEqual(r.data.tabs.map((t: any) => t.title), ["Form", "About"]);
      assert.equal(r.data.active, 1);
      assert.equal(r.data.tabs[1].active, true);
      // Closing a lower, inactive tab keeps the same page active (its index shifts down).
      r = await tabs("--action", "close", "--tab-index", "0");
      assert.equal(r.data.count, 1);
      assert.equal(r.data.active, 0);
      assert.equal(r.data.tabs[0].title, "About");
      // Closing an inactive tab keeps the active one.
      await tabs("--action", "new", "--url", fx.url("/form")); // 0 About, 1 Form (active)
      await tabs("--action", "select", "--tab-index", "0");
      r = await tabs("--action", "close", "--tab-index", "1");
      assert.equal(r.data.active, 0);
      assert.equal(r.data.tabs[0].title, "About");
    });

    it("the last tab cannot be closed and a bad index is INVALID_ARGUMENT (field tab-index)", async () => {
      const last = await tabs("--action", "close", "--tab-index", "0");
      assert.equal(last.ok, false);
      assert.equal(last.error.code, "INVALID_ARGUMENT");
      assert.equal((await tabs("--action", "list")).data.count, 1);
      for (const action of ["select", "close"]) {
        await tabs("--action", "new", "--url", fx.url("/about"));
        const bad = await tabs("--action", action, "--tab-index", "9");
        assert.equal(bad.error.code, "INVALID_ARGUMENT", action);
        assert.equal(bad.error.field, "tab-index");
        assert.equal(bad.error.received, 9);
        await tabs("--action", "close", "--tab-index", "1");
      }
      assert.equal((await tabs("--action", "list")).data.count, 1);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5. task component
  // ---------------------------------------------------------------------------------------------
  describe("task component", SEQ, () => {
    let env: Env;
    let fx: Fixture;
    before(async () => {
      env = await makeEnv();
      fx = await startFixture();
    });
    after(async () => {
      await fx.close();
      await env.cleanup();
    });
    const pngWidth = (file: string): number => readFileSync(file).readUInt32BE(16);

    it("captures a selector at two viewports with a hover state: files exist, 0600 (dirs 0700), styles json and hover diff present", async () => {
      const r = await env.hound(["task", "run", "--task", "component", "--url", fx.url("/comp"), "--arg", "selector=.cta", "--arg", "viewports=375,1280", "--arg", "states=hover"], { timeoutMs: 120_000 });
      assert.equal(r.exitCode, 0, r.stdout);
      const d = r.json.data;
      assert.equal(d.status, "pass");
      assert.deepEqual(d.data.viewports, [375, 1280]);
      assert.deepEqual(d.data.states, ["hover"]);
      assert.deepEqual(Object.keys(d.data.files).sort(), ["1280", "375"]);
      for (const width of ["375", "1280"]) {
        assert.deepEqual(
          d.data.files[width].map((f: string) => f.slice(width.length + 1)),
          ["page.png", "element.png", "element.html", "styles.json", "assets.json", "element.hover.png", "styles.hover.json"],
        );
        for (const rel of d.data.files[width] as string[]) {
          const abs = join(d.runDir, rel);
          assert.ok(existsSync(abs), abs);
          assert.equal(mode(abs), 0o600, rel);
          assert.ok(statSync(abs).size > 0, rel);
        }
        assert.equal(mode(join(d.runDir, width)), 0o700);
      }
      assert.ok(d.files.every((f: string) => f.startsWith(d.runDir)), "data.files lists absolute paths in the run dir");
      assert.ok(d.files.map((f: string) => f.slice(d.runDir.length + 1)).includes("result.json"));
      assert.equal(mode(d.resultFile), 0o600);
      assert.equal(mode(d.runDir), 0o700);
      assert.ok(pngWidth(join(d.runDir, "375/page.png")) < pngWidth(join(d.runDir, "1280/page.png")), "each viewport has its own width");
      const styles = JSON.parse(readFileSync(join(d.runDir, "375/styles.json"), "utf8"));
      assert.ok(JSON.stringify(styles).includes("a.cta") || JSON.stringify(styles).includes("cta"), "the component's nodes are described");
      const html = readFileSync(join(d.runDir, "375/element.html"), "utf8");
      assert.match(html, /Buy now/);
      const hover = JSON.parse(readFileSync(join(d.runDir, "375/styles.hover.json"), "utf8"));
      assert.equal(hover.state, "hover");
      const change = hover.changes.find((c: any) => c.selector === "a.cta");
      assert.equal(change.changed["background-color"].from, "rgb(238, 238, 255)");
      assert.equal(change.changed["background-color"].to, "rgb(255, 204, 0)");
      assert.doesNotMatch(readFileSync(d.resultFile, "utf8"), /COOKIE-SECRET/);
    });

    it("bad arguments fail as RUN_ERROR with the reason in data, not a crash: missing selector, unknown state, selector that matches nothing", async () => {
      for (const [extra, re] of [
        [[], /selector/i],
        [["--arg", "selector=.cta", "--arg", "states=active"], /Invalid state/],
        [["--arg", "selector=.nope-nothing", "--arg", "viewports=500"], /./],
      ] as const) {
        const r = await env.hound(["task", "run", "--task", "component", "--url", fx.url("/comp"), ...extra, "--timeout", "20"], { timeoutMs: 60_000 });
        assert.equal(r.exitCode, 1, r.stdout);
        assert.equal(r.json.error.code, "RUN_ERROR");
        assert.match(JSON.stringify(r.json.data.error ?? r.json.data.summary), re);
        assert.equal(mode(r.json.data.resultFile), 0o600);
      }
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 6. deprecated mcp
  // ---------------------------------------------------------------------------------------------
  describe("hound mcp (deprecated)", SEQ, () => {
    let env: Env;
    before(async () => {
      env = await makeEnv();
    });
    after(async () => {
      await env.cleanup();
    });

    it("starts, warns on stderr, answers an MCP initialize on stdout (only JSON-RPC there) and exits 0 when stdin closes", async () => {
      const child = spawn(HOUND_BIN, ["mcp"], { cwd: env.cwd, env: { ...process.env, HOUND_HOME: env.home, NO_COLOR: "1" }, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (c: string) => (stdout += c));
      child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c));
      const exited = new Promise<number | null>((res) => child.on("close", (code) => res(code)));
      const guard = setTimeout(() => child.kill("SIGKILL"), 25_000);
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "gap-test", version: "0" } } })}\n`);
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline && !stdout.includes("\n")) await sleep(50);
        const first = JSON.parse(stdout.split("\n")[0]!);
        assert.equal(first.jsonrpc, "2.0");
        assert.equal(first.id, 1);
        assert.ok(first.result.serverInfo.name, "serverInfo present");
        assert.ok(first.result.capabilities);
        assert.match(stderr, /deprecated: "hound mcp"/);
        child.stdin.end();
        assert.equal(await exited, 0, stderr.slice(-300));
        for (const line of stdout.split("\n").filter(Boolean)) assert.equal(JSON.parse(line).jsonrpc, "2.0", "stdout carries protocol messages only");
      } finally {
        clearTimeout(guard);
        child.kill("SIGKILL");
      }
    });

    it("an unknown profile fails on stderr with exit 1 and nothing on stdout", async () => {
      const r = await env.raw(["mcp", "--profile", "ghost"]);
      assert.equal(r.exitCode, 1);
      assert.equal(r.stdout, "");
      assert.match(r.stderr, /deprecated/);
      assert.match(r.stderr, /Profile "ghost" not found/);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 7. snapshot --ref keeps other refs valid
  // ---------------------------------------------------------------------------------------------
  describe("snapshot --ref does not invalidate refs outside the subtree", SEQ, () => {
    let env: Env;
    let fx: Fixture;
    const S = "subref";
    const snap = async (...extra: string[]) => env.hound(["page", "snapshot", "--session-name", S, ...extra]);
    before(async () => {
      env = await makeEnv();
      fx = await startFixture();
      assert.equal((await env.open(S)).exitCode, 0);
      assert.equal((await env.hound(["page", "navigate", "--session-name", S, "--url", fx.url("/diffy")])).exitCode, 0);
    });
    after(async () => {
      await fx.close();
      await env.cleanup();
    });

    it("refs of the earlier full snapshot (nav links, footer, siblings) still work after a scoped snapshot", async () => {
      const full = (await snap()).json.data.snapshot as string;
      const main = refFor(full, /main "Work area"/);
      const about = refFor(full, /link "About page"/);
      const footer = refFor(full, /paragraph.*Footer text/);
      const rename = refFor(full, /button "Rename"/);
      const sub = await snap("--ref", main);
      assert.equal(sub.exitCode, 0, sub.stdout);
      const text = sub.json.data.snapshot as string;
      assert.match(text, /^- main "Work area"/);
      assert.doesNotMatch(text, /About page|Footer text/);
      for (const [ref, what] of [[about, "outside, before"], [footer, "outside, after"], [rename, "inside"], [main, "the root itself"]] as const) {
        const r = await env.hound(["element", "read", "--session-name", S, "--ref", ref]);
        assert.equal(r.exitCode, 0, `${what}: ${r.stdout}`);
      }
      assert.match((await env.hound(["element", "read", "--session-name", S, "--ref", footer])).json.data.text, /Footer text/);
      // And the refs printed by the scoped snapshot are the full snapshot's.
      assert.equal(refFor(text, /button "Rename"/), rename);
    });

    it("a nested ref, --depth relative to the element, and repeated scoped snapshots all keep every ref valid", async () => {
      const full = (await snap()).json.data.snapshot as string;
      const list = refFor(full, /list \[ref=/);
      const about = refFor(full, /link "About page"/);
      const nested = (await snap("--ref", list)).json.data.snapshot as string;
      assert.match(nested, /^- list/);
      assert.match(nested, /Order one/);
      assert.doesNotMatch(nested, /Rename|Orders/);
      const main = refFor(full, /main "Work area"/);
      const shallow = (await snap("--ref", main, "--depth", "1")).json.data.snapshot as string;
      assert.match(shallow, /^- main "Work area"/);
      assert.match(shallow, /button "Add order"/);
      assert.match(shallow, /- list \[ref=e\d+\]$/m, "a collapsed parent has no trailing colon");
      assert.doesNotMatch(shallow, /Order one/, "depth 1 stops at the element's children");
      const deep = (await snap("--ref", main, "--depth", "2")).json.data.snapshot as string;
      assert.match(deep, /Order one/);
      const r = await env.hound(["element", "hover", "--session-name", S, "--ref", about]);
      assert.equal(r.exitCode, 0, r.stdout);
    });

    it("a stale or unknown ref is still REF_NOT_FOUND", async () => {
      const r = await snap("--ref", "e9999");
      assert.equal(r.exitCode, 1);
      assert.equal(r.json.error.code, "REF_NOT_FOUND");
    });
  });

  describe("snapshotSubtree (unit)", SEQ, () => {
    const text = [
      "- generic [ref=e1]:",
      "  - navigation [ref=e2]:",
      "    - link \"A\" [ref=e3] [cursor=pointer]:",
      "      - /url: /a",
      "  - main [ref=e10]:",
      "    - list [ref=e11]:",
      "      - listitem [ref=e12]: One",
      "    - button \"Go\" [ref=e13]",
      "  - paragraph [ref=e14]: Foot",
    ].join("\n");

    it("cuts the block of a ref and dedents it; a ref is matched whole (e1 is not e10)", () => {
      assert.equal(snapshotSubtree(text, "e10"), ["- main [ref=e10]:", "  - list [ref=e11]:", "    - listitem [ref=e12]: One", "  - button \"Go\" [ref=e13]"].join("\n"));
      assert.equal(snapshotSubtree(text, "e13"), "- button \"Go\" [ref=e13]");
      assert.equal(snapshotSubtree(text, "e14"), "- paragraph [ref=e14]: Foot");
      assert.equal(snapshotSubtree(text, "e1")?.split("\n").length, 9);
      assert.equal(snapshotSubtree(text, "e999"), undefined);
      assert.equal(snapshotSubtree(text, "e"), undefined);
    });

    it("depth keeps that many levels, property lines ride with their parent, emptied parents lose the colon", () => {
      assert.equal(snapshotSubtree(text, "e2", 1), "- navigation [ref=e2]:\n  - link \"A\" [ref=e3] [cursor=pointer]:\n    - /url: /a");
      assert.equal(snapshotSubtree(text, "e2", 1)?.includes("/url"), true);
      assert.equal(snapshotSubtree(text, "e10", 1), "- main [ref=e10]:\n  - list [ref=e11]\n  - button \"Go\" [ref=e13]");
      assert.equal(snapshotSubtree(text, "e10", 0), snapshotSubtree(text, "e10"), "depth 0 means unlimited, as for a full snapshot");
    });
  });
});

after(() => {
  rmSync(CORE_HOME, { recursive: true, force: true });
});
