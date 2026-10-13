import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  client,
  type EmailAttachment,
  type InboxAnalyzeResponse,
  type InboxMessageDetail,
  type InboxMessageListResponse,
  type InboxMessageSummary,
  type InboxStatus,
  type InboxThreadDetail,
  type InboxThreadListResponse,
  type InboxThreadSummary,
  type MailComposeDraft,
  type MailLabel,
  type MailLabelMessageKey,
  type AutoTrashSettings,
  type AutoTrashDailyLogDay,
} from "../api/client";
import {
  isMailLabelSection,
  mailLabelIdFromSection,
  type MailSection,
} from "../components/AppSidebar";
import { CreateLabelModal } from "../components/CreateLabelModal";
import { ComposeMailModal } from "../components/ComposeMailModal";

const DEFAULT_AUTO_TRASH: AutoTrashSettings = {
  user_id: 0,
  enabled: false,
  last_scan_at: null,
  updated_at: null,
  profile_ready: false,
  samples_seen: 0,
  last_learned_at: null,
  can_auto_trash: false,
};
import { ComposeRecipientsPickerModal } from "../components/ComposeRecipientsPickerModal";
import { buildForwardBodyHtml, forwardSubject } from "../utils/forwardMail";
import { InboxAttachmentChips } from "../components/InboxAttachmentChips";
import { AttachedFilesList } from "../components/AttachedFilesList";
import { AttachCatalogueModal } from "../components/AttachCatalogueModal";
import {
  EmailBodyEditor,
  emailBodyHasContent,
} from "../components/EmailBodyEditor";
import { capitalizeFirstLetter } from "../utils/spelling";
import { ActionButton } from "../components/ui/ActionButton";
import {
  IconArchive,
  IconBookOpen,
  IconChevronRight,
  IconFilter,
  IconInbox,
  IconPaperclip,
  IconPlus,
  IconRefresh,
  IconReply,
  IconSearch,
  IconSend,
  IconSparkles,
  IconTag,
  IconTrash,
  IconX,
} from "../components/icons/AppIcons";
import {
  buildReplyRecipients,
  hasReplyAllTargets,
} from "../utils/replyRecipients";
import {
  labelRoutingSummary,
  messageMatchesLabelKeys,
  messageMatchesLabelRules,
} from "../lib/mailLabelRules";

interface InboxPageProps {
  section: MailSection;
  onError: (message: string) => void;
  onUnreadChange?: (count: number) => void;
  onFolderCountsChange?: (counts: {
    inbox: number;
    sent: number;
    trash: number;
    junk: number;
    archive: number;
  }) => void;
  onMailExtrasChange?: () => void;
  onSelectMailSection?: (section: MailSection) => void;
  /** Open Vercel mailer compose (mailer-pied), optionally with To/Cc prefilled. */
  onOpenMailerCompose?: (opts?: { to?: string; cc?: string }) => void;
  initialThreadId?: string | null;
  initialMailboxUserId?: number | null;
  /** Asim shared mailbox (marketing/info/essence) — switched from header only. */
  activeMailboxUserId?: number | null;
  autoOpenReply?: boolean;
  onThreadOpened?: () => void;
}

const PAGE_SIZE = 50;

const TRIAGE_FILTERS: Array<{
  key: string;
  label: string;
  emoji: string;
  activeClass: string;
  inactiveClass: string;
  chipClass: string;
}> = [
  {
    key: "",
    label: "All",
    emoji: "🌐",
    activeClass: "border-cyan-400 text-white bg-cyan-600 ring-2 ring-cyan-400 shadow-md shadow-cyan-900/50 font-bold",
    inactiveClass: "border-slate-700 text-slate-200 bg-slate-800/80 hover:bg-slate-700 hover:border-slate-500",
    chipClass: "border-slate-600 text-slate-300",
  },
  {
    key: "urgent",
    label: "Urgent",
    emoji: "🚨",
    activeClass: "border-red-400 text-white bg-red-600 ring-2 ring-red-400 shadow-md shadow-red-950/60 font-bold",
    inactiveClass: "border-red-800/70 text-red-300 bg-red-950/40 hover:bg-red-900/60 hover:border-red-600",
    chipClass: "border-red-700/60 text-red-200 bg-red-950/40",
  },
  {
    key: "action_required",
    label: "Action",
    emoji: "⚡",
    activeClass: "border-amber-400 text-amber-950 bg-amber-400 ring-2 ring-amber-300 shadow-md shadow-amber-950/60 font-bold",
    inactiveClass: "border-amber-800/70 text-amber-300 bg-amber-950/40 hover:bg-amber-900/60 hover:border-amber-600",
    chipClass: "border-amber-700/60 text-amber-200 bg-amber-950/40",
  },
  {
    key: "opportunity",
    label: "Opportunity",
    emoji: "💰",
    activeClass: "border-emerald-400 text-emerald-950 bg-emerald-400 ring-2 ring-emerald-300 shadow-md shadow-emerald-950/60 font-bold",
    inactiveClass: "border-emerald-800/70 text-emerald-300 bg-emerald-950/40 hover:bg-emerald-900/60 hover:border-emerald-600",
    chipClass: "border-emerald-700/60 text-emerald-200 bg-emerald-950/40",
  },
  {
    key: "info",
    label: "Info",
    emoji: "ℹ️",
    activeClass: "border-teal-400 text-teal-950 bg-teal-400 ring-2 ring-teal-300 shadow-md shadow-teal-950/60 font-bold",
    inactiveClass: "border-teal-800/70 text-teal-300 bg-teal-950/40 hover:bg-teal-900/60 hover:border-teal-600",
    chipClass: "border-slate-600 text-slate-400 bg-slate-900/60",
  },
  {
    key: "tracking",
    label: "Tracking",
    emoji: "📦",
    activeClass: "border-sky-400 text-white bg-sky-600 ring-2 ring-sky-300 shadow-md shadow-sky-950/60 font-bold",
    inactiveClass: "border-sky-800/70 text-sky-300 bg-sky-950/40 hover:bg-sky-900/60 hover:border-sky-600",
    chipClass: "border-sky-700/60 text-sky-200 bg-sky-950/40",
  },
  {
    key: "newsletter",
    label: "Newsletter",
    emoji: "📰",
    activeClass: "border-purple-400 text-white bg-purple-600 ring-2 ring-purple-300 shadow-md shadow-purple-950/60 font-bold",
    inactiveClass: "border-purple-800/70 text-purple-300 bg-purple-950/40 hover:bg-purple-900/60 hover:border-purple-600",
    chipClass: "border-purple-700/60 text-purple-200 bg-purple-950/40",
  },
  {
    key: "invites_exhibitions",
    label: "Invites & Exhibitions",
    emoji: "🎟️",
    activeClass: "border-indigo-400 text-white bg-indigo-600 ring-2 ring-indigo-300 shadow-md shadow-indigo-950/60 font-bold",
    inactiveClass: "border-indigo-800/70 text-indigo-300 bg-indigo-950/40 hover:bg-indigo-900/60 hover:border-indigo-600",
    chipClass: "border-indigo-700/60 text-indigo-200 bg-indigo-950/40",
  },
  {
    key: "advertising",
    label: "Advertising",
    emoji: "📣",
    activeClass: "border-pink-400 text-white bg-pink-600 ring-2 ring-pink-300 shadow-md shadow-pink-950/60 font-bold",
    inactiveClass: "border-pink-800/70 text-pink-300 bg-pink-950/40 hover:bg-pink-900/60 hover:border-pink-600",
    chipClass: "border-pink-700/60 text-pink-200 bg-pink-950/40",
  },
  {
    key: "tax_notice_challan",
    label: "Tax, Notice & Challan",
    emoji: "⚖️",
    activeClass: "border-rose-400 text-white bg-rose-600 ring-2 ring-rose-300 shadow-md shadow-rose-950/60 font-bold",
    inactiveClass: "border-rose-800/70 text-rose-300 bg-rose-950/40 hover:bg-rose-900/60 hover:border-rose-600",
    chipClass: "border-rose-700/60 text-rose-200 bg-rose-950/40",
  },
];

function triageBadgeClass(category: string | null | undefined): string {
  switch ((category || "").toLowerCase()) {
    case "urgent":
      return "border-red-700/50 text-red-200 bg-red-950/50";
    case "action_required":
      return "border-amber-700/50 text-amber-200 bg-amber-950/50";
    case "opportunity":
      return "border-emerald-700/50 text-emerald-200 bg-emerald-950/50";
    case "tracking":
      return "border-sky-700/50 text-sky-200 bg-sky-950/50";
    case "newsletter":
      return "border-purple-700/50 text-purple-200 bg-purple-950/50";
    case "invites_exhibitions":
      return "border-indigo-700/50 text-indigo-200 bg-indigo-950/50";
    case "advertising":
      return "border-pink-700/50 text-pink-200 bg-pink-950/50";
    case "tax_notice_challan":
      return "border-rose-700/50 text-rose-200 bg-rose-950/50";
    case "info":
      return "border-slate-600 text-slate-400 bg-slate-900/60";
    default:
      return "border-slate-700 text-slate-400";
  }
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString();
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function replySubject(original: string | null | undefined): string {
  const subject = (original || "").trim();
  if (!subject) return "Re:";
  if (subject.toLowerCase().startsWith("re:")) return subject;
  return `Re: ${subject}`;
}

function senderLabel(fromName: string | null | undefined, fromEmail: string | null | undefined): string {
  return fromName || fromEmail || "Unknown";
}

function initialsFrom(label: string): string {
  return label.trim().charAt(0).toUpperCase() || "?";
}

function participantsLabel(thread: InboxThreadSummary, mailboxEmail?: string | null): string {
  const mailbox = (mailboxEmail || "").toLowerCase();
  const others = thread.participants.filter((p) => p.toLowerCase() !== mailbox);
  if (others.length) return others.join(", ");
  return thread.latest_from_name || thread.latest_from_email || "Conversation";
}

function sectionDescription(section: MailSection, email?: string | null): string {
  const mailbox = email ? email : "Company mailbox";
  if (section === "all") return `${mailbox} · All folders (Inbox, Sent, Spam, Trash, Archive)`;
  if (section === "sent") return `${mailbox} · Messages you sent`;
  if (section === "trash") return `${mailbox} · Deleted messages`;
  if (section === "junk") return `${mailbox} · Spam / Junk from Outlook`;
  if (section === "archive") return `${mailbox} · Archived messages`;
  if (section === "drafts") return `${mailbox} · Unsent compose drafts`;
  if (isMailLabelSection(section)) return `${mailbox} · Labeled / flagged messages`;
  return mailbox;
}

function emptyListMessage(section: MailSection): string {
  if (section === "all") return "No messages across folders. Try Search with All mail.";
  if (section === "sent") return "No sent messages.";
  if (section === "trash") return "Trash is empty.";
  if (section === "junk") return "Spam / Junk is empty — or Outlook has no Junk folder linked to this mailbox.";
  if (section === "archive") return "No archived messages.";
  if (section === "drafts") return "No drafts.";
  if (isMailLabelSection(section)) return "No messages in this label. Flagged emails appear here after you Flag them.";
  return "No conversations.";
}

function messageListLabel(message: InboxMessageSummary, section: MailSection): string {
  if (section === "sent") {
    const to = message.to?.[0];
    return to || "No recipient";
  }
  return senderLabel(message.from_name, message.from_email);
}

/** Simple exact substring match on visible mail fields (no fuzzy IMAP body noise). */
function messageMatchesExactQuery(message: InboxMessageSummary, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const parts: string[] = [
    message.from_email || "",
    message.from_name || "",
    message.subject || "",
    message.preview || "",
    ...(message.to || []),
    ...(message.cc || []),
    ...(message.bcc || []),
  ];
  const haystack = parts.join(" \n ").toLowerCase();
  return haystack.includes(q);
}

const _MEM_THREAD_CACHE = new Map<string, { items: InboxThreadSummary[]; total: number; has_more: boolean }>();
const _MEM_MESSAGE_CACHE = new Map<string, { items: InboxMessageSummary[]; total: number; has_more: boolean }>();

function isRichHtml(html: string): boolean {
  // Keep the white iframe only when the mail needs real HTML layout
  // (images, tables, heavy styling). Simple Outlook wrappers stay as dark text.
  if (/<(?:img|table|td|tr|th|iframe|video)\b/i.test(html)) return true;
  if (html.length > 2500 && /style\s*=/i.test(html)) return true;
  return false;
}

function MessageBody({ message }: { message: InboxMessageDetail }) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState(48);
  const html = message.body_html?.trim();
  const text = message.body_text?.trim();
  const useIframe = Boolean(html && isRichHtml(html));

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || !useIframe || !html) return;
    setHeight(48);
    iframe.srcdoc = `<!DOCTYPE html><html><head><meta charset="utf-8"><base target="_blank"><style>
      html,body{margin:0;padding:0;background:#fff;}
      body{font-family:Segoe UI,system-ui,sans-serif;color:#0f172a;padding:8px 10px;font-size:14px;line-height:1.5;word-break:break-word;}
      img,video{max-width:100%;height:auto;}
      a{color:#0369a1;}
      pre,code{white-space:pre-wrap;word-break:break-word;}
      p{margin:0 0 0.6em;}
      p:last-child{margin-bottom:0;}
    </style></head><body>${html}</body></html>`;
  }, [html, message.uid, message.folder, useIframe]);

  if (useIframe && html) {
    return (
      <iframe
        ref={iframeRef}
        title={`Message ${message.uid}`}
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        onLoad={() => {
          try {
            const doc = iframeRef.current?.contentDocument;
            const next =
              doc?.body?.scrollHeight || doc?.documentElement?.scrollHeight || 0;
            if (next > 0) setHeight(Math.min(Math.max(next + 4, 36), 720));
          } catch {
            setHeight(160);
          }
        }}
        style={{ height, maxHeight: 720 }}
        className="w-full border-0 rounded-md bg-white block"
      />
    );
  }

  const plain =
    text ||
    (html ? stripHtml(html) : "") ||
    message.preview ||
    "(empty message)";

  return (
    <pre className="whitespace-pre-wrap break-words text-sm text-slate-200 font-sans m-0 leading-relaxed">
      {plain}
    </pre>
  );
}

