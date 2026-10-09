/**
 * The browser-session daemon. One detached process per session: one Chromium, one context (the
 * profile loaded in memory), its pages, and a unix socket speaking newline-delimited JSON
 * (`{ id, op, params }` -> `{ id, ok, result | error }`). Page/element ops run strictly one at a time;
 * `ping` and `status` are answered out of band from in-memory facts and do not reset the idle timer.
 *
 * Logging rule: daemon.log gets op names, durations and error codes only. Never URLs, page text,
 * console text, cookies or headers.
 */
import { chmod, link, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import type { BrowserContext, CDPSession, Dialog, Download, FileChooser, Locator, Page, Request } from "playwright";
import { isMissingBrowser, missingBrowserError, openSession, type Session } from "../browser.ts";
import { HoundError, isHoundError } from "../errors.ts";
import { ensurePrivateDir } from "../paths.ts";
import { redactText, stripUrl } from "../redact.ts";
import { cleanTrace } from "../trace.ts";
import { blockedCategory } from "./block.ts";
import { DOWNLOAD_FALLBACK_NAME, isBinaryType, mediaType, numberedName, redactBody, sanitizeFilename } from "./bodies.ts";
import {
  CONFIG_FILE,
  STARTUP_ERROR_FILE,
  STATE_FILE,
  assertIdleTimeout,
  assertViewport,
  chooseSocketPath,
  isStateChanging,
  readJson,
  removeSessionDir,
  sessionRunsDir,
  writePrivateJson,
} from "./state.ts";
import {
  CLICK_MODIFIERS,
  REQUEST_METHODS,
  WAIT_FOR,
  type BrowserOp,
  type BrowserOpResult,
  type BrowserSessionInfo,
  type ClickModifier,
  type ColorScheme,
  type ConsoleEntry,
  type DaemonConfig,
  type DaemonState,
  type DialogAction,
  type DialogEntry,
  type MediaType,
  type NetworkEntry,
  type ReducedMotion,
  type TabInfo,
  type WaitUntil,
  type WireRequest,
  type WireResponse,
} from "./types.ts";
import {
  ATTR_NAME_PATTERN,
  DIALOG_BUFFER_CAP,
  DIALOG_GRACE_MS,
  DIALOG_TEXT_MAX_CHARS,
  DRAG_METHODS,
  DRAG_SETTLE_MS,
  DRAG_STEPS_DEFAULT,
  DRAG_STEPS_MAX,
  DRAG_STEPS_MIN,
  FIND_CONTEXT_MAX,
  FIND_LIMIT_DEFAULT,
  FIND_LIMIT_MAX,
  FIND_PATTERN_MAX_CHARS,
  FIND_REGEX_BUDGET_MS,
  FIND_SNAPSHOT_MAX_CHARS,
  MAX_OP_TIMEOUT_MS,
  PDF_FORMATS,
  READ_LIMIT_DEFAULT,
  READ_LIMIT_MAX,
  READ_SCAN_MAX_CHARS,
  RECORD_DESCRIBE_MS,
  REQUEST_BUFFER_CAP,
  SNAPSHOT_BASELINES_PER_TAB,
  SNAPSHOT_BASELINE_MAX_CHARS,
  SNAPSHOT_DIFF_CONTEXT,
  TYPE_MAX_CHARS,
  UPLOAD_MAX_FILES,
  typingFits,
  typingTimeoutMs,
  type BlockCategory,
} from "./limits.ts";
import { matchRegex, matchSubstring, matchText, parseRegexArg, parseRequestValue } from "./find.ts";
import { PASSWORD_SAFE_ATTRS, SENSITIVE_HINT, passwordBlocked, redactAttr, redactFindLines, redactReadText, sanitizeSnapshot, type ReadFacts } from "./read.ts";
import { outputError, placeFile, writeOutputSafe } from "./output.ts";
import { sideEffectLinkReason } from "./sideeffect.ts";
import { ActionLog, describeTarget, isRecorded, type OpNotes } from "./recorder.ts";
import { diffSnapshots, snapshotSubtree } from "./snapdiff.ts";
import { resolveUploadFiles } from "./upload.ts";

const ACTION_TIMEOUT_MS = 10_000;
const NAV_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
/** Largest body the `request` op reads or processes; a known larger one is reported, not read. */
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const WAIT_TIMEOUT_MS = 10_000;
const CONSOLE_CAP = 200;
const NETWORK_FAILED_CAP = 200;
const NETWORK_ALL_CAP = 500;
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const WAIT_UNTIL: readonly WaitUntil[] = ["load", "domcontentloaded", "networkidle"];
const TRACE_OPTIONS = { screenshots: false, snapshots: true, sources: false } as const;

type Params = Record<string, unknown>;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Ops that accept a per-op dialog policy (`dialog`, `dialogText`): they can trigger alert/confirm/prompt/beforeunload. */
const DIALOG_OPS: ReadonlySet<BrowserOp> = new Set<BrowserOp>(["click", "press", "select", "type", "download", "upload", "drag", "check", "navigate", "back", "forward", "reload"]);
const log = (msg: string) => process.stderr.write(`${new Date().toISOString()} ${msg}\n`);
const now = () => new Date().toISOString();
let fileSeq = 0;
const stamp = () => `${new Date().toISOString().replace(/[:.]/g, "-")}-${++fileSeq}`;
/** Page-controlled strings are clamped before they leave the daemon. */
const MAX_TITLE = 200;
const MAX_URL = 2000;
const clamp = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const cleanUrl = (url: string) => clamp(url === "about:blank" ? url : stripUrl(url), MAX_URL);
const cleanTitle = (title: string) => clamp(title, MAX_TITLE);
const firstLine = (err: unknown) => (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "";

function push<T>(ring: T[], item: T, cap: number): void {
  ring.push(item);
  if (ring.length > cap) ring.splice(0, ring.length - cap);
}

// ---- param validation (field names are the CLI flag names) ----

function optStr(p: Params, key: string, field: string): string | undefined {
  const v = p[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new HoundError("INVALID_ARGUMENT", `--${field} must be a string.`, { field, received: typeof v });
  return v;
}
function reqStr(p: Params, key: string, field: string): string {
  const v = optStr(p, key, field);
  if (v === undefined || v === "") throw new HoundError("MISSING_REQUIRED_FLAG", `--${field} is required.`, { field });
  return v;
}
function optInt(p: Params, key: string, field: string, min: number, max: number): number | undefined {
  const v = p[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw new HoundError("INVALID_ARGUMENT", `--${field} must be an integer from ${min} to ${max}.`, { field, received: v });
  }
  return v;
}
function optEnum<T extends string>(p: Params, key: string, field: string, allowed: readonly T[]): T | undefined {
  const v = p[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !allowed.includes(v as T)) {
    throw new HoundError("INVALID_ENUM", `Invalid --${field} "${String(v)}".`, { field, received: v, allowed });
  }
  return v as T;
}
function reqEnum<T extends string>(p: Params, key: string, field: string, allowed: readonly T[]): T {
  const v = optEnum(p, key, field, allowed);
  if (v === undefined) throw new HoundError("MISSING_REQUIRED_FLAG", `--${field} is required.`, { field, allowed });
  return v;
}
const REF_HINT = "a ref from the latest page snapshot (e.g. e12 or f3e4)";
const formatSeconds = (ms: number) => `${Math.round(ms / 100) / 10}s`;

/** Time kept back from the client's deadline so the daemon can still send its own TIMEOUT reply. */
const DEADLINE_RESERVE_MS = 300;
/** Client deadline (epoch ms) of the op being run; ops run one at a time, so a module variable is enough. */
let currentDeadline: number | undefined;
const remainingMs = () => (currentDeadline === undefined ? Number.POSITIVE_INFINITY : currentDeadline - DEADLINE_RESERVE_MS - Date.now());
/** An internal wait (settle, post-click load) bounded by what is left of the client's deadline. */
const capWait = (ms: number) => Math.max(1, Math.min(ms, remainingMs()));

/** Default timeout per op, used only to word the TIMEOUT message. */
const OP_DEFAULT_TIMEOUT: Partial<Record<BrowserOp, number>> = {
  navigate: NAV_TIMEOUT_MS, snapshot: NAV_TIMEOUT_MS, screenshot: NAV_TIMEOUT_MS, wait: WAIT_TIMEOUT_MS,
  back: NAV_TIMEOUT_MS, forward: NAV_TIMEOUT_MS, reload: NAV_TIMEOUT_MS, tabs: NAV_TIMEOUT_MS,
  click: ACTION_TIMEOUT_MS, hover: ACTION_TIMEOUT_MS, fill: ACTION_TIMEOUT_MS, select: ACTION_TIMEOUT_MS, press: ACTION_TIMEOUT_MS,
  type: ACTION_TIMEOUT_MS, upload: ACTION_TIMEOUT_MS, download: DOWNLOAD_TIMEOUT_MS, request: NAV_TIMEOUT_MS,
  drag: ACTION_TIMEOUT_MS, find: NAV_TIMEOUT_MS, read: ACTION_TIMEOUT_MS, check: ACTION_TIMEOUT_MS, pdf: NAV_TIMEOUT_MS,
};

/**
 * TIMEOUT error saying what was waited for. Quotes the timeout the caller asked for (not the clipped
 * one) and only echoes values the caller supplied (never page content). State-changing ops are not
 * retryable: the click/navigation may have landed after the client gave up.
 */
function timeoutError(op: BrowserOp, p: Params, snapshotCmd?: string): HoundError {
  const ms = typeof p.timeoutMs === "number" && p.timeoutMs > 0 ? p.timeoutMs : (OP_DEFAULT_TIMEOUT[op] ?? ACTION_TIMEOUT_MS);
  const str = (k: string) => (typeof p[k] === "string" ? redactText(p[k] as string, 200) : undefined);
  const ref = str("ref");
  let what: string;
  let field = "timeout";
  let received: unknown = Math.round(ms / 1000);
  if (op === "navigate" && typeof p.url === "string") {
    const url = stripUrl(p.url);
    what = `"${url}" to load`;
    [field, received] = ["url", url];
  } else if (ref && ["click", "hover", "fill", "select", "press", "type", "upload", "download", "drag", "read", "check"].includes(op)) {
    what = `element "${ref}" to be actionable for ${op}`;
    [field, received] = ["ref", ref];
  } else if (op === "press" && str("key")) {
    what = `the key press "${str("key")}" to complete`;
    [field, received] = ["key", str("key")];
  } else if (op === "back" || op === "forward" || op === "reload") {
    what = `${op} navigation to finish`;
  } else {
    what = `"${op}" to complete`;
  }
  if (isStateChanging(op, p)) {
    return new HoundError("TIMEOUT", `Timed out after ${formatSeconds(ms)} waiting for ${what}; it may still have been applied; run page snapshot before retrying.`, {
      field,
      received,
      retryable: false,
      ...(snapshotCmd ? { suggestedFix: snapshotCmd } : {}),
    });
  }
  return new HoundError("TIMEOUT", `Timed out after ${formatSeconds(ms)} waiting for ${what}. Retry, or raise --timeout.`, { field, received, retryable: true });
}

/** The op's own timeout: the requested one (or the default), never past the client's deadline. */
const timeoutOf = (p: Params, def: number) => capWait(optInt(p, "timeoutMs", "timeout", 1, 600_000) ?? def);

/** `**` matches anything, `*` anything but "/"; everything else is literal. Anchored. */
function globToRegExp(glob: string): RegExp {
  const parts = glob.split("**").map((chunk) => chunk.split("*").map((t) => t.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*"));
  return new RegExp(`^${parts.join(".*")}$`);
}

function checkNavUrl(url: string): void {
  if (url === "about:blank") return;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new HoundError("INVALID_ARGUMENT", "--url is not a valid absolute URL.", { field: "url", received: redactText(url, 200) });
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new HoundError("INVALID_ARGUMENT", "--url must be http(s) or about:blank.", { field: "url", received: u.protocol, allowed: ["http:", "https:"] });
  }
}

/**
 * Read-level click policy, step 1: decided in the page (serialized: no outside references). `block` is null when the element
 * may be clicked, else a short reason. For an allowed link it also returns the resolved URL and the link's accessible texts,
 * which `clickBlockReason` checks for side effects (step 2, outside the page).
 *
 * Allowed, and nothing else: (a) an `<a>` with an href whose resolved protocol (`new URL(el.href)`,
 * which also sees through `java\tscript:` tricks) is http: or https: and that is not a same-document
 * fragment link (`#...`, or the current URL with only the hash changed); (b) `<summary>`. Anything
 * inside a form or a button is blocked, as are role=link/tab/menuitem non-anchors, buttons and form controls.
 */
function clickProbe(el: Element): { block: string | null; href?: string; labels?: string[] } {
  const only = "only http(s) links and <summary> can be clicked with --actions read";
  if (el.closest("form")) return { block: "the element is inside a form" };
  if (el.closest("button, [role=button]")) return { block: "the element is a button or inside one" };
  const tag = el.tagName.toLowerCase();
  if (tag === "summary") return { block: null };
  if (!(el instanceof HTMLAnchorElement) || !el.hasAttribute("href")) return { block: `the element is a <${tag}>; ${only}` };
  const raw = (el.getAttribute("href") ?? "").trim();
  let url: URL;
  try {
    url = new URL(el.href);
  } catch {
    return { block: "the link's URL is not valid" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { block: `the link uses ${url.protocol} instead of http(s)` };
  if (raw.startsWith("#")) return { block: "the link only jumps within the page" };
  const here = new URL(location.href);
  if (url.hash !== "" && url.href.split("#")[0] === here.href.split("#")[0]) return { block: "the link only jumps within the page" };
  // Rails UJS / Turbo / Laravel links that send a non-GET request: <a data-method="delete" href="/posts/1">.
  const verb = ["data-method", "data-turbo-method", "data-http-method"].map((a) => (el.getAttribute(a) ?? "").trim().toLowerCase()).find((v) => v !== "");
  if (verb !== undefined && verb !== "get") {
    return { block: "the link looks like a side-effect link (it sends a non-GET request through data-method): following it could change data, so it needs --actions interact" };
  }
  const labels = [el.getAttribute("aria-label"), el.getAttribute("title"), el.innerText, el.querySelector("img[alt]")?.getAttribute("alt")]
    .filter((t): t is string => typeof t === "string" && t.trim() !== "")
    .map((t) => t.slice(0, 200));
  return { block: null, href: url.href, labels };
}

/**
 * Read-level click policy for `click` and `download`: null when allowed, else a short reason. Step 1 (`clickProbe`, in the
 * page) lets through only http(s) links and `<summary>`; step 2 (`sideEffectLinkReason`) refuses links whose URL path, query
 * or label looks like logout/delete/unsubscribe/... (a GET with side effects).
 *
 * Remaining limits (by design, documented): a side-effect link with an innocent URL and label, a redirect, and a JS click
 * handler attached to a real link cannot be detected; elements in shadow DOM are checked against their light-DOM ancestors
 * only. `read` reduces accidental writes; it is not a sandbox.
 */
async function clickBlockReason(loc: Locator): Promise<string | null> {
  const probe = await loc.evaluate(clickProbe);
  if (probe.block) return probe.block;
  return probe.href ? sideEffectLinkReason(probe.href, probe.labels ?? []) : null;
}

/** Set once the browser is up / once the daemon is serving; used by failDaemon. */
let liveSession: Session | undefined;
let serving = false;

/**
 * Last-resort handler for an error escaping runDaemon: closes the browser, records the error for
 * the waiting client during startup (startup-error.json) or removes the session dir afterwards.
 */
export async function failDaemon(dir: string, err: unknown): Promise<never> {
  log(`fatal: ${isHoundError(err) ? err.code : "INTERNAL_ERROR"}`);
  await liveSession?.close().catch(() => {});
  if (serving) await removeSessionDir(dir).catch(() => {});
  else {
    const herr = isHoundError(err) ? err : new HoundError("BROWSER_CRASHED", `The browser session failed to start: ${redactText(firstLine(err), 200)}`);
    await writePrivateJson(join(dir, STARTUP_ERROR_FILE), herr.toJSON()).catch(() => {});
  }
  process.exit(1);
}

export async function runDaemon(dir: string): Promise<void> {
  const loaded = await readJson<DaemonConfig>(join(dir, CONFIG_FILE));
  if (!loaded) {
    log("startup error: missing config");
    process.exit(1);
  }
  const config: DaemonConfig = loaded;
  const { name } = config;
  try {
    assertIdleTimeout(config.idleTimeoutMinutes);
  } catch (err) {
    log("startup error: invalid config");
    await writePrivateJson(join(dir, STARTUP_ERROR_FILE), (err as HoundError).toJSON());
    process.exit(1);
  }
  const startedAt = now();

  let session: Session;
  try {
    session = await openSession({
      profile: config.profile,
      headless: config.display === "headless",
      downloadsPath: join(dir, "pw-downloads"),
      ...(config.viewport ? { viewport: config.viewport } : {}),
      ...(config.deviceScaleFactor ? { deviceScaleFactor: config.deviceScaleFactor } : {}),
      ...(config.mobile ? { mobile: true } : {}),
      ...(config.locale ? { locale: config.locale } : {}),
      ...(config.timezone ? { timezoneId: config.timezone } : {}),
      ...(config.geolocation ? { geolocation: config.geolocation } : {}),
      // A service worker's own requests bypass context routes, so --block could not see them.
      ...(config.block?.length ? { blockServiceWorkers: true } : {}),
    });
  } catch (err) {
    const msg = firstLine(err);
    const herr = isHoundError(err)
      ? err
      : isMissingBrowser(msg)
        ? missingBrowserError()
        : new HoundError("BROWSER_CRASHED", `Could not launch the browser: ${redactText(msg, 200)}`, {
        });
    log(`startup error: ${herr.code}`);
    await writePrivateJson(join(dir, STARTUP_ERROR_FILE), herr.toJSON());
    process.exit(1);
  }
  liveSession = session;
  const { browser, context } = session;
  context.setDefaultTimeout(ACTION_TIMEOUT_MS);
  context.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
  if (config.trace === "on") await context.tracing.start(TRACE_OPTIONS);

  // ---- diagnostics (redacted, capped; never headers, cookies or bodies) ----
  const consoleRing: ConsoleEntry[] = [];
  const failedRing: NetworkEntry[] = [];
  const allRing: NetworkEntry[] = [];
  /** Playwright Request objects by `network` index, oldest first; at most REQUEST_BUFFER_CAP are kept (older ones are evicted). */
  const requestBuffer = new Map<number, Request>();
  let requestSeq = 0;
  /** `requestSeq` when the last state-changing op started: the default mark of `wait --for request`. */
  let requestMark = 0;
  const remember = (req: Request): number => {
    const index = ++requestSeq;
    requestBuffer.set(index, req);
    if (requestBuffer.size > REQUEST_BUFFER_CAP) requestBuffer.delete(requestBuffer.keys().next().value as number);
    return index;
  };
  // ---- --block: refused requests (a context-level route exists only when something is blocked) ----
  const blockList: readonly BlockCategory[] = config.block ?? [];
  const blockedRequests = new WeakMap<Request, BlockCategory>();
  if (blockList.length > 0) {
    await context.route("**/*", (route) => {
      const req = route.request();
      const category = blockedCategory(req.url(), req.resourceType(), blockList);
      if (!category) return route.fallback().catch(() => {});
      blockedRequests.set(req, category);
      return route.abort("blockedbyclient").catch(() => {});
    });
  }
  // ---- JavaScript dialogs: one context-level handler covers every tab (popups included), so none can ever hang a page ----
  const dialogDefault: DialogAction = config.dialog === "accept" && config.actions === "interact" ? "accept" : "dismiss";
  const dialogRing: DialogEntry[] = [];
  type DialogPolicy = { action: DialogAction; text?: string };
  /** Set only while an op runs (ops are serial): the op's explicit dialog override (if any), and the dialogs it handled. */
  let opPolicy: DialogPolicy | undefined;
  let opDialogs: DialogEntry[] | undefined;
  /** The running op navigates away (navigate/back/forward/reload/tab close): a beforeunload dialog is then always accepted. */
  let opLeaves = false;
  /** The last op's explicit override stays in force for a short while after it returns, for dialogs raised by timers or requests it started. */
  let graceOp: { op: string; policy: DialogPolicy; until: number } | undefined;
  context.on("dialog", (d: Dialog) => {
    const leaving = d.type() === "beforeunload" && opLeaves;
    const late = !opPolicy && !leaving && graceOp && Date.now() < graceOp.until ? graceOp : undefined;
    const policy: DialogPolicy = leaving ? { action: "accept" } : (opPolicy ?? late?.policy ?? { action: dialogDefault });
    const entry: DialogEntry = {
      time: now(),
      type: d.type() as DialogEntry["type"],
      message: redactText(d.message(), 300),
      action: policy.action,
      ...(late ? { op: late.op } : {}),
    };
    push(dialogRing, entry, DIALOG_BUFFER_CAP);
    if (opDialogs && opDialogs.length < DIALOG_BUFFER_CAP) opDialogs.push(entry);
    // Without an answer text a prompt is accepted with its own default value (Playwright would send an empty string).
    const handled = policy.action === "accept" ? d.accept(d.type() === "prompt" ? (policy.text ?? d.defaultValue()) : undefined) : d.dismiss();
    handled.catch(() => {});
  });
  context.on("console", (m) => {
    const type = m.type();
    if (type !== "error" && type !== "warning") return;
    const loc = m.location().url;
    push(consoleRing, { time: now(), level: type, source: "console", text: redactText(m.text(), 300), ...(loc ? { location: cleanUrl(loc) } : {}) }, CONSOLE_CAP);
  });
  context.on("weberror", (e) => push(consoleRing, { time: now(), level: "error", source: "pageerror", text: redactText(firstLine(e.error()), 300) }, CONSOLE_CAP));
  context.on("requestfailed", (r) => {
    const category = blockedRequests.get(r);
    const entry: NetworkEntry = {
      index: remember(r),
      time: now(),
      method: r.method(),
      url: cleanUrl(r.url()),
      resourceType: r.resourceType(),
      failure: category ? "blocked" : redactText(r.failure()?.errorText ?? "failed", 100),
      ...(category ? { blocked: category } : {}),
    };
    // A request refused on purpose by --block is not a failure of the page: it is listed with `state all` only.
    if (!category) push(failedRing, entry, NETWORK_FAILED_CAP);
    push(allRing, entry, NETWORK_ALL_CAP);
  });
  context.on("response", (r) => {
    const req = r.request();
    const entry: NetworkEntry = { index: remember(req), time: now(), method: req.method(), url: cleanUrl(r.url()), status: r.status(), resourceType: req.resourceType() };
    if (r.status() >= 400) push(failedRing, entry, NETWORK_FAILED_CAP);
    push(allRing, entry, NETWORK_ALL_CAP);
  });

  // ---- media emulation (page emulate): kept for the session and applied to every tab opened later ----
  type Emulation = { colorScheme?: ColorScheme; media?: MediaType; reducedMotion?: ReducedMotion };
  let emulation: Emulation = {};
  const applyEmulation = async (pg: Page): Promise<void> => {
    if (Object.keys(emulation).length > 0) await pg.emulateMedia(emulation).catch(() => {});
  };
  context.on("page", (pg) => void applyEmulation(pg));

  let active: Page = await context.newPage();
  async function page(): Promise<Page> {
    if (!active.isClosed()) return active;
    const pages = context.pages();
    active = pages[pages.length - 1] ?? (await context.newPage());
    return active;
  }

  // ---- socket + state ----
  const socketPath = await chooseSocketPath(dir);
  await rm(socketPath, { force: true });
  let shuttingDown = false;
  let pending = 0;
  let idleTimer: NodeJS.Timeout | undefined;
  const idleMs = Math.min(Math.max(1000, Math.round(config.idleTimeoutMinutes * 60_000)), 2 ** 31 - 1);
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = pending === 0 ? setTimeout(() => void shutdown(0, "idle timeout"), idleMs) : undefined;
  };

  async function shutdown(code: number, why: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    if (idleTimer) clearTimeout(idleTimer);
    log(`shutdown: ${why}`);
    server.close();
    const force = setTimeout(() => process.exit(code), 15_000);
    await session.close().catch(() => {});
    // A hung daemon whose dir was cleaned and re-claimed must not delete its successor's state.
    const current = await readJson<DaemonState>(join(dir, STATE_FILE));
    if (!current || current.pid === process.pid) await removeSessionDir(dir).catch(() => {});
    clearTimeout(force);
    process.exit(code);
  }

  const state: DaemonState = { ...config, pid: process.pid, startedAt, socket: socketPath };
  const info = async (): Promise<BrowserSessionInfo> => {
    const p = active.isClosed() ? undefined : active;
    const viewport = p?.viewportSize() ?? config.viewport;
    return {
      name,
      pid: process.pid,
      ...(config.profile ? { profile: config.profile } : {}),
      actions: config.actions,
      display: config.display,
      dialog: dialogDefault,
      trace: config.trace,
      startedAt,
      idleTimeoutMinutes: config.idleTimeoutMinutes,
      alive: browser.isConnected(),
      ...(viewport ? { viewport } : {}),
      ...(config.deviceScaleFactor ? { deviceScaleFactor: config.deviceScaleFactor } : {}),
      ...(config.mobile ? { mobile: true } : {}),
      ...(blockList.length ? { block: [...blockList] } : {}),
      ...(config.locale ? { locale: config.locale } : {}),
      ...(config.timezone ? { timezone: config.timezone } : {}),
      ...(config.geolocation ? { geolocation: config.geolocation } : {}),
      ...(p ? { currentUrl: cleanUrl(p.url()) } : {}),
      tabs: context.pages().length,
    };
  };

  // ---- ops ----
  const runsDir = () => ensurePrivateDir(sessionRunsDir(name));
  const location = async (p: Page) => ({ url: cleanUrl(p.url()), title: cleanTitle(await p.title().catch(() => "")) });

  /** Lets a pending (error-page) navigation finish so the next goto is not interrupted by it. */
  const settle = (pg: Page) => pg.waitForLoadState("load", { timeout: capWait(3000) }).catch(() => {});

  function refLocator(p: Page, ref: string, field = "ref"): Locator {
    if (!/^[a-z0-9]{1,32}$/i.test(ref)) {
      throw new HoundError("INVALID_ARGUMENT", `--${field} must be ${REF_HINT}.`, { field, received: redactText(ref, 40) });
    }
    return p.locator(`aria-ref=${ref}`);
  }

  async function locate(p: Page, ref: string, field = "ref"): Promise<Locator> {
    const loc = refLocator(p, ref, field);
    const count = await loc.count().catch(() => 0);
    if (count === 0) {
      throw new HoundError("REF_NOT_FOUND", `Element ref "${ref}" is not on the current page (stale or unknown); use ${REF_HINT}.`, {
        field,
        received: ref,
        retryable: true,
        suggestedFix: `hound page snapshot --session-name ${name} --json`,
      });
    }
    return loc.first();
  }

  function blocked(what: string, reason?: string): HoundError {
    const profileFlag = config.profile ? ` --profile ${config.profile}` : "";
    return new HoundError("ACTION_BLOCKED", `${what} is blocked: the session was opened with --actions read${reason ? ` (${reason})` : ""}.`, {
      field: "actions",
      received: "read",
      allowed: ["interact"],
      suggestedFix: `hound browser close --session-name ${name} --json && hound browser open --session-name ${name}${profileFlag} --actions interact --json`,
    });
  }

  // ---- action log for `script export` (memory only; never values, answers or paths) ----
  const actionLog = new ActionLog();
  /** Set only while a recorded op runs: what it learned about its elements before acting. */
  let opNotes: OpNotes | undefined;
  /** The running op types into, checks or selects its element: the element's text is then never used to describe it (see recorder.ts). */
  let opIsForm = false;
  /**
   * Describes the element behind `ref` for the action log, before the op acts on it (its ref may not survive the action).
   * Bounded (RECORD_DESCRIBE_MS, and a quarter of what is left of the op's time); never throws, never fails the op.
   */
  async function note(key: "target" | "to" | "within", pg: Page, loc: Locator, ref: string): Promise<void> {
    if (!opNotes) return;
    const notes = opNotes;
    notes[key] = await describeTarget(pg, loc, ref, Math.min(RECORD_DESCRIBE_MS, remainingMs() / 4), opIsForm).catch(() => ({ kind: "none" as const, ambiguous: true, hint: `element ${ref}` }));
  }

  /** `--output`, validated up front: a path that is an existing directory is the caller's mistake. */
  async function outputPath(p: Params): Promise<string | undefined> {
    const output = optStr(p, "output", "output");
    if (!output) return undefined;
    if ((await stat(output).catch(() => undefined))?.isDirectory()) {
      throw new HoundError("INVALID_ARGUMENT", `--output must be a file path, but it is an existing directory: ${output}`, { field: "output", received: output });
    }
    return output;
  }

  /** `--if-exists overwrite` (anything else, or nothing, means the exclusive default). */
  const overwriteFlag = (p: Params): boolean => optEnum(p, "ifExists", "if-exists", ["error", "overwrite"] as const) === "overwrite";

  async function writeOutput(file: string, data: string | Buffer): Promise<void> {
    try {
      await writeFile(file, data, { mode: 0o600 });
      await chmod(file, 0o600);
    } catch (err) {
      throw outputError(err, file);
    }
  }

  /** Last snapshot text per tab for `snapshot --diff`, by "ref|depth"; at most SNAPSHOT_BASELINES_PER_TAB each, dropped with the tab. */
  const baselines = new WeakMap<Page, Map<string, string>>();

  const snapshotCmd = `hound page snapshot --session-name ${name} --json`;

  /** Races `work` against what is left of the op's time; a late finish is ignored. */
  async function within<T>(work: Promise<T>, ms: number, onTimeout: () => HoundError): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(onTimeout()), Math.max(1, ms));
    });
    work.catch(() => {});
    try {
      return await Promise.race([work, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * A click or download that timed out may have left a navigation pending (the server accepted the request and never answered):
   * Chromium then keeps the page busy and every later op (snapshot, hover, even navigate) times out behind it. Cancel the pending
   * load (CDP Page.stopLoading, bounded) so the page is usable again; the document that was showing stays. Never throws.
   */
  async function releasePage(pg: Page): Promise<void> {
    let cdp: CDPSession | undefined;
    const slow = () => new HoundError("TIMEOUT", "Could not cancel the pending navigation.");
    try {
      cdp = await within(context.newCDPSession(pg), 1000, slow);
      await within(cdp.send("Page.stopLoading"), 1000, slow);
    } catch {
      // best effort: the op already failed with its own TIMEOUT
    } finally {
      void cdp?.detach().catch(() => {});
    }
  }

  /** Resolves with the next download of `pg` (or of a tab opened meanwhile), or null after `ms`. */
  function nextDownload(pg: Page, ms: number): { promise: Promise<Download | null>; cancel(): void } {
    let finish!: (d: Download | null) => void;
    const promise = new Promise<Download | null>((res) => (finish = res));
    const popups: Page[] = [];
    const onDownload = (d: Download) => done(d);
    const onPage = (np: Page) => {
      popups.push(np);
      np.on("download", onDownload);
    };
    const timer = setTimeout(() => done(null), ms);
    function done(d: Download | null): void {
      clearTimeout(timer);
      pg.off("download", onDownload);
      context.off("page", onPage);
      for (const np of popups) np.off("download", onDownload);
      finish(d);
    }
    pg.on("download", onDownload);
    context.on("page", onPage);
    return { promise, cancel: () => done(null) };
  }

  /** Resolves with the next file chooser opened by `pg`, or null after `ms`. */
  function nextFileChooser(pg: Page, ms: number): { promise: Promise<FileChooser | null>; cancel(): void } {
    let finish!: (c: FileChooser | null) => void;
    const promise = new Promise<FileChooser | null>((res) => (finish = res));
    const onChooser = (c: FileChooser) => done(c);
    const timer = setTimeout(() => done(null), ms);
    function done(c: FileChooser | null): void {
      clearTimeout(timer);
      pg.off("filechooser", onChooser);
      finish(c);
    }
    pg.on("filechooser", onChooser);
    return { promise, cancel: () => done(null) };
  }

  /** Hard-links a staged file into `dir` under `name`, adding -2, -3, ... instead of ever replacing a file. */
  async function moveUnique(staged: string, dir: string, fileName: string): Promise<string> {
    for (let n = 1; n <= 1000; n++) {
      const dest = join(dir, n === 1 ? fileName : numberedName(fileName, n));
      try {
        await link(staged, dest);
        return dest;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    }
    const dest = join(dir, `${stamp()}-${fileName}`);
    await link(staged, dest);
    return dest;
  }

  function clickModifiers(p: Params): ClickModifier[] {
    const v = p.modifiers;
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || v.length > CLICK_MODIFIERS.length * 2) throw new HoundError("INVALID_ARGUMENT", "--modifiers must be a list of key names.", { field: "modifiers" });
    for (const m of v) {
      if (typeof m !== "string" || !CLICK_MODIFIERS.includes(m as ClickModifier)) {
        throw new HoundError("INVALID_ENUM", `Invalid --modifiers entry "${redactText(String(m), 40)}".`, { field: "modifiers", received: redactText(String(m), 40), allowed: CLICK_MODIFIERS });
      }
    }
    return [...new Set(v as ClickModifier[])];
  }

  /** The dialog policy of one op: the per-op override (needs interact to accept) or the session default. The answer text is never echoed. */
  function dialogPolicy(op: BrowserOp, p: Params): DialogPolicy & { explicit: boolean } {
    if (!DIALOG_OPS.has(op)) return { action: dialogDefault, explicit: false };
    const dialog = optEnum(p, "dialog", "dialog", ["accept", "dismiss"] as const);
    const text = optStr(p, "dialogText", "dialog-text");
    if (text !== undefined && text.length > DIALOG_TEXT_MAX_CHARS) {
      throw new HoundError("INVALID_ARGUMENT", `--dialog-text must be at most ${DIALOG_TEXT_MAX_CHARS} characters.`, { field: "dialog-text", received: `${text.length} chars` });
    }
    if (dialog === "accept" && config.actions === "read") throw blocked("Accepting a dialog", "--dialog accept needs interact");
    return { action: dialog ?? dialogDefault, ...(text !== undefined ? { text } : {}), explicit: dialog !== undefined || text !== undefined };
  }

  /** Page signature for "did the drag do anything": URL, document size and hash, plus how many requests finished. */
  const pageSignature = (pg: Page): Promise<string> =>
    pg
      .evaluate(() => {
        const html = document.documentElement.outerHTML;
        let h = 5381;
        for (let i = 0; i < html.length; i++) h = ((h << 5) + h + html.charCodeAt(i)) | 0;
        return `${window.location.href}|${html.length}|${h}`;
      })
      .catch(() => "gone")
      .then((sig) => `${sig}|${requestSeq}`);

  /** Where the dragged element is: position, size and its place in the tree. Animated libraries move it a little later than dragTo returns. */
  const elementPlace = (loc: Locator): Promise<string> =>
    loc
      .evaluate((el) => {
        const r = el.getBoundingClientRect();
        const path: string[] = [];
        for (let e: Element | null = el, i = 0; e && i < 5; e = e.parentElement, i++) {
          path.push(`${e.tagName}${e.parentElement ? Array.prototype.indexOf.call(e.parentElement.children, e) : ""}`);
        }
        return `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}|${path.join("/")}`;
      }, undefined, { timeout: 500 })
      .catch(() => "gone");

  /**
   * Starts watching a drag: `changed()` is true when the page fired an HTML5 dragstart, or its URL/DOM/requests or the dragged element's
   * position/parent differ from now. It polls up to DRAG_SETTLE_MS, because animated libraries only react after a transition.
   */
  async function watchDrag(pg: Page, source: Locator): Promise<{ changed(): Promise<boolean> }> {
    const key = `__houndDrag${Math.random().toString(36).slice(2)}`;
    const before = await pageSignature(pg);
    const placeBefore = await elementPlace(source);
    await pg.evaluate((k) => {
      (window as unknown as Record<string, unknown>)[k] = false;
      document.addEventListener("dragstart", () => ((window as unknown as Record<string, unknown>)[k] = true), { capture: true, once: true });
    }, key).catch(() => {});
    return {
      async changed() {
        const until = Date.now() + DRAG_SETTLE_MS;
        let result = false;
        for (;;) {
          await sleep(capWait(100));
          const started = await pg.evaluate((k) => (window as unknown as Record<string, unknown>)[k] === true, key).catch(() => false);
          if (started || (await pageSignature(pg)) !== before || (await elementPlace(source)) !== placeBefore) {
            result = true;
            break;
          }
          if (Date.now() >= until || remainingMs() < 400) break;
        }
        await pg.evaluate((k) => { delete (window as unknown as Record<string, unknown>)[k]; }, key).catch(() => {});
        return result;
      },
    };
  }

  /** A real pointer drag: move to the source centre, press, move to the target centre in `steps` moves, release. */
  async function mouseDrag(pg: Page, source: Locator, target: Locator, steps: number, timeout: number): Promise<void> {
    const centre = async (loc: Locator, what: string) => {
      await loc.scrollIntoViewIfNeeded({ timeout });
      const box = await loc.boundingBox();
      if (!box || box.width <= 0 || box.height <= 0) {
        throw new HoundError("INVALID_ARGUMENT", `The ${what} element is not visible, so it cannot be dragged with the pointer.`, { field: what === "source" ? "ref" : "to-ref", retryable: true });
      }
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    };
    const from = await centre(source, "source");
    await pg.mouse.move(from.x, from.y);
    await pg.mouse.down();
    try {
      const to = await centre(target, "target");
      await pg.mouse.move(to.x, to.y, { steps });
    } finally {
      await pg.mouse.up();
    }
  }

  const ops: { [K in BrowserOp]: (p: Params) => Promise<BrowserOpResult<K>> } = {
    ping: async () => ({ pong: true, pid: process.pid, name }),
    status: info,
    close: async () => ({ closed: true }),

    async navigate(p) {
      const url = reqStr(p, "url", "url");
      checkNavUrl(url);
      const waitUntil = optEnum(p, "waitUntil", "wait-until", WAIT_UNTIL) ?? "load";
      const pg = await page();
      let status: number | null;
      const go = async () => (await pg.goto(url, { waitUntil, timeout: timeoutOf(p, NAV_TIMEOUT_MS) }))?.status() ?? null;
      try {
        // After a failed navigation Chromium may commit its error page late and interrupt the next goto.
        status = await go().catch((err: unknown) => {
          if (!/interrupted by another navigation/i.test(firstLine(err))) throw err;
          return settle(pg).then(go);
        });
      } catch (err) {
        if ((err as Error)?.name === "TimeoutError" || !browser.isConnected()) throw err;
        await settle(pg);
        throw new HoundError("NAVIGATION_FAILED", `Navigation failed: ${redactText(firstLine(err).replace(/^page\.goto:\s*/, ""), 200)}`, {
          field: "url",
          retryable: true,
        });
      }
      return { ...(await location(pg)), status };
    },

    async snapshot(p) {
      const depth = optInt(p, "depth", "depth", 0, 1000);
      const limit = optInt(p, "limitChars", "limit-chars", 1, 200_000) ?? 8000;
      const ref = optStr(p, "ref", "ref");
      const diff = p.diff === true;
      const output = await outputPath(p);
      const overwrite = overwriteFlag(p);
      const pg = await page();
      const plain = { mode: "ai", timeout: timeoutOf(p, NAV_TIMEOUT_MS) } as const;
      const options = { ...plain, ...(depth !== undefined ? { depth } : {}) } as const;
      // With a ref only that element's subtree is returned. It is cut from a full snapshot (element.ariaSnapshot() would replace
      // Playwright's ref map with the subtree's refs and break every ref outside it); the refs are the same a full snapshot gives.
      let full: string;
      if (ref) {
        const whole = sanitizeSnapshot(await pg.ariaSnapshot(plain));
        const sub = snapshotSubtree(whole, ref, depth);
        // A ref the full snapshot does not list (e.g. inside a shadow root) falls back to the element's own snapshot.
        full = sub ?? sanitizeSnapshot(await (await locate(pg, ref)).ariaSnapshot(options));
      } else full = sanitizeSnapshot(await pg.ariaSnapshot(options));
      const refs = full.match(/\[ref=[^\]\s]+\]/g)?.length ?? 0;
      // The baseline of --diff: the last snapshot of this tab with the same ref and depth. Every snapshot replaces it.
      const key = `${ref ?? ""}|${depth ?? 0}`;
      const kept = baselines.get(pg) ?? new Map<string, string>();
      baselines.set(pg, kept);
      const previous = kept.get(key);
      kept.delete(key);
      if (full.length <= SNAPSHOT_BASELINE_MAX_CHARS) kept.set(key, full);
      while (kept.size > SNAPSHOT_BASELINES_PER_TAB) kept.delete(kept.keys().next().value as string);
      let body = full;
      let change: { added: number; removed: number; baseline: boolean } | undefined;
      if (diff) {
        if (previous === undefined) change = { added: full.split("\n").length, removed: 0, baseline: false };
        else {
          const d = diffSnapshots(previous, full, SNAPSHOT_DIFF_CONTEXT);
          body = d.text;
          change = { added: d.added, removed: d.removed, baseline: true };
        }
      }
      const truncated = body.length > limit;
      let text = body;
      if (truncated) {
        text = body.slice(0, limit);
        const nl = text.lastIndexOf("\n");
        if (nl > limit / 2) text = text.slice(0, nl);
      }
      let file: string | undefined;
      if (output) {
        file = output;
        await writeOutputSafe(output, body, overwrite);
      } else if (truncated) {
        file = join(await runsDir(), `${change?.baseline ? "snapshot-diff" : "snapshot"}-${stamp()}.${change?.baseline ? "diff" : "yml"}`);
        await writeOutput(file, body);
      }
      return { ...(await location(pg)), snapshot: text, truncated, totalChars: body.length, refs, ...(file ? { file } : {}), ...(change ? { diff: change } : {}) };
    },

    async screenshot(p) {
      const scope = optEnum(p, "scope", "scope", ["viewport", "full", "element"] as const) ?? "viewport";
      const ref = optStr(p, "ref", "ref");
      const output = await outputPath(p);
      const overwrite = overwriteFlag(p);
      const timeout = timeoutOf(p, NAV_TIMEOUT_MS);
      const pg = await page();
      let buf: Buffer;
      if (scope === "element") {
        if (!ref) throw new HoundError("MISSING_REQUIRED_FLAG", "--ref is required with --scope element.", { field: "ref" });
        buf = await (await locate(pg, ref)).screenshot({ timeout });
      } else {
        buf = await pg.screenshot({ fullPage: scope === "full", timeout });
      }
      const file = output ?? join(await runsDir(), `screenshot-${stamp()}.png`);
      if (output) await writeOutputSafe(output, buf, overwrite);
      else await writeOutput(file, buf);
      return { file, scope, url: cleanUrl(pg.url()) };
    },

    async wait(p) {
      const kind = reqEnum(p, "for", "for", WAIT_FOR);
      const timeout = timeoutOf(p, WAIT_TIMEOUT_MS);
      const asked = optInt(p, "timeoutMs", "timeout", 1, 600_000) ?? WAIT_TIMEOUT_MS;
      const within = optStr(p, "within", "within");
      const method = optEnum(p, "method", "method", REQUEST_METHODS);
      const sinceIndex = optInt(p, "sinceIndex", "since-index", 0, 2 ** 31 - 1);
      if (within !== undefined && kind !== "text" && kind !== "text-gone") {
        throw new HoundError("INVALID_ARGUMENT", "--within only applies to --for text and --for text-gone.", { field: "within", received: kind, allowed: ["text", "text-gone"] });
      }
      if ((method !== undefined || sinceIndex !== undefined) && kind !== "request") {
        throw new HoundError("INVALID_ARGUMENT", "--method and --since-index only apply to --for request.", { field: method !== undefined ? "method" : "since-index", received: kind, allowed: ["request"] });
      }
      const pg = await page();
      const t0 = Date.now();
      const timedOut = (): HoundError => {
        const value = optStr(p, "value", "value");
        const what = kind === "load" ? `page load state "${value ?? "load"}"` : `${kind} "${redactText(value ?? "", 200)}"`;
        return new HoundError("TIMEOUT", `Timed out after ${formatSeconds(asked)} waiting for ${what}.`, {
          field: kind === "load" ? "for" : "value",
          received: kind === "load" ? (value ?? "load") : redactText(value ?? "", 200),
          retryable: true,
        });
      };
      if (kind === "request") {
        const pattern = parseRequestValue(reqStr(p, "value", "value"));
        // Requests are numbered when they finish; only finished ones after the mark count (a fast one that ended before this wait began is not missed).
        const since = sinceIndex ?? requestMark;
        const until = Date.now() + timeout;
        let checked = since;
        for (;;) {
          const top = allRing.length > 0 ? allRing[allRing.length - 1]!.index : checked;
          const fresh = allRing.filter((e) => e.index > checked && (method === undefined || e.method === method));
          if (fresh.length > 0) {
            // A regex runs in a worker with a time budget, like `page find`: it must never freeze the daemon.
            const budget = Math.min(FIND_REGEX_BUDGET_MS, until - Date.now());
            let hits: number[] = [];
            if ("substring" in pattern) hits = matchSubstring(fresh.map((e) => e.url), pattern.substring);
            else if (budget >= 100) hits = await matchRegex(fresh.map((e) => e.url), pattern.source, pattern.flags, budget, { name: "value", fallback: "a plain substring" });
            else throw timedOut();
            const hit = hits.length > 0 ? fresh[hits[0]!] : undefined;
            if (hit) {
              const { index, method: m, status, failure, url } = hit;
              return { ...(await location(pg)), waitedMs: Date.now() - t0, sinceIndex: since, request: { index, method: m, ...(status !== undefined && { status }), ...(failure && { failure }), url } };
            }
            checked = Math.max(checked, top);
          } else checked = Math.max(checked, top);
          if (Date.now() >= until) throw timedOut();
          await sleep(Math.min(50, Math.max(1, until - Date.now())));
        }
      }
      /** text-gone / ref-hidden: was the thing visible when the wait began? false = the condition held at once (check the value). */
      let wasPresent: boolean | undefined;
      try {
        if (kind === "load") {
          const state = optEnum(p, "value", "value", WAIT_UNTIL) ?? "load";
          await pg.waitForLoadState(state, { timeout });
        } else {
          const value = reqStr(p, "value", "value");
          if (kind === "text" || kind === "text-gone") {
            // For text-gone a --within element that has vanished means its text is gone too.
            const scope = within ? (kind === "text" ? await locate(pg, within, "within") : refLocator(pg, within, "within").first()) : pg;
            if (within && scope !== pg) await note("within", pg, scope as Locator, within);
            const found = scope.getByText(value).filter({ visible: true }).first();
            if (kind === "text-gone") wasPresent = (await found.count().catch(() => 0)) > 0;
            await found.waitFor({ state: kind === "text" ? "visible" : "detached", timeout });
          } else if (kind === "ref") {
            const loc = await locate(pg, value);
            await note("target", pg, loc, value);
            await loc.waitFor({ state: "visible", timeout });
          }
          else if (kind === "ref-hidden") {
            // A ref that is no longer on the page (the spinner was removed) counts as hidden.
            const target = refLocator(pg, value, "value").first();
            wasPresent = await target.isVisible().catch(() => false);
            if (wasPresent) await note("target", pg, target, value);
            await target.waitFor({ state: "hidden", timeout });
          } else {
            // Agents only ever see stripped URLs, so a glob may match the full URL or origin + path.
            const re = value.includes("*") ? globToRegExp(value) : undefined;
            await pg.waitForURL((u) => (re ? re.test(u.href) || re.test(u.origin + u.pathname) : u.href.includes(value)), { timeout });
          }
        }
      } catch (err) {
        if ((err as Error)?.name !== "TimeoutError") throw err;
        throw timedOut();
      }
      return { ...(await location(pg)), waitedMs: Date.now() - t0, ...(wasPresent !== undefined ? { wasPresent } : {}) };
    },

    async back(p) {
      const pg = await page();
      const before = pg.url();
      const res = await pg.goBack({ timeout: timeoutOf(p, NAV_TIMEOUT_MS) });
      return { ...(await location(pg)), moved: res !== null || pg.url() !== before };
    },
    async forward(p) {
      const pg = await page();
      const before = pg.url();
      const res = await pg.goForward({ timeout: timeoutOf(p, NAV_TIMEOUT_MS) });
      return { ...(await location(pg)), moved: res !== null || pg.url() !== before };
    },
    async reload(p) {
      const pg = await page();
      const res = await pg.reload({ timeout: timeoutOf(p, NAV_TIMEOUT_MS) });
      return { ...(await location(pg)), status: res?.status() ?? null };
    },

    async scroll(p) {
      const direction = reqEnum(p, "direction", "direction", ["up", "down"] as const);
      const amount = reqEnum(p, "amount", "amount", ["page", "half", "top", "bottom"] as const);
      const pg = await page();
      return pg.evaluate(
        ([direction, amount]) => {
          const el = document.scrollingElement ?? document.documentElement;
          if (amount === "top") window.scrollTo(0, 0);
          else if (amount === "bottom") window.scrollTo(0, el.scrollHeight);
          else {
            const step = (amount === "page" ? 0.9 : 0.5) * window.innerHeight;
            window.scrollBy(0, direction === "up" ? -step : step);
          }
          return { scrollY: Math.round(window.scrollY), scrollHeight: el.scrollHeight, viewportHeight: window.innerHeight };
        },
        [direction, amount] as const,
      );
    },

    async tabs(p) {
      const action = reqEnum(p, "action", "action", ["list", "select", "close", "new"] as const);
      const pages = context.pages();
      const current = await page();
      const index = optInt(p, "tabIndex", "tab-index", 0, 1000);
      const pick = () => {
        const i = index ?? pages.indexOf(current);
        const target = pages[i];
        if (!target) throw new HoundError("INVALID_ARGUMENT", `No tab at index ${i}.`, { field: "tab-index", received: i });
        return target;
      };
      if (action === "select") {
        active = pick();
        await active.bringToFront().catch(() => {});
      } else if (action === "close") {
        if (pages.length <= 1) throw new HoundError("INVALID_ARGUMENT", "Cannot close the last tab; use `hound browser close` instead.", { field: "action", received: "close" });
        const target = pick();
        const at = pages.indexOf(target);
        await target.close();
        const left = context.pages();
        if (target === current) active = left[Math.min(at, left.length - 1)] ?? left[0]!;
      } else if (action === "new") {
        const url = optStr(p, "url", "url");
        if (url) checkNavUrl(url);
        const fresh = await context.newPage();
        active = fresh;
        await applyEmulation(fresh);
        if (url) {
          try {
            await fresh.goto(url, { timeout: timeoutOf(p, NAV_TIMEOUT_MS) });
          } catch (err) {
            if ((err as Error)?.name === "TimeoutError") throw err;
            throw new HoundError("NAVIGATION_FAILED", `Navigation failed: ${redactText(firstLine(err).replace(/^page\.goto:\s*/, ""), 200)}`, { field: "url" });
          }
        }
      }
      const all = context.pages();
      const tabs: TabInfo[] = await Promise.all(
        all.map(async (pg, i) => ({ index: i, url: cleanUrl(pg.url()), title: cleanTitle(await pg.title().catch(() => "")), active: pg === active })),
      );
      return { tabs, active: all.indexOf(active) };
    },

    async click(p) {
      const ref = reqStr(p, "ref", "ref");
      const count = optInt(p, "count", "count", 1, 3) ?? 1;
      const button = optEnum(p, "button", "button", ["left", "right", "middle"] as const) ?? "left";
      const modifiers = clickModifiers(p);
      if (config.actions === "read" && (count !== 1 || button !== "left" || modifiers.length > 0)) {
        throw blocked("This click", "--count, --button and --modifiers need interact; at the read level only a plain single left click on a link or <summary> is allowed");
      }
      const pg = await page();
      const loc = await locate(pg, ref);
      // The log note comes first: the read-level check must sit right before the click (the link may change while it is described).
      await note("target", pg, loc, ref);
      if (config.actions === "read") {
        const reason = await clickBlockReason(loc);
        if (reason) throw blocked("This click", reason);
      }
      // target=_blank: the new tab registers a moment after the click; wait briefly so `tabs` counts it.
      const opensTab = await loc.evaluate((el) => el instanceof HTMLAnchorElement && el.target === "_blank", undefined, { timeout: 500 }).catch(() => false);
      let popupSeen: Promise<unknown> | undefined;
      let onPopup: ((opened: Page) => void) | undefined;
      if (opensTab) {
        popupSeen = new Promise<void>((resolveSeen) => {
          onPopup = () => resolveSeen();
          pg.once("popup", onPopup);
        });
      }
      try {
        await loc.click({ timeout: timeoutOf(p, ACTION_TIMEOUT_MS), clickCount: count, button, ...(modifiers.length ? { modifiers } : {}) });
        if (popupSeen) await Promise.race([popupSeen, sleep(capWait(500))]);
      } catch (err) {
        // The click may have started a navigation that never gets an answer: do not leave the page stuck behind it.
        if ((err as Error)?.name === "TimeoutError") {
          await releasePage(pg);
          // Not retryable: the click (a form submit, say) may have been sent before the answer failed to arrive.
          throw timeoutError("click", p, snapshotCmd);
        }
        throw err;
      } finally {
        if (onPopup) pg.off("popup", onPopup);
      }
      await pg.waitForLoadState("domcontentloaded", { timeout: capWait(5000) }).catch(() => {});
      return {
        ...(await location(pg)),
        ref,
        tabs: context.pages().length,
        ...(count !== 1 ? { count } : {}),
        ...(button !== "left" ? { button } : {}),
        ...(modifiers.length ? { modifiers } : {}),
      };
    },
    async hover(p) {
      const ref = reqStr(p, "ref", "ref");
      const pg = await page();
      const loc = await locate(pg, ref);
      await note("target", pg, loc, ref);
      await loc.hover({ timeout: timeoutOf(p, ACTION_TIMEOUT_MS) });
      return { ref };
    },
    async fill(p) {
      const ref = reqStr(p, "ref", "ref");
      const value = optStr(p, "value", "value");
      if (value === undefined) throw new HoundError("MISSING_REQUIRED_FLAG", "--value is required.", { field: "value" });
      if (config.actions === "read") throw blocked("fill");
      const pg = await page();
      const loc = await locate(pg, ref);
      await note("target", pg, loc, ref);
      try {
        await loc.fill(value, { timeout: timeoutOf(p, ACTION_TIMEOUT_MS) });
      } catch (err) {
        // e.g. type=number/date/color/range reject text they cannot parse. Never echo the value.
        if (/cannot be filled|malformed value|cannot type text into input/i.test(firstLine(err))) {
          const type = await loc.evaluate((el) => (el instanceof HTMLInputElement ? el.type : el.tagName.toLowerCase())).catch(() => "input");
          throw new HoundError("INVALID_ARGUMENT", `The <input type="${redactText(type, 20)}"> does not accept that value; use a value valid for this input type.`, {
            field: "value",
            received: `${value.length} chars`,
          });
        }
        throw err;
      }
      return { ref, chars: value.length };
    },
    async select(p) {
      const ref = reqStr(p, "ref", "ref");
      const options = p.options;
      if (!Array.isArray(options) || options.length === 0 || !options.every((o) => typeof o === "string")) {
        throw new HoundError("MISSING_REQUIRED_FLAG", "--option is required (one or more strings).", { field: "option" });
      }
      if (config.actions === "read") throw blocked("select");
      const pg = await page();
      const loc = await locate(pg, ref);
      // Fail fast on an option that does not exist instead of waiting out the action timeout.
      const available = await loc.evaluate((el) =>
        el instanceof HTMLSelectElement ? Array.from(el.options).map((o) => ({ value: o.value, label: o.label })) : null,
      );
      if (!available) {
        throw new HoundError("INVALID_ARGUMENT", `Element "${ref}" is not a <select>; use fill or click instead.`, { field: "ref", received: ref, retryable: true });
      }
      const missing = (options as string[]).filter((o) => !available.some((a) => a.value === o || a.label === o));
      if (missing.length > 0) {
        throw new HoundError("INVALID_ARGUMENT", `Option ${missing.map((m) => `"${redactText(m, 80)}"`).join(", ")} not found in the select (matches a value or a label).`, {
          field: "option",
          received: missing.map((m) => redactText(m, 80)),
          allowed: available.slice(0, 20).map((a) => redactText(a.value, 80)),
          retryable: true,
        });
      }
      await note("target", pg, loc, ref);
      const selected = await loc.selectOption(options as string[], { timeout: timeoutOf(p, ACTION_TIMEOUT_MS) });
      return { ref, selected };
    },
    async press(p) {
      const key = reqStr(p, "key", "key");
      const ref = optStr(p, "ref", "ref");
      if (config.actions === "read") throw blocked("press");
      const pg = await page();
      try {
        if (ref) {
          const loc = await locate(pg, ref);
          await note("target", pg, loc, ref);
          await loc.press(key, { timeout: timeoutOf(p, ACTION_TIMEOUT_MS) });
        }
        else await pg.keyboard.press(key);
      } catch (err) {
        // Enter on a form may have started a navigation that never gets an answer (see click).
        if ((err as Error)?.name === "TimeoutError") {
          await releasePage(pg);
          throw timeoutError("press", p, snapshotCmd);
        }
        throw err;
      }
      await pg.waitForLoadState("domcontentloaded", { timeout: capWait(5000) }).catch(() => {});
      return { ...(await location(pg)), key };
    },

    async type(p) {
      const ref = reqStr(p, "ref", "ref");
      const value = optStr(p, "value", "value");
      if (value === undefined) throw new HoundError("MISSING_REQUIRED_FLAG", "--value is required.", { field: "value" });
      if (value.length > TYPE_MAX_CHARS) {
        throw new HoundError("INVALID_ARGUMENT", `The value is ${value.length} characters; type accepts at most ${TYPE_MAX_CHARS}. Use fill for long text.`, {
          field: "value",
          received: `${value.length} chars`,
        });
      }
      const delay = optInt(p, "delayMs", "delay-ms", 0, 1000) ?? 30;
      if (!typingFits(value.length, delay)) {
        throw new HoundError("INVALID_ARGUMENT", `Typing ${value.length} characters at ${delay} ms each takes over ${MAX_OP_TIMEOUT_MS / 1000} s. Lower --delay-ms or shorten the value.`, {
          field: "delay-ms",
          received: delay,
        });
      }
      if (config.actions === "read") throw blocked("type");
      const timeout = timeoutOf(p, typingTimeoutMs(value.length, delay));
      const pg = await page();
      const loc = await locate(pg, ref);
      await note("target", pg, loc, ref);
      try {
        if (p.clear === true) {
          try {
            await loc.fill("", { timeout });
          } catch (err) {
            if ((err as Error)?.name === "TimeoutError") throw err;
            // Not an input/textarea/contenteditable: focus it and select-all + delete with real keys.
            await loc.focus({ timeout });
            await loc.press("ControlOrMeta+a", { timeout });
            await loc.press("Backspace", { timeout });
          }
        }
        await loc.pressSequentially(value, { delay, timeout });
      } catch (err) {
        if (isHoundError(err) || (err as Error)?.name === "TimeoutError") throw err;
        // Never echo the typed text, even if Playwright's message does.
        const msg = value === "" ? firstLine(err) : firstLine(err).split(value).join("[redacted]");
        throw new HoundError("INTERNAL_ERROR", `"type" failed: ${redactText(msg, 200)}`);
      }
      return { ref, chars: value.length };
    },
    async upload(p) {
      const ref = reqStr(p, "ref", "ref");
      const given = p.files;
      if (!Array.isArray(given) || given.length === 0 || !given.every((f) => typeof f === "string" && f !== "")) {
        throw new HoundError("MISSING_REQUIRED_FLAG", `--file is required (1 to ${UPLOAD_MAX_FILES} paths).`, { field: "file" });
      }
      if (config.actions === "read") throw blocked("upload");
      // The safety checks come first: nothing is clicked or set before every file has been approved.
      const files = await resolveUploadFiles(given as string[]);
      const paths = files.map((f) => f.path);
      const pg = await page();
      const loc = await locate(pg, ref);
      const asked = optInt(p, "timeoutMs", "timeout", 1, 600_000) ?? ACTION_TIMEOUT_MS;
      const timeout = timeoutOf(p, ACTION_TIMEOUT_MS);
      const t0 = Date.now();
      const left = () => Math.max(1, timeout - (Date.now() - t0));
      const isInput = await loc.evaluate((el) => el instanceof HTMLInputElement && el.type === "file");
      await note("target", pg, loc, ref);
      if (opNotes) opNotes.fileInput = isInput;
      try {
        if (isInput) await loc.setInputFiles(paths, { timeout });
        else {
          // Like download: the chooser event is what matters; the click must not hold the op queue if it stays pending.
          const waiter = nextFileChooser(pg, timeout);
          const clicking = loc.click({ timeout }).then(
            () => undefined,
            (error: unknown) => ({ error }),
          );
          const first = await Promise.race([waiter.promise.then((c) => ({ c })), clicking.then((x) => ({ x }))]);
          let chooser: FileChooser | null;
          if ("c" in first) chooser = first.c;
          else if (first.x) {
            waiter.cancel();
            throw first.x.error;
          } else chooser = await waiter.promise;
          if (!chooser) {
            throw new HoundError("TIMEOUT", `No file chooser opened within ${formatSeconds(asked)} after clicking "${ref}"; it is not a file field or button; run page snapshot before retrying.`, {
              field: "ref",
              received: ref,
              retryable: false,
              suggestedFix: snapshotCmd,
            });
          }
          await chooser.setFiles(paths, { timeout: left() });
        }
      } catch (err) {
        if (/non-multiple/i.test(firstLine(err))) {
          throw new HoundError("INVALID_ARGUMENT", `This file field accepts a single file; ${files.length} were given.`, { field: "file", received: files.length, retryable: true });
        }
        throw err;
      }
      return { ref, files: files.map(({ name, bytes }) => ({ name, bytes })) };
    },

    async download(p) {
      const ref = reqStr(p, "ref", "ref");
      const output = await outputPath(p);
      const overwrite = overwriteFlag(p);
      const pg = await page();
      const loc = await locate(pg, ref);
      await note("target", pg, loc, ref);
      if (config.actions === "read") {
        const reason = await clickBlockReason(loc);
        if (reason) throw blocked("This download", reason);
      }
      const asked = optInt(p, "timeoutMs", "timeout", 1, 600_000) ?? DOWNLOAD_TIMEOUT_MS;
      const timeout = timeoutOf(p, DOWNLOAD_TIMEOUT_MS);
      const t0 = Date.now();
      const left = () => Math.max(1, timeout - (Date.now() - t0));
      const slow = (what: string) => () =>
        new HoundError("TIMEOUT", `Timed out after ${formatSeconds(asked)} ${what}; the click may have had other effects; run page snapshot before retrying.`, {
          field: "timeout",
          received: Math.round(asked / 1000),
          retryable: false,
          suggestedFix: snapshotCmd,
        });
      const waiter = nextDownload(pg, timeout);
      let dl: Download | null;
      // The download event is what we wait for: a click can stay pending (the navigation it started is a download) or fail
      // after the download began, so the click's outcome only matters while no download has started.
      const clicking = loc.click({ timeout }).then(
        () => undefined,
        (error: unknown) => ({ error }),
      );
      const first = await Promise.race([waiter.promise.then((d) => ({ d })), clicking.then((c) => ({ c }))]);
      if ("d" in first) dl = first.d;
      else if (first.c) {
        waiter.cancel();
        if ((first.c.error as Error)?.name === "TimeoutError") {
          await releasePage(pg);
          throw timeoutError("download", p, snapshotCmd);
        }
        throw first.c.error;
      } else dl = await waiter.promise;
      if (!dl) {
        // No bytes ever came: the click's navigation may still be pending and would block the next ops.
        await releasePage(pg);
        throw new HoundError("TIMEOUT", `No download started within ${formatSeconds(asked)} after clicking "${ref}"; the click may have done something else; run page snapshot before retrying.`, {
          field: "ref",
          received: ref,
          retryable: false,
          suggestedFix: snapshotCmd,
        });
      }
      const suggestedFilename = sanitizeFilename(dl.suggestedFilename());
      const dir = await ensurePrivateDir(join(await runsDir(), "downloads"));
      const staged = join(dir, `.partial-${stamp()}`);
      try {
        const failure = await within(dl.failure(), left(), slow("waiting for the download to finish"));
        if (failure) {
          throw new HoundError("NETWORK_ERROR", `The download failed: ${redactText(failure, 100)}.`, { field: "ref", received: ref, retryable: false, suggestedFix: snapshotCmd });
        }
        await within(dl.saveAs(staged), left(), slow("saving the download"));
        await chmod(staged, 0o600);
        const file = output ? await placeFile(staged, output, overwrite) : await moveUnique(staged, dir, suggestedFilename || DOWNLOAD_FALLBACK_NAME);
        return { file, bytes: (await stat(file)).size, suggestedFilename, url: cleanUrl(dl.url()) };
      } catch (err) {
        // A stuck or slow download must not hold the op queue: cancel it (bounded) before the error goes out.
        await within(dl.cancel(), 2000, () => new HoundError("TIMEOUT", "Could not cancel the download.")).catch(() => {});
        throw err;
      } finally {
        await rm(staged, { force: true }).catch(() => {});
        // delete() waits for the download to finish and has no timeout of its own: never await it.
        void dl.delete().catch(() => {});
      }
    },

    async check(p) {
      const ref = reqStr(p, "ref", "ref");
      const want = p.checked;
      if (typeof want !== "boolean") throw new HoundError("INVALID_ARGUMENT", "checked must be true or false.", { field: "checked", received: typeof want });
      if (config.actions === "read") throw blocked(want ? "check" : "uncheck");
      const pg = await page();
      const loc = await locate(pg, ref);
      const timeout = timeoutOf(p, ACTION_TIMEOUT_MS);
      const kind = await loc.evaluate((el) => {
        const role = (el.getAttribute("role") ?? "").trim().toLowerCase().split(/\s+/)[0] ?? "";
        if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) return role === "switch" ? "switch" : el.type;
        return role === "checkbox" || role === "radio" || role === "switch" ? role : null;
      });
      if (!kind) {
        throw new HoundError("INVALID_ARGUMENT", `Element "${ref}" is not a checkbox, radio button or switch (<input type=checkbox|radio>, or role checkbox, radio or switch); use click instead.`, {
          field: "ref",
          received: ref,
          retryable: true,
        });
      }
      await note("target", pg, loc, ref);
      const before = await loc.isChecked({ timeout });
      if (before === want) return { ref, checked: before, changed: false };
      if (kind === "radio" && !want) {
        throw new HoundError("INVALID_ARGUMENT", `Element "${ref}" is a radio button: it cannot be unchecked; check another radio button of its group instead.`, { field: "ref", received: ref, retryable: true });
      }
      try {
        await loc.setChecked(want, { timeout });
      } catch (err) {
        if (/did not change its state|state was not changed/i.test(firstLine(err))) {
          throw new HoundError("CONFLICT", `The page did not let "${ref}" be ${want ? "checked" : "unchecked"} (its state did not change after the click).`, { field: "ref", received: ref, retryable: false, suggestedFix: snapshotCmd });
        }
        throw err;
      }
      const after = await loc.isChecked({ timeout: capWait(2000) }).catch(() => want);
      return { ref, checked: after, changed: after !== before };
    },

    async pdf(p) {
      const format = optEnum(p, "format", "format", PDF_FORMATS) ?? "A4";
      const landscape = p.landscape === true;
      const background = p.background === true;
      const output = await outputPath(p);
      const overwrite = overwriteFlag(p);
      if (config.display === "headed") {
        throw new HoundError("CONFLICT", "page pdf needs a headless session: Chromium cannot print to PDF while its window is shown. Reopen the session without --display headed.", {
          field: "display",
          received: "headed",
          allowed: ["headless"],
          retryable: false,
          suggestedFix: `hound browser close --session-name ${name} --json && hound browser open --session-name ${name}${config.profile ? ` --profile ${config.profile}` : ""} --display headless --json`,
        });
      }
      const pg = await page();
      const buf = await within(pg.pdf({ format, landscape, printBackground: background }), timeoutOf(p, NAV_TIMEOUT_MS), () =>
        new HoundError("TIMEOUT", "Timed out while printing the page to PDF. Retry, or raise --timeout.", { field: "timeout", retryable: true }),
      );
      const file = output ?? join(await runsDir(), `page-${stamp()}.pdf`);
      if (output) await writeOutputSafe(output, buf, overwrite);
      else await writeOutput(file, buf);
      // Best effort: Chromium writes one "/Type /Page" object per page.
      const pages = buf.toString("latin1").match(/\/Type\s*\/Page(?![A-Za-z])/g)?.length ?? 0;
      return { file, bytes: buf.length, url: cleanUrl(pg.url()), format, landscape, background, ...(pages > 0 ? { pages } : {}) };
    },

    async resize(p) {
      assertViewport(p.width, p.height);
      const pg = await page();
      await pg.setViewportSize({ width: p.width as number, height: p.height as number });
      return { viewport: pg.viewportSize() ?? { width: p.width as number, height: p.height as number } };
    },

    async emulate(p) {
      const colorScheme = optEnum(p, "colorScheme", "color-scheme", ["light", "dark", "no-preference"] as const);
      const media = optEnum(p, "media", "media", ["screen", "print"] as const);
      const reducedMotion = optEnum(p, "reducedMotion", "reduced-motion", ["reduce", "no-preference"] as const);
      const reset = p.reset === true;
      if (reset && (colorScheme !== undefined || media !== undefined || reducedMotion !== undefined)) {
        throw new HoundError("INVALID_ARGUMENT", "--reset cannot be combined with --color-scheme, --media or --reduced-motion.", { field: "reset", received: true });
      }
      if (!reset && colorScheme === undefined && media === undefined && reducedMotion === undefined) {
        throw new HoundError("MISSING_REQUIRED_FLAG", "Give at least one of --color-scheme, --media, --reduced-motion or --reset.", {
          field: "color-scheme|media|reduced-motion|reset",
        });
      }
      const pg = await page();
      if (reset) {
        await pg.emulateMedia({ colorScheme: null, media: null, reducedMotion: null });
        emulation = {};
      } else {
        await pg.emulateMedia({
          ...(colorScheme !== undefined ? { colorScheme } : {}),
          ...(media !== undefined ? { media } : {}),
          ...(reducedMotion !== undefined ? { reducedMotion } : {}),
        });
        emulation = {
          ...emulation,
          ...(colorScheme !== undefined ? { colorScheme } : {}),
          ...(media !== undefined ? { media } : {}),
          ...(reducedMotion !== undefined ? { reducedMotion } : {}),
        };
      }
      return { colorScheme: emulation.colorScheme ?? "default", media: emulation.media ?? "default", reducedMotion: emulation.reducedMotion ?? "default" };
    },

    async drag(p) {
      const ref = reqStr(p, "ref", "ref");
      const toRef = reqStr(p, "toRef", "to-ref");
      const method = optEnum(p, "method", "method", DRAG_METHODS) ?? "auto";
      const steps = optInt(p, "steps", "steps", DRAG_STEPS_MIN, DRAG_STEPS_MAX) ?? DRAG_STEPS_DEFAULT;
      if (ref === toRef) throw new HoundError("INVALID_ARGUMENT", "--ref and --to-ref are the same element.", { field: "to-ref", received: toRef });
      if (config.actions === "read") throw blocked("drag");
      const pg = await page();
      const source = await locate(pg, ref);
      const target = await locate(pg, toRef, "to-ref");
      await note("target", pg, source, ref);
      await note("to", pg, target, toRef);
      const timeout = timeoutOf(p, ACTION_TIMEOUT_MS);
      let used: "html5" | "mouse" = method === "mouse" ? "mouse" : "html5";
      let fellBack = false;
      if (method === "mouse") await mouseDrag(pg, source, target, steps, timeout);
      else if (method === "html5") await source.dragTo(target, { timeout });
      else {
        // auto: Playwright's dragTo (HTML5 drag-and-drop, one pointer move) first; when the page did not react, or dragTo
        // failed, repeat with a real pointer path for libraries that need intermediate moves.
        const spy = await watchDrag(pg, source);
        let failed: unknown;
        try {
          await source.dragTo(target, { timeout });
        } catch (err) {
          if ((err as Error)?.name === "TimeoutError" || isHoundError(err)) throw err;
          failed = err;
        }
        if (failed !== undefined || !(await spy.changed())) {
          fellBack = true;
          used = "mouse";
          await mouseDrag(pg, source, target, steps, capWait(timeout));
        }
      }
      await pg.waitForLoadState("domcontentloaded", { timeout: capWait(5000) }).catch(() => {});
      return { ...(await location(pg)), ref, toRef, tabs: context.pages().length, method: used, ...(fellBack ? { fellBack } : {}) };
    },

    async find(p) {
      const text = optStr(p, "text", "text");
      const regex = optStr(p, "regex", "regex");
      if ((text === undefined) === (regex === undefined)) {
        throw new HoundError("INVALID_ARGUMENT", "Give exactly one of --text or --regex.", { field: "text|regex", allowed: ["--text", "--regex"] });
      }
      if (text !== undefined && (text === "" || text.length > FIND_PATTERN_MAX_CHARS)) {
        throw new HoundError("INVALID_ARGUMENT", `--text must be 1 to ${FIND_PATTERN_MAX_CHARS} characters.`, { field: "text", received: `${text.length} chars` });
      }
      const compiled = regex !== undefined ? parseRegexArg(regex) : undefined;
      const limit = optInt(p, "limit", "limit", 1, FIND_LIMIT_MAX) ?? FIND_LIMIT_DEFAULT;
      const context = optInt(p, "context", "context", 0, FIND_CONTEXT_MAX) ?? 0;
      const pg = await page();
      const full = sanitizeSnapshot(await pg.ariaSnapshot({ mode: "ai", timeout: timeoutOf(p, NAV_TIMEOUT_MS) }));
      const cut = full.length > FIND_SNAPSHOT_MAX_CHARS;
      let scanned = full;
      if (cut) {
        scanned = full.slice(0, FIND_SNAPSHOT_MAX_CHARS);
        const nl = scanned.lastIndexOf("\n");
        if (nl > 0) scanned = scanned.slice(0, nl);
      }
      const lines = scanned.split("\n");
      const budget = Math.min(FIND_REGEX_BUDGET_MS, remainingMs());
      if (compiled && budget < 100) throw new HoundError("TIMEOUT", "Timed out before the --regex scan could start; raise --timeout.", { field: "timeout", retryable: true });
      const hits = compiled ? await matchRegex(lines, compiled.source, compiled.flags, budget) : matchText(lines, text!);
      const shown = hits.slice(0, limit);
      // Matching used the raw lines; what is returned has one-time codes after a code label and card numbers masked.
      const safe = redactFindLines(lines);
      const tidy = (l: string | undefined) => clamp((l ?? "").trim(), 300);
      const matches = shown.map((i) => {
        const raw = safe[i] ?? "";
        const ref = /\[ref=([a-z0-9]{1,32})\]/i.exec(raw)?.[1];
        const before = context > 0 ? safe.slice(Math.max(0, i - context), i).map(tidy) : undefined;
        const after = context > 0 ? safe.slice(i + 1, i + 1 + context).map(tidy) : undefined;
        return { line: i + 1, ...(ref ? { ref } : {}), text: tidy(raw), ...(before ? { before } : {}), ...(after ? { after } : {}) };
      });
      const truncated = hits.length > shown.length;
      let snapshotFile: string | undefined;
      if (truncated || cut) {
        snapshotFile = join(await runsDir(), `snapshot-${stamp()}.yml`);
        await writeOutput(snapshotFile, full);
      }
      return { ...(await location(pg)), matches, total: hits.length, truncated, lines: lines.length, ...(cut ? { snapshotCut: true } : {}), ...(snapshotFile ? { snapshotFile } : {}) };
    },

    async read(p) {
      const ref = reqStr(p, "ref", "ref");
      const attr = optStr(p, "attr", "attr");
      if (attr !== undefined && !new RegExp(ATTR_NAME_PATTERN).test(attr)) {
        throw new HoundError("INVALID_ARGUMENT", "--attr must be an attribute name (letters, digits, '-', '_', ':', '.'; at most 64 characters).", { field: "attr", received: redactText(attr, 80) });
      }
      const limit = optInt(p, "limitChars", "limit-chars", 1, READ_LIMIT_MAX) ?? READ_LIMIT_DEFAULT;
      const loc = await locate(await page(), ref);
      // The page decides first: a password field's content never leaves it, only whitelisted descriptive attributes do.
      const facts: ReadFacts = await loc.evaluate(
        (el, [name, cap, safe, hint]) => {
          const tag = el.tagName.toLowerCase();
          let sensitive = false;
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
            const type = el instanceof HTMLInputElement ? el.type : "";
            const labels = Array.from(el.labels ?? []).map((l) => (l.textContent ?? "").slice(0, 100));
            const words = [el.getAttribute("name"), el.id, el.getAttribute("autocomplete"), el.getAttribute("aria-label"), el.getAttribute("placeholder"), el.getAttribute("data-testid"), ...labels].join(" ");
            sensitive = type === "password" || type === "hidden" || new RegExp(hint.source, hint.flags).test(words);
          }
          if (sensitive && !(typeof name === "string" && (safe as string[]).includes(name.toLowerCase()))) return { tag, sensitive, attr: null, text: "" };
          if (typeof name === "string") {
            const live = name.toLowerCase() === "value" && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement);
            const v = live ? (el as HTMLInputElement).value : el.getAttribute(name);
            return { tag, sensitive, attr: v === null ? null : v.slice(0, cap as number), text: "" };
          }
          // What the element and its surroundings say about themselves: decides how much of its text is masked (never returned).
          const bits: string[] = [];
          const add = (v: string | null | undefined) => {
            if (v) bits.push(v.slice(0, 100));
          };
          const describe = (e: Element) => [e.id, e.getAttribute("name"), e.getAttribute("aria-label"), e.getAttribute("data-testid"), e.getAttribute("placeholder"), e.getAttribute("autocomplete"), e.getAttribute("title"), typeof e.className === "string" ? e.className : ""];
          describe(el).forEach(add);
          const by = el.getAttribute("aria-labelledby");
          if (by) by.split(/\s+/).slice(0, 3).forEach((id) => add(document.getElementById(id)?.textContent));
          // The label just before the element ("Verification code" above its value): short and without digits, so a neighbouring paragraph is not a label.
          const before = el.previousElementSibling?.textContent?.trim() ?? "";
          if (before.length > 0 && before.length <= 60 && !/\d/.test(before)) add(before);
          let up: Element | null = el.parentElement;
          for (let i = 0; i < 3 && up && up !== document.body && up !== document.documentElement; i++, up = up.parentElement) {
            [up.id, up.getAttribute("aria-label"), up.getAttribute("data-testid"), typeof up.className === "string" ? up.className : ""].forEach(add);
          }
          const hints = bits.join(" ").slice(0, 800);
          return { tag, sensitive, attr: null, text: ((el as HTMLElement).innerText ?? el.textContent ?? "").slice(0, cap as number), hints };
        },
        [attr ?? null, READ_SCAN_MAX_CHARS, [...PASSWORD_SAFE_ATTRS], SENSITIVE_HINT] as const,
        { timeout: timeoutOf(p, ACTION_TIMEOUT_MS) },
      );
      if (facts.sensitive && (attr === undefined || !PASSWORD_SAFE_ATTRS.includes(attr.toLowerCase()))) {
        throw passwordBlocked(ref, attr === undefined ? "the text" : `the "${redactText(attr, 40)}" attribute`);
      }
      if (attr !== undefined) {
        if (facts.attr === null) return { ref, attr, value: null, chars: 0, truncated: false };
        const clean = redactAttr(attr, facts.attr);
        return { ref, attr, value: clean.slice(0, limit), chars: clean.length, truncated: clean.length > limit };
      }
      const clean = redactReadText(facts.text, facts.hints ?? "");
      return { ref, text: clean.slice(0, limit), chars: clean.length, truncated: clean.length > limit };
    },

    async console(p) {
      const level = optEnum(p, "level", "level", ["error", "warning", "all"] as const) ?? "error";
      const limit = optInt(p, "limit", "limit", 1, 500) ?? 20;
      const matching = level === "all" ? consoleRing : consoleRing.filter((e) => e.level === level);
      const entries = matching.slice(-limit);
      return { entries, total: matching.length, truncated: matching.length - entries.length };
    },
    async dialogs(p) {
      const limit = optInt(p, "limit", "limit", 1, 500) ?? 20;
      const entries = dialogRing.slice(-limit);
      return { entries, total: dialogRing.length, truncated: dialogRing.length - entries.length };
    },
    async network(p) {
      const state = optEnum(p, "state", "state", ["failed", "all"] as const) ?? "failed";
      const limit = optInt(p, "limit", "limit", 1, 500) ?? 20;
      const matching = state === "all" ? allRing : failedRing;
      const entries = matching.slice(-limit);
      return { entries, total: matching.length, truncated: matching.length - entries.length };
    },

    async request(p) {
      const index = optInt(p, "index", "index", 1, 2 ** 31 - 1);
      if (index === undefined) throw new HoundError("MISSING_REQUIRED_FLAG", "--index is required.", { field: "index" });
      const part = reqEnum(p, "part", "part", ["request-body", "response-body"] as const);
      const limit = optInt(p, "limitChars", "limit-chars", 1, 200_000) ?? 8000;
      const output = await outputPath(p);
      const overwrite = overwriteFlag(p);
      const req = requestBuffer.get(index);
      if (!req) {
        throw new HoundError("INVALID_ARGUMENT", `No request with index ${index} is available: unknown, or older than the last ${REQUEST_BUFFER_CAP} requests of this session.`, {
          field: "index",
          received: index,
          retryable: true,
          suggestedFix: `hound diag network --session-name ${name} --state all --json`,
        });
      }
      const method = req.method();
      const url = cleanUrl(req.url());
      const timeout = timeoutOf(p, NAV_TIMEOUT_MS);
      const slow = () => new HoundError("TIMEOUT", `Timed out reading the ${part} of request ${index}.`, { field: "timeout", retryable: true });
      const unavailable = () =>
        new HoundError("CONFLICT", `The response body of request ${index} is no longer available (the page navigated away or the browser discarded it).`, {
          field: "index",
          received: index,
          retryable: false,
        });
      let buf: Buffer;
      let headerType: string | undefined;
      let status: number | undefined;
      if (part === "request-body") {
        const data = req.postDataBuffer();
        if (!data) {
          const plain = method === "GET" || method === "HEAD";
          throw new HoundError(
            "INVALID_ARGUMENT",
            plain
              ? `Request ${index} (${method}) has no request body.`
              : `The request body of request ${index} (${method}) is not available: it is empty, or the browser does not expose it (e.g. a file upload).`,
            { field: "part", received: part, allowed: ["response-body"], retryable: false },
          );
        }
        buf = data;
        headerType = req.headers()["content-type"];
      } else {
        if (req.failure()) {
          const why = blockedRequests.get(req);
          throw new HoundError("NETWORK_ERROR", why ? `Request ${index} was blocked by --block ${why}, so it has no response body.` : `Request ${index} failed before any response arrived, so it has no response body.`, { field: "index", received: index, retryable: false });
        }
        const res = await within(req.response(), timeout, slow);
        if (!res) {
          throw new HoundError("CONFLICT", `Request ${index} has no response recorded.`, { field: "index", received: index, retryable: false });
        }
        status = res.status();
        if (req.redirectedTo() || [301, 302, 303, 307, 308].includes(status)) {
          throw new HoundError("INVALID_ARGUMENT", `Request ${index} was answered with a redirect (HTTP ${status}), which has no response body; pick the index of the request it redirected to.`, {
            field: "index",
            received: index,
            retryable: false,
            suggestedFix: `hound diag network --session-name ${name} --state all --json`,
          });
        }
        const headers = res.headers();
        headerType = headers["content-type"];
        const len = Number(headers["content-length"]);
        const declared: number | undefined = headers["content-length"] !== undefined && Number.isFinite(len) && len >= 0 ? len : undefined;
        // Size before reading, even without Content-Length (chunked, HTTP/2): the encoded size the browser counted.
        let encoded = declared;
        if (encoded === undefined) {
          const sizes = await within(req.sizes(), timeout, slow).catch(() => undefined);
          encoded = sizes && sizes.responseBodySize >= 0 ? sizes.responseBodySize : undefined;
        }
        const binary = isBinaryType(headerType);
        // A compressed body can expand a lot: allow less encoded data for it.
        const compressed = (headers["content-encoding"] ?? "identity").toLowerCase() !== "identity";
        const readLimit = compressed ? MAX_BODY_BYTES / 8 : MAX_BODY_BYTES;
        if ((binary && (declared !== undefined || encoded === undefined)) || (encoded !== undefined && encoded > readLimit)) {
          // Binary with a declared length (or an unknown size we cannot bound), or known to be too big: report its size without reading it.
          // Binary of a bounded size without Content-Length is read below only to count its exact bytes; the content is dropped.
          return {
            index, part, method, url, status, contentType: mediaType(headerType) || "unknown", bytes: encoded ?? 0, redacted: true,
            format: binary ? "binary" : "text", truncated: false, totalChars: 0,
            omitted: binary ? "binary" : "too-large",
          };
        }
        try {
          buf = await within(res.body(), timeout, slow);
        } catch (err) {
          if (isHoundError(err)) throw err;
          throw /redirect/i.test(firstLine(err))
            ? new HoundError("INVALID_ARGUMENT", `Request ${index} was a redirect, which has no response body.`, { field: "index", received: index, retryable: false })
            : unavailable();
        }
      }
      const bytes = buf.length;
      const cut = buf.length > MAX_BODY_BYTES;
      const redacted = redactBody(cut ? buf.subarray(0, MAX_BODY_BYTES) : buf, headerType);
      const common = { index, part, method, url, ...(status !== undefined ? { status } : {}), contentType: mediaType(headerType) || "unknown", bytes, redacted: true as const };
      if (redacted.text === undefined) {
        return { ...common, format: redacted.format, truncated: false, totalChars: 0, omitted: "binary" };
      }
      const text = redacted.text;
      const inlineCut = text.length > limit;
      let file: string | undefined;
      if (inlineCut || output) {
        if (output) {
          file = output;
          await writeOutputSafe(file, text, overwrite);
        } else {
          file = join(await runsDir(), `request-${index}-${part}-${stamp()}.txt`);
          await writeOutput(file, text);
        }
      }
      return {
        ...common,
        format: redacted.format,
        truncated: inlineCut || cut,
        totalChars: text.length,
        body: inlineCut ? text.slice(0, limit) : text,
        ...(file ? { file } : {}),
      };
    },

    async actions(p) {
      const includeQuery = p.includeQuery === true;
      const session = {
        name,
        ...(config.profile ? { profile: config.profile } : {}),
        actions: config.actions,
        dialog: dialogDefault,
        ...(config.viewport ? { viewport: config.viewport } : {}),
        ...(config.mobile ? { mobile: true } : {}),
        ...(config.deviceScaleFactor ? { deviceScaleFactor: config.deviceScaleFactor } : {}),
        ...(config.locale ? { locale: config.locale } : {}),
        ...(config.timezone ? { timezone: config.timezone } : {}),
        ...(config.geolocation ? { geolocation: config.geolocation } : {}),
        ...(blockList.length ? { block: [...blockList] } : {}),
      };
      return { session, ...actionLog.export(includeQuery) };
    },

    async "trace-export"() {
      if (config.trace !== "on") {
        throw new HoundError("INVALID_ARGUMENT", "This session was not opened with --trace on.", {
          field: "trace",
          received: "off",
          allowed: ["on"],
          suggestedFix: `hound browser close --session-name ${name} --json && hound browser open --session-name ${name}${config.profile ? ` --profile ${config.profile}` : ""} --trace on --json`,
        });
      }
      return exportTrace(context, await runsDir());
    },
  };

  function toHoundError(err: unknown, op: BrowserOp, params: Params = {}): HoundError {
    if (isHoundError(err)) return err;
    if (!browser.isConnected()) return new HoundError("BROWSER_CRASHED", "The browser of this session is gone.", { suggestedFix: `hound browser open --session-name ${name} --json` });
    if ((err as Error)?.name === "TimeoutError") return timeoutError(op, params, `hound page snapshot --session-name ${name} --json`);
    const msg = firstLine(err);
    if (/has been closed|Target closed/i.test(msg)) return new HoundError("CONFLICT", `The tab was closed while running "${op}".`, { retryable: true });
    return new HoundError("INTERNAL_ERROR", `"${op}" failed: ${redactText(msg, 200)}`);
  }

  let queue: Promise<void> = Promise.resolve();
  function handle(conn: Socket, req: WireRequest): void {
    const reply = (res: WireResponse, after?: () => void) => {
      if (conn.destroyed) return after?.();
      conn.write(JSON.stringify(res) + "\n", () => after?.());
    };
    const id = typeof req.id === "number" ? req.id : 0;
    const op = req.op;
    const fn = (ops as Record<string, ((p: Params) => Promise<unknown>) | undefined>)[op];
    if (!fn) {
      return reply({ id, ok: false, error: new HoundError("UNKNOWN_COMMAND", `Unknown op "${String(op)}".`, { field: "op", received: op }).toJSON() });
    }
    const params: Params = req.params && typeof req.params === "object" ? req.params : {};
    if (op === "ping" || op === "status") {
      void fn(params).then(
        (result) => reply({ id, ok: true, result }),
        (err) => reply({ id, ok: false, error: toHoundError(err, op, params).toJSON() }),
      );
      return;
    }
    pending++;
    if (idleTimer) clearTimeout(idleTimer);
    const deadline = typeof req.deadline === "number" && Number.isFinite(req.deadline) ? req.deadline : undefined;
    const finish = () => {
      pending--;
      if (!shuttingDown) armIdle();
    };
    queue = queue.then(async () => {
      if (shuttingDown) {
        reply({ id, ok: false, error: new HoundError("SESSION_NOT_FOUND", "The browser session is shutting down.", { field: "session-name", received: name }).toJSON() });
        return;
      }
      // A request whose client already left (it timed out) must never run later: it would act on the page unseen.
      if (op !== "close" && (conn.destroyed || !conn.writable)) {
        log(`op=${op} skipped (client left)`);
        return finish();
      }
      if (op !== "close" && deadline !== undefined && deadline - DEADLINE_RESERVE_MS - Date.now() <= 0) {
        log(`op=${op} skipped (deadline passed in queue)`);
        reply({
          id,
          ok: false,
          error: new HoundError("TIMEOUT", `"${op}" was not started: its time ran out while queued behind another operation.`, { field: "timeout", retryable: true }).toJSON(),
        });
        return finish();
      }
      const t0 = Date.now();
      currentDeadline = deadline;
      const recording = isRecorded(op, params);
      const hrefBefore = recording && !active.isClosed() ? active.url() : "";
      try {
        opNotes = recording ? {} : undefined;
        opIsForm = op === "fill" || op === "type" || op === "select" || op === "press" || op === "check" || op === "upload";
        const { explicit, ...chosen } = dialogPolicy(op, params);
        opPolicy = explicit ? chosen : undefined;
        opLeaves = op === "navigate" || op === "back" || op === "forward" || op === "reload" || (op === "tabs" && params.action === "close");
        opDialogs = [];
        if (isStateChanging(op, params)) {
          requestMark = requestSeq;
          graceOp = undefined;
        }
        const result = await fn(params);
        if (opDialogs.length > 0 && result && typeof result === "object") (result as { dialogs?: DialogEntry[] }).dialogs = opDialogs;
        if (recording && opNotes) {
          try {
            actionLog.record(op, params, result, opNotes, hrefBefore, active.isClosed() ? "" : active.url());
          } catch {
            // the log is best effort: it never fails an op
          }
        }
        log(`op=${op} ms=${Date.now() - t0} ok`);
        if (op === "close") {
          pending--;
          reply({ id, ok: true, result }, () => void shutdown(0, "close requested"));
          return;
        }
        reply({ id, ok: true, result });
      } catch (err) {
        const herr = toHoundError(err, op, params);
        if (opDialogs && opDialogs.length > 0 && herr.details.data === undefined) herr.details.data = { dialogs: opDialogs };
        log(`op=${op} ms=${Date.now() - t0} err=${herr.code}`);
        reply({ id, ok: false, error: herr.toJSON() });
      } finally {
        currentDeadline = undefined;
        opNotes = undefined;
        if (opPolicy) graceOp = { op, policy: opPolicy, until: Date.now() + DIALOG_GRACE_MS };
        opPolicy = undefined;
        opLeaves = false;
        opDialogs = undefined;
      }
      finish();
    });
  }

  const server = createServer((conn) => {
    let buf = "";
    conn.setEncoding("utf8");
    conn.on("error", () => {});
    conn.on("data", (chunk: string) => {
      buf += chunk;
      if (buf.length > MAX_LINE_BYTES) {
        conn.end(JSON.stringify({ id: 0, ok: false, error: new HoundError("INVALID_ARGUMENT", "Request too large.").toJSON() }) + "\n");
        buf = "";
        return;
      }
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let req: WireRequest;
        try {
          req = JSON.parse(line) as WireRequest;
        } catch {
          conn.write(JSON.stringify({ id: 0, ok: false, error: new HoundError("INVALID_ARGUMENT", "Malformed request line.").toJSON() }) + "\n");
          continue;
        }
        handle(conn, req);
      }
    });
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolveListen());
  });
  await chmod(socketPath, 0o600);

  browser.on("disconnected", () => void shutdown(1, "browser disconnected"));
  process.on("SIGTERM", () => void shutdown(0, "SIGTERM"));
  process.on("SIGINT", () => void shutdown(0, "SIGINT"));
  process.on("SIGHUP", () => {});
  process.on("uncaughtException", (err) => {
    log(`uncaught: ${redactText(firstLine(err), 200)}`);
    void shutdown(1, "uncaught exception");
  });
  process.on("unhandledRejection", (err) => {
    log(`unhandled rejection: ${redactText(firstLine(err), 200)}`);
  });

  await writePrivateJson(join(dir, STATE_FILE), state);
  serving = true;
  armIdle();
  log(`ready pid=${process.pid} actions=${config.actions} display=${config.display} trace=${config.trace}`);
}

