import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import type { TimestampFormat } from "@t3tools/contracts/settings";

import { TimeInput } from "./TimeInput";

const settings = vi.hoisted(() => ({ timestampFormat: "24-hour" as TimestampFormat }));
vi.mock("../hooks/useSettings", () => ({
  useClientSettings: (select: (value: typeof settings) => unknown) => select(settings),
}));

afterEach(() => vi.unstubAllGlobals());

it("submits canonical 24-hour times and rejects invalid entries", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  settings.timestampFormat = "24-hour";
  const submitted = vi.fn();
  function Form() {
    const [time, setTime] = useState("17:30");
    return (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submitted(time);
        }}
      >
        <label htmlFor="time">Run at</label>
        <TimeInput
          id="time"
          required
          value={time}
          onChange={(event) => setTime(event.target.value)}
        />
        <button type="submit">Save</button>
      </form>
    );
  }
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  try {
    await act(() => root.render(<Form />));
    const field = page.getByRole("textbox", { name: "Run at" });
    await expect.element(field).toHaveValue("17:30");
    for (const time of ["17:30", "23:59", "00:00"]) {
      await userEvent.fill(field, time);
      await userEvent.click(page.getByRole("button", { name: "Save" }));
      expect(submitted).toHaveBeenLastCalledWith(time);
    }
    submitted.mockClear();
    for (const time of ["", "24:00", "17:60", "5:30", "5:30 PM"]) {
      await userEvent.fill(field, time);
      await userEvent.click(page.getByRole("button", { name: "Save" }));
      expect(submitted).not.toHaveBeenCalled();
    }
    await userEvent.fill(field, "18:45");
    for (const format of ["12-hour", "locale", "24-hour"] as const) {
      settings.timestampFormat = format;
      await act(() => root.render(<Form />));
      const input = container.querySelector("input")!;
      expect(input.value).toBe("18:45");
      await userEvent.click(page.getByRole("button", { name: "Save" }));
      expect(submitted).toHaveBeenLastCalledWith("18:45");
      expect(input.value).toBe("18:45");
    }
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});
