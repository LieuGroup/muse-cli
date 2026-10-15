/**
 * Wire config, adapters, approval channel, policy, dispatcher and server
 * together, and manage the pid file `muse bridge stop` uses as a kill switch.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ConnectedMuse, MuseGateway } from "muse-agent-core";
import { buildAdapters } from "./adapters/index.js";
import {
  APPROVAL_THREAD_TITLE,
  macosApprover,
  museThreadApprover,
  terminalApprover,
} from "./approval/index.js";
import { AuditLog } from "./audit-log.js";
import { runBridgeServer } from "./bridge-server.js";
import { buildCommandTable } from "./command-table.js";
import type { BridgeConfig } from "./config.js";
import { Dispatcher } from "./dispatcher.js";
import { type Approver, PolicyGate } from "./policy.js";

export const PID_PATH = join(homedir(), ".config", "muse", "bridge.pid");

export async function readBridgePid(): Promise<number | null> {
  try {
    const pid = Number((await readFile(PID_PATH, "utf8")).trim());
    if (!Number.isInteger(pid) || pid <= 0) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

/** Find or create the approval thread; returns its session id. */
async function approvalThread(gw: MuseGateway): Promise<string> {
  const res = (await gw.request("sessions.list", {})) as {
    sessions?: { session_id: string; title?: string }[];
  };
  const found = res.sessions?.find((s) => s.title === APPROVAL_THREAD_TITLE);
  if (found) return found.session_id;
  const sessionId = randomUUID();
  await gw.request("session.start", {
    method: "/api/session/start",
    session_id: sessionId,
    params: { origin: "fresh", lifecycle: "persistent" },
  });
  await gw.request("session.rename", {
    session_id: sessionId,
    title: APPROVAL_THREAD_TITLE,
  });
  return sessionId;
}

export interface StartBridgeOptions {
  readonly config: BridgeConfig;
  readonly connect: () => Promise<ConnectedMuse>;
  readonly log: (line: string) => void;
  readonly signal: AbortSignal;
  readonly audit?: AuditLog;
}

export async function startBridge(opts: StartBridgeOptions): Promise<void> {
  const { config } = opts;
  const built = await buildAdapters(config);
  let table: ReturnType<typeof buildCommandTable>;
  try {
    table = buildCommandTable(config, built.byRuntime);
  } catch (err) {
    built.stop();
    throw err;
  }
  if (table.size === 0) {
    built.stop();
    throw new Error("No commands are enabled in the bridge config.");
  }

  // The Muse-thread channel needs a live gateway, so it is (re)bound on every
  // connection; the other channels are fixed.
  const timeout = config.approval.timeout_seconds;
  let threadApprover: Approver | null = null;
  const approve: Approver = (req, reason) => {
    if (config.approval.channel === "terminal")
      return terminalApprover(timeout)(req, reason);
    if (config.approval.channel === "macos")
      return macosApprover(timeout)(req, reason);
    return threadApprover
      ? threadApprover(req, reason)
      : Promise.resolve(false);
  };
  const fixed =
    config.approval.channel === "terminal"
      ? terminalApprover(timeout)
      : config.approval.channel === "macos"
        ? macosApprover(timeout)
        : null;
  const gate = new PolicyGate(fixed ?? approve);
  const dispatcher = new Dispatcher({
    table,
    gate,
    audit: opts.audit ?? new AuditLog(),
    log: opts.log,
  });

  await mkdir(join(homedir(), ".config", "muse"), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(PID_PATH, String(process.pid), { mode: 0o600 });
  try {
    await runBridgeServer({
      displayName: config.display_name,
      table,
      dispatcher,
      connect: opts.connect,
      log: opts.log,
      signal: opts.signal,
      onConnected: async ({ gateway }) => {
        if (config.approval.channel !== "muse") return;
        const sessionId = await approvalThread(gateway);
        // The main chat.subscribe does not carry thread messages; subscribe to
        // the approval thread so the user's reply reaches the approver.
        const threadSub = gateway.subscribe(
          "chat.subscribe",
          { replay_limit: 0, session_id: sessionId },
          () => {},
        );
        await threadSub.ack;
        threadApprover = museThreadApprover(gateway, sessionId, timeout);
        opts.log(`approvals go to the Muse thread "${APPROVAL_THREAD_TITLE}"`);
        return () => {
          threadApprover = null;
          threadSub.close();
        };
      },
    });
  } finally {
    dispatcher.abortAll();
    built.stop();
    await rm(PID_PATH, { force: true });
  }
}
