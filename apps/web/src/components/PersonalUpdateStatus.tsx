import { personalUpdateMessage, personalUpdateRepairKey } from "@t3tools/shared/personalUpdate";
import { TriangleAlertIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { usePersonalUpdateStatus } from "~/hooks/usePersonalUpdateStatus";
import { PersonalNightlyRepairButton } from "./PersonalNightlyRepairButton";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { toastManager } from "./ui/toast";

export function PersonalUpdateNotification() {
  const { status } = usePersonalUpdateStatus();
  const notice = useRef<{ attempt: string; id: string } | null>(null);

  useEffect(() => {
    if (!status) return;
    if (status.phase !== "conflict" && status.phase !== "failed") {
      if (notice.current) toastManager.close(notice.current.id);
      // Waiting or a release ends the episode; building the same attempt does not.
      if (status.waiting || status.phase === "ready") notice.current = null;
      return;
    }
    const attempt = personalUpdateRepairKey(status);
    // Polling, Strict Mode, and unrelated PR changes must not reopen a dismissed notice.
    if (notice.current?.attempt === attempt) return;
    if (notice.current) toastManager.close(notice.current.id);
    const id = toastManager.add({
      type: "warning",
      title: "Personal nightly update stopped",
      description: (
        <>
          {personalUpdateMessage(status)}{" "}
          <span className="mt-2 flex flex-wrap items-center gap-3">
            <a href={status.runUrl} target="_blank" rel="noreferrer">
              View update details
            </a>
            <PersonalNightlyRepairButton status={status} />
          </span>
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
        <span className="mt-2 flex flex-wrap items-center gap-3">
          <a href={status.runUrl} target="_blank" rel="noreferrer">
            View update details
          </a>
          {blocked ? <PersonalNightlyRepairButton status={status} /> : null}
        </span>
        {error ? <span> {error}</span> : null}
      </AlertDescription>
    </Alert>
  );
}
