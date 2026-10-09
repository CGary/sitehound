import { HoundError } from "@sitehound/core/errors";
import { BLOCK_CATEGORIES, BLOCK_PATTERN, DEVICE_SCALE_FACTOR_MAX, DEVICE_SCALE_FACTOR_MIN, GEOLOCATION_PATTERN, GEOLOCATION_RANGE, LOCALE_PATTERN, TIMEZONE_PATTERN, isValidLocale, isValidTimezone, parseBlockList, parseGeolocation } from "@sitehound/core/limits";
import type { BrowserSessionInfo } from "@sitehound/core";
import { defineCommand } from "../framework/types.ts";
import { SESSION_FLAG, VIEWPORT_DESCRIPTION, VIEWPORT_RULE, callSession, sessionCmd, viewportFlag } from "./browser-shared.ts";
import { NAME_RULE, houndCmd } from "./shared.ts";

/** The block / locale / timezone / geolocation facts of a session, for open and status data (only what was set). */
const environmentData = (info: BrowserSessionInfo) => ({
  ...(info.block?.length && { block: info.block }),
  ...(info.locale && { locale: info.locale }),
  ...(info.timezone && { timezone: info.timezone }),
  ...(info.geolocation && { geolocation: info.geolocation }),
});

const invalid = (field: string, received: string, message: string): HoundError => new HoundError("INVALID_ARGUMENT", message, { field, received: received.slice(0, 80), retryable: true });

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
        "read: navigation and reading; clicks only on real http(s) links and <summary> (links that look like GET side effects, e.g. /logout or \"Delete\", are refused; a heuristic); no fills, selects, key presses or button clicks. interact: all of it",
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
    block: {
      type: "string",
      pattern: BLOCK_PATTERN,
      patternHint: `a comma list of ${BLOCK_CATEGORIES.join(", ")}, e.g. analytics,images`,
      maxLength: 60,
      description:
        "Refuse request categories for the whole session, comma list of: analytics (well-known analytics and session-replay collectors), ads (well-known ad networks), images, media (audio/video), fonts. Cuts noise and load time; blocked requests are listed by 'diag network --state all' (failure 'blocked'), never as failures. Pages that need a blocked resource may look broken. Side effects: the browser HTTP cache is off for the session (every request goes to the network) and service workers are blocked (offline/PWA features and push do not work), because their requests would bypass the blocking",
    },
    locale: { type: "string", pattern: LOCALE_PATTERN, patternHint: "a BCP 47 language tag such as es-AR, en-US or pt-BR", maxLength: 35, description: "Browser language for every tab (navigator.language, Accept-Language, Intl formats), a BCP 47 tag such as es-AR" },
    timezone: { type: "string", pattern: TIMEZONE_PATTERN, patternHint: "an IANA time zone name such as Europe/Madrid", maxLength: 64, description: "Time zone for every tab, an IANA name such as America/Argentina/Buenos_Aires (Intl and Date follow it)" },
    geolocation: {
      type: "string",
      pattern: GEOLOCATION_PATTERN,
      patternHint: `LAT,LON[,ACCURACY]: ${GEOLOCATION_RANGE}, e.g. -34.6037,-58.3816`,
      maxLength: 60,
      description: `Fixed position for navigator.geolocation as LAT,LON[,ACCURACY] (${GEOLOCATION_RANGE}); also grants the geolocation permission to every site in the session (a negative latitude needs --geolocation=-34.6,-58.4)`,
    },
    "idle-timeout": { type: "integer", default: 30, min: 1, max: 1440, description: "Minutes of inactivity before the session closes itself" },
    trace: { type: "enum", values: ["off", "on"], default: "off", description: "on records a redacted trace exportable with: hound diag trace --action export" },
  },
  requiresWhen: [{ when: { dialog: "accept" }, restrict: { actions: ["interact"] } }],
  examples: [
    "hound browser open --session-name demo --json",
    "hound browser open --session-name work --profile work --actions interact --dialog accept --json",
    "hound browser open --session-name ar --locale es-AR --timezone America/Argentina/Buenos_Aires --geolocation=-34.6037,-58.3816 --block analytics,ads,fonts --json",
  ],
  async run(input, ctx) {
    const { openBrowserSession } = await import("@sitehound/core");
    const viewport = typeof input.viewport === "string" ? viewportFlag(input.viewport) : undefined;
    const block = typeof input.block === "string" ? parseBlockList(input.block) : undefined;
    if (typeof input.locale === "string" && !isValidLocale(input.locale)) throw invalid("locale", input.locale, `--locale "${input.locale.slice(0, 40)}" is not a valid BCP 47 language tag; use e.g. es-AR, en-US or pt-BR.`);
    if (typeof input.timezone === "string" && !isValidTimezone(input.timezone)) throw invalid("timezone", input.timezone, `--timezone "${input.timezone.slice(0, 64)}" is not a known IANA time zone; use e.g. Europe/Madrid or America/Argentina/Buenos_Aires.`);
    const geolocation = typeof input.geolocation === "string" ? parseGeolocation(input.geolocation) : undefined;
    if (typeof input.geolocation === "string" && !geolocation) throw invalid("geolocation", input.geolocation, `--geolocation must be LAT,LON[,ACCURACY] with ${GEOLOCATION_RANGE}.`);
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
      ...(block && { block }),
      ...(typeof input.locale === "string" && { locale: input.locale }),
      ...(typeof input.timezone === "string" && { timezone: input.timezone }),
      ...(geolocation && { geolocation }),
      ...(ctx.timeoutMs && { timeoutMs: ctx.timeoutMs }),
    });
    const s = info.name;
    return {
      summary: `Session "${s}" open (actions ${info.actions}, ${info.display}, dialogs ${info.dialog}${info.viewport ? `, viewport ${info.viewport.width}x${info.viewport.height}` : ""}${info.block?.length ? `, blocking ${info.block.join("+")}` : ""}${info.locale ? `, locale ${info.locale}` : ""}${info.timezone ? `, timezone ${info.timezone}` : ""}${info.geolocation ? ", geolocation set" : ""}${info.profile ? `, profile ${info.profile}` : ""}).`,
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
        ...environmentData(info),
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
        ...environmentData(info),
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
