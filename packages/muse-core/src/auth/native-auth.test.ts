import { describe, expect, it } from "vitest";
import { MuseError } from "../errors.js";
import { CookieJar } from "./cookie-jar.js";
import { loginWithOtp } from "./native-auth.js";

type Route = (req: { body: string; headers: Headers }) => Response;

function json(body: unknown, cookies: string[] = [], status = 200) {
  const headers = new Headers({ "Content-Type": "application/json" });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(JSON.stringify(body), { status, headers });
}

function redirect(location: string, cookies: string[] = []) {
  const headers = new Headers({ Location: location });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers });
}

/** A fake fetch routed by "METHOD url"; records every request. */
function fakeFetch(routes: Record<string, Route>) {
  const calls: { key: string; body: string; headers: Headers }[] = [];
  const impl = (async (input: string | URL, init: RequestInit = {}) => {
    const key = `${init.method ?? "GET"} ${String(input)}`;
    const body = typeof init.body === "string" ? init.body : "";
    const headers = new Headers(init.headers);
    calls.push({ key, body, headers });
    const route = routes[key];
    if (!route) throw new Error(`unexpected ${key}`);
    return route({ body, headers });
  }) as typeof fetch;
  return { impl, calls };
}

const API = "https://muse.ai/api/auth/native";
const BOOTSTRAP = "https://auth.meta.com/hatch/session/bootstrap/";

/** Routes for a successful email OTP login ending in a cookie redirect chain. */
function happyRoutes(extra: Record<string, Route> = {}): Record<string, Route> {
  return {
    [`POST ${API}/restart`]: () =>
      json({ csrf_token: "csrf-1", flow_state: "started" }, [
        "hatch_native_auth_csrf=c1; Path=/; HttpOnly",
      ]),
    [`POST ${API}/send-otp`]: () =>
      json({ registration_state: "otp_sent", flow: "login" }, [
        "hatch_native_auth_state=s1; Path=/; HttpOnly",
      ]),
    [`POST ${API}/confirm-otp`]: () =>
      json({ auth_meta_session: { frl_access_token: "frl-token" } }),
    [`POST ${BOOTSTRAP}`]: () =>
      redirect("https://auth.muse.ai/oidc/muse/?code=x", [
        "auth_meta_sess=m1; Domain=auth.meta.com; Path=/",
      ]),
    "GET https://auth.muse.ai/oidc/muse/?code=x": () =>
      redirect("https://muse.ai/", [
        "hatch_sess=SESSION; Domain=muse.ai; Path=/; HttpOnly; Max-Age=2592000",
        "hatch_native_auth_state=; Path=/; Max-Age=0",
      ]),
    ...extra,
  };
}

describe("CookieJar", () => {
  it("scopes Domain cookies to subdomains and honours deletion", () => {
    const jar = new CookieJar();
    const h = new Headers();
    h.append("Set-Cookie", "a=1; Domain=muse.ai; Path=/");
    h.append("Set-Cookie", "b=2; Path=/");
    jar.absorb("https://auth.muse.ai/x", h);
    expect(jar.get("https://muse.ai/", "a")).toBe("1");
    expect(jar.get("https://muse.ai/", "b")).toBeUndefined();
    expect(jar.header("https://auth.muse.ai/")).toBe("a=1; b=2");
    const del = new Headers({ "Set-Cookie": "a=; Domain=muse.ai; Max-Age=0" });
    jar.absorb("https://muse.ai/", del);
    expect(jar.get("https://muse.ai/", "a")).toBeUndefined();
  });

  it("ignores a Domain the responding host may not set", () => {
    const jar = new CookieJar();
    jar.absorb(
      "https://evil.example/",
      new Headers({ "Set-Cookie": "hatch_sess=x; Domain=muse.ai" }),
    );
    expect(jar.get("https://muse.ai/", "hatch_sess")).toBeUndefined();
  });
});

