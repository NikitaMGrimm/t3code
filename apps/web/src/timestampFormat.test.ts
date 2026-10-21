import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { formatFullTimestamp, formatTimeOfDay } from "./timestampFormat";

// ICU can separate the day period with a narrow no-break space.
const normalize = (value: string) => value.replace(/[  ]/g, " ");

// The host locale is read once at module load, so each case reloads the module under its locale.
const importUnderLocale = async (locale: string) => {
  vi.stubGlobal("window", { desktopBridge: { getSystemLocale: () => locale } });
  vi.resetModules();
  return import("./timestampFormat");
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("formatFullTimestamp", () => {
  it.each([
    ["en-US", "Apr 7, 2025, 3:44:09 PM", "Apr 7, 2025, 3:44:09 PM", "Apr 7, 2025, 15:44:09"],
    ["en-GB", "7 Apr 2025, 15:44:09", "7 Apr 2025, 3:44:09 pm", "7 Apr 2025, 15:44:09"],
  ])("keeps the date and seconds under %s", async (locale, localeLabel, twelve, twentyFour) => {
    const { formatFullTimestamp: format, formatTimestamp: time } = await importUnderLocale(locale);
    const date = new Date(2025, 3, 7, 15, 44, 9).toISOString();

    expect(normalize(format(date, "locale"))).toBe(localeLabel);
    expect(normalize(format(date, "12-hour"))).toBe(twelve);
    expect(format(date, "24-hour")).toBe(twentyFour);
    expect(normalize(format(date, "24-hour", false))).toBe(twentyFour.replace(":09", ""));
    // Switching back must not reuse a formatter cached for another preference or precision.
    expect(normalize(format(date, "locale"))).toBe(localeLabel);
    expect(normalize(time(date, "12-hour"))).toMatch(/^3:44:09 [ap]m$/i);
    expect(time(date, "24-hour")).toBe("15:44:09");
  });

  it.each([
    ["en-US", "Jan 1, 2025, 12:05 AM", "Jan 1, 2025, 00:05"],
    ["en-GB", "1 Jan 2025, 12:05 am", "1 Jan 2025, 0:05"],
  ])("renders midnight per explicit hour cycle under %s", async (locale, twelve, twentyFour) => {
    const { formatFullTimestamp: format } = await importUnderLocale(locale);
    const midnight = new Date(2025, 0, 1, 0, 5, 9).toISOString();

    expect(normalize(format(midnight, "12-hour", false))).toBe(twelve);
    expect(format(midnight, "24-hour", false)).toBe(twentyFour);
  });

  it("returns an empty label for an invalid date", () => {
    expect(formatFullTimestamp("not-a-date", "24-hour")).toBe("");
    expect(formatFullTimestamp("not-a-date", "12-hour", false)).toBe("");
  });
});

describe("formatTimeOfDay", () => {
  it.each([
    ["en-US", "9:30 AM", "12:00 AM", "12:00 PM"],
    ["en-GB", "9:30", "0:00", "12:00"],
  ])("formats scheduled wall-clock times under %s", async (locale, morning, midnight, noon) => {
    const { formatTimeOfDay: format } = await importUnderLocale(locale);

    expect(normalize(format("09:30", "locale"))).toBe(morning);
    expect(normalize(format("00:00", "locale"))).toBe(midnight);
    expect(normalize(format("12:00", "locale"))).toBe(noon);
    expect(normalize(format("00:00", "12-hour"))).toMatch(/^12:00 [ap]m$/i);
    expect(normalize(format("12:00", "12-hour"))).toMatch(/^12:00 pm$/i);
    expect(format("00:00", "24-hour")).toMatch(/^0?0:00$/);
    expect(format("12:00", "24-hour")).toBe("12:00");
    expect(format("9:05", "24-hour")).toMatch(/^0?9:05$/);
  });

  it("returns a malformed time of day unchanged", () => {
    expect(formatTimeOfDay("24:00", "24-hour")).toBe("24:00");
    expect(formatTimeOfDay("not-a-time", "12-hour")).toBe("not-a-time");
  });
});
