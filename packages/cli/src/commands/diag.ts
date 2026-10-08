import { defineCommand } from "../framework/types.ts";
import type { NextAction } from "../framework/types.ts";
import { givenInput, readFileAction } from "./shared.ts";
import { SESSION_FLAG, callSession, sessionCmd, snapshotAction } from "./browser-shared.ts";
import { OUTPUT_FLAGS, checkOutputPath } from "./output.ts";

const LIMIT_FLAG = { type: "integer", default: 20, min: 1, max: 500, description: "Max entries returned (newest kept)" } as const;

export const diagConsole = defineCommand({
  name: "diag.console",
  description: "Read console errors/warnings and uncaught page errors collected since the session started.",
  kind: "read",
  flags: {
    ...SESSION_FLAG,
    level: { type: "enum", values: ["error", "warning", "all"], default: "error", description: "all = errors and warnings" },
    limit: LIMIT_FLAG,
  },
  examples: [
    "hound diag console --session-name demo --json",
    "hound diag console --session-name demo --level all --limit 50 --json",
    "hound diag console --session-name demo --level warning --plain",
  ],
  async run(input, ctx) {
    const s: string = input["session-name"];
    const r = await callSession(ctx, s, "console", { level: input.level, limit: input.limit });
    return {
      summary: `${r.total} console ${input.level === "all" ? "message" : input.level}(s), ${r.entries.length} shown.`,
      data: { level: input.level, total: r.total, truncated: r.truncated, entries: r.entries },
      plain: r.entries.map((e) => `${e.time} ${e.level} ${e.source} ${e.text}${e.location ? ` (${e.location})` : ""}`).join("\n") || "No console entries.",
      next_actions: [snapshotAction(s, "Read the current page.")],
    };
  },
});

/** Points at the newest non-GET request (its body is what you usually want), else the newest one. */
function requestActions(session: string, entries: { index: number; method: string; status?: number }[]): NextAction[] {
  const post = [...entries].reverse().find((e) => e.method !== "GET" && e.method !== "HEAD" && e.method !== "OPTIONS");
  if (post) {
    return [{ command: sessionCmd("diag", "request", session, "--index", String(post.index), "--part", "request-body"), reason: `Inspect what request #${post.index} (${post.method}) sent (redacted).` }];
  }
  const last = entries[entries.length - 1];
  return last ? [{ command: sessionCmd("diag", "request", session, "--index", String(last.index), "--part", "response-body"), reason: `Inspect the response body of request #${last.index} (redacted).` }] : [];
}

export const diagNetwork = defineCommand({
  name: "diag.network",
  description: "Read failed requests (or all requests) collected since the session started. Each has a stable index for diag request. URLs have no query or fragment.",
  kind: "read",
  flags: {
    ...SESSION_FLAG,
    state: { type: "enum", values: ["failed", "all"], default: "failed", description: "failed = request failures and HTTP status >= 400" },
    limit: LIMIT_FLAG,
  },
  examples: [
    "hound diag network --session-name demo --json",
    "hound diag network --session-name demo --state all --limit 100 --json",
    "hound diag network --session-name demo --state failed --plain",
  ],
  async run(input, ctx) {
    const s: string = input["session-name"];
    const r = await callSession(ctx, s, "network", { state: input.state, limit: input.limit });
    return {
      summary: `${r.total} ${input.state} request(s), ${r.entries.length} shown.`,
      data: { state: input.state, total: r.total, truncated: r.truncated, entries: r.entries },
      plain: r.entries.map((e) => `#${e.index} ${e.time} ${e.method} ${e.status ?? e.failure ?? "-"} ${e.resourceType} ${e.url}`).join("\n") || "No matching requests.",
      next_actions: [snapshotAction(s, "Read the current page."), ...requestActions(s, r.entries)],
    };
  },
});

