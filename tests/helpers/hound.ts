/**
 * Shared test helpers: run `bin/hound` as a child process against an isolated HOUND_HOME, and a
 * local fixture web server. Erasable TypeScript only (run natively by Node).
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const HOUND_BIN = join(REPO_ROOT, "bin", "hound");

export interface HoundResult {
  exitCode: number;
  /** Parsed stdout; stdout must be exactly one JSON object (asserted). */
  json: any;
  stdout: string;
  stderr: string;
}

export interface Env {
  /** Isolated HOUND_HOME (mode 0700). */
  home: string;
  /** A cwd that is not the repo, to prove cwd independence. */
  cwd: string;
  /** Run `hound <args>`; stdin is piped when `input` is given, else closed. */
  hound(args: string[], opts?: { input?: string; timeoutMs?: number; parse?: boolean }): Promise<HoundResult>;
  /** Raw run without JSON parsing of stdout. */
  raw(args: string[], opts?: { input?: string; timeoutMs?: number }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  /** Session names opened via `open`, closed by `cleanup`. */
  open(name: string, extra?: string[]): Promise<HoundResult>;
  /** Closes every session opened through this env and asserts nothing is left behind. */
  cleanup(): Promise<void>;
}

/** Parses stdout and asserts it is exactly one JSON object followed by a newline. */
export function parseSingleJson(stdout: string): any {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("stdout is empty");
  if (trimmed.includes("\n")) throw new Error(`stdout is not a single line of JSON: ${trimmed.slice(0, 200)}`);
  const value = JSON.parse(trimmed);
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("stdout JSON is not an object");
  return value;
}

export async function makeEnv(): Promise<Env> {
  const home = await mkdtemp(join(tmpdir(), "hound-test-home-"));
  await chmod(home, 0o700);
  const cwd = await mkdtemp(join(tmpdir(), "hound-test-cwd-"));
  const opened = new Set<string>();

  const raw: Env["raw"] = (args, opts = {}) =>
    new Promise((res, rej) => {
      const child = spawn(HOUND_BIN, args, {
        cwd,
        env: { ...process.env, HOUND_HOME: home, NO_COLOR: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (c: string) => (stdout += c));
      child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c));
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        rej(new Error(`hound ${args.join(" ")} timed out after ${opts.timeoutMs ?? 90_000} ms\nstderr: ${stderr.slice(-500)}`));
      }, opts.timeoutMs ?? 90_000);
      child.on("error", (err) => {
        clearTimeout(timer);
        rej(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        res({ exitCode: code ?? -1, stdout, stderr });
      });
      child.stdin.on("error", () => {});
      if (opts.input !== undefined) child.stdin.end(opts.input);
      else child.stdin.end();
    });

  const hound: Env["hound"] = async (args, opts = {}) => {
    const r = await raw(args, opts);
    if (args[0] === "browser" && args[1] === "open" && r.exitCode === 0) {
      const at = args.indexOf("--session-name");
      if (at >= 0) opened.add(args[at + 1]!);
    }
    return { ...r, json: opts.parse === false ? undefined : parseSingleJson(r.stdout) };
  };

  const open: Env["open"] = async (name, extra = []) => {
    const r = await hound(["browser", "open", "--session-name", name, ...extra, "--json"]);
    opened.add(name);
    return r;
  };

  const cleanup: Env["cleanup"] = async () => {
    const pids = new Set<number>();
    const sessionsDir = join(home, "sessions");
    if (existsSync(sessionsDir)) {
      for (const name of readdirSync(sessionsDir)) {
        const pid = readSessionPid(join(sessionsDir, name));
        if (pid) pids.add(pid);
      }
    }
    for (const name of opened) await raw(["browser", "close", "--session-name", name, "--json"]).catch(() => {});
    // Safety net: kill anything that survived a failed close, so no daemon outlives the test.
    for (const pid of pids) {
      if (isAlive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    }
    const left = existsSync(sessionsDir) ? readdirSync(sessionsDir) : [];
    const alive = [...pids].filter(isAlive);
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
    if (alive.length) throw new Error(`daemon pid(s) still alive after cleanup: ${alive.join(", ")}`);
    if (left.length) throw new Error(`session dir(s) left behind: ${left.join(", ")}`);
  };

  return { home, cwd, hound, raw, open, cleanup };
}

function readSessionPid(dir: string): number | undefined {
  for (const [file, pick] of [
    ["state.json", (t: string) => (JSON.parse(t) as { pid?: number }).pid],
    ["pid", (t: string) => Number.parseInt(t, 10)],
  ] as const) {
    try {
      const pid = pick(readFileSync(join(dir, file), "utf8"));
      if (Number.isInteger(pid) && pid! > 0) return pid;
    } catch {}
  }
  return undefined;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Writes a synthetic profile (empty storage state + meta) into an isolated HOUND_HOME. Never real credentials. */
export async function writeSyntheticProfile(home: string, name: string, landingUrl: string): Promise<void> {
  const dir = join(home, "profiles");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, `${name}.json`), JSON.stringify({ cookies: [], origins: [] }), { mode: 0o600 });
  const meta = { name, sites: [{ loginUrl: new URL("/login", landingUrl).href, landingUrl, savedAt: new Date().toISOString() }] };
  await writeFile(join(dir, `${name}.meta.json`), JSON.stringify(meta), { mode: 0o600 });
}

