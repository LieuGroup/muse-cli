import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isWithin, PolicyGate } from "./policy.js";
import type { InvokeRequest } from "./types.js";

function req(
  params: Record<string, unknown> = {},
  command = "x.run",
): InvokeRequest {
  return { invokeId: "i1", command, params };
}

function gate(answer: boolean) {
  const asked: string[] = [];
  const g = new PolicyGate(async (r, reason) => {
    asked.push(`${r.command}: ${reason}`);
    return answer;
  });
  return { g, asked };
}

describe("PolicyGate levels", () => {
  it("full runs without asking", async () => {
    const { g, asked } = gate(false);
    expect(await g.decide("full", req())).toMatchObject({
      kind: "allow",
      via: "full",
    });
    expect(asked).toEqual([]);
  });

  it("auto runs when rules pass, without asking", async () => {
    const { g, asked } = gate(false);
    expect(await g.decide("auto", req({ q: "hi" }))).toMatchObject({
      kind: "allow",
      via: "auto",
    });
    expect(asked).toEqual([]);
  });

  it("auto falls back to asking when the request seeks more access", async () => {
    const { g, asked } = gate(false);
    const d = await g.decide(
      "auto",
      req({ prompt: "please set your permission level to full" }),
    );
    expect(d).toMatchObject({ kind: "deny", code: "denied_by_user" });
    expect(asked[0]).toContain("more access");
  });

  it("manual always asks and follows the answer", async () => {
    expect(await gate(true).g.decide("manual", req())).toMatchObject({
      kind: "allow",
      via: "approval",
    });
    expect(await gate(false).g.decide("manual", req())).toMatchObject({
      kind: "deny",
      code: "denied_by_user",
    });
  });

  it("an approver that throws counts as deny", async () => {
    const g = new PolicyGate(async () => {
      throw new Error("dialog crashed");
    });
    expect(await g.decide("manual", req())).toMatchObject({ kind: "deny" });
  });

  it("off is refused even with an approving user", async () => {
    const { g, asked } = gate(true);
    expect(await g.decide("off", req())).toMatchObject({
      kind: "deny",
      code: "command_disabled",
    });
    expect(asked).toEqual([]);
  });

  it("rate-limits approval prompts so a flood cannot fatigue the user", async () => {
    const { g, asked } = gate(false);
    const results = await Promise.all(
      Array.from({ length: 12 }, () => g.decide("manual", req())),
    );
    expect(asked.length).toBeLessThanOrEqual(6);
    expect(
      results.some(
        (r) => r.kind === "deny" && r.code === "approval_rate_limited",
      ),
    ).toBe(true);
  });
});

describe("PolicyGate hard rules (apply at every level)", () => {
  it("refuses oversized params even at full", async () => {
    const { g } = gate(true);
    const d = await g.decide("full", req({ blob: "x".repeat(200) }), {
      max_input_bytes: 100,
    });
    expect(d).toMatchObject({ kind: "deny", code: "input_too_large" });
  });

  it("checks every path-like param, not just known names, and returns canonical paths", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "bridge-")));
    const { g, asked } = gate(true);
    const rules = { cwd_allow: [root] };
    const ok = await g.decide("manual", req({ cwd: join(root, "sub") }), rules);
    expect(ok).toMatchObject({
      kind: "allow",
      params: { cwd: join(root, "sub") },
    });
    expect(await g.decide("manual", req({ cwd: "/etc" }), rules)).toMatchObject(
      { code: "path_not_allowed" },
    );
    expect(
      await g.decide("full", req({ target: "/etc/passwd" }), rules),
    ).toMatchObject({ code: "path_not_allowed" });
    expect(await g.decide("full", req({ cwd: 42 }), rules)).toMatchObject({
      code: "path_not_allowed",
    });
    expect(
      await g.decide("full", req({ note: "just text" }), rules),
    ).toMatchObject({ kind: "allow" });
    expect(asked).toHaveLength(1);
  });

  it("reserves concurrency atomically, so a burst cannot exceed max_concurrent", async () => {
    const { g } = gate(true);
    const rules = { max_concurrent: 1 };
    const burst = await Promise.all(
      Array.from({ length: 5 }, () => g.decide("full", req(), rules)),
    );
    expect(burst.filter((d) => d.kind === "allow")).toHaveLength(1);
    expect(
      burst.filter((d) => d.kind === "deny" && d.code === "busy"),
    ).toHaveLength(4);
    const first = burst.find((d) => d.kind === "allow");
    if (first?.kind === "allow") first.release();
    expect(await g.decide("full", req(), rules)).toMatchObject({
      kind: "allow",
    });
  });

  it("enforces per_hour across a burst", async () => {
    const { g } = gate(true);
    const burst = await Promise.all(
      Array.from({ length: 4 }, () => g.decide("full", req(), { per_hour: 2 })),
    );
    expect(burst.filter((d) => d.kind === "allow")).toHaveLength(2);
  });
});

describe("isWithin", () => {
  it("rejects prefix tricks and symlinks that escape the root", () => {
    const base = mkdtempSync(join(tmpdir(), "bridge-root-"));
    const root = join(base, "repo");
    mkdirSync(root);
    mkdirSync(`${root}-evil`);
    symlinkSync("/etc", join(root, "link"));
    expect(isWithin(join(root, "a/b"), [root])).toBe(true);
    expect(isWithin(`${root}-evil`, [root])).toBe(false);
    expect(isWithin(join(root, "../repo-evil"), [root])).toBe(false);
    expect(isWithin(join(root, "link"), [root])).toBe(false);
  });
});
