import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "playwright";

export type ElementState = "hover" | "focus";

export interface ElementCaptureOptions {
  /** Prepended to every file name, e.g. `"1280/"` (the directory must already exist). */
  prefix?: string;
  /** Extra interaction states to capture besides the base state. */
  states?: ElementState[];
}

export interface ElementCapture {
  screenshot: string;
  html: string;
  styles: string;
  assets: string;
  /** Per-state files, keyed by state name. */
  states: Partial<Record<ElementState, { screenshot: string; styles: string }>>;
}

const MAX_NODES = 300;
const STATE_SETTLE_MS = 400;

/** One captured node: everything needed to compare states, computed in the page. */
interface RawStyleMap {
  [property: string]: string;
}
interface RawNode {
  /** Full ancestor chain; only used to match nodes across states. */
  path: string;
  /** This node's own short selector: tag#id.class:nth-child(n). */
  selector: string;
  tag: string;
  classes: string[];
  box: { x: number; y: number; width: number; height: number };
  style: RawStyleMap;
  /** Pseudo-element styles, present only when `content` is not none/normal. */
  pseudo: { "::before"?: RawStyleMap; "::after"?: RawStyleMap };
}
interface RawSnapshot {
  nodes: RawNode[];
  totalNodes: number;
  /** Default computed styles per tag (a bare element in a clean iframe). */
  defaults: Record<string, RawStyleMap>;
  pseudoDefault: RawStyleMap;
  inherited: string[];
}

/**
 * Runs in the page. Kept as a plain string so the TS loader cannot inject helper calls
 * (e.g. `__name`) that do not exist in the browser context.
 */