export const diagRequest = defineCommand({
  name: "diag.request",
  description:
    "Inspect the REDACTED request body or response body of one request listed by diag network (by --index). Secret-looking fields are replaced, binary content is never returned, headers are never returned. Only the last 500 requests are kept.",
  kind: "read",
  flags: {
    ...SESSION_FLAG,
    index: { type: "integer", required: true, min: 1, max: 2147483647, description: "Request index from diag network (stable for the session; evicted after 500 newer requests)" },
    part: { type: "enum", values: ["request-body", "response-body"], required: true, description: "request-body: what the page sent; response-body: what the server answered" },
    "limit-chars": { type: "integer", default: 8000, min: 1, max: 200000, description: "Max body characters returned inline; the full redacted text goes to a file when exceeded" },
    ...OUTPUT_FLAGS,
    output: { ...OUTPUT_FLAGS.output!, description: "Write the full redacted body to this file instead of the session's runs directory (relative paths resolve against the current directory; refuses directories and symlinks)" },
  },
  examples: [
    "hound diag request --session-name demo --index 14 --part request-body --json",
    "hound diag request --session-name demo --index 14 --part response-body --limit-chars 2000 --json",
    "hound diag request --session-name demo --index 14 --part response-body --output ./response.json --if-exists overwrite --json",
  ],
  async run(input, ctx) {
    const s: string = input["session-name"];
    if (input.output) await checkOutputPath(this, givenInput(input, ctx), input.output, input["if-exists"]);
    const r = await callSession(ctx, s, "request", {
      index: input.index,
      part: input.part,
      limitChars: input["limit-chars"],
      ...(input.output && { output: input.output, ifExists: input["if-exists"] }),
    });
    const what = r.omitted === "binary" ? "binary (not shown)" : r.omitted === "too-large" ? "too large (not read)" : `${r.totalChars} chars${r.truncated ? ", truncated" : ""}`;
    const next: NextAction[] = [];
    if (r.file) next.push(readFileAction(r.file, r.truncated ? "Read the full redacted body." : "Read the saved redacted body."));
    next.push({ command: sessionCmd("diag", "network", s, "--state", "all"), reason: "List the recorded requests." });
    return {
      summary: `Request #${r.index} ${r.method} ${r.part}: ${r.contentType}, ${r.bytes} bytes, ${what} (redacted).`,
      data: {
        index: r.index,
        part: r.part,
        method: r.method,
        url: r.url,
        ...(r.status !== undefined && { status: r.status }),
        contentType: r.contentType,
        bytes: r.bytes,
        redacted: r.redacted,
        format: r.format,
        truncated: r.truncated,
        totalChars: r.totalChars,
        ...(r.omitted && { omitted: r.omitted }),
        ...(r.file && { file: r.file }),
        ...(r.body !== undefined && { body: r.body }),
      },
      plain: r.body ?? r.file ?? "",
      next_actions: next,
    };
  },
});

export const diagTrace = defineCommand({
  name: "diag.trace",
  description: "Export the redacted action trace of a session opened with --trace on (steps.json plus a trace zip).",
  kind: "read",
  flags: {
    ...SESSION_FLAG,
    action: { type: "enum", values: ["export"], required: true, description: "export writes the redacted trace; tracing restarts afterwards" },
  },
  examples: [
    "hound diag trace --session-name demo --action export --json",
    "hound diag trace --session-name dbg --action export --timeout 180 --json",
    "hound diag trace --session-name dbg --action export --plain",
  ],
  async run(input, ctx) {
    const s: string = input["session-name"];
    const r = await callSession(ctx, s, "trace-export", {});
    return {
      summary: `Exported a redacted trace with ${r.actions} action(s).`,
      data: { dir: r.dir, file: r.file, steps: r.steps, actions: r.actions, redactions: r.redactions },
      plain: `steps: ${r.steps}\ntrace: ${r.file}`,
      next_actions: [readFileAction(r.steps, "Read the redacted step list (steps.json).")],
    };
  },
});

export const diagCommands = [diagConsole, diagNetwork, diagRequest, diagTrace];
