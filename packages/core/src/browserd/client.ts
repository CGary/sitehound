/**
 * Client side of the browser-session daemon: spawns it, talks to it over its unix socket, and
 * cleans up state left by daemons that died. Every failure is a HoundError.
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { HoundError, isHoundError, type ErrorCode, type HoundErrorDetails } from "../errors.ts";
import { HOUND_HOME, SESSIONS_DIR, assertSafeName, ensurePrivateDir } from "../paths.ts";
import { hasProfile } from "../profiles.ts";
import { redactText } from "../redact.ts";
import {
  CONFIG_FILE,
  DAEMON_ENTRY,
  LOG_FILE,
  PID_FILE,
  STARTUP_ERROR_FILE,
  assertIdleTimeout,
  isDaemonProcess,
  isPidAlive,
  isStateChanging,
  readJson,
  readState,
  removeSessionDir,
  sessionDir,
  sessionNotFound,
  socketPathFor,
  writePrivateJson,
} from "./state.ts";
import {
  BROWSER_OPS,
  type BrowserOp,
  type BrowserSessionInfo,
  type DaemonConfig,
  type DaemonState,
  type OpenBrowserSessionOptions,
  type WireResponse,
  typingTimeoutMs,
} from "./types.ts";

/** A session dir with no state yet is "starting" for this long, then considered stale. */
const STARTING_GRACE_MS = 60_000;
const DEFAULT_OPEN_TIMEOUT_MS = 30_000;
const DEFAULT_OP_TIMEOUT_MS = 30_000;
/** The daemon replies with its own TIMEOUT shortly before the deadline; the client waits this much longer. */
const CLIENT_MARGIN_MS = 2_000;
/** Liveness probe: a daemon that cannot answer a ping in this long (twice) is treated as not answering. */
const PING_TIMEOUT_MS = 500;
const OPS_WITH_TIMEOUT = new Set<BrowserOp>([
  "navigate", "snapshot", "screenshot", "wait", "back", "forward", "reload", "tabs", "click", "hover", "fill", "select", "press", "type", "download", "request",
]);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function invalidEnum(field: string, received: unknown, allowed: readonly string[]): HoundError {
  return new HoundError("INVALID_ENUM", `Invalid --${field} "${String(received)}".`, { field, received, allowed });
}

/** Last lines of daemon.log, redacted. The log never holds page content, but redact anyway. */
async function logTail(dir: string, lines = 8): Promise<string[]> {
  const text = await readFile(join(dir, LOG_FILE), "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((l) => l.trim())
    .slice(-lines)
    .map((l) => redactText(l, 300));
}

function infoFrom(state: DaemonConfig & { pid: number; startedAt: string }, alive: boolean): BrowserSessionInfo {
  return {
    name: state.name,
    pid: state.pid,
    ...(state.profile ? { profile: state.profile } : {}),
    actions: state.actions,
    display: state.display,
    trace: state.trace,
    startedAt: state.startedAt,
    idleTimeoutMinutes: state.idleTimeoutMinutes,
    alive,
  };
}

interface RequestOptions {
  /** Epoch ms after which the daemon should not start / keep working on the op. */
  deadline?: number;
  /** The timeout the user asked for; the only number quoted in a TIMEOUT message. */
  shownMs?: number;
  /** The op may have taken effect even though the client gave up (navigate, click, ...). */
  stateChanging?: boolean;
}

const formatSeconds = (ms: number) => `${Math.round(ms / 100) / 10}s`;

function clientTimeout(op: BrowserOp, shownMs: number, stateChanging: boolean): HoundError {
  if (stateChanging) {
    return new HoundError(
      "TIMEOUT",
      `The browser session did not answer "${op}" within ${formatSeconds(shownMs)}; it may still have been applied; run page snapshot before retrying.`,
      { retryable: false },
    );
  }
  return new HoundError("TIMEOUT", `The browser session did not answer "${op}" within ${formatSeconds(shownMs)}.`, { retryable: true });
}

/** Sends one request and waits for its response line (the client leaves at deadline + margin). */
function request(socket: string, op: BrowserOp, params: Record<string, unknown>, timeoutMs: number, opts: RequestOptions = {}): Promise<WireResponse> {
  return new Promise((resolvePromise, reject) => {
    const conn = createConnection(socket);
    let buf = "";
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.destroy();
      fn();
    };
    const timer = setTimeout(
      () => done(() => reject(clientTimeout(op, opts.shownMs ?? timeoutMs, opts.stateChanging === true))),
      timeoutMs,
    );
    conn.setEncoding("utf8");
    conn.on("connect", () => conn.write(JSON.stringify({ id: 1, op, params, ...(opts.deadline !== undefined ? { deadline: opts.deadline } : {}) }) + "\n"));
    conn.on("data", (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      done(() => {
        try {
          resolvePromise(JSON.parse(line) as WireResponse);
        } catch {
          reject(new HoundError("INTERNAL_ERROR", "The browser session sent an unreadable response."));
        }
      });
    });
    conn.on("error", (err: NodeJS.ErrnoException) => done(() => reject(Object.assign(new Error("socket"), { code: err.code ?? "ESOCKET" }))));
    conn.on("close", () => done(() => reject(Object.assign(new Error("socket"), { code: "ECLOSED" }))));
  });
}

