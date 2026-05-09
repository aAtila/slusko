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
        <DesktopSidebar
          primaryAction={{ kind: "link", label: "New Meeting", to: "/" }}
          sidebar={sectionSidebar}
          storage={{
            description: "2 processed / 3 meetings",
            percentage: 66,
            percentageLabel: "66%",
          }}
        />
      </MemoryRouter>,
    );

    expect(markup).toContain('aria-label="Meeting sections"');
    expect(markup).toContain("#overview");
    expect(markup).toContain("#transcript");
    expect(markup).toContain("Summary");
    expect(markup).toContain('aria-current="location"');
    expect(markup).toContain("Transcript");
    expect(markup).not.toContain("New Meeting");
    expect(markup).not.toContain("2 processed / 3 meetings");
  });

  test("renders a flat list of summary anchor items in the meeting section navigation", () => {
    const markup = renderAppShellAt(
      "/meetings/00000000-0000-4000-8000-000000000123",
    );

    expect(markup).toContain('aria-label="Meeting sections"');
    expect(markup).toContain("#overview");
    expect(markup).toContain("#summary-key-topics");
    expect(markup).toContain("#summary-action-items");
    expect(markup).toContain("#summary-decisions");
    expect(markup).toContain("#summary-open-questions");
    expect(markup).toContain("#transcript");
    expect(markup).toContain("Summary");
    expect(markup).toContain("Key topics");
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
});