// ---------------------------------------------------------------------------------------------
// Fixture web server
// ---------------------------------------------------------------------------------------------

const page = (title: string, body: string, head = "") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`;

const PAGES: Record<string, string> = {
  "/": page(
    "Fixture Home",
    `<h1>Fixture Home</h1>
<nav><a href="/about">About page</a> <a href="/form">Form page</a></nav>
<p>Plain content for snapshots.</p>`,
  ),
  "/about": page("About", `<h1>About</h1><a href="/">Back home</a>`),
  "/form": page(
    "Form",
    `<h1>Form</h1>
<form id="f" action="/submitted" method="get">
  <label>Name <input type="text" name="name" id="name"></label>
  <label>Password <input type="password" name="pw" id="pw"></label>
  <label>Color <select name="color" id="color">
    <option value="r">Red</option>
    <option value="g">Green</option>
    <option value="b">Blue</option>
  </select></label>
  <button type="submit">Send it</button>
</form>
<div id="out"></div>
<script>
  document.getElementById("name").addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); document.getElementById("out").textContent = "Pressed Enter"; }
  });
</script>`,
  ),
  "/submitted": page("Submitted", `<h1>Submitted</h1>`),
  "/broken": page(
    "Broken",
    `<h1>Broken page</h1>
<script>
  console.error("fixture-console-error");
  fetch("/missing-resource").catch(function () {});
</script>`,
  ),
  "/slow": "",
  // Reacts to keyup only, so `fill` (which fires no key events) leaves #out empty and `type` fills it.
  "/type": page(
    "Type",
    `<h1>Type</h1>
<label>Search <input type="text" id="q" aria-label="Search"></label>
<div id="out"></div>
<div id="ce" role="textbox" contenteditable="true" aria-label="Notes">old notes</div>
<div id="box" role="textbox" tabindex="0" aria-label="Keys box">box</div>
<div id="mirror"></div>
<pre id="log"></pre>
<script>
  var q = document.getElementById("q"), out = document.getElementById("out"), log = document.getElementById("log");
  var kd = 0;
  q.addEventListener("keydown", function () { kd++; });
  q.addEventListener("keyup", function () { out.textContent = "keyup:" + q.value + " keydowns:" + kd; });
  var ce = document.getElementById("ce");
  ce.addEventListener("input", function () { document.getElementById("mirror").textContent = "notes:" + ce.textContent; });
  document.getElementById("box").addEventListener("keydown", function (e) { log.textContent += "[" + e.key + "]"; });
</script>`,
  ),
  "/downloads": page(
    "Downloads",
    `<h1>Downloads</h1>
<a href="/files/report.txt">Get report</a>
<a href="/files/evil">Get evil</a>
<a href="/files/leak">Get leak</a>
<a href="/files/stuck">Get stuck</a>
<a href="/files/hang">Get hang</a>
<button id="b" onclick="location.href='/files/report.txt'">Export PDF</button>
<button id="n" onclick="void 0">Do nothing</button>`,
  ),
  // Dialogs: confirm, prompt, alert, a late alert (outside any op), a popup that alerts on load, Enter -> confirm.
  "/dialogs": page(
    "Dialogs",
    `<h1>Dialogs</h1>
