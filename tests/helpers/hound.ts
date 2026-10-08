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
<button id="b" onclick="location.href='/files/report.txt'">Export PDF</button>
<button id="n" onclick="void 0">Do nothing</button>`,
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
    const file = path === "/files/report.txt" || path === "/files/evil" || path === "/files/leak";
    if (file) {
      const name = path === "/files/evil" ? "../../evil.txt" : path === "/files/leak" ? "jane.doe@example.com-A1b2C3d4E5f6G7h8I9j0K1l2M3.txt" : "report.txt";
      res.writeHead(200, { "content-type": "text/plain", "content-disposition": `attachment; filename="${name}"` });
      res.end("hello report");
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