const SNAPSHOT_SCRIPT = `(function (root, maxNodes) {
  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1 };
  // Layout-derived values are covered by the bounding box; logical props duplicate physical ones.
  var SKIP_EXACT = { "-webkit-locale": 1, "width": 1, "height": 1, "perspective-origin": 1, "transform-origin": 1,
    "inline-size": 1, "block-size": 1, "min-inline-size": 1, "min-block-size": 1,
    "max-inline-size": 1, "max-block-size": 1 };
  var INHERITED = ["color", "cursor", "direction", "font", "font-family", "font-size", "font-style",
    "font-variant", "font-weight", "font-stretch", "font-feature-settings", "font-kerning",
    "letter-spacing", "line-height", "list-style", "list-style-type", "list-style-position",
    "list-style-image", "text-align", "text-indent", "text-transform", "text-shadow",
    "text-rendering", "white-space", "word-break", "word-spacing", "overflow-wrap", "tab-size",
    "visibility", "quotes", "border-collapse", "border-spacing", "caption-side", "fill", "stroke",
    "stroke-width", "fill-opacity", "stroke-opacity", "pointer-events", "text-decoration-skip-ink",
    "-webkit-text-fill-color", "-webkit-text-stroke-color", "-webkit-text-stroke-width",
    "font-synthesis", "font-optical-sizing", "text-wrap", "color-scheme", "accent-color",
    "caret-color", "user-select", "text-size-adjust", "-webkit-font-smoothing",
    "-webkit-tap-highlight-color", "-webkit-text-size-adjust"];

  function keep(prop) {
    if (SKIP_EXACT[prop]) return false;
    if (prop.indexOf("-inline-") !== -1 || prop.indexOf("-block-") !== -1) return false;
    if (/^(inline|block)-/.test(prop)) return false;
    if (/^(inset|margin|padding|border|scroll-margin|scroll-padding)-(inline|block)/.test(prop)) return false;
    if (/^(border)-(start|end)/.test(prop)) return false;
    return true;
  }
  function toMap(cs) {
    var out = {};
    for (var i = 0; i < cs.length; i++) {
      var p = cs[i];
      if (keep(p)) out[p] = cs.getPropertyValue(p);
    }
    return out;
  }
  function classesOf(el) {
    var c = el.getAttribute("class");
    return c ? c.trim().split(/\\s+/).filter(Boolean).slice(0, 8) : [];
  }
  function segment(el, isRoot) {
    var s = el.localName;
    if (el.id && /^[A-Za-z][\\w-]*$/.test(el.id)) s += "#" + el.id;
    var cls = classesOf(el).filter(function (c) { return /^[A-Za-z_][\\w-]*$/.test(c); }).slice(0, 2);
    if (cls.length) s += "." + cls.join(".");
    if (!isRoot && el.parentElement) {
      var idx = 1, sib = el;
      while ((sib = sib.previousElementSibling)) idx++;
      s += ":nth-child(" + idx + ")";
    }
    return s;
  }

  // Defaults come from a hidden same-origin iframe with no author styles.
  var iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.cssText = "position:fixed;left:-99999px;top:0;width:1280px;height:800px;visibility:hidden;border:0";
  document.documentElement.appendChild(iframe);
  var idoc = iframe.contentDocument;
  var defaults = {};
  function defaultFor(el) {
    var key = (el.namespaceURI || "") + "|" + el.localName;
    if (defaults[key]) return key;
    var probe = el.namespaceURI === "http://www.w3.org/2000/svg"
      ? idoc.createElementNS(el.namespaceURI, el.localName)
      : idoc.createElement(el.localName);
    var host = idoc.body;
    if (el.namespaceURI === "http://www.w3.org/2000/svg") {
      var svg = idoc.createElementNS(el.namespaceURI, "svg");
      host.appendChild(svg);
      host = svg;
    }
    host.appendChild(probe);
    defaults[key] = toMap(iframe.contentWindow.getComputedStyle(probe));
    host.removeChild(probe);
    return key;
  }
  var tagKey = {};
  var nodes = [];
  var all = [root].concat(Array.prototype.slice.call(root.querySelectorAll("*")));
  var pathOf = new Map();
  var total = 0;
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    if (SKIP_TAGS[el.tagName]) continue;
    total++;
    if (nodes.length >= maxNodes) continue;
    var parentPath = el === root ? "" : pathOf.get(el.parentElement);
    var path = (parentPath ? parentPath + " > " : "") + segment(el, el === root);
    pathOf.set(el, path);
    var key = defaultFor(el);
    var r = el.getBoundingClientRect();
    var node = {
      path: path,
      selector: segment(el, el === root),
      tag: el.localName,
      classes: classesOf(el),
      box: { x: Math.round(r.x * 10) / 10, y: Math.round(r.y * 10) / 10,
             width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10 },
      style: toMap(getComputedStyle(el)),
      pseudo: {}
    };
    tagKey[el.localName] = key;
    ["::before", "::after"].forEach(function (pe) {
      var ps = getComputedStyle(el, pe);
      var content = ps.getPropertyValue("content");
      if (content && content !== "none" && content !== "normal") node.pseudo[pe] = toMap(ps);
    });
    nodes.push(node);
  }
  var pseudoKey = defaultFor({ namespaceURI: "http://www.w3.org/1999/xhtml", localName: "span" });
  var out = { nodes: nodes, totalNodes: total, defaults: {}, pseudoDefault: defaults[pseudoKey], inherited: INHERITED };
  Object.keys(tagKey).forEach(function (t) { out.defaults[t] = defaults[tagKey[t]]; });
  iframe.remove();
  return out;
})`;

