import {
  deleteMeetingAndArtifacts,
  MeetingMutationError,
  updateMeetingTitle,
  type DeleteMeetingResult,
  type UpdateMeetingTitleResult,
} from "./meetings-mutations.server";

export type MeetingDetailActionData =
  | { ok: true; intent: "update-title"; title: string }
  | { ok: false; intent: "delete-meeting" | "update-title"; error: string };

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
};

export async function handleMeetingDetailAction(
  input: { formData: FormData; meetingId: string | undefined },
  handlers: MeetingDetailActionHandlers = {},
): Promise<MeetingDetailActionResult> {
  const intent = input.formData.get("_intent");

  if (intent !== "delete-meeting" && intent !== "update-title") {
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

    throw error;
  }
}
