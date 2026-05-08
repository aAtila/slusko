import {
  index,
  layout,
  route,
  type RouteConfig,
} from "@react-router/dev/routes";

export default [
  layout("routes/app-layout.tsx", [
    index("routes/home.tsx"),
    route("meetings/:meetingId", "routes/meetings.$meetingId.tsx"),
  ]),
  route("api/meetings", "routes/api.meetings.ts"),
] satisfies RouteConfig;