const ASSETS_SCRIPT = `(function (root) {
  function clean(raw, base) {
    if (!raw) return null;
    raw = String(raw).trim();
    if (!raw) return null;
    if (/^data:/i.test(raw)) {
      var m = /^data:([^;,]*)/i.exec(raw);
      return "data:" + (m && m[1] ? m[1] : "") + " (inline, " + raw.length + " chars)";
    }
    if (/^blob:/i.test(raw)) return "blob:";
    try {
      var u = new URL(raw, base || document.baseURI);
      u.search = ""; u.hash = ""; u.username = ""; u.password = "";
      return u.toString();
    } catch (e) {
      return raw.split(/[?#]/)[0];
    }
  }
  function splitSrcset(srcset) {
    // Candidates are "url [descriptor]" separated by commas; data: URLs may contain commas.
    var out = [];
    String(srcset || "").split(/,\\s+|,(?=[^\\s,]+\\s+\\d)|\\s*,\\s*(?=https?:|\\/|\\.)/).forEach(function (part) {
      var p = part.trim();
      if (!p) return;
      var bits = p.split(/\\s+/);
      var url = clean(bits[0]);
      if (url) out.push(bits.length > 1 ? { url: url, descriptor: bits.slice(1).join(" ") } : { url: url });
    });
    return out;
  }
  function cssUrls(value) {
    var out = [], re = /url\\(\\s*(["']?)(.*?)\\1\\s*\\)/g, m;
    while ((m = re.exec(value || ""))) { var c = clean(m[2]); if (c) out.push(c); }
    return out;
  }

  var all = [root].concat(Array.prototype.slice.call(root.querySelectorAll("*")));
  var images = [], pictureSources = [], media = [], cssImages = [], svgInline = 0, svgUse = [];
  var families = {};
  var CSS_IMAGE_PROPS = ["background-image", "list-style-image", "border-image-source", "mask-image", "-webkit-mask-image", "content"];

  all.forEach(function (el) {
    var tag = el.localName;
    if (tag === "img") {
      images.push({
        src: clean(el.currentSrc || el.getAttribute("src")),
        srcset: splitSrcset(el.getAttribute("srcset")),
        alt: el.getAttribute("alt") || undefined,
        naturalSize: el.naturalWidth ? [el.naturalWidth, el.naturalHeight] : undefined
      });
    } else if (tag === "source" && el.parentElement) {
      var pt = el.parentElement.localName;
      if (pt === "picture") {
        pictureSources.push({ srcset: splitSrcset(el.getAttribute("srcset")), media: el.getAttribute("media") || undefined, type: el.getAttribute("type") || undefined });
      } else if (pt === "video" || pt === "audio") {
        media.push({ kind: pt, src: clean(el.getAttribute("src")), type: el.getAttribute("type") || undefined });
      }
    } else if (tag === "video" || tag === "audio") {
      media.push({ kind: tag, src: clean(el.currentSrc || el.getAttribute("src")), poster: clean(el.getAttribute("poster")) || undefined });
    } else if (tag === "svg" && !(el.parentElement && el.parentElement.closest("svg"))) {
      svgInline++;
    } else if (tag === "use" || tag === "image") {
      var h = el.getAttribute("href") || el.getAttribute("xlink:href");
      if (h && h.charAt(0) !== "#") svgUse.push(clean(h));
    } else if (tag === "link" || tag === "object" || tag === "embed" || tag === "iframe") {
      // not part of visual assets
    }
    var cs = getComputedStyle(el);
    CSS_IMAGE_PROPS.forEach(function (p) {
      cssUrls(cs.getPropertyValue(p)).forEach(function (u) { cssImages.push({ property: p, url: u }); });
    });
    ["::before", "::after"].forEach(function (pe) {
      var ps = getComputedStyle(el, pe);
      var content = ps.getPropertyValue("content");
      if (!content || content === "none" || content === "normal") return;
      CSS_IMAGE_PROPS.forEach(function (p) {
        cssUrls(ps.getPropertyValue(p)).forEach(function (u) { cssImages.push({ property: pe + " " + p, url: u }); });
      });
    });
    var ff = cs.getPropertyValue("font-family");
    ff.split(",").forEach(function (f) {
      var n = f.trim().replace(/^["']|["']$/g, "");
      if (n) families[n.toLowerCase()] = n;
    });
  });

  function uniq(arr) {
    var seen = {}, out = [];
    arr.forEach(function (x) { var k = JSON.stringify(x); if (!seen[k]) { seen[k] = 1; out.push(x); } });
    return out;
  }

  // @font-face sources from readable stylesheets.
  var faceRules = [], unreadable = 0;
  function walk(rules, sheet) {
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      if (r.type === 5) { // CSSFontFaceRule
        var src = r.style.getPropertyValue("src");
        var base = (sheet && sheet.href) || document.baseURI;
        var urls = [], re = /url\\(\\s*(["']?)(.*?)\\1\\s*\\)/g, m;
        while ((m = re.exec(src))) { var c = clean(m[2], base); if (c) urls.push(c); }
        faceRules.push({
          family: r.style.getPropertyValue("font-family").trim().replace(/^["']|["']$/g, ""),
          weight: r.style.getPropertyValue("font-weight").trim() || "normal",
          style: r.style.getPropertyValue("font-style").trim() || "normal",
          urls: urls
        });
      } else if (r.type === 3 && r.styleSheet) { // @import
        try { walk(r.styleSheet.cssRules, r.styleSheet); } catch (e) { unreadable++; }
      } else if (r.cssRules) {
        walk(r.cssRules, sheet);
      }
    }
  }
  Array.prototype.forEach.call(document.styleSheets, function (sheet) {
    try { walk(sheet.cssRules, sheet); } catch (e) { unreadable++; }
  });

  var loaded = [];
  document.fonts.forEach(function (face) {
    var fam = face.family.replace(/^["']|["']$/g, "");
    if (face.status !== "loaded" || !families[fam.toLowerCase()]) return;
    var rule = faceRules.filter(function (r) {
      return r.family.toLowerCase() === fam.toLowerCase() && r.weight === face.weight && r.style === face.style;
    })[0] || faceRules.filter(function (r) { return r.family.toLowerCase() === fam.toLowerCase(); })[0];
    loaded.push({ family: fam, weight: face.weight, style: face.style, sources: rule ? rule.urls : [] });
  });
  var loadedNames = {};
  loaded.forEach(function (f) { loadedNames[f.family.toLowerCase()] = 1; });

  return {
    images: uniq(images),
    pictureSources: uniq(pictureSources),
    media: uniq(media),
    svgInline: svgInline,
    svgReferences: uniq(svgUse),
    cssImages: uniq(cssImages),
    fonts: {
      familiesInUse: Object.keys(families).map(function (k) { return families[k]; }),
      loadedWebFonts: uniq(loaded),
      familiesWithoutLoadedWebFont: Object.keys(families).filter(function (k) { return !loadedNames[k]; }).map(function (k) { return families[k]; }),
      unreadableStylesheets: unreadable
    }
  };
})`;

