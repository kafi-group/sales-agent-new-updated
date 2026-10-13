import {
  IconBell,
  IconGear,
  IconRefresh,
  IconSignOut,
  IconUser,
  AdminUserIcon,
} from "./icons/AppIcons";
import { ThemeToggle } from "./ThemeToggle";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { client, type AppUser } from "../api/client";
import { displayDashboardUserLabel } from "../utils/displayUserName";
import {
  getNotificationMode,
  getNotificationPermission,
  requestNotificationPermission,
  setNotificationMode,
  subscribeNotificationPrefs,
  unlockNotificationAudio,
  type NotificationMode,
} from "../utils/notify";
import {
  loadNarratorPrefs,
  saveNarratorPrefs,
  type NarratorGender,
  type NarratorPause,
  type NarratorPrefs,
  type NarratorSpeed,
} from "../utils/narratorPrefs";

interface AppTopActionsProps {
  onRefresh?: () => void;
  onOpenSettings?: () => void;
  onLogout?: () => void;
  /** Compact strip for the mobile header. */
  compact?: boolean;
  userLabel?: string;
  userRole?: string;
  onReconnectDb?: () => void;
  reconnectingDb?: boolean;
}

const MODE_OPTIONS: { value: NotificationMode; label: string; hint: string }[] = [
  {
    value: "popup_sound",
    label: "Popup + sound",
    hint: "In-app popup with alert chime",
  },
  {
    value: "popup_voiceover",
    label: "Popup + voiceover",
    hint: "In-app popup with spoken alert",
  },
  {
    value: "handsfree_email",
    label: "Hands-free email reader",
    hint: "Asks to read new emails aloud; say yes/ha parho or no/nahi",
  },
  {
    value: "off",
    label: "No popup or voiceover",
    hint: "Silent — no popup, sound, or speech",
  },
];

