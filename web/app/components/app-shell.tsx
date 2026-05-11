import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type DragEventHandler,
  type SetStateAction,
} from "react";
import { Link, Outlet, useLocation } from "react-router";
import { Icon, LogoMark, type IconName } from "~/components/app-icons";

export type AppShellPrimaryAction =
  | {
      kind: "button";
      label: string;
      ariaLabel?: string;
      disabled?: boolean;
      onClick: () => void;
    }
  | {
      kind: "link";
      label: string;
      ariaLabel?: string;
      to: string;
    };

export type AppShellDropZone = {
  onDragEnter: DragEventHandler<HTMLElement>;
  onDragLeave: DragEventHandler<HTMLElement>;
  onDragOver: DragEventHandler<HTMLElement>;
  onDrop: DragEventHandler<HTMLElement>;
};

export type SidebarTone = "ink" | "brand" | "accent" | "warning";

export type AppShellSectionNavItem = {
  defaultActive?: boolean;
  icon: IconName;
  label: string;
  to: string;
  tone?: SidebarTone;
};

export type AppShellSidebar =
  | { kind?: "default" }
  | {
      ariaLabel: string;
      items: AppShellSectionNavItem[];
      kind: "sections";
    };

export type AppShellChrome = {
  dropZone?: AppShellDropZone;
  primaryAction?: AppShellPrimaryAction;
  sidebar?: AppShellSidebar;
};

type AppShellChromeContextValue = {
  setChromeOverride: Dispatch<SetStateAction<AppShellChrome | null>>;
};

const defaultPrimaryAction: AppShellPrimaryAction = {
  kind: "link",
  label: "New Meeting",
  to: "/",
};

const defaultSidebar: AppShellSidebar = { kind: "default" };

const meetingDetailSidebar: AppShellSidebar = {
  kind: "sections",
  ariaLabel: "Meeting sections",
  items: [
    {
      defaultActive: true,
      icon: "sliders",
      label: "Summary",
      to: "#overview",
      tone: "brand",
    },
    {
      icon: "check",
      label: "Action items",
      to: "#summary-action-items",
      tone: "accent",
    },
    {
      icon: "megaphone",
      label: "Decisions",
      to: "#summary-decisions",
      tone: "brand",
    },
    {
      icon: "alert",
      label: "Questions",
      to: "#summary-open-questions",
      tone: "warning",
    },
    { icon: "file", label: "Transcript", to: "#transcript" },
  ],
};

const AppShellChromeContext = createContext<AppShellChromeContextValue | null>(
  null,
);

const navItems: Array<{
  icon: IconName;
  label: string;
  to: string;
  tone?: SidebarTone;
}> = [
  { icon: "home", label: "Home", to: "/", tone: "brand" },
  { icon: "calendar", label: "Meetings", to: "/#meetings-list", tone: "ink" },
  { icon: "search", label: "Search", to: "/#meetings-search", tone: "ink" },
];

export function AppShell() {
  const location = useLocation();
  const [chromeOverride, setChromeOverride] = useState<AppShellChrome | null>(
    null,
  );
  const contextValue = useMemo(
    () => ({ setChromeOverride }),
    [setChromeOverride],
  );
  const dropZone = chromeOverride?.dropZone;
  const primaryAction = chromeOverride?.primaryAction ?? defaultPrimaryAction;
  const routeSidebar = location.pathname.startsWith("/meetings/")
    ? meetingDetailSidebar
    : defaultSidebar;
  const sidebar = chromeOverride?.sidebar ?? routeSidebar;

  return (
    <AppShellChromeContext.Provider value={contextValue}>
      <main
        className="bg-canvas text-ink"
        onDragEnter={dropZone?.onDragEnter}
        onDragLeave={dropZone?.onDragLeave}
        onDragOver={dropZone?.onDragOver}
        onDrop={dropZone?.onDrop}
      >
        <DesktopSidebar sidebar={sidebar} />
        <div className="flex min-w-0 flex-col lg:pl-[180px]">
          <MobileHeader primaryAction={primaryAction} />
          <Outlet />
        </div>
      </main>
    </AppShellChromeContext.Provider>
  );
}