/** Properties whose initial value is `currentcolor`: redundant while they equal the node's `color`. */
const CURRENT_COLOR_PROPS = new Set([
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "outline-color",
  "column-rule-color",
  "row-rule-color",
  "text-decoration-color",
  "text-emphasis-color",
  "-webkit-text-stroke-color",
]);

function diffFromDefault(
  style: RawStyleMap,
  base: RawStyleMap | undefined,
  parent: RawStyleMap | undefined,
  inherited: Set<string>,
): RawStyleMap {
  const out: RawStyleMap = {};
  for (const [prop, value] of Object.entries(style)) {
    // Custom properties inherit: the root's are listed once at the top level.
    if (prop.startsWith("--")) {
      if (parent && parent[prop] !== value) out[prop] = value;
      continue;
    }
    if (base && base[prop] === value) continue;
    if (CURRENT_COLOR_PROPS.has(prop) && value === style.color) continue;
    // Inherited values equal to the parent's are noise: the cascade already carries them.
    if (parent && inherited.has(prop) && parent[prop] === value) continue;
    out[prop] = value;
  }
  return out;
}

function rootCustomProperties(snap: RawSnapshot): RawStyleMap {
  const root = snap.nodes[0];
  const out: RawStyleMap = {};
  for (const [k, v] of Object.entries(root?.style ?? {})) if (k.startsWith("--") && v.trim() !== "") out[k] = v.trim();
  return out;
}

function buildStyles(snap: RawSnapshot) {
  const inherited = new Set(snap.inherited);
  const byPath = new Map<string, RawNode>();
  for (const n of snap.nodes) byPath.set(n.path, n);
  const parentOf = (path: string) => {
    const i = path.lastIndexOf(" > ");
    return i === -1 ? undefined : byPath.get(path.slice(0, i));
  };
  const idOf = new Map(snap.nodes.map((n, i) => [n.path, i]));
  return snap.nodes.map((n, id) => {
    const parent = parentOf(n.path);
    const entry: Record<string, unknown> = {
      id,
      parent: parent ? (idOf.get(parent.path) ?? null) : null,
      selector: n.selector,
      tag: n.tag,
      classes: n.classes,
      box: n.box,
      styles: diffFromDefault(n.style, snap.defaults[n.tag], parent?.style, inherited),
    };
    const pseudo: Record<string, RawStyleMap> = {};
    for (const [pe, map] of Object.entries(n.pseudo)) {
      pseudo[pe] = diffFromDefault(map, snap.pseudoDefault, n.style, inherited);
    }
    if (Object.keys(pseudo).length) entry.pseudo = pseudo;
    return entry;
  });
}