/**
 * Identity check: the session's socket answers `ping` with this pid and session name. Nothing is ever
 * signalled on the strength of state.json alone (pids get reused), so this is the gate for everything.
 */
async function pingIdentity(dir: string, name: string, pid: number): Promise<boolean> {
  const socket = socketPathFor(dir);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await request(socket, "ping", {}, PING_TIMEOUT_MS);
      if (!res.ok) return false;
      const r = res.result as { pid?: unknown; name?: unknown };
      return r.pid === pid && r.name === name;
    } catch (err) {
      if (!isHoundError(err)) return false; // refused / no such socket: nobody is listening
      // a ping that timed out: retry once
    }
  }
  return false;
}

type Probe =
  | { kind: "none" }
  | { kind: "starting" }
  | { kind: "live"; state: DaemonState }
  /** Not answering ping, but the pid is positively one of our daemons (/proc cmdline). */
  | { kind: "unresponsive"; pid: number; state?: DaemonState }
  | { kind: "dead" };

function validState(state: DaemonState | undefined, name: string): DaemonState | undefined {
  return state && Number.isInteger(state.pid) && state.pid > 1 && state.name === name ? state : undefined;
}

async function pidFromFile(dir: string): Promise<number | undefined> {
  const pid = Number.parseInt(await readFile(join(dir, PID_FILE), "utf8").catch(() => ""), 10);
  return Number.isInteger(pid) && pid > 1 ? pid : undefined;
}

async function probe(name: string, dir: string): Promise<Probe> {
  if (!existsSync(dir)) return { kind: "none" };
  const state = validState(await readState(dir), name);
  if (state) {
    if (await pingIdentity(dir, name, state.pid)) return { kind: "live", state };
    return isDaemonProcess(state.pid, dir) ? { kind: "unresponsive", pid: state.pid, state } : { kind: "dead" };
  }
  const pid = await pidFromFile(dir);
  const young = await isYoung(dir);
  if (pid && isDaemonProcess(pid, dir)) return young ? { kind: "starting" } : { kind: "unresponsive", pid };
  if (young && (pid === undefined || isPidAlive(pid))) return { kind: "starting" };
  return { kind: "dead" };
}

/** SIGTERM then SIGKILL, each only while the pid is still verified as this session's daemon. */
async function terminateVerified(dir: string, name: string, pid: number): Promise<void> {
  const verified = async () => isDaemonProcess(pid, dir) || (await pingIdentity(dir, name, pid));
  if (!(await verified())) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && isPidAlive(pid)) await sleep(100);
  if (isPidAlive(pid) && (await verified())) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

const notAnswering = (name: string): HoundError =>
  new HoundError("BROWSER_CRASHED", `Browser session "${name}" is running but not answering (busy or hung).`, {
    field: "session-name",
    received: name,
    retryable: true,
    suggestedFix: `hound browser close --session-name ${name} --json`,
  });

const stillStarting = (name: string): HoundError =>
  new HoundError("SESSION_NOT_FOUND", `Browser session "${name}" is still starting.`, { field: "session-name", received: name, retryable: true });

/** Ensures the dir belongs to a live daemon (identity-checked); cleans a dead one and throws SESSION_NOT_FOUND. */
async function liveState(name: string): Promise<{ dir: string; state: DaemonState }> {
  const dir = sessionDir(name);
  const p = await probe(name, dir);
  switch (p.kind) {
    case "live":
      return { dir, state: p.state };
    case "starting":
      throw stillStarting(name);
    case "unresponsive":
      throw notAnswering(name);
    case "none":
      throw sessionNotFound(name);
    case "dead":
      await removeSessionDir(dir);
      throw sessionNotFound(name, "The browser session's daemon is no longer running (crashed or killed); its state was cleaned up.");
  }
}

async function isYoung(dir: string): Promise<boolean> {
  const info = await stat(dir).catch(() => undefined);
  return !!info && Date.now() - info.mtimeMs < STARTING_GRACE_MS;
}

