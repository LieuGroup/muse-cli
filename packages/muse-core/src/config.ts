/**
 * Fixed protocol constants observed on the production muse.ai web client.
 * These are endpoints/paths, not secrets.
 */
export const MUSE_ORIGIN = "https://muse.ai";
export const NOISE_SHARED_INGRESS_HOST = "hatch.metaaivm.com";
export const NOISE_WS_PATH = "/v1/noise";
export const DEFAULT_APP_ID = "hatch-web";

/** VM gateway host suffixes; a per-VM FQDN is `<uuid>.metaaivm.com`. */
export const VM_GATEWAY_HOST_SUFFIXES = [
  ".metaaivm.com",
  ".willow606.com",
  ".exe.xyz",
] as const;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^[0-9a-f]{32}$/i;

/** Extract the VM uuid from a per-VM gateway hostname, if present. */
export function extractVmId(gatewayUrl: string): string | null {
  let host: string;
  try {
    const value = /^[a-z]+:\/\//i.test(gatewayUrl)
      ? gatewayUrl
      : `https://${gatewayUrl}`;
    host = new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
  for (const suffix of VM_GATEWAY_HOST_SUFFIXES) {
    if (host.endsWith(suffix)) {
      const label = host.slice(0, -suffix.length);
      if (UUID_RE.test(label)) return label;
    }
  }
  return null;
}

export interface WsUrlParts {
  readonly token: string;
  readonly requestId: string;
  readonly vmName?: string | null;
  readonly notaryToken?: string | null;
  readonly appId?: string;
  readonly ingressHost?: string;
}

/**
 * Build the Noise WebSocket URL. The browser always dials the fixed shared
 * ingress; the VM is addressed by `vm_id`, never by the source gateway host.
 */
export function buildNoiseWsUrl(gatewayUrl: string, parts: WsUrlParts): string {
  const vmId = extractVmId(gatewayUrl) ?? parts.vmName?.trim() ?? "";
  if (!vmId) throw new Error("cannot resolve vm_id from gateway url or vmName");
  const q = new URLSearchParams();
  q.set("vm_id", vmId);
  q.set("auth_token", parts.token);
  if (parts.notaryToken) q.set("notary_token", parts.notaryToken);
  q.set("app_id", parts.appId ?? DEFAULT_APP_ID);
  q.set("request_id", parts.requestId);
  const host = parts.ingressHost ?? NOISE_SHARED_INGRESS_HOST;
  return `wss://${host}${NOISE_WS_PATH}?${q.toString()}`;
}
