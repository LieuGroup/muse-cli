/**
 * Minimal per-domain cookie jar for the login redirect chain. Login crosses
 * muse.ai and auth.meta.com, so cookies are scoped by domain rather than by
 * exact host. Values are held in memory and never logged.
 */

interface StoredCookie {
  readonly name: string;
  readonly value: string;
  /** Domain the cookie is scoped to, without a leading dot. */
  readonly domain: string;
  /** True when set without a Domain attribute (host-only). */
  readonly hostOnly: boolean;
}

function domainMatches(host: string, cookie: StoredCookie): boolean {
  if (cookie.hostOnly) return host === cookie.domain;
  return host === cookie.domain || host.endsWith(`.${cookie.domain}`);
}

export class CookieJar {
  /** Keyed by `domain|name` so one name can live on two domains. */
  readonly #cookies = new Map<string, StoredCookie>();

  /** Absorb every `Set-Cookie` header from a response to `url`. */
  absorb(url: string, headers: Headers): void {
    const host = new URL(url).hostname;
    for (const line of headers.getSetCookie()) this.#set(host, line);
  }

  #set(host: string, line: string): void {
    const [pair = "", ...attrs] = line.split(";");
    const eq = pair.indexOf("=");
    if (eq <= 0) return;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    let domain = host;
    let hostOnly = true;
    let expired = false;
    for (const raw of attrs) {
      const sep = raw.indexOf("=");
      const key = (sep < 0 ? raw : raw.slice(0, sep)).trim().toLowerCase();
      const val = sep < 0 ? "" : raw.slice(sep + 1).trim();
      if (key === "domain" && val) {
        const d = val.replace(/^\./, "").toLowerCase();
        // Ignore a Domain the response host is not allowed to set.
        if (host === d || host.endsWith(`.${d}`)) {
          domain = d;
          hostOnly = false;
        }
      } else if (key === "max-age" && Number(val) <= 0) {
        expired = true;
      } else if (key === "expires" && Date.parse(val) <= Date.now()) {
        expired = true;
      }
    }
    // Drop any host-only twin so a Domain cookie replaces it cleanly.
    this.#cookies.delete(`${host}|${name}`);
    const key = `${domain}|${name}`;
    if (expired || value === "") this.#cookies.delete(key);
    else this.#cookies.set(key, { name, value, domain, hostOnly });
  }

  /** `Cookie` header value for a request to `url`, or undefined if none. */
  header(url: string): string | undefined {
    const host = new URL(url).hostname;
    const parts: string[] = [];
    for (const c of this.#cookies.values()) {
      if (domainMatches(host, c)) parts.push(`${c.name}=${c.value}`);
    }
    return parts.length > 0 ? parts.join("; ") : undefined;
  }

  /** Value of a named cookie visible to `url`. */
  get(url: string, name: string): string | undefined {
    const host = new URL(url).hostname;
    for (const c of this.#cookies.values()) {
      if (c.name === name && domainMatches(host, c)) return c.value;
    }
    return undefined;
  }
}
