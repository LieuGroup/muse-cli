/**
 * One-call entry point: resolve a VM for the account and open a gateway.
 */
import { extractVmId } from "./config.js";
import { MuseError } from "./errors.js";
import { MuseGateway } from "./gateway.js";
import { MuseSession, type SessionVm } from "./session.js";

export interface ConnectMuseOptions {
  readonly cookie: string;
  /** Pick a specific VM by id/name; defaults to the preferred standard VM. */
  readonly vm?: string;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
  /** Gateway connect attempts before giving up (default 5, ~1s apart). */
  readonly maxConnectAttempts?: number;
}

export interface ConnectedMuse {
  readonly session: MuseSession;
  readonly vm: SessionVm;
  readonly gateway: MuseGateway;
}

function pickVm(vms: SessionVm[], wanted?: string): SessionVm | undefined {
  if (wanted) {
    const w = wanted.toLowerCase();
    return vms.find(
      (v) =>
        v.vmId?.toLowerCase() === w ||
        v.vmName?.toLowerCase() === w ||
        extractVmId(v.endpointUrl)?.toLowerCase() === w,
    );
  }
  const live = vms.filter((v) => v.vmState !== "DISABLED");
  const standard = live.filter((v) => v.vmType !== "confidential");
  return (
    standard.find((v) => v.isPreferred) ??
    standard[0] ??
    live.find((v) => v.isPreferred) ??
    live[0]
  );
}

export async function connectMuse(
  opts: ConnectMuseOptions,
): Promise<ConnectedMuse> {
  const session = new MuseSession({
    cookie: opts.cookie,
    fetchImpl: opts.fetchImpl,
  });
  const vms = await session.listVms();
  const vm = pickVm(vms, opts.vm);
  if (!vm) {
    throw new MuseError(
      "config",
      opts.vm
        ? `No VM matches "${opts.vm}". Run \`muse vms\` to list them.`
        : "No agent VM is assigned to this account yet. Open muse.ai once to provision it.",
    );
  }
  if (vm.vmType === "confidential") {
    throw new MuseError(
      "unsupported",
      "The selected VM is confidential (CVM). Only standard VMs are supported right now.",
      { code: "cvm_unsupported" },
    );
  }
  const vmId = vm.vmId ?? extractVmId(vm.endpointUrl);
  if (vmId && (vm.vmState === "SUSPENDED" || vm.vmState === "SLEEPING")) {
    await session.wakeVm(vmId).catch(() => {});
  }

  // A rejected WebSocket upgrade can mean a stale token or a transient ingress
  // refusal (e.g. rapid reconnects). Mirror the web client: refresh the token
  // once, then retry on a ~1s cadence for a few attempts.
  const maxAttempts = opts.maxConnectAttempts ?? 5;
  let forceRefresh = false;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (opts.signal?.aborted) break;
    const credentials = await session.vmCredentials(
      vm.endpointUrl,
      vm.vmName,
      forceRefresh,
    );
    try {
      const gateway = await MuseGateway.connect({
        gatewayUrl: vm.endpointUrl,
        vmName: vm.vmName,
        credentials,
        signal: opts.signal,
      });
      return { session, vm, gateway };
    } catch (err) {
      lastError = err;
      const retryable =
        err instanceof MuseError &&
        (err.kind === "auth" || err.kind === "transport");
      if (!retryable) throw err;
      forceRefresh = attempt === 0;
      const delay = Math.round(1000 * (1 + Math.random() * 0.2));
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}
