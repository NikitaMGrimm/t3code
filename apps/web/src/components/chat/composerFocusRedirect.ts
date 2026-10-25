export const TYPE_TO_FOCUS_EDITABLE_SELECTOR = [
  "input",
  "textarea",
  "select",
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]',
  '[role="textbox"]',
].join(",");
const TYPE_TO_FOCUS_INTERACTIVE_SELECTOR = [
  "button",
  "a[href]",
  "summary",
  '[role="application"]',
  '[role="button"]',
  '[role="checkbox"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="tab"]',
].join(",");
// Closed popups can stay mounted; match only open or closing layers.
export const TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR = [
  '[role="dialog"][aria-modal="true"]',
  '[data-slot="alert-dialog-popup"]:is([data-open],[data-ending-style])',
  '[data-slot="command-dialog-popup"]:is([data-open],[data-ending-style])',
  '[data-slot="dialog-popup"]:is([data-open],[data-ending-style])',
  '[data-slot="sheet-popup"]:is([data-open],[data-ending-style])',
  '[data-slot="sidebar"][data-mobile="true"]:is([data-open],[data-ending-style])',
  '[data-slot="menu-popup"]:is([data-open],[data-ending-style])',
  '[data-slot="select-popup"]:is([data-open],[data-ending-style])',
  '[data-slot="popover-popup"]:is([data-open],[data-ending-style])',
  '[data-slot="combobox-popup"]:is([data-open],[data-ending-style])',
  '[data-slot="autocomplete-popup"]:is([data-open],[data-ending-style])',
].join(",");

export function eventPathContainsSelector(event: Event, selector: string): boolean {
  const path = event.composedPath();
  if (path.length === 0 && event.target) {
    path.push(event.target);
  }
  return path.some((target) => target instanceof Element && target.closest(selector));
}

const SECRET_REQUEST_SELECTOR = '[data-v2-item-type="secret_request"]';
const SURFACE_LAUNCHER_KEYS_ATTRIBUTE = "data-surface-launcher-keys";

// The right-panel launcher registers its own window capture listener when it
// mounts. When the panel opens after page load that listener runs after ours,
// so we must leave its letters alone or the composer takes them first.
function isSurfaceLauncherKey(key: string): boolean {
  const launcherKeys = document
    .querySelector(`[${SURFACE_LAUNCHER_KEYS_ATTRIBUTE}]`)
    ?.getAttribute(SURFACE_LAUNCHER_KEYS_ATTRIBUTE);
  return launcherKeys?.toLowerCase().includes(key.toLowerCase()) ?? false;
}

export function shouldRedirectInputToComposer(event: Event): boolean {
  if (event.defaultPrevented) return false;
  // Never persist or send secret-request typing through the composer.
  if (eventPathContainsSelector(event, SECRET_REQUEST_SELECTOR)) return false;
  if (eventPathContainsSelector(event, TYPE_TO_FOCUS_EDITABLE_SELECTOR)) return false;
  if (eventPathContainsSelector(event, TYPE_TO_FOCUS_INTERACTIVE_SELECTOR)) return false;
  if (document.querySelector(TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR)) return false;
  return true;
}

export function shouldTypeToFocusComposer(event: KeyboardEvent): boolean {
  if (event.isComposing) return false;
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  if (event.key.length !== 1) return false;
  if (!shouldRedirectInputToComposer(event)) return false;
  if (isSurfaceLauncherKey(event.key)) return false;

  return true;
}

export function pasteTextToFocusComposer(event: ClipboardEvent): string | null {
  if (!event.clipboardData || event.clipboardData.files.length > 0) return null;
  if (!shouldRedirectInputToComposer(event)) return null;
  const text = event.clipboardData.getData("text/plain");
  return text.length > 0 ? text : null;
}

// Marks a field that focused itself, such as a picker search, rather than one
// the user chose. Pastes pass through it to the composer until the user engages.
export const COMPOSER_PASTE_PASSTHROUGH_ATTRIBUTE = "data-composer-paste-passthrough";
const COMPOSER_CONTROL_SELECTOR = "[data-composer-control]";

function isTextPaste(event: ClipboardEvent): boolean {
  if (event.defaultPrevented || !event.clipboardData) return false;
  if (event.clipboardData.files.length > 0) return false;
  return event.clipboardData.getData("text/plain").length > 0;
}

/** A text paste inside an open composer menu that belongs in the draft. */
export function isComposerMenuPaste(event: ClipboardEvent): boolean {
  if (!isTextPaste(event)) return false;
  return (
    !eventPathContainsSelector(event, TYPE_TO_FOCUS_EDITABLE_SELECTOR) ||
    eventPathContainsSelector(event, `[${COMPOSER_PASTE_PASSTHROUGH_ATTRIBUTE}]`)
  );
}

/** A text paste while a composer control keeps focus, as after a pointer toggle. */
export function isComposerControlPaste(event: ClipboardEvent): boolean {
  if (!isTextPaste(event)) return false;
  if (!eventPathContainsSelector(event, COMPOSER_CONTROL_SELECTOR)) return false;
  if (eventPathContainsSelector(event, SECRET_REQUEST_SELECTOR)) return false;
  return document.querySelector(TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR) === null;
}

export function isComposerControl(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(COMPOSER_CONTROL_SELECTOR) !== null;
}
