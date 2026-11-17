import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  formatChatTimestampTooltip,
  formatDayAwareTimestamp,
  formatFullTimestamp,
  formatTimeOfDay,
  formatTimestamp,
  formatUpcomingTimestamp,
} from "./timestampFormat";

// Node re-resolves the default zone when TZ is assigned, like a renderer after the OS zone changes.
function useTimeZone(timeZone: string): Disposable {
  const previous = process.env.TZ;
  process.env.TZ = timeZone;
  return {
    [Symbol.dispose]: () => {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    },
  };
}

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

describe("timestamps in an explicit time zone", () => {
  // 23:00 UTC on July 1 is 7 PM on July 1 in New York, whatever the host zone.
  const now = Date.parse("2026-07-01T23:00:00.000Z");
  const zone = "America/New_York";

  it("picks relative days from the calendar in that zone", () => {
    expect(formatUpcomingTimestamp("2026-07-02T00:30:00.000Z", "12-hour", now, zone)).not.toMatch(
      /tomorrow/,
    );
    expect(formatUpcomingTimestamp("2026-07-02T05:30:00.000Z", "12-hour", now, zone)).toMatch(
      /^tomorrow at /,
    );
    expect(formatDayAwareTimestamp("2026-07-01T03:30:00.000Z", "12-hour", now, zone)).toMatch(
      /^yesterday at /,
    );
  });
});

describe("timestamps after the system time zone changes", () => {
  // Built fresh with an explicit zone, so expectations follow the host locale but not a stale zone.
  const timeIn = (iso: string, timeZone: string) =>
    new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone,
    }).format(new Date(iso));
  const dayIn = (iso: string, timeZone: string) =>
    new Intl.DateTimeFormat(undefined, { month: "numeric", day: "numeric", timeZone }).format(
      new Date(iso),
    );

  it("renders the gutter label in the new zone", () => {
    const sameDay = "2026-11-07T04:45:43.877Z";
    const earlierInWeek = "2026-11-04T20:00:00.000Z";
    const now = Date.parse(sameDay);
    using _zone = useTimeZone("America/New_York");
    expect([
      formatDayAwareTimestamp(sameDay, "12-hour", now),
      formatDayAwareTimestamp(earlierInWeek, "12-hour", now),
    ]).toEqual([
      timeIn(sameDay, "America/New_York"),
      `${dayIn(earlierInWeek, "America/New_York")} ${timeIn(earlierInWeek, "America/New_York")}`,
    ]);

    process.env.TZ = "Asia/Bangkok";
    expect([
      formatDayAwareTimestamp(sameDay, "12-hour", now),
      formatDayAwareTimestamp(earlierInWeek, "12-hour", now),
    ]).toEqual([
      timeIn(sameDay, "Asia/Bangkok"),
      `${dayIn(earlierInWeek, "Asia/Bangkok")} ${timeIn(earlierInWeek, "Asia/Bangkok")}`,
    ]);
  });

  it("renders detailed timestamps in the new zone", () => {
    const instant = "2026-10-31T20:00:09.000Z";
    const expected = (timeZone: string, includeDate: boolean) =>
      new Intl.DateTimeFormat(undefined, {
        ...(includeDate ? { year: "numeric", month: "short", day: "numeric" } : {}),
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
        hour12: true,
        timeZone,
      }).format(new Date(instant));
    using _zone = useTimeZone("America/New_York");
    expect(formatTimestamp(instant, "12-hour")).toBe(expected("America/New_York", false));
    expect(formatFullTimestamp(instant, "12-hour")).toBe(expected("America/New_York", true));

    process.env.TZ = "Asia/Bangkok";
    expect(formatTimestamp(instant, "12-hour")).toBe(expected("Asia/Bangkok", false));
    expect(formatFullTimestamp(instant, "12-hour")).toBe(expected("Asia/Bangkok", true));
  });

  it("renders the tooltip in the new zone", () => {
    const monthEnd = "2026-10-31T20:00:00.000Z";
    using _zone = useTimeZone("America/New_York");
    expect(formatChatTimestampTooltip(monthEnd, "12-hour")).toBe(
      `${timeIn(monthEnd, "America/New_York")}, 31st October 2026`,
    );

    process.env.TZ = "Asia/Bangkok";
    expect(formatChatTimestampTooltip(monthEnd, "12-hour")).toBe(
      `${timeIn(monthEnd, "Asia/Bangkok")}, 1st November 2026`,
    );
  });
});