<button onclick="out.textContent = confirm('¿Seguro que desea eliminar?') ? 'deleted' : 'kept'">Delete record</button>
<button onclick="out.textContent = 'name:' + prompt('Your name?', 'anon')">Ask name</button>
<button onclick="alert('Saved ok'); out.textContent = 'alerted'">Say saved</button>
<button onclick="setTimeout(function () { alert('late notice'); out.textContent = 'late done'; }, 400)">Alert later</button>
<button onclick="window.open('/dialog-popup')">Open popup</button>
<label>Confirm field <input type="text" aria-label="Confirm field" onkeydown="if (event.key === 'Enter') out.textContent = confirm('Submit it?') ? 'submitted' : 'cancelled'"></label>
<div id="out" role="status">idle</div>
<script>var out = document.getElementById("out");</script>`,
  ),
  "/dialog-popup": page("Popup", `<h1>Popup</h1><script>alert("popup says hi"); document.title = "popup done";</script>`),
  // Uploads: a plain input, a multiple input, and a button that opens a chooser for a hidden input.
  "/upload": page(
    "Upload",
    `<h1>Upload</h1>
<label>Photo <input type="file" id="one" aria-label="Photo"></label>
<label>Docs <input type="file" id="many" multiple aria-label="Docs"></label>
<button onclick="document.getElementById('hid').click()">Choose file</button>
<input type="file" id="hid" hidden>
<button>Not a picker</button>
<div id="out" role="status">none</div>
<script>
  ["one", "many", "hid"].forEach(function (id) {
    document.getElementById(id).addEventListener("change", function (e) {
      document.getElementById("out").textContent = id + ":" + Array.from(e.target.files).map(function (f) { return f.name + "=" + f.size; }).join(",");
    });
  });
</script>`,
  ),
  // Waits: a spinner and "Cargando" that go away 700 ms after the click; "Listo" exists in the footer from the start and in the panel later.
  "/waits": page(
    "Waits",
    `<h1>Waits</h1>
<button onclick="start()">Load data</button>
<div role="progressbar" aria-label="Spinner" id="sp">Cargando datos</div>
<section aria-label="Panel" id="panel"><h2>Results</h2><div id="res"></div></section>
<footer>Listo (footer)</footer>
<script>
  function start() {
    setTimeout(function () {
      document.getElementById("sp").style.display = "none";
      document.getElementById("res").textContent = "Listo (panel)";
    }, 700);
  }
</script>`,
  ),
  // Requests: a fast GET, a POST, and a GET that starts 500 ms after the click.
  "/reqs": page(
    "Reqs",
    `<h1>Reqs</h1>
<button onclick="fetch('/api/data?x=1')">Ping</button>
<button onclick="fetch('/api/form', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'a=1' })">Post it</button>
<button onclick="setTimeout(function () { fetch('/api/data?late=1'); }, 500)">Ping later</button>`,
  ),
  // Click kinds: the page logs what it observed.
  "/clicks": page(
    "Clicks",
    `<h1>Clicks</h1>
<button id="t">Target</button> <a href="/about" id="lnk" onclick="event.preventDefault(); log('link clicked')">Plain link</a>
<pre id="log" role="log"></pre>
<script>
  var t = document.getElementById("t");
  function log(s) { document.getElementById("log").textContent += s + ";"; }
  t.addEventListener("click", function (e) { log("click" + e.detail + (e.shiftKey ? "+shift" : "") + (e.ctrlKey ? "+ctrl" : "")); });
  t.addEventListener("dblclick", function () { log("dblclick"); });
  t.addEventListener("contextmenu", function (e) { e.preventDefault(); log("contextmenu"); });
  t.addEventListener("auxclick", function (e) { if (e.button === 1) log("middle"); });
</script>`,
  ),
  // Viewport / media emulation readout: width, touch, pixel ratio and the media features the page sees.
  "/media": page(
    "Media",
    `<h1>Media</h1><p id="env" role="status"></p><a href="/about">About us</a>
<script>
  var queries = ["(prefers-color-scheme: dark)", "print", "(prefers-reduced-motion: reduce)"].map(function (q) { return matchMedia(q); });
  function upd() {
    document.getElementById("env").textContent = "w:" + innerWidth + " dark:" + queries[0].matches + " print:" + queries[1].matches + " reduce:" + queries[2].matches + " touch:" + (navigator.maxTouchPoints > 0) + " dpr:" + devicePixelRatio;
  }
  queries.forEach(function (q) { q.addEventListener("change", upd); });
  addEventListener("resize", upd);
  upd();
</script>`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
  ),
  // Drag and drop: HTML5 (dragstart/drop) and pointer based (pointerdown on the handle, pointerup over the slot).
  "/drag": page(
    "Drag",
    `<h1>Drag</h1>
