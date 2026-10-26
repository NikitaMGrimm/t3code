import { expect, it } from "vite-plus/test";

import { isExplicitCompactionActive, resolveComposerDispatchMode } from "./composerDispatch.ts";

it("allows steering during automatic compaction and preserves Queue and alternate dispatch", () => {
  const canSteer = !isExplicitCompactionActive({
    compactCommandIsActive: false,
    compactionRunning: true,
    activeRunUserMessageText: "Read the code",
  });
  expect(resolveComposerDispatchMode({ running: true, alternateModifier: false, canSteer })).toBe(
    "steer",
  );
  expect(resolveComposerDispatchMode({ running: true, alternateModifier: true, canSteer })).toBe(
    "queue",
  );
  expect(
    resolveComposerDispatchMode({
      running: true,
      alternateModifier: false,
      activeTurnDefault: "queue",
      canSteer,
    }),
  ).toBe("queue");
});

it("blocks steering only for a pending compact command or a running explicit compaction", () => {
  expect(
    isExplicitCompactionActive({
      compactCommandIsActive: true,
      compactionRunning: false,
      activeRunUserMessageText: undefined,
    }),
  ).toBe(true);
  for (const text of ["/compact", "  /COMPACT  ", "/compact keep the debugging notes"]) {
    const canSteer = !isExplicitCompactionActive({
      compactCommandIsActive: false,
      compactionRunning: true,
      activeRunUserMessageText: text,
    });
    expect(resolveComposerDispatchMode({ running: true, alternateModifier: false, canSteer })).toBe(
      "queue",
    );
    expect(resolveComposerDispatchMode({ running: true, alternateModifier: true, canSteer })).toBe(
      "queue",
    );
    expect(
      isExplicitCompactionActive({
        compactCommandIsActive: false,
        compactionRunning: false,
        activeRunUserMessageText: text,
      }),
    ).toBe(false);
  }
  for (const text of ["/compactify", "please /compact", undefined]) {
    expect(
      isExplicitCompactionActive({
        compactCommandIsActive: false,
        compactionRunning: true,
        activeRunUserMessageText: text,
      }),
    ).toBe(false);
  }
});
