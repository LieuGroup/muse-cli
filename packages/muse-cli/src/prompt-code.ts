/**
 * Collect a one-time code: from `--code-command` (automation, like asc's
 * ASC_WEB_2FA_CODE_COMMAND), or from an interactive terminal prompt.
 */
import { execFile } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";
import { MuseError } from "muse-agent-core";

const execFileAsync = promisify(execFile);

/** Run a shell command and return the first run of 4-12 digits it prints. */
export async function codeFromCommand(command: string): Promise<string> {
  const { stdout } = await execFileAsync("/bin/sh", ["-c", command], {
    timeout: 5 * 60_000,
  });
  const code = /\b(\d{4,12})\b/.exec(stdout)?.[1];
  if (!code) {
    throw new MuseError("auth", "--code-command printed no numeric code.");
  }
  return code;
}

/** Ask for a code on the terminal. Fails fast when there is no TTY. */
export async function codeFromTerminal(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new MuseError(
      "auth",
      "No terminal to type the code into. Pass --code-command or set MUSE_CODE_COMMAND.",
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(question)).trim();
    if (!answer) throw new MuseError("auth", "No code entered.");
    return answer;
  } finally {
    rl.close();
  }
}
