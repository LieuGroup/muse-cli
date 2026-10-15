/**
 * One-call passwordless login: send a code to an email or phone, ask the
 * caller for it, handle an optional second factor, and return the muse.ai
 * session cookie header. The caller decides how codes are collected
 * (terminal prompt, a command, a test fixture).
 */
import { MuseError } from "../errors.js";
import {
  type ConfirmOutcome,
  NativeAuthClient,
  type NativeAuthClientOptions,
  type TwoFactorMethod,
} from "./native-auth-client.js";

export interface OtpLoginOptions extends NativeAuthClientOptions {
  /** Email address or phone number (E.164, or local with `region`). */
  readonly contactPoint: string;
  /** ISO 3166 region hint for local phone numbers, e.g. "AU". */
  readonly region?: string;
  /** Return the one-time code that was just sent. */
  readonly getCode: () => Promise<string>;
  /** Return the second-factor code for `method` (2FA accounts only). */
  readonly getTwoFactorCode?: (method: TwoFactorMethod) => Promise<string>;
  readonly log?: (message: string) => void;
}

/** Prefer SMS (the server sends it on request), else the first offered. */
function pickMethod(methods: TwoFactorMethod[]): TwoFactorMethod {
  const method = methods.find((m) => m.methodType === "SMS") ?? methods[0];
  if (!method) {
    throw new MuseError(
      "auth",
      "Two-factor is required but no method was offered.",
    );
  }
  return method;
}

export async function loginWithOtp(opts: OtpLoginOptions): Promise<string> {
  const client = new NativeAuthClient(opts);
  const log = opts.log ?? (() => {});
  await client.restart();
  await client.sendOtp(opts.contactPoint, opts.region);
  log("Code sent.");
  let outcome: ConfirmOutcome = await client.confirmOtp(
    (await opts.getCode()).trim(),
  );
  if (outcome.kind === "two_factor") {
    if (!opts.getTwoFactorCode) {
      throw new MuseError(
        "auth",
        "This account has two-factor authentication.",
      );
    }
    const method = pickMethod(outcome.methods);
    if (method.methodType === "SMS")
      await client.sendTwoFactorCode(method.methodId);
    log(`Two-factor code required (${method.label}).`);
    const code = (await opts.getTwoFactorCode(method)).replace(/\s/g, "");
    outcome = await client.confirmTwoFactor(method.methodId, code);
    if (outcome.kind === "two_factor") {
      throw new MuseError("auth", "Two-factor verification did not complete.");
    }
  }
  if (outcome.kind === "token")
    await client.bootstrapSession(outcome.frlAccessToken);
  return client.sessionCookieHeader();
}
