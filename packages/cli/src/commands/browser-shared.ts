import type { BrowserOp, BrowserOpParams, BrowserOpResult, DialogEntry } from "@sitehound/core";
import { HoundError, isHoundError } from "@sitehound/core/errors";
import { DIALOG_TEXT_MAX_CHARS, VIEWPORT_MAX_HEIGHT, VIEWPORT_MAX_WIDTH, VIEWPORT_MIN_HEIGHT, VIEWPORT_MIN_WIDTH, VIEWPORT_PATTERN, parseViewport } from "@sitehound/core/limits";
import type { CommandContext, ConditionalRule, FlagSpec, NextAction } from "../framework/types.ts";
import { NAME_RULE, houndCmd } from "./shared.ts";

/** The required --session-name flag shared by every page/element/diag command. */
export const SESSION_FLAG: Record<string, FlagSpec> = {
  "session-name": { type: "string", required: true, ...NAME_RULE, description: "Browser session id (see: hound browser open, hound browser list)" },
};

/** Element refs come from the latest snapshot: e12 (main frame) or f3e4 (frame 3). */
export const REF_RULE: Pick<FlagSpec, "pattern" | "patternFlags" | "patternHint" | "maxLength"> = {
  pattern: "^(?:[a-z]+[0-9]+)+$",
  patternFlags: "i",
  patternHint: "refs look like e12 or f3e4 and come from the latest page snapshot",
  maxLength: 32,
};

/** Sends one op to a running browser session. The core client is imported lazily to keep startup light. */
export async function callSession<O extends BrowserOp>(ctx: CommandContext, session: string, op: O, params: BrowserOpParams<O>): Promise<BrowserOpResult<O>> {
  const { callBrowserSession } = await import("@sitehound/core");
  return callBrowserSession<BrowserOpResult<O>>(session, op, params as Record<string, unknown>, ctx.timeoutMs ? { timeoutMs: ctx.timeoutMs } : {});
}

/** `hound <domain> <verb> --session-name <s> ... --json` */
export const sessionCmd = (domain: string, verb: string, session: string, ...rest: string[]): string => houndCmd(domain, verb, "--session-name", session, ...rest);

export const snapshotAction = (session: string, reason: string): NextAction => ({ command: sessionCmd("page", "snapshot", session), reason });

/** Secrets shorter than this are never scrubbed (too likely to corrupt ordinary words); the daemon never echoes them. */
export const MIN_SCRUB_LENGTH = 8;

/** Re-throws `err` with every occurrence of `secret` (8+ chars) removed from its text fields. */
export function scrubSecret(err: unknown, secret: string): never {
  if (secret.length < MIN_SCRUB_LENGTH || !isHoundError(err)) throw err;
  const clean = (v: string): string => v.split(secret).join("[redacted]");
  const d = err.details;
  throw new HoundError(err.code, clean(err.message), {
    ...d,
    ...(typeof d.received === "string" && { received: clean(d.received) }),
    ...(d.suggestedFix && { suggestedFix: clean(d.suggestedFix) }),
  });
}

/** Per-action dialog override for the actions that can trigger alert/confirm/prompt/beforeunload. */
export const DIALOG_FLAGS: Record<string, FlagSpec> = {
  dialog: {
    type: "enum",
    values: ["accept", "dismiss"],
    description:
      "How to answer JavaScript dialogs (alert, confirm, prompt, beforeunload) opened during this action; default: the session's --dialog. accept needs a session opened with --actions interact (ACTION_BLOCKED otherwise). Handled dialogs are in data.dialogs",
  },
  "dialog-text": {
    type: "string",
    sensitive: true,
    maxLength: DIALOG_TEXT_MAX_CHARS,
    description: `Answer for a prompt() dialog, at most ${DIALOG_TEXT_MAX_CHARS} characters; used when the dialog is accepted. Never echoed`,
  },
};
export const DIALOG_RULES: readonly ConditionalRule[] = [{ when: { dialog: "dismiss" }, forbid: ["dialog-text"] }];

/** The daemon params for the dialog flags. */
export const dialogParams = (input: Record<string, unknown>): { dialog?: "accept" | "dismiss"; dialogText?: string } => ({
  ...(input.dialog !== undefined && { dialog: input.dialog as "accept" | "dismiss" }),
  ...(typeof input["dialog-text"] === "string" && { dialogText: input["dialog-text"] }),
});

/** `data.dialogs` for an op result, only when dialogs were handled. */
export const dialogData = (r: { dialogs?: DialogEntry[] }): { dialogs?: DialogEntry[] } => (r.dialogs?.length ? { dialogs: r.dialogs } : {});

/** A summary suffix naming the dialogs an action handled ("" when none). */
export function dialogNote(r: { dialogs?: DialogEntry[] }): string {
  const d = r.dialogs;
  if (!d?.length) return "";
  const kinds = [...new Set(d.map((x) => `${x.type} ${x.action}`))];
  return ` ${d.length} dialog(s) handled (${kinds.join(", ")}); see data.dialogs.`;
}

const VIEWPORT_RANGE = `width ${VIEWPORT_MIN_WIDTH}..${VIEWPORT_MAX_WIDTH}, height ${VIEWPORT_MIN_HEIGHT}..${VIEWPORT_MAX_HEIGHT}`;

/** The --viewport flag: shape declared as a pattern, bounds checked by `viewportFlag`. */
export const VIEWPORT_RULE: Pick<FlagSpec, "pattern" | "patternFlags" | "patternHint" | "maxLength"> = {
  pattern: VIEWPORT_PATTERN,
  patternFlags: "i",
  patternHint: `WIDTHxHEIGHT in CSS pixels (${VIEWPORT_RANGE}), e.g. 375x812`,
  maxLength: 9,
};
export const VIEWPORT_DESCRIPTION = `WIDTHxHEIGHT in CSS pixels, ${VIEWPORT_RANGE} (e.g. 375x812 phone, 1280x720 desktop)`;

/** Parses a --viewport value; INVALID_ARGUMENT when a side is outside the bounds. */
export function viewportFlag(text: string): { width: number; height: number } {
  const v = parseViewport(text);
  if (!v) {
    throw new HoundError("INVALID_ARGUMENT", `--viewport "${text.slice(0, 20)}" is out of range: ${VIEWPORT_RANGE}.`, { field: "viewport", received: text.slice(0, 20), retryable: true });
  }
  return v;
}