<button id="card" draggable="true">Card A</button> <button id="zone">Drop zone</button>
<button id="handle">Handle</button> <button id="slot">Slot</button>
<pre id="log" role="log"></pre>
<script>
  function log(s) { document.getElementById("log").textContent += s + ";"; }
  var card = document.getElementById("card"), zone = document.getElementById("zone");
  card.addEventListener("dragstart", function (e) { e.dataTransfer.setData("text/plain", "Card A"); log("dragstart"); });
  zone.addEventListener("dragover", function (e) { e.preventDefault(); });
  zone.addEventListener("drop", function (e) {
    e.preventDefault();
    log("drop:" + e.dataTransfer.getData("text/plain") + ">zone");
    fetch("/api/data?moved=1");
    setTimeout(function () { log(confirm("Move card?") ? "moved" : "kept"); }, 0);
  });
  var down = null;
  document.getElementById("handle").addEventListener("pointerdown", function () { down = "handle"; });
  document.addEventListener("pointerup", function (e) {
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (down && el && el.id) log("pointer:" + down + ">" + el.id);
    down = null;
  });
</script>`,
  ),
  // Find: 40 links (30 results cap), a few unique lines, and a long run of "a" for catastrophic-regex checks.
  "/find": page(
    "Find",
    `<h1>Catalog</h1><a href="/about?utm=1">About us</a> <button>Checkout now</button>
<ul>${Array.from({ length: 40 }, (_, i) => `<li><a href="/about?i=${i + 1}">Item ${i + 1}</a></li>`).join("")}</ul>
<p>${"a".repeat(45)}!</p>`,
  ),
  // Element read: text, URL attributes with queries, a live input value, a password field, long text and a token-like string.
  "/reads": page(
    "Reads",
    `<h1>Reads</h1>
<p id="para">Hello <b>brave</b> world</p>
<a id="lnk" href="/about?token=QUERYSECRET1&x=1#frag">Docs link</a>
<a href="/about" data-redirect-url="https://example.test/cb?code=XYZSECRET2#h">Redirect link</a>
<img alt="Logo" src="/logo.png?sig=SIGSECRET3" width="10" height="10">
<input type="text" value="initial" aria-label="Name field">
<input type="password" value="hunter2hunter2" aria-label="Pass field" placeholder="your secret" autocomplete="current-password">
<p id="key">Key: ghp_${"abcdefghijklmnopqrstuvwxyz0123456789ab"} end</p>
<p id="long">${"word ".repeat(600)}</p>`,
  ),
  // beforeunload: the page asks before it is left (Chromium needs a user gesture first: click the link).
  "/unload": page(
    "Unload",
    `<h1>Unload</h1><a id="leave" href="/about">Leave page</a>
<script>addEventListener("beforeunload", function (e) { e.preventDefault(); e.returnValue = ""; });</script>`,
  ),
  // A confirm raised 300 ms after the click, by a timer.
  "/late": page(
    "Late",
    `<h1>Late</h1><button onclick="setTimeout(function () { out.textContent = confirm('Later?') ? 'late-yes' : 'late-no'; }, 300)">Late confirm</button>
<div id="out" role="status">idle</div>
<script>var out = document.getElementById("out");</script>`,
  ),
  // Fields that hold secrets in every way the page can say so.
  "/sensitive": page(
    "Sensitive",
    `<h1>Sensitive</h1>
<input type="text" autocomplete="cc-number" value="4111111111111111" aria-label="Pay number">
<input type="text" name="cvv" value="123" aria-label="Security code">
<input type="text" autocomplete="one-time-code" value="482913" aria-label="Code box">
<input type="text" name="pwd" value="hunter2shown" aria-label="Shown secret">
<label for="lab">Card number</label><input type="text" id="lab" value="4242424242424242">
<input type="text" value="plain-value" aria-label="Plain field">`,
  ),
  // Read-level links: which ones look like GET links with side effects (logout, delete, unsubscribe, action=remove ...) and which do not.
  "/sidefx": page(
    "Sidefx",
    `<h1>Sidefx</h1>
