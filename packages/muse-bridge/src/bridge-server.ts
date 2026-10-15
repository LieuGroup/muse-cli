/**
 * The long-running bridge: connect to the user's agent VM, register this
 * machine as a node with its device commands, answer `client.invoke` events
 * through the Dispatcher, and reconnect with re-registration when the gateway
 * drops (a node only exists while its connection does).
 */
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import {
  type ConnectedMuse,
  type GatewayEvent,
  MuseError,
} from "muse-agent-core";
import type { CommandEntry } from "./command-table.js";
import { deviceCommands } from "./command-table.js";
import type { Dispatcher } from "./dispatcher.js";

export interface BridgeServerOptions {
  readonly displayName: string;
  readonly table: Map<string, CommandEntry>;
  readonly dispatcher: Dispatcher;
  /** Opens a fresh gateway connection (re-used on every reconnect). */
  readonly connect: () => Promise<ConnectedMuse>;
  /**
   * Called once per connection, after registration (e.g. approval thread).
   * May return a cleanup that runs when this connection ends.
   */
  readonly onConnected?: (
    c: ConnectedMuse,
  ) => Promise<(() => void) | undefined> | (() => void) | undefined;
  readonly log: (line: string) => void;
  readonly signal: AbortSignal;
}

/** Stable per-machine node id, so the same Mac keeps the same identity. */
export function bridgeNodeId(displayName: string): string {
  const h = createHash("sha256")
    .update(`${hostname()}|${displayName}`)
    .digest("hex");
  return `muse-bridge-${h.slice(0, 24)}`;
}

const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

export async function runBridgeServer(
  opts: BridgeServerOptions,
): Promise<void> {
  const nodeId = bridgeNodeId(opts.displayName);
  let attempt = 0;
  while (!opts.signal.aborted) {
    let connected: ConnectedMuse | null = null;
    try {
      connected = await opts.connect();
      const { gateway } = connected;
      const sub = gateway.subscribe(
        "chat.subscribe",
        { replay_limit: 0 },
        () => {},
      );
      await sub.ack;
      await gateway.request("node.register", {
        node_id: nodeId,
        display_name: opts.displayName,
        platform: "web",
        // node.register requires commands_v2; the agent-callable set is the
        // device_commands registered just below.
        commands_v2: { ping: { description: "Connection liveness check" } },
      });
      const caps = (await gateway.request("client.register_capabilities", {
        client_id: nodeId,
        platform: "web",
        display_name: opts.displayName,
        version: "0.1.0",
        capabilities: {
          data_sources: {},
          device_commands: deviceCommands(opts.table),
          hatch_app_commands: {},
          rendering: {
            supported_presentations: [],
            supported_inline_presentations: [],
            supported_text_entities: [],
          },
        },
      })) as { accepted_device_commands?: number; rejected_ids?: string[] };
      const rejected = caps.rejected_ids ?? [];
      opts.log(
        `connected as "${opts.displayName}": ${caps.accepted_device_commands ?? 0} command(s) registered${rejected.length ? `, rejected: ${rejected.join(", ")}` : ""}`,
      );
      attempt = 0;
      const cleanup = await opts.onConnected?.(connected);

      const off = gateway.onEvent((ev: GatewayEvent) => {
        if (process.env.MUSE_BRIDGE_DEBUG) opts.log(`event: ${ev.event}`);
        if (ev.event !== "client.invoke") return;
        void opts.dispatcher.handle(ev.payload).then((reply) => {
          if (!reply) return;
          gateway
            .request("client.invoke.result", { ...reply })
            .catch((err: unknown) => {
              opts.log(
                `could not deliver result for ${reply.invoke_id}: ${(err as Error).message}`,
              );
            });
        });
      });
      const stop = new Promise<void>((resolve) => {
        opts.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      // Runs until the subscription ends (drop) or we are asked to stop.
      await Promise.race([sub.done.catch(() => undefined), stop]);
      off();
      if (typeof cleanup === "function") cleanup();
      sub.close();
      if (opts.signal.aborted) {
        await gateway
          .request("node.unpair", { node_id: nodeId })
          .catch(() => {});
        gateway.close();
        return;
      }
      opts.log("gateway stream ended; reconnecting");
    } catch (err) {
      if (
        err instanceof MuseError &&
        (err.kind === "auth" ||
          err.kind === "unsupported" ||
          err.kind === "config")
      ) {
        connected?.gateway.close();
        throw err;
      }
      opts.log(`bridge connection failed: ${(err as Error).message}`);
    }
    connected?.gateway.close();
    opts.dispatcher.abortAll();
    const wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 30_000;
    attempt++;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, wait);
      opts.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          resolve();
        },
        { once: true },
      );
    });
  }
}
