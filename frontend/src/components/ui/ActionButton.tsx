import type { ButtonHTMLAttributes, ComponentType, ReactNode } from "react";
import type { IconSize } from "../icons/AppIcons";

/**
 * Standard action control: recognizable icon + short label.
 * Use for toolbars, modal footers, and primary CTAs.
 * Skip for filter chips, sort headers, and pure toggles.
 */
export type ActionVariant =
  | "primary"
  | "secondary"
  | "danger"
  | "sky"
  | "violet"
  | "amber"
  | "emerald"
  | "ghost"
  | "rose";

export type ActionSize = "sm" | "md";

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

const SIZE_CLASS: Record<ActionSize, string> = {
  sm: "px-2.5 py-1.5 text-xs gap-1.5 rounded-lg",
  md: "px-3 py-2 text-sm gap-1.5 rounded-lg",
};

const ICON_SIZE: Record<ActionSize, IconSize> = {
  sm: "xs",
  md: "sm",
};

export type ActionIcon = ComponentType<{ size?: IconSize; className?: string }>;

interface ActionButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: ActionIcon;
  variant?: ActionVariant;
  size?: ActionSize;
  children: ReactNode;
  /** Extra class on the icon only */
  iconClassName?: string;
}

export function ActionButton({
  icon: Icon,
  variant = "secondary",
  size = "sm",
  children,
  className = "",
  iconClassName = "",
  type = "button",
  disabled,
  ...rest
}: ActionButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled}
      className={`inline-flex items-center justify-center font-medium transition disabled:opacity-50 ${SIZE_CLASS[size]} ${VARIANT_CLASS[variant]} ${className}`}
      {...rest}
    >
      <Icon size={ICON_SIZE[size]} className={`shrink-0 opacity-95 ${iconClassName}`} />
      <span className="truncate">{children}</span>
    </button>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: ActionIcon;
  /** Required for accessibility when there is no visible label */
  label: string;
  variant?: ActionVariant;
  size?: ActionSize;
  iconClassName?: string;
}

export function IconButton({
  icon: Icon,
  label,
  variant = "secondary",
  size = "md",
  className = "",
  iconClassName = "",
  type = "button",
  disabled,
  ...rest
}: IconButtonProps) {
  const box = size === "sm" ? "h-8 w-8" : "h-9 w-9";
  return (
    <button
      type={type}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={`inline-flex items-center justify-center rounded-lg transition disabled:opacity-50 ${box} ${VARIANT_CLASS[variant]} ${className}`}
      {...rest}
    >
      <Icon size={ICON_SIZE[size]} className={`shrink-0 ${iconClassName}`} />
    </button>
  );
}
