import { describe, expect, it } from "vite-plus/test";

import { act, render, stubGlobal } from "../../../test/render";
import { MediaVideoPlayer } from "./MediaVideoPlayer";

// The observer never reports the video as visible, so it keeps preload="none" and never
// requests these fake URLs; the test fires the media events itself.
class HiddenIntersectionObserver {
  observe() {}
  disconnect() {}
}

function videoSrc(container: HTMLElement): string | undefined {
  return container.querySelector("video")?.getAttribute("src") ?? undefined;
}

async function loadMetadata(container: HTMLElement) {
  await act(() => {
    container.querySelector("video")?.dispatchEvent(new Event("loadedmetadata"));
  });
}

describe("MediaVideoPlayer", () => {
  it("keeps a loaded paused video when only its URL is re-signed", async () => {
    using _observer = stubGlobal("IntersectionObserver", HiddenIntersectionObserver);
    await using screen = await render(
      <MediaVideoPlayer src="/asset/first/clip.mp4" label="clip" revision="file-1" />,
    );
    await loadMetadata(screen.container);

    await screen.rerender(
      <MediaVideoPlayer src="/asset/renewed/clip.mp4" label="clip" revision="file-1" />,
    );
    expect(videoSrc(screen.container)).toBe("/asset/first/clip.mp4");

    await screen.rerender(
      <MediaVideoPlayer src="/asset/changed/clip.mp4" label="clip" revision="file-2" />,
    );
    expect(videoSrc(screen.container)).toBe("/asset/changed/clip.mp4");

    // A second re-sign while the changed file is still loading must not restart that load.
    await screen.rerender(
      <MediaVideoPlayer src="/asset/changed-renewed/clip.mp4" label="clip" revision="file-2" />,
    );
    expect(videoSrc(screen.container)).toBe("/asset/changed/clip.mp4");
  });

  it("keeps a loaded paused video while its URL is briefly unavailable", async () => {
    using _observer = stubGlobal("IntersectionObserver", HiddenIntersectionObserver);
    await using screen = await render(
      <MediaVideoPlayer src="/asset/first/clip.mp4" label="clip" revision="file-1" />,
    );
    await loadMetadata(screen.container);

    await screen.rerender(<MediaVideoPlayer src={null} label="clip" revision="mutation-2" />);
    expect(videoSrc(screen.container)).toBe("/asset/first/clip.mp4");
  });
});