describe("loginWithOtp", () => {
  it("sends the code, confirms it, and returns only session cookies", async () => {
    const f = fakeFetch(happyRoutes());
    const cookie = await loginWithOtp({
      contactPoint: " me@example.com ",
      region: "AU",
      fetchImpl: f.impl,
      getCode: async () => " 123456 ",
    });
    expect(cookie).toBe("hatch_sess=SESSION");

    const send = f.calls.find((c) => c.key.endsWith("/send-otp"));
    expect(JSON.parse(send?.body ?? "{}")).toEqual({
      contact_point: "me@example.com",
      region: "AU",
    });
    expect(send?.headers.get("X-Hatch-CSRF-Token")).toBe("csrf-1");
    expect(send?.headers.get("Cookie")).toContain("hatch_native_auth_csrf=c1");
    expect(send?.headers.get("Sec-Fetch-Site")).toBe("same-origin");

    const confirm = f.calls.find((c) => c.key.endsWith("/confirm-otp"));
    expect(JSON.parse(confirm?.body ?? "{}")).toEqual({ otp_code: "123456" });

    const boot = f.calls.find((c) => c.key === `POST ${BOOTSTRAP}`);
    expect(boot?.body).toBe("frl_access_token=frl-token");
    // muse.ai cookies never leak to auth.meta.com.
    expect(boot?.headers.get("Cookie")).toBeNull();
  });

  it("starts a fresh flow when restart reports flow_state=new", async () => {
    const f = fakeFetch(
      happyRoutes({
        [`POST ${API}/restart`]: () =>
          json({ csrf_token: "c", flow_state: "new" }),
        [`POST ${API}/start`]: () => json({}),
      }),
    );
    await loginWithOtp({
      contactPoint: "+61400000000",
      fetchImpl: f.impl,
      getCode: async () => "1",
    });
    expect(f.calls.map((c) => c.key)).toContain(`POST ${API}/start`);
  });

  it("requests an SMS second factor and submits its code", async () => {
    const f = fakeFetch(
      happyRoutes({
        [`POST ${API}/confirm-otp`]: () =>
          json({
            registration_state: "two_factor_required",
            two_factor_methods: [
              {
                method_id: "t1",
                method_type: "TOTP",
                label: "App",
                code_length: 6,
              },
              {
                method_id: "s1",
                method_type: "SMS",
                label: "Text",
                code_length: 6,
              },
            ],
          }),
        [`POST ${API}/two-factor-send-code`]: () => json({}),
        [`POST ${API}/two-factor`]: () =>
          json({ auth_meta_session: { frl_access_token: "frl-token" } }),
      }),
    );
    const asked: string[] = [];
    const cookie = await loginWithOtp({
      contactPoint: "me@example.com",
      fetchImpl: f.impl,
      getCode: async () => "111111",
      getTwoFactorCode: async (m) => {
        asked.push(m.methodType);
        return "222 222";
      },
    });
    expect(cookie).toBe("hatch_sess=SESSION");
    expect(asked).toEqual(["SMS"]);
    const sent = f.calls.find((c) => c.key.endsWith("/two-factor-send-code"));
    expect(JSON.parse(sent?.body ?? "{}")).toEqual({ method_id: "s1" });
    const tf = f.calls.find((c) => c.key === `POST ${API}/two-factor`);
    expect(JSON.parse(tf?.body ?? "{}")).toEqual({
      method_id: "s1",
      code: "222222",
    });
  });

  it("refuses password-only accounts before asking for a code", async () => {
    const f = fakeFetch(
      happyRoutes({
        [`POST ${API}/send-otp`]: () =>
          json({ registration_state: "password_required" }),
      }),
    );
    let asked = false;
    const err = await loginWithOtp({
      contactPoint: "me@example.com",
      fetchImpl: f.impl,
      getCode: async () => {
        asked = true;
        return "1";
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MuseError);
    expect((err as MuseError).detail?.code).toBe("password_required");
    expect(asked).toBe(false);
  });

  it("surfaces a wrong code as an auth error with the server's type", async () => {
    const f = fakeFetch(
      happyRoutes({
        [`POST ${API}/confirm-otp`]: () =>
          json(
            { type: "invalidCode", detail: "That code isn't right." },
            [],
            400,
          ),
      }),
    );
    const err = await loginWithOtp({
      contactPoint: "me@example.com",
      fetchImpl: f.impl,
      getCode: async () => "000000",
    }).catch((e: unknown) => e);
    expect((err as MuseError).kind).toBe("auth");
    expect((err as MuseError).detail?.code).toBe("invalidCode");
  });

  it("fails clearly when the bootstrap chain issues no session", async () => {
    const f = fakeFetch(
      happyRoutes({ [`POST ${BOOTSTRAP}`]: () => json({}, [], 403) }),
    );
    const err = await loginWithOtp({
      contactPoint: "me@example.com",
      fetchImpl: f.impl,
      getCode: async () => "1",
    }).catch((e: unknown) => e);
    expect((err as MuseError).message).toContain("no muse.ai session");
    expect((err as MuseError).message).not.toContain("frl-token");
  });
});