/**
 * Same cleaning call as run.ts finishTrace: stop tracing into a raw zip in a private dir, write the
 * redacted derivative (`debug-trace.zip`, `steps.json`), ALWAYS delete the raw, then restart tracing.
 */
async function exportTrace(context: BrowserContext, runs: string): Promise<BrowserOpResult<"trace-export">> {
  const outDir = await ensurePrivateDir(join(runs, `trace-${stamp()}`));
  const rawDir = await ensurePrivateDir(join(outDir, ".raw"));
  const file = join(outDir, "debug-trace.zip");
  const steps = join(outDir, "steps.json");
  try {
    const raw = join(rawDir, "raw.zip");
    await context.tracing.stop({ path: raw });
    await chmod(raw, 0o600);
    const stagedZip = join(rawDir, "debug-trace.zip");
    const stagedSteps = join(rawDir, "steps.json");
    const { actions, redactions } = await cleanTrace(raw, stagedZip, stagedSteps);
    await rename(stagedZip, file);
    await rename(stagedSteps, steps);
    await chmod(file, 0o600);
    await chmod(steps, 0o600);
    return { dir: outDir, file, steps, actions, redactions };
  } catch (err) {
    await rm(outDir, { recursive: true, force: true });
    throw new HoundError("INTERNAL_ERROR", `Trace export failed: ${redactText(firstLine(err), 200)}`);
  } finally {
    await rm(rawDir, { recursive: true, force: true });
    await context.tracing.start(TRACE_OPTIONS).catch(() => log("trace restart failed"));
  }
}
