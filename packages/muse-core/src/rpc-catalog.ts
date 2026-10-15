import { RPC_ROUTES } from "./rpc-catalog.generated.js";

export type HttpVerb = "GET" | "POST" | "PATCH" | "DELETE";
export type NoiseService =
  | "daemon"
  | "sentinel"
  | "vault"
  | "authd"
  | "ssh_access";
export type MethodSafety = "read" | "write" | "destructive" | "sensitive";

/** One gateway RPC method, as carried over HTTP-over-Noise. */
export interface RpcRouteSpec {
  readonly method: string;
  readonly httpMethod: HttpVerb;
  /** May contain `{param}` and `{*param}` placeholders filled from params. */
  readonly path: string;
  readonly service: NoiseService;
  readonly safety: MethodSafety;
  readonly requestBody?: "empty";
  readonly aliases?: readonly string[];
  readonly noiseOnly?: boolean;
  readonly responseType?: "binary";
  readonly maxResponseBytes?: number;
  readonly unboundedResponse?: boolean;
  readonly requestTimeoutMs?: number;
  readonly responseIdleTimeoutMs?: number;
  readonly channel?: "main" | "media";
  /** `subscription`: NDJSON ack + events. `records`: NDJSON records. */
  readonly streamMode?: "subscription" | "records";
  readonly connectionClass?: "shared_agent";
}

export { RPC_ROUTES };

const byMethod = new Map<string, RpcRouteSpec>();
for (const route of RPC_ROUTES) {
  byMethod.set(route.method, route);
  for (const alias of route.aliases ?? []) byMethod.set(alias, route);
}

export function findRoute(method: string): RpcRouteSpec | undefined {
  return byMethod.get(method);
}

export class RoutePathParamError extends Error {
  constructor(
    readonly method: string,
    readonly param: string,
  ) {
    super(`Missing required path parameter "${param}" for ${method}`);
    this.name = "RoutePathParamError";
  }
}

/**
 * Fill `{param}` / `{*param}` placeholders from params. Consumed params are
 * removed from the returned params so they are not also sent in the body/query.
 */
export function resolveRoutePath(
  route: RpcRouteSpec,
  params: Record<string, unknown>,
): { path: string; params: Record<string, unknown> } {
  const rest: Record<string, unknown> = { ...params };
  const path = route.path.replace(
    /\{(\*?)([a-zA-Z0-9_]+)\}/g,
    (_m, star: string, name: string) => {
      const value = rest[name];
      if (value == null || value === "") {
        throw new RoutePathParamError(route.method, name);
      }
      delete rest[name];
      const text = String(value);
      return star
        ? text.split("/").map(encodeURIComponent).join("/")
        : encodeURIComponent(text);
    },
  );
  return { path, params: rest };
}

/** Append params as a query string (GET requests). Nested values become JSON. */
export function appendQuery(
  path: string,
  params: Record<string, unknown>,
): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) qs.append(key, String(item));
    } else if (typeof value === "object") {
      qs.append(key, JSON.stringify(value));
    } else {
      qs.append(key, String(value));
    }
  }
  const search = qs.toString();
  if (!search) return path;
  return path.includes("?") ? `${path}&${search}` : `${path}?${search}`;
}
