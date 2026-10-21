import { useState } from "react";

import { selectPinnedMediaSource, type PinnedMediaSource } from "../media/pinnedMediaSource";

export function AudioPreview(props: {
  readonly src: string;
  readonly name: string;
  readonly revision?: string | null;
  readonly onError?: () => void;
}) {
  const [source, setSource] = useState<PinnedMediaSource | null>(null);
  const [playing, setPlaying] = useState(false);
  const nextSource = selectPinnedMediaSource(source, props.src, props.revision ?? null, playing);
  if (nextSource !== source) setSource(nextSource);
  const src = source?.src ?? props.src;

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <audio
        controls
        preload="metadata"
        src={src}
        aria-label={props.name}
        className="w-full max-w-xl"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onError={() => {
          setPlaying(false);
          if (src !== props.src) setSource(null);
          else props.onError?.();
        }}
      />
    </div>
  );
}
