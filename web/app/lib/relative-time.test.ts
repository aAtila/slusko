import { describe, expect, test } from "bun:test";
import { formatRelativeTimeFromNow } from "./relative-time";

const nowMs = Date.parse("2026-05-05T12:00:00.000Z");

describe("formatRelativeTimeFromNow", () => {
  test("formats recent timestamps as just now", () => {
    expect(formatRelativeTimeFromNow("2026-05-05T11:59:30.000Z", nowMs)).toBe(
      "just now",
    );
  });

  test("formats minutes, hours, and days", () => {
    expect(formatRelativeTimeFromNow("2026-05-05T11:52:00.000Z", nowMs)).toBe(
      "8 minutes ago",
    );
    expect(formatRelativeTimeFromNow("2026-05-05T09:00:00.000Z", nowMs)).toBe(
      "3 hours ago",
    );
    expect(formatRelativeTimeFromNow("2026-05-02T12:00:00.000Z", nowMs)).toBe(
      "3 days ago",
    );
  });

  test("returns Unknown date for invalid dates", () => {
    expect(formatRelativeTimeFromNow("not-a-date", nowMs)).toBe("Unknown date");
  });
});
