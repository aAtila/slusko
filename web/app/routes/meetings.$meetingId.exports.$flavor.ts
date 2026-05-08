import {
  createMeetingExportFilename,
  renderMeetingMarkdownExport,
  type MeetingExportFlavor,
} from "~/lib/meeting-export";
import { loadMeetingDetailRouteData } from "~/lib/meetings-list.server";
import type { Route } from "./+types/meetings.$meetingId.exports.$flavor";

type MeetingExportResourceLoaderDeps = {
  loadMeetingDetailRouteData: typeof loadMeetingDetailRouteData;
};

const validFlavors: ReadonlySet<MeetingExportFlavor> = new Set([
  "summary",
  "full",
]);

export function createMeetingExportResourceLoader(
  deps: MeetingExportResourceLoaderDeps,
) {
  return async function meetingExportResourceLoader({
    params,
    request,
  }: Pick<Route.LoaderArgs, "params" | "request">): Promise<Response> {
    const flavor = params.flavor;

    if (!isMeetingExportFlavor(flavor)) {
      throw new Response("Not Found", { status: 404 });
    }

    const routeData = await deps.loadMeetingDetailRouteData(params.meetingId);
    const markdown = renderMeetingMarkdownExport(routeData, flavor);
    const filename = createMeetingExportFilename(routeData);
    const download = new URL(request.url).searchParams.get("download") === "1";
    const disposition = download ? "attachment" : "inline";

    return new Response(markdown, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `${disposition}; filename="${filename}"`,
        "Content-Type": "text/markdown; charset=utf-8",
      },
    });
  };
}

export const loader = createMeetingExportResourceLoader({
  loadMeetingDetailRouteData,
});

function isMeetingExportFlavor(
  flavor: string | undefined,
): flavor is MeetingExportFlavor {
  return (
    flavor !== undefined && validFlavors.has(flavor as MeetingExportFlavor)
  );
}
