import { describe, expect, it } from "vite-plus/test";

import { selectPinnedMediaSource } from "./pinnedMediaSource";

describe("versioned media sources", () => {
  it("pins a paused video before it has ever played", () => {
    expect(selectPinnedMediaSource(null, "/first", "file-1", false)).toEqual({
      src: "/first",
      revision: "file-1",
    });
  });

  it("keeps loaded media across access URL renewal", () => {
    const current = { src: "/first", revision: "file-1" };
    expect(selectPinnedMediaSource(current, "/renewed", "file-1", false)).toBe(current);
  });

  it("loads changed content once playback pauses", () => {
    const current = { src: "/first", revision: "file-1" };
    expect(selectPinnedMediaSource(current, "/changed", "file-2", true)).toBe(current);
    expect(selectPinnedMediaSource(current, "/changed", "file-2", false)).toEqual({
      src: "/changed",
      revision: "file-2",
    });
  });

  it("releases unavailable media after playback pauses", () => {
    const current = { src: "/first", revision: "file-1" };
    expect(selectPinnedMediaSource(current, null, null, true, true)).toBe(current);
    expect(selectPinnedMediaSource(current, null, null, false, true)).toBeNull();
  });

  it("keeps paused media loaded while its connection is unavailable", () => {
    const current = { src: "/first", revision: "file-1" };
    expect(selectPinnedMediaSource(current, null, "workspace-mutation", false)).toBe(current);
  });

  it("does not pin unversioned inline or attachment media before playback", () => {
    expect(selectPinnedMediaSource(null, "/first", null, false)).toBeNull();
    expect(selectPinnedMediaSource(null, null, "file-1", false)).toBeNull();
  });

  it("recovers a failed pin when a fresh access URL arrives for the same revision", () => {
    const current = { src: "/expired", revision: "file-1" };
    expect(
      selectPinnedMediaSource(current, "/renewed", "file-1", false, false, "/expired"),
    ).toEqual({ src: "/renewed", revision: "file-1" });
    expect(selectPinnedMediaSource(current, "/expired", "file-1", false, false, "/expired")).toBe(
      current,
    );
  });
});