<ul>
<li><a href="/logout">Leave</a></li>
<li><a href="/account/delete">Account page</a></li>
<li><a href="/items/42/Sign-Out">Go on</a></li>
<li><a href="/items?action=remove&id=4">Item four</a></li>
<li><a href="/neutral">Cerrar sesión</a></li>
<li><a href="/neutral2" aria-label="Unsubscribe from emails">Click here</a></li>
<li><a href="/deleted-items">Deleted items</a></li>
<li><a href="/blog/how-to-remove-stains">Tips for stains</a></li>
<li><a href="/docs?q=delete&removed=1">Search docs</a></li>
<li><a href="/about">Learn about us</a></li>
<li><a href="/files/report.txt">Delete log export</a></li>
</ul>`,
  ),
  "/logout": page("Logged out", `<h1>Logged out</h1>`),
  "/account/delete": page("Account deleted", `<h1>Account deleted</h1>`),
  "/deleted-items": page("Deleted items", `<h1>Deleted items</h1>`),
  "/neutral": page("Neutral", `<h1>Neutral</h1>`),
  "/neutral2": page("Neutral two", `<h1>Neutral two</h1>`),
  "/blog/how-to-remove-stains": page("Stains", `<h1>Stains</h1>`),
  "/docs": page("Docs", `<h1>Docs</h1>`),
  "/items": page("Items", `<h1>Items</h1>`),
  "/items/42/Sign-Out": page("Signed out", `<h1>Signed out</h1>`),
  // Text that looks like secret codes (one-time codes, PINs) next to ordinary numbers; PAN-like numbers and an epoch in milliseconds.
  "/codes": page(
    "Codes",
    `<h1>Codes</h1>
<p>Your verification code is 482913. It expires in 10 minutes.</p>
<p>Total 4500 EUR, order 123456 on 2024-01-05 at 12:30</p>
<div class="otp-box"><p>731904</p></div>
<div aria-label="Security PIN"><p>8842</p></div>
<p>Código de verificación</p>
<p>907153</p>
<p>Quantity 3456 shipped to zip code 28001</p>
<p>Paid with card 4242 4242 4242 4242 at 1723456789011 ms</p>
<p>Created 1700000000004</p>`,
  ),
  // Pointer-only drag: no HTML5 drag-and-drop. The chip is dropped only when the pointer moved at least 3 times while pressed.
  // Review round 2 fixtures.
  "/dollar": page("$$cost", `<h1>Dollar</h1><label>Amount <input type="text" id="amt" aria-label="Amount"></label>`),
  // Rich-text editors holding text that must never become a locator, a comment or a parameter name.
  "/editor": page(
    "Editor",
    `<h1>Editor</h1>
<div id="ed" contenteditable="true" role="textbox">PREFILLED-SECRET-77</div>
<div id="ed2" contenteditable="true">PREFILLED-SECRET-88</div>
<div id="out" role="status">idle</div>`,
  ),
  "/longattrs": page("Longattrs", `<h1>Long</h1><button id="${"i".repeat(300)}" data-testid="${"t".repeat(300)}" aria-label="${"a".repeat(300)}">Go</button><div id="done" role="status">idle</div>`),
  // Drag by mouse events only; the drop is applied 600 ms later (an animated library).
  "/drag-slow": page(
    "Drag slow",
    `<h1>Drag slow</h1>
<button id="chip">Chip</button> <button id="bin">Bin</button>
<pre id="log" role="log"></pre>
<script>
  var pressed = false;
  document.getElementById("chip").addEventListener("mousedown", function () { pressed = true; });
  document.addEventListener("mouseup", function (e) {
    if (!pressed) return;
    pressed = false;
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (el && el.id === "bin") setTimeout(function () { document.getElementById("log").textContent += "moved;"; }, 600);
  });
</script>`,
  ),
  // Links that send a non-GET request through a data attribute or a method override.
  "/sidefx2": page(
    "Sidefx2",
    `<h1>Sidefx2</h1>
<a href="/neutral" data-method="delete">Open one</a>
<a href="/neutral" data-turbo-method="post">Open two</a>
<a href="/neutral?_method=delete">Open three</a>
<a href="/neutral2" data-method="get">Open four</a>
<a href="/neutral2">Open five</a>`,
  ),
  "/sw": page(
    "Sw",
    `<h1>Sw</h1><p id="out" role="status">pending</p>
<script>
  if (!navigator.serviceWorker) document.getElementById("out").textContent = "sw:none";
  else navigator.serviceWorker.register("/sw.js").then(function () { return navigator.serviceWorker.getRegistrations(); }).then(
    function (rs) { document.getElementById("out").textContent = "sw:registrations=" + rs.length; },
    function () { document.getElementById("out").textContent = "sw:refused"; });
