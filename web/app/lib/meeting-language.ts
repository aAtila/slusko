export type RequestedMeetingLanguage = "sr" | "en";
export type MeetingLanguage = RequestedMeetingLanguage | null;
export type MeetingLanguageFormValue = RequestedMeetingLanguage | "auto";

export const defaultMeetingLanguage: RequestedMeetingLanguage = "sr";
export const meetingLanguageValidationMessage =
  "Choose Serbian, English, or Auto-detect.";

const knownLanguageLabels: Record<string, string> = {
  bs: "Bosnian",
  en: "English",
  hr: "Croatian",
  mk: "Macedonian",
  sr: "Serbian",
};

export function parseMeetingLanguageFormValue(
  value: unknown,
  options: { defaultWhenMissing?: MeetingLanguage } = {},
):
  | { ok: true; language: MeetingLanguage }
  | { ok: false; error: typeof meetingLanguageValidationMessage } {
  if (value === undefined) {
    return {
      ok: true,
      language: options.defaultWhenMissing ?? null,
    };
  }

  if (value === "sr" || value === "en") {
    return { ok: true, language: value };
  }

  if (value === "auto") {
    return { ok: true, language: null };
  }

  return { ok: false, error: meetingLanguageValidationMessage };
}

export function languageToFormValue(
  language: MeetingLanguage,
): MeetingLanguageFormValue {
  return language ?? "auto";
}

export function formatRequestedLanguageLabel(language: MeetingLanguage) {
  if (language === null) {
    return "Auto-detect";
  }

  return getLanguageName(language);
}

export function formatMeetingLanguageLabel({
  detectedLanguage,
  language,
}: {
  language: MeetingLanguage;
  detectedLanguage: string | null;
}) {
  if (language !== null) {
    return getLanguageName(language);
  }

  const normalizedDetectedLanguage = detectedLanguage?.trim();

  if (!normalizedDetectedLanguage) {
    return "Auto-detect pending";
  }

  return `Auto-detected ${getLanguageName(normalizedDetectedLanguage)}`;
}

function getLanguageName(language: string) {
  const normalizedLanguage = language.trim().toLowerCase();

  return (
    knownLanguageLabels[normalizedLanguage] ?? normalizedLanguage.toUpperCase()
  );
}
