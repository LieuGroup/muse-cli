/**
 * Ask in the terminal running the bridge. Only usable in the foreground with
 * a TTY. Prompts are serialised so two invokes never interleave on screen.
 * No answer before the timeout counts as Deny.
 */
import { createInterface } from "node:readline/promises";
import type { Approver } from "../policy.js";
import { describeRequest } from "./describe-request.js";

export function terminalApprover(timeoutSeconds: number): Approver {
  let queue: Promise<unknown> = Promise.resolve();
  return (req, reason) => {
    const ask = async (): Promise<boolean> => {
      if (!process.stdin.isTTY) return false;
      const rl = createInterface({
        input: process.stdin,
        output: process.stderr,
      });
      const timer = AbortSignal.timeout(timeoutSeconds * 1000);
      try {
        process.stderr.write(
          `\nMuse wants to run a bridge command.\n${describeRequest(req)}\n(${reason})\n`,
        );
        const answer = await rl.question(
          `Allow? [y/N] (auto-deny in ${timeoutSeconds}s): `,
          { signal: timer },
        );
        return /^y(es)?$/i.test(answer.trim());
      } catch {
        process.stderr.write("\nNo answer: denied.\n");
        return false;
      } finally {
        rl.close();
      }
    };
    const next = queue.then(ask, ask);
    queue = next.catch(() => undefined);
    return next;
  };
}
