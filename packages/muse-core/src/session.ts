/**
 * Web session against muse.ai's Next.js `/api/*` surface.
 *
 * Authentication is the user's own logged-in browser session: the `hatch_sess`
 * cookie (and siblings). This module never logs cookie values or tokens.
 */
import { MUSE_ORIGIN } from "./config.js";
import { MuseError } from "./errors.js";

export interface SessionVm {
  readonly vmId: string | null;
  readonly endpointUrl: string;
  readonly vmName: string | null;
  readonly vmType: string | null;
  readonly vmState: string | null;
  readonly isPreferred: boolean;
}

export interface VmCredentials {
  /** The VM's own `vm_auth_token`. Valid only for this exact VM. */
  readonly token: string;
  readonly notaryToken: string | null;
}

export interface MuseSessionOptions {
  /** Raw `Cookie` header value, e.g. `hatch_sess=…; hatch_gw=…`. */
  readonly cookie: string;
  readonly origin?: string;
  readonly fetchImpl?: typeof fetch;
  readonly userAgent?: string;
}

const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";

type RawVm = {
  vm_id?: string | null;
  endpoint_url?: string | null;
  name?: string | null;
  vm_name?: string | null;
  is_preferred?: boolean | null;
  vm_type?: string | null;
  vm_state?: string | null;
};

type RawSession = RawVm & { status?: string; vms?: RawVm[] | null };

function toVm(raw: RawVm, preferred: boolean): SessionVm | null {
  const endpointUrl = raw.endpoint_url?.trim();
  if (!endpointUrl) return null;
  return {
    vmId: raw.vm_id?.trim() || null,
    endpointUrl,
    vmName: (raw.vm_name ?? raw.name)?.trim() || null,
    vmType: raw.vm_type ?? null,
    vmState: raw.vm_state ?? null,
    isPreferred: raw.is_preferred === true || preferred,
  };
}

export class MuseSession {
  readonly #cookie: string;
  readonly #origin: string;
  readonly #fetch: typeof fetch;
  readonly #ua: string;

  constructor(opts: MuseSessionOptions) {
    if (!/\bhatch_sess=/.test(opts.cookie)) {
      throw new MuseError(
        "auth",
        "Cookie is missing hatch_sess. Export it from a logged-in muse.ai browser session.",
      );
    }
    this.#cookie = opts.cookie;
    this.#origin = opts.origin ?? MUSE_ORIGIN;
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#ua = opts.userAgent ?? DEFAULT_UA;
  }

  async #call(
    path: string,
    init: { method: "GET" | "POST"; body?: unknown },
  ): Promise<unknown> {
    const res = await this.#fetch(`${this.#origin}${path}`, {
      method: init.method,
      headers: {
        Cookie: this.#cookie,
        Origin: this.#origin,
        Referer: `${this.#origin}/`,
        "User-Agent": this.#ua,
        Accept: "*/*",
        // The app's /api routes require same-origin fetch metadata (CSRF guard).
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
        ...(init.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: "manual",
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // non-JSON (e.g. login redirect HTML)
    }
    if (
      res.status === 401 ||
      res.status === 403 ||
      (res.status >= 300 && res.status < 400)
    ) {
      const type =
        json && typeof json === "object" && "type" in json
          ? String((json as { type: unknown }).type)
          : undefined;
      throw new MuseError(
        "auth",
        type === "checkpointRequired"
          ? "Meta requires a security checkpoint. Open muse.ai in a browser to clear it."
          : `Session not authorized (${res.status}). Refresh your muse.ai cookie.`,
        { status: res.status, code: type },
      );
    }
    if (!res.ok) {
      const code =
        json && typeof json === "object" && "code" in json
          ? String((json as { code: unknown }).code)
          : undefined;
      const err =
        json && typeof json === "object" && "error" in json
          ? String((json as { error: unknown }).error)
          : `HTTP ${res.status}`;
      throw new MuseError("gateway", `${path} failed: ${err}`, {
        status: res.status,
        code,
      });
    }
    return json;
  }

  /**
   * Probe whether the cookie is still a valid session. Uses the same
   * `/api/session` read the web app makes on load; `/api/auth/check` is a
   * stricter post-failure probe that rejects non-browser callers.
   */
  async check(): Promise<boolean> {
    try {
      const raw = await this.#call("/api/session?vm_state=live", {
        method: "GET",
      });
      return raw != null && typeof raw === "object";
    } catch (err) {
      if (err instanceof MuseError && err.kind === "auth") return false;
      throw err;
    }
  }

  /** List the VMs assigned to this account. */
  async listVms(): Promise<SessionVm[]> {
    const raw = (await this.#call("/api/session?vm_state=live", {
      method: "GET",
    })) as RawSession | null;
    if (!raw) return [];
    const out: SessionVm[] = [];
    const seen = new Set<string>();
    const primary = toVm(raw, true);
    if (primary) {
      out.push(primary);
      seen.add(primary.endpointUrl + (primary.vmName ?? ""));
    }
    for (const vm of raw.vms ?? []) {
      const v = toVm(vm, false);
      if (v && !seen.has(v.endpointUrl + (v.vmName ?? ""))) {
        seen.add(v.endpointUrl + (v.vmName ?? ""));
        out.push(v);
      }
    }
    return out;
  }

  /** Ask the server to assign (lease) a VM of the given type. */
  async leaseVm(vmType: "standard" | "confidential" = "standard"): Promise<{
    gatewayUrl: string;
    vmName: string;
  }> {
    const body = (await this.#call("/api/hatch/lease-vm", {
      method: "POST",
      body: { vmType },
    })) as { status?: string; gatewayUrl?: string; vmName?: string } | null;
    if (body?.status !== "assigned" || !body.gatewayUrl || !body.vmName) {
      throw new MuseError("gateway", "VM lease returned no assignment");
    }
    return { gatewayUrl: body.gatewayUrl, vmName: body.vmName };
  }

  /** Best-effort wake of a suspended VM. */
  async wakeVm(vmId: string): Promise<void> {
    await this.#call("/api/hatch/vm/wake", {
      method: "POST",
      body: { vm_id: vmId, retry_count: 0 },
    });
  }

  /** Mint the per-VM gateway credentials. */
  async vmCredentials(
    gatewayUrl: string,
    vmName?: string | null,
    forceRefresh = false,
  ): Promise<VmCredentials> {
    const body = (await this.#call("/api/hatch/token", {
      method: "POST",
      body: {
        vmAddress: gatewayUrl,
        ...(vmName ? { vmName } : {}),
        ...(forceRefresh ? { force_refresh: true } : {}),
      },
    })) as { token?: string; notary_token?: string | null } | null;
    if (!body?.token) {
      throw new MuseError(
        "auth",
        "Server returned no vm_auth_token for this VM",
      );
    }
    const notary = body.notary_token?.trim() || null;
    if (notary?.startsWith("delegation.")) {
      // A private CVM delegation must be endorsed with a browser-held signing
      // key (confidential VMs). Not supported by this client.
      throw new MuseError(
        "unsupported",
        "This VM is a confidential VM (CVM). CVM delegation/attestation is not supported yet; use a standard VM.",
        { code: "cvm_unsupported" },
      );
    }
    return { token: body.token, notaryToken: notary };
  }
}
