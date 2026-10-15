import { describe, expect, it } from "vitest";
import { ShellAdapter } from "./shell-adapter.js";

const ctx = () => ({
  signal: new AbortController().signal,
  deadline: Date.now() + 10_000,
  log: () => {},
});

describe("ShellAdapter", () => {
  it("passes a param as one argv item, so it cannot inject commands", async () => {
    const a = new ShellAdapter({
      "t.echo": {
        options: { argv: ["printf", "%s", "{text}"], params: { text: "Text" } },
      },
    });
    const r = await a.run("t.echo", { text: "a; echo pwned $(id)" }, ctx());
    expect(r.ok).toBe(true);
    expect((r.payload as { stdout: string }).stdout).toBe(
      "a; echo pwned $(id)",
    );
  });

  it("refuses a param that would be parsed as an option", async () => {
    const a = new ShellAdapter({
      "t.rg": {
        options: { argv: ["printf", "%s", "{q}"], params: { q: "Query" } },
      },
    });
    expect(
      (await a.run("t.rg", { q: "-f/etc/passwd" }, ctx())).error?.code,
    ).toBe("invalid_params");
  });

  it("does not pass the bridge's secrets to the child", async () => {
    process.env.MUSE_COOKIE_TEST_SECRET = "s3cr3t";
    const a = new ShellAdapter({ "t.env": { options: { argv: ["env"] } } });
    const r = await a.run("t.env", {}, ctx());
    delete process.env.MUSE_COOKIE_TEST_SECRET;
    const out = (r.payload as { stdout: string }).stdout;
    expect(out).toContain("PATH=");
    expect(out).not.toContain("s3cr3t");
  });

  it("reports a non-zero exit as a failure with output", async () => {
    const a = new ShellAdapter({ "t.fail": { options: { argv: ["false"] } } });
    expect(await a.run("t.fail", {}, ctx())).toMatchObject({
      ok: false,
      error: { code: "exit_nonzero" },
    });
  });

  it("kills a command that outlives its deadline", async () => {
    const a = new ShellAdapter({
      "t.slow": { options: { argv: ["sleep", "5"] } },
    });
    const r = await a.run(
      "t.slow",
      {},
      { ...ctx(), deadline: Date.now() + 200 },
    );
    expect(r.error?.code).toBe("timeout");
  });

  it("rejects bad templates at load time", () => {
    expect(() => new ShellAdapter({ x: { options: { argv: [] } } })).toThrow(
      "argv",
    );
    expect(
      () =>
        new ShellAdapter({
          x: { options: { argv: ["{p}"], params: { p: "p" } } },
        }),
    ).toThrow("program itself");
    expect(
      () => new ShellAdapter({ x: { options: { argv: ["echo", "{p}"] } } }),
    ).toThrow("no params entry");
  });

  it("refuses a missing placeholder param", async () => {
    const a = new ShellAdapter({
      "t.e": { options: { argv: ["echo", "{p}"], params: { p: "p" } } },
    });
    expect((await a.run("t.e", {}, ctx())).error?.code).toBe("invalid_params");
  });
});