</script>`,
  ),
  "/blank": page("Blank", `<h1>Blank</h1><a href="/about" target="_blank">Open elsewhere</a>`),
  // Pressing Enter submits a form whose answer never comes.
  "/hangform": page("Hangform", `<h1>Hangform</h1><form action="/files/hang" method="get"><input type="text" name="q" aria-label="Query"></form>`),
  "/drag-pointer": page(
    "Drag pointer",
    `<h1>Drag pointer</h1>
<button id="chip">Chip</button> <button id="bin">Bin</button>
<pre id="log" role="log"></pre>
<script>
  var pressed = false, moves = 0;
  document.getElementById("chip").addEventListener("mousedown", function () { pressed = true; moves = 0; });
  document.addEventListener("mousemove", function () { if (pressed) moves++; });
  document.addEventListener("mouseup", function (e) {
    if (!pressed) return;
    pressed = false;
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (moves >= 3 && el && el.id === "bin") document.getElementById("log").textContent += "dropped:" + moves + ";";
  });
</script>`,
  ),
  // A request with a long path (for catastrophic-regex checks) and a plain /api/data one.
  "/redos": page(
    "Redos",
    `<h1>Redos</h1><p id="done"></p>
<script>
  Promise.all([fetch("/${"a".repeat(30)}"), fetch("/api/data")]).then(function () { document.getElementById("done").textContent = "redos done"; });
</script>`,
  ),
  // 520 requests, more than the daemon keeps, so the oldest indexes get evicted.
  "/many": page(
    "Many",
    `<h1>Many</h1><p id="done"></p>
<script>
Promise.all(Array.from({ length: 520 }, function (_, i) { return fetch("/api/data?i=" + i); })).then(function () {
  document.getElementById("done").textContent = "many done";
});
</script>`,
  ),
  // Sends one request of each kind on load; the secrets in them must never reach the output.
  "/net": page(
    "Net",
    `<h1>Net</h1><p id="done"></p>
<script>
(async function () {
  await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + "AUTHHEADER1234567890abcdef" },
    body: JSON.stringify({ user: "ann", password: "hunter2hunter2", profile: { token: "TOK-SECRET-1", name: "Ann" }, items: [{ api_key: "KEY123" }, { note: "see https://x.test/p?access=ABC" }], comment: "ok" }) });
  await fetch("/api/form", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "name=ann&password=pw-SECRET-2&csrf_token=zzz&city=Madrid" });
  var b = "XBOUNDARY", crlf = "\\r\\n";
  var multipart = "--" + b + crlf + 'Content-Disposition: form-data; name="title"' + crlf + crlf + "Hello" + crlf +
    "--" + b + crlf + 'Content-Disposition: form-data; name="secret_note"' + crlf + crlf + "topsecret" + crlf +
    "--" + b + crlf + 'Content-Disposition: form-data; name="file"; filename="a.txt"' + crlf + "Content-Type: text/plain" + crlf + crlf + "FILEBODY-CONTENT" + crlf +
    "--" + b + "--" + crlf;
  await fetch("/api/upload", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=" + b }, body: multipart });
  var fd = new FormData();
  fd.append("blob", new Blob(["x"], { type: "text/plain" }), "b.txt");
  await fetch("/api/blob", { method: "POST", body: fd });
  await fetch("/api/data"); await fetch("/api/bin"); await fetch("/api/redirect"); await fetch("/api/big");
  document.getElementById("done").textContent = "net done";
})();
</script>`,
  ),
  // --block: an image, a web font, an audio file and two tracker requests (the hosts are never reached when blocked).
  "/blockme": page(
    "Blockme",
    `<style>@font-face { font-family: HoundTest; src: url(/assets/t.woff2) format("woff2"); } body { font-family: HoundTest, sans-serif; }</style>
<h1>Blockme</h1><img id="pic" src="/assets/pic.png" alt="Logo" width="20" height="20"><audio src="/assets/a.mp3" preload="auto"></audio>
<p id="out" role="status">pending</p>
<script>
  if (location.search.indexOf("trackers") >= 0) {
    new Image().src = "http://www.google-analytics.com/g/collect?v=2";
    new Image().src = "http://stats.g.doubleclick.net/pixel";
  }
  window.addEventListener("load", function () {
    setTimeout(function () { document.getElementById("out").textContent = "pic:" + document.getElementById("pic").naturalWidth; }, 300);
  });
</script>`,
  ),
  // --locale / --timezone / --geolocation: what the page sees.
  "/env": page(
    "Env",
    `<h1>Env</h1><p id="lang" role="status"></p><p id="tz" role="status"></p><p id="geo" role="status">geo pending</p>
