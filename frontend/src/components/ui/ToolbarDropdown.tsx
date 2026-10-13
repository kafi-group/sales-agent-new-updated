import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ActionIcon, ActionVariant } from "./ActionButton";
import { IconChevronDown } from "../icons/AppIcons";

const VARIANT_CLASS: Record<ActionVariant, string> = {
  primary: "bg-emerald-600 hover:bg-emerald-500 text-white border border-emerald-500/40",
  secondary:
    "bg-slate-800 hover:bg-slate-700 text-slate-100 border border-slate-700",
  danger: "bg-red-900/60 hover:bg-red-800 text-red-100 border border-red-800/60",
  sky: "bg-sky-700 hover:bg-sky-600 text-white border border-sky-600/50",
  violet: "bg-violet-700 hover:bg-violet-600 text-white border border-violet-600/50",
  amber: "bg-amber-900/60 hover:bg-amber-800 text-amber-100 border border-amber-800/60",
  emerald:
    "bg-emerald-700 hover:bg-emerald-600 text-white border border-emerald-600/50",
  ghost:
    "bg-transparent hover:bg-slate-800 text-slate-300 border border-slate-700",
  rose: "bg-transparent hover:bg-rose-500/10 text-rose-200 border border-rose-500/40",
};

interface ToolbarDropdownProps {
  label: string;
  icon: ActionIcon;
  variant?: ActionVariant;
  menuClassName?: string;
  children: ReactNode;
}

export function ToolbarDropdown({
  label,
  icon: Icon,
  variant = "secondary",
  menuClassName = "",
  children,
}: ToolbarDropdownProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, []);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={`inline-flex items-center justify-center font-medium transition px-2.5 py-1.5 text-xs gap-1.5 rounded-lg ${VARIANT_CLASS[variant]}`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Icon size="xs" className="shrink-0 opacity-95" />
        <span>{label}</span>
        <IconChevronDown size="xs" className={`shrink-0 opacity-80 transition ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? (
        <div
          role="menu"
          className={`absolute left-0 z-40 mt-1 min-w-[200px] max-h-[min(70vh,420px)] overflow-y-auto rounded-xl border border-slate-700 bg-slate-900 py-1 shadow-xl ${menuClassName}`}
          onClick={(event) => {
            if ((event.target as HTMLElement).closest("button:not(:disabled)")) {
              setOpen(false);
            }
          }}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

interface ToolbarMenuItemProps {
  icon?: ActionIcon;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
  children: ReactNode;
  tone?: "default" | "danger" | "emerald" | "sky" | "violet";
}

export function ToolbarMenuLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
      {children}
    </div>
  );
}

export function ToolbarMenuItem({
  icon: Icon,
  disabled,
  title,
  onClick,
  children,
  tone = "default",
}: ToolbarMenuItemProps) {
  const toneClass =
    tone === "danger"
      ? "text-red-200 hover:bg-red-950/60"
      : tone === "emerald"
        ? "text-emerald-200 hover:bg-emerald-950/50"
        : tone === "sky"
          ? "text-sky-200 hover:bg-sky-950/50"
          : tone === "violet"
            ? "text-violet-200 hover:bg-violet-950/50"
            : "text-slate-200 hover:bg-slate-800";
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed ${toneClass}`}
    >
      {Icon ? <Icon size="xs" className="shrink-0 opacity-90" /> : null}
      <span className="truncate">{children}</span>
    </button>
  );
}
