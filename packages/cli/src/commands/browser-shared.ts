import type { BrowserOp, BrowserOpParams, BrowserOpResult } from "@sitehound/core";
import { HoundError, isHoundError } from "@sitehound/core/errors";
import type { CommandContext, FlagSpec, NextAction } from "../framework/types.ts";
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
