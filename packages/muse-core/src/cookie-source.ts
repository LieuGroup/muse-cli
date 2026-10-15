/**
 * Resolve the muse.ai session cookie from one of several sources, in order:
 *   1. an explicit string,
 *   2. `MUSE_COOKIE` env var,
 *   3. a cookie file (Netscape `cookies.txt` or a raw `Cookie:` header),
 *   4. the local Chrome cookie store (macOS; decrypted via Keychain).
 *
 * Only cookies for the muse.ai domain are read, and values are never logged.
 */
import { execFile } from "node:child_process";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { MuseError } from "./errors.js";

const execFileAsync = promisify(execFile);
const WANTED = ["hatch_sess", "hatch_gw", "hatch_vml", "datr"];

export interface CookieSourceOptions {
  readonly cookie?: string;
  readonly cookieFile?: string;
  readonly fromChrome?: boolean;
  readonly chromeProfile?: string;
  readonly env?: NodeJS.ProcessEnv;
}

function headerFromPairs(pairs: Map<string, string>): string {
  if (!pairs.has("hatch_sess")) {
    throw new MuseError(
      "auth",
      "No hatch_sess cookie found. Log in at muse.ai first, or pass --cookie.",
    );
  }
  return [...pairs.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

/** Parse a raw `Cookie:` header or a Netscape cookies.txt into name→value. */
function parseCookieText(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const trimmed = text.trim();
  if (trimmed.includes("\t") || /^#.*HTTP Cookie File/m.test(trimmed)) {
    for (const line of trimmed.split("\n")) {
      if (!line || line.startsWith("#")) continue;
      const cols = line.split("\t");
      if (cols.length >= 7 && /muse\.ai$/.test(cols[0] ?? "")) {
        out.set((cols[5] as string).trim(), (cols[6] as string).trim());
      }
    }
    return out;
  }
  for (const part of trimmed.replace(/^Cookie:\s*/i, "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) out.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return out;
}

async function keychainPassword(): Promise<string> {
  const { stdout } = await execFileAsync("security", [
    "find-generic-password",
    "-w",
    "-s",
    "Chrome Safe Storage",
    "-a",
    "Chrome",
  ]);
  return stdout.trim();
}

/** Decrypt one Chrome `v10` cookie blob (macOS AES-128-CBC scheme). */
function decryptChromeValue(blob: Buffer, key: Buffer): string | null {
  if (blob.subarray(0, 3).toString("latin1") !== "v10") return null;
  const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  decipher.setAutoPadding(true);
  let plain: Buffer;
  try {
    plain = Buffer.concat([
      decipher.update(blob.subarray(3)),
      decipher.final(),
    ]);
  } catch {
    return null;
  }
  // Chrome >= v24 prepends a 32-byte SHA-256 domain hash to the value.
  const body = plain.length > 32 ? plain.subarray(32) : plain;
  return body.toString("utf8");
}

async function fromChromeStore(profile: string): Promise<Map<string, string>> {
  const cookiesDb = join(
    homedir(),
    "Library",
    "Application Support",
    "Google",
    "Chrome",
    profile,
    "Cookies",
  );
  const query =
    "select name, hex(encrypted_value) from cookies where host_key like '%muse.ai'";
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("sqlite3", [
      "-readonly",
      `file:${cookiesDb}?immutable=1`,
      query,
    ]));
  } catch {
    throw new MuseError(
      "auth",
      `Could not read Chrome cookies at ${cookiesDb}`,
    );
  }
  const password = await keychainPassword();
  const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  const out = new Map<string, string>();
  for (const line of stdout.trim().split("\n")) {
    if (!line) continue;
    const sep = line.indexOf("|");
    const name = line.slice(0, sep);
    const hex = line.slice(sep + 1);
    if (!WANTED.includes(name)) continue;
    const value = decryptChromeValue(Buffer.from(hex, "hex"), key);
    if (value) out.set(name, value);
  }
  return out;
}

/** Resolve a ready-to-send `Cookie` header value. */
export async function resolveCookie(
  opts: CookieSourceOptions = {},
): Promise<string> {
  const env = opts.env ?? process.env;
  if (opts.cookie) return headerFromPairs(parseCookieText(opts.cookie));
  if (env.MUSE_COOKIE) return headerFromPairs(parseCookieText(env.MUSE_COOKIE));
  if (opts.cookieFile) {
    const text = await readFile(opts.cookieFile, "utf8");
    return headerFromPairs(parseCookieText(text));
  }
  if (env.MUSE_COOKIE_FILE) {
    const text = await readFile(env.MUSE_COOKIE_FILE, "utf8");
    return headerFromPairs(parseCookieText(text));
  }
  // Chrome is the default on macOS: the user's logged-in browser session.
  const useChrome = opts.fromChrome ?? process.platform === "darwin";
  if (useChrome) {
    if (process.platform !== "darwin") {
      throw new MuseError(
        "unsupported",
        "--from-chrome currently supports macOS only. Use --cookie or MUSE_COOKIE.",
      );
    }
    return headerFromPairs(
      await fromChromeStore(
        opts.chromeProfile ?? env.MUSE_CHROME_PROFILE ?? "Default",
      ),
    );
  }
  throw new MuseError(
    "auth",
    "No cookie source. Pass --cookie, set MUSE_COOKIE / MUSE_COOKIE_FILE, or log in to muse.ai in Chrome (macOS).",
  );
}

/** List Chrome profile directories that hold a muse.ai session cookie. */
export async function listChromeProfilesWithMuse(): Promise<string[]> {
  if (process.platform !== "darwin") return [];
  const root = join(
    homedir(),
    "Library",
    "Application Support",
    "Google",
    "Chrome",
  );
  const { readdir } = await import("node:fs/promises");
  let dirs: string[];
  try {
    dirs = await readdir(root);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const dir of dirs) {
    if (dir !== "Default" && !dir.startsWith("Profile ")) continue;
    try {
      const { stdout } = await execFileAsync("sqlite3", [
        "-readonly",
        `file:${join(root, dir, "Cookies")}?immutable=1`,
        "select count(*) from cookies where host_key like '%muse.ai' and name='hatch_sess'",
      ]);
      if (Number(stdout.trim()) > 0) out.push(dir);
    } catch {
      // profile without a readable cookie store
    }
  }
  return out;
}
