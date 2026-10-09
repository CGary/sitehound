/**
 * Wire types for the browser-session daemon ("browserd"). Everything here is JSON-serializable.
 * One entry per op in `BrowserOpMap`: `params` is what `callBrowserSession` sends, `result` is what
 * it resolves to. URLs in results are stripped (origin + path, see stripUrl); file paths are absolute.
 */
import type { ErrorCode, HoundErrorDetails } from "../errors.ts";
import type { BlockCategory, Geolocation, PdfFormat } from "./limits.ts";

export type ActionsLevel = "read" | "interact";
export type DisplayMode = "headless" | "headed";
export type SessionTraceMode = "off" | "on";
export type WaitUntil = "load" | "domcontentloaded" | "networkidle";
export type DialogAction = "accept" | "dismiss";
export type ClickButton = "left" | "right" | "middle";
export type ClickModifier = "Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift";
export const CLICK_MODIFIERS: readonly ClickModifier[] = ["Alt", "Control", "ControlOrMeta", "Meta", "Shift"];
export const WAIT_FOR = ["text", "text-gone", "url", "ref", "ref-hidden", "request", "load"] as const;
export type WaitFor = (typeof WAIT_FOR)[number];
export const REQUEST_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
export type RequestMethod = (typeof REQUEST_METHODS)[number];

/** One JavaScript dialog (alert, confirm, prompt, beforeunload) the daemon handled. */
export interface DialogEntry {
  time: string;
  type: "alert" | "confirm" | "prompt" | "beforeunload";
  /** Redacted (redactText), max 300 chars. The answer given to a prompt is never recorded. */
  message: string;
  action: DialogAction;
  /** Only for a dialog raised after an op returned, while that op's --dialog override still applied (DIALOG_GRACE_MS): the op's name. */
  op?: string;
}

/** Optional per-op dialog policy on ops that can trigger dialogs; `dialogText` answers a prompt (never echoed). */
export interface DialogParams {
  dialog?: DialogAction;
  dialogText?: string;
}

/** Dialogs handled while the op ran (present only when there were any). */
export interface Dialogged {
  dialogs?: DialogEntry[];
}

export type ColorScheme = "light" | "dark" | "no-preference";
export type MediaType = "screen" | "print";
export type ReducedMotion = "reduce" | "no-preference";
export interface Viewport {
  width: number;
  height: number;
}

export interface BrowserSessionInfo {
  name: string;
  pid: number;
  /** Profile NAME only. */
  profile?: string;
  actions: ActionsLevel;
  display: DisplayMode;
  /** Session default for JavaScript dialogs. */
  dialog: DialogAction;
  trace: SessionTraceMode;
  startedAt: string;
  idleTimeoutMinutes: number;
  alive: boolean;
  /** Size of the active tab's viewport (as set at open, or by `resize`). Present when the daemon answered. */
  viewport?: Viewport;
  /** Only when opened with a device scale factor / mobile emulation. */
  deviceScaleFactor?: number;
  mobile?: boolean;
  /** Only when opened with --block / --locale / --timezone / --geolocation. */
  block?: BlockCategory[];
  locale?: string;
  timezone?: string;
  geolocation?: Geolocation;
  /** Active tab URL (stripped). Present when the daemon answered. */
  currentUrl?: string;
  tabs?: number;
}

export interface OpenBrowserSessionOptions {
  name: string;
  profile?: string;
  actions: ActionsLevel;
  display: DisplayMode;
  /** Default for JavaScript dialogs (default "dismiss"); "accept" needs actions "interact". */
  dialog?: DialogAction;
  /** Minutes of inactivity before the daemon exits: 1 to 1440 (fractions allowed). */
  idleTimeoutMinutes: number;
  trace: SessionTraceMode;
  /** Initial viewport of every tab (default: Playwright's 1280x720). */
  viewport?: Viewport;
  /** 1..4 (default 1). */
  deviceScaleFactor?: number;
  /** Mobile emulation: isMobile + hasTouch. */
  mobile?: boolean;
  /** Request categories the session refuses (see block.ts). */
  block?: BlockCategory[];
  /** BCP 47 language tag (navigator.language, Accept-Language, Intl). */
  locale?: string;
  /** IANA time zone name. */
  timezone?: string;
  /** Fixed position for navigator.geolocation; also grants the geolocation permission. */
  geolocation?: Geolocation;
  /** How long to wait for the daemon to be ready. Default 30 000. */
  timeoutMs?: number;
}

