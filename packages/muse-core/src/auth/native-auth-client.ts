/**
 * Client for muse.ai's passwordless native-auth surface (`/api/auth/native/*`),
 * the same steps the web login page drives:
 *   restart -> send-otp(contact_point) -> confirm-otp(otp_code) [-> two-factor]
 * A verified login returns `auth_meta_session.frl_access_token`; a form POST of
 * that token to auth.meta.com is exchanged, through a redirect chain, for the
 * `hatch_sess` cookie on muse.ai.
 *
 * Nothing here is logged: not the contact point, codes, tokens or cookies.
 */
import { MUSE_ORIGIN } from "../config.js";
import { MuseError } from "../errors.js";
import { CookieJar } from "./cookie-jar.js";

const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";
const AUTH_META_BOOTSTRAP = "https://auth.meta.com/hatch/session/bootstrap/";
/** Cookies the rest of the SDK needs; native-auth scratch cookies are dropped. */
const SESSION_COOKIES = ["hatch_sess", "hatch_gw", "hatch_vml", "datr"];

export interface TwoFactorMethod {
  readonly methodId: string;
  readonly methodType: "SMS" | "TOTP" | "RECOVERY_CODES" | "ADMIN_CODES";
  readonly label: string;
  readonly codeLength: number;
}

export type ConfirmOutcome =
  | { readonly kind: "session" }
  | { readonly kind: "token"; readonly frlAccessToken: string }
  | { readonly kind: "two_factor"; readonly methods: TwoFactorMethod[] };

export interface NativeAuthClientOptions {
  readonly origin?: string;
  readonly fetchImpl?: typeof fetch;
  readonly userAgent?: string;
}

type Json = Record<string, unknown>;

const isRecord = (v: unknown): v is Json =>
  v != null && typeof v === "object" && !Array.isArray(v);

const METHOD_TYPES = new Set(["SMS", "TOTP", "RECOVERY_CODES", "ADMIN_CODES"]);

function parseTwoFactorMethods(data: Json): TwoFactorMethod[] {
  if (!Array.isArray(data.two_factor_methods)) return [];
  return data.two_factor_methods.flatMap((v): TwoFactorMethod[] => {
    if (!isRecord(v)) return [];
    const { method_id: id, method_type: type, label, code_length: len } = v;
    if (typeof id !== "string" || typeof type !== "string") return [];
    if (!METHOD_TYPES.has(type)) return [];
    return [
      {
        methodId: id,
        methodType: type as TwoFactorMethod["methodType"],
        label: typeof label === "string" ? label : type,
        codeLength: typeof len === "number" ? len : 6,
      },
    ];
  });
}

export class NativeAuthClient {
  readonly #jar = new CookieJar();
  readonly #origin: string;
  readonly #fetch: typeof fetch;
  readonly #ua: string;
  readonly #waterfallId = crypto.randomUUID();
  #csrf: string | null = null;

  constructor(opts: NativeAuthClientOptions = {}) {
    this.#origin = opts.origin ?? MUSE_ORIGIN;
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#ua = opts.userAgent ?? DEFAULT_UA;
  }

