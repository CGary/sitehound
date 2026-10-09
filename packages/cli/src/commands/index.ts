import type { Command } from "../framework/types.ts";
import { batchCommand } from "./batch.ts";
import { browserCommands } from "./browser.ts";
import { diagCommands } from "./diag.ts";
import { elementCommands } from "./element.ts";
import { pageCommands } from "./page.ts";
import { profileCommands } from "./profile.ts";
import { scriptCommands } from "./script.ts";
import { taskCommands } from "./task.ts";

const DOMAIN_COMMANDS: readonly Command[] = [...browserCommands, ...pageCommands, ...elementCommands, ...diagCommands, ...profileCommands, ...taskCommands, ...scriptCommands];

/** The command catalog. To add commands: create commands/<domain>.ts exporting an array and spread it above. `batch` runs steps of the others. */
export const COMMANDS: readonly Command[] = [...DOMAIN_COMMANDS, batchCommand(DOMAIN_COMMANDS)];
