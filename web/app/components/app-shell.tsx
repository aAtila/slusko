import {
  createContext,
  useContext,
  useEffect,
  useMemo,
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

export type AppShellChrome = {
  dropZone?: AppShellDropZone;
  primaryAction?: AppShellPrimaryAction;
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
  const [chromeOverride, setChromeOverride] = useState<AppShellChrome | null>(
    null,
  );
  const contextValue = useMemo(
    () => ({ setChromeOverride }),
    [setChromeOverride],
  );
  const dropZone = chromeOverride?.dropZone;
  const primaryAction = chromeOverride?.primaryAction ?? defaultPrimaryAction;
  const storage = chromeOverride?.storage ?? defaultStorage;

  return (
    <AppShellChromeContext.Provider value={contextValue}>
      <main
        className="min-h-screen bg-white text-[#151936]"
        onDragEnter={dropZone?.onDragEnter}
        onDragLeave={dropZone?.onDragLeave}
        onDragOver={dropZone?.onDragOver}
        onDrop={dropZone?.onDrop}
      >
        <div className="flex min-h-screen">
          <DesktopSidebar primaryAction={primaryAction} storage={storage} />
          <div className="flex min-w-0 flex-1 flex-col">
            <MobileHeader primaryAction={primaryAction} />
            <Outlet />
          </div>
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

function DesktopSidebar({
  primaryAction,
  storage,
}: {
  primaryAction: AppShellPrimaryAction;
  storage: AppShellStorageSummary;
}) {
  return (
    <aside className="hidden w-[258px] shrink-0 border-r border-[#edf0f7] bg-white px-6 py-8 lg:flex lg:flex-col">
      <Link className="flex items-center gap-3 text-lg font-semibold" to="/">
        <LogoMark />
        <span>Slusko</span>
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

function MobileHeader({
  primaryAction,
}: {
  primaryAction: AppShellPrimaryAction;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 pt-5 sm:px-6 md:px-8 lg:hidden">
      <Link className="flex min-w-0 items-center gap-3 font-semibold" to="/">
        <LogoMark />
        <span className="truncate">Slusko</span>
      </Link>
      <PrimaryAction action={primaryAction} iconOnly />
    </div>
  );
}

function SidebarNav() {
  const location = useLocation();

  return (
    <nav className="mt-9 space-y-2 text-sm font-medium text-[#151936]">
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
              className="flex items-center gap-3 rounded-lg px-3 py-3 text-[#66718c]"
              key={item.label}
            >
              <Icon name={item.icon} className="size-5" />
              {item.label}
            </div>
          );
        }

        return (
          <Link
            className={`flex items-center gap-3 rounded-lg px-3 py-3 transition ${
              isActive ? "bg-[#f2f0ff] text-[#5947f5]" : "hover:bg-[#fafbff]"
            }`}
            key={item.label}
            to={item.to}
          >
            <Icon
              name={item.icon}
              className={`size-5 ${isActive ? "" : "text-[#66718c]"}`}
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
    ? "inline-flex size-11 shrink-0 items-center justify-center rounded-lg bg-[#5947f5] text-white shadow-[0_12px_24px_rgba(89,71,245,0.2)] disabled:cursor-not-allowed disabled:opacity-60"
    : `inline-flex items-center justify-center rounded-lg bg-[#5947f5] px-4 text-sm font-semibold text-white shadow-[0_14px_30px_rgba(89,71,245,0.22)] transition hover:bg-[#4938dc] disabled:cursor-not-allowed disabled:opacity-60 ${className}`;
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
    <div className="rounded-lg border border-[#edf0f7] p-4 shadow-[0_10px_25px_rgba(17,24,39,0.03)]">
      <div className="flex items-center justify-between text-sm font-medium">
        <span>Storage</span>
        <span className="text-xs text-[#697391]">
          {storage.percentageLabel}
        </span>
      </div>
      <p className="mt-2 text-xs text-[#697391]">{storage.description}</p>
      <div className="mt-4 h-1.5 rounded-full bg-[#edf0f7]">
        <div
          className="h-full rounded-full bg-[#5947f5]"
          style={{ width: `${clampedPercentage}%` }}
        />
      </div>
    </div>
  );
}

function UserCard() {
  return (
    <div className="mt-7 border-t border-[#edf0f7] pt-6">
      <div className="flex items-center gap-3">
        <div className="flex size-11 items-center justify-center rounded-full bg-[#edf0f7] text-sm font-semibold text-[#151936]">
          AA
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">Atila</p>
          <p className="text-xs text-[#697391]">Admin</p>
        </div>
        <Icon name="chevron-down" className="ml-auto size-4 text-[#66718c]" />
      </div>
    </div>
  );
}
