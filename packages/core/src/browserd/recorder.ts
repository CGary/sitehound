/**
 * The action log behind `script export`. Each successful state-changing, navigation or wait op of a session is kept
 * (in daemon memory only, the last ACTION_LOG_CAP) with a stable description of the element it acted on, because refs
 * (`aria-ref=e12`) die with the snapshot that made them.
 *
 * What is never recorded: typed or filled values, prompt answers, upload paths (only basenames), page text other than
 * the accessible names that identify controls. URLs are kept whole in memory and exported as origin + path unless the
 * caller asks for the query.
 */
import type { ElementHandle, Locator, Page } from "playwright";
import { stripPathTokens } from "../redact.ts";
import { ACTION_LOG_CAP } from "./limits.ts";
import { RECORDED_OPS, type ExportedAction, type ExportedUrl, type LocatorDesc, type RecordedOp } from "./types.ts";

type Params = Record<string, unknown>;

/** Extra facts an op learned while running (before it acted), for the log. */
export interface OpNotes {
  target?: LocatorDesc;
  to?: LocatorDesc;
  within?: LocatorDesc;
  fileInput?: boolean;
}

interface RawAction {
  seq: number;
  op: RecordedOp;
  before: string;
  after: string;
  goto?: string;
  target?: LocatorDesc;
  to?: LocatorDesc;
  within?: LocatorDesc;
  details: ExportedAction["details"];
}

const RECORDED: ReadonlySet<string> = new Set(RECORDED_OPS);

/** Is this op (with these params) one the log keeps? `tabs list` is not. */
export function isRecorded(op: string, params: Params): op is RecordedOp {
  if (!RECORDED.has(op)) return false;
  return op !== "tabs" || params.action === "select" || params.action === "new" || params.action === "close";
}

const HINT_MAX = 80;
const oneLine = (s: string, max = HINT_MAX): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

interface Facts {
  tag: string;
  /** Explicit role, or the implicit one of common elements ("" when unknown). */
  role: string;
  /** Approximate accessible name (aria-labelledby, aria-label, label, alt, value, text, title); verified by matching, never trusted. */
  name: string;
  label: string;
  placeholder: string;
  text: string;
  testid: string;
  id: string;
  css: string;
  /** The element's document is an iframe's. */
  inFrame: boolean;
}

/**
 * Runs in the page (serialized: no outside references): what the element says about itself, plus a unique `#id` and a
 * short structural CSS path. Never takes an aria snapshot: that would replace the page's ref map and kill every ref.
 */