/** Common optional field on every page/element op: Playwright timeout for that op. */
export interface OpTimeout {
  timeoutMs?: number;
}

/** Result of anything that may have moved the active tab. */
export interface PageLocation {
  url: string;
  title: string;
}

export interface TabInfo {
  index: number;
  url: string;
  title: string;
  active: boolean;
}

export interface ConsoleEntry {
  time: string;
  level: "error" | "warning";
  /** "console" for console.error/warn, "pageerror" for uncaught exceptions. */
  source: "console" | "pageerror";
  /** Redacted (redactText), max 300 chars. */
  text: string;
  location?: string;
}

export interface NetworkEntry {
  /** Stable per-session request number (1, 2, ...); `request` accepts it while the request is still in the buffer. */
  index: number;
  time: string;
  method: string;
  url: string;
  status?: number;
  resourceType: string;
  /** Redacted failure reason for requests that never got a response. */
  failure?: string;
  /** Set when the session's --block refused the request (then `failure` is "blocked"): such requests are listed with `state all` only, never as failures. */
  blocked?: BlockCategory;
}

/**
 * How `script export` finds an element again once its ref is gone, chosen before the action ran (see recorder.ts):
 * the first of test id, role + accessible name, label, placeholder, exact text, `#id`, short CSS path that matched exactly
 * that one element. `ambiguous` (with `nth`, the element's index among the matches of the best candidate) when none was
 * unique; kind "none" when nothing could be described in time. `frame`: the element is inside an iframe (not replayable as is).
 */
export interface LocatorDesc {
  kind: "testid" | "role" | "label" | "placeholder" | "text" | "css" | "none";
  /** kind role: the ARIA role. */
  role?: string;
  /** The test id, accessible name, label, placeholder, text or CSS selector. */
  value?: string;
  nth?: number;
  ambiguous?: boolean;
  frame?: boolean;
  /** Short description for comments and parameter names, e.g. textbox "Email" (clamped, one line). */
  hint: string;
}

/** A URL of the action log as exported: origin + path (token-like segments masked) unless `includeQuery`. */
export interface ExportedUrl {
  url: string;
  /** Path for assertions ("" for about:blank and non-http URLs). */
  path: string;
  /** A token-like path segment was replaced by ":token" (the URL will not replay as is). */
  masked: boolean;
}

export const RECORDED_OPS = ["navigate", "click", "hover", "fill", "type", "select", "press", "check", "drag", "upload", "download", "back", "forward", "reload", "tabs", "wait", "resize", "emulate"] as const;
export type RecordedOp = (typeof RECORDED_OPS)[number];

/**
 * One successful state-changing, navigation or wait op of the session, for `script export`. Never holds typed or filled
 * values, dialog answers or upload paths: those become script parameters. `details` holds only option values, keys,
 * wait conditions, sizes and flags.
 */
export interface ExportedAction {
  seq: number;
  op: RecordedOp;
  /** Active tab before and after the op. */
  before: ExportedUrl;
  after: ExportedUrl;
  /** navigate / tabs new: the URL that was opened. */
  goto?: ExportedUrl;
  target?: LocatorDesc;
  /** drag: the drop target. */
  to?: LocatorDesc;
  /** wait --within. */
  within?: LocatorDesc;
  details: Record<string, string | number | boolean | string[]>;
}

export interface BrowserOpMap {
  /** Internal liveness check; answered out of band (does not wait for the queue or reset idle). */
  ping: { params: Record<string, never>; result: { pong: true; pid: number; name: string } };
  /** Session facts; answered out of band (does not wait for the queue or reset idle). */
  status: { params: Record<string, never>; result: BrowserSessionInfo };
  /** Closes the browser and removes the session dir; the daemon exits after replying. */
  close: { params: Record<string, never>; result: { closed: true } };

