import type { ReactNode } from "react";
import type { IndexIconKey } from "../../data/indexSections";
import { LogoOutlook, LogoTwilio, LogoWhatsApp, LogoLinkedIn, LogoTelegram } from "./BrandLogos";
import { adminIcon, resolveNavIconSrc } from "./navIconImages";

export type IconSize = "xs" | "sm" | "md" | "lg";

const SIZE_CLASS: Record<IconSize, string> = {
  xs: "h-3.5 w-3.5",
  sm: "h-4 w-4",
  md: "h-5 w-5",
  lg: "h-6 w-6",
};

interface IconProps {
  size?: IconSize;
  className?: string;
}

function Svg({
  size = "sm",
  className = "",
  children,
}: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      className={`${SIZE_CLASS[size]} shrink-0 ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function IconPaperclip({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l7.88-7.88" />
    </Svg>
  );
}

export function IconBook({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </Svg>
  );
}

/** Open book — User Manual. */
export function IconBookOpen({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M12 7v14" />
      <path d="M3 6a3 3 0 0 1 3-3h6a3 3 0 0 1 3 3v14a3 3 0 0 0-3-3H6a3 3 0 0 0-3 3V6z" />
      <path d="M21 6a3 3 0 0 0-3-3h-6a3 3 0 0 0-3 3v14a3 3 0 0 1 3-3h6a3 3 0 0 1 3 3V6z" />
    </Svg>
  );
}

/** Closed book — FAQ. */
export function IconBookClosed({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
      <path d="M8 7h8M8 11h8M8 15h5" />
    </Svg>
  );
}

/** Gearbox — Settings. */
export function IconGear({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M12 15.5A3.5 3.5 0 1 0 12 8.5a3.5 3.5 0 0 0 0 7z" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.604.852.997 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </Svg>
  );
}

/** Cargo ship — CNF / FOB incoterms tool. */
export function IconShip({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M2 18h20" />
      <path d="M4 18l3-8h10l3 8" />
      <path d="M7 10l2-4h6l2 4" />
      <path d="M12 6V3" />
      <path d="M8 18v2M12 18v2M16 18v2" />
    </Svg>
  );
}

export function IconList({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
    </Svg>
  );
}

export function IconSearch({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </Svg>
  );
}

export function IconTable({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 10h18M9 4v16" />
    </Svg>
  );
}

export function IconUsers({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </Svg>
  );
}

export function IconHeart({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z" />
    </Svg>
  );
}

export function IconPhone({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.08 4.18 2 2 0 0 1 4.06 2h3a2 2 0 0 1 2 1.72c.12.86.3 1.7.54 2.5a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.58-1.06a2 2 0 0 1 2.11-.45c.8.24 1.64.42 2.5.54A2 2 0 0 1 22 16.92z" />
    </Svg>
  );
}

export function IconPhoneMissed({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M14 5l4 4m0-4-4 4" />
      <path d="M8.5 8.5a5 5 0 0 0 7.07 7.07l1.42-1.42" />
      <path d="M2 16.92v3a2 2 0 0 0 2.18 2 15.8 15.8 0 0 0 6.56-1.4" />
    </Svg>
  );
}

export function IconXCircle({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <circle cx="12" cy="12" r="10" />
      <path d="M15 9l-6 6M9 9l6 6" />
    </Svg>
  );
}

export function IconMessage({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </Svg>
  );
}

export function IconTemplate({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
    </Svg>
  );
}

export function IconInbox({ size, className }: IconProps) {
  /** Classic envelope — used for Mail / Inbox. */
  return (
    <Svg size={size} className={className}>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="M22 7l-10 7L2 7" />
    </Svg>
  );
}

export function IconMail({ size, className }: IconProps) {
  /** Official Microsoft Outlook brand logo for Mail. */
  return <LogoOutlook size={size} className={className} />;
}

export function IconMailStack({ size, className }: IconProps) {
  /** Stacked envelopes — Email Activity. */
  return (
    <Svg size={size} className={className}>
      <rect x="6" y="3" width="15" height="11" rx="1.5" />
      <path d="M21 5.2 13.5 10 6 5.2" />
      <rect x="2" y="9" width="15" height="12" rx="1.5" />
      <path d="M17 11.5 9.5 16.5 2 11.5" />
    </Svg>
  );
}

export function IconCalendar({ size, className }: IconProps) {
  /** Calendar — Client History timeline. */
  return (
    <Svg size={size} className={className}>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
      <path d="M8 14h.01M12 14h.01M16 14h.01M8 17h.01M12 17h.01" />
    </Svg>
  );
}

export function IconSend({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M22 2 11 13" />
      <path d="M22 2 15 22l-4-9-9-4 20-7z" />
    </Svg>
  );
}

export function IconDraft({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
    </Svg>
  );
}

export function IconTrash({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
    </Svg>
  );
}

export function IconArchive({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <rect x="2" y="3" width="20" height="5" rx="1" />
      <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
      <path d="M10 12h4" />
    </Svg>
  );
}

export function IconActivity({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </Svg>
  );
}

export function IconTag({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
      <circle cx="7" cy="7" r="1.5" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconExternal({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <path d="M15 3h6v6M10 14 21 3" />
    </Svg>
  );
}

export function IconCall({ size, className }: IconProps) {
  /** Official Twilio brand logo for Calls. */
  return <LogoTwilio size={size} className={className} />;
}

export function IconQuote({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6M8 13h2M8 17h8" />
    </Svg>
  );
}

export function IconRobot({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <rect x="3" y="8" width="18" height="12" rx="2" />
      <path d="M12 8V5M8 5h8M9 14h.01M15 14h.01" />
    </Svg>
  );
}

export function IconSparkles({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M12 3l1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5L12 3z" />
      <path d="M19 15l.75 2.25L22 18l-2.25.75L19 21l-.75-2.25L16 18l2.25-.75L19 15z" />
    </Svg>
  );
}

export function IconChart({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M3 3v18h18" />
      <path d="M7 16l4-6 4 3 5-8" />
    </Svg>
  );
}

export function IconSettings({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
    </Svg>
  );
}

export function IconRefresh({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </Svg>
  );
}

export function IconSignOut({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="M16 17l5-5-5-5M21 12H9" />
    </Svg>
  );
}

export function IconSun({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </Svg>
  );
}

export function IconMoon({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M21 14.5A8.5 8.5 0 0 1 9.5 3 7 7 0 1 0 21 14.5z" />
    </Svg>
  );
}

export function IconBell({ size, className }: IconProps) {
  return (
    <svg
      className={`${SIZE_CLASS[size ?? "sm"]} shrink-0 ${className}`}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22Zm7-5-1.6-1.6V10a5.4 5.4 0 0 0-4-5.23V4a1.4 1.4 0 0 0-2.8 0v.77A5.4 5.4 0 0 0 6.6 10v5.4L5 17a.9.9 0 0 0 .64 1.54h12.72A.9.9 0 0 0 19 17Z" />
    </svg>
  );
}

export function IconChevronDown({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M6 9l6 6 6-6" />
    </Svg>
  );
}

export function IconChevronRight({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M9 18l6-6-6-6" />
    </Svg>
  );
}

export function IconUser({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
    </Svg>
  );
}

export function IconFollowUp({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </Svg>
  );
}

export function IconPlus({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  );
}

export function IconUpload({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M17 8l-5-5-5 5M12 3v12" />
    </Svg>
  );
}

export function IconDownload({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M7 10l5 5 5-5M12 15V3" />
    </Svg>
  );
}

export function IconCheck({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M20 6 9 17l-5-5" />
    </Svg>
  );
}

export function IconX({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M18 6 6 18M6 6l12 12" />
    </Svg>
  );
}

export function IconEdit({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
    </Svg>
  );
}

export function IconCheckSquare({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M8 12l3 3 5-6" />
    </Svg>
  );
}

export function IconSave({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
      <path d="M17 21v-8H7v8M7 3v5h8" />
    </Svg>
  );
}

export function IconReply({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M9 17 4 12l5-5" />
      <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
    </Svg>
  );
}

export function IconFilter({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" />
    </Svg>
  );
}

/** Official WhatsApp brand logo (colored). */
export function IconWhatsApp({ size, className }: IconProps) {
  return <LogoWhatsApp size={size} className={className} />;
}

/** Telegram brand logo (colored). */
export function IconTelegram({ size, className }: IconProps) {
  return <LogoTelegram size={size} className={className} />;
}

/** Official Microsoft Outlook brand logo (colored). */
export function IconOutlook({ size, className }: IconProps) {
  return <LogoOutlook size={size} className={className} />;
}

/** Official Twilio brand logo (colored). */
export function IconTwilio({ size, className }: IconProps) {
  return <LogoTwilio size={size} className={className} />;
}

const MAIL_SUB_ICON_COLORS: Record<string, string> = {
  inbox: "", // Outlook brand logo
  sent: "text-blue-400",
  drafts: "text-amber-400",
  trash: "text-red-400",
  archive: "text-violet-400",
  activity: "text-cyan-400",
  "email-templates": "text-indigo-400",
  "personalized-emails": "text-fuchsia-400",
};

const LABEL_TAG_PALETTE = [
  "text-rose-400",
  "text-orange-400",
  "text-lime-400",
  "text-teal-400",
  "text-fuchsia-400",
  "text-yellow-400",
  "text-pink-400",
  "text-emerald-400",
] as const;

function mailSubIconClass(navId: string, className: string): string {
  if (className.includes("text-white")) return "text-white";
  return MAIL_SUB_ICON_COLORS[navId] ?? className;
}

function labelTagIconClass(navId: string, className: string): string {
  if (className.includes("text-white")) return "text-white";
  if (navId.startsWith("label-linkedin:")) return "";
  const idPart = navId.split(":")[1];
  const id = Number.parseInt(idPart ?? "0", 10);
  return LABEL_TAG_PALETTE[Number.isFinite(id) ? id % LABEL_TAG_PALETTE.length : 0];
}

function NavImageIcon({
  src,
  size = "sm",
  className = "",
}: {
  src: string;
  size?: IconSize;
  className?: string;
}) {
  return (
    <img
      src={src}
      alt=""
      aria-hidden
      className={`${SIZE_CLASS[size]} shrink-0 object-contain ${className}`}
    />
  );
}

/** Sidebar footer avatar — crops the provided admin artwork to the circular badge. */
export function AdminUserIcon({ className = "" }: { className?: string }) {
  return (
    <div
      className={`h-8 w-8 shrink-0 overflow-hidden rounded-full ${className}`}
      aria-hidden
    >
      <img
        src={adminIcon}
        alt=""
        className="h-8 w-auto max-w-none object-left"
      />
    </div>
  );
}

export function NavIcon({
  navId,
  label,
  size = "sm",
  className = "text-slate-400",
}: {
  navId: string;
  label?: string;
  size?: IconSize;
  className?: string;
}) {
  const imageSrc = resolveNavIconSrc(navId, label);
  if (imageSrc) {
    return <NavImageIcon src={imageSrc} size={size} className={className} />;
  }

  const props = { size, className };

  if (navId === "indexes") return <IconList {...props} />;
  if (navId === "user-manual")
    return <IconBookOpen size={size} className="text-amber-400" />;
  if (navId === "whatsapp-templates")
    return <IconTemplate size={size} className="text-violet-400" />;
  if (navId === "whatsapp-activity")
    return <IconActivity size={size} className="text-emerald-400" />;
  if (navId === "whatsapp-inbox" || navId.startsWith("whatsapp"))
    return <LogoWhatsApp size={size} />;
  if (navId === "telegram-templates")
    return <IconTemplate size={size} className="text-sky-400" />;
  if (navId === "telegram-mobile" || navId.startsWith("telegram"))
    return <LogoTelegram size={size} />;
  if (navId === "leads") return <IconSearch {...props} />;
  if (navId === "data-synthesis") {
    const emojiSize = size === "xs" ? "text-xs" : size === "md" ? "text-base" : "text-sm";
    return (
      <span className={`inline-flex shrink-0 leading-none ${emojiSize}`} aria-hidden>
        🧩
      </span>
    );
  }
  if (navId === "target-workspace") {
    const emojiSize = size === "xs" ? "text-xs" : size === "md" ? "text-base" : "text-sm";
    return (
      <span className={`inline-flex shrink-0 leading-none ${emojiSize}`} aria-hidden>
        🎯
      </span>
    );
  }
  if (navId === "table" || navId === "all")
    return <IconTable size={size} className="text-emerald-400" />;
  if (navId === "master")
    return <IconTable size={size} className="text-emerald-400" />;
  if (navId === "old_clients") return <IconUsers {...props} />;
  if (navId === "incomplete_archives") return <IconArchive {...props} />;
  if (navId === "sales_interested_clients") return <IconHeart {...props} />;
  if (navId === "interested_clients") return <IconFollowUp {...props} />;
  if (navId === "not_interested_clients") return <IconXCircle {...props} />;
  if (navId === "not_received_call_clients") return <IconPhoneMissed {...props} />;
  if (navId === "whatsapp-mobile") return <IconWhatsApp {...props} />;
  if (navId === "telegram-mobile") return <IconTelegram {...props} />;
  if (navId === "hyperstore_targeted" || navId === "targeted_distributor" || navId === "targeted_client" || navId === "khalid_focused_sales")
    return <IconSearch {...props} />;
  if (navId.startsWith("assigned:")) return <IconUser {...props} />;
  if (navId === "inbox") return <LogoOutlook size={size} />;
  if (navId === "sent")
    return <IconSend size={size} className={mailSubIconClass(navId, className)} />;
  if (navId === "drafts")
    return <IconDraft size={size} className={mailSubIconClass(navId, className)} />;
  if (navId === "trash")
    return <IconTrash size={size} className={mailSubIconClass(navId, className)} />;
  if (navId === "archive")
    return <IconArchive size={size} className={mailSubIconClass(navId, className)} />;
  if (navId === "activity")
    return <IconMailStack size={size} className={mailSubIconClass(navId, className)} />;
  if (navId === "email-templates")
    return <IconTemplate size={size} className={mailSubIconClass(navId, className)} />;
  if (navId === "personalized-emails")
    return <IconSparkles size={size} className={mailSubIconClass(navId, className)} />;
  if (navId.startsWith("label-linkedin:")) return <LogoLinkedIn size={size} />;
  if (navId.startsWith("label:"))
    return <IconTag size={size} className={labelTagIconClass(navId, className)} />;
  if (navId === "mail") return <LogoOutlook size={size} />;
  if (navId === "calls") return <LogoTwilio size={size} />;
  if (navId === "ai-sales-agent") return <IconRobot size={size} className="text-cyan-400" />;
  if (navId === "ai-train")
    return <IconBookOpen size={size} className="text-violet-400" />;
  if (navId === "ai") return <IconSparkles size={size} className="text-emerald-400" />;
  if (navId === "others") return <IconList size={size} className="text-slate-400" />;
  if (navId === "client-history")
    return <IconCalendar size={size} className="text-sky-400" />;
  if (navId === "quotation-agent")
    return <IconShip size={size} className="text-cyan-400" />;
  if (navId === "catalogue" || navId.startsWith("catalogue-"))
    return <IconBook size={size} className="text-emerald-400" />;
  if (navId === "chatbot") return <IconRobot {...props} />;
  if (navId === "helpful-guidance")
    return <IconBookOpen size={size} className="text-amber-400" />;
  if (navId === "sales-assistant")
    return <IconBookClosed size={size} className="text-violet-400" />;
  if (navId === "ai-mode") return <IconSparkles {...props} />;
  if (navId === "kpi") return <IconChart {...props} />;
  if (navId === "users") return <IconUser {...props} />;
  if (navId === "settings")
    return <IconGear size={size} className="text-orange-400" />;

  return <LogoOutlook size={size} />;
}

export function IndexSectionIcon({
  sectionNumber,
  size = "md",
  className = "text-emerald-400",
}: {
  sectionNumber: number;
  size?: IconSize;
  className?: string;
}) {
  const map: Record<number, ReactNode> = {
    1: <LogoWhatsApp size={size} />,
    2: <IconTable size={size} className={className} />,
    3: <LogoOutlook size={size} />,
    4: <LogoOutlook size={size} />,
    5: <LogoTwilio size={size} />,
    6: <IconQuote size={size} className={className} />,
    7: <IconRobot size={size} className={className} />,
    8: <IconSparkles size={size} className={className} />,
    9: <IconChart size={size} className={className} />,
    10: <IconUser size={size} className={className} />,
  };
  return map[sectionNumber] ?? <IconList size={size} className={className} />;
}

export function IndexIcon({
  name,
  size = "md",
  className = "text-slate-500",
}: {
  name: IndexIconKey;
  size?: IconSize;
  className?: string;
}) {
  const props = { size, className };
  switch (name) {
    case "search":
      return <IconSearch {...props} />;
    case "table":
      return <IconTable {...props} />;
    case "users":
      return <IconUsers {...props} />;
    case "user":
      return <IconUser {...props} />;
    case "heart":
      return <IconHeart {...props} />;
    case "phone":
      return <IconPhone {...props} />;
    case "x-circle":
      return <IconXCircle {...props} />;
    case "message":
      return <LogoWhatsApp size={size} />;
    case "template":
      return <IconTemplate {...props} />;
    case "inbox":
      return <LogoOutlook size={size} />;
    case "activity":
      return <IconActivity {...props} />;
    case "mail":
      return <LogoOutlook size={size} />;
    case "mail-stack":
      return <IconMailStack {...props} />;
    case "calendar":
      return <IconCalendar {...props} />;
    case "call":
      return <LogoTwilio size={size} />;
    case "robot":
      return <IconRobot {...props} />;
    case "sparkles":
      return <IconSparkles {...props} />;
    case "chart":
      return <IconChart {...props} />;
    case "quote":
      return <IconQuote {...props} />;
    case "settings":
      return <IconSettings {...props} />;
    default:
      return <IconList {...props} />;
  }
}

export function IconEye({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  );
}

export function IconCopy({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </Svg>
  );
}