  /** POST one native-auth step; returns its JSON body (empty on redirect). */
  async #step(action: string, body: Json): Promise<Json> {
    const url = `${this.#origin}/api/auth/native/${action}`;
    const cookie = this.#jar.header(url);
    const res = await this.#fetch(url, {
      method: "POST",
      redirect: "manual",
      headers: {
        Origin: this.#origin,
        Referer: `${this.#origin}/`,
        "User-Agent": this.#ua,
        Accept: "*/*",
        "Content-Type": "application/json",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
        "X-Hatch-Waterfall-Id": this.#waterfallId,
        "X-Hatch-Caa-Reg-Entry-Point": "login_home",
        ...(this.#csrf ? { "X-Hatch-CSRF-Token": this.#csrf } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify(body),
    });
    this.#jar.absorb(url, res.headers);
    const text = await res.text();
    let json: Json = {};
    try {
      const parsed: unknown = text ? JSON.parse(text) : {};
      if (isRecord(parsed)) json = parsed;
    } catch {
      // non-JSON, e.g. a redirect page
    }
    if (res.status >= 300 && res.status < 400) return json;
    if (!res.ok) {
      const type = typeof json.type === "string" ? json.type : undefined;
      const detail =
        typeof json.detail === "string" ? json.detail : `HTTP ${res.status}`;
      throw new MuseError("auth", `Login step "${action}" failed: ${detail}`, {
        status: res.status,
        code: type,
      });
    }
    if (typeof json.csrf_token === "string") this.#csrf = json.csrf_token;
    return json;
  }

  /** Begin a fresh login attempt; must run before `sendOtp`. */
  async restart(): Promise<void> {
    const data = await this.#step("restart", { resume: false });
    if (data.flow_state === "new") await this.#step("start", {});
    if (!this.#csrf) {
      throw new MuseError("auth", "Login is unavailable (no CSRF token).");
    }
  }

  /** Send a one-time code to an email address or phone number. */
  async sendOtp(contactPoint: string, region?: string): Promise<void> {
    const data = await this.#step("send-otp", {
      contact_point: contactPoint.trim(),
      ...(region ? { region } : {}),
    });
    if (data.registration_state === "password_required") {
      throw new MuseError(
        "unsupported",
        "This account must sign in with a password, which `muse auth login` does not support. Log in at muse.ai in Chrome instead.",
        { code: "password_required" },
      );
    }
  }

  async confirmOtp(code: string): Promise<ConfirmOutcome> {
    return this.#outcome(await this.#step("confirm-otp", { otp_code: code }));
  }

  /** SMS second factors are not sent automatically; request one first. */
  async sendTwoFactorCode(methodId: string): Promise<void> {
    await this.#step("two-factor-send-code", { method_id: methodId });
  }

  async confirmTwoFactor(
    methodId: string,
    code: string,
  ): Promise<ConfirmOutcome> {
    const body = { method_id: methodId, code };
    return this.#outcome(await this.#step("two-factor", body));
  }

  #outcome(data: Json): ConfirmOutcome {
    if (this.#jar.get(this.#origin, "hatch_sess")) return { kind: "session" };
    if (data.reactivation_required === true) {
      throw new MuseError(
        "unsupported",
        "This account is scheduled for deletion. Reactivate it at muse.ai first.",
      );
    }
    if (data.registration_state === "two_factor_required") {
      return { kind: "two_factor", methods: parseTwoFactorMethods(data) };
    }
    const session = data.auth_meta_session;
    if (isRecord(session) && typeof session.frl_access_token === "string") {
      return { kind: "token", frlAccessToken: session.frl_access_token };
    }
    if (typeof data.registration_state === "string") {
      throw new MuseError(
        "unsupported",
        `This account needs the "${data.registration_state}" step, which only the web sign-up supports. Finish it once at muse.ai.`,
      );
    }
    throw new MuseError("auth", "Login did not return a session token.");
  }

  /**
   * Replay the browser's hidden-form POST of the frl token to auth.meta.com
   * and follow redirects until `hatch_sess` lands on muse.ai.
   */
  async bootstrapSession(frlAccessToken: string): Promise<void> {
    let url = AUTH_META_BOOTSTRAP;
    let method = "POST";
    let body: string | undefined = new URLSearchParams({
      frl_access_token: frlAccessToken,
    }).toString();
    let last = "";
    for (
      let hop = 0;
      hop < 12 && !this.#jar.get(this.#origin, "hatch_sess");
      hop++
    ) {
      const cookie = this.#jar.header(url);
      const res = await this.#fetch(url, {
        method,
        redirect: "manual",
        headers: {
          "User-Agent": this.#ua,
          Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
          ...(body
            ? { "Content-Type": "application/x-www-form-urlencoded" }
            : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body,
      });
      this.#jar.absorb(url, res.headers);
      const { host, pathname } = new URL(url);
      last = `${res.status} ${host}${pathname}`;
      const location = res.headers.get("location");
      if (!location || res.status < 300 || res.status >= 400) break;
      url = new URL(location, url).toString();
      method = "GET";
      body = undefined;
    }
    if (!this.#jar.get(this.#origin, "hatch_sess")) {
      throw new MuseError(
        "auth",
        `Code accepted, but no muse.ai session was issued (last hop: ${last}).`,
      );
    }
  }

  /** `Cookie` header with just the session cookies for muse.ai. */
  sessionCookieHeader(): string {
    return SESSION_COOKIES.flatMap((name) => {
      const value = this.#jar.get(this.#origin, name);
      return value ? [`${name}=${value}`] : [];
    }).join("; ");
  }
}
