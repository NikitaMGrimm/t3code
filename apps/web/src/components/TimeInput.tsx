import { useClientSettings } from "../hooks/useSettings";
import { Input, type InputProps } from "./ui/input";

export function TimeInput(props: Omit<InputProps, "type" | "nativeInput">) {
  const is24Hour = useClientSettings((settings) => settings.timestampFormat === "24-hour");
  // Native time inputs follow the browser/OS hour cycle, regardless of our setting.
  return (
    <Input
      {...props}
      nativeInput
      type={is24Hour ? "text" : "time"}
      placeholder={is24Hour ? "HH:MM" : undefined}
      pattern={is24Hour ? "([01][0-9]|2[0-3]):[0-5][0-9]" : undefined}
      title={is24Hour ? "Enter a 24-hour time (HH:MM)." : undefined}
    />
  );
}
