export type MuseErrorKind =
  | "auth"
  | "config"
  | "transport"
  | "handshake"
  | "unsupported"
  | "gateway"
  | "timeout";

/** One error type for the whole SDK, tagged by kind for the CLI to render. */
export class MuseError extends Error {
  constructor(
    readonly kind: MuseErrorKind,
    message: string,
    readonly detail?: { code?: string; status?: number; cause?: unknown },
  ) {
    super(message);
    this.name = "MuseError";
  }
}

/** The gateway rejected a request with a structured error payload. */
export class GatewayRequestError extends MuseError {
  constructor(
    message: string,
    readonly code: string | undefined,
    readonly status: number,
  ) {
    super("gateway", message, { code, status });
    this.name = "GatewayRequestError";
  }
}