<script>
  document.getElementById("lang").textContent = "lang:" + navigator.language + " num:" + (1234.5).toLocaleString();
  document.getElementById("tz").textContent = "tz:" + Intl.DateTimeFormat().resolvedOptions().timeZone;
  navigator.geolocation.getCurrentPosition(
    function (p) { document.getElementById("geo").textContent = "geo:" + p.coords.latitude + "," + p.coords.longitude + "," + p.coords.accuracy; },
    function (e) { document.getElementById("geo").textContent = "geo-error:" + e.code; },
  );
</script>`,
  ),
  // element check / uncheck: native checkbox (one pre-checked), radios, ARIA switch/checkbox, a confirm on change, a button.
  "/checks": page(
    "Checks",
    `<h1>Checks</h1>
<label><input type="checkbox" id="news" onchange="fetch('/api/data?news=1')"> Newsletter</label>
<label><input type="checkbox" id="terms" checked> Terms</label>
<label><input type="radio" name="size" id="small" value="s"> Small</label>
<label><input type="radio" name="size" id="large" value="l" checked> Large</label>
<div role="switch" id="dark" aria-checked="false" aria-label="Dark mode" tabindex="0" style="width:40px;height:20px;background:#ccc"></div>
<div role="checkbox" id="agree" aria-checked="true" aria-label="Agree" tabindex="0" style="width:20px;height:20px;background:#9c9"></div>
<label><input type="checkbox" id="del" onchange="out.textContent = confirm('Really?') ? 'confirmed' : 'declined'"> Delete all</label>
<label><input type="checkbox" id="stuck" onclick="event.preventDefault()"> Stuck</label>
<button id="btn">Plain button</button>
<p id="out" role="status">idle</p>
<script>
  var out = document.getElementById("out");
  ["dark", "agree"].forEach(function (id) {
    var el = document.getElementById(id);
    el.addEventListener("click", function () { el.setAttribute("aria-checked", el.getAttribute("aria-checked") === "true" ? "false" : "true"); });
  });
</script>`,
  ),
  // page pdf: enough text for several pages.
  "/print": page(
    "Print",
    `<h1>Printable report</h1>${Array.from({ length: 160 }, (_, i) => `<p>Paragraph ${i + 1}: ${"lorem ipsum dolor sit amet ".repeat(8)}</p>`).join("")}`,
    "<style>body { background: #eef; }</style>",
  ),
  // script export: a short form flow (fill, select, check, a button that reveals text, a link) and two "Add" buttons that
  // no locator tells apart (same role, name and 6-level CSS path).
  "/flow": page(
    "Flow",
    `<h1>Flow</h1>
<label>Full name <input type="text" id="fullname"></label>
<label>Secret code <input type="password" id="code"></label>
<label>Plan <select id="plan"><option value="free">Free</option><option value="pro">Pro</option></select></label>
<label><input type="checkbox" id="agree"> I agree</label>
<button onclick="setTimeout(function () { var ok = document.getElementById('agree').checked && document.getElementById('plan').value === 'pro' && document.getElementById('fullname').value !== '' && document.getElementById('code').value !== ''; document.getElementById('msg').textContent = ok ? 'All set' : 'Missing data'; }, 300)">Continue</button>
<div id="msg" role="status"></div>
${'<section><div><div><div><div><div><button onclick="this.textContent = \'Added\'">Add</button></div></div></div></div></div></section>'.repeat(2)}
<a href="/about">About page</a>`,
  ),
  // snapshot --ref / --diff: a stable nav and a main region that changes.
  "/diffy": page(
    "Diffy",
    `<h1>Diffy</h1>
<nav aria-label="Primary"><a href="/about">About page</a> <a href="/form">Form page</a></nav>
<main aria-label="Work area">
  <h2 id="title">Orders</h2>
  <ul id="list"><li>Order one</li><li>Order two</li></ul>
  <button onclick="var li = document.createElement('li'); li.textContent = 'Order ' + (document.querySelectorAll('li').length + 1); document.getElementById('list').appendChild(li)">Add order</button>
  <button onclick="document.getElementById('title').textContent = 'Orders (renamed)'">Rename</button>
  <button onclick="var l = document.getElementById('list'); l.removeChild(l.firstChild)">Drop first</button>
