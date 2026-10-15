import type { InvokeRequest } from "../types.js";

const MAX_PARAM_CHARS = 400;

/**
 * Summary of an invoke for an approval prompt. The command name comes from the
 * bridge's own table; the params are agent-controlled, so they are flattened to
 * one line (no newlines to fake extra prompt lines), capped, and clearly
 * labelled as untrusted.
 */
export function describeRequest(req: InvokeRequest): string {
  const params = [...JSON.stringify(req.params)]
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x2028 || code === 0x2029 ? " " : ch;
    })
    .join("");
  const shown =
    params.length > MAX_PARAM_CHARS
      ? `${params.slice(0, MAX_PARAM_CHARS)}… (${params.length} chars)`
      : params;
  return `Command: ${req.command}\nParameters (written by the agent, untrusted): ${shown}`;
}
