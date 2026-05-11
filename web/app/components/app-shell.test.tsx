import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router";
import { AppShell, DesktopSidebar, type AppShellSidebar } from "./app-shell";

const sectionSidebar: AppShellSidebar = {
  kind: "sections",
  ariaLabel: "Meeting sections",
  items: [
    { defaultActive: true, icon: "sliders", label: "Summary", to: "#overview" },
    { icon: "file", label: "Transcript", to: "#transcript" },
  ],
};

function renderAppShellAt(path: string) {
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: <AppShell />,
        children: [
          { index: true, element: <div>Home</div> },
          { path: "meetings/:meetingId", element: <div>Meeting detail</div> },
        ],
      },
    ],
    { initialEntries: [path] },
  );

  return renderToStaticMarkup(<RouterProvider router={router} />);
}

describe("DesktopSidebar", () => {
  test("renders compact meeting section navigation instead of the global app sidebar", () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <DesktopSidebar sidebar={sectionSidebar} />
      </MemoryRouter>,
    );

    expect(markup).toContain('aria-label="Meeting sections"');
    expect(markup).toContain("#overview");
    expect(markup).toContain("#transcript");
    expect(markup).toContain("Summary");
    expect(markup).toContain('aria-current="location"');
    expect(markup).toContain("Transcript");
    expect(markup).not.toContain("New Meeting");
  });

  test("renders a flat list of summary anchor items in the meeting section navigation", () => {
    const markup = renderAppShellAt(
      "/meetings/00000000-0000-4000-8000-000000000123",
    );

    expect(markup).toContain('aria-label="Meeting sections"');
    expect(markup).toContain("#overview");
    expect(markup).toContain("#summary-action-items");
    expect(markup).toContain("#summary-decisions");
    expect(markup).toContain("#summary-open-questions");
    expect(markup).toContain("#transcript");
    expect(markup).toContain("Summary");
    expect(markup).toContain("Action items");
    expect(markup).toContain("Decisions");
    expect(markup).toContain("Questions");
    expect(markup).toContain("Transcript");
    expect(markup).not.toContain("#processing");
    expect(markup).not.toContain("#speakers");
    expect(markup).not.toContain("#key-moments");
    expect(markup).not.toContain("#export");
    expect(markup).not.toContain(">Export</span>");
  });

  test("default sidebar renders logo-only header and functional nav items", () => {
    const markup = renderAppShellAt("/");

    expect(markup).toContain('aria-label="Sluško home"');
    expect(markup).toContain('aria-label="Main navigation"');
    expect(markup).toContain("Home");
    expect(markup).toContain("Meetings");
    expect(markup).toContain("Search");
    expect(markup).not.toContain("Speakers");
    expect(markup).not.toContain("Templates");
    expect(markup).not.toContain("Settings");
    expect(markup).not.toContain("Storage");
    expect(markup).toContain("Atila");
  });
});