async function send<T>(name: string, dir: string, state: DaemonState, op: BrowserOp, params: Record<string, unknown>, timeoutMs: number, opts: RequestOptions = {}): Promise<T> {
  let res: WireResponse;
  try {
    res = await request(socketPathFor(dir), op, params, timeoutMs, opts);
  } catch (err) {
    if (isHoundError(err)) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ECLOSED" && op === "close") return { closed: true } as T;
    await sleep(300);
    const p = await probe(name, dir);
    if (p.kind === "none" || p.kind === "dead") {
      if (p.kind === "dead") await removeSessionDir(dir);
      if (code === "ECLOSED") {
        throw new HoundError("BROWSER_CRASHED", `Browser session "${name}" ended while handling "${op}".`, {
          suggestedFix: `hound browser open --session-name ${name} --json`,
        });
      }
      throw sessionNotFound(name);
    }
    if (p.kind === "unresponsive") throw notAnswering(name);
    throw new HoundError("BROWSER_CRASHED", `Browser session "${name}" is not accepting requests (${code}).`, {
      retryable: true,
      suggestedFix: `hound browser close --session-name ${name} --json`,
    });
  }
  if (res.ok) return res.result as T;
  throw HoundError.fromJSON(res.error);
}

export async function callBrowserSession<T = unknown>(
  name: string,
  op: BrowserOp,
  params: Record<string, unknown>,
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  if (!BROWSER_OPS.includes(op)) throw invalidEnum("op", op, BROWSER_OPS);
  const started = Date.now();
  const { dir, state } = await liveState(name);
  const p: Record<string, unknown> = { ...params };
  if (op === "snapshot" && typeof p.output === "string" && p.output) p.output = resolve(process.cwd(), p.output);
  if ((op === "screenshot" || op === "download" || op === "request") && typeof p.output === "string" && p.output) p.output = resolve(process.cwd(), p.output);
  // Typing takes chars x delay: unless the caller set a timeout, give the op the time that needs.
  if (op === "type" && opts.timeoutMs === undefined && p.timeoutMs === undefined && typeof p.value === "string") {
    p.timeoutMs = typingTimeoutMs(p.value.length, typeof p.delayMs === "number" ? p.delayMs : 30);
  }
  // The user's number is both what the op is told (the daemon clips it to the deadline) and what a TIMEOUT message quotes.
  if (opts.timeoutMs !== undefined && p.timeoutMs === undefined && OPS_WITH_TIMEOUT.has(op)) p.timeoutMs = opts.timeoutMs;
  const shownMs = opts.timeoutMs ?? (typeof p.timeoutMs === "number" ? p.timeoutMs : op === "trace-export" ? 120_000 : DEFAULT_OP_TIMEOUT_MS);
  const deadline = started + shownMs;
  return send<T>(name, dir, state, op, p, Math.max(1, deadline - Date.now()) + CLIENT_MARGIN_MS, {
    deadline,
    shownMs,
    stateChanging: isStateChanging(op, p),
  });
}

export async function openBrowserSession(opts: OpenBrowserSessionOptions): Promise<BrowserSessionInfo> {
  const { name, profile } = opts;
  assertSafeName("session-name", name);
  if (opts.actions !== "read" && opts.actions !== "interact") throw invalidEnum("actions", opts.actions, ["read", "interact"]);
  if (opts.display !== "headless" && opts.display !== "headed") throw invalidEnum("display", opts.display, ["headless", "headed"]);
  if (opts.trace !== "off" && opts.trace !== "on") throw invalidEnum("trace", opts.trace, ["off", "on"]);
  assertIdleTimeout(opts.idleTimeoutMinutes);
  if (profile !== undefined && !hasProfile(profile)) {
    throw new HoundError("PROFILE_NOT_FOUND", `Profile "${profile}" not found.`, {
      field: "profile",
      received: profile,
      suggestedFix: "hound profile list --json",
    });
  }

  const dir = sessionDir(name);
  await ensurePrivateDir(SESSIONS_DIR);
  await claimDir(name, dir);

  const config: DaemonConfig = {
    name,
    ...(profile ? { profile } : {}),
    actions: opts.actions,
    display: opts.display,
    trace: opts.trace,
    idleTimeoutMinutes: opts.idleTimeoutMinutes,
  };
  await writePrivateJson(join(dir, CONFIG_FILE), config);

  const logFd = openSync(join(dir, LOG_FILE), "a", 0o600);
  const env: NodeJS.ProcessEnv = { ...process.env, HOUND_HOME };
  // Debug switches would make Playwright print protocol traffic (cookies, headers) into daemon.log.
  delete env.DEBUG;
  delete env.PWDEBUG;
  delete env.NODE_OPTIONS;
  let exited: { code: number | null; signal: string | null } | undefined;
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", DAEMON_ENTRY, dir], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env,
  });
  closeSync(logFd);
  child.on("exit", (code, signal) => (exited = { code, signal }));
  child.on("error", () => (exited = { code: -1, signal: null }));
  child.unref();
  if (child.pid) await writeFile(join(dir, PID_FILE), String(child.pid), { mode: 0o600 });

  const timeoutMs = opts.timeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const fail = async (code: ErrorCode, message: string, details: HoundErrorDetails = {}): Promise<never> => {
    const log = await logTail(dir);
    await removeSessionDir(dir);
    throw new HoundError(code, message, { ...details, data: { log } });
  };

  while (Date.now() < deadline) {
    if (exited) {
      const startup = await readJson<{ code: ErrorCode; message: string; details?: HoundErrorDetails }>(join(dir, STARTUP_ERROR_FILE));
      if (startup) {
        await removeSessionDir(dir);
        throw HoundError.fromJSON(startup);
      }
      return fail("BROWSER_CRASHED", `The browser session daemon exited during startup (code ${exited.code ?? exited.signal}).`);
    }
    const state = await readState(dir);
    if (state) {
      try {
        const res = await request(socketPathFor(dir), "status", {}, 2000);
        if (res.ok) return res.result as BrowserSessionInfo;
      } catch {
        // not listening yet
      }
    }
    await sleep(100);
  }
  // child.pid is the process spawned a moment ago and not yet reaped (`exited` unset), so it is ours.
  if (child.pid && !exited && isPidAlive(child.pid)) {
    try {
      process.kill(child.pid, "SIGTERM");
    } catch {}
    await sleep(2000);
    if (!exited && isPidAlive(child.pid)) {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {}
    }
  }
  return fail("TIMEOUT", `The browser session did not become ready within ${Math.round(timeoutMs / 1000)}s.`, { retryable: true });
}