function elementFacts(el: Element, formOp: boolean): Facts {
  const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  const CAP = 200;
  const uniqueId = (e: Element) => e.id !== "" && e.id.length <= CAP && document.querySelectorAll(`#${CSS.escape(e.id)}`).length === 1;
  /** Text of an element without the form controls inside it (a <label> wrapping its <select> must not include the options). */
  const ownText = (e: Element) => {
    const copy = e.cloneNode(true) as Element;
    copy.querySelectorAll("input, select, textarea, button, script, style").forEach((c) => c.remove());
    return clean(copy.textContent);
  };
  const tag = el.tagName.toLowerCase();
  const type = el instanceof HTMLInputElement ? el.type : "";
  const explicit = clean(el.getAttribute("role")).split(" ")[0] ?? "";
  // Anything the user can type into: its text (innerText of an editor) is what they typed, never a name. Also whatever a fill/type/check/select/press targeted.
  const editable = formOp || (el as HTMLElement).isContentEditable === true || ["textbox", "searchbox", "combobox", "spinbutton"].includes(explicit);
  const implicit = (() => {
    if (tag === "button" || ["button", "submit", "reset", "image"].includes(type)) return "button";
    if (tag === "a" && el.hasAttribute("href")) return "link";
    if (tag === "textarea") return "textbox";
    if (tag === "select") return (el as HTMLSelectElement).multiple || (el as HTMLSelectElement).size > 1 ? "listbox" : "combobox";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "img") return el.getAttribute("alt") === "" ? "" : "img";
    if (tag === "input") {
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      if (type === "number") return "spinbutton";
      if (type === "search") return el.hasAttribute("list") ? "combobox" : "searchbox";
      if (["", "text", "email", "tel", "url", "password"].includes(type)) return el.hasAttribute("list") ? "combobox" : "textbox";
      return "";
    }
    if (tag === "option") return "option";
    if (tag === "summary") return "";
    return "";
  })();
  const labels = "labels" in el && (el as HTMLInputElement).labels ? Array.from((el as HTMLInputElement).labels ?? []).map(ownText).filter((l) => l !== "") : [];
  const labelledBy = clean(el.getAttribute("aria-labelledby"))
    .split(" ")
    .filter(Boolean)
    .map((id) => document.getElementById(id))
    // A field labelled by itself (or by something inside it) would name itself with its own content.
    .map((l) => (l && !(editable && (l === el || el.contains(l) || l.contains(el))) ? clean(l.textContent) : ""))
    .filter(Boolean)
    .join(" ");
  const ariaLabel = clean(el.getAttribute("aria-label"));
  const text = editable ? "" : clean(el instanceof HTMLElement ? el.innerText : el.textContent);
  const value = type === "submit" || type === "button" || type === "reset" ? clean((el as HTMLInputElement).value) : "";
  const isField = editable || tag === "input" || tag === "select" || tag === "textarea";
  const name =
    labelledBy ||
    ariaLabel ||
    (isField ? labels.join(" ") : "") ||
    (tag === "img" ? clean(el.getAttribute("alt")) : "") ||
    value ||
    (isField ? "" : text) ||
    clean(el.getAttribute("title")) ||
    (isField ? clean(el.getAttribute("placeholder")) : "");
  const parts: string[] = [];
  let cur: Element | null = el;
  for (let i = 0; i < 6 && cur && cur !== document.documentElement && cur !== document.body; i++) {
    if (i > 0 && uniqueId(cur)) {
      parts.unshift(`#${CSS.escape(cur.id)}`);
      break;
    }
    const node: Element = cur;
    const parent: Element | null = node.parentElement;
    const same = parent ? Array.from(parent.children).filter((c) => c.tagName === node.tagName) : [];
    const t = node.tagName.toLowerCase();
    parts.unshift(same.length > 1 ? `${t}:nth-of-type(${same.indexOf(node) + 1})` : t);
    cur = parent;
  }
  // Long values are not stable locators and a hostile page could make the log huge: candidates over the cap are dropped.
  const capped = (s: string, max = CAP) => (s.length <= max ? s : "");
  const css = parts.join(" > ");
  const idCss = uniqueId(el) ? `#${CSS.escape(el.id)}` : "";
  return {
    tag,
    role: explicit || implicit,
    name: capped(name),
    label: capped(ariaLabel || labels[0] || ""),
    placeholder: capped(clean(el.getAttribute("placeholder"))),
    text: capped(text, 80),
    testid: capped(el.getAttribute("data-testid") ?? ""),
    id: capped(idCss),
    css: capped(css),
    inFrame: window.top !== window,
  };
}

const race = <T>(work: Promise<T>, ms: number): Promise<T | undefined> => {
  let timer: NodeJS.Timeout | undefined;
  work.catch(() => {});
  return Promise.race([work, new Promise<undefined>((r) => (timer = setTimeout(() => r(undefined), Math.max(1, ms))))]).finally(() => clearTimeout(timer));
};

/**
 * A stable description of the element `loc` (resolved from `ref`) that finds exactly that element again: the first
 * candidate whose `count()` is 1 and whose match is the same element. Bounded by `budgetMs`; never throws.
 */
