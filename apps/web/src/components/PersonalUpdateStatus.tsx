import { personalUpdateMessage } from "@t3tools/shared/personalUpdate";
import { TriangleAlertIcon } from "lucide-react";
import { usePersonalUpdateStatus } from "~/hooks/usePersonalUpdateStatus";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";

export function PersonalUpdateStatus({ compact = false }: { readonly compact?: boolean }) {
  const { status, error } = usePersonalUpdateStatus();
  const blocked = status?.phase === "conflict" || status?.phase === "failed";
  if (compact && !blocked) return null;
  if (!status) return error && !compact ? <p role="status">{error}</p> : null;
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
