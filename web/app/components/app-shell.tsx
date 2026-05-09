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

export type AppShellStorageSummary = {
  description: string;
  percentage: number;
  percentageLabel: string;
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
  storage?: AppShellStorageSummary;
};

type AppShellChromeContextValue = {
  setChromeOverride: Dispatch<SetStateAction<AppShellChrome | null>>;
};

const defaultPrimaryAction: AppShellPrimaryAction = {
  kind: "link",
  label: "New Meeting",
  to: "/",
};

const defaultStorage: AppShellStorageSummary = {
  description: "28.4 GB / 100 GB used",
  percentage: 28,
  percentageLabel: "28%",
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
      icon: "folder",
      label: "Key topics",
      to: "#summary-key-topics",
      tone: "ink",
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

const navItems: Array<
  | { disabled?: false; icon: IconName; label: string; to: string }
  | { disabled: true; icon: IconName; label: string }
> = [
  { icon: "home", label: "Home", to: "/" },
  { icon: "calendar", label: "Meetings", to: "/#meetings-list" },
  { icon: "search", label: "Search", to: "/#meetings-search" },
  { disabled: true, icon: "users", label: "Speakers" },
  { disabled: true, icon: "file", label: "Templates" },
  { disabled: true, icon: "settings", label: "Settings" },
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
  const storage = chromeOverride?.storage ?? defaultStorage;
  const desktopInsetClass =
    sidebar.kind === "sections" ? "lg:pl-[180px]" : "lg:pl-[258px]";

  return (
    <AppShellChromeContext.Provider value={contextValue}>
      <main
        className="bg-canvas text-ink"
        onDragEnter={dropZone?.onDragEnter}
        onDragLeave={dropZone?.onDragLeave}
        onDragOver={dropZone?.onDragOver}
        onDrop={dropZone?.onDrop}
      >
        <DesktopSidebar
          primaryAction={primaryAction}
          sidebar={sidebar}
          storage={storage}
        />
        <div className={`flex min-w-0 flex-col ${desktopInsetClass}`}>
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
  primaryAction,
  sidebar = defaultSidebar,
  storage,
}: {
  primaryAction: AppShellPrimaryAction;
  sidebar?: AppShellSidebar;
  storage: AppShellStorageSummary;
}) {
  if (sidebar.kind === "sections") {
    return <SectionSidebar sidebar={sidebar} />;
  }

  return (
    <aside className="border-hairline bg-canvas hidden w-[258px] border-r px-6 py-8 lg:fixed lg:top-0 lg:left-0 lg:flex lg:h-screen lg:flex-col">
      <Link
        className="text-ink flex items-center gap-3 text-lg font-medium tracking-tight"
        to="/"
      >
        <LogoMark />
        <span className="font-display text-[1.35rem] tracking-tight">
          Sluško
        </span>
      </Link>
      <PrimaryAction action={primaryAction} className="mt-10 h-12 gap-3" />
      <SidebarNav />
      <div className="mt-auto">
        <StorageCard storage={storage} />
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

function SidebarNav() {
  const location = useLocation();

  return (
    <nav className="text-ink mt-9 space-y-1 text-sm font-medium">
      {navItems.map((item) => {
        const isActive =
          item.label === "Home"
            ? location.pathname === "/"
            : item.label === "Meetings"
              ? location.pathname.startsWith("/meetings")
              : false;

        if (item.disabled) {
          return (
            <div
              className="text-ink-subtle flex items-center gap-3 rounded-lg px-3 py-2.5"
              key={item.label}
            >
              <Icon name={item.icon} className="size-5" />
              {item.label}
            </div>
          );
        }

        return (
          <Link
            className={`flex items-center gap-3 rounded-lg px-3 py-2.5 transition ${
              isActive
                ? "bg-brand-soft text-brand"
                : "text-ink-soft hover:bg-surface-sunken/60"
            }`}
            key={item.label}
            to={item.to}
          >
            <Icon
              name={item.icon}
              className={`size-5 ${isActive ? "" : "text-ink-muted"}`}
            />
            {item.label}
          </Link>
        );
      })}
    </nav>
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
    ? "inline-flex size-11 shrink-0 items-center justify-center rounded-lg bg-brand text-canvas shadow-[0_10px_24px_-8px_rgba(63,90,48,0.45)] transition hover:bg-brand-deep active:translate-y-px disabled:cursor-not-allowed disabled:opacity-60"
    : `inline-flex items-center justify-center rounded-lg bg-brand px-4 text-sm font-medium text-canvas shadow-[0_10px_24px_-8px_rgba(63,90,48,0.45)] transition hover:bg-brand-deep active:translate-y-px disabled:cursor-not-allowed disabled:opacity-60 ${className}`;
  const label = action.ariaLabel ?? action.label;

  if (action.kind === "link") {
    return (
      <Link aria-label={label} className={sharedClassName} to={action.to}>
        <Icon name="plus" className="size-5" />
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
      <Icon name="plus" className="size-5" />
      {iconOnly ? null : <span>{action.label}</span>}
    </button>
  );
}

function StorageCard({ storage }: { storage: AppShellStorageSummary }) {
  const clampedPercentage = Math.max(0, Math.min(100, storage.percentage));

  return (
    <div className="border-hairline bg-surface/60 rounded-xl border p-4">
      <div className="text-ink flex items-center justify-between text-sm font-medium">
        <span>Storage</span>
        <span className="text-ink-muted font-mono text-xs tabular-nums">
          {storage.percentageLabel}
        </span>
      </div>
      <p className="text-ink-muted mt-2 text-xs">{storage.description}</p>
      <div className="bg-hairline mt-4 h-[3px] overflow-hidden rounded-full">
        <div
          className="bg-brand h-full rounded-full"
          style={{ width: `${clampedPercentage}%` }}
        />
      </div>
    </div>
  );
}

function UserCard() {
  return (
    <div className="border-hairline -mx-6 mt-6 border-t px-6 pt-6">
      <div className="flex items-center gap-3">
        <div className="bg-brand-soft text-brand flex size-10 items-center justify-center rounded-full text-sm font-medium">
          AA
        </div>
        <div className="min-w-0">
          <p className="text-ink truncate text-sm font-medium">Atila</p>
          <p className="text-ink-muted text-xs">Admin</p>
        </div>
        <Icon name="chevron-down" className="text-ink-muted ml-auto size-4" />
      </div>
    </div>
  );
}
