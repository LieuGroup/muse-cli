/** Test-only runtime: echoes params, fails, or returns a large payload. */
import type { RuntimeAdapter } from "./types.js";

export const fakeAdapter: RuntimeAdapter = {
  id: "fake",
  commands: () => [
    {
      name: "fake.echo",
      description: "Echo the text back",
      required: { text: { type: "string", description: "Text" } },
      optional: { n: { type: "integer", description: "A number" } },
      defaultLevel: "manual",
      timeoutMs: 5_000,
    },
    {
      name: "fake.boom",
      description: "Always throws",
      defaultLevel: "manual",
      timeoutMs: 5_000,
    },
    {
      name: "fake.big",
      description: "Large output",
      defaultLevel: "manual",
      timeoutMs: 5_000,
    },
  ],
  run: async (command, params) => {
    if (command === "fake.boom") throw new Error("kaboom");
    if (command === "fake.big")
      return { ok: true, payload: { data: "y".repeat(5_000) } };
    return { ok: true, payload: { echo: params.text } };
  },
};
