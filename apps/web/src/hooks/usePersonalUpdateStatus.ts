import { useSyncExternalStore } from "react";
import {
  decodePersonalUpdateStatus,
  PERSONAL_UPDATE_STATUS_URL,
  type PersonalUpdateStatus,
} from "@t3tools/shared/personalUpdate";

let snapshot: { status: PersonalUpdateStatus | null; error: string | null } = {
  status: null,
  error: null,
};
const listeners = new Set<() => void>();
let controller: AbortController | undefined;
let pending: Promise<void> | undefined;

export function refreshPersonalUpdateStatus(): Promise<void> {
  if (pending) return pending;
  const request = new AbortController();
  controller = request;
  pending = (async () => {
    try {
      const response = await fetch(PERSONAL_UPDATE_STATUS_URL, {
        cache: "no-store",
        signal: request.signal,
      });
      if (!response.ok) throw new Error("Update status unavailable");
      const status = decodePersonalUpdateStatus(await response.json());
      if (request.signal.aborted) return;
      snapshot = { status, error: null };
    } catch {
      if (request.signal.aborted) return;
      snapshot = { ...snapshot, error: "Could not check personal nightly status." };
    } finally {
      if (controller === request) {
        controller = undefined;
        pending = undefined;
      }
    }
    for (const listener of listeners) listener();
  })();
  return pending;
}

let stopPolling: (() => void) | undefined;
const onFocus = () => {
  void refreshPersonalUpdateStatus();
};
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    void refreshPersonalUpdateStatus();
    const timer = window.setInterval(onFocus, 240_000);
    window.addEventListener("focus", onFocus);
    stopPolling = () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      controller?.abort();
      controller = undefined;
      pending = undefined;
    };
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stopPolling?.();
  };
}
const getSnapshot = () => snapshot;
export function usePersonalUpdateStatus() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
