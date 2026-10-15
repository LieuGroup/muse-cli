import {
  ask,
  type ConnectedMuse,
  cancel,
  connectMuse,
  findRoute,
  history,
  MuseError,
  MuseSession,
  RPC_ROUTES,
  resolveCookie,
} from "muse-agent-core";

type Json = Record<string, unknown>;

export interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Json;
  readonly annotations?: Json;
}

export const TOOLS: readonly ToolDef[] = [
  {
    name: "muse_ask",
    description:
      "Send a message to the user's Muse agent and wait for its complete reply. Returns the reply text plus tools the agent used.",
    inputSchema: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "What to ask or tell the agent.",
        },
        session_id: {
          type: "string",
          description: "Optional thread/session id.",
        },
        timeout_seconds: { type: "number", description: "Default 300." },
      },
      required: ["message"],
    },
  },
  {
    name: "muse_history",
    description: "Read recent messages from the Muse agent's transcript.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Default 20." },
        session_id: { type: "string" },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "muse_cancel",
    description: "Stop the Muse agent's in-flight turn.",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" } },
    },
  },
  {
    name: "muse_vms",
    description: "List the agent VMs on the account.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "muse_methods",
    description:
      "Search the Muse gateway RPC catalog (method, verb, path, service, safety, stream mode).",
    inputSchema: {
      type: "object",
      properties: {
        filter: {
          type: "string",
          description: "Substring of the method name.",
        },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "muse_call",
    description:
      "Call any non-streaming Muse gateway method by name. Methods tagged destructive or sensitive are refused unless allow_unsafe is true.",
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string" },
        params: { type: "object" },
        allow_unsafe: { type: "boolean" },
      },
      required: ["method"],
    },
  },
];

/** Lazily-opened, reused connection. Reconnects if it dies. */
export class MuseConnection {
  #pending: Promise<ConnectedMuse> | null = null;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async cookie(): Promise<string> {
    return resolveCookie({
      env: this.env,
      cookieFile: this.env.MUSE_COOKIE_FILE,
      // Chrome is the macOS default; MUSE_FROM_CHROME=0 disables it.
      fromChrome: this.env.MUSE_FROM_CHROME === "0" ? false : undefined,
      chromeProfile: this.env.MUSE_CHROME_PROFILE,
    });
  }

  async get(): Promise<ConnectedMuse> {
    if (!this.#pending) {
      this.#pending = (async () =>
        connectMuse({ cookie: await this.cookie(), vm: this.env.MUSE_VM }))();
      this.#pending.catch(() => {
        this.#pending = null;
      });
    }
    return this.#pending;
  }

  reset(): void {
    const p = this.#pending;
    this.#pending = null;
    p?.then((c) => c.gateway.close()).catch(() => {});
  }
}

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

export async function callTool(
  conn: MuseConnection,
  name: string,
  args: Json,
): Promise<unknown> {
  switch (name) {
    case "muse_methods": {
      const filter = str(args.filter);
      return RPC_ROUTES.filter((r) => !filter || r.method.includes(filter));
    }
    case "muse_vms":
      return new MuseSession({ cookie: await conn.cookie() }).listVms();
    case "muse_ask": {
      const message = str(args.message);
      if (!message) throw new MuseError("config", "message is required");
      const { gateway } = await conn.get();
      const r = await ask(gateway, message, {
        sessionId: str(args.session_id),
        timeoutMs: (num(args.timeout_seconds) ?? 300) * 1000,
      });
      return {
        reply: r.text,
        tools: r.tools,
        session_id: r.sessionId,
        message_id: r.messageId,
      };
    }
    case "muse_history": {
      const { gateway } = await conn.get();
      const res = await history(gateway, {
        limit: num(args.limit) ?? 20,
        sessionId: str(args.session_id),
      });
      return res.chat_events
        .map((row) => ({
          role: row.event_name === "message.user" ? "user" : "agent",
          text: String(row.display_text ?? ""),
          seq: row.seq,
        }))
        .filter((m) => m.text);
    }
    case "muse_cancel": {
      const { gateway } = await conn.get();
      return cancel(gateway, str(args.session_id));
    }
    case "muse_call": {
      const method = str(args.method);
      if (!method) throw new MuseError("config", "method is required");
      const route = findRoute(method);
      if (!route) throw new MuseError("config", `unknown method ${method}`);
      if (route.streamMode) {
        throw new MuseError(
          "config",
          `${method} is a stream; not callable via muse_call`,
        );
      }
      if (
        (route.safety === "destructive" || route.safety === "sensitive") &&
        args.allow_unsafe !== true
      ) {
        throw new MuseError(
          "config",
          `${method} is tagged "${route.safety}". Ask the user first, then pass allow_unsafe: true.`,
        );
      }
      const params = (
        args.params && typeof args.params === "object" ? args.params : {}
      ) as Json;
      const { gateway } = await conn.get();
      return gateway.request(method, params);
    }
    default:
      throw new MuseError("config", `unknown tool ${name}`);
  }
}