/** Creates the session dir exclusively; reclaims it when nothing identifiable owns it. */
async function claimDir(name: string, dir: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await mkdir(dir, { mode: 0o700 });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const p = await probe(name, dir);
    if (p.kind === "live" || p.kind === "starting" || p.kind === "unresponsive") {
      throw new HoundError("SESSION_EXISTS", `Browser session "${name}" is already running.`, {
        field: "session-name",
        received: name,
        suggestedFix: p.kind === "unresponsive" ? `hound browser close --session-name ${name} --json` : `hound browser status --session-name ${name} --json`,
      });
    }
    if (p.kind === "dead") await removeSessionDir(dir);
  }
  throw new HoundError("CONFLICT", `Could not claim the session directory for "${name}".`, { retryable: true });
}

export async function closeBrowserSession(name: string): Promise<{ closed: boolean }> {
  const dir = sessionDir(name);
  const p = await probe(name, dir);
  switch (p.kind) {
    case "none":
      return { closed: false };
    case "starting":
      throw stillStarting(name);
    case "dead":
      await removeSessionDir(dir);
      return { closed: false };
    case "unresponsive":
      await terminateVerified(dir, name, p.pid);
      await removeSessionDir(dir);
      return { closed: true };
    case "live":
      break;
  }
  const { state } = p;
  try {
    await send(name, dir, state, "close", {}, 20_000);
  } catch {
    // fall through to the forced path below
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && isPidAlive(state.pid)) await sleep(100);
  if (isPidAlive(state.pid)) await terminateVerified(dir, name, state.pid);
  if (existsSync(dir)) await removeSessionDir(dir);
  return { closed: true };
}

export async function browserSessionStatus(name: string): Promise<BrowserSessionInfo> {
  const { dir, state } = await liveState(name);
  return send<BrowserSessionInfo>(name, dir, state, "status", {}, 5000);
}

export async function listBrowserSessions(): Promise<BrowserSessionInfo[]> {
  const names = await readdir(SESSIONS_DIR).catch(() => [] as string[]);
  const out: BrowserSessionInfo[] = [];
  for (const name of names.sort()) {
    let dir: string;
    try {
      dir = sessionDir(name);
    } catch {
      continue;
    }
    const p = await probe(name, dir);
    if (p.kind === "none") continue;
    if (p.kind === "dead") {
      await removeSessionDir(dir);
      continue;
    }
    if (p.kind === "live") {
      try {
        const res = await request(socketPathFor(dir), "status", {}, 2000);
        out.push(res.ok ? (res.result as BrowserSessionInfo) : infoFrom(p.state, true));
      } catch {
        out.push(infoFrom(p.state, true));
      }
      continue;
    }
    // starting / unresponsive: report what the config says
    const state = p.kind === "unresponsive" ? p.state : undefined;
    const config = state ?? (await readJson<DaemonConfig>(join(dir, CONFIG_FILE)));
    const pid = p.kind === "unresponsive" ? p.pid : ((await pidFromFile(dir)) ?? 0);
    if (config) out.push(infoFrom({ ...config, pid, startedAt: state?.startedAt ?? "" }, p.kind === "starting"));
  }
  return out;
}
