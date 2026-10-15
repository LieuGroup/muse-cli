/**
 * Ask with a native macOS dialog (works under launchd, no terminal needed).
 * The request text is passed as an AppleScript argv item, never spliced into
 * the script, so request content cannot inject AppleScript. Deny is the
 * default button; a timeout or closing the dialog counts as Deny.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Approver } from "../policy.js";
import { describeRequest } from "./describe-request.js";

const execFileAsync = promisify(execFile);

const SCRIPT = [
  "on run argv",
  'set r to display dialog (item 1 of argv) with title "Muse bridge" with icon caution buttons {"Deny", "Allow"} default button "Deny" cancel button "Deny" giving up after (item 2 of argv as integer)',
  'if gave up of r then return "timeout"',
  "return button returned of r",
  "end run",
];

export function macosApprover(timeoutSeconds: number): Approver {
  let queue: Promise<unknown> = Promise.resolve();
  return (req, reason) => {
    const ask = async (): Promise<boolean> => {
      const message = `Muse wants to run a bridge command.\n\n${describeRequest(req)}\n\n${reason}`;
      const args = SCRIPT.flatMap((line) => ["-e", line]);
      try {
        const { stdout } = await execFileAsync(
          "osascript",
          [...args, "--", message, String(timeoutSeconds)],
          { timeout: (timeoutSeconds + 10) * 1000 },
        );
        return stdout.trim() === "Allow";
      } catch {
        // Deny button (cancel) exits non-zero; treat every failure as Deny.
        return false;
      }
    };
    const next = queue.then(ask, ask);
    queue = next.catch(() => undefined);
    return next;
  };
}
