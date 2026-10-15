/**
 * HTTP adapter: forwards a command to a local service (e.g. a LilOS API) as a
 * JSON POST. Each command maps to one fixed URL from config; the request never
 * chooses the URL. Hosts are limited to loopback and Tailscale (100.64.0.0/10)
 * so the bridge cannot be used as a proxy to the internet. Redirects are not
 * followed.
 *
 * Config (per command, runtimes.<id>.commands.<name>.options):
 *   { "url": "http://127.0.0.1:7777/tasks/run", "description": "Run a LilOS task",
 *     "params": { "task": "Task id" } }
 * Runtime options: { "headers": { "X-Api-Key": "env:LILOS_API_KEY" } }
 *   A header value "env:NAME" is read from the environment at call time, so
 *   secrets stay out of the config file.
 */
import type {
  CommandSpec,
  ParamSpec,
  RunContext,
  RunResult,
  RuntimeAdapter,
} from "../types.js";

interface Route {
  readonly url: URL;
  readonly description: string;
  readonly params: Record<string, string>;
}

/** Loopback, or a Tailscale CGNAT address 100.64.0.0 – 100.127.255.255. */
export function isAllowedHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h))
    return true;
  const m = /^100\.(\d+)\.\d+\.\d+$/.exec(h);
  return m?.[1] !== undefined && Number(m[1]) >= 64 && Number(m[1]) <= 127;
}

export class HttpAdapter implements RuntimeAdapter {
  readonly #routes = new Map<string, Route>();
  readonly #headers: Record<string, string>;

  constructor(
    readonly id: string,
    commands: Record<string, { options?: Record<string, unknown> }>,
    options: Record<string, unknown> = {},
  ) {
    const headers = options.headers;
    this.#headers =
      headers && typeof headers === "object" && !Array.isArray(headers)
        ? Object.fromEntries(
            Object.entries(headers).map(([k, v]) => [k, String(v)]),
          )
        : {};
    for (const [name, cfg] of Object.entries(commands)) {
      const raw = cfg.options?.url;
      if (typeof raw !== "string")
        throw new Error(`${id} command ${name}: options.url is required`);
      const url = new URL(raw);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error(`${id} command ${name}: url must be http(s)`);
      }
      if (!isAllowedHost(url.hostname)) {
        throw new Error(
          `${id} command ${name}: host ${url.hostname} is not loopback or Tailscale`,
        );
      }
      const params: Record<string, string> = {};
      const p = cfg.options?.params;
      if (p && typeof p === "object" && !Array.isArray(p)) {
        for (const [k, v] of Object.entries(p)) params[k] = String(v);
      }
      const description = cfg.options?.description;
      this.#routes.set(name, {
        url,
        description:
          typeof description === "string"
            ? description
            : `POST ${url.pathname}`,
        params,
      });
    }
  }

  commands(): CommandSpec[] {
    return [...this.#routes].map(([name, r]) => {
      const optional: Record<string, ParamSpec> = {};
      for (const [k, d] of Object.entries(r.params))
        optional[k] = { type: "string", description: d };
      return {
        name,
        description: r.description,
        optional,
        defaultLevel: "manual",
        timeoutMs: 120_000,
      };
    });
  }

  #resolveHeaders(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.#headers)) {
      out[k] = v.startsWith("env:") ? (process.env[v.slice(4)] ?? "") : v;
    }
    return out;
  }

  async run(
    command: string,
    params: Record<string, unknown>,
    ctx: RunContext,
  ): Promise<RunResult> {
    const route = this.#routes.get(command);
    if (!route)
      return {
        ok: false,
        error: { code: "unknown_command", message: command },
      };
    const signal = AbortSignal.any([
      ctx.signal,
      AbortSignal.timeout(Math.max(1, ctx.deadline - Date.now())),
    ]);
    let res: Response;
    try {
      res = await fetch(route.url, {
        method: "POST",
        redirect: "manual",
        signal,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...this.#resolveHeaders(),
        },
        body: JSON.stringify(params),
      });
    } catch (err) {
      return {
        ok: false,
        error: { code: "unreachable", message: (err as Error).message },
      };
    }
    const text = (await res.text()).slice(0, 256 * 1024);
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // keep text
    }
    if (!res.ok) {
      return {
        ok: false,
        payload: body,
        error: { code: `http_${res.status}`, message: res.statusText },
      };
    }
    return { ok: true, payload: body };
  }
}