const MAX_CUSTOM_PROPERTIES = 500;

/** Pretty-prints top-level keys but keeps each array item / flat map entry on one line. */
function toJson(top: Record<string, unknown>): string {
  const parts = Object.entries(top).map(([k, v]) => {
    const key = JSON.stringify(k);
    if (Array.isArray(v)) {
      return v.length ? `  ${key}: [\n${v.map((x) => `    ${JSON.stringify(x)}`).join(",\n")}\n  ]` : `  ${key}: []`;
    }
    if (v && typeof v === "object" && Object.values(v).every((x) => typeof x === "string")) {
      const entries = Object.entries(v);
      return entries.length
        ? `  ${key}: {\n${entries.map(([a, b]) => `    ${JSON.stringify(a)}: ${JSON.stringify(b)}`).join(",\n")}\n  }`
        : `  ${key}: {}`;
    }
    return `  ${key}: ${JSON.stringify(v)}`;
  });
  return `{\n${parts.join(",\n")}\n}\n`;
}

type Change = { from: string | null; to: string | null };

function diffMaps(a: RawStyleMap | undefined, b: RawStyleMap | undefined): Record<string, Change> {
  const out: Record<string, Change> = {};
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const k of keys) {
    const from = a?.[k] ?? null;
    const to = b?.[k] ?? null;
    if (from !== to) out[k] = { from, to };
  }
  return out;
}

function buildStateDiff(base: RawSnapshot, state: RawSnapshot) {
  const baseByPath = new Map(base.nodes.map((n) => [n.path, n]));
  const idOf = new Map(base.nodes.map((n, i) => [n.path, i]));
  const stateByPath = new Map(state.nodes.map((n) => [n.path, n]));
  const changes: Record<string, unknown>[] = [];
  for (const b of base.nodes) {
    const s = stateByPath.get(b.path);
    if (!s) {
      changes.push({ id: idOf.get(b.path), selector: b.selector, removed: true });
      continue;
    }
    const entry: Record<string, unknown> = { id: idOf.get(b.path), selector: b.selector };
    const styles = diffMaps(b.style, s.style);
    const colorChange = styles.color;
    if (colorChange) {
      // currentcolor-derived props that merely follow `color` are noise.
      for (const p of [...CURRENT_COLOR_PROPS, "caret-color", "-webkit-text-fill-color"]) {
        const c = styles[p];
        if (c && c.from === colorChange.from && c.to === colorChange.to) delete styles[p];
      }
    }
    if (Object.keys(styles).length) entry.changed = styles;
    const pseudo: Record<string, Record<string, Change>> = {};
    for (const pe of ["::before", "::after"] as const) {
      const d = diffMaps(b.pseudo[pe], s.pseudo[pe]);
      if (Object.keys(d).length) pseudo[pe] = d;
    }
    if (Object.keys(pseudo).length) entry.pseudo = pseudo;
    const box = ["x", "y", "width", "height"].some(
      (k) => b.box[k as keyof typeof b.box] !== s.box[k as keyof typeof s.box],
    );
    if (box) entry.box = { from: b.box, to: s.box };
    if (Object.keys(entry).length > 2) changes.push(entry);
  }
  for (const s of state.nodes) {
    if (!baseByPath.has(s.path)) changes.push({ selector: s.selector, added: true, box: s.box });
  }
  return changes;
}

