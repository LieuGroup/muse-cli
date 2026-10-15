/**
 * Build runtime adapters from config. A runtime's adapter is chosen by
 * `options.kind`, defaulting to the runtime id, so several runtimes can share
 * one kind (e.g. `lilos` and `grokbot` both `mcp`).
 */
import type { BridgeConfig } from "../config.js";
import type { RuntimeAdapter } from "../types.js";
import { ClaudeCodeAdapter } from "./claude-code-adapter.js";
import { HttpAdapter } from "./http-adapter.js";
import { McpAdapter } from "./mcp-adapter.js";
import { ShellAdapter } from "./shell-adapter.js";

export const ADAPTER_KINDS = ["shell", "claude-code", "http", "mcp"] as const;
export type AdapterKind = (typeof ADAPTER_KINDS)[number];

export interface BuiltAdapters {
  /** Adapter per enabled runtime id (the config key). */
  readonly byRuntime: Map<string, RuntimeAdapter>;
  /** Stop long-lived children (MCP servers). */
  stop(): void;
}

export async function buildAdapters(
  config: BridgeConfig,
): Promise<BuiltAdapters> {
  const byRuntime = new Map<string, RuntimeAdapter>();
  const mcp: McpAdapter[] = [];
  for (const [id, rt] of Object.entries(config.runtimes)) {
    if (!rt.enabled) continue;
    const kind = String(rt.options?.kind ?? id);
    const options = rt.options ?? {};
    switch (kind) {
      case "shell":
        byRuntime.set(id, new ShellAdapter(rt.commands));
        break;
      case "claude-code":
        byRuntime.set(id, new ClaudeCodeAdapter(options));
        break;
      case "http":
        byRuntime.set(id, new HttpAdapter(id, rt.commands, options));
        break;
      case "mcp": {
        const adapter = new McpAdapter(id, options, Object.keys(rt.commands));
        mcp.push(adapter);
        await adapter.init();
        byRuntime.set(id, adapter);
        break;
      }
      default:
        throw new Error(
          `runtime "${id}": unknown adapter kind "${kind}" (use ${ADAPTER_KINDS.join(", ")})`,
        );
    }
  }
  return {
    byRuntime,
    stop: () => {
      for (const a of mcp) a.stop();
    },
  };
}

export { ClaudeCodeAdapter } from "./claude-code-adapter.js";
export { HttpAdapter, isAllowedHost } from "./http-adapter.js";
export { McpAdapter, toCommandName } from "./mcp-adapter.js";
export { runProcess } from "./run-process.js";
export { ShellAdapter } from "./shell-adapter.js";
