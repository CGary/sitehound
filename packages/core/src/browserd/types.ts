/**
 * Wire types for the browser-session daemon ("browserd"). Everything here is JSON-serializable.
 * One entry per op in `BrowserOpMap`: `params` is what `callBrowserSession` sends, `result` is what
 * it resolves to. URLs in results are stripped (origin + path, see stripUrl); file paths are absolute.
 */
import type { ErrorCode, HoundErrorDetails } from "../errors.ts";

export type ActionsLevel = "read" | "interact";
export type DisplayMode = "headless" | "headed";
export type SessionTraceMode = "off" | "on";
export type WaitUntil = "load" | "domcontentloaded" | "networkidle";

export interface BrowserSessionInfo {
  name: string;
  pid: number;
  /** Profile NAME only. */
  profile?: string;
  actions: ActionsLevel;
  display: DisplayMode;
  trace: SessionTraceMode;
  startedAt: string;
  idleTimeoutMinutes: number;
  alive: boolean;
  /** Active tab URL (stripped). Present when the daemon answered. */
  currentUrl?: string;
  tabs?: number;
}

export interface OpenBrowserSessionOptions {
  name: string;
  profile?: string;
  actions: ActionsLevel;
  display: DisplayMode;
  /** Minutes of inactivity before the daemon exits: 1 to 1440 (fractions allowed). */
  idleTimeoutMinutes: number;
  trace: SessionTraceMode;
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
}

export interface BrowserOpMap {
  /** Internal liveness check; answered out of band (does not wait for the queue or reset idle). */
  ping: { params: Record<string, never>; result: { pong: true; pid: number; name: string } };
  /** Session facts; answered out of band (does not wait for the queue or reset idle). */
  status: { params: Record<string, never>; result: BrowserSessionInfo };
  /** Closes the browser and removes the session dir; the daemon exits after replying. */
  close: { params: Record<string, never>; result: { closed: true } };

  /** Only http(s) URLs and about:blank. Default waitUntil "load", timeout 30 000. */
  navigate: { params: { url: string; waitUntil?: WaitUntil } & OpTimeout; result: PageLocation & { status: number | null } };
  /**
   * `page.ariaSnapshot({ mode: "ai" })`. limitChars 1..200000, default 8000; depth 0..1000. When truncated (or `output` given) the
   * full text is written to `output` (absolute; the client resolves it against the caller's cwd) or to
   * `<HOUND_HOME>/runs/browser/<name>/snapshot-<ts>.yml`, and `file` is set.
   */
  snapshot: {
    params: { depth?: number; limitChars?: number; output?: string } & OpTimeout;
    result: PageLocation & { snapshot: string; truncated: boolean; totalChars: number; refs: number; file?: string };
  };
  /** PNG under `<HOUND_HOME>/runs/browser/<name>/` (or `output`, absolute). scope default "viewport"; "element" needs `ref`. */
  screenshot: {
    params: { scope?: "viewport" | "full" | "element"; ref?: string; output?: string } & OpTimeout;
    result: { file: string; scope: "viewport" | "full" | "element"; url: string };
  };
  /**
   * text: first element containing the text becomes visible; url: glob (when it has `*`; `**` any, `*` no "/")
   * matched against the full URL or origin + path, else a substring of the full URL; ref: element visible; load: `value` is an optional WaitUntil (default "load").
   * timeoutMs default 10 000 -> TIMEOUT.
   */
  wait: {
    params: { for: "text" | "url" | "ref" | "load"; value?: string } & OpTimeout;
    result: PageLocation & { waitedMs: number };
  };
  /** `moved` is false when there was no history entry to go to. */
  back: { params: OpTimeout; result: PageLocation & { moved: boolean } };
  forward: { params: OpTimeout; result: PageLocation & { moved: boolean } };
  reload: { params: OpTimeout; result: PageLocation & { status: number | null } };
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
  /** Action timeout default 10 000. `tabs` is the tab count afterwards (a click may open a tab). */
  click: { params: { ref: string } & OpTimeout; result: PageLocation & { ref: string; tabs: number } };
  hover: { params: { ref: string } & OpTimeout; result: { ref: string } };
  /** The value is never echoed back; `chars` is its length. */
  fill: { params: { ref: string; value: string } & OpTimeout; result: { ref: string; chars: number } };
  /** Options match by value or label; `selected` are the resulting option values. */
  select: { params: { ref: string; options: string[] } & OpTimeout; result: { ref: string; selected: string[] } };
  /** Playwright key name ("Enter", "Control+A"). Without ref it goes to the focused element. */
  press: { params: { key: string; ref?: string } & OpTimeout; result: PageLocation & { key: string } };
  /** level default "error" ("all" = error + warning); limit default 20. Newest last. */
  console: {
    params: { level?: "error" | "warning" | "all"; limit?: number };
    result: { entries: ConsoleEntry[]; total: number; truncated: number };
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
  type: { params: { ref: string; value: string; delayMs?: number; clear?: boolean } & OpTimeout; result: { ref: string; chars: number } };
  /**
   * Clicks `ref` and saves the download it starts. Same read-level click policy as `click`. Without `output` the file goes to
   * `<HOUND_HOME>/runs/browser/<name>/downloads/` under its sanitized suggested name (a counter is added instead of overwriting);
   * `output` is absolute (the client resolves it). Default timeout 30 000 covers the click, the download start and the save.
   */
  download: {
    params: { ref: string; output?: string; ifExists?: "error" | "overwrite" } & OpTimeout;
    result: { file: string; bytes: number; suggestedFilename: string; url: string };
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
  "scroll", "tabs", "click", "hover", "fill", "select", "press", "type", "download", "console", "network", "request", "trace-export",
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
  trace: SessionTraceMode;
  idleTimeoutMinutes: number;
}

/** Written by the daemon once it is ready (state.json, 0600). */
export interface DaemonState extends DaemonConfig {
  pid: number;
  startedAt: string;
  socket: string;
}