  /** Only http(s) URLs and about:blank. Default waitUntil "load", timeout 30 000. */
  navigate: { params: { url: string; waitUntil?: WaitUntil } & DialogParams & OpTimeout; result: PageLocation & { status: number | null } & Dialogged };
  /**
   * `page.ariaSnapshot({ mode: "ai" })`. limitChars 1..200000, default 8000; depth 0..1000. When truncated (or `output` given) the
   * full text is written to `output` (absolute; the client resolves it against the caller's cwd) or to
   * `<HOUND_HOME>/runs/browser/<name>/snapshot-<ts>.yml`, and `file` is set.
   * `ref`: snapshot only that element's subtree (`locator.ariaSnapshot`; its refs are the same as in a full snapshot, so they stay
   * valid for element commands). `diff`: compare with the previous snapshot of the same tab taken with the same `ref` and `depth`
   * (any snapshot op, diff or not, replaces that baseline; the last SNAPSHOT_BASELINES_PER_TAB combinations are kept per tab):
   * `snapshot` is then the unified line diff (see snapdiff.ts; "" when nothing changed) with `added`/`removed` line counts and
   * `baseline: true`; without a baseline `snapshot` is the full snapshot and `baseline` is false. `truncated`, `totalChars`, `file`
   * and `output` then refer to the diff text; `refs` counts the refs of the whole current snapshot.
   */
  snapshot: {
    params: { depth?: number; limitChars?: number; output?: string; ifExists?: "error" | "overwrite"; ref?: string; diff?: boolean } & OpTimeout;
    result: PageLocation & { snapshot: string; truncated: boolean; totalChars: number; refs: number; file?: string; diff?: { added: number; removed: number; baseline: boolean } };
  };
  /** PNG under `<HOUND_HOME>/runs/browser/<name>/` (or `output`, absolute). scope default "viewport"; "element" needs `ref`. */
  screenshot: {
    params: { scope?: "viewport" | "full" | "element"; ref?: string; output?: string; ifExists?: "error" | "overwrite" } & OpTimeout;
    result: { file: string; scope: "viewport" | "full" | "element"; url: string };
  };
  /**
   * text: first visible element containing the text (inside `within`, a ref, when given); text-gone: no visible element contains
   * it any more (also inside `within`); url: glob (when it has `*`; `**` any, `*` no "/") matched against the full URL or
   * origin + path, else a substring of the full URL; ref: element visible; ref-hidden: element hidden or no longer on the page;
   * text-gone / ref-hidden also return `wasPresent`: whether the text / element was visible when the wait began (false: it held at once).
   * A vanished `within` ref counts as gone for text-gone. load: `value` is an optional WaitUntil (default "load").
   * request: a finished request (response or failure) whose `network` index is greater than `sinceIndex` (default: the request
   * counter when the last state-changing op of the session started) whose URL without query (and method, if given) matches `value`
   * (a substring, or /regex/flags); the result then has `request` and `sinceIndex`. timeoutMs default 10 000 -> TIMEOUT.
   */
  wait: {
    params: { for: WaitFor; value?: string; within?: string; method?: RequestMethod; sinceIndex?: number } & DialogParams & OpTimeout;
    result: PageLocation & { waitedMs: number; wasPresent?: boolean; request?: { index: number; method: string; status?: number; failure?: string; url: string }; sinceIndex?: number } & Dialogged;
  };
  /** `moved` is false when there was no history entry to go to. */
  back: { params: DialogParams & OpTimeout; result: PageLocation & { moved: boolean } & Dialogged };
  forward: { params: DialogParams & OpTimeout; result: PageLocation & { moved: boolean } & Dialogged };
  reload: { params: DialogParams & OpTimeout; result: PageLocation & { status: number | null } & Dialogged };
  /** top/bottom ignore direction. */
  scroll: {
    params: { direction: "up" | "down"; amount: "page" | "half" | "top" | "bottom" };
    result: { scrollY: number; scrollHeight: number; viewportHeight: number };
  };
  /** select/close default to the active tab index; new opens `url` when given and becomes active. */
  tabs: {
    params: { action: "list" | "select" | "close" | "new"; tabIndex?: number; url?: string } & OpTimeout;
    result: { tabs: TabInfo[]; active: number };
  };
  /**
   * Action timeout default 10 000. `tabs` is the tab count afterwards (a click may open a tab). `count` 1..3 (double/triple
   * click), `button`, `modifiers` (subset of CLICK_MODIFIERS): with actions "read" only a plain single left click can pass
   * the link policy; any option needs "interact". The options are echoed back only when given.
   */
  click: {
    params: { ref: string; count?: number; button?: ClickButton; modifiers?: ClickModifier[] } & DialogParams & OpTimeout;
    result: PageLocation & { ref: string; tabs: number; count?: number; button?: ClickButton; modifiers?: ClickModifier[] } & Dialogged;
  };
  hover: { params: { ref: string } & OpTimeout; result: { ref: string } & Dialogged };
  /** The value is never echoed back; `chars` is its length. */
  fill: { params: { ref: string; value: string } & OpTimeout; result: { ref: string; chars: number } & Dialogged };
  /** Options match by value or label; `selected` are the resulting option values. */
  select: { params: { ref: string; options: string[] } & DialogParams & OpTimeout; result: { ref: string; selected: string[] } & Dialogged };
  /** Playwright key name ("Enter", "Control+A"). Without ref it goes to the focused element. */
  press: { params: { key: string; ref?: string } & DialogParams & OpTimeout; result: PageLocation & { key: string } & Dialogged };
  /** level default "error" ("all" = error + warning); limit default 20. Newest last. */
  console: {
    params: { level?: "error" | "warning" | "all"; limit?: number };
    result: { entries: ConsoleEntry[]; total: number; truncated: number };
  };
  /** JavaScript dialogs the daemon handled (newest last; the last DIALOG_BUFFER_CAP are kept); limit default 20. */
  dialogs: {
    params: { limit?: number };
    result: { entries: DialogEntry[]; total: number; truncated: number };
  };
  /** state default "failed" (request failures + status >= 400); limit default 20. Newest last. */
  network: {
    params: { state?: "failed" | "all"; limit?: number };
    result: { entries: NetworkEntry[]; total: number; truncated: number };
  };
  /**
   * Types `value` character by character with real key events (`pressSequentially`). `clear` empties the field first.
   * delayMs 0..1000 (default 30); value at most TYPE_MAX_CHARS. The value is never echoed back. The default op timeout
   * grows with chars x delay (typingTimeoutMs).
   */
  type: { params: { ref: string; value: string; delayMs?: number; clear?: boolean } & DialogParams & OpTimeout; result: { ref: string; chars: number } & Dialogged };
  /**
   * Needs actions "interact". Sets the files (absolute paths, at most UPLOAD_MAX_FILES, UPLOAD_MAX_BYTES in total) on `ref`: an
   * `<input type=file>` directly, anything else is clicked and the file chooser it opens is answered. Real paths are resolved;
   * sitehound's own data, `.env*`, HAR/trace files and SSH/cloud credentials are refused (ACTION_BLOCKED). Only basenames are returned.
   */
  upload: { params: { ref: string; files: string[] } & DialogParams & OpTimeout; result: { ref: string; files: { name: string; bytes: number }[] } & Dialogged };
  /**
   * Clicks `ref` and saves the download it starts. Same read-level click policy as `click`. Without `output` the file goes to
   * `<HOUND_HOME>/runs/browser/<name>/downloads/` under its sanitized suggested name (a counter is added instead of overwriting);
   * `output` is absolute (the client resolves it). Default timeout 30 000 covers the click, the download start and the save.
   */
  download: {
    params: { ref: string; output?: string; ifExists?: "error" | "overwrite" } & DialogParams & OpTimeout;
    result: { file: string; bytes: number; suggestedFilename: string; url: string } & Dialogged;
  };
  /**
   * One recorded request by its `network` index (the last REQUEST_BUFFER_CAP requests are kept). Returns the REDACTED body of the
   * `request-body` or `response-body` part, never headers. Inline text is cut at limitChars (1..200000, default 8000); when cut,
   * or when `output` is given, the full redacted text is written to `output` (absolute) or to
   * `<HOUND_HOME>/runs/browser/<name>/request-<index>-<part>-<ts>.txt` and `file` is set. Binary content is never returned.
   */
  request: {
    params: { index: number; part: "request-body" | "response-body"; limitChars?: number; output?: string; ifExists?: "error" | "overwrite" } & OpTimeout;
    result: {
      index: number;
      part: "request-body" | "response-body";
      method: string;
      url: string;
      status?: number;
      contentType: string;
      bytes: number;
      redacted: true;
      format: "json" | "form" | "multipart" | "text" | "binary";
      truncated: boolean;
      totalChars: number;
      body?: string;
      file?: string;
      /** Why no body is present: binary content, or a body over the read limit (bytes then comes from Content-Length). */
      omitted?: "binary" | "too-large";
    };
  };
  /**
   * Idempotently sets a checkbox, radio or switch (`<input type=checkbox|radio>`, or role checkbox/radio/switch with aria-checked) to
   * `checked` (`locator.setChecked`). Needs actions "interact". `changed` is false when it already was in that state (nothing is
   * clicked). A radio cannot be unchecked (INVALID_ARGUMENT). Same dialog policy as `click`.
   */
  check: { params: { ref: string; checked: boolean } & DialogParams & OpTimeout; result: { ref: string; checked: boolean; changed: boolean } & Dialogged };
  /**
   * `page.pdf()` of the active tab (headless Chromium only; a headed session gives INVALID_ARGUMENT, field display). `format`
   * default "A4". Written to `output` (absolute) or `<HOUND_HOME>/runs/browser/<name>/page-<ts>.pdf` (0600); `pages` is counted from the
   * file when it can be read from it.
   */
  pdf: {
    params: { output?: string; ifExists?: "error" | "overwrite"; format?: PdfFormat; landscape?: boolean; background?: boolean } & OpTimeout;
    result: { file: string; bytes: number; url: string; format: PdfFormat; landscape: boolean; background: boolean; pages?: number };
  };
  /** Sets the active tab's viewport (width/height within the VIEWPORT_* limits); other tabs keep theirs. */
  resize: { params: Viewport; result: { viewport: Viewport } };
  /**
   * `page.emulateMedia` on the active tab; the settings are kept for the session and applied to tabs opened later. A key left out is
   * unchanged, `reset` clears all three (browser defaults). The result is what is in force: "default" = not emulated.
   */
  emulate: {
    params: { colorScheme?: ColorScheme; media?: MediaType; reducedMotion?: ReducedMotion; reset?: boolean };
    result: { colorScheme: ColorScheme | "default"; media: MediaType | "default"; reducedMotion: ReducedMotion | "default" };
  };
  /**
   * Drags `ref` onto `toRef`. method "html5": `locator.dragTo` (pointer down, one move to the target, up; HTML5 drag events included); "mouse": a real pointer path (move to the source centre, press, `steps` 1..50 moves to the target centre, release); "auto" (default): dragTo first, then the pointer path when the page did not react (no dragstart, same URL/DOM/requests) or dragTo failed. `method` in the result is the one that ran, `fellBack` is set when auto changed to the pointer path.
   * Needs actions "interact". Same dialog policy as `click`. `tabs` is the tab count afterwards.
   */
  drag: {
    params: { ref: string; toRef: string; method?: "auto" | "html5" | "mouse"; steps?: number } & DialogParams & OpTimeout;
    result: PageLocation & { ref: string; toRef: string; tabs: number; method: "html5" | "mouse"; fellBack?: true } & Dialogged;
  };
  /**
   * Fresh aria snapshot (same generator as `snapshot`, so the refs are valid afterwards) filtered to the lines matching `text`
   * (case-insensitive substring) or `regex` (`/pattern/flags` with flags from imsu, or a bare pattern). Pattern at most
   * FIND_PATTERN_MAX_CHARS; only the first FIND_LINE_MAX_CHARS of a line are examined and only the first FIND_SNAPSHOT_MAX_CHARS of the
   * snapshot are scanned (`snapshotCut`); a regex runs in a worker thread with a FIND_REGEX_BUDGET_MS budget. limit 1..FIND_LIMIT_MAX
   * (default FIND_LIMIT_DEFAULT), context 0..FIND_CONTEXT_MAX lines around each match (default 0). `snapshotFile` holds the full snapshot
   * and is written only when matches were cut by the limit or the scan was cut.
   */
  find: {
    params: { text?: string; regex?: string; limit?: number; context?: number } & OpTimeout;
    result: PageLocation & {
      matches: { line: number; ref?: string; text: string; before?: string[]; after?: string[] }[];
      total: number;
      truncated: boolean;
      lines: number;
      snapshotCut?: boolean;
      snapshotFile?: string;
    };
  };
  /**
   * Reads one element: its `innerText` (default) or one attribute (`attr`; `value` on input/textarea/select is the current value).
   * Redacted: tokens masked; URL attributes (href, src, action, formaction, data-*url*) lose query and fragment. A password input
   * (type=password or autocomplete *-password) yields no text and only harmless attributes (ACTION_BLOCKED otherwise). `chars` is the
   * length before cutting at limitChars (1..READ_LIMIT_MAX, default READ_LIMIT_DEFAULT; at most READ_SCAN_MAX_CHARS are read).
   * `value` is null when the attribute is absent.
   */
  read: {
    params: { ref: string; attr?: string; limitChars?: number } & OpTimeout;
    result: { ref: string; attr?: string; text?: string; value?: string | null; chars: number; truncated: boolean };
  };
  /**
   * The session's action log (the last ACTION_LOG_CAP successful recorded ops, oldest first; in memory only) for
   * `script export`, with the session settings a replay needs. URLs are origin + path unless `includeQuery`.
   */
  actions: {
    params: { includeQuery?: boolean };
    result: {
      session: { name: string; profile?: string; actions: ActionsLevel; dialog: DialogAction; viewport?: Viewport; mobile?: boolean; deviceScaleFactor?: number; locale?: string; timezone?: string; geolocation?: Geolocation; block?: BlockCategory[] };
      actions: ExportedAction[];
      /** Actions recorded since the session started, and how many of them were dropped from the front of the log. */
      recorded: number;
      dropped: number;
    };
  };
  /** Only for sessions opened with trace "on". Writes a redacted trace; tracing restarts afterwards. */
  "trace-export": {
    params: Record<string, never>;
    result: { dir: string; file: string; steps: string; actions: number; redactions: { headers: number; cookies: number; bodies: number; inputValues: number; urls: number } };
  };
}