export async function describeTarget(pg: Page, loc: Locator, ref: string, budgetMs: number, formOp = false): Promise<LocatorDesc> {
  let frame = false;
  const none = (why: string): LocatorDesc => ({ kind: "none", ambiguous: true, hint: why, ...(frame ? { frame: true } : {}) });
  if (budgetMs < 50) return none(`element ${ref} (not described in time)`);
  const t0 = Date.now();
  const left = () => Math.max(1, budgetMs - (Date.now() - t0));
  const work = async (): Promise<LocatorDesc> => {
    let handle: ElementHandle | null = null;
    try {
      handle = await loc.elementHandle({ timeout: left() });
      if (!handle) return none(`element ${ref}`);
      const target = handle;
      const facts = await target.evaluate(elementFacts, formOp);
      const { role, name } = facts;
      frame = facts.inFrame;
      const hint = oneLine(role && name ? `${role} "${name}"` : role ? role : facts.label || facts.placeholder || facts.text ? `${facts.tag} "${facts.label || facts.placeholder || facts.text}"` : facts.tag);
      const candidates: { desc: Omit<LocatorDesc, "hint">; loc: () => Locator }[] = [];
      if (facts.testid) candidates.push({ desc: { kind: "testid", value: facts.testid }, loc: () => pg.getByTestId(facts.testid) });
      if (role && name) candidates.push({ desc: { kind: "role", role, value: name }, loc: () => pg.getByRole(role as Parameters<Page["getByRole"]>[0], { name, exact: true }) });
      if (facts.label) candidates.push({ desc: { kind: "label", value: facts.label }, loc: () => pg.getByLabel(facts.label, { exact: true }) });
      if (facts.placeholder) candidates.push({ desc: { kind: "placeholder", value: facts.placeholder }, loc: () => pg.getByPlaceholder(facts.placeholder, { exact: true }) });
      if (facts.text) candidates.push({ desc: { kind: "text", value: facts.text }, loc: () => pg.getByText(facts.text, { exact: true }) });
      if (facts.id) candidates.push({ desc: { kind: "css", value: facts.id }, loc: () => pg.locator(facts.id) });
      if (facts.css) candidates.push({ desc: { kind: "css", value: facts.css }, loc: () => pg.locator(facts.css) });
      let fallback: LocatorDesc | undefined;
      for (const c of candidates) {
        if (Date.now() - t0 >= budgetMs) break;
        try {
          const l = c.loc();
          const n = await l.count();
          if (n === 1 && (await l.evaluate((el, t) => el === t, target, { timeout: left() }))) return { ...c.desc, hint, ...(frame ? { frame: true } : {}) };
          if (n > 1 && !fallback) {
            const at = await l.evaluateAll((els, t) => (els as Element[]).indexOf(t as unknown as Element), target);
            if (at >= 0) fallback = { ...c.desc, nth: at, ambiguous: true, hint, ...(frame ? { frame: true } : {}) };
          }
        } catch {
          // an unusable candidate (e.g. a role Playwright does not know): try the next one
        }
      }
      return fallback ?? none(hint);
    } finally {
      if (handle) void (handle as ElementHandle).dispose().catch(() => {});
    }
  };
  try {
    return (await race(work(), budgetMs)) ?? none(`element ${ref} (not described in time)`);
  } catch {
    return none(`element ${ref}`);
  }
}

/** A URL as `script export` writes it (see ExportedUrl). Credentials are always dropped. */
export function exportUrl(href: string, includeQuery: boolean): ExportedUrl {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return { url: "about:blank", path: "", masked: false };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { url: href === "about:blank" ? href : "about:blank", path: "", masked: false };
  u.username = "";
  u.password = "";
  // Token-like path segments are masked even with the query kept: `--include-query` is about the query string only.
  const path = stripPathTokens(u.pathname);
  return { url: u.origin + path + (includeQuery ? u.search + u.hash : ""), path, masked: path !== u.pathname };
}

/**
 * A `page wait --for url|request` value as exported: a glob, substring or whole URL, so only its text is cleaned: credentials, the
 * query and fragment (unless `includeQuery`) and token-like path segments are removed.
 */
