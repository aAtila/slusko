import { data } from "react-router";
import { loadHomeMeetings } from "~/lib/meetings-list.server";

export async function loader() {
  return data(
    { meetings: await loadHomeMeetings() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
