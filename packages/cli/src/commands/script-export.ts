/**
 * Renders a session's action log (daemon op `actions`) as a script for `hound script run`: a TypeScript file with no
 * imports that default-exports `{ name, run(ctx) }`.
 *
 * - Elements use the locator recorded before each action (test id, role + name, label, placeholder, text, CSS); an
 *   ambiguous or undescribed one gets `.nth(i)` or a placeholder and a `// TODO verify locator` comment.
 * - Filled/typed values, prompt answers and upload paths were never recorded: each becomes a required `--arg` (read
 *   with `arg("name")`), named from the field's accessible name.
 * - Checks (`ctx.check`, recorded in result.json): the URL path after every navigation (and after clicks or key presses
 *   that changed it), every `page wait` condition, and the final URL path.
 */
import type { BrowserOpResult, ExportedAction, ExportedUrl, LocatorDesc } from "@sitehound/core";
import { shellQuote } from "../framework/usage.ts";

export interface ScriptParam {
  name: string;
  step: number;
  /** What the value is for, e.g. `text filled into textbox "Email"`. */
  what: string;
}

export interface RenderedScript {
  code: string;
  steps: number;
  /** Locators that matched more than one element (or could not be described): each has a TODO comment. */
  ambiguous: number;
  params: ScriptParam[];
  startUrl: string;
  /** The `hound script run ...` command for this file. */
  runCommand: string;
}

