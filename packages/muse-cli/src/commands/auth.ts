import {
  deleteKeychainSession,
  listChromeProfilesWithMuse,
  loginWithOtp,
  MuseSession,
  readKeychainSession,
  saveKeychainSession,
} from "muse-agent-core";
import {
  type Command,
  type CommandContext,
  EXIT,
  printJson,
  usageError,
} from "../context.js";
import { flagString } from "../parse-argv.js";
import { codeFromCommand, codeFromTerminal } from "../prompt-code.js";
import { dim, green, red } from "../render.js";

/** Optional `--region AU`, else the locale's region, for local phone numbers. */
function regionHint(ctx: CommandContext): string | undefined {
  const flag = flagString(ctx.args.flags, "region");
  if (flag) return flag.toUpperCase();
  try {
    const region = new Intl.Locale(
      Intl.DateTimeFormat().resolvedOptions().locale,
    ).region;
    return region && /^[A-Za-z]{2}$/.test(region) ? region : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `muse auth login --email you@x.com | --phone +61400000000`
 * Sends a one-time code and reads it from the terminal (or --code-command),
 * then saves the session to the macOS Keychain.
 */
async function login(ctx: CommandContext): Promise<number> {
  const { flags } = ctx.args;
  const contact =
    flagString(flags, "email") ??
    flagString(flags, "phone") ??
    process.env.MUSE_LOGIN;
  if (!contact) {
    usageError(
      'usage: muse auth login --email "you@example.com"  |  --phone "+61400000000"',
    );
  }
  const command =
    flagString(flags, "code-command") ?? process.env.MUSE_CODE_COMMAND;
  // Without a code source, stop before a code is sent that nobody can enter.
  if (!command && !process.stdin.isTTY) {
    usageError(
      "No terminal to type the code into. Pass --code-command or set MUSE_CODE_COMMAND.",
    );
  }
  const getCode = (question: string) =>
    command ? codeFromCommand(command) : codeFromTerminal(question);
  const where = contact.includes("@") ? "email" : "phone";

  const cookie = await loginWithOtp({
    contactPoint: contact,
    region: regionHint(ctx),
    log: (line) => ctx.io.err(dim(line)),
    getCode: () => getCode(`Enter the code sent to your ${where}: `),
    getTwoFactorCode: (method) =>
      getCode(`Two-factor code (${method.label}): `),
  });
  if (!(await new MuseSession({ cookie }).check())) {
    ctx.io.err(red("Signed in, but the new session was rejected by muse.ai."));
    return EXIT.auth;
  }
  await saveKeychainSession(cookie);
  if (ctx.json) printJson(ctx, { authenticated: true, saved: "keychain" });
  else
    ctx.io.out(`${green("Logged in.")} Session saved to the macOS Keychain.`);
  return EXIT.ok;
}

async function logout(ctx: CommandContext): Promise<number> {
  const removed = await deleteKeychainSession();
  if (ctx.json) printJson(ctx, { removed });
  else
    ctx.io.out(
      removed
        ? "Removed the saved session from the Keychain."
        : "No saved session to remove.",
    );
  return EXIT.ok;
}

/** `muse auth [status]`: is the active session valid, and where is it from? */
async function status(ctx: CommandContext): Promise<number> {
  const session = await ctx.session();
  const ok = await session.check();
  const saved = (await readKeychainSession().catch(() => null)) != null;
  const profiles = await listChromeProfilesWithMuse().catch(() => []);
  if (ctx.json) {
    printJson(ctx, {
      authenticated: ok,
      saved_login: saved,
      chrome_profiles_with_session: profiles,
    });
    return ok ? EXIT.ok : EXIT.auth;
  }
  ctx.io.out(
    ok
      ? green("authenticated")
      : red("NOT authenticated. Run: muse auth login --email you@example.com"),
  );
  if (saved) ctx.io.out(dim("Using the login saved in the macOS Keychain."));
  if (profiles.length > 0) {
    ctx.io.out(
      dim(
        `Chrome profiles with a muse.ai session: ${profiles.join(", ")} (pick one with --profile)`,
      ),
    );
  }
  return ok ? EXIT.ok : EXIT.auth;
}

/** `muse auth [status|login|logout]` */
export const authCommand: Command = async (ctx) => {
  const sub = ctx.args.positionals[0] ?? "status";
  switch (sub) {
    case "status":
      return status(ctx);
    case "login":
      return login(ctx);
    case "logout":
      return logout(ctx);
    default:
      usageError("usage: muse auth [status|login|logout]");
  }
};