export function useAppShellChrome(chrome: AppShellChrome) {
  const context = useContext(AppShellChromeContext);

  if (context === null) {
    throw new Error("useAppShellChrome must be used inside AppShell.");
  }

  useEffect(() => {
    context.setChromeOverride(chrome);

    return () => context.setChromeOverride(null);
  }, [chrome, context]);
}

export function DesktopSidebar({
  sidebar = defaultSidebar,
}: {
  sidebar?: AppShellSidebar;
}) {
  if (sidebar.kind === "sections") {
    return <SectionSidebar sidebar={sidebar} />;
  }

  return <DefaultSidebar />;
}

function DefaultSidebar() {
  const location = useLocation();

  return (
    <aside className="border-hairline bg-surface hidden w-[180px] border-r lg:fixed lg:top-0 lg:left-0 lg:flex lg:h-screen lg:flex-col">
      <Link
        aria-label="Sluško home"
        className="border-hairline flex h-24 items-center justify-center border-b"
        to="/"
      >
        <LogoMark />
      </Link>
      <nav
        aria-label="Main navigation"
        className="flex flex-1 flex-col gap-1 overflow-y-auto px-3 py-5 text-xs font-medium"
      >
        {navItems.map((item) => {
          const isActive =
            item.label === "Home"
              ? location.pathname === "/" && !location.hash
              : item.label === "Meetings"
                ? location.pathname.startsWith("/meetings") ||
                  location.hash === "#meetings-list"
                : location.hash === "#meetings-search";
          const tone = item.tone ?? "brand";
          const activeClass = SIDEBAR_TONE_ACTIVE_CLASS[tone];

          return (
            <Link
              aria-current={isActive ? "page" : undefined}
              className={`flex min-h-20 flex-col items-center justify-center gap-2 rounded-xl px-2 py-3 text-center transition ${
                isActive
                  ? activeClass
                  : "text-ink-muted hover:bg-surface-sunken/70 hover:text-ink-soft"
              }`}
              key={item.label}
              to={item.to}
            >
              <Icon className="size-5" name={item.icon} />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>
      <div className="mt-auto px-3 pb-5">
        <UserCard />
      </div>
    </aside>
  );
}

const SIDEBAR_TONE_ACTIVE_CLASS: Record<SidebarTone, string> = {
  ink: "bg-surface-sunken text-ink",
  brand: "bg-brand-soft text-brand",
  accent: "bg-accent-soft/70 text-accent-deep",
  warning: "bg-warning-soft/70 text-warning",
};

function useSectionScrollSpy(
  items: ReadonlyArray<AppShellSectionNavItem>,
): string | null {
  const [activeAnchor, setActiveAnchor] = useState<string | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const orderedAnchors: string[] = [];
    for (const item of itemsRef.current) {
      if (item.to.startsWith("#")) {
        orderedAnchors.push(item.to);
      }
    }

    if (orderedAnchors.length === 0) {
      return;
    }

    const visibleIds = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            visibleIds.add(entry.target.id);
          } else {
            visibleIds.delete(entry.target.id);
          }
        }

        for (const anchor of orderedAnchors) {
          if (visibleIds.has(anchor.slice(1))) {
            setActiveAnchor(anchor);
            return;
          }
        }
      },
      {
        rootMargin: "-12% 0px -65% 0px",
        threshold: [0, 0.1, 0.5, 1],
      },
    );

    const observed: Element[] = [];
    for (const anchor of orderedAnchors) {
      const element = document.getElementById(anchor.slice(1));
      if (element !== null) {
        observer.observe(element);
        observed.push(element);
      }
    }

    if (observed.length === 0) {
      return;
    }

    return () => observer.disconnect();
  }, [items]);

  return activeAnchor;
}

