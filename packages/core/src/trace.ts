import { chmod, readFile, writeFile } from "node:fs/promises";
import { redactData, redactText, scrubTokens, stripPathTokens, stripUrl } from "./redact.ts";
import { ZipWriter, readZipEntry, readZipIndex } from "./zip.ts";

/**
 * Turns a raw Playwright trace zip (cookies, auth headers, request bodies, form values) into a
 * redacted derivative that still opens in `playwright show-trace`, plus an agent-friendly
 * `steps.json`. The raw zip must never be read by humans or agents; only this module parses it.
 *
 * Format reference (playwright-core `tracing.ts`, `harTracer.ts`, `snapshotterInjected.ts`,
 * `traceLoader.ts`): the zip holds `<name>.trace` and `<name>.network` (JSON lines), plus
 * `resources/<sha1>` (response bodies, snapshot CSS overrides), `screencast/*.jpeg` (never
 * recorded here: pixels can show typed values) and optional `<name>.stacks`. Anything not recognized here is dropped, never copied through.
 */

export interface TraceRedactions {
  headers: number;
  cookies: number;
  bodies: number;
  inputValues: number;
  urls: number;
}

export interface CleanTraceResult {
  actions: number;
  redactions: TraceRedactions;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

const REDACTED = "[redacted]";
const SECRET_KEY_RE = /cookie|auth|token|secret|password|credential/i;
/** Attribute names that never carry anything the viewer needs and often carry secrets. */
const ATTR_SECRET_RE = /cookie|auth|token|secret|password|credential|csrf|xsrf|nonce|api[-_]?key|session/i;
/** Selector / element hints for fields whose typed value must not be recorded. */
export const HINT_RE =
  /passw|pwd|token|secret|(^|[^a-z])otp([^a-z]|$)|one-time|cvv|cvc|card|cc-(number|csc|exp)|csrf|xsrf|credential|(^|[^a-z])(pin|ssn)([^a-z]|$)|api[-_]?key/i;
const QUERY_SECRET_KEY_RE = /token|secret|pass|auth|key|sig|code|session|sid|jwt|credential|otp/i;

const KEEP_HEADERS = new Set(["content-type", "content-length", "accept", "cache-control", "location"]);
const STATIC_MIME_RE = /^(text\/css|image\/|font\/|application\/(font|x-font|vnd\.ms-fontobject))/i;
const STATIC_RESOURCE_TYPES = new Set(["stylesheet", "image", "font"]);
const SAFE_FILE_RE = /^resources\/[A-Za-z0-9._@-]+$/;
const NAME_RE = /^([A-Za-z0-9._-]*)\.trace$/;

/** Input types whose `value` is the button label, not user-entered text. */
const LABEL_INPUT_TYPES = new Set(["submit", "button", "reset", "image"]);
const URL_ATTRS = new Set(["href", "src", "action", "formaction", "poster", "cite", "data", "ping", "background", "xlink:href", "__playwright_current_src__"]);
const CSS_ATTRS = new Set(["style", "__playwright_style_sheet_", "__playwright_style_content__"]);

type Bucket = keyof TraceRedactions;
const DROP_PARAMS: Record<string, Bucket> = {
  headers: "headers",
  extrahttpheaders: "headers",
  httpcredentials: "headers",
  proxy: "headers",
  clientcertificates: "headers",
  cookies: "cookies",
  storagestate: "cookies",
  postdata: "bodies",
  jsondata: "bodies",
  formdata: "bodies",
  multipartdata: "bodies",
  body: "bodies",
  payloads: "bodies",
  streams: "bodies",
  localpaths: "inputValues",
  localdirectory: "inputValues",
  /** Dialog.accept: the answer given to a prompt() dialog. */
  prompttext: "inputValues",
};
const VALUE_KEYS = new Set(["value", "text", "values", "options", "key", "expectedtext", "prompttext"]);
/** Serialized-argument params the trace viewer parses structurally (`{ value, handles }`). */
const SERIALIZED_ARG_KEYS = new Set(["arg", "eventinit", "expectedvalue"]);
/** Params that carry code or markup: never kept. */
const CODE_KEYS = new Set(["expression", "source", "script", "html", "content"]);
const URL_PARAM_KEYS = new Set(["url", "referer", "referrer", "href", "baseurl", "redirecturl"]);
/** Methods that enter a value into the page: their value params are always redacted. */
const VALUE_METHODS = new Set([
  "Frame.fill",
  "Frame.type",
  "Frame.press",
  "Frame.selectOption",
  "Frame.setInputFiles",
  "ElementHandle.fill",
  "ElementHandle.type",
  "ElementHandle.press",
  "ElementHandle.selectOption",
  "ElementHandle.setInputFiles",
  "Dialog.accept",
  "Page.keyboardType",
  "Page.keyboardInsertText",
  "Page.keyboardPress",
  "Page.keyboardDown",
  "Page.keyboardUp",
]);
/** Key-press methods: only redacted when the key is a printable character. */
const PRESS_METHODS = new Set(["Frame.press", "ElementHandle.press", "Page.keyboardPress", "Page.keyboardDown", "Page.keyboardUp"]);
/** Methods that run or inject page code or content: errors and logs are cut to a safe first line. */
const CODE_METHOD_RE = /^(evaluate|waitForFunction|addInitScript|exposeBinding|exposeFunction|addScriptTag|addStyleTag|setContent|fulfill|route)/;
const CONTEXT_OPTION_KEYS = [
  "viewport", "screenSize", "noDefaultViewport", "deviceScaleFactor", "isMobile", "hasTouch", "locale", "timezoneId",
  "colorScheme", "reducedMotion", "forcedColors", "contrast", "javaScriptEnabled", "ignoreHTTPSErrors", "bypassCSP",
  "offline", "acceptDownloads", "serviceWorkers", "userAgent", "strictSelectors",
];

/** Keeps origin + path of absolute URLs, and cuts query/fragment off relative ones. Token-like path segments are masked. */
function stripAnyUrl(v: string): string {
  if (/^data:/i.test(v)) return /^data:image\//i.test(v) && v.length <= 200_000 ? v : "data:";
  if (/^(javascript|vbscript):/i.test(v)) return "";
  if (/^blob:/i.test(v)) return "blob:";
  if (/^https?:\/\//i.test(v)) return stripUrl(v);
  const i = v.search(/[?#]/);
  return stripPathTokens(i < 0 ? v : v.slice(0, i));
}

const quotedRe = /"(?:[^"\\]|\\.)*"/g;
const valueAttrRe = /\bvalue=\\?"(?:[^"\\]|\\.)*\\?"/g;
const textareaRe = /(<textarea\b[^>]{0,500}>)[^<]{1,5000}/gi;
const editableRe = /(<([a-z][\w-]*)\b[^>]{0,500}\bcontenteditable\b[^>]{0,500}>)[\s\S]{1,5000}?(?=<\/\2>|$)/gi;
const CSS_DATA_URL_RE = /(url\(\s*["']?data:[^)]*\))/i;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function isSensitiveElement(tag: string, attrs: Obj): boolean {
  if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") return false;
  const type = (str(attrs.type) ?? "").toLowerCase();
  if (type === "password" || type === "hidden") return true;
  const hint = [attrs.name, attrs.id, attrs.autocomplete, attrs["aria-label"], attrs.placeholder, attrs["data-testid"]]
    .map((v) => str(v) ?? "")
    .join(" ");
  return HINT_RE.test(hint);
}

/** Calls `visit` for every element of a snapshot node tree (see `snapshotterInjected.ts`). */
function scanHtml(node: unknown, visit: (tag: string, attrs: Obj) => void): void {
  if (!Array.isArray(node) || node.length === 0 || Array.isArray(node[0])) return; // text or back-reference
  const tag = String(node[0]);
  let i = 1;
  if (isObj(node[1])) {
    visit(tag, node[1]);
    i = 2;
  }
  for (; i < node.length; i++) scanHtml(node[i], visit);
}

class TraceCleaner {
  r: TraceRedactions = { headers: 0, cookies: 0, bodies: 0, inputValues: 0, urls: 0 };
  private literals = new Set<string>();
  private scrubRe: RegExp | undefined;
  private redactedCalls = new Set<string>();
  private keepFiles = new Set<string>();
  private cssFiles = new Set<string>();
  steps: Obj[] = [];
  consoleErrors: Obj[] = [];
  pageErrors: Obj[] = [];
  private stepById = new Map<string, Obj>();
  baseTime: number | undefined;

  // ---- literal scrubbing (defense in depth: known secret values are removed wherever they appear)

  private addLiteral(v: unknown, min: number): void {
    if (typeof v !== "string" || v.length < min || v.length > 4096 || this.literals.size >= 2000) return;
    this.literals.add(v);
    const enc = encodeURIComponent(v);
    if (enc !== v) this.literals.add(enc);
  }

  private buildScrubber(): void {
    const list = [...this.literals].sort((a, b) => b.length - a.length).map(escapeRe);
    this.scrubRe = list.length ? new RegExp(list.join("|"), "g") : undefined;
  }

  private scrub(s: string): string {
    return this.scrubRe ? s.replace(this.scrubRe, REDACTED) : s;
  }

  /** Scrubs known secrets and strips URL queries; truncates to `max`. */
  private txt(s: string, max = 500): string {
    return redactText(this.scrub(s), max);
  }

  private cssText(s: string): string {
    const capped = s.length > 2_000_000 ? s.slice(0, 2_000_000) : s;
    const parts = this.scrub(capped).split(CSS_DATA_URL_RE);
    const out = parts
      .map((part, i) => {
        if (i % 2 === 1) return part; // inline data: url, kept as is
        const noUrls = part
          .replace(/url\(\s*(["']?)([^"')]{0,4096})\1\s*\)/gi, (_m, q: string, u: string) => `url(${q}${this.anyUrl(u)}${q})`)
          .replace(/(@import\s+)(["'])([^"']{0,4096})\2/gi, (_m, a: string, q: string, u: string) => `${a}${q}${this.anyUrl(u)}${q}`);
        return scrubTokens(noUrls);
      })
      .join("");
    return out;
  }

  /** Plain text/attribute value: known secrets, URL queries and token-like strings removed. */
  private plain(s: string): string {
    return scrubTokens(redactData(this.scrub(s)) as string);
  }

  private cleanAbsUrl(u: string): string {
    if (/[?#]/.test(u)) this.r.urls++;
    return stripUrl(u);
  }

  private anyUrl(v: string): string {
    const out = stripAnyUrl(v);
    if (out !== v) this.r.urls++;
    return out;
  }

  // ---- pass 1: collect target sensitivity and secret literals

  private collectQuery(url: string): void {
    try {
      const u = new URL(url);
      for (const [k, v] of u.searchParams) {
        if (QUERY_SECRET_KEY_RE.test(k) ? v.length >= 4 : v.length >= 16) this.addLiteral(v, 4);
      }
    } catch {
      // not a URL
    }
  }

  private collectHeaderLiterals(headers: unknown): void {
    if (!Array.isArray(headers)) return;
    for (const h of headers) {
      if (!isObj(h)) continue;
      const name = (str(h.name) ?? "").toLowerCase();
      const value = str(h.value);
      if (!value) continue;
      if (name === "cookie" || name === "set-cookie") {
        for (const part of name === "cookie" ? value.split(";") : [value.split(";")[0] ?? ""]) {
          this.addLiteral(part.slice(part.indexOf("=") + 1).trim(), 6);
        }
      } else if (name === "authorization" || name === "proxy-authorization") {
        this.addLiteral(value.split(/\s+/).pop(), 6);
      } else if (SECRET_KEY_RE.test(name) || /^x-.*(key|csrf|xsrf|session)/.test(name)) {
        this.addLiteral(value, 6);
      }
    }
  }

  private collectNetwork(e: Obj): void {
    const req = isObj(e.request) ? e.request : {};
    const res = isObj(e.response) ? e.response : {};
    for (const list of [req.cookies, res.cookies]) {
      if (Array.isArray(list)) for (const c of list) if (isObj(c)) this.addLiteral(c.value, 6);
    }
    this.collectHeaderLiterals(req.headers);
    this.collectHeaderLiterals(res.headers);
    if (typeof req.url === "string") this.collectQuery(req.url);
    if (Array.isArray(req.queryString)) {
      for (const q of req.queryString) {
        if (isObj(q) && typeof q.name === "string" && QUERY_SECRET_KEY_RE.test(q.name)) this.addLiteral(q.value, 4);
      }
    }
  }

  private collectContextOptions(ev: Obj): void {
    const options = isObj(ev.options) ? ev.options : {};
    const state = options.storageState;
    if (isObj(state)) {
      if (Array.isArray(state.cookies)) for (const c of state.cookies) if (isObj(c)) this.addLiteral(c.value, 6);
      if (Array.isArray(state.origins)) {
        for (const o of state.origins) {
          const items = isObj(o) && Array.isArray(o.localStorage) ? o.localStorage : [];
          for (const item of items) if (isObj(item)) this.addLiteral(item.value, 8);
        }
      }
    }
    if (isObj(options.extraHTTPHeaders)) for (const v of Object.values(options.extraHTTPHeaders)) this.addLiteral(v, 6);
    if (isObj(options.httpCredentials)) this.addLiteral(options.httpCredentials.password, 4);
    if (isObj(options.proxy)) this.addLiteral(options.proxy.password, 4);
  }

  private collectSnapshot(s: Obj): void {
    scanHtml(s.html, (tag, attrs) => {
      if (isSensitiveElement(tag, attrs)) {
        this.addLiteral(attrs.__playwright_value_, 4);
        this.addLiteral(attrs.value, 4);
      }
    });
  }

  /**
   * Must this call be treated as carrying a value or code? Value-entry methods (fill, type, press of a
   * printable key, selectOption, setInputFiles, keyboard text), expect and code-running methods qualify,
   * whatever the selector: their params, title, logs and error text are redacted.
   */
  private needsValueRedaction(ev: Obj): boolean {
    const cls = str(ev.class) ?? "";
    const method = str(ev.method) ?? "";
    const api = `${cls}.${method}`;
    const params = isObj(ev.params) ? ev.params : {};
    if (method === "expect" || CODE_METHOD_RE.test(method)) return true;
    if (!VALUE_METHODS.has(api)) return false;
    if (PRESS_METHODS.has(api)) {
      const key = str(params.key) ?? "";
      const last = key.length > 1 ? (key.split("+").pop() ?? "") : key;
      return Array.from(last).length === 1;
    }
    return true;
  }

  private collectCallValues(v: unknown, key: string, depth: number): void {
    if (depth > 6) return;
    if (typeof v === "string") {
      if (VALUE_KEYS.has(key) && key !== "key") this.addLiteral(v, 3);
    } else if (Array.isArray(v)) {
      for (const x of v) this.collectCallValues(x, key, depth + 1);
    } else if (isObj(v)) {
      for (const [k, x] of Object.entries(v)) this.collectCallValues(x, VALUE_KEYS.has(key) ? key : k.toLowerCase(), depth + 1);
    }
  }

  // ---- pass 2: clean

  private cleanHeaders(list: unknown): Obj[] {
    if (!Array.isArray(list)) return [];
    const out: Obj[] = [];
    for (const h of list) {
      if (!isObj(h) || typeof h.name !== "string") continue;
      const lower = h.name.toLowerCase();
      if (!KEEP_HEADERS.has(lower)) {
        this.r.headers++;
        continue;
      }
      const value = String(h.value ?? "");
      out.push({ name: h.name, value: lower === "location" ? this.anyUrl(value) : this.txt(value, 200) });
    }
    return out;
  }

  private cleanNetwork(e: Obj): Obj | undefined {
    const req = isObj(e.request) ? e.request : {};
    const res = isObj(e.response) ? e.response : {};
    const url = str(req.url);
    if (!url || !/^https?:/i.test(url)) return undefined;
    const content = isObj(res.content) ? res.content : {};
    const mime = str(content.mimeType) ?? "";
    const resourceType = str(e._resourceType);
    const isStatic = STATIC_MIME_RE.test(mime) && (resourceType === undefined || STATIC_RESOURCE_TYPES.has(resourceType));

    if (Array.isArray(req.cookies)) this.r.cookies += req.cookies.length;
    if (Array.isArray(res.cookies)) this.r.cookies += res.cookies.length;
    if (Array.isArray(req.queryString)) this.r.urls += req.queryString.length;
    if (req.postData !== undefined) this.r.bodies++;

    const outContent: Obj = { size: num(content.size) ?? 0, mimeType: mime.slice(0, 100) };
    if (num(content.compression) !== undefined) outContent.compression = content.compression;
    const file = str(content._file);
    if (file !== undefined || content.text !== undefined) {
      if (isStatic && file && SAFE_FILE_RE.test(file) && content.text === undefined) {
        outContent._file = file;
        this.keepFiles.add(file);
        if (/^text\/css/i.test(mime)) this.cssFiles.add(file);
      } else {
        this.r.bodies++;
      }
    }

    const timings: Obj = {};
    if (isObj(e.timings)) for (const [k, v] of Object.entries(e.timings)) if (num(v) !== undefined) timings[k] = v;
    const out: Obj = {
      startedDateTime: str(e.startedDateTime),
      time: num(e.time) ?? -1,
      request: {
        method: str(req.method) ?? "GET",
        url: this.cleanAbsUrl(url),
        httpVersion: str(req.httpVersion) ?? "",
        cookies: [],
        headers: this.cleanHeaders(req.headers),
        queryString: [],
        headersSize: num(req.headersSize) ?? -1,
        bodySize: num(req.bodySize) ?? -1,
      },
      response: {
        status: num(res.status) ?? 0,
        statusText: this.txt(str(res.statusText) ?? "", 100),
        httpVersion: str(res.httpVersion) ?? "",
        cookies: [],
        headers: this.cleanHeaders(res.headers),
        content: outContent,
        redirectURL: this.anyUrl(str(res.redirectURL) ?? ""),
        headersSize: num(res.headersSize) ?? -1,
        bodySize: num(res.bodySize) ?? -1,
        _transferSize: num(res._transferSize) ?? -1,
        ...(str(res._failureText) !== undefined && { _failureText: this.txt(str(res._failureText)!, 200) }),
      },
      cache: {},
      timings,
    };
    for (const k of ["pageref", "_frameref", "_resourceType", "_serviceWorkerRef", "_apiRequestRef"]) {
      if (str(e[k]) !== undefined) out[k] = e[k];
    }
    if (num(e._monotonicTime) !== undefined) out._monotonicTime = e._monotonicTime;
    for (const k of ["_wasAborted", "_wasFulfilled", "_wasContinued"]) if (e[k] === true) out[k] = true;
    return out;
  }

  private blankValue(v: string): string {
    if (v !== "") this.r.inputValues++;
    return "";
  }

  private cleanAttrs(tag: string, attrs: Obj): Obj {
    const out: Obj = {};
    const type = (str(attrs.type) ?? "").toLowerCase();
    const keepsLabel = tag === "INPUT" && LABEL_INPUT_TYPES.has(type) && !isSensitiveElement(tag, attrs);
    const metaName = `${str(attrs.name) ?? ""} ${str(attrs.property) ?? ""} ${str(attrs["http-equiv"]) ?? ""}`;
    for (const [k, v] of Object.entries(attrs)) {
      const lk = k.toLowerCase();
      if (typeof v !== "string") {
        out[k] = v;
      } else if (lk === "__playwright_value_" || lk === "value") {
        out[k] = keepsLabel ? this.plain(v) : this.blankValue(v);
      } else if (lk === "content" && tag === "META" && ATTR_SECRET_RE.test(metaName)) {
        out[k] = this.blankValue(v);
      } else if (!lk.startsWith("__playwright_") && ATTR_SECRET_RE.test(k)) {
        out[k] = this.blankValue(v);
      } else if (lk === "srcset") {
        out[k] = v
          .split(",")
          .map((c) => {
            const t = c.trim();
            const sp = t.search(/\s/);
            return sp < 0 ? this.anyUrl(t) : this.anyUrl(t.slice(0, sp)) + t.slice(sp);
          })
          .join(", ");
      } else if (URL_ATTRS.has(lk)) {
        out[k] = this.scrub(this.anyUrl(v));
      } else if (CSS_ATTRS.has(lk)) {
        out[k] = this.cssText(v);
      } else if (lk.startsWith("data-") && /^\S+$/.test(v) && /[?#]/.test(v)) {
        this.r.urls++;
        out[k] = this.plain(v.slice(0, v.search(/[?#]/)));
      } else {
        out[k] = this.plain(v);
      }
    }
    return out;
  }

  /** `blankText`: inside a contenteditable element, so descendant text is user-typed content. */
  private cleanNode(node: unknown, parent: string, blankText: boolean): unknown {
    if (typeof node === "string") {
      if (parent === "TEXTAREA" || blankText) return this.blankValue(node.trim() === "" ? "" : node);
      if (parent === "STYLE") return this.cssText(node);
      return this.plain(node);
    }
    if (!Array.isArray(node) || node.length === 0 || Array.isArray(node[0])) return node; // back-reference
    const tag = String(node[0]);
    const out: unknown[] = [tag];
    let i = 1;
    let editable = blankText;
    if (isObj(node[1])) {
      out.push(this.cleanAttrs(tag, node[1]));
      const ce = str(node[1].contenteditable);
      if (ce !== undefined && ce.toLowerCase() !== "false") editable = true;
      i = 2;
    }
    for (; i < node.length; i++) out.push(this.cleanNode(node[i], tag, editable));
    return out;
  }

  private cleanSnapshot(s: Obj): Obj | undefined {
    const frameUrl = str(s.frameUrl) ?? "";
    const overrides: Obj[] = [];
    if (Array.isArray(s.resourceOverrides)) {
      for (const o of s.resourceOverrides) {
        if (!isObj(o) || typeof o.url !== "string") continue;
        const url = /^https?:/i.test(o.url) ? this.cleanAbsUrl(o.url) : undefined;
        if (!url) continue;
        const file = str(o.file);
        if (file && SAFE_FILE_RE.test(file) && file.endsWith(".css")) {
          this.keepFiles.add(file);
          this.cssFiles.add(file);
          overrides.push({ url, file });
        } else if (num(o.ref) !== undefined) {
          overrides.push({ url, ref: o.ref });
        }
      }
    }
    const out: Obj = {
      callId: str(s.callId),
      phase: str(s.phase),
      pageId: str(s.pageId),
      frameId: str(s.frameId),
      frameUrl: frameUrl === "about:blank" ? frameUrl : this.cleanAbsUrl(frameUrl),
      html: this.cleanNode(s.html, "", false),
      resourceOverrides: overrides,
      isMainFrame: s.isMainFrame === true,
    };
    if (str(s.doctype) !== undefined) out.doctype = str(s.doctype)!.replace(/[^a-zA-Z0-9]/g, "");
    if (isObj(s.viewport)) out.viewport = { width: num(s.viewport.width) ?? 0, height: num(s.viewport.height) ?? 0 };
    for (const k of ["timestamp", "wallTime", "collectionTime"]) if (num(s[k]) !== undefined) out[k] = s[k];
    return out;
  }

  /** Replaces every string leaf with "[redacted]", keeping arrays and objects so the viewer can still render them. */
  private redactShape(v: unknown, depth = 0): unknown {
    if (typeof v === "string") {
      if (v !== "") this.r.inputValues++;
      return REDACTED;
    }
    if (depth > 6) return REDACTED;
    if (Array.isArray(v)) return v.slice(0, 100).map((x) => this.redactShape(x, depth + 1));
    if (isObj(v)) return Object.fromEntries(Object.entries(v).slice(0, 100).map(([k, x]) => [k, this.redactShape(x, depth + 1)]));
    return typeof v === "number" || typeof v === "boolean" || v === null ? v : undefined;
  }

  private cleanParams(v: unknown, key: string, redactValues: boolean, method: string, depth: number): unknown {
    if (depth > 6) return "[truncated]";
    if (key) {
      if (SERIALIZED_ARG_KEYS.has(key)) {
        if (v !== undefined && v !== null) this.r.inputValues++;
        return { value: { v: "undefined" }, handles: [] };
      }
      const bucket = DROP_PARAMS[key];
      if (bucket) {
        if (v !== undefined && v !== null && v !== "") this.r[bucket]++;
        return REDACTED;
      }
      if (CODE_KEYS.has(key) && !(key === "expression" && method === "expect")) {
        if (v !== undefined && v !== null && v !== "") this.r.inputValues++;
        return REDACTED;
      }
      if (SECRET_KEY_RE.test(key) || (redactValues && VALUE_KEYS.has(key))) return this.redactShape(v);
    }
    if (typeof v === "string") {
      if (URL_PARAM_KEYS.has(key)) return this.txt(this.anyUrl(v), 2000);
      return this.txt(v, 2000);
    }
    if (Array.isArray(v)) return v.slice(0, 100).map((x) => this.cleanParams(x, key, redactValues, method, depth + 1));
    if (isObj(v)) {
      const out: Obj = {};
      for (const [k, x] of Object.entries(v).slice(0, 100)) out[k] = this.cleanParams(x, k.toLowerCase(), redactValues, method, depth + 1);
      return out;
    }
    return typeof v === "number" || typeof v === "boolean" || v === null ? v : undefined;
  }

  /** Call logs echo element HTML (`<input value="...">`) and typed values: blank them. */
  private quoteScrub(s: string, redacted: boolean): string {
    const noValues = s
      .replace(valueAttrRe, (m) => {
        if (m !== 'value=""') this.r.inputValues++;
        return 'value=""';
      })
      .replace(textareaRe, (_m, open: string) => {
        this.r.inputValues++;
        return open;
      })
      .replace(editableRe, (_m, open: string) => {
        this.r.inputValues++;
        return open;
      });
    return redacted ? noValues.replace(quotedRe, `"${REDACTED}"`) : noValues;
  }

  private cleanContextOptions(ev: Obj): Obj {
    const out: Obj = {};
    for (const k of ["type", "version", "origin", "browserName", "channel", "platform", "playwrightVersion", "wallTime", "monotonicTime", "sdkLanguage", "testIdAttributeName", "contextId"]) {
      if (typeof ev[k] === "string" || typeof ev[k] === "number") out[k] = ev[k];
    }
    if (str(ev.title) !== undefined) out.title = this.txt(str(ev.title)!, 200);
    const options = isObj(ev.options) ? ev.options : {};
    const kept: Obj = {};
    for (const k of CONTEXT_OPTION_KEYS) {
      const v = options[k];
      if (typeof v === "string") kept[k] = v.slice(0, 300);
      else if (typeof v === "number" || typeof v === "boolean") kept[k] = v;
      else if (isObj(v)) kept[k] = { width: num(v.width) ?? 0, height: num(v.height) ?? 0 };
    }
    if (str(options.baseURL) !== undefined) kept.baseURL = this.anyUrl(str(options.baseURL)!);
    out.options = kept;
    const state = options.storageState;
    if (isObj(state) && Array.isArray(state.cookies)) this.r.cookies += state.cookies.length;
    if (isObj(options.extraHTTPHeaders)) this.r.headers += Object.keys(options.extraHTTPHeaders).length;
    for (const k of ["httpCredentials", "proxy", "clientCertificates"]) if (options[k] !== undefined) this.r.headers++;
    return out;
  }

  private rel(t: unknown): number | undefined {
    const n = num(t);
    return n === undefined || this.baseTime === undefined ? undefined : Math.round(n - this.baseTime);
  }

  private cleanBefore(ev: Obj): Obj | undefined {
    const callId = str(ev.callId);
    const cls = str(ev.class);
    const method = str(ev.method);
    if (!callId || !cls || !method || cls === "Tracing") return undefined;
    const redacted = this.redactedCalls.has(callId);
    const params = isObj(ev.params) ? ev.params : {};
    const clean = this.cleanParams(params, "", redacted, method, 0) as Obj;
    const title = str(ev.title);
    const out: Obj = { type: "before", callId, startTime: num(ev.startTime) ?? 0, class: cls, method, params: clean };
    if (title !== undefined) out.title = this.txt(this.quoteScrub(title, redacted), 200);
    if (str(ev.stepId)) out.stepId = ev.stepId;
    if (str(ev.parentId)) out.parentId = ev.parentId;

    const step: Obj = { id: callId, title: out.title ?? `${cls}.${method}`, api: `${cls}.${method}` };
    if (str(ev.parentId)) step.parentId = ev.parentId;
    if (typeof clean.selector === "string") step.selector = clean.selector;
    step.params = clean;
    step.startTime = this.rel(ev.startTime) ?? 0;
    this.steps.push(step);
    this.stepById.set(callId, step);
    return out;
  }

  private cleanAfter(ev: Obj): Obj | undefined {
    const callId = str(ev.callId);
    if (!callId || !this.stepById.has(callId)) return undefined;
    const redacted = this.redactedCalls.has(callId);
    const out: Obj = { type: "after", callId, endTime: num(ev.endTime) ?? 0 };
    const step = this.stepById.get(callId)!;
    const end = this.rel(ev.endTime);
    if (end !== undefined && typeof step.startTime === "number") step.durationMs = Math.max(0, end - step.startTime);
    if (isObj(ev.error)) {
      // Value- or code-carrying calls: keep only the first line (the call log can echo values and page data).
      const raw = str(ev.error.message) ?? "error";
      const message = this.txt(this.quoteScrub(redacted ? (raw.split("\n")[0] ?? "error") : raw, redacted), redacted ? 300 : 800);
      out.error = { name: str(ev.error.name) ?? "Error", message };
      step.error = message;
    }
    const allowResult = (v: unknown, depth = 0): boolean =>
      depth < 5 &&
      (v === null ||
        typeof v === "number" ||
        typeof v === "boolean" ||
        (Array.isArray(v) && v.every((x) => allowResult(x, depth + 1))) ||
        (isObj(v) && Object.values(v).every((x) => allowResult(x, depth + 1))));
    if (ev.result !== undefined && allowResult(ev.result)) out.result = ev.result;
    else if (ev.result !== undefined) this.r.bodies++;
    if (num((isObj(ev.point) ? ev.point : {}).x) !== undefined) out.point = ev.point;
    return out;
  }

  private cleanEvent(ev: Obj): Obj | undefined {
    const method = str(ev.method);
    const params = isObj(ev.params) ? ev.params : {};
    const base: Obj = { type: "event", time: num(ev.time) ?? 0, class: "BrowserContext", method };
    const pageId = str(params.pageId);
    const topPageId = str(ev.pageId);
    switch (method) {
      case "page":
      case "pageClosed":
        return { ...base, params: { pageId, ...(str(params.openerPageId) && { openerPageId: params.openerPageId }) } };
      case "dialog": {
        if (str(params.defaultValue)) this.r.inputValues++;
        return { ...base, params: { pageId, type: str(params.type), message: this.txt(str(params.message) ?? "", 300), defaultValue: "" } };
      }
      case "download":
        return { ...base, params: { pageId, url: this.cleanAbsUrl(str(params.url) ?? ""), suggestedFilename: this.txt(str(params.suggestedFilename) ?? "", 100) } };
      case "pageError": {
        const error = isObj(params.error) ? params.error : {};
        const loc = isObj(params.location) ? params.location : {};
        const message = this.txt(str(error.message) ?? "", 300);
        this.pageErrors.push({ timeMs: this.rel(ev.time), message });
        return {
          ...base,
          ...(topPageId && { pageId: topPageId }),
          params: {
            error: { name: str(error.name) ?? "Error", message, stack: "" },
            location: { url: this.cleanAbsUrl(str(loc.url) ?? ""), line: num(loc.line) ?? 0, column: num(loc.column) ?? 0 },
          },
        };
      }
      default:
        return undefined;
    }
  }

  /** Only error and warning text is kept (redacted, 300 chars); other levels keep type and location. Args are dropped. */
  private cleanConsole(ev: Obj): Obj {
    const loc = isObj(ev.location) ? ev.location : {};
    const messageType = str(ev.messageType) ?? "log";
    const keepText = messageType === "error" || messageType === "warning";
    const text = keepText ? this.txt(str(ev.text) ?? "", 300) : "";
    const location: Obj = { url: this.cleanAbsUrl(str(loc.url) ?? ""), lineNumber: num(loc.lineNumber) ?? 0, columnNumber: num(loc.columnNumber) ?? 0 };
    if (keepText) {
      this.consoleErrors.push({ timeMs: this.rel(ev.time), type: messageType, text, ...(location.url ? { location: location.url } : {}) });
    }
    const out: Obj = { type: "console", messageType, text, args: [], location, time: num(ev.time) ?? 0 };
    if (str(ev.pageId)) out.pageId = ev.pageId;
    return out;
  }

  // ---- driver

  clean(buf: Buffer): { files: Map<string, Buffer | string>; names: string[] } {
    const index = readZipIndex(buf);
    const byName = new Map(index.map((e) => [e.name, e]));
    const prefixes = index.map((e) => NAME_RE.exec(e.name)?.[1]).filter((p): p is string => p !== undefined);
    if (!prefixes.length) throw new Error("trace archive has no .trace entry");
    const read = (name: string) => {
      const e = byName.get(name);
      return e ? readZipEntry(buf, e).toString("utf8") : "";
    };
    const parse = (text: string): Obj[] => {
      const out: Obj[] = [];
      for (const line of text.split("\n")) {
        if (!line) continue;
        try {
          const v: unknown = JSON.parse(line);
          if (isObj(v)) out.push(v);
        } catch {
          // an unparseable line is dropped, not copied through
        }
      }
      return out;
    };
    const traces = prefixes.map((p) => ({ prefix: p, trace: parse(read(`${p}.trace`)), network: parse(read(`${p}.network`)) }));

    for (const t of traces) {
      for (const ev of t.trace) {
        if (ev.type === "context-options") {
          this.collectContextOptions(ev);
          const m = num(ev.monotonicTime);
          if (m !== undefined && (this.baseTime === undefined || m < this.baseTime)) this.baseTime = m;
        } else if (ev.type === "frame-snapshot" && isObj(ev.snapshot)) {
          this.collectSnapshot(ev.snapshot);
        }
      }
      for (const ev of t.network) if (ev.type === "resource-snapshot" && isObj(ev.snapshot)) this.collectNetwork(ev.snapshot);
    }
    if (this.baseTime === undefined) {
      for (const t of traces) for (const ev of t.trace) if (ev.type === "before" && num(ev.startTime) !== undefined) this.baseTime = Math.min(this.baseTime ?? Infinity, ev.startTime as number);
    }
    for (const t of traces) {
      for (const ev of t.trace) {
        if (ev.type !== "before") continue;
        if (this.needsValueRedaction(ev)) {
          this.redactedCalls.add(String(ev.callId));
          this.collectCallValues(ev.params, "", 0);
        }
      }
    }
    this.buildScrubber();

    const files = new Map<string, Buffer | string>();
    const names: string[] = [];
    for (const t of traces) {
      const traceLines: string[] = [];
      const networkLines: string[] = [];
      for (const ev of t.trace) {
        let out: Obj | undefined;
        switch (ev.type) {
          case "context-options":
            out = this.cleanContextOptions(ev);
            break;
          case "before":
            out = this.cleanBefore(ev);
            break;
          case "input":
            if (str(ev.callId) && this.stepById.has(ev.callId as string)) {
              out = { type: "input", callId: ev.callId };
              for (const k of ["point", "box"]) if (isObj(ev[k])) out[k] = Object.fromEntries(Object.entries(ev[k]).filter(([, v]) => num(v) !== undefined));
            }
            break;
          case "log": {
            const callId = str(ev.callId);
            if (callId && this.stepById.has(callId) && typeof ev.message === "string") {
              out = { type: "log", callId, time: num(ev.time) ?? -1, message: this.txt(this.quoteScrub(ev.message, this.redactedCalls.has(callId)), 500) };
            }
            break;
          }
          case "after":
            out = this.cleanAfter(ev);
            break;
          case "event":
            out = this.cleanEvent(ev);
            break;
          case "console":
            out = this.cleanConsole(ev);
            break;
          case "frame-snapshot":
            if (isObj(ev.snapshot)) {
              const s = this.cleanSnapshot(ev.snapshot);
              if (s) out = { type: "frame-snapshot", snapshot: s };
            }
            break;
          default:
            break; // screencast-frame, stdout, stderr, error, video, aria-snapshot, screenshot, legacy actions: not carried over
        }
        if (out) traceLines.push(JSON.stringify(out));
      }
      for (const ev of t.network) {
        if (ev.type !== "resource-snapshot" || !isObj(ev.snapshot)) continue;
        const snap = this.cleanNetwork(ev.snapshot);
        if (snap) networkLines.push(JSON.stringify({ type: "resource-snapshot", snapshot: snap }));
      }
      files.set(`${t.prefix}.trace`, traceLines.join("\n") + "\n");
      names.push(`${t.prefix}.trace`);
      files.set(`${t.prefix}.network`, networkLines.join("\n") + (networkLines.length ? "\n" : ""));
      names.push(`${t.prefix}.network`);
    }

    for (const file of [...this.keepFiles].sort()) {
      const e = byName.get(file);
      if (!e) continue;
      const data = readZipEntry(buf, e);
      if (this.cssFiles.has(file)) {
        files.set(file, this.cssText(data.toString("utf8")));
      } else {
        files.set(file, data);
      }
      names.push(file);
    }
    return { files, names };
  }
}

/** Files written by `cleanTrace` get mode 0600; the caller owns the (private) directory. */
export async function cleanTrace(rawZip: string, outZip: string, outSteps: string): Promise<CleanTraceResult> {
  const cleaner = new TraceCleaner();
  const { files, names } = cleaner.clean(await readFile(rawZip));
  const zip = new ZipWriter();
  for (const name of names) {
    const data = files.get(name)!;
    zip.add(name, data, { store: typeof data !== "string" && /\.(jpe?g|png|webp|woff2?|gif)$/i.test(name) });
  }
  const steps = {
    version: 1,
    note: "Redacted summary of the Playwright trace. Times are ms from the start of the browser context.",
    actions: cleaner.steps,
    consoleErrors: cleaner.consoleErrors,
    pageErrors: cleaner.pageErrors,
  };
  await writeFile(outZip, zip.finish(), { mode: 0o600 });
  await chmod(outZip, 0o600);
  await writeFile(outSteps, JSON.stringify(steps, null, 2), { mode: 0o600 });
  await chmod(outSteps, 0o600);
  return { actions: cleaner.steps.length, redactions: { ...cleaner.r } };
}
