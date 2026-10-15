/**
 * Run `muse bridge start` at login with launchd (macOS). The plist calls the
 * same `muse` the user is running, so a local or global install both work.
 * The approval channel must not be "terminal" here: there is no TTY.
 */
import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { MuseError } from "muse-agent-core";

const execFileAsync = promisify(execFile);
export const LAUNCHD_LABEL = "com.lieugroup.muse-bridge";
const PLIST_PATH = join(
  homedir(),
  "Library",
  "LaunchAgents",
  `${LAUNCHD_LABEL}.plist`,
);
const LOG_PATH = join(homedir(), ".config", "muse", "bridge.log");

const xml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function plist(programArgs: string[], configPath: string): string {
  const args = [
    ...programArgs,
    "bridge",
    "start",
    "--foreground",
    "--config",
    configPath,
  ]
    .map((a) => `    <string>${xml(a)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${xml(LOG_PATH)}</string>
  <key>StandardErrorPath</key><string>${xml(LOG_PATH)}</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(process.env.PATH ?? "/usr/bin:/bin")}</string></dict>
</dict>
</plist>
`;
}

/** argv that re-runs this same CLI (runtime + script). */
function selfArgs(): string[] {
  const script = process.argv[1];
  if (!script)
    throw new MuseError("config", "Cannot determine the muse CLI path.");
  return [process.execPath, script];
}

export async function installLaunchAgent(configPath: string): Promise<string> {
  if (process.platform !== "darwin") {
    throw new MuseError("unsupported", "launchd install is macOS only.");
  }
  await mkdir(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  await mkdir(join(homedir(), ".config", "muse"), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(PLIST_PATH, plist(selfArgs(), configPath), { mode: 0o644 });
  await execFileAsync("launchctl", ["unload", PLIST_PATH]).catch(() => {});
  await execFileAsync("launchctl", ["load", "-w", PLIST_PATH]);
  return PLIST_PATH;
}

export async function uninstallLaunchAgent(): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  await execFileAsync("launchctl", ["unload", "-w", PLIST_PATH]).catch(
    () => {},
  );
  try {
    await rm(PLIST_PATH);
    return true;
  } catch {
    return false;
  }
}

export { LOG_PATH as BRIDGE_LOG_PATH };
