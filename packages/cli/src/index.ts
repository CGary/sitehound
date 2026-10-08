import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "@sitehound/core/paths";
import { COMMANDS } from "./commands/index.ts";
import { parseMcpArgs, translateLegacy } from "./commands/legacy.ts";
import { runCli } from "./framework/cli.ts";
import { claimOutput, installProcessGuards, realExit } from "./framework/lifecycle.ts";
import { buildRegistry } from "./framework/registry.ts";
import { guardStdout, writeStderr } from "./framework/stdio.ts";

// Only the JSON envelope (or help/schema text) may reach stdout: everything else goes to stderr.
guardStdout();

try {
  process.loadEnvFile(join(REPO_ROOT, ".env"));
} catch {
  // .env is optional
}

function version(): string {
  try {
    return (JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv[0] === "mcp") {
    // Deprecated: kept as-is. stdout belongs to the MCP protocol, so this path never prints an envelope.
    claimOutput();
    writeStderr("deprecated: \"hound mcp\" is kept for now; prefer the browser/page/element commands.\n");
    try {
      const { runMcp } = await import("./mcp.ts");
      await runMcp(parseMcpArgs(argv.slice(1)));
    } catch (err) {
      writeStderr(`${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
    return 0;
  }
  installProcessGuards();
  return runCli(argv, buildRegistry(COMMANDS), { version: version(), translateLegacy });
}

main().then(
  (code) => realExit(code),
  (err: unknown) => {
    // Unreachable in practice (runCli maps every error); the guards still guarantee one envelope.
    queueMicrotask(() => {
      throw err;
    });
  },
);
