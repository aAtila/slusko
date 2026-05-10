import { describe, expect, test } from "bun:test";
import {
  applySpeakerMap,
  collectSpeakerLabels,
  formatSpeakerDisplayList,
  formatSpeakerDisplayOwner,
} from "./speaker-display";

describe("speaker mapping display helpers", () => {
  test("applies a full speaker mapping fixture", () => {
    expect(
      applySpeakerMap("SPEAKER_00 handed off to SPEAKER_01.", {
        SPEAKER_00: "Atila",
        SPEAKER_01: "Marko",
      }),
    ).toBe("Atila handed off to Marko.");
  });

  test("leaves unmapped speakers as raw labels in a partial mapping fixture", () => {
    expect(
      applySpeakerMap("SPEAKER_00 asked SPEAKER_02 to follow up.", {
        SPEAKER_00: "Atila",
      }),
    ).toBe("Atila asked SPEAKER_02 to follow up.");
  });

  test("leaves text unchanged for an empty mapping fixture", () => {
    expect(applySpeakerMap("SPEAKER_00 and SPEAKER_01 joined.", {})).toBe(
      "SPEAKER_00 and SPEAKER_01 joined.",
    );
  });

  test("replaces labels with substring-safe boundaries", () => {
    expect(
      applySpeakerMap(
        "SPEAKER_01, SPEAKER_010, SPEAKER_1, and SPEAKER_10 are distinct.",
        {
          SPEAKER_01: "Ana",
          SPEAKER_1: "Mila",
        },
      ),
    ).toBe("Ana, SPEAKER_010, Mila, and SPEAKER_10 are distinct.");
  });

  test("does not cascade replacements through mapped names", () => {
    expect(
      applySpeakerMap("SPEAKER_00 handed off to SPEAKER_01.", {
        SPEAKER_00: "SPEAKER_01",
        SPEAKER_01: "Marko",
      }),
    ).toBe("SPEAKER_01 handed off to Marko.");
  });

  test("trims mapped names before display", () => {
    expect(
      applySpeakerMap("SPEAKER_00 joined.", {
        SPEAKER_00: "  Atila  ",
      }),
    ).toBe("Atila joined.");
  });

  test("ignores blank mapped names", () => {
    expect(
      applySpeakerMap("SPEAKER_00 joined.", {
        SPEAKER_00: "   ",
      }),
    ).toBe("SPEAKER_00 joined.");
  });

  test("escapes regex metacharacters in non-canonical labels", () => {
    // Labels are normally `SPEAKER_##` (no metachars). This test exercises
    // the escape path so future label formats containing `.`, `(`, `+`,
    // etc. don't silently break or throw on RegExp construction.
    expect(
      applySpeakerMap("A.B and C(D) joined.", {
        "A.B": "Ana",
        "C(D)": "Bo",
      }),
    ).toBe("Ana and Bo joined.");
  });
});

describe("formatSpeakerDisplayOwner", () => {
  test("returns named owners as-is", () => {
    expect(formatSpeakerDisplayOwner({ kind: "name", value: "Mila" }, {})).toBe(
      "Mila",
    );
  });

  test("maps speaker owners when a display name exists", () => {
    expect(
      formatSpeakerDisplayOwner(
        { kind: "speaker", value: "SPEAKER_00" },
        { SPEAKER_00: "Atila" },
      ),
    ).toBe("Atila");
  });

  test("falls back to raw labels for unmapped speaker owners", () => {
    expect(
      formatSpeakerDisplayOwner({ kind: "speaker", value: "SPEAKER_00" }, {}),
    ).toBe("SPEAKER_00");
  });

  test("returns Unassigned for unknown owners", () => {
    expect(formatSpeakerDisplayOwner({ kind: "unknown" }, {})).toBe(
      "Unassigned",
    );
  });

  test("returns Unassigned for malformed runtime owners", () => {
    expect(formatSpeakerDisplayOwner({ kind: "team" } as never, {})).toBe(
      "Unassigned",
    );
  });
});

describe("collectSpeakerLabels", () => {
  test("includes labels from mappings and transcript segments", () => {
    expect(
      collectSpeakerLabels({
        speakerMappings: [{ speakerLabel: "SPEAKER_00", name: "Atila" }],
        summary: null,
        transcriptSegments: [{ speakerLabel: "SPEAKER_01" }],
      }),
    ).toEqual(["SPEAKER_00", "SPEAKER_01"]);
  });

  test("includes labels referenced only in summary prose", () => {
    expect(
      collectSpeakerLabels({
        speakerMappings: [],
        summary: {
          overview: "SPEAKER_10 kicked off the rollout.",
          decisions: [{ text: "SPEAKER_11 approves the timeline." }],
          actionItems: [],
          openQuestions: [{ text: "Can SPEAKER_12 join QA?" }],
        },
        transcriptSegments: [],
      }),
    ).toEqual(["SPEAKER_10", "SPEAKER_11", "SPEAKER_12"]);
  });

  test("includes labels from action item speaker owners", () => {
    expect(
      collectSpeakerLabels({
        speakerMappings: [],
        summary: {
          overview: "",
          decisions: [],
          actionItems: [
            {
              owner: { kind: "speaker", value: "SPEAKER_12" },
              task: "SPEAKER_13 sends notes.",
            },
          ],
          openQuestions: [],
        },
        transcriptSegments: [],
      }),
    ).toEqual(["SPEAKER_13", "SPEAKER_12"]);
  });

  test("preserves current export insertion order", () => {
    expect(
      collectSpeakerLabels({
        speakerMappings: [],
        summary: {
          overview: "SPEAKER_10 kicked off the rollout.",
          decisions: [{ text: "SPEAKER_11 approves the timeline." }],
          actionItems: [
            {
              owner: { kind: "speaker", value: "SPEAKER_12" },
              task: "SPEAKER_13 sends the follow-up notes.",
            },
          ],
          openQuestions: [],
        },
        transcriptSegments: [],
      }),
    ).toEqual(["SPEAKER_10", "SPEAKER_11", "SPEAKER_13", "SPEAKER_12"]);
  });

  test("returns an empty array when no labels exist", () => {
    expect(
      collectSpeakerLabels({
        speakerMappings: [],
        summary: null,
        transcriptSegments: [],
      }),
    ).toEqual([]);
  });
});

describe("formatSpeakerDisplayList", () => {
  test("formats labels with the supplied speaker map", () => {
    expect(
      formatSpeakerDisplayList({
        labels: ["SPEAKER_00", "SPEAKER_01"],
        speakerMap: { SPEAKER_00: "Atila", SPEAKER_01: "Marko" },
      }),
    ).toBe("Atila, Marko");
  });

  test("preserves label order and falls back for unmapped entries", () => {
    expect(
      formatSpeakerDisplayList({
        labels: ["SPEAKER_10", "SPEAKER_11"],
        speakerMap: {},
      }),
    ).toBe("SPEAKER_10, SPEAKER_11");
  });

  test("returns None when labels is empty", () => {
    expect(
      formatSpeakerDisplayList({
        labels: [],
        speakerMap: {},
      }),
    ).toBe("None");
  });
});
