/** Line search of an aria snapshot for `page find`: substring or bounded regex, with limits against pathological input. */
import { Worker } from "node:worker_threads";
import { HoundError } from "../errors.ts";
import { redactText } from "../redact.ts";
import { FIND_LINE_MAX_CHARS, FIND_PATTERN_MAX_CHARS, FIND_REGEX_BUDGET_MS } from "./limits.ts";

const REGEX_FLAGS = "imsu";

/** Parses `/pattern/flags` (flags from imsu) or a bare pattern into [source, flags]; INVALID_ARGUMENT when unusable. */
export function parseRegexArg(value: string): { source: string; flags: string } {
  const bad = (why: string): HoundError => new HoundError("INVALID_ARGUMENT", `--regex ${why}`, { field: "regex", received: redactText(value, 80), retryable: true });
  const m = /^\/(.+)\/([a-z]*)$/s.exec(value);
  const source = m ? m[1]! : value;
  const flags = m ? m[2]! : "";
  if (source.length === 0) throw bad("is empty.");
  if (source.length > FIND_PATTERN_MAX_CHARS) throw bad(`is longer than ${FIND_PATTERN_MAX_CHARS} characters.`);
  for (const f of flags) if (!REGEX_FLAGS.includes(f)) throw bad(`has the unsupported flag "${f}"; allowed: ${[...REGEX_FLAGS].join(", ")}.`);
  if (new Set(flags).size !== flags.length) throw bad("repeats a flag.");
  try {
    new RegExp(source, flags);
  } catch {
    throw bad("is not a valid regular expression.");
  }
  return { source, flags };
}

/** Indexes (0-based) of the lines containing `needle` (case-insensitive); only the first FIND_LINE_MAX_CHARS of a line are examined. */
export function matchText(lines: readonly string[], needle: string): number[] {
  const n = needle.toLowerCase();
  const hits: number[] = [];
  for (let i = 0; i < lines.length; i++) if (lines[i]!.slice(0, FIND_LINE_MAX_CHARS).toLowerCase().includes(n)) hits.push(i);
  return hits;
}

/** Indexes of the strings containing `needle` (case-sensitive). */
export function matchSubstring(items: readonly string[], needle: string): number[] {
  const hits: number[] = [];
  for (let i = 0; i < items.length; i++) if (items[i]!.includes(needle)) hits.push(i);
  return hits;
}

/** Runs in a worker so a catastrophic pattern can be killed: V8 has no regex timeout of its own. */
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { lines, source, flags, cap } = workerData;
const re = new RegExp(source, flags);
const hits = [];
for (let i = 0; i < lines.length; i++) if (re.test(lines[i].slice(0, cap))) hits.push(i);
parentPort.postMessage(hits);
`;

/** Indexes of the lines matching the regex, scanned off the main thread; INVALID_ARGUMENT when it takes longer than the budget. */
export function matchRegex(
  lines: readonly string[],
  source: string,
  flags: string,
  budgetMs: number = FIND_REGEX_BUDGET_MS,
  flag: { name: string; fallback: string } = { name: "regex", fallback: "--text" },
): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { lines, source, flags, cap: FIND_LINE_MAX_CHARS } });
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(new HoundError("INVALID_ARGUMENT", `--${flag.name} took longer than ${Math.round(budgetMs / 100) / 10}s on this page (catastrophic backtracking?); use a simpler pattern or ${flag.fallback}.`, {
            field: flag.name,
            retryable: true,
          })),
        ),
      Math.max(1, budgetMs),
    );
    worker.on("message", (hits: number[]) => finish(() => resolve(hits)));
    worker.on("error", () => finish(() => reject(new HoundError("INVALID_ARGUMENT", `--${flag.name} could not be evaluated.`, { field: flag.name, retryable: true }))));
  });
}

/**
 * `page wait --for request --value`: `/regex/flags` (flags only from imsu) is a regular expression, anything else a plain substring
 * (so a path such as /api/ids is a substring, not the regex "api" with flags "ids"). A regex source is capped like `page find` patterns.
 */
export function parseRequestValue(value: string): { substring: string } | { source: string; flags: string } {
  const m = /^\/(.+)\/([a-z]*)$/s.exec(value);
  if (!m || ![...m[2]!].every((f) => REGEX_FLAGS.includes(f)) || new Set(m[2]).size !== m[2]!.length) return { substring: value };
  const source = m[1]!;
  const flags = m[2]!;
  const bad = (why: string): HoundError => new HoundError("INVALID_ARGUMENT", `--value looks like /regex/flags but ${why}`, { field: "value", received: redactText(value, 80), retryable: true });
  if (source.length > FIND_PATTERN_MAX_CHARS) throw bad(`the pattern is longer than ${FIND_PATTERN_MAX_CHARS} characters.`);
  try {
    new RegExp(source, flags);
  } catch {
    throw bad("is not a valid regular expression.");
  }
  return { source, flags };
}