export function InboxPage({
  section,
  onError,
  onUnreadChange,
  onFolderCountsChange,
  onMailExtrasChange,
  onSelectMailSection,
  onOpenMailerCompose,
  initialThreadId,
  initialMailboxUserId = null,
  activeMailboxUserId = null,
  autoOpenReply,
  onThreadOpened,
}: InboxPageProps) {
  const [status, setStatus] = useState<InboxStatus | null>(null);
  const [threads, setThreads] = useState<InboxThreadSummary[]>([]);
  const [messages, setMessages] = useState<InboxMessageSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [selectedMessageKey, setSelectedMessageKey] = useState<string | null>(null);
  const [thread, setThread] = useState<InboxThreadDetail | null>(null);
  const [messageDetail, setMessageDetail] = useState<InboxMessageDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [moving, setMoving] = useState(false);
  const [emptyingTrash, setEmptyingTrash] = useState(false);
  const [filterRibbonOpen, setFilterRibbonOpen] = useState(false);
  const [autoTrash, setAutoTrash] = useState<AutoTrashSettings>(DEFAULT_AUTO_TRASH);
  const [autoTrashSaving, setAutoTrashSaving] = useState(false);
  const [autoTrashLogDays, setAutoTrashLogDays] = useState<AutoTrashDailyLogDay[]>([]);
  const [autoTrashLogLoading, setAutoTrashLogLoading] = useState(false);

  const [replyBody, setReplyBody] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [replyCc, setReplyCc] = useState("");
  const [replyBcc, setReplyBcc] = useState("");
  const [replySubjectLine, setReplySubjectLine] = useState("");
  const [replyAttachments, setReplyAttachments] = useState<EmailAttachment[]>([]);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const [showAttachCatalogue, setShowAttachCatalogue] = useState(false);
  const replyFileInputRef = useRef<HTMLInputElement | null>(null);
  const [showReplyForm, setShowReplyForm] = useState(false);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [aiAnalysis, setAiAnalysis] = useState<InboxAnalyzeResponse | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [showCompose, setShowCompose] = useState(false);
  const [showComposeRecipients, setShowComposeRecipients] = useState(false);
  // Forward: the contact picker (To / Cc with filters) opens only after clicking Forward.
  const [showForwardPicker, setShowForwardPicker] = useState(false);
  const forwardDraftRef = useRef<{
    subject: string;
    body: string;
    attachments: EmailAttachment[];
  } | null>(null);
  const forwardPreparingRef = useRef(false);
  const [composeDraft, setComposeDraft] = useState<
    (MailComposeDraft & { attachments?: EmailAttachment[] }) | null
  >(null);
  const [drafts, setDrafts] = useState<MailComposeDraft[]>([]);
  const [labels, setLabels] = useState<MailLabel[]>([]);
  const [messageLabels, setMessageLabels] = useState<MailLabel[]>([]);
  const [creatingLabel, setCreatingLabel] = useState(false);
  const [deletingLabel, setDeletingLabel] = useState(false);
  const [renamingLabel, setRenamingLabel] = useState(false);
  const [showRenameModal, setShowRenameModal] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [labelMenuOpen, setLabelMenuOpen] = useState(false);
  const [assigningLabel, setAssigningLabel] = useState(false);
  const [showLabelModal, setShowLabelModal] = useState(false);
  const [threadPage, setThreadPage] = useState(1);
  const [threadTotal, setThreadTotal] = useState(0);
  const [threadHasMore, setThreadHasMore] = useState(false);
  const [messagePage, setMessagePage] = useState(1);
  const [messageTotal, setMessageTotal] = useState(0);
  const [messageHasMore, setMessageHasMore] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchScope, setSearchScope] = useState(() =>
    section === "all" ? "all" : section === "junk" ? "junk" : "inbox",
  );
  const [searchActive, setSearchActive] = useState(false);
  const searchActiveRef = useRef(false);
  const [mailAiOpen, setMailAiOpen] = useState(false);
  const [mailAiQuestion, setMailAiQuestion] = useState("");
  const [mailAiAnswer, setMailAiAnswer] = useState<string | null>(null);
  const [mailAiLoading, setMailAiLoading] = useState(false);
  const [triageFilter, setTriageFilter] = useState("");

  const pollTimerRef = useRef<number | null>(null);
  const conversationEndRef = useRef<HTMLDivElement | null>(null);
  const mailAiPanelRef = useRef<HTMLDivElement | null>(null);
  const onErrorRef = useRef(onError);
  const onUnreadChangeRef = useRef(onUnreadChange);
  const onFolderCountsChangeRef = useRef(onFolderCountsChange);
  const onMailExtrasChangeRef = useRef(onMailExtrasChange);
  const threadsRef = useRef<InboxThreadSummary[]>([]);
  threadsRef.current = threads;
  const openMessageRef = useRef<
    ((message: InboxMessageSummary) => Promise<void>) | null
  >(null);
  const mailboxUserIdRef = useRef<number | null>(initialMailboxUserId ?? null);
  /** Sticky for urgent Open & Reply — parent clears initialMailboxUserId immediately. */
  const stickyMailboxUserIdRef = useRef<number | null>(null);
  if (initialMailboxUserId != null) {
    stickyMailboxUserIdRef.current = initialMailboxUserId;
    mailboxUserIdRef.current = initialMailboxUserId;
  } else if (stickyMailboxUserIdRef.current != null) {
    mailboxUserIdRef.current = stickyMailboxUserIdRef.current;
  } else {
    mailboxUserIdRef.current =
      activeMailboxUserId != null && Number.isFinite(activeMailboxUserId)
        ? activeMailboxUserId
        : null;
  }
  const effectiveMailboxUserId = mailboxUserIdRef.current;
  onErrorRef.current = onError;
  onUnreadChangeRef.current = onUnreadChange;
  onFolderCountsChangeRef.current = onFolderCountsChange;
  onMailExtrasChangeRef.current = onMailExtrasChange;
  const loadGenerationRef = useRef(0);
  const analyzeGenerationRef = useRef(0);
  const pendingAutoDraftRef = useRef(false);
  const replyBodyRef = useRef("");
  replyBodyRef.current = replyBody;
  const labelId = mailLabelIdFromSection(section);
  const isLabelView = labelId != null;
  const flaggedLabel = useMemo(
    () =>
      labels.find(
        (label) => label.is_system || label.name.trim().toLowerCase() === "flagged",
      ) || null,
    [labels],
  );
  const isFlaggedSection = Boolean(
    flaggedLabel && labelId != null && flaggedLabel.id === labelId,
  );
  const customLabels = useMemo(
    () =>
      labels.filter(
        (label) => !(label.is_system || label.name.trim().toLowerCase() === "flagged"),
      ),
    [labels],
  );
  const currentMessageFlagged = Boolean(
    flaggedLabel && messageLabels.some((label) => label.id === flaggedLabel.id),
  );
  const isDraftsView = section === "drafts";
  const isAllMailView = section === "all";
  const isFolderMail =
    section === "all" ||
    section === "inbox" ||
    section === "sent" ||
    section === "trash" ||
    section === "junk" ||
    section === "archive" ||
    isLabelView;
  /** Inbox conversation list (not search / labels). */
  const showThreadList = section === "inbox" && !isLabelView && !searchActive;
  /**
   * Thread detail pane — unless we fell back to a single message open
   * (bounce / newsletter rows that 404 on /threads/{id}).
   */
  const isThreadView = showThreadList && !selectedMessageKey;

  useEffect(() => {
    if (!mailAiOpen) return;
    mailAiPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [mailAiOpen]);

  const refreshFolderCounts = useCallback(async () => {
    if (!onFolderCountsChangeRef.current) return;
    try {
      const result = await client.listInboxFolders(mailboxUserIdRef.current);
      const next = { inbox: 0, sent: 0, trash: 0, junk: 0, archive: 0 };
      for (const folder of result.folders) {
        if (
          folder.key === "inbox" ||
          folder.key === "sent" ||
          folder.key === "trash" ||
          folder.key === "junk" ||
          folder.key === "archive"
        ) {
          next[folder.key] = folder.count;
        }
      }
      onFolderCountsChangeRef.current(next);
    } catch {
      /* optional */
    }
  }, [effectiveMailboxUserId]);

  const clearSelection = useCallback(() => {
    setSelectedThreadId(null);
    setSelectedMessageKey(null);
    setThread(null);
    setMessageDetail(null);
    setShowReplyForm(false);
    setReplyBody("");
    setAiAnalysis(null);
    setAiLoading(false);
    setMessageLabels([]);
    setLabelMenuOpen(false);
    analyzeGenerationRef.current += 1;
    pendingAutoDraftRef.current = false;
    stickyMailboxUserIdRef.current = null;
    mailboxUserIdRef.current =
      activeMailboxUserId != null && Number.isFinite(activeMailboxUserId)
        ? activeMailboxUserId
        : null;
  }, [activeMailboxUserId]);

  const applyAiDraftToReplyForm = useCallback((analysis: InboxAnalyzeResponse) => {
    if (analysis.to?.trim()) setReplyTo(analysis.to.trim());
    if (analysis.suggested_subject?.trim()) {
      setReplySubjectLine(analysis.suggested_subject.trim());
    }
    setReplyCc("");
    setReplyBcc("");
    setReplyBody(analysis.draft_reply);
    setShowReplyForm(true);
    setNotice(null);
  }, []);

  const runThreadAnalyze = useCallback(async (threadId: string, mailboxUserId?: number | null) => {
    const generation = ++analyzeGenerationRef.current;
    const mailboxId =
      mailboxUserId !== undefined ? mailboxUserId : mailboxUserIdRef.current;
    setAiLoading(true);
    setAiAnalysis(null);
    try {
      const result = await client.analyzeInboxThread(threadId, {}, mailboxId);
      if (generation !== analyzeGenerationRef.current) return;
      setAiAnalysis(result);
      // Same path as clicking "AI draft" / "Edit & send".
      if (pendingAutoDraftRef.current && result.draft_reply?.trim()) {
        pendingAutoDraftRef.current = false;
        applyAiDraftToReplyForm(result);
      }
    } catch (e) {
      pendingAutoDraftRef.current = false;
      if (generation !== analyzeGenerationRef.current) return;
      onErrorRef.current(
        e instanceof Error ? e.message : "AI assistant could not analyze this email",
      );
    } finally {
      if (generation === analyzeGenerationRef.current) setAiLoading(false);
    }
  }, [applyAiDraftToReplyForm]);

  const runMessageAnalyze = useCallback(async (uid: string, folder: string) => {
    const generation = ++analyzeGenerationRef.current;
    setAiLoading(true);
    setAiAnalysis(null);
    try {
      const result = await client.analyzeInboxMessage(
        uid,
        { folder },
        mailboxUserIdRef.current,
      );
      if (generation !== analyzeGenerationRef.current) return;
      setAiAnalysis(result);
    } catch (e) {
      if (generation !== analyzeGenerationRef.current) return;
      onErrorRef.current(
        e instanceof Error ? e.message : "AI assistant could not analyze this email",
      );
    } finally {
      if (generation === analyzeGenerationRef.current) setAiLoading(false);
    }
  }, []);

  const loadList = useCallback(
    async (options?: { silent?: boolean }) => {
      // Never overwrite an active search with the normal folder list / poll.
      if (searchActiveRef.current) return;

      const generation = ++loadGenerationRef.current;
      const mailboxId = mailboxUserIdRef.current;
      const mailboxKey = mailboxId != null ? String(mailboxId) : "self";

      // 1. Instant Cache Render (Stale-While-Revalidate): Show cached mail immediately
      let hadCachedRender = false;
      if (section === "inbox") {
        const cacheKey = `threads:${mailboxKey}:${threadPage}:${unreadOnly}:${triageFilter || ""}`;
        const cached = _MEM_THREAD_CACHE.get(cacheKey);
        if (cached) {
          setThreads(cached.items);
          setThreadTotal(cached.total);
          setThreadHasMore(cached.has_more);
          setMessages([]);
          setDrafts([]);
          hadCachedRender = true;
        }
      } else if (
        section === "sent" ||
        section === "trash" ||
        section === "junk" ||
        section === "archive"
      ) {
        const cacheKey = `messages:${mailboxKey}:${section}:${messagePage}:${unreadOnly}`;
        const cached = _MEM_MESSAGE_CACHE.get(cacheKey);
        if (cached) {
          setMessages(cached.items);
          setMessageTotal(cached.total);
          setMessageHasMore(cached.has_more);
          setThreads([]);
          setDrafts([]);
          hadCachedRender = true;
        }
      } else if (section === "all") {
        const cacheKey = `messages:${mailboxKey}:all:${messagePage}:${unreadOnly}`;
        const cached = _MEM_MESSAGE_CACHE.get(cacheKey);
        if (cached) {
          setMessages(cached.items);
          setMessageTotal(cached.total);
          setMessageHasMore(cached.has_more);
          setThreads([]);
          setDrafts([]);
          hadCachedRender = true;
        }
      }

      if (!options?.silent && !hadCachedRender) setLoading(true);

      try {
        // 2. Parallelize status, labels, and list queries concurrently
        const statusPromise = client.getInboxStatus(mailboxId).catch(() => null);
        const labelsPromise = client.listMailLabels(mailboxId).catch(() => [] as MailLabel[]);

        let listPromise: Promise<unknown>;
        if (section === "inbox") {
          const offset = (threadPage - 1) * PAGE_SIZE;
          listPromise = client.listInboxThreads({
            limit: PAGE_SIZE,
            offset,
            unread_only: unreadOnly,
            triage_category: triageFilter || undefined,
            mailbox_user_id: mailboxId,
          });
        } else if (section === "drafts") {
          listPromise = client.listMailDrafts();
        } else if (isMailLabelSection(section)) {
          const id = mailLabelIdFromSection(section);
          if (id == null) {
            listPromise = Promise.resolve(null);
          } else {
            // Same path for Flagged and custom labels: keys + recent scan + batch hydrate.
            listPromise = Promise.all([
              client.listMailLabelMessages(id, mailboxId),
              client.listInboxMessages({
                limit: 60,
                folder: "inbox",
                mailbox_user_id: mailboxId,
              }),
              client.listInboxMessages({
                limit: 30,
                folder: "sent",
                mailbox_user_id: mailboxId,
              }),
            ]).then(([keys, inboxRows, sentRows]) => ({
              kind: "label_scan" as const,
              keys,
              inboxRows,
              sentRows,
            }));
          }
        } else if (
          section === "sent" ||
          section === "trash" ||
          section === "junk" ||
          section === "archive" ||
          section === "all"
        ) {
          const offset = (messagePage - 1) * PAGE_SIZE;
          listPromise = client.listInboxMessages({
            limit: PAGE_SIZE,
            offset,
            unread_only: unreadOnly && section !== "sent" && section !== "all",
            folder: section === "all" ? "all" : section,
            mailbox_user_id: mailboxId,
          });
        } else {
          listPromise = Promise.resolve(null);
        }

        const [s, labelRows, listResult] = await Promise.all([
          statusPromise,
          labelsPromise,
          listPromise,
        ]);

        if (generation !== loadGenerationRef.current) return;
        if (searchActiveRef.current) return;

        if (s) {
          setStatus(s);
          onUnreadChangeRef.current?.(s.unread_count);
        }
        setLabels(labelRows);

        if (section === "drafts") {
          setDrafts(Array.isArray(listResult) ? listResult : []);
          setThreads([]);
          setMessages([]);
          onMailExtrasChangeRef.current?.();
          return;
        }

        if (s && !s.configured) {
          setThreads([]);
          setMessages([]);
          setDrafts([]);
          return;
        }

        if (section === "inbox" && listResult) {
          const threadList = listResult as InboxThreadListResponse;
          setThreads(threadList.items || []);
          setThreadTotal(threadList.total || 0);
          setThreadHasMore(Boolean(threadList.has_more));
          setMessages([]);
          setDrafts([]);
          const cacheKey = `threads:${mailboxKey}:${threadPage}:${unreadOnly}:${triageFilter || ""}`;
          _MEM_THREAD_CACHE.set(cacheKey, {
            items: threadList.items || [],
            total: threadList.total || 0,
            has_more: Boolean(threadList.has_more),
          });
        } else if (
          isMailLabelSection(section) &&
          listResult &&
          typeof listResult === "object" &&
          "kind" in (listResult as object)
        ) {
          const payload = listResult as {
            kind: "label_scan";
            keys: MailLabelMessageKey[];
            inboxRows: InboxMessageListResponse;
            sentRows: InboxMessageListResponse;
          };
          const { keys, inboxRows, sentRows } = payload;
          const id = mailLabelIdFromSection(section);
          const activeLabel = labelRows.find((l) => l.id === id) || null;
          const fromScan = [...(inboxRows?.items || []), ...(sentRows?.items || [])].filter(
            (m) => {
              // Flagged / system labels are assignment-only (no domain rules).
              if (
                activeLabel &&
                !activeLabel.is_system &&
                activeLabel.name.trim().toLowerCase() !== "flagged" &&
                messageMatchesLabelRules(m, activeLabel)
              ) {
                return true;
              }
              return messageMatchesLabelKeys(m, keys || []);
            },
          );
          const seen = new Set(
            fromScan.map((m) => {
              const folder = (m.folder || "inbox").trim().toLowerCase() || "inbox";
              return `${folder}:${String(m.uid || "").trim()}`;
            }),
          );
          const missingKeys = (keys || []).filter((k) => {
            const folder = (k.folder || "inbox").trim().toLowerCase() || "inbox";
            const uid = String(k.message_uid || "").trim();
            return Boolean(uid) && !seen.has(`${folder}:${uid}`);
          });
          let hydrated: InboxMessageSummary[] = [];
          if (missingKeys.length > 0 && id != null) {
            try {
              const resolved = await client.resolveMailLabelMessages(id, mailboxId);
              hydrated = (resolved.items || []).filter((msg) => {
                const folder = (msg.folder || "inbox").trim().toLowerCase() || "inbox";
                const key = `${folder}:${String(msg.uid).trim()}`;
                return !seen.has(key);
              });
            } catch {
              hydrated = [];
            }
          }
          if (generation !== loadGenerationRef.current) return;
          if (searchActiveRef.current) return;
          setMessages([...fromScan, ...hydrated]);
          setThreads([]);
          setDrafts([]);
        } else if (
          (section === "sent" ||
            section === "trash" ||
            section === "junk" ||
            section === "archive" ||
            section === "all") &&
          listResult
        ) {
          const msgList = listResult as InboxMessageListResponse;
          setMessages(msgList.items || []);
          setMessageTotal(msgList.total || 0);
          setMessageHasMore(Boolean(msgList.has_more));
          setThreads([]);
          setDrafts([]);
          const cacheKey = `messages:${mailboxKey}:${section}:${messagePage}:${unreadOnly}`;
          _MEM_MESSAGE_CACHE.set(cacheKey, {
            items: msgList.items || [],
            total: msgList.total || 0,
            has_more: Boolean(msgList.has_more),
          });
        } else if (!isMailLabelSection(section)) {
          setThreads([]);
          setMessages([]);
          setDrafts([]);
        }

        void refreshFolderCounts();
        onMailExtrasChangeRef.current?.();
      } catch (e) {
        if (!options?.silent && generation === loadGenerationRef.current) {
          onErrorRef.current(e instanceof Error ? e.message : "Failed to load mail");
        }
      } finally {
        if (generation === loadGenerationRef.current) {
          setLoading(false);
        }
      }
    },
    [
      messagePage,
      refreshFolderCounts,
      section,
      threadPage,
      triageFilter,
      unreadOnly,
      effectiveMailboxUserId,
    ],
  );

  useEffect(() => {
    clearSelection();
    setNotice(null);
    setUnreadOnly(false);
    setThreadPage(1);
    setMessagePage(1);
    setSearchActive(false);
    searchActiveRef.current = false;
    setTriageFilter("");
    // Default search to All mail when opening All emails (finds Spam like Outlook).
    if (section === "all") {
      setSearchScope("all");
      setFilterRibbonOpen(true);
    } else if (
      section === "sent" ||
      section === "trash" ||
      section === "junk" ||
      section === "archive"
    ) {
      setSearchScope(section);
    } else if (section === "inbox") {
      setSearchScope("inbox");
    }
  }, [clearSelection, section]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    if (!status?.configured) return;
    pollTimerRef.current = window.setInterval(() => {
      void loadList({ silent: true });
    }, 60_000);
    return () => {
      if (pollTimerRef.current !== null) window.clearInterval(pollTimerRef.current);
    };
  }, [status?.configured, loadList]);

  /** When thread open 404s, resolve the same row via folder messages (Sent-style). */
  const openInboxThreadAsMessage = useCallback(
    async (
      summary: InboxThreadSummary,
      mailboxId: number | null,
    ): Promise<boolean> => {
      const subject = (summary.subject || "").trim();
      const fromEmail = (summary.latest_from_email || "").trim().toLowerCase();
      const pickMatch = (items: InboxMessageSummary[]) => {
        if (!items.length) return null;
        const bySubjectAndFrom = items.find((m) => {
          const sameSubject = subject
            ? (m.subject || "").trim() === subject
            : false;
          const sameFrom = fromEmail
            ? (m.from_email || "").trim().toLowerCase() === fromEmail
            : true;
          return sameSubject && sameFrom;
        });
        if (bySubjectAndFrom) return bySubjectAndFrom;
        if (subject) {
          const bySubject = items.find((m) => (m.subject || "").trim() === subject);
          if (bySubject) return bySubject;
        }
        if (fromEmail) {
          const byFrom = items.find(
            (m) => (m.from_email || "").trim().toLowerCase() === fromEmail,
          );
          if (byFrom) return byFrom;
        }
        return null;
      };

      try {
        const searchQ = (fromEmail || subject).slice(0, 120);
        const searched = await client.listInboxMessages({
          limit: 50,
          folder: "inbox",
          q: searchQ || undefined,
          mailbox_user_id: mailboxId,
        });
        let match = pickMatch(searched.items || []);
        if (!match) {
          const page = await client.listInboxMessages({
            limit: 80,
            folder: "inbox",
            mailbox_user_id: mailboxId,
          });
          match = pickMatch(page.items || []);
        }
        if (!match) return false;

        // Switch into message detail view (clears thread selection).
        setSelectedThreadId(null);
        setThread(null);
        if (openMessageRef.current) {
          await openMessageRef.current(match);
          return true;
        }
        return false;
      } catch {
        return false;
      }
    },
    [],
  );

  const openThread = useCallback(
    async (
      threadId: string,
      opts?: { mailboxUserId?: number | null; autoDraft?: boolean },
    ) => {
      const mailboxId =
        opts?.mailboxUserId !== undefined
          ? opts.mailboxUserId
          : stickyMailboxUserIdRef.current ??
            (activeMailboxUserId != null && Number.isFinite(activeMailboxUserId)
              ? activeMailboxUserId
              : null);
      if (opts?.autoDraft) {
        if (opts.mailboxUserId != null) stickyMailboxUserIdRef.current = opts.mailboxUserId;
      } else if (opts?.mailboxUserId === undefined) {
        // Normal list click — keep Asim switcher mailbox (not sticky urgent override).
        stickyMailboxUserIdRef.current = null;
      }
      mailboxUserIdRef.current =
        stickyMailboxUserIdRef.current ??
        (activeMailboxUserId != null && Number.isFinite(activeMailboxUserId)
          ? activeMailboxUserId
          : null);

      setSelectedThreadId(threadId);
      setSelectedMessageKey(null);
      setMessageDetail(null);
      setThread(null);
      setDetailLoading(true);
      setNotice(null);
      setShowReplyForm(Boolean(opts?.autoDraft));
      setReplyBody("");
      setReplyCc("");
      setReplyBcc("");
      setAiAnalysis(null);
      try {
        const detail = await client.getInboxThread(threadId, mailboxId);
        setThread(detail);
        setReplySubjectLine(replySubject(detail.subject));

        const latestInbound = [...detail.messages]
          .reverse()
          .find((m) => m.direction !== "outbound");
        const latest = latestInbound || detail.messages[detail.messages.length - 1];
        if (latest?.direction === "outbound") {
          setReplyTo((latest.to && latest.to[0]) || "");
        } else {
          setReplyTo(latest?.from_email || "");
        }

        setThreads((prev) =>
          prev.map((t) => (t.thread_id === threadId ? { ...t, unread_count: 0 } : t)),
        );
        void client
          .getInboxStatus(mailboxUserIdRef.current)
          .then((s) => {
            onUnreadChangeRef.current?.(s.unread_count);
            setStatus(s);
          })
          .catch(() => {
            /* ignore */
          });
        void runThreadAnalyze(threadId, mailboxId);
        const latestForLabels =
          latestInbound || detail.messages[detail.messages.length - 1];
        if (latestForLabels) {
          void client
            .mapMailLabelsByUids(
              (latestForLabels.folder || "inbox").toLowerCase(),
              [String(latestForLabels.uid)],
              mailboxUserIdRef.current,
            )
            .then((mapped) => {
              setMessageLabels(mapped[String(latestForLabels.uid)] || []);
            })
            .catch(() => setMessageLabels([]));
        } else {
          setMessageLabels([]);
        }
      } catch (e) {
        pendingAutoDraftRef.current = false;
        // Thread merge can 404 for bounces / newsletters while the row is still in the list.
        // Fall back to the same single-message open path Sent uses — inbox-only, no API redesign.
        const summary = threadsRef.current.find((t) => t.thread_id === threadId);
        const openedAsMessage = summary
          ? await openInboxThreadAsMessage(summary, mailboxId)
          : false;
        if (!openedAsMessage) {
          setSelectedThreadId(null);
          setThread(null);
          onErrorRef.current(e instanceof Error ? e.message : "Failed to open conversation");
        }
      } finally {
        setDetailLoading(false);
      }
    },
    [runThreadAnalyze, activeMailboxUserId, openInboxThreadAsMessage],
  );

  useEffect(() => {
    // Asim mailbox switch — clear open thread and reload that mailbox only.
    stickyMailboxUserIdRef.current = null;
    mailboxUserIdRef.current =
      activeMailboxUserId != null && Number.isFinite(activeMailboxUserId)
        ? activeMailboxUserId
        : null;
    setSelectedThreadId(null);
    setSelectedMessageKey(null);
    setThread(null);
    setMessageDetail(null);
    setShowReplyForm(false);
    setAiAnalysis(null);
    setNotice(null);
  }, [activeMailboxUserId]);

  useEffect(() => {
    let cancelled = false;
    void client
      .getAutoTrashSettings(mailboxUserIdRef.current)
      .then((row) => {
        if (!cancelled) setAutoTrash(row);
      })
      .catch(() => {
        // Keep a local default so the toggle stays clickable; PUT creates settings.
        if (!cancelled) setAutoTrash((prev) => ({ ...DEFAULT_AUTO_TRASH, enabled: prev.enabled }));
      });
    return () => {
      cancelled = true;
    };
  }, [activeMailboxUserId, section]);

  useEffect(() => {
    if (section !== "trash") return;
    let cancelled = false;
    setAutoTrashLogLoading(true);
    void client
      .getAutoTrashDailyLog(14)
      .then((res) => {
        if (!cancelled) setAutoTrashLogDays(res.days || []);
      })
      .catch(() => {
        if (!cancelled) setAutoTrashLogDays([]);
      })
      .finally(() => {
        if (!cancelled) setAutoTrashLogLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [section]);

  async function toggleAutoTrash(next: boolean) {
    if (autoTrashSaving) return;
    const previous = autoTrash;
    setAutoTrashSaving(true);
    // Optimistic — never leave the switch dead while the request is in flight.
    setAutoTrash((prev) => ({
      ...prev,
      enabled: next,
      can_auto_trash: next && prev.profile_ready,
    }));
    try {
      const row = await client.updateAutoTrashSettings(
        { enabled: next },
        mailboxUserIdRef.current,
      );
      setAutoTrash(row);
      setNotice(
        next
          ? row.profile_ready
            ? "Auto Trash ON — matching inbox mail will move to Trash automatically."
            : "Auto Trash ON — still learning from Trash; auto-moves start once the profile is ready (Settings → Study Trash now)."
          : "Auto Trash OFF for this mailbox.",
      );
    } catch (e) {
      setAutoTrash(previous);
      onError(e instanceof Error ? e.message : "Could not update Auto Trash");
    } finally {
      setAutoTrashSaving(false);
    }
  }

  useEffect(() => {
    if (!initialThreadId) return;
    const mailboxId = initialMailboxUserId ?? stickyMailboxUserIdRef.current;
    if (autoOpenReply) pendingAutoDraftRef.current = true;
    void openThread(initialThreadId, {
      mailboxUserId: mailboxId,
      autoDraft: Boolean(autoOpenReply),
    }).then(() => {
      onThreadOpened?.();
    });
  }, [initialThreadId, autoOpenReply, initialMailboxUserId, onThreadOpened, openThread]);

  const openMessage = useCallback(
    async (message: InboxMessageSummary) => {
      const folder = message.folder || "INBOX";
      const key = `${folder}:${message.uid}`;
      setSelectedMessageKey(key);
      setSelectedThreadId(null);
      setThread(null);
      setMessageDetail(null);
      setDetailLoading(true);
      setNotice(null);
      setShowReplyForm(false);
      setAiAnalysis(null);
      try {
        const detail = await client.getInboxMessage(
          message.uid,
          folder,
          mailboxUserIdRef.current,
        );
        setMessageDetail(detail);
        setReplySubjectLine(replySubject(detail.subject));
        if (detail.direction === "outbound") {
          setReplyTo((detail.to && detail.to[0]) || "");
        } else {
          setReplyTo(detail.from_email || "");
        }
        if (detail.unread) {
          try {
            const unread = await client.markInboxMessageRead(
              message.uid,
              folder,
              mailboxUserIdRef.current,
            );
            onUnreadChangeRef.current?.(unread.count);
            setMessages((prev) =>
              prev.map((m) =>
                m.uid === message.uid && (m.folder || "INBOX") === folder
                  ? { ...m, unread: false }
                  : m,
              ),
            );
          } catch {
            /* mark-read is best-effort */
          }
        }
        void runMessageAnalyze(message.uid, folder);
        void client
          .mapMailLabelsByUids(
            folder.toLowerCase(),
            [String(detail.uid)],
            mailboxUserIdRef.current,
          )
          .then((mapped) => setMessageLabels(mapped[String(detail.uid)] || []))
          .catch(() => setMessageLabels([]));
      } catch (e) {
        onErrorRef.current(e instanceof Error ? e.message : "Failed to open message");
      } finally {
        setDetailLoading(false);
      }
    },
    [runMessageAnalyze],
  );
  openMessageRef.current = openMessage;

  useEffect(() => {
    if (!thread || detailLoading) return;
    conversationEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [thread, detailLoading]);

  const replyTarget = useMemo(() => {
    if (!thread?.messages.length) return null;
    return (
      [...thread.messages].reverse().find((m) => m.direction !== "outbound") ||
      thread.messages[thread.messages.length - 1]
    );
  }, [thread]);

  function startReply(mode: "reply" | "reply_all" = "reply") {
    const mailbox = status?.email || status?.emails?.[0] || null;
    const source = isThreadView ? replyTarget : messageDetail;
    if (!source) return;

    const recipients = buildReplyRecipients(source, mailbox, mode);
    setReplyTo(recipients.to);
    setReplyCc(recipients.cc);
    setReplyBcc(recipients.bcc);
    setShowReplyForm(true);
    setNotice(null);

    if (mode === "reply" && aiAnalysis?.draft_reply?.trim()) {
      setReplyBody(aiAnalysis.draft_reply);
      if (aiAnalysis.suggested_subject?.trim()) {
        setReplySubjectLine(aiAnalysis.suggested_subject.trim());
      }
      if (aiAnalysis.to?.trim()) setReplyTo(aiAnalysis.to.trim());
      return;
    }

    // Clean empty compose box — do not quote the prior thread.
    setReplyBody("");
  }

  async function startForward() {
    const source =
      isThreadView && thread ? thread.messages[thread.messages.length - 1] : messageDetail;
    if (!source || forwardPreparingRef.current) return;
    forwardPreparingRef.current = true;
    setNotice(null);
    try {
      // Carry the original attachments over: copy them into outgoing storage first. If that
      // fails the forward still works — the body then says the files were not included.
      let attachments: EmailAttachment[] = [];
      let notIncluded: string[] | null = null;
      const originalNames = (source.attachments || [])
        .map((a) => (a.filename || "").trim())
        .filter(Boolean);
      if (originalNames.length > 0) {
        setNotice("Preparing the attachments for your forward…");
        try {
          const staged = await client.stageInboxAttachmentsForForward(
            source.uid,
            source.folder || "INBOX",
            mailboxUserIdRef.current,
          );
          attachments = staged.attachments || [];
          notIncluded = staged.skipped || [];
        } catch {
          notIncluded = null;
        }
        setNotice(null);
      }

      forwardDraftRef.current = {
        subject: forwardSubject(source.subject),
        body: buildForwardBodyHtml(source, notIncluded),
        attachments,
      };
      setShowForwardPicker(true);
    } finally {
      forwardPreparingRef.current = false;
    }
  }

  const canReplyAll = useMemo(() => {
    const mailbox = status?.email || status?.emails?.[0] || null;
    const source = isThreadView ? replyTarget : messageDetail;
    if (!source) return false;
    return hasReplyAllTargets(source, mailbox);
  }, [isThreadView, replyTarget, messageDetail, status?.email, status?.emails]);

  async function handleReplyFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploadingAttachment(true);
    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const uploaded = await client.uploadEmailAttachment(file);
        setReplyAttachments((prev) => [...prev, uploaded]);
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to upload attachment");
    } finally {
      setUploadingAttachment(false);
      if (replyFileInputRef.current) {
        replyFileInputRef.current.value = "";
      }
    }
  }

  function handleRemoveReplyAttachment(id: string) {
    setReplyAttachments((prev) => prev.filter((a) => a.id !== id));
  }

  async function sendReply() {
    if (!emailBodyHasContent(replyBody)) return;
    setSending(true);
    setNotice(null);
    try {
      if (selectedThreadId) {
        const result = await client.replyInboxThread(
          selectedThreadId,
          {
            body: replyBody,
            to: replyTo.trim() || undefined,
            subject: replySubjectLine.trim() || undefined,
            cc: replyCc.trim() || undefined,
            bcc: replyBcc.trim() || undefined,
            attachments: replyAttachments.length > 0 ? replyAttachments : undefined,
          },
          mailboxUserIdRef.current,
        );
        const extras = [
          replyCc.trim() ? `Cc: ${replyCc.trim()}` : "",
          replyBcc.trim() ? `Bcc: ${replyBcc.trim()}` : "",
          replyAttachments.length > 0 ? `${replyAttachments.length} attachment(s)` : "",
        ]
          .filter(Boolean)
          .join("; ");
        setNotice(
          `Reply sent to ${result.to ?? replyTo}${extras ? ` (${extras})` : ""}.`,
        );
        setReplyBody("");
        setReplyBcc("");
        setReplyAttachments([]);
        setShowReplyForm(false);
        await openThread(selectedThreadId);
      } else if (messageDetail) {
        const result = await client.replyInboxMessage(
          messageDetail.uid,
          {
            body: replyBody,
            to: replyTo.trim() || undefined,
            subject: replySubjectLine.trim() || undefined,
            cc: replyCc.trim() || undefined,
            bcc: replyBcc.trim() || undefined,
            folder: messageDetail.folder || "INBOX",
            attachments: replyAttachments.length > 0 ? replyAttachments : undefined,
          },
          mailboxUserIdRef.current,
        );
        const extras = [
          replyCc.trim() ? `Cc: ${replyCc.trim()}` : "",
          replyBcc.trim() ? `Bcc: ${replyBcc.trim()}` : "",
          replyAttachments.length > 0 ? `${replyAttachments.length} attachment(s)` : "",
        ]
          .filter(Boolean)
          .join("; ");
        setNotice(
          `Reply sent to ${result.to ?? replyTo}${extras ? ` (${extras})` : ""}.`,
        );
        setReplyBody("");
        setReplyBcc("");
        setReplyAttachments([]);
        setShowReplyForm(false);
        await openMessage(messageDetail);
      }
      await loadList({ silent: true });
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to send reply");
    } finally {
      setSending(false);
    }
  }

  async function moveThread(toFolder: "trash" | "archive") {
    if (!selectedThreadId) return;
    setMoving(true);
    setNotice(null);
    try {
      const result = await client.moveInboxThread(
        selectedThreadId,
        toFolder,
        mailboxUserIdRef.current,
      );
      setNotice(result.message);
      clearSelection();
      await loadList({ silent: true });
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to move conversation");
    } finally {
      setMoving(false);
    }
  }

  async function moveSelectedMessage(toFolder: "inbox" | "trash" | "archive") {
    if (!messageDetail) return;
    setMoving(true);
    setNotice(null);
    try {
      const result = await client.moveInboxMessage(
        messageDetail.uid,
        {
          from_folder: messageDetail.folder || "INBOX",
          to_folder: toFolder,
        },
        mailboxUserIdRef.current,
      );
      setNotice(result.message);
      clearSelection();
      await loadList({ silent: true });
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to move message");
    } finally {
      setMoving(false);
    }
  }

  async function handleEmptyTrash() {
    const confirmed = window.confirm(
      "Permanently delete all messages in Trash? This cannot be undone.",
    );
    if (!confirmed) return;
    setEmptyingTrash(true);
    setNotice(null);
    try {
      const result = await client.emptyInboxTrash(mailboxUserIdRef.current);
      setNotice(result.message);
      clearSelection();
      await loadList();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to empty trash");
    } finally {
      setEmptyingTrash(false);
    }
  }

  async function showAllMail() {
    try {
      await client.clearInboxCutoff(mailboxUserIdRef.current);
      setNotice("Showing all mailbox conversations.");
      clearSelection();
      setUnreadOnly(false);
      await loadList();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to show all mail");
    }
  }

  function formatSince(value: string | null | undefined): string {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString();
  }

  if (
    section === "activity" ||
    section === "email-templates" ||
    section === "personalized-emails"
  ) {
    return null;
  }

  if (!loading && status && !status.configured && !isDraftsView) {
    return (
      <section className="space-y-4 w-full min-w-0">
        <h2 className="text-lg font-medium text-slate-100">Mail</h2>
        <div className="p-6 rounded-xl border border-slate-800 bg-slate-900/40 text-slate-400 text-sm space-y-2">
          <p>Mail is not enabled for your account yet.</p>
          <p>
            Ask an admin to set your company mailbox (email + password) on the Users page.
            Shared IMAP/SMTP hosts must be configured in{" "}
            <code className="text-slate-300">backend/.env</code> with{" "}
            <code className="text-slate-300">MAILBOX_ENABLED=true</code>.
          </p>
        </div>
      </section>
    );
  }

  async function createLabelFromModal(payload: {
    name: string;
    domain: string;
    keyword: string;
  }) {
    const { name, domain, keyword } = payload;
    if (!name) return;
    if (!domain && !keyword) {
      onError("Enter a domain or keyword — label name alone does not route mail.");
      return;
    }
    setCreatingLabel(true);
    try {
      await client.createMailLabel({
        name,
        match_query: domain || null,
        match_keyword: keyword || null,
      });
      setShowLabelModal(false);
      const parts: string[] = [];
      if (domain) parts.push(`domain/email “${domain}”`);
      if (keyword) parts.push(`keyword “${keyword}”`);
      setNotice(
        `Label “${name}” created — mail matching ${parts.join(" or ")} will leave Inbox.`,
      );
      onMailExtrasChangeRef.current?.();
      await loadList({ silent: true });
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to create label");
    } finally {
      setCreatingLabel(false);
    }
  }

  async function runMailSearch() {
    const q = searchQuery.trim();
    if (!q) return;
    setLoading(true);
    setNotice(null);
    // Cancel any in-flight folder load so it cannot wipe search results.
    loadGenerationRef.current += 1;
    searchActiveRef.current = true;
    setSearchActive(true);
    setThreads([]);
    setDrafts([]);
    setSelectedThreadId(null);
    setMessageDetail(null);
    setThread(null);
    try {
      const result = await client.searchInboxMail(
        {
          query: q,
          scope: searchScope,
          limit: Math.max(PAGE_SIZE, 100),
          offset: 0,
        },
        mailboxUserIdRef.current,
      );
      if (!searchActiveRef.current) return;
      const matched = (result.items || []).filter((item) =>
        messageMatchesExactQuery(item, q),
      );
      setMessages(matched);
      setMessageTotal(matched.length);
      setMessageHasMore(false);
      setThreads([]);
      if (matched.length === 0) {
        setNotice(`No emails match “${q}”.`);
      } else {
        setNotice(
          `Found ${matched.length} email${matched.length === 1 ? "" : "s"} matching “${q}”.`,
        );
      }
    } catch (e) {
      if (searchActiveRef.current) {
        onError(e instanceof Error ? e.message : "Search failed");
      }
    } finally {
      setLoading(false);
    }
  }

  async function runMailAi(unreadOnly = false) {
    const question = mailAiQuestion.trim();
    if (!question) return;
    setMailAiLoading(true);
    setMailAiAnswer(null);
    try {
      const result = await client.queryInboxMailAi(
        { question, unread_only: unreadOnly },
        mailboxUserIdRef.current,
      );
      setMailAiAnswer(result.answer);
      if (result.suggested_threads?.length && section === "inbox") {
        setThreads(result.suggested_threads);
        searchActiveRef.current = false;
        setSearchActive(false);
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : "Mail assistant could not answer");
    } finally {
      setMailAiLoading(false);
    }
  }

  async function deleteCurrentLabel() {
    if (labelId == null) return;
    const active = labels.find((l) => l.id === labelId);
    const name = active?.name || "this label";
    const countHint =
      messages.length > 0
        ? `${messages.length} message${messages.length === 1 ? "" : "s"} in this label will return to Inbox. `
        : "";
    if (
      !window.confirm(
        `Delete label “${name}”? ${countHint}No emails will be removed from the mailbox — only the label and its grouping.`,
      )
    ) {
      return;
    }
    setDeletingLabel(true);
    try {
      await client.deleteMailLabel(labelId);
      setNotice(`Label “${name}” deleted — matching mail will show in Inbox again.`);
      clearSelection();
      onMailExtrasChangeRef.current?.();
      onSelectMailSection?.("inbox");
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to delete label");
    } finally {
      setDeletingLabel(false);
    }
  }

  function startRenameCurrentLabel() {
    if (labelId == null) return;
    const active = labels.find((l) => l.id === labelId);
    setRenameValue(active?.name || "");
    setShowRenameModal(true);
  }

  async function handleRenameSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (labelId == null) return;
    const clean = renameValue.trim();
    if (!clean) return;
    const active = labels.find((l) => l.id === labelId);
    if (active && active.name === clean) {
      setShowRenameModal(false);
      return;
    }
    setRenamingLabel(true);
    try {
      const updated = await client.renameMailLabel(labelId, { name: clean });
      setLabels((prev) =>
        prev.map((l) => (l.id === labelId ? { ...l, name: updated.name } : l)),
      );
      setNotice(`Label renamed to “${updated.name}”.`);
      setShowRenameModal(false);
      onMailExtrasChangeRef.current?.();
      await loadList({ silent: true });
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to rename label");
    } finally {
      setRenamingLabel(false);
    }
  }

  async function discardDraftById(draftId: number) {
    try {
      await client.deleteMailDraft(draftId);
      setNotice("Draft discarded.");
      if (composeDraft?.id === draftId) {
        setShowCompose(false);
        setComposeDraft(null);
      }
      onMailExtrasChangeRef.current?.();
      await loadList({ silent: true });
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to discard draft");
    }
  }

  async function assignLabelToCurrent(label: MailLabel, applySimilar: boolean) {
    const detail = messageDetail;
    const threadMsg = thread?.messages?.[thread.messages.length - 1];
    const target = detail || threadMsg;
    if (!target) {
      onError("Open a message first to apply a label");
      return;
    }
    setAssigningLabel(true);
    try {
      await client.assignMailLabel({
        label_id: label.id,
        folder: (target.folder || section || "inbox").toLowerCase(),
        message_uid: String(target.uid),
        message_id: target.message_id ?? null,
        thread_id: thread?.thread_id ?? null,
        from_email: target.from_email,
        subject: target.subject,
        apply_similar: applySimilar,
        mailbox_user_id: mailboxUserIdRef.current,
      });
      setNotice(
        applySimilar
          ? `Labeled “${label.name}” (including similar messages).`
          : `Labeled “${label.name}”.`,
      );
      setLabelMenuOpen(false);
      const mapped = await client.mapMailLabelsByUids(
        (target.folder || "inbox").toLowerCase(),
        [String(target.uid)],
        mailboxUserIdRef.current,
      );
      setMessageLabels(mapped[String(target.uid)] || []);
      onMailExtrasChangeRef.current?.();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to assign label");
    } finally {
      setAssigningLabel(false);
    }
  }

  async function toggleFlagCurrent() {
    let flag = flaggedLabel;
    if (!flag) {
      try {
        const rows = await client.listMailLabels(mailboxUserIdRef.current);
        setLabels(rows);
        flag =
          rows.find(
            (label) => label.is_system || label.name.trim().toLowerCase() === "flagged",
          ) || null;
      } catch {
        /* ignore */
      }
    }
    if (!flag) {
      onError("Flagged mailbox is not ready yet. Refresh and try again.");
      return;
    }
    const detail = messageDetail;
    const threadMsg = thread?.messages?.[thread.messages.length - 1];
    const target = detail || threadMsg;
    if (!target) {
      onError("Open a message first to flag it");
      return;
    }
    const folder = (target.folder || section || "inbox").toLowerCase();
    const uid = String(target.uid);
    const already = messageLabels.some((label) => label.id === flag!.id);
    setAssigningLabel(true);
    try {
      if (already) {
        await client.unassignMailLabel({
          label_id: flag.id,
          folder,
          message_uid: uid,
          mailbox_user_id: mailboxUserIdRef.current,
        });
        setNotice("Removed from Flagged.");
        if (isFlaggedSection) {
          await loadList({ silent: true });
          setSelectedMessageKey(null);
          setSelectedThreadId(null);
          setMessageDetail(null);
          setThread(null);
        }
      } else {
        await client.assignMailLabel({
          label_id: flag.id,
          folder,
          message_uid: uid,
          message_id: target.message_id ?? null,
          thread_id: thread?.thread_id ?? null,
          from_email: target.from_email,
          subject: target.subject,
          apply_similar: false,
          mailbox_user_id: mailboxUserIdRef.current,
        });
        setNotice("Added to Flagged.");
      }
      const mapped = await client.mapMailLabelsByUids(
        folder,
        [uid],
        mailboxUserIdRef.current,
      );
      setMessageLabels(mapped[uid] || []);
      onMailExtrasChangeRef.current?.();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to update flag");
    } finally {
      setAssigningLabel(false);
    }
  }

  return (
    <section className="space-y-4 w-full min-w-0">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0 space-y-2">
          <p className="text-sm text-slate-500">
            {sectionDescription(section, status?.email)}
            {section === "inbox" && status ? (
              <>
                {" · "}
                <button
                  type="button"
                  onClick={() => {
                    setMailAiOpen(true);
                    if (!mailAiQuestion) {
                      setMailAiQuestion("What are the most important unread emails?");
                    }
                  }}
                  className="text-emerald-400 hover:text-emerald-300 underline decoration-dotted"
                  title="Ask AI about unread mail"
                >
                  {status.unread_count} unread — ask AI
                </button>
              </>
            ) : null}
          </p>
          {section === "inbox" && !searchActive && !loading && threads.length > 0 ? (
            <p className="text-xs text-slate-500 mt-1">
              Page {threadPage} · showing {(threadPage - 1) * PAGE_SIZE + 1}–
              {(threadPage - 1) * PAGE_SIZE + threads.length} of ~{threadTotal} in mailbox
            </p>
          ) : null}
          {!showThreadList && !isDraftsView && !searchActive && !loading && messages.length > 0 && messageTotal > 0 ? (
            <p className="text-xs text-slate-500 mt-1">
              Page {messagePage} · showing {(messagePage - 1) * PAGE_SIZE + 1}–
              {(messagePage - 1) * PAGE_SIZE + messages.length} of ~{messageTotal}
            </p>
          ) : null}
          {isLabelView && labels.find((l) => l.id === labelId) ? (
            <p className="text-xs text-emerald-400/90 mt-1">
              {isFlaggedSection
                ? "Manual flags only — each flag is one email in this mailbox."
                : (() => {
                    const active = labels.find((l) => l.id === labelId)!;
                    const { domain, keyword } = labelRoutingSummary(active);
                    const parts: string[] = [];
                    if (domain) parts.push(`domain/email ${domain}`);
                    if (keyword) parts.push(`keyword ${keyword}`);
                    return `Routing: ${parts.join(" · ") || "manual assignments only"}`;
                  })()}
            </p>
          ) : null}
          {section === "inbox" && status?.showing_since && (
            <p className="text-xs text-slate-500 mt-1">
              Temporary filter: mail from {formatSince(status.showing_since)} onward.{" "}
              <button
                type="button"
                onClick={() => void showAllMail()}
                className="text-emerald-400 hover:text-emerald-300 underline"
              >
                Show all mail
              </button>
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {isFolderMail && !isDraftsView ? (
            <>
              <ActionButton
                icon={IconInbox}
                variant={isAllMailView || searchScope === "all" ? "emerald" : "secondary"}
                size="md"
                onClick={() => {
                  onSelectMailSection?.("all");
                  setSearchScope("all");
                  setFilterRibbonOpen(true);
                }}
                title="Search and browse Inbox + Sent + Spam/Junk + Trash + Archive"
              >
                All emails
              </ActionButton>
              <ActionButton
              icon={IconFilter}
              variant={filterRibbonOpen || searchActive || Boolean(triageFilter) ? "emerald" : "secondary"}
              size="md"
              onClick={() => setFilterRibbonOpen((prev) => !prev)}
              title={filterRibbonOpen ? "Hide search, triage & mail assistant" : "Show search, triage & mail assistant"}
            >
              Filter & Search
              {searchActive || (triageFilter && triageFilter !== "all") ? " · on" : ""}
            </ActionButton>
            </>
          ) : null}
          {isLabelView && labelId != null && !isFlaggedSection ? (
            <>
              <ActionButton
                icon={IconTag}
                variant="ghost"
                size="md"
                disabled={renamingLabel || deletingLabel}
                onClick={startRenameCurrentLabel}
                title="Rename this label"
                className="text-emerald-300 hover:text-emerald-200 border border-emerald-500/30"
              >
                Rename label
              </ActionButton>
              <ActionButton
                icon={IconTrash}
                variant="ghost"
                size="md"
                disabled={deletingLabel || renamingLabel}
                onClick={() => void deleteCurrentLabel()}
                title="Delete label — emails return to Inbox"
                className="text-rose-300 hover:text-rose-200 border border-rose-500/30"
              >
                {deletingLabel ? "Deleting…" : "Delete label"}
              </ActionButton>
            </>
          ) : null}
          <ActionButton
            icon={IconPlus}
            variant="primary"
            size="md"
            onClick={() => setShowComposeRecipients(true)}
            title="Choose To / Cc contacts, then compose"
          >
            Compose
          </ActionButton>
          <ActionButton
            icon={IconTag}
            size="md"
            onClick={() => setShowLabelModal(true)}
            title="Create label"
          >
            Create label
          </ActionButton>
          {section === "trash" && (
            <ActionButton
              icon={IconTrash}
              variant="danger"
              size="md"
              onClick={() => void handleEmptyTrash()}
              disabled={emptyingTrash || messages.length === 0}
              title="Empty Trash"
            >
              {emptyingTrash ? "Emptying…" : "Empty Trash"}
            </ActionButton>
          )}
          {isFolderMail && section !== "sent" && !isDraftsView && (
            <label className="flex items-center gap-2 text-sm text-slate-400">
              <input
                type="checkbox"
                checked={unreadOnly}
                onChange={(e) => setUnreadOnly(e.target.checked)}
                className="accent-emerald-600"
              />
              Unread only
            </label>
          )}
        </div>
      </div>

      {section === "trash" ? (
        <div className="rounded-xl border border-slate-700 bg-slate-900/80 p-3.5 space-y-2 shrink-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-slate-100">Auto Trash log</h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Emails moved automatically — day-wise counts per mailbox user (last 14 days).
                Retrain from Settings → Study Trash now.
              </p>
            </div>
            {autoTrashLogLoading ? (
              <span className="text-xs text-slate-500">Loading…</span>
            ) : null}
          </div>
          {autoTrashLogDays.length === 0 && !autoTrashLogLoading ? (
            <p className="text-xs text-slate-500">No auto-trashed emails logged yet.</p>
          ) : (
            <div className="max-h-40 overflow-y-auto space-y-2">
              {autoTrashLogDays.map((day) => (
                <div
                  key={day.date}
                  className="rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2"
                >
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-semibold text-amber-200">{day.date}</span>
                    <span className="text-slate-300 tabular-nums">{day.total} total</span>
                  </div>
                  <ul className="mt-1.5 space-y-0.5">
                    {day.users.map((u) => (
                      <li
                        key={`${day.date}-${u.user_id}`}
                        className="text-xs text-slate-400 flex flex-wrap gap-x-2"
                      >
                        <span className="text-slate-200">
                          {u.full_name || u.username}
                        </span>
                        {u.mailbox_email ? (
                          <span className="text-slate-500">{u.mailbox_email}</span>
                        ) : null}
                        <span className="text-rose-300/90 tabular-nums ml-auto">{u.count}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}

      {section === "inbox" && !filterRibbonOpen ? (
        <div className="flex flex-wrap items-center justify-end gap-2 shrink-0">
          {autoTrash ? (
            <span className="text-[11px] text-slate-500">
              {autoTrash.profile_ready
                ? `Ready · ${autoTrash.samples_seen} samples`
                : `${autoTrash.samples_seen} samples · Learning…`}
            </span>
          ) : null}
          <label
            className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border text-sm font-semibold cursor-pointer select-none ${
              autoTrash.enabled
                ? "border-rose-500/50 bg-rose-500/15 text-rose-100"
                : "border-slate-600 bg-slate-900 text-slate-300 hover:border-slate-500"
            } ${autoTrashSaving ? "opacity-70" : ""}`}
            title="When ON, this mailbox inbox is scanned and matching noise is moved to Trash automatically. Retrain in Settings."
          >
            <input
              type="checkbox"
              className="sr-only"
              checked={Boolean(autoTrash.enabled)}
              disabled={autoTrashSaving}
              onChange={(e) => void toggleAutoTrash(e.target.checked)}
            />
            <span
              className={`relative w-9 h-5 rounded-full transition-colors ${
                autoTrash.enabled ? "bg-rose-500" : "bg-slate-600"
              }`}
              aria-hidden
            >
              <span
                className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                  autoTrash.enabled ? "translate-x-4" : ""
                }`}
              />
            </span>
            <span>Auto Trash</span>
            {!autoTrash.profile_ready ? (
              <span className="text-[10px] font-normal text-amber-300/90">Learning…</span>
            ) : (
              <span className="text-[10px] font-normal text-emerald-300/90">Ready</span>
            )}
          </label>
        </div>
      ) : null}

      {isFolderMail && !isDraftsView && filterRibbonOpen ? (
        <div className="rounded-xl border border-slate-700 bg-slate-900 p-3.5 space-y-3 shadow-sm shrink-0">
              <div className="flex flex-wrap items-center gap-2">
            <select
              value={searchScope}
              onChange={(e) => setSearchScope(e.target.value)}
              className="rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-2 text-sm text-slate-200"
              aria-label="Search scope"
            >
              <option value="all">All mail (Inbox + Sent + Spam + …)</option>
              <option value="inbox">Inbox</option>
              <option value="sent">Sent</option>
              <option value="archive">Archive</option>
              <option value="trash">Trash</option>
              <option value="junk">Spam / Junk</option>
              {customLabels.map((label) => (
                <option key={label.id} value={`label:${label.id}`}>
                  Label: {label.name}
                </option>
              ))}
            </select>
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void runMailSearch();
              }}
              placeholder="Search mail…"
              className="flex-1 min-w-[12rem] rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
            />
            <ActionButton icon={IconSearch} size="md" onClick={() => void runMailSearch()}>
              Search
            </ActionButton>
            {searchActive ? (
              <ActionButton
                icon={IconX}
                variant="ghost"
                size="md"
                onClick={() => {
                  searchActiveRef.current = false;
                  setSearchActive(false);
                  setNotice(null);
                  void loadList();
                }}
              >
                Clear
              </ActionButton>
            ) : null}
          </div>
          {section === "inbox" && !searchActive ? (
            <div className="flex flex-wrap items-center gap-2 py-1">
              <span className="text-xs font-bold text-slate-400 uppercase tracking-wider mr-1 flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-400 inline-block animate-pulse" />
                Triage:
              </span>
              {TRIAGE_FILTERS.map((f) => {
                const active = triageFilter === f.key;
                return (
                  <button
                    key={f.key || "all"}
                    type="button"
                    onClick={() => {
                      setTriageFilter(f.key);
                      setThreadPage(1);
                      clearSelection();
                    }}
                    className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg border text-sm font-semibold transition-all duration-150 transform hover:scale-[1.03] active:scale-[0.98] cursor-pointer ${
                      active ? f.activeClass : f.inactiveClass
                    }`}
                  >
                    <span className="text-base">{f.emoji}</span>
                    <span>{f.label}</span>
                  </button>
                );
              })}
              <label
                className={`ml-auto inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border text-sm font-semibold cursor-pointer select-none ${
                  autoTrash.enabled
                    ? "border-rose-500/50 bg-rose-500/15 text-rose-100"
                    : "border-slate-600 bg-slate-950/60 text-slate-300 hover:border-slate-500"
                } ${autoTrashSaving ? "opacity-70" : ""}`}
                title={
                  autoTrash.profile_ready
                    ? "When ON, this mailbox inbox is scanned and matching noise is moved to Trash automatically."
                    : "Profile still learning — retrain in Settings → Study Trash now, then turn ON."
                }
              >
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={Boolean(autoTrash.enabled)}
                  disabled={autoTrashSaving}
                  onChange={(e) => void toggleAutoTrash(e.target.checked)}
                />
                <span
                  className={`relative w-9 h-5 rounded-full transition-colors ${
                    autoTrash.enabled ? "bg-rose-500" : "bg-slate-600"
                  }`}
                  aria-hidden
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                      autoTrash.enabled ? "translate-x-4" : ""
                    }`}
                  />
                </span>
                <span>Auto Trash</span>
                {!autoTrash.profile_ready ? (
                  <span className="text-[10px] font-normal text-amber-300/90">Learning…</span>
                ) : (
                  <span className="text-[10px] font-normal text-emerald-300/90">Ready</span>
                )}
              </label>
            </div>
          ) : null}
          <div
            ref={mailAiPanelRef}
            className={`rounded-xl border bg-slate-950/50 p-3 space-y-2 ${
              mailAiOpen ? "border-emerald-500/40 ring-1 ring-emerald-500/20" : "border-slate-800"
            }`}
          >
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <IconSparkles size="sm" className="text-emerald-400" />
              Mail assistant — ask about important unread, queries, or new leads
            </div>
            <div className="flex flex-wrap gap-2">
              <input
                value={mailAiQuestion}
                onChange={(e) => setMailAiQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void runMailAi(false);
                }}
                placeholder="e.g. Any important unread emails from finance?"
                className="flex-1 min-w-[14rem] rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
              />
              <ActionButton
                icon={IconSparkles}
                size="md"
                disabled={mailAiLoading || !mailAiQuestion.trim()}
                onClick={() => void runMailAi(false)}
              >
                {mailAiLoading ? "…" : "Ask"}
              </ActionButton>
              <ActionButton
                icon={IconInbox}
                size="md"
                variant="ghost"
                disabled={mailAiLoading}
                onClick={() => {
                  setMailAiOpen(true);
                  setMailAiQuestion("Summarize my most important unread emails.");
                  void runMailAi(true);
                }}
              >
                Unread focus
              </ActionButton>
            </div>
            {mailAiAnswer ? (
              <p className="text-sm text-slate-300 whitespace-pre-wrap">{mailAiAnswer}</p>
            ) : null}
          </div>
        </div>
      ) : null}

      <CreateLabelModal
        open={showLabelModal}
        onClose={() => setShowLabelModal(false)}
        onCreate={createLabelFromModal}
        creating={creatingLabel}
      />

      {showRenameModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
          <div
            className="w-full max-w-md rounded-xl border border-slate-700 bg-slate-950 shadow-xl p-5 space-y-4"
            role="dialog"
            aria-labelledby="rename-label-title"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 id="rename-label-title" className="text-base font-medium text-slate-100">
                  Rename label
                </h3>
                <p className="text-xs text-slate-500 mt-1">
                  Enter a new name for this email label.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowRenameModal(false)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
                aria-label="Close"
              >
                <IconX size="sm" />
              </button>
            </div>
            <form onSubmit={(e) => void handleRenameSubmit(e)} className="space-y-4">
              <label className="block text-sm text-slate-400">
                Label name
                <input
                  required
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  placeholder="e.g. Finance - KAFI"
                  className="mt-1.5 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-slate-200 focus:border-emerald-500 focus:outline-none"
                />
              </label>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowRenameModal(false)}
                  className="px-3 py-1.5 rounded-lg border border-slate-700 text-sm text-slate-400 hover:bg-slate-800"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={renamingLabel || !renameValue.trim()}
                  className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-medium text-white disabled:opacity-50"
                >
                  {renamingLabel ? "Renaming…" : "Save"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {notice && !showReplyForm && !showCompose && (
        <div className="p-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-200 text-sm">
          {notice}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(320px,440px)_1fr] gap-4 xl:gap-6">
        <div
          className={`rounded-xl border border-slate-800 overflow-hidden bg-slate-950/40 ${
            selectedThreadId || selectedMessageKey || (isDraftsView && composeDraft)
              ? "hidden lg:block"
              : ""
          }`}
        >
          <div className="max-h-[75vh] overflow-y-auto divide-y divide-slate-800/80">
            {loading ? (
              <p className="py-10 text-center text-slate-500 text-sm">
                {isDraftsView
                  ? "Loading drafts…"
                  : showThreadList
                    ? "Loading conversations…"
                    : "Loading messages…"}
              </p>
            ) : isDraftsView ? (
              drafts.length === 0 ? (
                <p className="py-10 text-center text-slate-500 text-sm">{emptyListMessage(section)}</p>
              ) : (
                drafts.map((draft) => (
                  <div
                    key={draft.id}
                    className="flex items-stretch gap-1 hover:bg-slate-900/60 transition"
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setComposeDraft(draft);
                        setShowCompose(true);
                      }}
                      className="min-w-0 flex-1 text-left px-4 py-3.5"
                    >
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-slate-100">
                          {draft.to_addrs || "(no recipient)"}
                        </span>
                        <span className="ml-auto shrink-0 text-[11px] text-slate-500">
                          {formatDate(draft.updated_at)}
                        </span>
                      </div>
                      <div className="truncate text-sm text-slate-300 mt-0.5">
                        {draft.subject || "(no subject)"}
                      </div>
                      <div className="truncate text-xs text-slate-500 mt-1">
                        {(draft.body || "").replace(/\s+/g, " ").slice(0, 120)}
                      </div>
                    </button>
                    <button
                      type="button"
                      title="Discard draft"
                      onClick={() => void discardDraftById(draft.id)}
                      className="shrink-0 self-center mr-3 px-2.5 py-1.5 rounded-lg border border-red-800/40 text-red-300 text-xs hover:bg-red-950/40"
                    >
                      Discard
                    </button>
                  </div>
                ))
              )
            ) : showThreadList ? (
              threads.length === 0 ? (
                <p className="py-10 text-center text-slate-500 text-sm">{emptyListMessage(section)}</p>
              ) : (
                threads.map((item) => {
                  const active = item.thread_id === selectedThreadId;
                  const label = participantsLabel(item, status?.email);
                  return (
                    <button
                      key={item.thread_id}
                      type="button"
                      onClick={() => void openThread(item.thread_id)}
                      className={`w-full text-left px-4 py-3 transition ${
                        active ? "bg-emerald-600/15" : "hover:bg-slate-900/60"
                      }`}
                    >
                      <div className="flex items-start gap-3">
                        <span className="mt-0.5 shrink-0 w-8 h-8 rounded-full bg-slate-800 text-slate-300 flex items-center justify-center text-sm font-medium">
                          {initialsFrom(label)}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            {item.unread_count > 0 && (
                              <span className="shrink-0 w-2 h-2 rounded-full bg-emerald-400" />
                            )}
                            <span
                              className={`truncate text-sm ${
                                item.unread_count > 0
                                  ? "text-slate-100 font-semibold"
                                  : "text-slate-300"
                              }`}
                            >
                              {label}
                            </span>
                            <span className="ml-auto shrink-0 text-[11px] text-slate-500">
                              {formatDate(item.latest_date)}
                            </span>
                          </div>
                          <div
                            className={`truncate text-sm ${
                              item.unread_count > 0 ? "text-slate-200" : "text-slate-400"
                            }`}
                          >
                            {item.subject}
                            {item.triage_label ? (
                              <span
                                className={`ml-2 inline-flex align-middle px-1.5 py-0 rounded border text-[10px] font-medium ${triageBadgeClass(
                                  item.triage_category,
                                )}`}
                              >
                                {item.triage_label}
                              </span>
                            ) : null}
                            <span className="ml-1 text-slate-500">
                              · {item.message_count} msg{item.message_count === 1 ? "" : "s"}
                            </span>
                          </div>
                          <div className="truncate text-xs text-slate-500">{item.latest_preview}</div>
                        </div>
                      </div>
                    </button>
                  );
                })
              )
            ) : messages.length === 0 ? (
              <p className="py-10 text-center text-slate-500 text-sm">
                {searchActive
                  ? `No emails match “${searchQuery.trim()}”.`
                  : emptyListMessage(section)}
              </p>
            ) : (
              messages.map((item) => {
                const folder = item.folder || "INBOX";
                const key = `${folder}:${item.uid}`;
                const active = key === selectedMessageKey;
                const label = messageListLabel(item, section);
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => void openMessage(item)}
                    className={`w-full text-left px-4 py-3 transition ${
                      active ? "bg-emerald-600/15" : "hover:bg-slate-900/60"
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <span className="mt-0.5 shrink-0 w-8 h-8 rounded-full bg-slate-800 text-slate-300 flex items-center justify-center text-sm font-medium">
                        {initialsFrom(label)}
                      </span>
                      <div className="min-w-0 flex-1">
                        {searchActive ? (
                          <>
                            <div className="flex items-center gap-2">
                              {item.unread && (
                                <span className="shrink-0 w-2 h-2 rounded-full bg-emerald-400" />
                              )}
                              <span
                                className={`truncate text-sm ${
                                  item.unread
                                    ? "text-slate-100 font-semibold"
                                    : "text-slate-200 font-medium"
                                }`}
                              >
                                {item.subject || "(no subject)"}
                              </span>
                              <span className="ml-auto shrink-0 text-[11px] text-slate-500">
                                {formatDate(item.date)}
                              </span>
                            </div>
                            <div className="truncate text-xs text-slate-400 mt-0.5">
                              {label}
                              {item.from_email ? ` · ${item.from_email}` : ""}
                              {item.folder ? ` · ${item.folder}` : ""}
                            </div>
                            {item.preview ? (
                              <div className="truncate text-xs text-slate-500 mt-0.5">
                                {item.preview}
                              </div>
                            ) : null}
                          </>
                        ) : (
                          <>
                            <div className="flex items-center gap-2">
                              {item.unread && (
                                <span className="shrink-0 w-2 h-2 rounded-full bg-emerald-400" />
                              )}
                              <span
                                className={`truncate text-sm ${
                                  item.unread ? "text-slate-100 font-semibold" : "text-slate-300"
                                }`}
                              >
                                {label}
                              </span>
                              <span className="ml-auto shrink-0 text-[11px] text-slate-500">
                                {formatDate(item.date)}
                              </span>
                            </div>
                            <div
                              className={`truncate text-sm ${
                                item.unread ? "text-slate-200" : "text-slate-400"
                              }`}
                            >
                              {item.subject}
                            </div>
                            <div className="truncate text-xs text-slate-500">{item.preview}</div>
                          </>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
          {showThreadList && !searchActive && (threadPage > 1 || threadHasMore) ? (
            <div className="flex items-center justify-between gap-2 px-3 py-2 border-t border-slate-800 bg-slate-950/60">
              <ActionButton
                icon={IconChevronRight}
                iconClassName="rotate-180"
                size="md"
                variant="ghost"
                disabled={threadPage <= 1 || loading}
                onClick={() => setThreadPage((p) => Math.max(1, p - 1))}
              >
                Prev
              </ActionButton>
              <span className="text-xs text-slate-500 tabular-nums">Page {threadPage}</span>
              <ActionButton
                icon={IconChevronRight}
                size="md"
                variant="ghost"
                disabled={!threadHasMore || loading}
                onClick={() => setThreadPage((p) => p + 1)}
              >
                Next
              </ActionButton>
            </div>
          ) : null}
          {!showThreadList && !isDraftsView && !searchActive && (messagePage > 1 || messageHasMore) ? (
            <div className="flex items-center justify-between gap-2 px-3 py-2 border-t border-slate-800 bg-slate-950/60">
              <ActionButton
                icon={IconChevronRight}
                iconClassName="rotate-180"
                size="md"
                variant="ghost"
                disabled={messagePage <= 1 || loading}
                onClick={() => setMessagePage((p) => Math.max(1, p - 1))}
              >
                Prev
              </ActionButton>
              <span className="text-xs text-slate-500 tabular-nums">Page {messagePage}</span>
              <ActionButton
                icon={IconChevronRight}
                size="md"
                variant="ghost"
                disabled={!messageHasMore || loading}
                onClick={() => setMessagePage((p) => p + 1)}
              >
                Next
              </ActionButton>
            </div>
          ) : null}
        </div>

        <div
          className={`rounded-xl border border-slate-800 min-h-[50vh] flex-col bg-slate-950/30 ${
            selectedThreadId || selectedMessageKey ? "flex" : "hidden lg:flex"
          }`}
        >
              <div className="lg:hidden px-4 pt-3">
                <button
                  type="button"
                  onClick={() => {
                    setSelectedThreadId(null);
                    setSelectedMessageKey(null);
                  }}
                  className="text-sm text-slate-400 hover:text-slate-200"
                >
                  ← Back to list
                </button>
              </div>
          {isThreadView ? (
            !selectedThreadId ? (
              <div className="flex-1 flex items-center justify-center text-slate-500 text-sm">
                Select a conversation to read the thread.
              </div>
            ) : detailLoading ? (
              <div className="flex-1 flex items-center justify-center text-slate-500 text-sm">
                Loading conversation…
              </div>
            ) : thread ? (
              <div className="flex flex-col h-full min-h-0">
                <div className="px-5 py-4 border-b border-slate-800 space-y-2">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div>
                      <h3 className="text-base font-semibold text-slate-100">{thread.subject}</h3>
                      <p className="mt-1 text-sm text-slate-400">
                        {participantsLabel(thread, status?.email)}
                        <span className="text-slate-500">
                          {" "}
                          · {thread.message_count} message
                          {thread.message_count === 1 ? "" : "s"}
                        </span>
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2 items-center">
                      {messageLabels.map((label) => (
                        <span
                          key={label.id}
                          className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium border"
                          style={{
                            color: label.color,
                            borderColor: `${label.color}66`,
                            backgroundColor: `${label.color}22`,
                          }}
                        >
                          {label.name}
                        </span>
                      ))}
                      <div className="relative">
                        <button
                          type="button"
                          onClick={() => setLabelMenuOpen((open) => !open)}
                          disabled={assigningLabel || customLabels.length === 0}
                          className="shrink-0 px-3 py-1.5 rounded-lg border border-slate-700 text-slate-300 text-sm hover:bg-slate-900 disabled:opacity-50"
                        >
                          Labels
                        </button>
                        {labelMenuOpen && (
                          <div className="absolute right-0 z-20 mt-1 w-56 rounded-lg border border-slate-700 bg-slate-900 shadow-xl py-1">
                            {customLabels.map((label) => (
                              <div key={label.id} className="px-2 py-1">
                                <button
                                  type="button"
                                  onClick={() => void assignLabelToCurrent(label, false)}
                                  className="w-full text-left px-2 py-1.5 rounded text-sm text-slate-200 hover:bg-slate-800"
                                >
                                  {label.name}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void assignLabelToCurrent(label, true)}
                                  className="w-full text-left px-2 py-1 text-[11px] text-slate-500 hover:text-emerald-300"
                                >
                                  + similar messages
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                      <button
                        type="button"
                        disabled={assigningLabel}
                        onClick={() => void toggleFlagCurrent()}
                        className={`shrink-0 px-3 py-1.5 rounded-lg border text-sm font-medium transition disabled:opacity-50 ${
                          currentMessageFlagged
                            ? "border-amber-500/60 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25"
                            : "border-slate-700 text-slate-300 hover:bg-slate-900"
                        }`}
                        title={
                          currentMessageFlagged ? "Remove from Flagged" : "Flag this email"
                        }
                      >
                        {currentMessageFlagged ? "⚑ Remove flag" : "⚐ Flag"}
                      </button>
                      <ActionButton
                        icon={IconArchive}
                        onClick={() => void moveThread("archive")}
                        disabled={moving}
                        title="Archive"
                      >
                        Archive
                      </ActionButton>
                      <ActionButton
                        icon={IconTrash}
                        variant="rose"
                        onClick={() => void moveThread("trash")}
                        disabled={moving}
                        title="Move to Trash"
                      >
                        Trash
                      </ActionButton>
                      {!showReplyForm && (
                        <>
                          <ActionButton
                            icon={IconReply}
                            variant="primary"
                            onClick={() => startReply("reply")}
                            disabled={!replyTarget}
                            title="Reply to sender only"
                          >
                            Reply
                          </ActionButton>
                          {canReplyAll && (
                            <ActionButton
                              icon={IconReply}
                              onClick={() => startReply("reply_all")}
                              title="Reply all — sender plus To/Cc/Bcc"
                            >
                              Reply all
                            </ActionButton>
                          )}
                          <ActionButton
                            icon={IconSend}
                            onClick={() => startForward()}
                            title="Forward this email — pick To and Cc contacts"
                          >
                            Forward
                          </ActionButton>
                          {aiAnalysis?.draft_reply ? (
                            <ActionButton
                              icon={IconSparkles}
                              variant="sky"
                              onClick={() => applyAiDraftToReplyForm(aiAnalysis)}
                              title="Use AI draft reply"
                            >
                              AI draft
                            </ActionButton>
                          ) : null}
                        </>
                      )}
                    </div>
                  </div>
                </div>

                {(aiLoading || aiAnalysis) && (
                  <div className="mx-4 mt-3 rounded-xl border border-sky-500/25 bg-sky-500/10 px-4 py-3 space-y-3 shrink-0">
                    <div className="flex items-start justify-between gap-3 flex-wrap">
                      <div>
                        <p className="text-xs font-medium uppercase tracking-wide text-sky-300/90">
                          AI assistant
                        </p>
                        {aiLoading ? (
                          <p className="mt-1 text-sm text-slate-300">Reading this email…</p>
                        ) : (
                          <p className="mt-1 text-sm text-slate-200 leading-relaxed">
                            {aiAnalysis?.summary}
                          </p>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {selectedThreadId && (
                          <ActionButton
                            icon={IconRefresh}
                            size="sm"
                            onClick={() => void runThreadAnalyze(selectedThreadId)}
                            disabled={aiLoading}
                            title="Refresh analysis"
                            className="border-sky-500/40 text-sky-200"
                          >
                            Refresh analysis
                          </ActionButton>
                        )}
                        {aiAnalysis?.draft_reply && !showReplyForm && (
                          <ActionButton
                            icon={IconSparkles}
                            variant="primary"
                            size="sm"
                            onClick={() => applyAiDraftToReplyForm(aiAnalysis)}
                            title="Edit and send draft"
                          >
                            Edit &amp; send
                          </ActionButton>
                        )}
                      </div>
                    </div>
                    {aiAnalysis?.draft_reply && !showReplyForm && (
                      <div className="rounded-lg border border-slate-700/80 bg-slate-950/50 px-3 py-2">
                        <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">
                          Suggested reply
                          {aiAnalysis.source === "fallback" ? " (template)" : ""}
                        </p>
                        <pre className="whitespace-pre-wrap break-words text-sm text-slate-300 font-sans m-0 max-h-40 overflow-y-auto">
                          {aiAnalysis.draft_reply}
                        </pre>
                      </div>
                    )}
                  </div>
                )}

                <div className="flex-1 overflow-y-auto min-h-0 px-4 py-4 space-y-3">
                  {thread.messages.map((message) => {
                    const outbound = message.direction === "outbound";
                    return (
                      <div
                        key={`${message.folder || "INBOX"}:${message.uid}`}
                        className={`flex ${outbound ? "justify-end" : "justify-start"}`}
                      >
                        <div
                          className={`max-w-[98%] xl:max-w-5xl w-full rounded-2xl border px-5 py-4 ${
                            outbound
                              ? "bg-emerald-600/15 border-emerald-500/30"
                              : "bg-slate-900/80 border-slate-700"
                          }`}
                        >
                          <div className="flex items-center gap-2 text-xs text-slate-400 mb-2">
                            <span className="font-medium text-slate-200">
                              {outbound
                                ? "You"
                                : senderLabel(message.from_name, message.from_email)}
                            </span>
                            {message.from_email && !outbound ? (
                              <span className="truncate text-slate-500">{message.from_email}</span>
                            ) : null}
                            <span className="ml-auto shrink-0">{formatDate(message.date)}</span>
                          </div>
                          <MessageBody message={message} />
                          <InboxAttachmentChips
                            message={message}
                            mailboxUserId={mailboxUserIdRef.current}
                            onError={onError}
                          />
                        </div>
                      </div>
                    );
                  })}
                  <div ref={conversationEndRef} />
                </div>

                {!showReplyForm && (
                  <div className="px-5 py-3 border-t border-slate-800 bg-slate-950/70 flex flex-wrap items-center gap-2 shrink-0">
                    <ActionButton
                      icon={IconReply}
                      variant="primary"
                      size="md"
                      onClick={() => startReply("reply")}
                      disabled={!replyTarget}
                      title="Reply to sender only"
                    >
                      Reply
                    </ActionButton>
                    {canReplyAll && (
                      <ActionButton
                        icon={IconReply}
                        size="md"
                        onClick={() => startReply("reply_all")}
                        title="Reply all — sender plus To/Cc/Bcc"
                      >
                        Reply all
                      </ActionButton>
                    )}
                    <ActionButton
                      icon={IconSend}
                      size="md"
                      onClick={() => startForward()}
                      title="Forward this email — pick To and Cc contacts"
                    >
                      Forward
                    </ActionButton>
                    <span className="text-xs text-slate-500">
                      Write a reply and send from your mailbox
                    </span>
                  </div>
                )}

                {showReplyForm && (
                  <div className="px-5 py-4 border-t border-slate-800 space-y-2 bg-slate-950/50">
                    {notice && (
                      <div className="p-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-200 text-sm">
                        {notice}
                      </div>
                    )}
                    {aiLoading && !replyBody.trim() ? (
                      <div className="p-2.5 rounded-lg bg-sky-500/10 border border-sky-500/30 text-sky-200 text-sm">
                        AI draft is reading this email and filling the reply…
                      </div>
                    ) : null}
                    <div className="flex items-center gap-2 text-sm">
                      <span className="w-14 shrink-0 text-slate-500">To</span>
                      <input
                        type="email"
                        value={replyTo}
                        onChange={(e) => setReplyTo(e.target.value)}
                        className="flex-1 rounded-lg bg-slate-950 border border-slate-700 px-3 py-1.5 text-sm"
                      />
                    </div>
                    <div className="flex items-center gap-2 text-sm">
                      <span className="w-14 shrink-0 text-slate-500">Cc</span>
                      <input
                        type="text"
                        value={replyCc}
                        onChange={(e) => setReplyCc(e.target.value)}
                        placeholder="optional"
                        className="flex-1 rounded-lg bg-slate-950 border border-slate-700 px-3 py-1.5 text-sm"
                      />
                    </div>
                    <div className="flex items-center gap-2 text-sm">
                      <span className="w-14 shrink-0 text-slate-500">Bcc</span>
                      <input
                        type="text"
                        value={replyBcc}
                        onChange={(e) => setReplyBcc(e.target.value)}
                        placeholder="optional"
                        className="flex-1 rounded-lg bg-slate-950 border border-slate-700 px-3 py-1.5 text-sm"
                      />
                    </div>
                    <div className="flex items-center gap-2 text-sm">
                      <span className="w-14 shrink-0 text-slate-500">Subject</span>
                      <input
                        type="text"
                        value={replySubjectLine}
                        onChange={(e) =>
                          setReplySubjectLine(capitalizeFirstLetter(e.target.value))
                        }
                        className="flex-1 rounded-lg bg-slate-950 border border-slate-700 px-3 py-1.5 text-sm"
                      />
                    </div>
                    <EmailBodyEditor
                      value={replyBody}
                      onChange={setReplyBody}
                      placeholder={
                        aiLoading && !replyBody.trim()
                          ? "Writing suggested reply…"
                          : "Write your reply…"
                      }
                      rows={7}
                      onAttachClick={() => replyFileInputRef.current?.click()}
                      attachmentCount={replyAttachments.length}
                      isUploadingAttachment={uploadingAttachment}
                    />
                    <AttachedFilesList
                      attachments={replyAttachments}
                      onRemove={handleRemoveReplyAttachment}
                      onClearAll={() => setReplyAttachments([])}
                      uploading={uploadingAttachment}
                    />
                    <div className="flex items-center justify-between gap-2 pt-1">
                      <div className="flex items-center gap-2">
                        <ActionButton
                          icon={IconPaperclip}
                          size="md"
                          variant="secondary"
                          onClick={() => replyFileInputRef.current?.click()}
                          disabled={sending || uploadingAttachment}
                          title="Attach Document / Files"
                        >
                          {uploadingAttachment ? "Attaching…" : "Attach Document"}
                        </ActionButton>
                        <ActionButton
                          icon={IconBookOpen}
                          size="md"
                          variant="secondary"
                          onClick={() => setShowAttachCatalogue(true)}
                          disabled={sending || uploadingAttachment}
                          title="Attach Official Catalogue / Price List"
                        >
                          Attach Catalogue
                        </ActionButton>
                        {replyAttachments.length > 0 && (
                          <span className="text-xs text-emerald-400 font-medium">
                            {replyAttachments.length} attached
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <ActionButton
                          icon={IconX}
                          size="md"
                          onClick={() => {
                            setShowReplyForm(false);
                            setReplyBody("");
                            setReplyBcc("");
                            setReplyAttachments([]);
                            setNotice(null);
                          }}
                          title="Cancel"
                        >
                          Cancel
                        </ActionButton>
                        <ActionButton
                          icon={IconSend}
                          variant="primary"
                          size="md"
                          onClick={() => void sendReply()}
                          disabled={
                            sending ||
                            !emailBodyHasContent(replyBody) ||
                            !replyTo.trim() ||
                            uploadingAttachment
                          }
                          title="Send reply"
                        >
                          {sending
                            ? "Sending…"
                            : replyAttachments.length > 0
                              ? `Send reply (${replyAttachments.length} file${replyAttachments.length > 1 ? "s" : ""})`
                              : "Send reply"}
                        </ActionButton>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex-1 flex items-center justify-center text-slate-500 text-sm">
                Conversation not found.
              </div>
            )
          ) : !selectedMessageKey ? (
            <div className="flex-1 flex items-center justify-center text-slate-500 text-sm">
              {isDraftsView
                ? "Select a draft to continue editing."
                : "Select a message to read it."}
            </div>
          ) : detailLoading ? (
            <div className="flex-1 flex items-center justify-center text-slate-500 text-sm">
              Loading message…
            </div>
          ) : messageDetail ? (
            <div className="flex flex-col h-full min-h-0">
              <div className="px-5 py-4 border-b border-slate-800 space-y-2">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <h3 className="text-base font-semibold text-slate-100">
                      {messageDetail.subject}
                    </h3>
                    <p className="mt-1 text-sm text-slate-400">
                      {section === "sent"
                        ? `To ${(messageDetail.to || []).join(", ") || "—"}`
                        : senderLabel(messageDetail.from_name, messageDetail.from_email)}
                      {messageDetail.from_email && section !== "sent" ? (
                        <span className="text-slate-500"> · {messageDetail.from_email}</span>
                      ) : null}
                      <span className="text-slate-500">
                        {" "}
                        · {formatDate(messageDetail.date)}
                      </span>
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2 items-center">
                    {messageLabels.map((label) => (
                      <span
                        key={label.id}
                        className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium border"
                        style={{
                          color: label.color,
                          borderColor: `${label.color}66`,
                          backgroundColor: `${label.color}22`,
                        }}
                      >
                        {label.name}
                      </span>
                    ))}
                    <div className="relative">
                      <button
                        type="button"
                        onClick={() => setLabelMenuOpen((open) => !open)}
                        disabled={assigningLabel || customLabels.length === 0}
                        className="shrink-0 px-3 py-1.5 rounded-lg border border-slate-700 text-slate-300 text-sm hover:bg-slate-900 disabled:opacity-50"
                      >
                        Labels
                      </button>
                      {labelMenuOpen && (
                        <div className="absolute right-0 z-20 mt-1 w-56 rounded-lg border border-slate-700 bg-slate-900 shadow-xl py-1">
                          {customLabels.map((label) => (
                            <div key={label.id} className="px-2 py-1">
                              <button
                                type="button"
                                onClick={() => void assignLabelToCurrent(label, false)}
                                className="w-full text-left px-2 py-1.5 rounded text-sm text-slate-200 hover:bg-slate-800"
                              >
                                {label.name}
                              </button>
                              <button
                                type="button"
                                onClick={() => void assignLabelToCurrent(label, true)}
                                className="w-full text-left px-2 py-1 text-[11px] text-slate-500 hover:text-emerald-300"
                              >
                                + similar messages
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      disabled={assigningLabel}
                      onClick={() => void toggleFlagCurrent()}
                      className={`shrink-0 px-3 py-1.5 rounded-lg border text-sm font-medium transition disabled:opacity-50 ${
                        currentMessageFlagged
                          ? "border-amber-500/60 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25"
                          : "border-slate-700 text-slate-300 hover:bg-slate-900"
                      }`}
                      title={
                        currentMessageFlagged ? "Remove from Flagged" : "Flag this email"
                      }
                    >
                      {currentMessageFlagged ? "⚑ Remove flag" : "⚐ Flag"}
                    </button>
                    {(section === "trash" || section === "junk" || section === "archive") && (
                      <ActionButton
                        icon={IconInbox}
                        onClick={() => void moveSelectedMessage("inbox")}
                        disabled={moving}
                        title="Restore to Inbox"
                      >
                        Restore
                      </ActionButton>
                    )}
                    {section === "archive" && (
                      <ActionButton
                        icon={IconTrash}
                        variant="rose"
                        onClick={() => void moveSelectedMessage("trash")}
                        disabled={moving}
                        title="Move to Trash"
                      >
                        Trash
                      </ActionButton>
                    )}
                    {(section === "inbox" || section === "all") && (
                      <ActionButton
                        icon={IconTrash}
                        variant="rose"
                        onClick={() => void moveSelectedMessage("trash")}
                        disabled={moving}
                        title="Move to Trash"
                      >
                        Trash
                      </ActionButton>
                    )}
                    {section === "sent" && (
                      <>
                        <ActionButton
                          icon={IconArchive}
                          onClick={() => void moveSelectedMessage("archive")}
                          disabled={moving}
                          title="Archive"
                        >
                          Archive
                        </ActionButton>
                        <ActionButton
                          icon={IconTrash}
                          variant="rose"
                          onClick={() => void moveSelectedMessage("trash")}
                          disabled={moving}
                          title="Move to Trash"
                        >
                          Trash
                        </ActionButton>
                      </>
                    )}
                    {section !== "sent" &&
                      section !== "drafts" &&
                      !showReplyForm && (
                      <>
                        <ActionButton
                          icon={IconReply}
                          variant="primary"
                          onClick={() => startReply("reply")}
                          disabled={!messageDetail}
                          title="Reply to sender only"
                        >
                          Reply
                        </ActionButton>
                        {canReplyAll && (
                          <ActionButton
                            icon={IconReply}
                            onClick={() => startReply("reply_all")}
                            title="Reply all — sender plus To/Cc/Bcc"
                          >
                            Reply all
                          </ActionButton>
                        )}
                        <ActionButton
                          icon={IconSend}
                          onClick={() => startForward()}
                          title="Forward this email — pick To and Cc contacts"
                        >
                          Forward
                        </ActionButton>
                        {aiAnalysis?.draft_reply ? (
                          <ActionButton
                            icon={IconSparkles}
                            variant="sky"
                            onClick={() => applyAiDraftToReplyForm(aiAnalysis)}
                            title="Use AI draft reply"
                          >
                            AI draft
                          </ActionButton>
                        ) : null}
                      </>
                    )}
                  </div>
                </div>
              </div>

              {(aiLoading || aiAnalysis) && (
                <div className="mx-4 mt-3 rounded-xl border border-sky-500/25 bg-sky-500/10 px-4 py-3 space-y-3 shrink-0">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div>
                      <p className="text-xs font-medium uppercase tracking-wide text-sky-300/90">
                        AI assistant
                      </p>
                      {aiLoading ? (
                        <p className="mt-1 text-sm text-slate-300">Reading this email…</p>
                      ) : (
                        <p className="mt-1 text-sm text-slate-200 leading-relaxed">
                          {aiAnalysis?.summary}
                        </p>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {messageDetail && (
                        <button
                          type="button"
                          onClick={() =>
                            void runMessageAnalyze(
                              messageDetail.uid,
                              messageDetail.folder || "INBOX",
                            )
                          }
                          disabled={aiLoading}
                          className="px-2.5 py-1 rounded-lg border border-sky-500/40 text-sky-200 text-xs hover:bg-sky-500/10 disabled:opacity-50"
                        >
                          Refresh analysis
                        </button>
                      )}
                      {section !== "sent" && aiAnalysis?.draft_reply && !showReplyForm && (
                        <button
                          type="button"
                          onClick={() => applyAiDraftToReplyForm(aiAnalysis)}
                          className="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium"
                        >
                          Edit &amp; send draft
                        </button>
                      )}
                    </div>
                  </div>
                  {aiAnalysis?.draft_reply && section !== "sent" && !showReplyForm && (
                    <div className="rounded-lg border border-slate-700/80 bg-slate-950/50 px-3 py-2">
                      <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">
                        Suggested reply
                        {aiAnalysis.source === "fallback" ? " (template)" : ""}
                      </p>
                      <pre className="whitespace-pre-wrap break-words text-sm text-slate-300 font-sans m-0 max-h-40 overflow-y-auto">
                        {aiAnalysis.draft_reply}
                      </pre>
                    </div>
                  )}
                </div>
              )}

              <div className="flex-1 overflow-y-auto min-h-0 px-4 py-4">
                <div className="rounded-2xl border border-slate-700 bg-slate-900/80 px-5 py-4 max-w-5xl">
                  <MessageBody message={messageDetail} />
                  <InboxAttachmentChips
                    message={messageDetail}
                    mailboxUserId={mailboxUserIdRef.current}
                    onError={onError}
                    className="mt-3 flex flex-wrap gap-1.5"
                  />
                </div>
              </div>

              {!showReplyForm && section !== "sent" && section !== "drafts" && (
                <div className="px-5 py-3 border-t border-slate-800 bg-slate-950/70 flex flex-wrap items-center gap-2 shrink-0">
                  <ActionButton
                    icon={IconReply}
                    variant="primary"
                    size="md"
                    onClick={() => startReply("reply")}
                    disabled={!messageDetail}
                    title="Reply to sender only"
                  >
                    Reply
                  </ActionButton>
                  {canReplyAll && (
                    <ActionButton
                      icon={IconReply}
                      size="md"
                      onClick={() => startReply("reply_all")}
                      title="Reply all — sender plus To/Cc/Bcc"
                    >
                      Reply all
                    </ActionButton>
                  )}
                  <ActionButton
                    icon={IconSend}
                    size="md"
                    onClick={() => startForward()}
                    title="Forward this email — pick To and Cc contacts"
                  >
                    Forward
                  </ActionButton>
                  <span className="text-xs text-slate-500">
                    Write a reply and send from your mailbox
                  </span>
                </div>
              )}

              {showReplyForm && section !== "sent" && section !== "drafts" && (
                <div className="px-5 py-4 border-t border-slate-800 space-y-2 bg-slate-950/50">
                  {notice && (
                    <div className="p-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-200 text-sm">
                      {notice}
                    </div>
                  )}
                  <div className="flex items-center gap-2 text-sm">
                    <span className="w-14 shrink-0 text-slate-500">To</span>
                    <input
                      type="email"
                      value={replyTo}
                      onChange={(e) => setReplyTo(e.target.value)}
                      className="flex-1 rounded-lg bg-slate-950 border border-slate-700 px-3 py-1.5 text-sm"
                    />
                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    <span className="w-14 shrink-0 text-slate-500">Cc</span>
                    <input
                      type="text"
                      value={replyCc}
                      onChange={(e) => setReplyCc(e.target.value)}
                      placeholder="optional"
                      className="flex-1 rounded-lg bg-slate-950 border border-slate-700 px-3 py-1.5 text-sm"
                    />
                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    <span className="w-14 shrink-0 text-slate-500">Bcc</span>
                    <input
                      type="text"
                      value={replyBcc}
                      onChange={(e) => setReplyBcc(e.target.value)}
                      placeholder="optional"
                      className="flex-1 rounded-lg bg-slate-950 border border-slate-700 px-3 py-1.5 text-sm"
                    />
                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    <span className="w-14 shrink-0 text-slate-500">Subject</span>
                    <input
                      type="text"
                      value={replySubjectLine}
                      onChange={(e) =>
                        setReplySubjectLine(capitalizeFirstLetter(e.target.value))
                      }
                      className="flex-1 rounded-lg bg-slate-950 border border-slate-700 px-3 py-1.5 text-sm"
                    />
                  </div>
                  <EmailBodyEditor
                    value={replyBody}
                    onChange={setReplyBody}
                    placeholder={
                      aiLoading && !replyBody.trim()
                        ? "Writing suggested reply…"
                        : "Write your reply…"
                    }
                    rows={7}
                    onAttachClick={() => replyFileInputRef.current?.click()}
                    attachmentCount={replyAttachments.length}
                    isUploadingAttachment={uploadingAttachment}
                  />
                  <AttachedFilesList
                    attachments={replyAttachments}
                    onRemove={handleRemoveReplyAttachment}
                    onClearAll={() => setReplyAttachments([])}
                    uploading={uploadingAttachment}
                  />
                  <div className="flex items-center justify-between gap-2 pt-1">
                    <div className="flex items-center gap-2">
                      <ActionButton
                        icon={IconPaperclip}
                        size="md"
                        variant="secondary"
                        onClick={() => replyFileInputRef.current?.click()}
                        disabled={sending || uploadingAttachment}
                        title="Attach Document / Files"
                      >
                        {uploadingAttachment ? "Attaching…" : "Attach Document"}
                      </ActionButton>
                      <ActionButton
                        icon={IconBookOpen}
                        size="md"
                        variant="secondary"
                        onClick={() => setShowAttachCatalogue(true)}
                        disabled={sending || uploadingAttachment}
                        title="Attach Official Catalogue / Price List"
                      >
                        Attach Catalogue
                      </ActionButton>
                      {replyAttachments.length > 0 && (
                        <span className="text-xs text-emerald-400 font-medium">
                          {replyAttachments.length} attached
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <ActionButton
                        icon={IconX}
                        size="md"
                        onClick={() => {
                          setShowReplyForm(false);
                          setReplyBody("");
                          setReplyBcc("");
                          setReplyAttachments([]);
                          setNotice(null);
                        }}
                        title="Cancel"
                      >
                        Cancel
                      </ActionButton>
                      <ActionButton
                        icon={IconSend}
                        variant="primary"
                        size="md"
                        onClick={() => void sendReply()}
                        disabled={
                          sending ||
                          !emailBodyHasContent(replyBody) ||
                          !replyTo.trim() ||
                          uploadingAttachment
                        }
                        title="Send reply"
                      >
                        {sending
                          ? "Sending…"
                          : replyAttachments.length > 0
                            ? `Send reply (${replyAttachments.length} file${replyAttachments.length > 1 ? "s" : ""})`
                            : "Send reply"}
                      </ActionButton>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center text-slate-500 text-sm">
              Message not found.
            </div>
          )}
        </div>
      </div>

      <input
        type="file"
        ref={replyFileInputRef}
        onChange={handleReplyFileUpload}
        multiple
        className="hidden"
        accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.jpg,.jpeg,.png,.webp,.gif"
      />

      {showAttachCatalogue && (
        <AttachCatalogueModal
          onClose={() => setShowAttachCatalogue(false)}
          onAttach={(newAtts) => setReplyAttachments((prev) => [...prev, ...newAtts])}
          onError={onError}
        />
      )}

      {showForwardPicker && (
        <ComposeRecipientsPickerModal
          onClose={() => setShowForwardPicker(false)}
          onError={onError}
          onContinue={({ to, cc }) => {
            setShowForwardPicker(false);
            const fwd = forwardDraftRef.current;
            setComposeDraft({
              id: 0,
              to_addrs: to.join(", "),
              cc_addrs: cc.join(", "),
              subject: fwd?.subject || "Fwd:",
              body: fwd?.body || "",
              created_at: "",
              updated_at: "",
              attachments: fwd?.attachments || [],
            });
            setShowCompose(true);
          }}
        />
      )}

      {showComposeRecipients && (
        <ComposeRecipientsPickerModal
          onClose={() => setShowComposeRecipients(false)}
          onError={onError}
          onContinue={({ to, cc }) => {
            setShowComposeRecipients(false);
            const toStr = to.join(", ");
            const ccStr = cc.join(", ");
            // Live: open Vercel mailer with To/Cc prefilled.
            // Localhost: in-app compose so Email Activity logs to this backend.
            if (onOpenMailerCompose && !import.meta.env.DEV) {
              onOpenMailerCompose({ to: toStr, cc: ccStr });
              return;
            }
            setComposeDraft({
              id: 0,
              to_addrs: toStr,
              cc_addrs: ccStr,
              subject: "",
              body: "",
              created_at: "",
              updated_at: "",
            });
            setShowCompose(true);
          }}
        />
      )}

      {showCompose && (
        <ComposeMailModal
          fromEmail={status?.email || status?.emails?.[0] || "Your mailbox"}
          mailboxUserId={mailboxUserIdRef.current}
          initialDraft={composeDraft}
          onClose={() => {
            setShowCompose(false);
            setComposeDraft(null);
            if (isDraftsView) void loadList({ silent: true });
          }}
          onDraftSaved={() => {
            onMailExtrasChangeRef.current?.();
            if (isDraftsView) void loadList({ silent: true });
          }}
          onDraftDiscarded={() => {
            setNotice("Draft discarded.");
            onMailExtrasChangeRef.current?.();
            void loadList({ silent: true });
          }}
          onSent={(message) => {
            setNotice(message);
            setComposeDraft(null);
            void loadList({ silent: true });
            void refreshFolderCounts();
            onMailExtrasChangeRef.current?.();
          }}
          onError={onError}
        />
      )}
    </section>
  );
}
