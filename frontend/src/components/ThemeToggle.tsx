import { IconMoon, IconSun } from "./icons/AppIcons";
import { useTheme } from "../theme/ThemeContext";

interface ThemeToggleProps {
  className?: string;
  /** Compact icon-only control (e.g. login corner). */
  compact?: boolean;
}

export function ThemeToggle({ className = "", compact = false }: ThemeToggleProps) {
  const { theme, toggleTheme } = useTheme();
  const isLight = theme === "light";

  return (
    <button
      type="button"
      onClick={toggleTheme}
      title={isLight ? "Switch to dark mode" : "Switch to light mode"}
      aria-label={isLight ? "Switch to dark mode" : "Switch to light mode"}
      className={
        compact
          ? `inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800 hover:text-slate-100 transition ${className}`
          : `w-full flex items-center justify-between gap-2 text-sm px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 transition ${className}`
      }
    >
      {!compact && <span className="text-slate-400">Theme</span>}
      <span className="inline-flex items-center gap-1.5 shrink-0" aria-hidden>
        {isLight ? (
          <IconSun size="sm" className="text-amber-300" />
        ) : (
          <IconMoon size="sm" className="text-sky-300" />
        )}
        {!compact && (
          <span className="text-slate-200">{isLight ? "Light" : "Dark"}</span>
        )}
      </span>
    </button>
  );
}
