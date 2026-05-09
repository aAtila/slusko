import { describe, expect, test } from "bun:test";
import {
  defaultMeetingLanguage,
  formatMeetingLanguageLabel,
  formatRequestedLanguageLabel,
  languageToFormValue,
  meetingLanguageValidationMessage,
  parseMeetingLanguageFormValue,
} from "./meeting-language";

describe("meeting language helpers", () => {
  test("parses valid form values and defaults missing values when requested", () => {
    expect(parseMeetingLanguageFormValue("sr")).toEqual({
      ok: true,
      language: "sr",
    });
    expect(parseMeetingLanguageFormValue("en")).toEqual({
      ok: true,
      language: "en",
    });
    expect(parseMeetingLanguageFormValue("auto")).toEqual({
      ok: true,
      language: null,
    });
    expect(
      parseMeetingLanguageFormValue(undefined, {
        defaultWhenMissing: defaultMeetingLanguage,
      }),
    ).toEqual({ ok: true, language: "sr" });
  });

  test("rejects unsupported and empty language form values", () => {
    expect(parseMeetingLanguageFormValue("de")).toEqual({
      ok: false,
      error: meetingLanguageValidationMessage,
    });
    expect(
      parseMeetingLanguageFormValue("", {
        defaultWhenMissing: defaultMeetingLanguage,
      }),
    ).toEqual({
      ok: false,
      error: meetingLanguageValidationMessage,
    });
  });

  test("converts stored language values back to form values", () => {
    expect(languageToFormValue("sr")).toBe("sr");
    expect(languageToFormValue("en")).toBe("en");
    expect(languageToFormValue(null)).toBe("auto");
  });

  test("formats requested language labels", () => {
    expect(formatRequestedLanguageLabel("sr")).toBe("Serbian");
    expect(formatRequestedLanguageLabel("en")).toBe("English");
    expect(formatRequestedLanguageLabel(null)).toBe("Auto-detect");
  });

  test("formats resolved meeting language labels", () => {
    expect(
      formatMeetingLanguageLabel({ language: "sr", detectedLanguage: null }),
    ).toBe("Serbian");
    expect(
      formatMeetingLanguageLabel({ language: "en", detectedLanguage: null }),
    ).toBe("English");
    expect(
      formatMeetingLanguageLabel({ language: null, detectedLanguage: null }),
    ).toBe("Auto-detect pending");
    expect(
      formatMeetingLanguageLabel({ language: null, detectedLanguage: "hr" }),
    ).toBe("Auto-detected Croatian");
    expect(
      formatMeetingLanguageLabel({ language: null, detectedLanguage: "de" }),
    ).toBe("Auto-detected DE");
  });
});