const lit = (s: string): string => JSON.stringify(s);
/** Text for a `//` comment: one line, bounded. */
const note = (s: string, max = 160): string => {
  const t = s.replace(/[\r\n\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** A `--arg` key (`^[A-Za-z0-9][A-Za-z0-9_.-]*$`, as script run accepts) from a field name: "E-mail address" -> "e_mail_address". */
export function paramName(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+/, "")
    .slice(0, 40)
    .replace(/_+$/, "");
}

const DEFAULT_TIMEOUT_MS = 15_000;

export function renderScript(log: BrowserOpResult<"actions">, opts: { name: string; file: string; generatedAt: string }): RenderedScript {
  const { session, actions } = log;
  const params: ScriptParam[] = [];
  const used = new Set<string>();
  const helpers = new Set<"urlMatches" | "mouseDrag" | "chooseFiles" | "download">();
  let ambiguous = 0;
  const body: string[] = [];
  const out = (line = "") => body.push(line === "" ? "" : `    ${line}`);

  const first = actions[0]!;
  const startUrl = first.op === "navigate" && first.goto ? first.goto : first.before;
  const startOrigin = (() => {
    try {
      return new URL(startUrl.url).origin;
    } catch {
      return "";
    }
  })();

  function param(base: string, step: number, what: string): string {
    const stem = paramName(base) || "value";
    let name = stem;
    for (let k = 2; used.has(name); k++) name = `${stem}_${k}`;
    used.add(name);
    params.push({ name, step, what: note(what, 120) });
    return name;
  }

  /** A locator expression for `d` (scoped to `base`), plus the TODO comment it needs, if any. */
  function locator(d: LocatorDesc | undefined, base = "page"): string {
    if (!d || d.kind === "none") {
      ambiguous++;
      out(`// TODO verify locator: ${note(d?.hint ?? "the element")} could not be described when it was used; replace this placeholder.`);
      return `${base}.locator(${lit("hound-unresolved-element")})`;
    }
    let code: string;
    switch (d.kind) {
      case "testid":
        code = `${base}.getByTestId(${lit(d.value ?? "")})`;
        break;
      case "role":
        code = `${base}.getByRole(${lit(d.role ?? "generic")}, { name: ${lit(d.value ?? "")}, exact: true })`;
        break;
      case "label":
        code = `${base}.getByLabel(${lit(d.value ?? "")}, { exact: true })`;
        break;
      case "placeholder":
        code = `${base}.getByPlaceholder(${lit(d.value ?? "")}, { exact: true })`;
        break;
      case "text":
        code = `${base}.getByText(${lit(d.value ?? "")}, { exact: true })`;
        break;
      default:
        code = `${base}.locator(${lit(d.value ?? "")})`;
    }
    if (d.frame) out(`// TODO verify locator: ${note(d.hint)} is inside an iframe; wrap it in page.frameLocator(...).`);
    if (d.ambiguous) {
      ambiguous++;
      out(`// TODO verify locator: ${note(d.hint)} matched more than one element when recorded; this uses match #${(d.nth ?? 0) + 1}.`);
      code += `.nth(${d.nth ?? 0})`;
    }
    return code;
  }

  /** Base name of a parameter for an element: its accessible name, label, placeholder, test id or id. */
  const fieldName = (d: LocatorDesc | undefined): string => {
    if (!d || d.kind === "none") return "";
    if (d.kind === "css") return d.value?.startsWith("#") ? d.value.slice(1) : "";
    return d.value ?? "";
  };

  /** A URL expression: relative to ctx.url when it is on the start origin (so the script can run against another host). */
  function urlExpr(u: ExportedUrl): string {
    if (u.masked) out(`// TODO verify URL: a path segment looked like a token and was replaced by ":token"; put the real value back.`);
    if (startOrigin && u.url.startsWith(`${startOrigin}/`)) return `new URL(${lit(u.url.slice(startOrigin.length))}, ctx.url).href`;
    return lit(u.url);
  }

  const pathCheck = (label: string, u: ExportedUrl) => {
    if (u.masked || u.path === "") return;
    out(`ctx.check(${lit(label)}, await pathIs(${lit(u.path)}));`);
  };

  /** Wraps an action expression in the dialog override and/or the "leaving the page" marker it ran with. */
  function act(a: ExportedAction, step: number, expr: string, leaving = false): string {
    let e = leaving ? `leave(() => ${expr})` : expr;
    const d = a.details;
    if (d.dialog !== undefined || d.dialogText === true) {
      const action = typeof d.dialog === "string" ? d.dialog : session.dialog;
      const text = d.dialogText === true ? `arg(${lit(param("dialog_text", step, "answer typed into a prompt() dialog"))})` : "undefined";
      e = `withDialog(${lit(action)}, ${text}, () => ${e})`;
    }
    return e;
  }

  if (session.viewport) {
    out(`await page.setViewportSize({ width: ${session.viewport.width}, height: ${session.viewport.height} });`);
    out();
  }

  if (first.op !== "navigate") {
    out("// step 0: open the start URL (--url)");
    out("await leave(() => page.goto(ctx.url));");
    out();
  }

  actions.forEach((a, i) => {
    const step = i + 1;
    const d = a.details;
    const what = a.target ? ` ${note(a.target.hint, 80)}` : "";
    out(`// step ${step}: ${a.op}${a.op === "wait" ? ` --for ${String(d.for)}` : a.op === "tabs" ? ` ${String(d.action)}` : ""}${what}`);
    const changed = a.before.path !== a.after.path || a.before.url.split("/")[2] !== a.after.url.split("/")[2];
    switch (a.op) {
      case "navigate": {
        const waitUntil = typeof d.waitUntil === "string" ? d.waitUntil : "load";
        if (i === 0) {
          out(`await ${act(a, step, `page.goto(ctx.url, { waitUntil: ${lit(waitUntil)} })`, true)};`);
        } else {
          const url = urlExpr(a.goto ?? a.after);
          out(`await ${act(a, step, `page.goto(${url}, { waitUntil: ${lit(waitUntil)} })`, true)};`);
          pathCheck(`step ${step}: url path is ${a.after.path}`, a.after);
        }
        break;
      }
      case "click": {
        const o: string[] = [];
        if (typeof d.count === "number" && d.count !== 1) o.push(`clickCount: ${d.count}`);
        if (typeof d.button === "string" && d.button !== "left") o.push(`button: ${lit(d.button)}`);
        if (Array.isArray(d.modifiers) && d.modifiers.length) o.push(`modifiers: ${JSON.stringify(d.modifiers)}`);
        const loc = locator(a.target);
        out(`await ${act(a, step, `${loc}.click(${o.length ? `{ ${o.join(", ")} }` : ""})`)};`);
        if (changed) pathCheck(`step ${step}: url path is ${a.after.path}`, a.after);
        break;
      }
      case "hover":
        out(`await ${locator(a.target)}.hover();`);
        break;
      case "fill": {
        const loc = locator(a.target);
        const p = param(fieldName(a.target), step, `text filled into ${a.target?.hint ?? "a field"}`);
        out(`await ${act(a, step, `${loc}.fill(arg(${lit(p)}))`)};`);
        break;
      }
      case "type": {
        const loc = locator(a.target);
        const p = param(fieldName(a.target), step, `text typed into ${a.target?.hint ?? "a field"}`);
        if (d.clear === true) out(`await ${loc}.fill("");`);
        out(`await ${act(a, step, `${loc}.pressSequentially(arg(${lit(p)}), { delay: ${typeof d.delayMs === "number" ? d.delayMs : 30} })`)};`);
        break;
      }
      case "select": {
        const options = Array.isArray(d.options) ? d.options : [];
        out(`await ${act(a, step, `${locator(a.target)}.selectOption(${JSON.stringify(options)})`)};`);
        break;
      }
      case "press": {
        const key = typeof d.key === "string" ? d.key : "Enter";
        out(`await ${act(a, step, a.target ? `${locator(a.target)}.press(${lit(key)})` : `page.keyboard.press(${lit(key)})`)};`);
        if (changed) pathCheck(`step ${step}: url path is ${a.after.path}`, a.after);
        break;
      }
      case "check":
        out(`await ${act(a, step, `${locator(a.target)}.setChecked(${d.checked === true})`)};`);
        break;
      case "drag": {
        const from = locator(a.target);
        const to = locator(a.to);
        if (d.method === "mouse") {
          helpers.add("mouseDrag");
          out(`await ${act(a, step, `mouseDrag(${from}, ${to}, ${typeof d.steps === "number" ? d.steps : 10})`)};`);
        } else out(`await ${act(a, step, `${from}.dragTo(${to})`)};`);
        if (changed) pathCheck(`step ${step}: url path is ${a.after.path}`, a.after);
        break;
      }
      case "upload": {
        const loc = locator(a.target);
        const names = Array.isArray(d.files) && d.files.length ? d.files : ["file"];
        const stem = `${fieldName(a.target) || "upload"}_file`;
        const keys = names.map((n) => param(stem, step, `path of a file to upload (recorded: ${n})`));
        const files = `[${keys.map((k) => `arg(${lit(k)})`).join(", ")}]`;
        if (d.fileInput === true) out(`await ${act(a, step, `${loc}.setInputFiles(${files})`)};`);
        else {
          helpers.add("chooseFiles");
          out(`await ${act(a, step, `chooseFiles(${loc}, ${files})`)};`);
        }
        break;
      }
      case "download":
        helpers.add("download");
        out(`ctx.check(${lit(`step ${step}: download finished`)}, await ${act(a, step, `download(${locator(a.target)})`)});`);
        break;
      case "back":
      case "forward":
        out(`await ${act(a, step, `page.${a.op === "back" ? "goBack" : "goForward"}()`, true)};`);
        pathCheck(`step ${step}: url path is ${a.after.path}`, a.after);
        break;
      case "reload":
        out(`await ${act(a, step, "page.reload()", true)};`);
        pathCheck(`step ${step}: url path is ${a.after.path}`, a.after);
        break;
      case "tabs": {
        const index = typeof d.tabIndex === "number" ? d.tabIndex : 0;
        if (d.action === "new") {
          out("page = await ctx.context.newPage();");
          out("page.setDefaultTimeout(TIMEOUT);");
          if (a.goto) {
            out(`await page.goto(${urlExpr(a.goto)});`);
            pathCheck(`step ${step}: url path is ${a.after.path}`, a.after);
          }
        } else if (d.action === "select") {
          out(`page = ctx.context.pages()[${index}];`);
          out("await page.bringToFront();");
        } else {
          out("{");
          out(`  const tab = ctx.context.pages()[${index}];`);
          out("  const wasActive = tab === page;");
          out("  await tab.close();");
          out(`  if (wasActive) page = ctx.context.pages()[Math.min(${index}, ctx.context.pages().length - 1)];`);
          out("}");
        }
        break;
      }
      case "wait": {
        const value = typeof d.value === "string" ? d.value : "";
        switch (d.for) {
          case "text":
          case "text-gone": {
            const scope = a.within ? locator(a.within) : "page";
            const gone = d.for === "text-gone";
            out(`ctx.check(${lit(`step ${step}: text "${note(value, 60)}" ${gone ? "gone" : "visible"}`)}, await ${act(a, step, `shows(${scope}.getByText(${lit(value)}).filter({ visible: true }).first()${gone ? ', "detached"' : ""})`)});`);
            break;
          }
          case "url":
            helpers.add("urlMatches");
            out(`ctx.check(${lit(`step ${step}: url matches ${note(value, 60)}`)}, await urlMatches(${lit(value)}));`);
            break;
          case "ref":
          case "ref-hidden": {
            const hidden = d.for === "ref-hidden";
            const loc = locator(a.target);
            out(`ctx.check(${lit(`step ${step}: ${a.target?.hint ?? "element"} ${hidden ? "hidden" : "visible"}`)}, await shows(${loc}${hidden ? ', "hidden"' : ""}));`);
            break;
          }
          case "request":
            out(`// TODO: "page wait --for request ${note(`${typeof d.method === "string" ? `${d.method} ` : ""}${value}`, 80)}" is not replayed: start page.waitForResponse(...) before the action that sends the request.`);
            out(`await page.waitForLoadState("networkidle").catch(() => {});`);
            break;
          default:
            out(`await page.waitForLoadState(${lit(value || "load")});`);
        }
        break;
      }
      case "resize":
        out(`await page.setViewportSize({ width: ${Number(d.width)}, height: ${Number(d.height)} });`);
        break;
      case "emulate": {
        if (d.reset === true) out("await page.emulateMedia({ colorScheme: null, media: null, reducedMotion: null });");
        else {
          const o = (["colorScheme", "media", "reducedMotion"] as const).filter((k) => typeof d[k] === "string").map((k) => `${k}: ${lit(String(d[k]))}`);
          out(`await page.emulateMedia({ ${o.join(", ")} });`);
        }
        break;
      }
    }
    out();
  });

  const last = actions[actions.length - 1]!;
  if (!last.after.masked && last.after.path !== "") out(`ctx.check(${lit(`final url path is ${last.after.path}`)}, await pathIs(${lit(last.after.path)}));`);
  else out("// TODO verify: the final URL could not be checked (masked or not http).");
  out(`return { summary: ${lit(`replayed ${actions.length} recorded step(s)`)} };`);

  const runCommand = [
    "hound script run --file",
    shellQuote(opts.file),
    "--url",
    shellQuote(startUrl.url),
    ...(session.profile ? ["--profile", shellQuote(session.profile)] : []),
    ...params.flatMap((p) => ["--arg", shellQuote(`${p.name}=<${p.name}>`)]),
    "--json",
  ].join(" ");

  const notReplayed = [
    session.mobile ? "--mobile" : "",
    session.deviceScaleFactor ? `--device-scale-factor ${session.deviceScaleFactor}` : "",
    session.locale ? `--locale ${session.locale}` : "",
    session.timezone ? `--timezone ${session.timezone}` : "",
    session.geolocation ? "--geolocation" : "",
    session.block?.length ? `--block ${session.block.join(",")}` : "",
  ].filter(Boolean);

  const header: string[] = [
    `// sitehound test script exported by \`hound script export\` from browser session "${note(session.name, 64)}" on ${opts.generatedAt}.`,
    `// ${actions.length} recorded step(s)${log.dropped ? `; the first ${log.dropped} action(s) of the session were dropped from the log and are missing (TODO)` : ""}.`,
    "// Run it:",
    `//   ${note(runCommand, 2000)}`,
  ];
  if (params.length) {
    header.push("// Required --arg values (the values were never recorded; pass your own, secrets included):");
    const width = Math.max(...params.map((p) => p.name.length));
    for (const p of params) header.push(`//   ${p.name.padEnd(width)}  ${p.what} (step ${p.step})`);
  }
  header.push(
    "// Locators were chosen when each action ran (test id, role + name, label, placeholder, text, CSS) and matched exactly",
    '// one element unless a line says "TODO verify locator". Checks (ctx.check) go to result.json; a failed one fails the run.',
  );
  if (session.profile) header.push(`// The session used the saved login "${note(session.profile, 64)}": keep --profile in the run command.`);
  if (notReplayed.length) header.push(`// Not replayed (script run opens a default browser): ${notReplayed.join(", ")}.`);

  const helperCode: string[] = [];
  if (helpers.has("urlMatches")) {
    helperCode.push(
      "    // page wait --for url: a glob (with *: ** any, * no \"/\") against the full URL or origin + path, else a substring.",
      String.raw`    const urlMatches = (value: string): Promise<boolean> => {
      const esc = (t: string) => t.replace(/[.+?^$(){}|[\]\\]/g, "\\$&");
      const glob = value.includes("*") ? new RegExp("^" + value.split("**").map((c) => c.split("*").map(esc).join("[^/]*")).join(".*") + "$") : undefined;
      return page.waitForURL((u: URL) => (glob ? glob.test(u.href) || glob.test(u.origin + u.pathname) : u.href.includes(value)), { timeout: TIMEOUT }).then(() => true, () => false);
    };`,
    );
  }
  if (helpers.has("mouseDrag")) {
    helperCode.push(
      "    // A real pointer drag: press on the source, `steps` moves to the target, release.",
      "    const mouseDrag = async (from: any, to: any, steps: number): Promise<void> => {",
      "      const centre = async (loc: any) => {",
      "        await loc.scrollIntoViewIfNeeded();",
      "        const box = await loc.boundingBox();",
      "        if (!box) throw new Error(\"drag: element not visible\");",
      "        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };",
      "      };",
      "      const a = await centre(from);",
      "      await page.mouse.move(a.x, a.y);",
      "      await page.mouse.down();",
      "      try {",
      "        const b = await centre(to);",
      "        await page.mouse.move(b.x, b.y, { steps });",
      "      } finally {",
      "        await page.mouse.up();",
      "      }",
      "    };",
    );
  }
  if (helpers.has("chooseFiles")) {
    helperCode.push(
      "    // Clicks an element that opens a file chooser and answers it.",
      "    const chooseFiles = async (loc: any, files: string[]): Promise<void> => {",
      "      const [chooser] = await Promise.all([page.waitForEvent(\"filechooser\"), loc.click()]);",
      "      await chooser.setFiles(files);",
      "    };",
    );
  }
  if (helpers.has("download")) {
    helperCode.push(
      "    // Clicks and saves the download into this run's private directory; true when it finished.",
      "    const download = async (loc: any): Promise<boolean> => {",
      "      const [dl] = await Promise.all([page.waitForEvent(\"download\"), loc.click()]);",
      "      if ((await dl.failure()) !== null) return false;",
      "      await dl.saveAs(`${ctx.outDir}/${dl.suggestedFilename().replace(/[^A-Za-z0-9._-]+/g, \"_\") || \"download\"}`);",
      "      return true;",
      "    };",
    );
  }

  const code = [
    ...header,
    "",
    `const TIMEOUT = ${DEFAULT_TIMEOUT_MS};`,
    `const DIALOG_DEFAULT = ${lit(session.dialog)};`,
    "",
    "export default {",
    `  name: ${lit(opts.name)},`,
    "  async run(ctx: any) {",
    "    let page = ctx.page;",
    "    page.setDefaultTimeout(TIMEOUT);",
    "    const arg = (key: string): string => {",
    "      const value = ctx.args[key];",
    "      if (typeof value !== \"string\") throw new Error(`Missing --arg ${key}=<value> (see the header of this script).`);",
    "      return value;",
    "    };",
    "    // JavaScript dialogs: the session default, or the per-step override it was recorded with (kept 2 s for late dialogs).",
    "    const dialogs = { action: DIALOG_DEFAULT, text: undefined as string | undefined, leaving: false, seq: 0 };",
    "    ctx.context.on(\"dialog\", (d: any) => {",
    "      const accept = (d.type() === \"beforeunload\" && dialogs.leaving) || dialogs.action === \"accept\";",
    "      const answer = d.type() === \"prompt\" ? (dialogs.text ?? d.defaultValue()) : undefined;",
    "      (accept ? d.accept(answer) : d.dismiss()).catch(() => {});",
    "    });",
    "    const withDialog = async (action: string, text: string | undefined, fn: () => Promise<unknown>): Promise<any> => {",
    "      const mine = ++dialogs.seq;",
    "      dialogs.action = action;",
    "      dialogs.text = text;",
    "      try {",
    "        return await fn();",
    "      } finally {",
    "        setTimeout(() => {",
    "          if (dialogs.seq !== mine) return;",
    "          dialogs.action = DIALOG_DEFAULT;",
    "          dialogs.text = undefined;",
    "        }, 2000).unref();",
    "      }",
    "    };",
    "    // Navigations accept a beforeunload dialog (leaving is what the step asked for).",
    "    const leave = async (fn: () => Promise<unknown>): Promise<any> => {",
    "      dialogs.leaving = true;",
    "      try {",
    "        return await fn();",
    "      } finally {",
    "        dialogs.leaving = false;",
    "      }",
    "    };",
    "    const pathIs = (path: string): Promise<boolean> => page.waitForURL((u: URL) => u.pathname === path, { timeout: TIMEOUT }).then(() => true, () => false);",
    "    const shows = (loc: any, state = \"visible\"): Promise<boolean> => loc.waitFor({ state, timeout: TIMEOUT }).then(() => true, () => false);",
    ...helperCode,
    "",
    ...body,
    "  },",
    "};",
    "",
  ].join("\n");

  return { code, steps: actions.length, ambiguous, params, startUrl: startUrl.url, runCommand };
}
