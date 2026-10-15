import { describe, expect, it } from "vitest";
import { mediaFromEvents, mediaFromPresentation, toVmPath } from "./media.js";
import { TurnTracker } from "./turn-tracker.js";

describe("toVmPath", () => {
  it("normalizes sandbox and absolute paths", () => {
    expect(toVmPath("sandbox://workspace/a.webp")).toBe("workspace/a.webp");
    expect(toVmPath("/home/hatch/workspace/a.webp")).toBe("workspace/a.webp");
    expect(toVmPath("/workspace/a.webp")).toBe("workspace/a.webp");
  });
});

describe("mediaFromPresentation", () => {
  it("reads image presentations", () => {
    const refs = mediaFromPresentation({
      kind: "image",
      image_path: "workspace/imagine_media/x.webp",
      data: {
        images: [
          {
            path: "sandbox://workspace/imagine_media/x.webp",
            mime: "image/webp",
            byte_len: 10,
            label: "x",
          },
        ],
      },
    });
    expect(refs).toEqual([
      {
        path: "workspace/imagine_media/x.webp",
        kind: "image",
        mime: "image/webp",
        label: "x",
        bytes: 10,
      },
    ]);
  });

  it("reads audio and file presentations and skips missing files", () => {
    expect(
      mediaFromPresentation({
        kind: "audio",
        data: {
          audio: {
            path: "sandbox://workspace/podcasts/a/a.mp3",
            mime: "audio/mpeg",
          },
        },
      })[0]?.path,
    ).toBe("workspace/podcasts/a/a.mp3");
    expect(
      mediaFromPresentation({
        kind: "file",
        data: { file: { path: "sandbox://workspace/x.docx", missing: true } },
      }),
    ).toEqual([]);
  });

  it("collects from event lists without duplicates", () => {
    const ev = {
      type: "event" as const,
      event: "delta.presentation",
      payload: {
        kind: "image",
        image_path: "workspace/a.webp",
        data: { images: [{ path: "sandbox://workspace/a.webp" }] },
      },
    };
    expect(mediaFromEvents([ev, ev])).toHaveLength(1);
  });
});

describe("TurnTracker presentations", () => {
  it("attributes presentations after our user echo", () => {
    const t = new TurnTracker("s1");
    t.setUserMessageId("u1");
    const base = { session_id: "s1", is_thread: true };
    expect(
      t.handle({
        type: "event",
        event: "delta.presentation",
        payload: { ...base, kind: "image" },
      }),
    ).toBeNull();
    t.handle({
      type: "event",
      event: "message.user",
      payload: { ...base, message_id: "u1" },
    });
    const u = t.handle({
      type: "event",
      event: "delta.presentation",
      payload: { ...base, kind: "image" },
    });
    expect(u?.kind).toBe("presentation");
    expect(t.presentations).toHaveLength(1);
  });
});
