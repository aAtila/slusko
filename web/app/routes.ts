import { index, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("api/meetings", "routes/api.meetings.ts"),
] satisfies RouteConfig;
