import {
  type ConnectedMuse,
  connectMuse,
  MuseError,
  MuseSession,
  resolveCookie,
} from "muse-agent-core";
import { flagString, type ParsedArgs } from "./parse-argv.js";

export interface Io {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  /** Write without a trailing newline (streaming text). */
  readonly write: (text: string) => void;
}

export const EXIT = {
  ok: 0,
  failure: 1,
  usage: 2,
  auth: 3,
  unsupported: 4,
} as const;

/** Everything a command needs; injectable so tests can fake the network. */
export interface CommandContext {
  readonly args: ParsedArgs;
  readonly io: Io;
  readonly json: boolean;
  readonly cookie: () => Promise<string>;
  readonly session: () => Promise<MuseSession>;
  readonly connect: () => Promise<ConnectedMuse>;
}

export type Command = (ctx: CommandContext) => Promise<number>;

export function usageError(message: string): never {
  throw new MuseError("config", message, { code: "usage" });
}

export function createContext(
  args: ParsedArgs,
  io: Io,
  overrides: Partial<
    Pick<CommandContext, "cookie" | "session" | "connect">
  > = {},
): CommandContext {
  let cookiePromise: Promise<string> | null = null;
  const cookie =
    overrides.cookie ??
    (() => {
      cookiePromise ??= resolveCookie({
        cookie: flagString(args.flags, "cookie"),
        cookieFile: flagString(args.flags, "cookie-file"),
        fromChrome: args.flags["from-chrome"] === true ? true : undefined,
        chromeProfile: flagString(args.flags, "profile"),
      });
      return cookiePromise;
    });
  const session =
    overrides.session ??
    (async () => new MuseSession({ cookie: await cookie() }));
  const connect =
    overrides.connect ??
    (async () =>
      connectMuse({
        cookie: await cookie(),
        vm: flagString(args.flags, "vm"),
      }));
  return { args, io, json: args.flags.json === true, cookie, session, connect };
}

/** Run `fn` with a live gateway connection, always closing it afterwards. */
export async function withGateway<T>(
  ctx: CommandContext,
  fn: (c: ConnectedMuse) => Promise<T>,
): Promise<T> {
  const connected = await ctx.connect();
  try {
    return await fn(connected);
  } finally {
    connected.gateway.close();
  }
}

export function printJson(ctx: CommandContext, value: unknown): void {
  ctx.io.out(JSON.stringify(value, null, 2));
}
