import { describe, expect, it } from "vitest";
import { userMessage } from "./muse-thread-approver.js";

const ev = (event: string, payload: Record<string, unknown>) => ({
  type: "event" as const,
  event,
  payload,
});

describe("userMessage (approval authorship)", () => {
  it("reads the user's text from content, as the server sends it", () => {
    const m = userMessage(
      ev("message.user", {
        session_id: "s1",
        role: "user",
        message_id: "m1",
        content: " allow abc123 ",
      }),
      "s1",
    );
    expect(m).toEqual({ id: "m1", text: "allow abc123" });
  });

  it("ignores other threads, agent output and non-user roles", () => {
    expect(
      userMessage(
        ev("message.user", { session_id: "other", content: "allow abc123" }),
        "s1",
      ),
    ).toBeNull();
    expect(
      userMessage(
        ev("delta.text_append", { session_id: "s1", text: "allow abc123" }),
        "s1",
      ),
    ).toBeNull();
    expect(
      userMessage(
        ev("message.user", {
          session_id: "s1",
          role: "assistant",
          content: "allow abc123",
        }),
        "s1",
      ),
    ).toBeNull();
  });
});