export * from "./limits.ts";

export type BrowserOp = keyof BrowserOpMap;
export type BrowserOpParams<O extends BrowserOp> = BrowserOpMap[O]["params"];
export type BrowserOpResult<O extends BrowserOp> = BrowserOpMap[O]["result"];

export const BROWSER_OPS: readonly BrowserOp[] = [
  "ping", "status", "close", "navigate", "snapshot", "screenshot", "wait", "back", "forward", "reload",
  "scroll", "tabs", "click", "hover", "fill", "select", "press", "type", "upload", "download", "resize", "emulate", "drag", "find", "read", "check", "pdf",
  "console", "dialogs", "network", "request", "trace-export", "actions",
];

/** Socket protocol: one JSON object per line. */
export interface WireRequest {
  id: number;
  op: BrowserOp;
  params: Record<string, unknown>;
  /** Epoch ms after which the client no longer wants the answer; the daemon bounds the op by it. */
  deadline?: number;
}
export type WireResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { code: ErrorCode; message: string; details: HoundErrorDetails } };

/** Written by the parent (config.json, 0600). Holds the profile NAME only, never secrets. */
export interface DaemonConfig {
  name: string;
  profile?: string;
  actions: ActionsLevel;
  display: DisplayMode;
  /** Absent in configs written by older versions: "dismiss". */
  dialog?: DialogAction;
  trace: SessionTraceMode;
  idleTimeoutMinutes: number;
  /** Absent in configs written by older versions: Playwright's default viewport. */
  viewport?: Viewport;
  deviceScaleFactor?: number;
  mobile?: boolean;
  block?: BlockCategory[];
  locale?: string;
  timezone?: string;
  geolocation?: Geolocation;
}

/** Written by the daemon once it is ready (state.json, 0600). */
export interface DaemonState extends DaemonConfig {
  pid: number;
  startedAt: string;
  socket: string;
}
