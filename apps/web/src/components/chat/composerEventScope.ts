import { useState } from "react";

import { useComposerHandleContext } from "../../composerHandleContext";
import {
  COMPOSER_PASTE_PASSTHROUGH_ATTRIBUTE,
  isComposerControl,
  isComposerMenuPaste,
} from "./composerFocusRedirect";

const COMPOSER_FLOATING_LAYER_SELECTOR = [
  '[data-composer-drawer-layer="true"]',
  '[data-chat-composer-floating-layer="true"]',
].join(",");

export const composerFloatingLayerProps = {
  "data-chat-composer-floating-layer": "true",
} as const;

/**
 * Props for the popup of a composer-owned picker. `close` closes its root:
 * a text paste the popup does not own goes to the draft and dismisses it.
 */
export function useComposerMenuProps(close: () => void) {
  const composerRef = useComposerHandleContext();
  if (!composerRef) return { ...composerFloatingLayerProps, finalFocus: undefined };

  return {
    ...composerFloatingLayerProps,
    finalFocus: (closeType: string) => {
      const activeElement = document.activeElement;
      // A pointer toggle on the trigger leaves focus on it. A trigger that
      // just opened its own picker keeps focus.
      const pointerClosedOnControl =
        closeType !== "keyboard" &&
        isComposerControl(activeElement) &&
        activeElement?.getAttribute("aria-expanded") !== "true";
      if (activeElement === document.body || isInsideComposerFloatingLayer(activeElement)) {
        composerRef.current?.restoreFocus();
      } else if (pointerClosedOnControl) {
        // This runs mid-commit, and React refocuses a still-mounted trigger
        // after the commit, so the move waits for it.
        queueMicrotask(() => {
          if (document.activeElement === activeElement) composerRef.current?.restoreFocus();
        });
      }
      return false;
    },
    onPasteCapture: (event: React.ClipboardEvent<HTMLElement>) => {
      if (!isComposerMenuPaste(event.nativeEvent)) return;
      // The paste focuses the editor first, so the closing popup returns no focus.
      if (!composerRef.current?.pasteClipboardEvent(event.nativeEvent)) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    },
  };
}

/**
 * Props for a field that focuses itself when its picker opens. Until the user
 * points at it or types, a paste there belongs to the composer draft. Closing
 * the picker (`open` false) resets it for the next open.
 */
export function useComposerPastePassthrough(open = true) {
  const [engaged, setEngaged] = useState(false);
  if (!open && engaged) setEngaged(false);
  const engage = () => setEngaged(true);
  return {
    [COMPOSER_PASTE_PASSTHROUGH_ATTRIBUTE]: engaged ? undefined : "true",
    onPointerDownCapture: engage,
    onInputCapture: engage,
    onKeyDownCapture: (event: React.KeyboardEvent) => {
      if (["Shift", "Control", "Meta", "Alt"].includes(event.key)) return;
      // Paste itself is not search intent; selection and navigation chords are.
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") return;
      if (event.shiftKey && event.key === "Insert") return;
      engage();
    },
  };
}

function isInsideComposerFloatingLayer(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(COMPOSER_FLOATING_LAYER_SELECTOR) !== null;
}

/** Composer pickers and controls redirect their text pastes to the draft. */
export function isComposerPasteSource(target: EventTarget | null): boolean {
  return isInsideComposerFloatingLayer(target) || isComposerControl(target);
}

export function isInsideCollapsedComposerControls(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('[data-chat-composer-collapsed-controls="true"]') !== null
  );
}

export function isInsideRestingComposerControlScope(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    (target.closest('[data-chat-composer-resting-controls="true"]') !== null ||
      target.closest('[data-chat-composer-resting-images="true"]') !== null ||
      target.closest("[data-composer-context-control]") !== null ||
      isInsideComposerFloatingLayer(target))
  );
}