</main>
<footer><p>Footer text</p></footer>`,
  ),
  // Tabs: a target=_blank link (popup) and a plain link to compare against.
  "/popups": page(
    "Popups",
    `<h1>Popups</h1><a href="/about" target="_blank">Open about in a new tab</a> <a href="/form">Same tab form</a>`,
  ),
  // task component: a card with a hover colour, a focus outline, an image and a responsive width.
  "/comp": page(
    "Comp",
    `<h1>Comp page</h1><div class="card" id="card"><h2>Card title</h2><img src="/assets/pic.png" alt="Pic" width="20" height="20"><a href="/about" class="cta">Buy now</a></div>`,
    `<style>
.card { background: #fafafa; padding: 12px; width: 90%; max-width: 600px; border: 1px solid #ccc; }
.cta { color: #036; display: inline-block; padding: 4px 8px; background: #eef; }
.cta:hover { background: #fc0; color: #000; }
.cta:focus { outline: 3px solid #f0f; }
@media (min-width: 800px) { .card { padding: 32px; } }
</style>`,
  ),
};

/** Fixture API: every endpoint answers JSON (or bytes) and sets a cookie, so the tests can prove nothing like it leaks. */
const API: Record<string, (res: import("node:http").ServerResponse) => void> = {
  "/api/login": (res) => json(res, { ok: true, session: "SESS-SECRET-3", user: { name: "Ann", email: "a@x.test" } }),
  "/api/form": (res) => json(res, { ok: true }),
  "/api/upload": (res) => json(res, { ok: true }),
  "/api/big": (res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("word ".repeat(60_000));
  },
  "/api/blob": (res) => json(res, { ok: true }),
  "/api/data": (res) => json(res, { items: [1, 2, 3], auth: { access_token: "ACCESS-SECRET-4" }, name: "Widget" }),
  "/api/bin": (res) => {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end(Buffer.from(Array.from({ length: 256 }, (_, i) => i)));
  },
  "/api/redirect": (res) => {
    res.writeHead(302, { location: "/api/data" });
    res.end();
  },
};

function json(res: import("node:http").ServerResponse, body: unknown): void {
  res.setHeader("set-cookie", "sid=COOKIE-SECRET-5; Path=/");
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export interface Fixture {
  origin: string;
  url(path: string): string;
  close(): Promise<void>;
}

export async function startFixture(): Promise<Fixture> {
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://fixture").pathname;
    if (path === "/slow") {
      // Headers right away, body never completes within a test's timeout: the page stays "loading".
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(page("Slow", "<h1>Slow page</h1>"));
      }, 8000).unref();
      return;
    }
    if (path === "/files/stuck") {
      // Download that starts and never finishes (until the fixture closes).
      res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="stuck.bin"', "content-length": "1000000" });
      res.write(Buffer.alloc(200_000, 97));
      return;
    }
    if (path === "/files/hang") {
      // Accepts the request and never answers: the navigation the click starts stays pending.
      return;
    }
    const file = path === "/files/report.txt" || path === "/files/evil" || path === "/files/leak";
    if (file) {
      const name = path === "/files/evil" ? "../../evil.txt" : path === "/files/leak" ? "jane.doe@example.com-A1b2C3d4E5f6G7h8I9j0K1l2M3.txt" : "report.txt";
      res.writeHead(200, { "content-type": "text/plain", "content-disposition": `attachment; filename="${name}"` });
      res.end("hello report");
      return;
    }
    if (path.startsWith("/assets/")) {
      // 1x1 PNG, and opaque bytes for the font and the audio file: blocking is decided by the request, not the content.
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
      const type = path.endsWith(".png") ? "image/png" : path.endsWith(".woff2") ? "font/woff2" : "audio/mpeg";
      res.writeHead(200, { "content-type": type });
      res.end(path.endsWith(".png") ? png : Buffer.alloc(64, 1));
      return;
    }
    if (path === "/sw.js") {
      res.writeHead(200, { "content-type": "application/javascript" });
      res.end("self.addEventListener('fetch', function () {});");
      return;
    }
    const api = API[path];
    if (api) {
      req.resume();
      req.on("end", () => api(res));
      return;
    }
    const html = PAGES[path];
    if (html === undefined) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    url: (path) => `${origin}${path}`,
    close: () =>
      new Promise<void>((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}

/** Finds `[ref=eN]` for the first snapshot line matching `re`. */
export function refFor(snapshot: string, re: RegExp): string {
  const line = snapshot.split("\n").find((l) => re.test(l));
  const ref = line && /\[ref=([a-z0-9]+)\]/i.exec(line)?.[1];
  if (!ref) throw new Error(`no ref for ${re} in snapshot:\n${snapshot.slice(0, 1500)}`);
  return ref;
}
