import { shellQuote } from "../framework/usage.ts";

/**
 * Deprecated positional syntax (login, run, exec, check, tasks, profiles, forget) translated to the
 * `domain verb --flag` form. `mcp` is not translated: it keeps its own entrypoint (see ../mcp.ts).
 */

const UNIVERSAL_BOOLEAN = new Set(["json", "plain", "quiet", "debug", "no-input", "schema", "help", "version"]);
const BOOLEAN = new Set([...UNIVERSAL_BOOLEAN, "headed", "yes"]);
const TRACE_VALUES = new Set(["on", "off", "on-failure"]);

interface OldArgs {
  positionals: string[];
  flags: Map<string, string | true>;
}

/** The old parser: `--key value`, `--key=value`, bare `--key` (true); known switches never take a value. */
function parseOld(argv: readonly string[]): OldArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    const long = token.match(/^--([^=]+)(?:=(.*))?$/s);
    const short = token.match(/^-([a-z])$/i);
    const key = long?.[1] ?? (short ? ({ p: "profile", h: "help" } as Record<string, string>)[short[1]!] ?? short[1]! : undefined);
    if (!key) {
      positionals.push(token);
      continue;
    }
    if (long?.[2] !== undefined) {
      flags.set(key, long[2]);
      continue;
    }
    const next = argv[i + 1];
    const takesNext = !BOOLEAN.has(key) && next !== undefined && !next.startsWith("-") && (key !== "trace" || TRACE_VALUES.has(next));
    if (takesNext) {
      flags.set(key, next);
      i++;
    } else {
      flags.set(key, true);
    }
  }
  return { positionals, flags };
}

export const LEGACY_COMMANDS = ["login", "run", "exec", "check", "tasks", "profiles", "forget"] as const;

/** Returns the new-style argv plus a one-line notice, or undefined when `argv` is not a legacy invocation. */
export function translateLegacy(argv: readonly string[]): { argv: string[]; notice: string } | undefined {
  const head = argv[0];
  if (!head || !(LEGACY_COMMANDS as readonly string[]).includes(head)) return undefined;
  const { positionals, flags } = parseOld(argv.slice(1));
  const [a, b] = positionals;
  const out: string[] = [];
  const profile = flags.get("profile");
  const push = (name: string, value: string | true | undefined) => {
    if (value === undefined) return;
    out.push(`--${name}`, ...(value === true ? [] : [value]));
  };
  let target: string;
  switch (head) {
    case "login":
      target = "profile login";
      out.push("--profile", String(profile ?? ""), "--url", a ?? "");
      break;
    case "run":
    case "exec": {
      target = head === "run" ? "task run" : "script run";
      out.push(head === "run" ? "--task" : "--file", a ?? "", "--url", b ?? "");
      if (profile !== undefined) push("profile", profile);
      if (flags.get("headed") === true) out.push("--display", "headed");
      const trace = flags.get("trace");
      if (trace !== undefined) out.push("--trace", trace === true ? "on" : trace);
      for (const [key, value] of flags) {
        if (["profile", "headed", "trace"].includes(key) || UNIVERSAL_BOOLEAN.has(key) || key === "timeout") continue;
        out.push("--arg", `${key}=${value === true ? "true" : value}`);
      }
      break;
    }
    case "check":
      target = "profile check";
      out.push("--profile", a ?? "");
      break;
    case "tasks":
      target = "task list";
      break;
    case "profiles":
      target = "profile list";
      break;
    default:
      // `forget` used to delete at once; it now previews unless the caller opts in with --yes.
      target = "profile delete";
      out.push("--profile", a ?? "", flags.get("yes") === true ? "--yes" : "--dry-run");
  }
  for (const key of [...UNIVERSAL_BOOLEAN]) if (flags.get(key) === true) out.push(`--${key}`);
  const timeout = flags.get("timeout");
  if (typeof timeout === "string") out.push("--timeout", timeout);
  // Drop empty placeholders so the new parser reports the missing flag properly.
  const cleaned: string[] = [];
  for (let i = 0; i < out.length; i++) {
    if (out[i]!.startsWith("--") && out[i + 1] === "") {
      i++;
      continue;
    }
    cleaned.push(out[i]!);
  }
  const shown = `hound ${target} ${cleaned.map(shellQuote).join(" ")}`.trim();
  return {
    argv: [...target.split(" "), ...cleaned],
    notice: `deprecated: "hound ${head}" will be removed; use: ${shown}${head === "check" ? " (exit code is now always 0 on success; read data.state)" : head === "forget" && flags.get("yes") !== true ? " (it now only previews; add --yes to delete)" : ""}`,
  };
}

/** Old `mcp` argv (after the command) to its options. */
export function parseMcpArgs(argv: readonly string[]): { profile?: string; headed: boolean; extraArgs: string[] } {
  const sep = argv.indexOf("--");
  const own = sep === -1 ? argv : argv.slice(0, sep);
  const { flags } = parseOld(own);
  const profile = flags.get("profile");
  return {
    profile: typeof profile === "string" ? profile : undefined,
    headed: flags.get("headed") === true,
    extraArgs: sep === -1 ? [] : argv.slice(sep + 1),
  };
}
