import { personalUpdateMessage } from "@t3tools/shared/personalUpdate";
import { TriangleAlertIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { usePersonalUpdateStatus } from "~/hooks/usePersonalUpdateStatus";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { toastManager } from "./ui/toast";

export function PersonalUpdateNotification() {
  const { status } = usePersonalUpdateStatus();
  const notice = useRef<{ attempt: string; id: string } | null>(null);

  useEffect(() => {
    if (!status) return;
    if (status.phase !== "conflict" && status.phase !== "failed") {
      if (notice.current) toastManager.close(notice.current.id);
      return;
    }
    const attempt = `${status.runUrl}:${status.sequence ?? status.phase}`;
    // Polling and Strict Mode must not reopen a dismissed notice for the same attempt.
    if (notice.current?.attempt === attempt) return;
    if (notice.current) toastManager.close(notice.current.id);
    const id = toastManager.add({
      type: "warning",
      title: "Personal nightly update stopped",
      description: (
        <>
          {personalUpdateMessage(status)}{" "}
          <a href={status.runUrl} target="_blank" rel="noreferrer">
            View update details
          </a>
        </>
      ),
      timeout: 10_000,
    });
    notice.current = { attempt, id };
  }, [status]);

  return null;
}

export function PersonalUpdateStatus() {
  const { status, error } = usePersonalUpdateStatus();
  const blocked = status?.phase === "conflict" || status?.phase === "failed";
  if (!status) return error ? <p role="status">{error}</p> : null;
  return (
    <Alert variant={blocked ? "warning" : "default"}>
      {blocked ? <TriangleAlertIcon /> : null}
      <AlertTitle>{blocked ? "Personal nightly update stopped" : "Personal nightly"}</AlertTitle>
      <AlertDescription>
        {personalUpdateMessage(status)}{" "}
        <a href={status.runUrl} target="_blank" rel="noreferrer">
          View update details
        </a>
        {error ? <span> {error}</span> : null}
      </AlertDescription>
    </Alert>
  );
}