export function exportWaitValue(value: string, includeQuery: boolean): string {
  const cut = value.search(/[?#]/);
  const base = (cut === -1 ? value : value.slice(0, cut)).replace(/^(https?:\/\/)[^/@]*@/i, "$1");
  return stripPathTokens(base) + (includeQuery && cut !== -1 ? value.slice(cut) : "");
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const int = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Only the non-secret parts of an op's params and result. Values, prompt answers and paths are never copied. */
function details(op: RecordedOp, p: Params, result: Record<string, unknown>, notes: OpNotes): ExportedAction["details"] {
  const d: ExportedAction["details"] = {};
  const set = (k: string, v: string | number | boolean | string[] | undefined) => {
    if (v !== undefined) d[k] = v;
  };
  if (p.dialog === "accept" || p.dialog === "dismiss") set("dialog", p.dialog);
  if (typeof p.dialogText === "string") set("dialogText", true);
  switch (op) {
    case "navigate":
      set("waitUntil", str(p.waitUntil));
      break;
    case "click":
      set("count", int(p.count));
      set("button", str(p.button));
      if (Array.isArray(p.modifiers)) set("modifiers", p.modifiers.filter((m): m is string => typeof m === "string"));
      break;
    case "type":
      set("delayMs", int(p.delayMs));
      if (p.clear === true) set("clear", true);
      break;
    case "select":
      if (Array.isArray(result.selected)) set("options", (p.options as unknown[]).filter((o): o is string => typeof o === "string"));
      break;
    case "press":
      set("key", str(p.key));
      break;
    case "check":
      set("checked", p.checked === true);
      break;
    case "drag":
      set("method", str(result.method));
      set("steps", int(p.steps));
      break;
    case "upload":
      if (Array.isArray(result.files)) set("files", (result.files as { name?: unknown }[]).map((f) => String(f.name ?? "file")));
      set("fileInput", notes.fileInput === true);
      break;
    case "tabs":
      set("action", str(p.action));
      set("tabIndex", int(p.tabIndex));
      break;
    case "wait":
      set("for", str(p.for));
      if (p.for !== "ref" && p.for !== "ref-hidden") set("value", str(p.value));
      set("method", str(p.method));
      break;
    case "resize":
      set("width", int(p.width));
      set("height", int(p.height));
      break;
    case "emulate":
      set("colorScheme", str(p.colorScheme));
      set("media", str(p.media));
      set("reducedMotion", str(p.reducedMotion));
      if (p.reset === true) set("reset", true);
      break;
    default:
      break;
  }
  return d;
}

/** The bounded per-session log. */
export class ActionLog {
  private readonly ring: RawAction[] = [];
  private seq = 0;

  record(op: RecordedOp, params: Params, result: unknown, notes: OpNotes, before: string, after: string): void {
    const res = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
    const goto = op === "navigate" || (op === "tabs" && params.action === "new") ? str(params.url) : undefined;
    this.ring.push({
      seq: ++this.seq,
      op,
      before,
      after,
      ...(goto ? { goto } : {}),
      ...(notes.target ? { target: notes.target } : {}),
      ...(notes.to ? { to: notes.to } : {}),
      ...(notes.within ? { within: notes.within } : {}),
      details: details(op, params, res, notes),
    });
    if (this.ring.length > ACTION_LOG_CAP) this.ring.splice(0, this.ring.length - ACTION_LOG_CAP);
  }

  export(includeQuery: boolean): { actions: ExportedAction[]; recorded: number; dropped: number } {
    const actions = this.ring.map((a) => ({
      seq: a.seq,
      op: a.op,
      before: exportUrl(a.before, includeQuery),
      after: exportUrl(a.after, includeQuery),
      ...(a.goto ? { goto: exportUrl(a.goto, includeQuery) } : {}),
      ...(a.target ? { target: a.target } : {}),
      ...(a.to ? { to: a.to } : {}),
      ...(a.within ? { within: a.within } : {}),
      details: a.op === "wait" && (a.details.for === "url" || a.details.for === "request") && typeof a.details.value === "string" ? { ...a.details, value: exportWaitValue(a.details.value, includeQuery) } : a.details,
    }));
    return { actions, recorded: this.seq, dropped: this.seq - this.ring.length };
  }
}
