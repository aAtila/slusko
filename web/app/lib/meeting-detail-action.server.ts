import {
  deleteMeetingAndArtifacts,
  MeetingMutationError,
  regenerateSummary,
  retryMeeting,
  saveSpeakerMapping,
  updateMeetingTitle,
  type DeleteMeetingResult,
  type RegenerateSummaryResult,
  type RetryMeetingResult,
  type SaveSpeakerMappingResult,
  type UpdateMeetingTitleResult,
} from "./meetings-mutations.server";

type MeetingDetailActionIntent =
  | "delete-meeting"
  | "regenerate-summary"
  | "retry-meeting"
  | "save-speaker-mapping"
  | "update-title";

export type MeetingDetailActionData =
  | { ok: true; intent: "update-title"; title: string }
  | { ok: true; intent: "regenerate-summary" }
  | {
      ok: true;
      intent: "retry-meeting";
      resumeFromStage: RetryMeetingResult["resumeFromStage"];
    }
  | {
      ok: true;
      intent: "save-speaker-mapping";
      speakerLabel: string;
      name: string | null;
    }
  | {
      ok: false;
      intent: MeetingDetailActionIntent;
      error: string;
      speakerLabel?: string;
    };

export type MeetingDetailActionResult =
  | { type: "data"; data: MeetingDetailActionData; status?: 400 | 404 | 500 }
  | { type: "redirect"; to: string };

type MeetingDetailActionHandlers = {
  deleteMeetingAndArtifacts?: (input: {
    meetingId: string | undefined;
  }) => Promise<DeleteMeetingResult>;
  updateMeetingTitle?: (input: {
    meetingId: string | undefined;
    title: unknown;
  }) => Promise<UpdateMeetingTitleResult>;
  saveSpeakerMapping?: (input: {
    meetingId: string | undefined;
    speakerLabel: unknown;
    name: unknown;
  }) => Promise<SaveSpeakerMappingResult>;
  retryMeeting?: (input: {
    meetingId: string | undefined;
  }) => Promise<RetryMeetingResult>;
  regenerateSummary?: (input: {
    meetingId: string | undefined;
  }) => Promise<RegenerateSummaryResult>;
};

export async function handleMeetingDetailAction(
  input: { formData: FormData; meetingId: string | undefined },
  handlers: MeetingDetailActionHandlers = {},
): Promise<MeetingDetailActionResult> {
  const intent = input.formData.get("_intent");

  if (!isMeetingDetailActionIntent(intent)) {
    return {
      type: "data",
      data: {
        ok: false,
        intent: "update-title",
        error: "Choose a valid meeting action.",
      },
      status: 400,
    };
  }

  try {
    if (intent === "delete-meeting") {
      await (handlers.deleteMeetingAndArtifacts ?? deleteMeetingAndArtifacts)({
        meetingId: input.meetingId,
      });

      return { type: "redirect", to: "/" };
    }

    if (intent === "save-speaker-mapping") {
      const result = await (handlers.saveSpeakerMapping ?? saveSpeakerMapping)({
        meetingId: input.meetingId,
        speakerLabel: input.formData.get("speakerLabel"),
        name: input.formData.get("name"),
      });

      return {
        type: "data",
        data: {
          ok: true,
          intent: "save-speaker-mapping",
          speakerLabel: result.speakerLabel,
          name: result.name,
        },
      };
    }

    if (intent === "retry-meeting") {
      const result = await (handlers.retryMeeting ?? retryMeeting)({
        meetingId: input.meetingId,
      });

      return {
        type: "data",
        data: {
          ok: true,
          intent: "retry-meeting",
          resumeFromStage: result.resumeFromStage,
        },
      };
    }

    if (intent === "regenerate-summary") {
      await (handlers.regenerateSummary ?? regenerateSummary)({
        meetingId: input.meetingId,
      });

      return {
        type: "data",
        data: { ok: true, intent: "regenerate-summary" },
      };
    }

    const result = await (handlers.updateMeetingTitle ?? updateMeetingTitle)({
      meetingId: input.meetingId,
      title: input.formData.get("title"),
    });

    return {
      type: "data",
      data: {
        ok: true,
        intent: "update-title",
        title: result.title,
      },
    };
  } catch (error) {
    if (error instanceof MeetingMutationError) {
      return {
        type: "data",
        data: {
          ok: false,
          intent,
          error: error.message,
          ...(intent === "save-speaker-mapping"
            ? {
                speakerLabel: stringifyFormValue(
                  input.formData.get("speakerLabel"),
                ),
              }
            : {}),
        },
        status: error.status,
      };
    }

    if (intent === "delete-meeting") {
      return {
        type: "data",
        data: {
          ok: false,
          intent: "delete-meeting",
          error: "Could not delete this meeting. Please try again.",
        },
        status: 500,
      };
    }

    if (intent === "save-speaker-mapping") {
      return {
        type: "data",
        data: {
          ok: false,
          intent: "save-speaker-mapping",
          error: "Could not save this speaker mapping. Please try again.",
          speakerLabel: stringifyFormValue(input.formData.get("speakerLabel")),
        },
        status: 500,
      };
    }

    if (intent === "retry-meeting") {
      return {
        type: "data",
        data: {
          ok: false,
          intent: "retry-meeting",
          error: "Could not queue this retry. Please try again.",
        },
        status: 500,
      };
    }

    if (intent === "regenerate-summary") {
      return {
        type: "data",
        data: {
          ok: false,
          intent: "regenerate-summary",
          error: "Could not queue summary regeneration. Please try again.",
        },
        status: 500,
      };
    }

    throw error;
  }
}

function isMeetingDetailActionIntent(
  intent: FormDataEntryValue | null,
): intent is MeetingDetailActionIntent {
  return (
    intent === "delete-meeting" ||
    intent === "regenerate-summary" ||
    intent === "retry-meeting" ||
    intent === "save-speaker-mapping" ||
    intent === "update-title"
  );
}

function stringifyFormValue(value: FormDataEntryValue | null) {
  return typeof value === "string" ? value : undefined;
}
