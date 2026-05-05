import { describe, expect, test } from "bun:test";
import { isMeetingId } from "./meeting-id";

describe("meeting id helper", () => {
  test("accepts UUID-shaped meeting ids and rejects other route params", () => {
    expect(isMeetingId("00000000-0000-4000-8000-000000000006")).toBe(true);
    expect(isMeetingId("00000000-0000-4000-8000-000000000006 ")).toBe(false);
    expect(isMeetingId("not-a-uuid")).toBe(false);
    expect(isMeetingId(undefined)).toBe(false);
  });
});
