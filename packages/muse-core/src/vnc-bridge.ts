/**
 * Local VNC bridge: expose a running browser task's RFB stream on a loopback
 * TCP port so any VNC client (macOS Screen Sharing, RealVNC, TigerVNC) can
 * view it. Bytes are piped verbatim through `browser_stream.attach`.
 *
 * Attaching does not take control; the agent keeps driving unless the user
 * takes over (`browser_task.takeover`) from the web app or the CLI.
 */
import { createServer, type Server, type Socket } from "node:net";
import { MuseError } from "./errors.js";
import type { MuseGateway } from "./gateway.js";

export interface VncBridgeOptions {
  readonly taskId: string;
  readonly port?: number;
  readonly host?: string;
  /** Viewer size sent with `browser_task.present` (physical pixels). */
  readonly viewer?: {
    width: number;
    height: number;
    device_pixel_ratio: number;
  };
  readonly log?: (line: string) => void;
}

export interface VncBridge {
  readonly port: number;
  readonly host: string;
  close(): Promise<void>;
}

/** Make sure the task is the presented surface before attaching a stream. */
export async function presentBrowserTask(
  gw: MuseGateway,
  taskId: string,
  viewer?: VncBridgeOptions["viewer"],
): Promise<void> {
  const res = (await gw.request("browser_task.present", {
    task_id: taskId,
    ...(viewer ? { viewer } : {}),
  })) as { presented_task_id?: string } | null;
  if (res?.presented_task_id && res.presented_task_id !== taskId) {
    throw new MuseError(
      "gateway",
      `server presented ${res.presented_task_id} instead of ${taskId}`,
    );
  }
}

function pipeClient(
  gw: MuseGateway,
  taskId: string,
  socket: Socket,
  log: (l: string) => void,
): void {
  const pending: Uint8Array[] = [];
  const stream = gw.openDuplex(
    "browser_stream.attach",
    { task_id: taskId },
    {
      onOpen: (status) => {
        log(`stream open (HTTP ${status})`);
        for (const chunk of pending.splice(0)) stream.send(chunk);
      },
      onData: (bytes) => {
        if (!socket.destroyed) socket.write(bytes);
      },
      onClose: (reason) => {
        log(`stream closed: ${reason}`);
        if (!socket.destroyed) socket.end();
      },
    },
  );
  socket.on("data", (data: Buffer) => {
    const bytes = new Uint8Array(data);
    if (stream.opened) stream.send(bytes);
    else pending.push(bytes);
  });
  socket.on("close", () => stream.close());
  socket.on("error", () => stream.close());
}

/** Start the bridge. Resolves once the TCP listener is bound. */
export async function startVncBridge(
  gw: MuseGateway,
  opts: VncBridgeOptions,
): Promise<VncBridge> {
  const host = opts.host ?? "127.0.0.1";
  const log = opts.log ?? (() => {});
  await presentBrowserTask(gw, opts.taskId, opts.viewer);
  let active: Socket | null = null;
  const server: Server = createServer((socket) => {
    if (active && !active.destroyed) {
      log("rejecting second client: one VNC viewer at a time");
      socket.destroy();
      return;
    }
    active = socket;
    log(`viewer connected from ${socket.remoteAddress}`);
    pipeClient(gw, opts.taskId, socket, log);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 5900, host, () => resolve());
  });
  const address = server.address();
  const port =
    typeof address === "object" && address ? address.port : (opts.port ?? 5900);
  return {
    port,
    host,
    close: () =>
      new Promise<void>((resolve) => {
        active?.destroy();
        server.close(() => resolve());
      }),
  };
}