function SectionSidebar({
  sidebar,
}: {
  sidebar: Extract<AppShellSidebar, { kind: "sections" }>;
}) {
  const location = useLocation();
  const spyAnchor = useSectionScrollSpy(sidebar.items);
  const explicitActive = spyAnchor ?? (location.hash || null);
  const fallbackActive =
    sidebar.items.find((candidate) => candidate.defaultActive === true)?.to ??
    null;
  const effectiveActive = explicitActive ?? fallbackActive;

  return (
    <aside className="border-hairline bg-surface hidden w-[180px] border-r lg:fixed lg:top-0 lg:left-0 lg:flex lg:h-screen lg:flex-col">
      <Link
        aria-label="Sluško home"
        className="border-hairline flex h-24 items-center justify-center border-b"
        to="/"
      >
        <LogoMark />
      </Link>
      <nav
        aria-label={sidebar.ariaLabel}
        className="flex flex-1 flex-col gap-1 overflow-y-auto px-3 py-5 text-xs font-medium"
      >
        {sidebar.items.map((item) => {
          const isActive = effectiveActive === item.to;
          const tone = item.tone ?? "brand";
          const activeClass = SIDEBAR_TONE_ACTIVE_CLASS[tone];

          return (
            <Link
              aria-current={isActive ? "location" : undefined}
              className={`flex min-h-20 flex-col items-center justify-center gap-2 rounded-xl px-2 py-3 text-center transition ${
                isActive
                  ? activeClass
                  : "text-ink-muted hover:bg-surface-sunken/70 hover:text-ink-soft"
              }`}
              key={item.label}
              to={item.to}
            >
              <Icon className="size-5" name={item.icon} />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}

function MobileHeader({
  primaryAction,
}: {
  primaryAction: AppShellPrimaryAction;
}) {
  return (
    <div className="border-hairline bg-canvas flex items-center justify-between gap-3 border-b px-4 pt-5 pb-4 sm:px-6 md:px-8 lg:hidden">
      <Link className="flex min-w-0 items-center gap-3 font-medium" to="/">
        <LogoMark />
        <span className="font-display truncate text-xl tracking-tight">
          Sluško
        </span>
      </Link>
      <PrimaryAction action={primaryAction} iconOnly />
    </div>
  );
}

function PrimaryAction({
  action,
  className = "",
  iconOnly = false,
}: {
  action: AppShellPrimaryAction;
  className?: string;
  iconOnly?: boolean;
}) {
  const sharedClassName = iconOnly
    ? "meeting-primary-button meeting-primary-button--icon-only shrink-0"
    : `meeting-primary-button ${className}`;
  const label = action.ariaLabel ?? action.label;

  if (action.kind === "link") {
    return (
      <Link aria-label={label} className={sharedClassName} to={action.to}>
        <span className="meeting-primary-button__icon">
          <Icon name="plus" className="size-5" />
        </span>
        {iconOnly ? null : <span>{action.label}</span>}
      </Link>
    );
  }

  return (
    <button
      aria-label={label}
      className={sharedClassName}
      disabled={action.disabled}
      onClick={action.onClick}
      type="button"
    >
      <span className="meeting-primary-button__icon">
        <Icon name="plus" className="size-5" />
      </span>
      {iconOnly ? null : <span>{action.label}</span>}
    </button>
  );
}

function UserCard() {
  return (
    <div className="border-hairline rounded-xl border p-3 opacity-50 grayscale">
      <div className="flex items-center gap-3">
        <div className="bg-surface-sunken text-ink-muted flex size-9 items-center justify-center rounded-full text-xs font-medium">
          AA
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-ink-muted truncate text-xs font-medium">Atila</p>
          <p className="text-ink-subtle text-[10px]">Admin</p>
        </div>
      </div>
    </div>
  );
}
