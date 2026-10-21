export interface PinnedMediaSource {
  readonly src: string;
  readonly revision: string | null;
}

/** Access renewal and reconnects do not change loaded media; file changes wait for pause. */
export function selectPinnedMediaSource(
  current: PinnedMediaSource | null,
  latestSrc: string | null,
  revision: string | null,
  playing: boolean,
  sourceFailed = false,
  failedSrc: string | null = null,
): PinnedMediaSource | null {
  if (latestSrc === null && !sourceFailed) return current;
  if (current === null) {
    return latestSrc !== null && revision !== null ? { src: latestSrc, revision } : null;
  }
  if (current.src === failedSrc && latestSrc !== null && latestSrc !== current.src) {
    return { src: latestSrc, revision };
  }
  if (current.revision === revision || playing) return current;
  return latestSrc === null ? null : { src: latestSrc, revision };
}
