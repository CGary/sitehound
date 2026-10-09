import { DEVICE_SCALE_FACTOR_MAX, DEVICE_SCALE_FACTOR_MIN } from "@sitehound/core/limits";
import { defineCommand } from "../framework/types.ts";
import { SESSION_FLAG, VIEWPORT_DESCRIPTION, VIEWPORT_RULE, callSession, sessionCmd, viewportFlag } from "./browser-shared.ts";
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
    dialog: {
      type: "enum",
      values: ["accept", "dismiss"],
      default: "dismiss",
      description:
        "Session default for JavaScript dialogs (alert, confirm, prompt, beforeunload; handled in every tab, never left hanging). dismiss cancels them; accept confirms them (e.g. 'Delete this record?') and needs --actions interact. Per-action override: --dialog on element click/press/...; see: hound diag dialogs",
    },
    viewport: { type: "string", ...VIEWPORT_RULE, description: `Viewport of every tab, ${VIEWPORT_DESCRIPTION} (default 1280x720). Change the active tab later with: hound page resize` },
    "device-scale-factor": { type: "integer", min: DEVICE_SCALE_FACTOR_MIN, max: DEVICE_SCALE_FACTOR_MAX, description: "Device pixel ratio of every tab (default 1); 2 gives retina-sharp screenshots" },
    mobile: { type: "boolean", description: "Mobile emulation: mobile viewport meta handling and touch events (isMobile + hasTouch); combine with --viewport 375x812" },
    "idle-timeout": { type: "integer", default: 30, min: 1, max: 1440, description: "Minutes of inactivity before the session closes itself" },
    trace: { type: "enum", values: ["off", "on"], default: "off", description: "on records a redacted trace exportable with: hound diag trace --action export" },
  },
  requiresWhen: [{ when: { dialog: "accept" }, restrict: { actions: ["interact"] } }],
  examples: [
    "hound browser open --session-name demo --json",
    "hound browser open --session-name work --profile work --actions interact --dialog accept --json",
    "hound browser open --session-name phone --viewport 375x812 --device-scale-factor 2 --mobile --json",
  ],
  async run(input, ctx) {
    const { openBrowserSession } = await import("@sitehound/core");
    const viewport = typeof input.viewport === "string" ? viewportFlag(input.viewport) : undefined;
    const info = await openBrowserSession({
      name: input["session-name"],
      ...(input.profile && { profile: input.profile }),
      actions: input.actions,
      display: input.display,
      dialog: input.dialog,
      idleTimeoutMinutes: input["idle-timeout"],
      trace: input.trace,
      ...(viewport && { viewport }),
      ...(input["device-scale-factor"] !== undefined && { deviceScaleFactor: input["device-scale-factor"] }),
      ...(input.mobile && { mobile: true }),
      ...(ctx.timeoutMs && { timeoutMs: ctx.timeoutMs }),
    });
    const s = info.name;
    return {
      summary: `Session "${s}" open (actions ${info.actions}, ${info.display}, dialogs ${info.dialog}${info.viewport ? `, viewport ${info.viewport.width}x${info.viewport.height}` : ""}${info.profile ? `, profile ${info.profile}` : ""}).`,
      data: {
        session: s,
        ...(info.profile && { profile: info.profile }),
        actions: info.actions,
        display: info.display,
        dialog: info.dialog,
        trace: info.trace,
        idleTimeoutMinutes: info.idleTimeoutMinutes,
        ...(info.viewport && { viewport: info.viewport }),
        ...(info.deviceScaleFactor !== undefined && { deviceScaleFactor: info.deviceScaleFactor }),
        ...(info.mobile && { mobile: true }),
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
      dialog: i.dialog ?? "dismiss",
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
        dialog: info.dialog ?? "dismiss",
        trace: info.trace,
        idleTimeoutMinutes: info.idleTimeoutMinutes,
        alive: info.alive,
        ...(info.viewport && { viewport: info.viewport }),
        ...(info.deviceScaleFactor !== undefined && { deviceScaleFactor: info.deviceScaleFactor }),
        ...(info.mobile && { mobile: true }),
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
