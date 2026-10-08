import { defineCommand } from "../framework/types.ts";
import { SESSION_FLAG, callSession, sessionCmd } from "./browser-shared.ts";
import { NAME_RULE, houndCmd } from "./shared.ts";

export const browserOpen = defineCommand({
  name: "browser.open",
  description: "Start a persistent browser session (optionally with a saved login) that page/element/diag commands then drive.",
  kind: "session",
  flags: {
    "session-name": { type: "string", required: true, ...NAME_RULE, description: "Id for the new session (letters, digits, '-', '_', '.')" },
    profile: { type: "string", ...NAME_RULE, description: "Saved login to load (see: hound profile list)" },
    actions: {
      type: "enum",
      values: ["read", "interact"],
      default: "read",
      description:
        "read: navigation and reading; clicks only on real http(s) links and <summary> (GET links with side effects, e.g. /logout, are not detected); no fills, selects, key presses or button clicks. interact: all of it",
    },
    display: { type: "enum", values: ["headless", "headed"], default: "headless", description: "headed shows the browser window" },
    "idle-timeout": { type: "integer", default: 30, min: 1, max: 1440, description: "Minutes of inactivity before the session closes itself" },
    trace: { type: "enum", values: ["off", "on"], default: "off", description: "on records a redacted trace exportable with: hound diag trace --action export" },
  },
  examples: [
    "hound browser open --session-name demo --json",
    "hound browser open --session-name work --profile work --actions interact --json",
    "hound browser open --session-name dbg --actions interact --trace on --display headed --idle-timeout 60 --json",
  ],
  async run(input, ctx) {
    const { openBrowserSession } = await import("@sitehound/core");
    const info = await openBrowserSession({
      name: input["session-name"],
      ...(input.profile && { profile: input.profile }),
      actions: input.actions,
      display: input.display,
      idleTimeoutMinutes: input["idle-timeout"],
      trace: input.trace,
      ...(ctx.timeoutMs && { timeoutMs: ctx.timeoutMs }),
    });
    const s = info.name;
    return {
      summary: `Session "${s}" open (actions ${info.actions}, ${info.display}${info.profile ? `, profile ${info.profile}` : ""}).`,
      data: {
        session: s,
        ...(info.profile && { profile: info.profile }),
        actions: info.actions,
        display: info.display,
        trace: info.trace,
        idleTimeoutMinutes: info.idleTimeoutMinutes,
        pid: info.pid,
        startedAt: info.startedAt,
      },
      next_actions: [
        { command: sessionCmd("page", "navigate", s, "--url", "<url>"), reason: "Open a page (replace <url>)." },
        { command: sessionCmd("browser", "close", s), reason: "Close the session when done." },
      ],
    };
  },
});

export const browserClose = defineCommand({
  name: "browser.close",
  description: "Close a browser session and remove its state. Idempotent: closing an unknown session succeeds with closed=false.",
  kind: "session",
  flags: { ...SESSION_FLAG },
  examples: [
    "hound browser close --session-name demo --json",
    "hound browser close --session-name work --plain",
    "hound browser list --json",
  ],
  async run(input) {
    const { closeBrowserSession } = await import("@sitehound/core");
    const session: string = input["session-name"];
    const { closed } = await closeBrowserSession(session);
    return {
      summary: closed ? `Session "${session}" closed.` : `Nothing was open under "${session}".`,
      data: { session, closed },
    };
  },
});

export const browserList = defineCommand({
  name: "browser.list",
  description: "List running browser sessions.",
  kind: "read",
  flags: {},
  examples: ["hound browser list --json", "hound browser list --plain", "hound browser open --session-name demo --json"],
  async run() {
    const { listBrowserSessions } = await import("@sitehound/core");
    const list = await listBrowserSessions();
    const sessions = list.map((i) => ({
      session: i.name,
      ...(i.profile && { profile: i.profile }),
      actions: i.actions,
      display: i.display,
      trace: i.trace,
      alive: i.alive,
      startedAt: i.startedAt,
      ...(i.currentUrl && { url: i.currentUrl }),
      ...(i.tabs !== undefined && { tabs: i.tabs }),
    }));
    return {
      summary: sessions.length ? `${sessions.length} session(s) running.` : "No browser sessions running.",
      data: { count: sessions.length, sessions },
      plain: sessions.map((s) => `${s.session.padEnd(16)} ${s.actions.padEnd(9)} ${s.url ?? ""}`.trimEnd()).join("\n") || "No browser sessions running.",
      next_actions: sessions[0]
        ? [{ command: sessionCmd("browser", "status", sessions[0].session), reason: "Inspect a session." }]
        : [{ command: houndCmd("browser", "open", "--session-name", "<session-name>"), reason: "Start a session (replace <session-name>)." }],
    };
  },
});

export const browserStatus = defineCommand({
  name: "browser.status",
  description: "Show one browser session: access level, current URL and tab count.",
  kind: "read",
  flags: { ...SESSION_FLAG },
  examples: [
    "hound browser status --session-name demo --json",
    "hound browser status --session-name work --plain",
    "hound browser list --json",
  ],
  async run(input, ctx) {
    const session: string = input["session-name"];
    const info = await callSession(ctx, session, "status", {});
    return {
      summary: `Session "${session}" is ${info.alive ? "running" : "not responding"}${info.currentUrl ? ` at ${info.currentUrl}` : ""}.`,
      data: {
        session,
        ...(info.profile && { profile: info.profile }),
        actions: info.actions,
        display: info.display,
        trace: info.trace,
        idleTimeoutMinutes: info.idleTimeoutMinutes,
        alive: info.alive,
        pid: info.pid,
        startedAt: info.startedAt,
        ...(info.currentUrl && { url: info.currentUrl }),
        ...(info.tabs !== undefined && { tabs: info.tabs }),
      },
      next_actions: [{ command: sessionCmd("page", "snapshot", session), reason: "Read the current page." }],
    };
  },
});

export const browserCommands = [browserOpen, browserClose, browserList, browserStatus];