export function AppTopActions({
  onRefresh: _onRefresh,
  onOpenSettings,
  onLogout,
  compact = false,
  userLabel: propUserLabel,
  userRole: propUserRole,
  onReconnectDb,
  reconnectingDb = false,
}: AppTopActionsProps) {
  const {
    user,
    isAdmin,
    impersonating,
    impersonatorLabel,
    switchToUser,
    switchBackToAdmin,
  } = useAuth();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [switchMenuOpen, setSwitchMenuOpen] = useState(false);
  const [switchUsers, setSwitchUsers] = useState<AppUser[]>([]);
  const [switchBusy, setSwitchBusy] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);

  const [mode, setMode] = useState<NotificationMode>(() => getNotificationMode());
  const [notifPermission, setNotifPermission] = useState(getNotificationPermission());
  const [narrator, setNarrator] = useState<NarratorPrefs>(() => loadNarratorPrefs());
  const panelRef = useRef<HTMLDivElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);

  const displayName = propUserLabel || displayDashboardUserLabel(user) || "User";
  const displayRole = propUserRole || user?.role || "admin";

  useEffect(() => {
    return subscribeNotificationPrefs(() => setMode(getNotificationMode()));
  }, []);

  useEffect(() => {
    if (!isAdmin || impersonating) {
      setSwitchUsers([]);
      return;
    }
    client
      .listUsers()
      .then((rows) =>
        setSwitchUsers(rows.filter((u) => u.is_active && u.role !== "admin")),
      )
      .catch(() => setSwitchUsers([]));
  }, [isAdmin, impersonating]);

  useEffect(() => {
    if (!settingsOpen && !switchMenuOpen) return;

    function onPointerDown(event: MouseEvent) {
      if (settingsOpen && panelRef.current && !panelRef.current.contains(event.target as Node)) {
        setSettingsOpen(false);
      }
      if (switchMenuOpen && userMenuRef.current && !userMenuRef.current.contains(event.target as Node)) {
        setSwitchMenuOpen(false);
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setSettingsOpen(false);
        setSwitchMenuOpen(false);
      }
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [settingsOpen, switchMenuOpen]);

  function chooseMode(next: NotificationMode) {
    unlockNotificationAudio();
    setNotificationMode(next);
    setMode(next);
    if (next === "handsfree_email" && typeof navigator !== "undefined" && navigator.mediaDevices?.getUserMedia) {
      void navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
        stream.getTracks().forEach((t) => t.stop());
      }).catch(() => {
        /* user can allow mic later when listening starts */
      });
    }
  }

  async function enableDesktopNotifications() {
    unlockNotificationAudio();
    const result = await requestNotificationPermission();
    setNotifPermission(result);
  }

  const iconBtn =
    "relative inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800 hover:text-slate-100 transition";

  return (
    <div className="relative flex items-center gap-1.5" ref={panelRef}>
      <button
        type="button"
        className={iconBtn}
        title="Notification settings"
        aria-label="Notification settings"
        aria-expanded={settingsOpen}
        onClick={() => {
          unlockNotificationAudio();
          setSettingsOpen((open) => !open);
        }}
      >
        <IconBell size="sm" />
      </button>

      <ThemeToggle compact />

      {onReconnectDb && (
        <button
          type="button"
          className={iconBtn}
          title="Reconnect database (fix empty contacts / WhatsApp / email)"
          aria-label="Reconnect database"
          disabled={reconnectingDb}
          onClick={onReconnectDb}
        >
          <IconRefresh size="sm" className={reconnectingDb ? "animate-spin" : undefined} />
        </button>
      )}

      {onOpenSettings && (
        <button
          type="button"
          className={iconBtn}
          title="Settings"
          aria-label="Settings"
          onClick={onOpenSettings}
        >
          <IconGear size="sm" />
        </button>
      )}

      {onLogout && (
        <button
          type="button"
          className={iconBtn}
          title="Sign out"
          aria-label="Sign out"
          onClick={onLogout}
        >
          <IconSignOut size="sm" />
        </button>
      )}

      {/* Mr. Khalid (admin) User Profile pill on top right */}
      {(user || propUserLabel) && (
        <div className="relative flex items-center ml-1" ref={userMenuRef}>
          <div className="flex items-center gap-2 pl-2 pr-2.5 py-1 rounded-lg bg-slate-900 border border-slate-700/80 text-xs shadow-sm">
            {isAdmin ? (
              <AdminUserIcon className="h-6 w-6 shrink-0" />
            ) : (
              <div className="h-6 w-6 rounded-full bg-slate-800 flex items-center justify-center text-slate-400">
                <IconUser size="xs" />
              </div>
            )}
            <div className="flex flex-col text-left leading-tight min-w-0 max-w-[130px]">
              <span className="text-xs font-semibold text-slate-200 truncate">
                {displayName}
              </span>
              <span className="text-[10px] text-slate-400 capitalize leading-none truncate mt-0.5">
                {impersonating ? `(Admin: ${impersonatorLabel})` : displayRole}
              </span>
            </div>
            {isAdmin ? (
              <button
                type="button"
                title={impersonating ? "Return to admin" : "Switch user"}
                aria-label={impersonating ? "Return to admin" : "Switch user"}
                disabled={switchBusy}
                onClick={() => {
                  if (impersonating) {
                    setSwitchBusy(true);
                    setSwitchError(null);
                    void switchBackToAdmin().catch((e) => {
                      setSwitchError(
                        e instanceof Error ? e.message : "Could not switch back",
                      );
                      setSwitchBusy(false);
                    });
                    return;
                  }
                  setSwitchMenuOpen((open) => !open);
                }}
                className="shrink-0 rounded p-1 text-emerald-400 hover:bg-emerald-500/15 hover:text-emerald-300 disabled:opacity-50 transition ml-0.5"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5" />
                </svg>
              </button>
            ) : null}
          </div>

          {isAdmin && switchMenuOpen && !impersonating && (
            <div className="absolute right-0 top-full mt-2 w-52 rounded-xl border border-slate-700 bg-slate-950/98 backdrop-blur shadow-2xl overflow-hidden z-50 py-1">
              <div className="px-3 py-1.5 border-b border-slate-800 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                Switch View
              </div>
              {switchUsers.length === 0 ? (
                <p className="px-3 py-2 text-xs text-slate-500">No other users</p>
              ) : (
                switchUsers.map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    disabled={switchBusy}
                    onClick={() => {
                      setSwitchBusy(true);
                      setSwitchError(null);
                      void switchToUser(u.id)
                        .then(() => setSwitchMenuOpen(false))
                        .catch((e) => {
                          setSwitchError(
                            e instanceof Error ? e.message : "Could not switch user",
                          );
                          setSwitchBusy(false);
                        });
                    }}
                    className="w-full px-3 py-2 text-left text-xs text-slate-300 hover:bg-slate-800 hover:text-white disabled:opacity-50 transition flex items-center justify-between"
                  >
                    <span className="truncate">{u.full_name || u.username}</span>
                    <span className="text-[10px] text-slate-500 capitalize ml-2">{u.role}</span>
                  </button>
                ))
              )}
              {switchError && (
                <p className="px-3 py-1.5 text-[11px] text-red-400 bg-red-950/30 border-t border-red-900/40">
                  {switchError}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {settingsOpen && (
        <div
          className={`absolute z-50 w-[min(22rem,calc(100vw-1.5rem))] rounded-xl border border-slate-700 bg-slate-950/98 backdrop-blur shadow-2xl p-4 ${
            compact ? "right-0 top-full mt-2" : "right-0 top-full mt-2"
          }`}
          role="dialog"
          aria-label="Notification settings"
        >
          <p className="text-sm font-medium text-slate-100 flex items-center gap-2">
            <IconBell size="sm" className="text-slate-400" />
            Notifications
          </p>
          <p className="text-xs text-slate-500 mt-1 mb-3">
            Applies to email, WhatsApp, and follow-up alerts. Hands-free email reader
            only drives the email read-aloud conversation; WhatsApp still gets a short voiceover.
          </p>

          <fieldset className="space-y-2">
            <legend className="sr-only">Alert style</legend>
            {MODE_OPTIONS.map((option) => {
              const selected = mode === option.value;
              return (
                <label
                  key={option.value}
                  className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 cursor-pointer transition ${
                    selected
                      ? "border-emerald-500/60 bg-emerald-500/10"
                      : "border-slate-800 bg-slate-900/60 hover:border-slate-700"
                  }`}
                >
                  <input
                    type="radio"
                    name="notification-mode"
                    className="mt-1 accent-emerald-500"
                    checked={selected}
                    onChange={() => chooseMode(option.value)}
                  />
                  <span className="min-w-0">
                    <span className="block text-sm text-slate-100">{option.label}</span>
                    <span className="block text-xs text-slate-500 mt-0.5">{option.hint}</span>
                  </span>
                </label>
              );
            })}
          </fieldset>

          <div className="mt-4 pt-3 border-t border-slate-800 space-y-3">
            <p className="text-xs font-medium text-violet-200">Narrator voice</p>
            <p className="text-[11px] text-slate-500 -mt-1">
              Email hands-free reader and WhatsApp / alert voiceovers.
            </p>
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="text-[11px] text-slate-400">Speed</span>
                <select
                  value={narrator.speed}
                  onChange={(e) =>
                    setNarrator(saveNarratorPrefs({ speed: e.target.value as NarratorSpeed }))
                  }
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-100"
                >
                  <option value="slow">Slow</option>
                  <option value="normal">Normal</option>
                  <option value="fast">Fast</option>
                </select>
              </label>
              <label className="block">
                <span className="text-[11px] text-slate-400">Voice</span>
                <select
                  value={narrator.gender}
                  onChange={(e) =>
                    setNarrator(saveNarratorPrefs({ gender: e.target.value as NarratorGender }))
                  }
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-100"
                >
                  <option value="male">Male</option>
                  <option value="female">Female</option>
                </select>
              </label>
            </div>
            <label className="block">
              <span className="text-[11px] text-slate-400">Reply pause</span>
              <select
                value={narrator.pause}
                onChange={(e) =>
                  setNarrator(saveNarratorPrefs({ pause: e.target.value as NarratorPause }))
                }
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-100"
              >
                <option value="short">Very short</option>
                <option value="normal">Normal</option>
                <option value="long">Longer</option>
              </select>
            </label>
            <label className="flex items-start gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={narrator.responseBeep}
                onChange={(e) =>
                  setNarrator(saveNarratorPrefs({ responseBeep: e.target.checked }))
                }
                className="mt-0.5 rounded border-slate-600 bg-slate-900 text-violet-500"
              />
              <span className="text-[11px] text-slate-300 leading-snug">
                Beep before I speak (signal to answer)
              </span>
            </label>
          </div>

          {notifPermission !== "unsupported" && (
            <div className="mt-4 pt-3 border-t border-slate-800">
              <p className="text-xs text-slate-400 mb-2">
                Desktop system popups (Windows / macOS), separate from in-app alerts.
              </p>
              {notifPermission === "granted" ? (
                <p className="text-xs text-emerald-400">Desktop notifications enabled</p>
              ) : (
                <button
                  type="button"
                  onClick={() => void enableDesktopNotifications()}
                  className="text-xs px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200"
                >
                  {notifPermission === "denied"
                    ? "Blocked in browser — check site settings"
                    : "Allow desktop notifications"}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
