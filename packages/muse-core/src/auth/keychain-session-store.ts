/**
 * Persist the muse.ai session cookie in the macOS login Keychain, like `asc`
 * stores its web session. The secret is passed to `security` on stdin
 * (`security -i`), never on the command line where `ps` could read it.
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { MuseError } from "../errors.js";

const execFileAsync = promisify(execFile);
export const KEYCHAIN_SERVICE = "muse-agent-cli";
const ACCOUNT = "muse.ai";
const NOT_FOUND = 44;

function requireDarwin(): void {
  if (process.platform !== "darwin") {
    throw new MuseError(
      "unsupported",
      "Saved logins use the macOS Keychain. Elsewhere, set MUSE_COOKIE.",
    );
  }
}

/** Quote one argument for the `security -i` command language. */
function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Save (or replace) the session cookie header. */
export async function saveKeychainSession(cookieHeader: string): Promise<void> {
  requireDarwin();
  if (/[\r\n]/.test(cookieHeader)) {
    throw new MuseError("config", "Refusing to store a multi-line cookie.");
  }
  const command = `add-generic-password -U -a ${quote(ACCOUNT)} -s ${quote(KEYCHAIN_SERVICE)} -l ${quote("Muse CLI session")} -w ${quote(cookieHeader)}\n`;
  await new Promise<void>((resolve, reject) => {
    const child = spawn("security", ["-i"], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 && stderr.trim() === "") resolve();
      else
        reject(
          new MuseError(
            "config",
            "Could not save the session to the Keychain.",
          ),
        );
    });
    child.stdin.end(command);
  });
}

/** Read the saved session cookie header, or null when none is saved. */
export async function readKeychainSession(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-a",
      ACCOUNT,
      "-s",
      KEYCHAIN_SERVICE,
      "-w",
    ]);
    const value = stdout.trim();
    return value === "" ? null : value;
  } catch (err) {
    if ((err as { code?: unknown }).code === NOT_FOUND) return null;
    throw new MuseError(
      "config",
      "Could not read the saved session from the Keychain.",
    );
  }
}

/** Delete the saved session. Returns false when nothing was saved. */
export async function deleteKeychainSession(): Promise<boolean> {
  requireDarwin();
  try {
    await execFileAsync("security", [
      "delete-generic-password",
      "-a",
      ACCOUNT,
      "-s",
      KEYCHAIN_SERVICE,
    ]);
    return true;
  } catch (err) {
    if ((err as { code?: unknown }).code === NOT_FOUND) return false;
    throw new MuseError(
      "config",
      "Could not remove the saved session from the Keychain.",
    );
  }
}