async function writePrivate(path: string, data: string): Promise<string> {
  await writeFile(path, data, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

/**
 * Playwright serializes functions with `toString()`. Building them from the constant sources
 * above keeps the loader's `__name` helpers out of the browser-side code and needs no eval there.
 */
const snapshotFn = new Function(`return ${SNAPSHOT_SCRIPT}`)() as (root: Element, max: number) => RawSnapshot;
const assetsFn = new Function(`return ${ASSETS_SCRIPT}`)() as (root: Element) => unknown;

async function snapshot(target: Locator): Promise<RawSnapshot> {
  return target.evaluate(snapshotFn, MAX_NODES);
}

async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(STATE_SETTLE_MS);
}

/**
 * Captures what an agent needs to imitate or improve the FIRST element matching `selector`:
 * screenshot, outerHTML, computed styles (only non-default values), used assets (URLs
 * stripped of query/fragment) and, optionally, hover/focus state screenshots and style diffs.
 * Throws if the element does not exist or is not visible. Never logs page content.
 */
export async function captureElement(
  page: Page,
  selector: string,
  outDir: string,
  opts: ElementCaptureOptions = {},
): Promise<ElementCapture> {
  const prefix = opts.prefix ?? "";
  const states = [...new Set(opts.states ?? [])];
  const loc = page.locator(selector);
  if ((await loc.count()) === 0) throw new Error(`No element matches selector: ${selector}`);
  const target = loc.first();
  if (!(await target.isVisible())) throw new Error(`First element matching selector is not visible: ${selector}`);

  const files: ElementCapture = {
    screenshot: join(outDir, `${prefix}element.png`),
    html: join(outDir, `${prefix}element.html`),
    styles: join(outDir, `${prefix}styles.json`),
    assets: join(outDir, `${prefix}assets.json`),
    states: {},
  };

  await target.screenshot({ path: files.screenshot });
  await chmod(files.screenshot, 0o600);
  await writePrivate(files.html, await target.evaluate((el) => el.outerHTML));

  const base = await snapshot(target);
  const allCustom = rootCustomProperties(base);
  const customNames = Object.keys(allCustom);
  const customProps = {
    customPropertiesTotal: customNames.length,
    customProperties: Object.fromEntries(customNames.slice(0, MAX_CUSTOM_PROPERTIES).map((k) => [k, allCustom[k] ?? ""])),
  };
  const styles = {
    url: new URL(page.url()).origin + new URL(page.url()).pathname,
    selector,
    viewport: page.viewportSize(),
    nodeCount: base.nodes.length,
    totalNodes: base.totalNodes,
    truncated: base.totalNodes > base.nodes.length,
    notes: [
      "styles lists only computed properties that differ from the browser default for that tag.",
      "Inherited properties (color, font-*, line-height, ...) are also omitted when equal to the parent's value.",
      "width/height and logical (inline/block) properties are omitted; see box for layout.",
      "Property names starting with -- are custom properties: customProperties holds the root's, nodes list only those that differ from their parent.",
      "Border/outline/text-decoration colors equal to the node's color (currentcolor) are omitted.",
      "pseudo holds ::before/::after styles for elements whose content is not none.",
      `nodes form a tree: parent is the id of the parent node (null for the root); selector is the node's own segment. customProperties is capped at ${MAX_CUSTOM_PROPERTIES} entries (customPropertiesTotal has the real count).`,
    ],
    ...customProps,
    nodes: buildStyles(base),
  };
  await writePrivate(files.styles, toJson(styles));

  const assets = await target.evaluate(assetsFn);
  await writePrivate(
    files.assets,
    JSON.stringify(
      {
        note: "All URLs have query strings and fragments removed. data: URLs are summarized.",
        ...(assets as object),
      },
      null,
      2,
    ),
  );

  for (const state of states) {
    let focusTarget: string | undefined;
    if (state === "hover") {
      await target.hover();
    } else {
      focusTarget = await target.evaluate((el) => {
        const focusable = 'a[href],button,input,select,textarea,summary,[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';
        const t = (el.matches(focusable) ? el : el.querySelector<HTMLElement>(focusable)) as HTMLElement | null;
        if (!t) return "none";
        t.focus();
        return t === el ? "self" : t.localName;
      });
    }
    await settle(page);
    const shot = join(outDir, `${prefix}element.${state}.png`);
    const stylesFile = join(outDir, `${prefix}styles.${state}.json`);
    await target.screenshot({ path: shot });
    await chmod(shot, 0o600);
    const snap = await snapshot(target);
    await writePrivate(
      stylesFile,
      toJson({
        state,
        ...(focusTarget ? { focusTarget } : {}),
        note: "Only nodes/properties that differ from the base state are listed; id refers to styles.json nodes.",
        changes: buildStateDiff(base, snap),
      }),
    );
    files.states[state] = { screenshot: shot, styles: stylesFile };
    // Reset so states do not leak into each other.
    if (state === "hover") await page.mouse.move(0, 0);
    else await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await settle(page);
  }

  return files;
}
