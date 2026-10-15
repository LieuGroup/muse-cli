import { MuseError } from "muse-agent-core";
import { ALIASES, COMMANDS } from "./commands/index.js";
import {
  type CommandContext,
  createContext,
  EXIT,
  type Io,
} from "./context.js";
import { HELP } from "./help.js";
import { parseArgv } from "./parse-argv.js";

export { EXIT, type Io } from "./context.js";

export type ContextOverrides = Partial<
  Pick<CommandContext, "cookie" | "session" | "connect">
>;

export async function run(
  argv: readonly string[],
  io: Io,
  overrides: ContextOverrides = {},
): Promise<number> {
  const args = parseArgv(argv);
  const name = args.command
    ? (ALIASES[args.command] ?? args.command)
    : undefined;

  if (!name || name === "help" || (args.flags.help === true && !name)) {
    io.out(HELP);
    return EXIT.ok;
  }
  const command = COMMANDS[name];
  if (!command) {
    io.err(`muse: unknown command "${args.command}". Run \`muse help\`.`);
    return EXIT.usage;
  }

  try {
    return await command(createContext(args, io, overrides));
  } catch (err) {
    if (err instanceof MuseError) {
      io.err(`muse: ${err.message}`);
      if (err.detail?.code === "usage") return EXIT.usage;
      if (err.kind === "auth") return EXIT.auth;
      if (err.kind === "unsupported") return EXIT.unsupported;
      return EXIT.failure;
    }
    if (err instanceof SyntaxError) {
      io.err(`muse: invalid JSON: ${err.message}`);
      return EXIT.usage;
    }
    io.err(`muse: ${(err as Error).message ?? String(err)}`);
    return EXIT.failure;
  }
}
