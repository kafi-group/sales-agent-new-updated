import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IndexAction } from "./data/indexSections";
import { sumWhatsAppInboxUnread } from "./utils/whatsappRead";
import { pushNumberToFloatingDialpad } from "./utils/dialpadEvents";
import {
  client,
  QUOTATION_AGENT_URL,
  sanitizeUserFacingError,
  type AppUser,
  type CustomLeadModule,
  type LeadTableSectionCountsResponse,
} from "./api/client";
import { useAuth } from "./auth/AuthContext";
import { WORKSPACE_HIDDEN_TABLE_SECTIONS } from "./auth/session";
import {
  AppSidebar,
  assignedUserIdFromSection,
  isAssignedLeadsSection,
  mailLabelIdFromSection,
  type LeadsTableSection,
  type MailSection,
  type NavItem,
  type Tab,
  type WhatsAppSection,
} from "./components/AppSidebar";
import { mailLabelSectionId } from "./lib/mailLabelRules";
import { displayDashboardUserLabel } from "./utils/displayUserName";
import { canOpenRestrictedAiTab } from "./lib/aiToolsGate";
import {
  snapshotLeadForAiResearch,
  type AiResearchContactSnapshot,
} from "./utils/aiResearchUpdate";
import {
  listAiResearchLog,
  type AiResearchLogEntry,
} from "./utils/aiResearchLog";
import { AiResearchLogModal } from "./components/AiResearchLogModal";
import { AiSalesAgentLogsModal } from "./components/AiSalesAgentLogsModal";
import { stashPendingAiResearchFind } from "./utils/aiResearchPendingFind";
import { InboxAlertToasts } from "./components/InboxAlertToasts";
import { UrgentEmailAlertModal, isGenuineNewInquiry } from "./components/UrgentEmailAlertModal";
import { WorkspaceAiAutopilotButton } from "./components/WorkspaceAiAutopilotButton";
import { ManageModulesModal } from "./components/ManageModulesModal";
import type { UrgentEmailItem } from "./api/client";
import { WhatsAppAlertToasts } from "./components/WhatsAppAlertToasts";
import { InterestedFollowUpAlertToasts } from "./components/InterestedFollowUpAlertToasts";
import { QuotationMeetingAlertToasts } from "./components/QuotationMeetingAlertToasts";
import { InterestedClientsActivityToasts } from "./components/InterestedClientsActivityToasts";
import { AppTopActions } from "./components/AppTopActions";
import { IconWhatsApp } from "./components/icons/AppIcons";
import { APP_BRAND_NAME } from "./brand";
import { EmailActivityPage } from "./pages/EmailActivityPage";
import { EmailTemplatesPage } from "./pages/EmailTemplatesPage";
import { WhatsAppTemplatesPage } from "./pages/WhatsAppTemplatesPage";
import { WhatsAppInboxPage } from "./pages/WhatsAppInboxPage";
import { WhatsAppMobilePage } from "./pages/WhatsAppMobilePage";
import { TelegramMobilePage } from "./pages/TelegramMobilePage";
import { TelegramTemplatesPage } from "./pages/TelegramTemplatesPage";
import { BuyerProfile } from "./pages/BuyerProfile";
import { CallsPage } from "./pages/CallsPage";
import { InboxPage } from "./pages/InboxPage";
import { AiModePage } from "./pages/AiModePage";
import { AiSalesAgentPage } from "./pages/AiSalesAgentPage";
import { AiTrainPage } from "./pages/AiTrainPage";
import { IndexesPage } from "./pages/IndexesPage";
import { UserManualPage } from "./pages/UserManualPage";
import { LeadsPage } from "./pages/LeadsPage";
import { DataSynthesisPage } from "./pages/DataSynthesisPage";
import { TargetWorkspacePage } from "./pages/TargetWorkspacePage";
import { LeadsTablePage } from "./pages/LeadsTablePage";
import { ClientHistoryPage } from "./pages/ClientHistoryPage";
import { HelpfulGuidancePage } from "./pages/HelpfulGuidancePage";
import { HorekaPage } from "./pages/HorekaPage";
import { CataloguePage } from "./pages/CataloguePage";
import { ChatbotPage } from "./pages/ChatbotPage";
import { KpiPage } from "./pages/KpiPage";
import { LoginPage } from "./pages/LoginPage";
import { UsersPage } from "./pages/UsersPage";
import { SettingsPage } from "./pages/SettingsPage";
import { TwilioVoiceProvider, useTwilioVoiceOptional } from "./hooks/useTwilioVoice";
import { CallQueueProvider } from "./hooks/useCallQueue";
import { PostCallRemarksModal } from "./components/PostCallRemarksModal";
import { CallingCardOverlay } from "./components/CallingCardOverlay";
import { BulkCallQueueHost } from "./components/BulkCallQueueHost";
import { FloatingDialpad } from "./components/FloatingDialpad";
import { FloatingSalesAssistant, OPEN_SALES_ASSISTANT_EVENT } from "./components/FloatingSalesAssistant";
import {
  alertInterestedFollowUp,
  alertInterestedClientsActivity,
  alertNewInboxMessage,
  alertNewWhatsAppMessage,
  alertQuotationMeeting,
  getNotificationMode,
  requestNotificationPermission,
  unlockNotificationAudio,
} from "./utils/notify";
import { startHandsFreeEmailReader } from "./utils/handsFreeEmailReader";
import { HandsFreeEmailReaderHost } from "./components/HandsFreeEmailReaderHost";


const INBOX_POLL_INTERVAL_MS = 20_000;
const WHATSAPP_POLL_INTERVAL_MS = 15_000;
const FOLLOW_UP_POLL_INTERVAL_MS = 60_000;
const MEETING_POLL_INTERVAL_MS = 60_000;
const INTERESTED_ACTIVITY_POLL_INTERVAL_MS = 30_000;
const SIDEBAR_OPEN_KEY = "kafi_sidebar_open";

function readSidebarOpenPreference(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_OPEN_KEY) !== "false";
  } catch {
    return true;
  }
}

function CallInitBanner() {
  const voice = useTwilioVoiceOptional();
  if (!voice) return null;

  if (voice.callError) {
    return (
      <div className="mb-7 p-4 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-100 text-sm">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="font-medium">Call did not connect</p>
            <p className="mt-1 text-rose-200/85">{voice.callError}</p>
            <p className="mt-2 text-xs text-rose-200/60">
              Twilio Console → Monitor → Logs (error on Voice URL), Voice → Settings → Geo
              Permissions (enable the lead’s country), and confirm TwiML App Voice URL is your
              Railway API{" "}
              <code className="text-rose-100/80">/api/webhooks/twilio/voice/client-dial</code>.
            </p>
          </div>
          <button
            type="button"
            onClick={() => voice.clearCallError()}
            className="shrink-0 rounded-md border border-rose-500/40 px-2 py-1 text-xs text-rose-100 hover:bg-rose-500/20"
          >
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  if (!voice.initError) return null;
  const micFail = /31402|AcquisitionFailed|getting the media failed/i.test(voice.initError);
  return (
    <div className="mb-7 p-4 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-100 text-sm">
      <p className="font-medium">Browser calling is not ready</p>
      <p className="mt-1 text-amber-200/80">{voice.initError}</p>
      <p className="mt-2 text-xs text-amber-200/60">
        {micFail
          ? "Microphone access failed after permission was granted. Close other apps using the mic (Zoom/Teams/WhatsApp), use Chrome/Edge on HTTPS, unplug/replug the headset, then refresh and try again."
          : "Refresh the page, or open Calls and try again in a moment. Railway may still be warming up."}
      </p>
    </div>
  );
}

function DashboardApp() {
  const {
    user,
    isAdmin,
    isWorkspaceOnlySalesUser,
    logout,
    impersonating,
    impersonatorLabel,
    switchBackToAdmin,
  } = useAuth();
  const [tab, setTab] = useState<Tab>("inbox");
  const [tableSection, setTableSection] = useState<LeadsTableSection>("master");
  const [masterType, setMasterType] = useState<string>("fmcg");
  const [mailSection, setMailSection] = useState<MailSection>("inbox");
  const [focusEditLeadId, setFocusEditLeadId] = useState<number | null>(null);
  const [focusEditCompany, setFocusEditCompany] = useState<string | null>(null);
  const [aiResearchContacts, setAiResearchContacts] = useState<
    AiResearchContactSnapshot[] | null
  >(null);
  const [aiResearchReturnSection, setAiResearchReturnSection] =
    useState<LeadsTableSection | null>(null);
  const [aiResearchRestoreIds, setAiResearchRestoreIds] = useState<number[] | null>(null);
  const [aiResearchRestoreSearch, setAiResearchRestoreSearch] = useState<string | null>(null);
  const [showAiResearchLog, setShowAiResearchLog] = useState(false);
  const [aiResearchLogEntries, setAiResearchLogEntries] = useState<AiResearchLogEntry[]>([]);
  const [showAiSalesAgentLog, setShowAiSalesAgentLog] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(readSidebarOpenPreference);
  const [mailDraftCount, setMailDraftCount] = useState(0);
  const [horekaCategory, setHorekaCategory] = useState<string>("All");
  const [catalogueId, setCatalogueId] = useState<string>("all_products");
  const [mailLabels, setMailLabels] = useState<
    Array<{ id: number; name: string; color: string; count: number; is_system?: boolean }>
  >([]);
  const [tableCounts, setTableCounts] = useState<LeadTableSectionCountsResponse>({
    all: 0,
    old_clients: 0,
    interested_clients: 0,
    sales_interested_clients: 0,
    not_interested_clients: 0,
    not_received_call_clients: 0,
    master: 0,
    hyperstore_targeted: 0,
    targeted_distributor: 0,
    targeted_client: 0,
    schedule_meeting: 0,
    khalid_focused_sales: 0,
    incomplete_archives: 0,
    my_assigned: 0,
    all_contacts: 0,
    by_assignee: {},
  });
  const [assigneeNavUsers, setAssigneeNavUsers] = useState<AppUser[]>([]);
  const [mailCounts, setMailCounts] = useState({
    inbox: 0,
    sent: 0,
    trash: 0,
    junk: 0,
    archive: 0,
  });
  const [leadsTableRefreshToken, setLeadsTableRefreshToken] = useState(0);
  const [selectedLeadId, setSelectedLeadId] = useState<number | null>(null);
  const [pendingWhatsAppContactId, setPendingWhatsAppContactId] = useState<number | null>(
    null,
  );
  const [error, setErrorState] = useState<string | null>(null);
  const [reconnectingDb, setReconnectingDb] = useState(false);
  useEffect(() => {
    // Keepalive ping every 2 minutes to keep Railway container warm 24/7
    const interval = setInterval(() => {
      client.listProductTypes().catch(() => {});
    }, 120000);
    return () => clearInterval(interval);
  }, []);

  const setError = useCallback((message: string | null) => {
    setErrorState(message == null ? null : sanitizeUserFacingError(message));
  }, []);
  const [emailActivityUnread, setEmailActivityUnread] = useState(0);
  const [whatsappActivityUnread, setWhatsappActivityUnread] = useState(0);
  const [whatsappInboxUnread, setWhatsappInboxUnread] = useState(0);
  const [emailTemplateCount, setEmailTemplateCount] = useState(0);
  const [, setPersonalizedEmailCount] = useState(0);
  const [whatsappTemplateCount, setWhatsappTemplateCount] = useState(0);
  const [, setDiscoverLeadsCount] = useState(0);

  const [inboxUnread, setInboxUnread] = useState(0);
  const [urgentEmails, setUrgentEmails] = useState<UrgentEmailItem[]>([]);
  const [urgentAlertDismissed, setUrgentAlertDismissed] = useState(false);
  const [targetThreadId, setTargetThreadId] = useState<string | null>(null);
  const [targetMailboxUserId, setTargetMailboxUserId] = useState<number | null>(null);
  const isAsimUser =
    (user?.username || "").trim().toLowerCase() === "asim" ||
    (user?.username || "").trim().toLowerCase().startsWith("asim") ||
    (user?.full_name || "").trim().toLowerCase().includes("asim");
  const [asimMailboxes, setAsimMailboxes] = useState<
    Array<{ user_id: number; email: string; display_name?: string | null }>
  >([]);
  const [asimActiveMailboxUserId, setAsimActiveMailboxUserId] = useState<number | null>(null);

  useEffect(() => {
    if (!isAsimUser) {
      setAsimMailboxes([]);
      setAsimActiveMailboxUserId(null);
      return;
    }
    let cancelled = false;
    void client
      .listInboxSwitchableMailboxes()
      .then((res) => {
        if (cancelled) return;
        const rows = res.mailboxes || [];
        setAsimMailboxes(rows);
        const stored = Number(sessionStorage.getItem("asim-inbox-mailbox-user-id") || "");
        const fromStorage = rows.find((r) => r.user_id === stored);
        const preferred =
          fromStorage ||
          rows.find((r) => (r.email || "").toLowerCase() === "marketing@kafi-group.com") ||
          rows[0] ||
          null;
        if (preferred) {
          setAsimActiveMailboxUserId(preferred.user_id);
          sessionStorage.setItem("asim-inbox-mailbox-user-id", String(preferred.user_id));
        }
      })
      .catch(() => {
        if (!cancelled) setAsimMailboxes([]);
      });
    return () => {
      cancelled = true;
    };
  }, [isAsimUser]);

  const asimMailboxSwitcher =
    isAsimUser && tab === "inbox" && asimMailboxes.length > 1 ? (
      <label className="flex items-center gap-2 min-w-0 flex-1 max-w-md">
        <span className="text-xs text-slate-400 shrink-0 hidden sm:inline">Mailbox</span>
        <select
          value={asimActiveMailboxUserId ?? ""}
          onChange={(e) => {
            const next = Number(e.target.value);
            if (!Number.isFinite(next)) return;
            setAsimActiveMailboxUserId(next);
            sessionStorage.setItem("asim-inbox-mailbox-user-id", String(next));
            setTargetThreadId(null);
            setTargetMailboxUserId(null);
            setError(null);
          }}
          className="w-full min-w-0 rounded-lg border border-emerald-500/40 bg-slate-900 px-3 py-1.5 text-xs sm:text-sm text-slate-100 focus:outline-none focus:ring-1 focus:ring-emerald-500/60"
          title="Switch mailbox (Asim only)"
        >
          {asimMailboxes.map((box) => (
            <option key={box.user_id} value={box.user_id}>
              {box.email}
            </option>
          ))}
        </select>
      </label>
    ) : null;
  const [autoOpenReply, setAutoOpenReply] = useState(false);
  const seenMessageUidsRef = useRef<Set<string> | null>(null);
  const lastInboxUnreadRef = useRef(0);
  const seenWhatsAppKeysRef = useRef<Set<string> | null>(null);
  const whatsappPollInflightRef = useRef(false);
  const seenFollowUpIdsRef = useRef<Set<string>>(new Set());
  const seenMeetingAlertIdsRef = useRef<Set<string>>(new Set());
  const seenInterestedActivityIdRef = useRef<number | null>(null);

  useEffect(() => {
    const onExpired = () => {
      void logout();
    };
    window.addEventListener("kafi:auth-expired", onExpired);
    return () => window.removeEventListener("kafi:auth-expired", onExpired);
  }, [logout]);

  useEffect(() => {
    if (!isAdmin && tab === "users") {
      setTab("inbox");
    }
    if (!isAdmin && tab === "settings") {
      setTab("inbox");
    }
    if ((tab === "ai-mode" || tab === "leads") && !canOpenRestrictedAiTab(isAdmin)) {
      setTab(isAdmin ? "settings" : "inbox");
    }
  }, [isAdmin, tab]);

  useEffect(() => {
    if (!isWorkspaceOnlySalesUser) return;
    if (
      (WORKSPACE_HIDDEN_TABLE_SECTIONS as readonly string[]).includes(tableSection)
    ) {
      setTableSection("my_assigned");
      setTab("target-workspace");
    }
  }, [isWorkspaceOnlySalesUser, tableSection]);

  useEffect(() => {
    if (tab !== "master-table") return;
    setTab("table");
    setTableSection("master");
    setSelectedLeadId(null);
  }, [tab]);

  const loadDiscoverLeadsCount = useCallback(async () => {
    try {
      const result = await client.listLeads({ page: 1, page_size: 1 });
      setDiscoverLeadsCount(result.total);
    } catch {
      setDiscoverLeadsCount(0);
    }
  }, []);

  const loadEmailTemplateCount = useCallback(async () => {
    try {
      const rows = await client.listEmailTemplates();
      setEmailTemplateCount(rows.length);
    } catch {
      setEmailTemplateCount(0);
    }
  }, []);

  const loadWhatsappTemplateCount = useCallback(async () => {
    try {
      const rows = await client.listWhatsAppTemplates();
      setWhatsappTemplateCount(rows.filter((t) => t.status === "approved").length);
    } catch {
      setWhatsappTemplateCount(0);
    }
  }, []);

  const loadTableCounts = useCallback(async () => {
    try {
      const counts = await client.getLeadsTableSectionCounts(masterType);
      setTableCounts({
        ...counts,
        by_assignee: counts.by_assignee ?? {},
      });
    } catch {
      /* optional badges */
    }
  }, [masterType]);

  const [customModules, setCustomModules] = useState<CustomLeadModule[]>([]);
  const [showManageModulesModal, setShowManageModulesModal] = useState(false);

  const loadCustomModules = useCallback(async () => {
    try {
      const list = await client.listCustomModules(false, masterType);
      setCustomModules(list);
    } catch {
      /* ignore */
    }
  }, [masterType]);

  const loadAssigneeNavUsers = useCallback(async () => {
    try {
      const users = await client.listAssignees();
      setAssigneeNavUsers(users);
    } catch {
      setAssigneeNavUsers([]);
    }
  }, []);

  const loadMailCounts = useCallback(async () => {
    try {
      const result = await client.listInboxFolders();
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
      setMailCounts(next);
    } catch {
      /* optional badges */
    }
  }, []);

  const loadMailExtras = useCallback(async () => {
    try {
      const mailboxId = isAsimUser ? asimActiveMailboxUserId : null;
      const [drafts, labels, personalized] = await Promise.all([
        client.getMailDraftCount(),
        client.listMailLabels(mailboxId),
        client.listPersonalizedFollowups({ limit: 1 }).catch(() => null),
      ]);
      setMailDraftCount(drafts.count);
      setMailLabels(labels);
      if (personalized) setPersonalizedEmailCount(personalized.pending_count);
    } catch {
      /* optional badges */
    }
  }, [asimActiveMailboxUserId, isAsimUser]);

  const handleDeleteMailLabel = useCallback(
    async (labelId: number) => {
      const label = mailLabels.find((row) => row.id === labelId);
      const name = label?.name || "this label";
      if (
        !window.confirm(
          `Delete label “${name}”? No emails will be removed from the mailbox — only the label and its grouping.`,
        )
      ) {
        return;
      }
      try {
        await client.deleteMailLabel(labelId);
        if (mailLabelIdFromSection(mailSection) === labelId) {
          setMailSection("inbox");
        }
        await loadMailExtras();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to delete label");
      }
    },
    [loadMailExtras, mailLabels, mailSection, setError],
  );

  const pollInbox = useCallback(() => {
    const mailboxOverride =
      isAsimUser && asimActiveMailboxUserId != null ? asimActiveMailboxUserId : null;
    client
      .getInboxStatus(mailboxOverride)
      .then((status) => {
        if (!status.configured) {
          seenMessageUidsRef.current = null;
          lastInboxUnreadRef.current = 0;
          setInboxUnread(0);
          return;
        }
        const previousUnread = lastInboxUnreadRef.current;
        lastInboxUnreadRef.current = status.unread_count;
        setInboxUnread(status.unread_count);

        // Only pull a message list when unread goes up — avoid downloading mail
        // on every badge poll just to detect new arrivals.
        if (status.unread_count <= previousUnread && seenMessageUidsRef.current !== null) {
          return;
        }

        return client
          .listInboxMessages({ limit: 15, mailbox_user_id: mailboxOverride })
          .then((result) => {
          const messages = result.items;
          const currentUids = new Set(messages.map((m) => m.uid));
          const seen = seenMessageUidsRef.current;

          if (seen === null) {
            seenMessageUidsRef.current = currentUids;
            return;
          }

          const newMessages = messages.filter((m) => !seen.has(m.uid));
          if (newMessages.length > 0) {
            const first = newMessages[0];
            alertNewInboxMessage({
              from: first.from_name || first.from_email,
              subject: first.subject,
              count: newMessages.length,
            });
            if (getNotificationMode() === "handsfree_email") {
              const mailboxId = mailboxOverride;
              void (async () => {
                try {
                  const items = await Promise.all(
                    newMessages.slice(0, 10).map(async (m) => {
                      try {
                        const detail = await client.getInboxMessage(
                          m.uid,
                          m.folder || "inbox",
                          mailboxId,
                        );
                        return {
                          uid: m.uid,
                          folder: m.folder || "inbox",
                          from:
                            detail.from_name ||
                            detail.from_email ||
                            m.from_name ||
                            m.from_email ||
                            "Unknown",
                          subject: detail.subject || m.subject || "(no subject)",
                          body:
                            detail.body_text ||
                            detail.preview ||
                            m.preview ||
                            "",
                        };
                      } catch {
                        return {
                          uid: m.uid,
                          folder: m.folder || "inbox",
                          from: m.from_name || m.from_email || "Unknown",
                          subject: m.subject || "(no subject)",
                          body: m.preview || "",
                        };
                      }
                    }),
                  );
                  await startHandsFreeEmailReader(items);
                } catch {
                  /* never block inbox polling */
                }
              })();
            }
          }

          seenMessageUidsRef.current = currentUids;
        });
      })
      .catch(() => {
        /* mailbox may be unconfigured — ignore */
      });
  }, [isAsimUser, asimActiveMailboxUserId]);

  const openUrgentAlerts = useCallback(() => {
    setUrgentAlertDismissed(false);
    client
      .getUrgentUnrepliedEmails()
      .then((res) => {
        const list = (res.urgent_threads || []).filter(isGenuineNewInquiry);
        setUrgentEmails(list);
        if (list.length === 0) {
          setError("No urgent inquiry emails right now.");
        }
      })
      .catch(() => {
        setError("Could not load urgent emails. Try again in a moment.");
      });
  }, [setError]);

  const urgentHeaderButton = (
    <button
      type="button"
      onClick={() => openUrgentAlerts()}
      className={`shrink-0 inline-flex items-center gap-1.5 rounded-md border border-red-500/70 bg-red-600/90 px-2.5 py-1 text-[11px] sm:text-xs font-bold uppercase tracking-wide text-white shadow-md shadow-red-950/40 hover:bg-red-500 ${
        urgentEmails.length > 0 ? "animate-pulse" : ""
      }`}
      title="Open urgent inquiry alerts"
    >
      <span aria-hidden>🚨</span>
      Urgent
      {urgentEmails.length > 0 ? (
        <span className="rounded-full bg-white/20 px-1.5 py-0.5 text-[10px] font-black tabular-nums">
          {urgentEmails.length > 99 ? "99+" : urgentEmails.length}
        </span>
      ) : null}
    </button>
  );

  const aiResearchLogsHeaderButton =
    tab === "chatbot" ? (
      <button
        type="button"
        onClick={() => {
          setAiResearchLogEntries(listAiResearchLog());
          setShowAiResearchLog(true);
        }}
        className="shrink-0 inline-flex items-center gap-1.5 rounded-md border border-amber-500/50 bg-amber-500/15 px-2.5 py-1 text-[11px] sm:text-xs font-semibold text-amber-100 hover:bg-amber-500/25"
        title="AI Research activity log"
      >
        Logs
      </button>
    ) : tab === "ai-sales-agent" ? (
      <button
        type="button"
        onClick={() => {
          setError(null);
          setShowAiSalesAgentLog(true);
        }}
        className="shrink-0 inline-flex items-center gap-1.5 rounded-md border border-amber-500/50 bg-amber-500/15 px-2.5 py-1 text-[11px] sm:text-xs font-semibold text-amber-100 hover:bg-amber-500/25"
        title="AI Sales Agent assign vs process-start log"
      >
        Logs
      </button>
    ) : null;

  const returnToTableWithSelection = useCallback(
    (leadIds: number[], section?: string | null, searchHint?: string | null) => {
      const nextSection = (section || aiResearchReturnSection || tableSection) as LeadsTableSection;
      const ids = leadIds.filter((id) => id > 0);
      const hint =
        (searchHint || "").trim() ||
        (ids.length ? String(ids[0]) : "");
      setShowAiResearchLog(false);
      setAiResearchContacts(null);
      setAiResearchReturnSection(null);
      // Persist before tab switch so remount / Strict Mode cannot keep the previous search.
      if (ids.length && hint) {
        stashPendingAiResearchFind(ids, hint, nextSection);
        setAiResearchRestoreIds(ids);
        setAiResearchRestoreSearch(hint);
      } else {
        setAiResearchRestoreIds(null);
        setAiResearchRestoreSearch(null);
      }
      setTableSection(nextSection);
      setLeadsTableRefreshToken((t) => t + 1);
      setTab("table");
    },
    [aiResearchReturnSection, tableSection],
  );

  const pollUrgentEmails = useCallback(() => {
    client
      .getUrgentUnrepliedEmails()
      .then((res) => {
        const list = (res.urgent_threads || []).filter(isGenuineNewInquiry);
        setUrgentEmails(list);
        if (list.length === 0) {
          setUrgentAlertDismissed(false);
        }
      })
      .catch(() => {
        /* mailbox may be unconfigured — ignore */
      });
  }, []);

  const handleOpenUrgentAndReply = useCallback((item: UrgentEmailItem) => {
    setTargetThreadId(item.thread_id);
    setTargetMailboxUserId(item.user_id ?? null);
    setAutoOpenReply(true);
    setMailSection("inbox");
    setTab("inbox");
    setUrgentAlertDismissed(true);
  }, []);

  const pollWhatsAppInbox = useCallback(() => {
    if (whatsappPollInflightRef.current) return;
    whatsappPollInflightRef.current = true;
    client
      .listWhatsAppConversations({ page: 1, page_size: 20 })
      .then((result) => {
        const rows = result.rows || [];
        const inboxUnreadTotal = sumWhatsAppInboxUnread(rows);
        setWhatsappInboxUnread(inboxUnreadTotal);

        const inbound = rows.filter(
          (row) => row.last_direction === "inbound" && row.last_message_at,
        );
        const currentKeys = new Set(
          inbound.map((row) => `${row.contact_id}:${row.last_message_at}`),
        );
        const seen = seenWhatsAppKeysRef.current;

        if (seen === null) {
          seenWhatsAppKeysRef.current = currentKeys;
          return;
        }

        const fresh = inbound.filter(
          (row) => !seen.has(`${row.contact_id}:${row.last_message_at}`),
        );
        if (fresh.length > 0) {
          const first = fresh[0];
          const label =
            first.contact_name?.trim() ||
            first.company_name?.trim() ||
            first.contact_phone ||
            "WhatsApp contact";
          alertNewWhatsAppMessage({
            from: label,
            preview: first.last_message,
            count: fresh.length,
            contactId: first.contact_id,
          });
        }

        seenWhatsAppKeysRef.current = currentKeys;
      })
      .catch(() => {
        /* WhatsApp may be unconfigured — ignore */
      })
      .finally(() => {
        whatsappPollInflightRef.current = false;
      });
  }, []);

  const pollInterestedFollowUps = useCallback(() => {
    client
      .listInterestedFollowUps()
      .then((reminders) => {
        const seen = seenFollowUpIdsRef.current;
        for (const reminder of reminders) {
          if (seen.has(reminder.id)) continue;
          seen.add(reminder.id);
          alertInterestedFollowUp({
            id: reminder.id,
            buyerId: reminder.buyer_id,
            companyName: reminder.company_name,
            contactName: reminder.contact_name,
            dueAt: reminder.due_at,
            daysSincePlacement: reminder.days_since_placement ?? 0,
            tableSection:
              reminder.table_section === "not_received_call_clients"
                ? "not_received_call_clients"
                : reminder.table_section === "sales_interested_clients"
                  ? "sales_interested_clients"
                  : "interested_clients",
          });
        }
      })
      .catch(() => {
        /* optional */
      });
  }, []);

  const pollQuotationMeetings = useCallback(() => {
    client
      .listQuotationMeetingAlerts()
      .then((result) => {
        const seen = seenMeetingAlertIdsRef.current;
        for (const alert of result.alerts || []) {
          if (seen.has(alert.id)) continue;
          seen.add(alert.id);
          alertQuotationMeeting({
            id: alert.id,
            buyerId: alert.buyer_id,
            companyName: alert.company_name,
            contactName: alert.contact_name,
            meetingAt: alert.meeting_at,
            minutesUntil: alert.minutes_until,
          });
        }
      })
      .catch(() => {
        /* optional */
      });
  }, []);

  const pollInterestedClientsActivity = useCallback(() => {
    const afterId = seenInterestedActivityIdRef.current;
    client
      .listAiModeInterestedActivities({
        after_id: afterId ?? undefined,
        limit: 50,
      })
      .then((data) => {
        if (afterId === null) {
          seenInterestedActivityIdRef.current = data.latest_id ?? 0;
          return;
        }

        const newRows = data.rows || [];
        seenInterestedActivityIdRef.current = data.latest_id ?? afterId;

        if (newRows.length === 0) return;

        if (isAdmin) {
          const grouped = new Map<
            number,
            { label: string; count: number; companies: string[] }
          >();
          for (const row of newRows) {
            const current = grouped.get(row.user_id) || {
              label: row.user_label,
              count: 0,
              companies: [],
            };
            current.count += 1;
            if (row.company_name) current.companies.push(row.company_name);
            grouped.set(row.user_id, current);
          }
          for (const [userId, group] of grouped) {
            const message =
              group.count === 1
                ? `${group.label} added ${group.companies[0] || "a client"} to Interested Clients`
                : `${group.label} added ${group.count} clients to Interested Clients`;
            alertInterestedClientsActivity({
              id: `interested-admin-${userId}-${data.latest_id}-${group.count}`,
              message,
              count: group.count,
              isSelf: false,
              userLabel: group.label,
            });
          }
          return;
        }

        const message =
          newRows.length === 1
            ? `You added ${newRows[0].company_name || "a client"} to Interested Clients`
            : `You added ${newRows.length} clients to Interested Clients`;
        alertInterestedClientsActivity({
          id: `interested-self-${data.latest_id}-${newRows.length}`,
          message,
          count: newRows.length,
          isSelf: true,
        });
      })
      .catch(() => {
        /* optional */
      });
  }, [isAdmin]);

  useEffect(() => {
    if (!isAsimUser) return;
    void loadMailExtras();
  }, [asimActiveMailboxUserId, isAsimUser, loadMailExtras]);

  const refreshAll = useCallback(() => {
    setError(null);
    void loadDiscoverLeadsCount();
    void loadTableCounts();
    void loadCustomModules();
    void loadAssigneeNavUsers();
    void loadMailCounts();
    void loadMailExtras();
    void loadEmailTemplateCount();
    void loadWhatsappTemplateCount();
    client
      .getEmailActivityUnreadCount("email")
      .then((r) => setEmailActivityUnread(r.unread_count))
      .catch(() => setEmailActivityUnread(0));
    client
      .getEmailActivityUnreadCount("whatsapp")
      .then((r) => setWhatsappActivityUnread(r.unread_count))
      .catch(() => setWhatsappActivityUnread(0));
    pollInbox();
    pollUrgentEmails();
    pollWhatsAppInbox();
    pollInterestedFollowUps();
    pollQuotationMeetings();
    pollInterestedClientsActivity();
  }, [
    loadDiscoverLeadsCount,
    loadEmailTemplateCount,
    loadWhatsappTemplateCount,
    loadMailCounts,
    loadMailExtras,
    loadTableCounts,
    loadCustomModules,
    loadAssigneeNavUsers,
    pollInbox,
    pollUrgentEmails,
    pollWhatsAppInbox,
    pollInterestedFollowUps,
    pollQuotationMeetings,
    pollInterestedClientsActivity,
  ]);

  const handleReconnectDb = useCallback(async () => {
    if (reconnectingDb) return;
    setReconnectingDb(true);
    setError(null);
    try {
      const result = await client.reconnectDatabase();
      setLeadsTableRefreshToken((n) => n + 1);
      refreshAll();
      window.alert(
        result.note ||
          "Database reconnected. If lists are still empty, hard-refresh the page.",
      );
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Could not reconnect. If you see 502, open Settings → Restart Railway backend.",
      );
    } finally {
      setReconnectingDb(false);
    }
  }, [reconnectingDb, refreshAll, setError]);

  useEffect(() => {
    void Promise.all([
      loadTableCounts(),
      loadCustomModules(),
      loadAssigneeNavUsers(),
      loadMailCounts(),
      loadMailExtras(),
      loadDiscoverLeadsCount(),
      loadEmailTemplateCount(),
      loadWhatsappTemplateCount(),
    ]);
    requestNotificationPermission();

    const unlock = () => unlockNotificationAudio();
    window.addEventListener("click", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });

    pollInbox();
    pollUrgentEmails();
    pollWhatsAppInbox();
    pollInterestedFollowUps();
    pollQuotationMeetings();
    pollInterestedClientsActivity();
    client
      .getEmailActivityUnreadCount("email")
      .then((r) => setEmailActivityUnread(r.unread_count))
      .catch(() => setEmailActivityUnread(0));
    client
      .getEmailActivityUnreadCount("whatsapp")
      .then((r) => setWhatsappActivityUnread(r.unread_count))
      .catch(() => setWhatsappActivityUnread(0));
    const inboxTimer = window.setInterval(pollInbox, INBOX_POLL_INTERVAL_MS);
    const urgentTimer = window.setInterval(pollUrgentEmails, 45_000);
    const whatsappTimer = window.setInterval(pollWhatsAppInbox, WHATSAPP_POLL_INTERVAL_MS);
    const followUpTimer = window.setInterval(pollInterestedFollowUps, FOLLOW_UP_POLL_INTERVAL_MS);
    const meetingTimer = window.setInterval(pollQuotationMeetings, MEETING_POLL_INTERVAL_MS);
    const interestedActivityTimer = window.setInterval(
      pollInterestedClientsActivity,
      INTERESTED_ACTIVITY_POLL_INTERVAL_MS,
    );
    const activityTimer = window.setInterval(() => {
      client
        .getEmailActivityUnreadCount("email")
        .then((r) => setEmailActivityUnread(r.unread_count))
        .catch(() => undefined);
      client
        .getEmailActivityUnreadCount("whatsapp")
        .then((r) => setWhatsappActivityUnread(r.unread_count))
        .catch(() => undefined);
    }, INBOX_POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(inboxTimer);
      window.clearInterval(urgentTimer);
      window.clearInterval(whatsappTimer);
      window.clearInterval(followUpTimer);
      window.clearInterval(meetingTimer);
      window.clearInterval(interestedActivityTimer);
      window.clearInterval(activityTimer);
      window.removeEventListener("click", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, [
    loadDiscoverLeadsCount,
    loadEmailTemplateCount,
    loadWhatsappTemplateCount,
    loadMailCounts,
    loadMailExtras,
    loadTableCounts,
    loadAssigneeNavUsers,
    pollInbox,
    pollUrgentEmails,
    pollWhatsAppInbox,
    pollInterestedFollowUps,
    pollQuotationMeetings,
    pollInterestedClientsActivity,
  ]);

  function handleSelectLead(leadId: number) {
    setError(null);
    setSelectedLeadId(leadId);
  }

  /** Open a contact from the Email / WhatsApp Activity pages (lead profile, where it can be edited). */
  function handleOpenLeadFromActivity(buyerId: number) {
    setError(null);
    if (isWorkspaceOnlySalesUser) {
      setTab("target-workspace");
      setSelectedLeadId(buyerId);
      return;
    }
    setTab("table");
    setSelectedLeadId(buyerId);
  }

  function handleBackFromProfile() {
    setSelectedLeadId(null);
    void loadDiscoverLeadsCount();
    void loadTableCounts();
    void loadMailCounts();
    void loadEmailTemplateCount();
  }

  function handleSelectTab(nextTab: Tab) {
    if (nextTab === "personalized-emails") {
      if (!canOpenRestrictedAiTab(isAdmin)) {
        setError(
          isAdmin
            ? "Unlock AI tools in Settings (password required) to open AI Mode."
            : "AI Mode is admin-only. Open it from Settings after unlocking.",
        );
        if (isAdmin) setTab("settings");
        return;
      }
      sessionStorage.setItem("kafi.aiModePanel", "personalized");
      setTab("ai-mode");
      setSelectedLeadId(null);
      return;
    }
    if (nextTab === "ai-mode" || nextTab === "leads") {
      if (!canOpenRestrictedAiTab(isAdmin)) {
        setError(
          isAdmin
            ? "Unlock AI tools in Settings (password required) first."
            : "AI Mode and Searched by AI are admin-only (Settings).",
        );
        if (isAdmin) setTab("settings");
        return;
      }
    }
    setTab(nextTab);
    setError(null);
    if (nextTab !== "leads" && nextTab !== "table" && nextTab !== "calls") {
      setSelectedLeadId(null);
    }
  }

  function handleSelectTableSection(section: LeadsTableSection) {
    if (
      isWorkspaceOnlySalesUser &&
      (WORKSPACE_HIDDEN_TABLE_SECTIONS as readonly string[]).includes(section)
    ) {
      setTab("target-workspace");
      setSelectedLeadId(null);
      return;
    }
    setTableSection(section);
    setSelectedLeadId(null);
  }

  function handleSelectMailSection(section: MailSection) {
    if (String(section) === "flagged") {
      const existing = mailLabels.find(
        (label) => label.is_system || label.name.trim().toLowerCase() === "flagged",
      );
      if (existing) {
        setMailSection(mailLabelSectionId(existing) as MailSection);
        setSelectedLeadId(null);
        setTab("inbox");
        return;
      }
      void client.listMailLabels(isAsimUser ? asimActiveMailboxUserId : null).then((rows) => {
        setMailLabels(rows);
        const found = rows.find(
          (label) => label.is_system || label.name.trim().toLowerCase() === "flagged",
        );
        if (found) {
          setMailSection(mailLabelSectionId(found) as MailSection);
          setSelectedLeadId(null);
          setTab("inbox");
        }
      });
      return;
    }
    setMailSection(section);
    setSelectedLeadId(null);
    if (section === "activity") {
      setTab("activity");
      return;
    }
    if (section === "email-templates") {
      setTab("email-templates");
      return;
    }
    if (section === "personalized-emails") {
      sessionStorage.setItem("kafi.aiModePanel", "personalized");
      handleSelectTab("ai-mode");
      return;
    }
    setTab("inbox");
  }

  async function openMailerApp(nextPath = "/inbox") {
    try {
      const session = await client.createMailerSession();
      const url = new URL(session.url);
      if (nextPath.startsWith("/") && !nextPath.startsWith("//")) {
        url.searchParams.set("next", nextPath);
      }
      window.location.href = url.toString();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open Bulk Email Sender");
    }
  }

  function toggleSidebar() {
    setSidebarOpen((open) => {
      const next = !open;
      try {
        localStorage.setItem(SIDEBAR_OPEN_KEY, String(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  function handleSelectWhatsAppSection(section: WhatsAppSection) {
    setSelectedLeadId(null);
    setTab(section);
  }

  function handleOpenWhatsAppChat(contactId: number) {
    setSelectedLeadId(null);
    setPendingWhatsAppContactId(contactId);
    setTab("whatsapp-inbox");
  }

  const handleMailCountsChange = useCallback(
    (counts: {
      inbox: number;
      sent: number;
      trash: number;
      junk: number;
      archive: number;
    }) => {
      setMailCounts(counts);
    },
    [],
  );

  function handleCallFollowUpSaved(_outcome: string | null | undefined) {
    void loadTableCounts();
    void loadEmailTemplateCount();
    setLeadsTableRefreshToken((token) => token + 1);
  }

  function handleViewInterestedClient(
    buyerId: number,
    section: LeadsTableSection = "interested_clients",
  ) {
    if (isWorkspaceOnlySalesUser) {
      setTab("target-workspace");
      setSelectedLeadId(buyerId);
      return;
    }
    setTab("table");
    setTableSection(section);
    setSelectedLeadId(buyerId);
  }

  function handleOpenIndexesSection(sectionNumber: number) {
    sessionStorage.setItem("kafi.indexSection", String(sectionNumber));
    handleSelectTab("indexes");
  }

  function handleIndexNavigate(action: IndexAction) {
    switch (action.type) {
      case "tab":
        handleSelectTab(action.tab);
        break;
      case "table":
        handleSelectTab("table");
        handleSelectTableSection(action.section);
        break;
      case "mail":
        handleSelectMailSection(action.section);
        break;
      case "whatsapp":
        handleSelectWhatsAppSection(action.section);
        break;
      case "ai-mode":
        if (action.panel) {
          sessionStorage.setItem("kafi.aiModePanel", action.panel);
        }
        if (action.stage) {
          sessionStorage.setItem("kafi.aiModeStage", action.stage);
        }
        handleSelectTab("ai-mode");
        break;
      case "external":
        window.open(action.url, "_blank", "noopener,noreferrer");
        break;
      case "mailer":
        void openMailerApp();
        break;
      default:
        break;
    }
  }

  function handleViewInterestedClientsFeed() {
    sessionStorage.setItem("kafi.aiModeStage", "interested");
    handleSelectTab("ai-mode");
  }

  function handleViewQuotationMeeting(buyerId: number) {
    sessionStorage.setItem("kafi.aiModeStage", "quotation_sent");
    if (!canOpenRestrictedAiTab(isAdmin)) {
      setError(
        isAdmin
          ? "Unlock AI tools in Settings (password required) to view this client."
          : "AI Mode is admin-only (Settings).",
      );
      if (isAdmin) setTab("settings");
      return;
    }
    setTab("ai-mode");
    setSelectedLeadId(buyerId);
  }

  async function handleAcknowledgeInterestedFollowUp(buyerId: number) {
    await client.acknowledgeInterestedFollowUp(buyerId);
    const reminders = await client.listInterestedFollowUps();
    for (const reminder of reminders) {
      seenFollowUpIdsRef.current.add(reminder.id);
    }
    setLeadsTableRefreshToken((token) => token + 1);
  }

  const assigneeSectionUsers: AppUser[] = assigneeNavUsers;

  // Drop stale "Leads Sent To" selection if that user was removed.
  useEffect(() => {
    if (!isAssignedLeadsSection(tableSection)) return;
    const selectedId = assignedUserIdFromSection(tableSection);
    if (selectedId == null) return;
    const stillExists = assigneeSectionUsers.some((u) => u.id === selectedId);
    if (!stillExists) {
      setTableSection("master");
    }
  }, [assigneeSectionUsers, tableSection]);

  const assigneeNavChildren = isAdmin
    ? assigneeSectionUsers.map((u) => ({
        id: `assigned:${u.id}`,
        label: `Leads Sent To ${u.username}`,
        count: tableCounts.by_assignee?.[String(u.id)] ?? 0,
      }))
    : [];

  const masterTableLabel =
    masterType === "minerals_ores"
      ? "Master Table (Minerals & Ores)"
      : masterType === "other_items"
      ? "Master Table (Other Items)"
      : "Master Table (ALL)";

  const enabledCustomNavItems = customModules
    .filter((m) => m.is_enabled)
    .map((m) => ({
      id: m.key as any,
      label: `${m.icon ? m.icon + " " : ""}${m.name}`,
      count: (tableCounts as any)[m.key] ?? m.count ?? 0,
    }));

  const defaultStandardAdminNavItems = [
    {
      id: "testing" as const,
      label: "🧪 Testing",
      count: (tableCounts as any).testing ?? 0,
    },
    {
      id: "khalid_focused_sales" as const,
      label: "Khalid Focused Sales",
      count: tableCounts.khalid_focused_sales ?? 0,
    },
    {
      id: "interested_clients" as const,
      label: "Follow up clients",
      count: tableCounts.interested_clients,
    },
    {
      id: "sales_interested_clients" as const,
      label: "Interested Clients",
      count: tableCounts.sales_interested_clients ?? 0,
    },
    {
      id: "not_interested_clients" as const,
      label: "Not interested",
      count: tableCounts.not_interested_clients,
    },
    {
      id: "not_received_call_clients" as const,
      label: "Did not receive call",
      count: tableCounts.not_received_call_clients,
    },
    {
      id: "hyperstore_targeted" as const,
      label: "Hyperstore Target",
      count: tableCounts.hyperstore_targeted ?? 0,
    },
    {
      id: "targeted_distributor" as const,
      label: "Targeted Distributors",
      count: tableCounts.targeted_distributor ?? 0,
    },
    {
      id: "targeted_client" as const,
      label: "Targeted Client",
      count: tableCounts.targeted_client ?? 0,
    },
    {
      id: "schedule_meeting" as const,
      label: "SCHEDULE MEETING",
      count: tableCounts.schedule_meeting ?? 0,
    },
    {
      id: "incomplete_archives" as const,
      label: "Incomplete Data from Archives",
      count: tableCounts.incomplete_archives ?? 0,
    },
  ];

  const clientSectionNavChildren = isAdmin
    ? [
        {
          id: "master" as const,
          label: masterTableLabel,
          count: tableCounts.master ?? 0,
        },
        {
          id: "all" as const,
          label: "New search lead",
          count: tableCounts.all,
        },
        {
          id: "old_clients" as const,
          label: "Old clients",
          count: tableCounts.old_clients,
        },
        ...(customModules.length > 0
          ? enabledCustomNavItems
          : defaultStandardAdminNavItems),
      ]
    : [
        {
          id: "all_contacts" as const,
          label: "All Contacts",
          count: tableCounts.all_contacts ?? tableCounts.my_assigned ?? 0,
        },
        {
          id: "my_assigned" as const,
          label: "My Assigned Leads",
          count: tableCounts.my_assigned ?? 0,
        },
        ...(isWorkspaceOnlySalesUser
          ? []
          : [
              {
                id: "sales_interested_clients" as const,
                label: "Interested Clients",
                count: tableCounts.sales_interested_clients ?? 0,
              },
              {
                id: "interested_clients" as const,
                label: "Follow up clients",
                count: tableCounts.interested_clients,
              },
              {
                id: "not_interested_clients" as const,
                label: "Not interested",
                count: tableCounts.not_interested_clients,
              },
              {
                id: "not_received_call_clients" as const,
                label: "Did not receive call",
                count: tableCounts.not_received_call_clients,
              },
            ]),
        ...(customModules.length > 0
          ? enabledCustomNavItems.filter((m) => !["sales_interested_clients", "interested_clients", "not_interested_clients", "not_received_call_clients", "all_contacts"].includes(m.id))
          : []),
      ];

  const defaultTableSection: LeadsTableSection = isAdmin ? "master" : "my_assigned";

  const indexAssignees = assigneeSectionUsers.map((u) => ({
    id: u.id,
    username: u.username,
  }));

  const flaggedMailLabel = mailLabels.find(
    (label) => label.is_system || label.name.trim().toLowerCase() === "flagged",
  );
  const customMailLabels = mailLabels.filter(
    (label) => !(label.is_system || label.name.trim().toLowerCase() === "flagged"),
  );

  const navItems: NavItem[] = [
    // #1 Master Table + dropdowns
    {
      id: "table",
      label: isAdmin ? masterTableLabel : "My Assigned Leads",
      count: isAdmin ? (tableCounts.master ?? 0) : (tableCounts.all_contacts ?? tableCounts.my_assigned ?? 0),
      children: [
        ...clientSectionNavChildren,
        ...assigneeNavChildren,
      ],
    },
    // #2 WhatsApp + dropdown
    {
      id: "whatsapp-inbox",
      label: "WhatsApp",
      count: 0,
      alert: whatsappInboxUnread > 0,
      children: [
        {
          id: "whatsapp-inbox",
          label: "WhatsApp inbox",
          count: whatsappInboxUnread,
          alert: whatsappInboxUnread > 0,
        },
        {
          id: "whatsapp-mobile",
          label: "WhatsApp Mobile",
          count: 0,
        },
        {
          id: "whatsapp-templates",
          label: "WhatsApp Templates Draft",
          count: whatsappTemplateCount,
        },
        {
          id: "whatsapp-activity",
          label: "WhatsApp Activity",
          count: whatsappActivityUnread,
        },
      ],
    },
    {
      id: "telegram-mobile",
      label: "Telegram",
      count: 0,
      children: [
        {
          id: "telegram-mobile",
          label: "Telegram Mobile",
          count: 0,
        },
        {
          id: "telegram-templates",
          label: "Telegram templates",
          count: 0,
        },
      ],
    },
    // #3 Call Center (dropdown)
    {
      id: "calls",
      label: "Call Center",
      count: 0,
      children: [
        { id: "calls", label: "Manual Call Center", count: 0 },
      ],
    },
    // #4 Emails (dropdown)
    {
      id: "inbox",
      label: "Emails",
      count: 0,
      alert: inboxUnread > 0,
      children: [
        { id: "all", label: "All emails", count: 0 },
        { id: "inbox", label: "Inbox", count: mailCounts.inbox, alert: inboxUnread > 0 },
        ...(flaggedMailLabel
          ? [
              {
                id: mailLabelSectionId(flaggedMailLabel),
                label: "Flagged",
                count: flaggedMailLabel.count,
              },
            ]
          : [{ id: "flagged", label: "Flagged", count: 0 }]),
        { id: "sent", label: "Sent", count: mailCounts.sent },
        { id: "drafts", label: "Drafts", count: mailDraftCount },
        { id: "trash", label: "Trash", count: mailCounts.trash },
        { id: "junk", label: "Spam / Junk", count: mailCounts.junk },
        { id: "archive", label: "Archive", count: mailCounts.archive },
        {
          id: "activity",
          label: "Email Activity",
          count: emailActivityUnread,
        },
        {
          id: "email-templates",
          label: "Email templates",
          count: emailTemplateCount,
        },
        ...customMailLabels.map((label) => ({
          id: mailLabelSectionId(label),
          label: label.name,
          count: label.count,
        })),
      ],
    },
    // AI — Sales Agent / Train / Research for all users; Smart Data Clean admin-only
    {
      id: "ai",
      label: "AI",
      count: 0,
      children: [
        { id: "ai-sales-agent" as const, label: "AI Sales Agent", count: 0 },
        { id: "ai-train" as const, label: "AI Train", count: 0 },
        ...(isAdmin
          ? [{ id: "data-synthesis" as const, label: "Smart Data Clean & Merge", count: 0 }]
          : []),
        { id: "chatbot" as const, label: "AI Research & Update", count: 0 },
      ],
    },
    // #5 Others (dropdown)
    {
      id: "others",
      label: "Others",
      count: 0,
      children: [
        {
          id: "quotation-agent",
          label: "CNF or FOB",
          count: 0,
          external: QUOTATION_AGENT_URL,
        },
        {
          id: "catalogue" as const,
          label: "Catalogue",
          count: 4,
        },
        { id: "client-history", label: "Client History", count: 0 },
        { id: "helpful-guidance", label: "SALES HELP MANAGER", count: 0 },
        { id: "target-workspace" as const, label: "Target and Workspace", count: 0 },
        { id: "kpi", label: "KPI", count: 0 },
        ...(isAdmin ? [{ id: "users" as const, label: "Users", count: 0 }] : []),
      ],
    },
    // Indexes at the end (with User Manual inside)
    {
      id: "indexes",
      label: "Indexes",
      count: 0,
      children: [
        { id: "indexes", label: "Indexes Overview", count: 0 },
        { id: "user-manual", label: "User Manual", count: 0 },
      ],
    },
  ];

  const pageHeading = useMemo(() => {
    if (tab === "table") {
      if (selectedLeadId != null) return "Lead profile";
      if (tableSection === "master") return masterTableLabel;
      if (tableSection === "my_assigned") return "Assigned";
      if (tableSection === "old_clients") return isAdmin ? "Old clients" : "Clients";
      const tableChild = clientSectionNavChildren.find((child) => child.id === tableSection);
      if (tableChild) return tableChild.label;
      const assignedChild = assigneeNavChildren.find((child) => child.id === tableSection);
      if (assignedChild) return assignedChild.label;
      const custom = customModules.find((module) => module.key === tableSection);
      if (custom) return `${custom.icon ? `${custom.icon} ` : ""}${custom.name}`;
      return masterTableLabel;
    }
    if (tab === "inbox") {
      if (mailSection === "all") return "All emails";
      if (mailSection === "inbox") return "Inbox";
      if (mailSection === "sent") return "Sent";
      if (mailSection === "trash") return "Trash";
      if (mailSection === "junk") return "Spam / Junk";
      if (mailSection === "archive") return "Archive";
      if (mailSection === "drafts") return "Drafts";
      const labelId = mailLabelIdFromSection(mailSection);
      if (labelId != null) {
        return mailLabels.find((label) => label.id === labelId)?.name || "Label";
      }
      return "Inbox";
    }
    if ((tab === "leads" || tab === "calls") && selectedLeadId != null) return "Lead profile";
    if (tab === "whatsapp-qr" || tab === "whatsapp-mobile") return "WhatsApp Mobile";
    if (tab === "telegram-mobile") return "Telegram Mobile";
    if (tab === "telegram-templates") return "Telegram templates";
    if (tab === "settings") return "Settings";
    for (const item of navItems) {
      const children = "children" in item ? item.children : undefined;
      const child = children?.find((entry) => entry.id === tab);
      if (child) return child.label;
      if (item.id === tab) return item.label;
    }
    return APP_BRAND_NAME;
  }, [
    tab,
    tableSection,
    mailSection,
    selectedLeadId,
    masterTableLabel,
    isAdmin,
    clientSectionNavChildren,
    assigneeNavChildren,
    customModules,
    mailLabels,
    navItems,
  ]);
  const isWhatsAppMobile = tab === "whatsapp-mobile" || tab === "whatsapp-qr";

  return (
    <TwilioVoiceProvider>
      <CallQueueProvider>
      <PostCallRemarksModal
        onError={setError}
        onSaved={(outcome) => {
          handleCallFollowUpSaved(outcome);
        }}
      />
      <CallingCardOverlay />
      <BulkCallQueueHost onError={setError} />
      <FloatingDialpad onError={setError} />
      <FloatingSalesAssistant onNavigate={handleIndexNavigate} onError={setError} />
      {impersonating && impersonatorLabel && (
        <div className="sticky top-0 z-50 bg-amber-500 text-slate-950 px-4 py-2 flex items-center justify-between shadow-lg text-xs sm:text-sm font-semibold border-b border-amber-600">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="font-bold shrink-0 bg-slate-950 text-amber-400 px-2 py-0.5 rounded text-[11px] uppercase tracking-wider">
              Switched View
            </span>
            <span className="truncate">
              Viewing dashboard as <strong>{displayDashboardUserLabel(user)}</strong> (Admin: {impersonatorLabel})
            </span>
          </div>
          <button
            type="button"
            onClick={() => void switchBackToAdmin()}
            className="shrink-0 rounded-lg bg-slate-950 hover:bg-slate-900 text-amber-300 font-bold px-3 py-1.5 text-xs transition border border-amber-400/40 shadow-sm"
          >
            Return to Admin ({impersonatorLabel})
          </button>
        </div>
      )}
      <div className="min-h-dvh flex">
        <InboxAlertToasts
          onOpenInbox={() => {
            setMailSection("inbox");
            handleSelectTab("inbox");
          }}
        />
        <HandsFreeEmailReaderHost />
        <WhatsAppAlertToasts
          onOpenWhatsAppInbox={() => {
            handleSelectWhatsAppSection("whatsapp-inbox");
          }}
        />
        <InterestedFollowUpAlertToasts
          onViewClient={handleViewInterestedClient}
          onAcknowledge={handleAcknowledgeInterestedFollowUp}
        />
        <QuotationMeetingAlertToasts onViewClient={handleViewQuotationMeeting} />
        <InterestedClientsActivityToasts onViewFeed={handleViewInterestedClientsFeed} />
        <AppSidebar
          navItems={navItems}
          activeTab={tab}
          tableSection={tableSection}
          defaultTableSection={defaultTableSection}
          mailSection={mailSection}
          onSelectTab={handleSelectTab}
          onSelectTableSection={handleSelectTableSection}
          onSelectMailSection={handleSelectMailSection}
          onDeleteMailLabel={(labelId) => void handleDeleteMailLabel(labelId)}
          onSelectWhatsAppSection={handleSelectWhatsAppSection}
          horekaCategory={horekaCategory}
          onSelectHorekaCategory={(cat) => {
            setHorekaCategory(cat);
            setTab("horeka");
          }}
          catalogueId={catalogueId}
          onSelectCatalogueItem={(cid) => {
            setCatalogueId(cid);
            setTab("catalogue");
          }}
          onOpenMailer={() => void openMailerApp()}
          onOpenSalesAssistant={() => {
            window.dispatchEvent(new CustomEvent(OPEN_SALES_ASSISTANT_EVENT));
          }}
          onOpenManageModules={() => setShowManageModulesModal(true)}
          userLabel={displayDashboardUserLabel(user)}
          userRole={user?.role}
          mobileOpen={mobileNavOpen}
          onMobileClose={() => setMobileNavOpen(false)}
          desktopOpen={sidebarOpen}
          onToggleDesktop={toggleSidebar}
          masterType={masterType}
          onMasterTypeChange={setMasterType}
        />

        <div className="flex-1 min-w-0 flex flex-col overflow-x-hidden transition-[margin] duration-200">
          <header className="lg:hidden sticky top-0 z-30 border-b border-slate-800 bg-slate-950/95 backdrop-blur pt-[max(0.625rem,env(safe-area-inset-top))]">
            <div className="flex items-center gap-2 px-3 py-2.5">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              className="shrink-0 rounded-lg p-2 text-slate-300 hover:bg-slate-800 hover:text-slate-100"
              aria-label="Open menu"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M4 7h16M4 12h16M4 17h16" />
              </svg>
            </button>
            <h1 className="min-w-0 flex-1 text-sm font-semibold text-slate-100 truncate inline-flex items-center gap-2">
              {isWhatsAppMobile ? <IconWhatsApp className="w-5 h-5 text-emerald-400 shrink-0" /> : null}
              {pageHeading}
            </h1>
            {tab === "target-workspace" ? (
              <WorkspaceAiAutopilotButton compact onError={setError} />
            ) : null}
            {urgentHeaderButton}
            {aiResearchLogsHeaderButton}
            {asimMailboxSwitcher}
            <AppTopActions
              compact
              onRefresh={refreshAll}
              onOpenSettings={isAdmin ? () => setTab("settings") : undefined}
              onReconnectDb={isAdmin ? () => void handleReconnectDb() : undefined}
              reconnectingDb={reconnectingDb}
              onLogout={() => void logout()}
            />
            </div>
            {isWhatsAppMobile ? (
              <div
                id="wa-mobile-header-slot-sm"
                className="flex items-center gap-2 px-3 pb-2 min-h-[2.5rem]"
              />
            ) : null}
          </header>

          <div className="hidden lg:flex sticky top-0 z-30 items-center gap-2 border-b border-slate-800/80 bg-slate-950/80 backdrop-blur px-4 sm:px-6 lg:px-8 py-2.5">
            <button
              type="button"
              onClick={toggleSidebar}
              className="shrink-0 rounded-lg p-2 text-slate-300 hover:bg-slate-800 hover:text-slate-100"
              aria-label={sidebarOpen ? "Close sidebar" : "Open sidebar"}
              title={sidebarOpen ? "Close sidebar" : "Open sidebar"}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M4 7h16M4 12h16M4 17h16" />
              </svg>
            </button>
            <h1 className="min-w-0 max-w-[min(100%,16rem)] truncate text-sm sm:text-base font-semibold text-slate-100 inline-flex items-center gap-2">
              {isWhatsAppMobile ? <IconWhatsApp className="w-5 h-5 text-emerald-400 shrink-0" /> : null}
              {pageHeading}
            </h1>
            {tab === "target-workspace" ? (
              <WorkspaceAiAutopilotButton onError={setError} />
            ) : null}
            {urgentHeaderButton}
            {aiResearchLogsHeaderButton}
            {asimMailboxSwitcher ? (
              <div className="flex-1 min-w-0 flex items-center">{asimMailboxSwitcher}</div>
            ) : isWhatsAppMobile ? (
              <div
                id="wa-mobile-header-slot"
                className="flex-1 min-w-0 flex items-center gap-3 overflow-hidden"
              />
            ) : error ? (
              <button
                type="button"
                onClick={() => setError(null)}
                className="flex-1 min-w-0 text-left text-xs sm:text-sm text-red-200 truncate px-2 py-1 rounded-lg bg-red-500/10 border border-red-500/30 hover:bg-red-500/20"
                title="Click to dismiss"
              >
                {error}
              </button>
            ) : (
              <div className="flex-1" />
            )}
            {isWhatsAppMobile && error ? (
              <p
                className="max-w-[12rem] shrink-0 text-xs text-red-200 truncate px-2 py-1 rounded-lg bg-red-500/10 border border-red-500/30"
                title={error}
              >
                {error}
              </p>
            ) : null}
            <AppTopActions
              onRefresh={refreshAll}
              onOpenSettings={isAdmin ? () => setTab("settings") : undefined}
              onReconnectDb={isAdmin ? () => void handleReconnectDb() : undefined}
              reconnectingDb={reconnectingDb}
              onLogout={() => void logout()}
            />
          </div>

          <main className="w-full max-w-none min-w-0 mx-auto px-4 sm:px-6 lg:px-8 py-4 sm:py-6 lg:py-8">
            <CallInitBanner />
            {error ? (
              <div className="lg:hidden mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-200 text-sm">
                {error}
              </div>
            ) : null}

            {tab === "indexes" && (
              <IndexesPage
                isAdmin={isAdmin}
                quotationAgentUrl={QUOTATION_AGENT_URL}
                assignees={indexAssignees}
                hideOutcomeBuckets={isWorkspaceOnlySalesUser}
                onNavigate={handleIndexNavigate}
              />
            )}
            {tab === "user-manual" && (
              <UserManualPage
                isAdmin={isAdmin}
                quotationAgentUrl={QUOTATION_AGENT_URL}
                assignees={indexAssignees}
                hideOutcomeBuckets={isWorkspaceOnlySalesUser}
                onNavigate={handleIndexNavigate}
                onOpenIndexesSection={handleOpenIndexesSection}
              />
            )}
            {tab === "activity" && (
              <EmailActivityPage
                channel="email"
                onError={setError}
                onUnreadChange={setEmailActivityUnread}
                onOpenLead={handleOpenLeadFromActivity}
              />
            )}
            {tab === "email-templates" && (
              <EmailTemplatesPage
                onError={setError}
                onCountChange={setEmailTemplateCount}
              />
            )}
            {tab === "whatsapp-templates" && (
              <WhatsAppTemplatesPage
                onError={setError}
                onCountChange={setWhatsappTemplateCount}
              />
            )}
            {tab === "whatsapp-activity" && (
              <EmailActivityPage
                channel="whatsapp"
                onError={setError}
                onUnreadChange={setWhatsappActivityUnread}
                onOpenLead={handleOpenLeadFromActivity}
              />
            )}
            {(tab === "whatsapp-mobile" || tab === "whatsapp-qr") && (
              <WhatsAppMobilePage onError={setError} />
            )}
            {tab === "telegram-mobile" && <TelegramMobilePage onError={setError} />}
            {tab === "telegram-templates" && <TelegramTemplatesPage onError={setError} />}
            {tab === "whatsapp-inbox" && (
              <WhatsAppInboxPage
                onError={setError}
                initialContactId={pendingWhatsAppContactId}
                onInitialContactConsumed={() => setPendingWhatsAppContactId(null)}
              />
            )}
            {tab === "leads" && selectedLeadId !== null && (
              <BuyerProfile
                leadId={selectedLeadId}
                onBack={handleBackFromProfile}
                onError={setError}
                onCallFollowUpSaved={handleCallFollowUpSaved}
                onOpenWhatsAppChat={handleOpenWhatsAppChat}
                canDiscover
              />
            )}
            {tab === "leads" && selectedLeadId === null && (
              <LeadsPage
                onError={setError}
                onSelectLead={handleSelectLead}
                onTotalChange={setDiscoverLeadsCount}
              />
            )}
            {tab === "data-synthesis" && isAdmin && (
              <DataSynthesisPage onError={setError} masterType={masterType} />
            )}
            {tab === "target-workspace" && (
              <TargetWorkspacePage
                masterType={masterType}
                onOpenCall={(phone, company) => {
                  pushNumberToFloatingDialpad({
                    phone,
                    contactName: company,
                  });
                }}
                onOpenEmailComposer={(email, company, _contact) => {
                  void openMailerApp(
                    `/compose?to=${encodeURIComponent(email)}&subject=${encodeURIComponent(`Inquiry - ${company}`)}`
                  );
                }}
                onEditLead={(leadId, companyName) => {
                  setTableSection(isAdmin ? "master" : "my_assigned");
                  setSelectedLeadId(null);
                  setFocusEditLeadId(leadId);
                  setFocusEditCompany(companyName);
                  setTab("table");
                }}
                onError={setError}
              />
            )}
            {tab === "table" && selectedLeadId !== null && (
              <BuyerProfile
                leadId={selectedLeadId}
                onBack={handleBackFromProfile}
                onError={setError}
                onCallFollowUpSaved={handleCallFollowUpSaved}
                onOpenWhatsAppChat={handleOpenWhatsAppChat}
                canDiscover
              />
            )}
            {tab === "table" && selectedLeadId === null && (
              <LeadsTablePage
                section={tableSection}
                refreshToken={leadsTableRefreshToken}
                onError={setError}
                onSelectLead={handleSelectLead}
                onSectionCountsChange={setTableCounts}
                onCustomModulesChanged={() => void loadCustomModules()}
                masterType={masterType}
                focusEditLeadId={focusEditLeadId}
                focusEditCompany={focusEditCompany}
                onFocusEditConsumed={() => {
                  setFocusEditLeadId(null);
                  setFocusEditCompany(null);
                }}
                onOpenAiSalesAgent={() => handleSelectTab("ai-sales-agent")}
                onOpenAiResearchUpdate={(contacts) => {
                  setAiResearchContacts(contacts.map(snapshotLeadForAiResearch));
                  setAiResearchReturnSection(tableSection);
                  setAiResearchRestoreIds(contacts.map((c) => c.id));
                  setTab("chatbot");
                }}
                restoreSelectedIds={aiResearchRestoreIds}
                restoreSearchHint={aiResearchRestoreSearch}
                onRestoreSelectedConsumed={() => {
                  setAiResearchRestoreIds(null);
                  setAiResearchRestoreSearch(null);
                }}
              />
            )}
            {tab === "inbox" && (
              <InboxPage
                section={mailSection}
                onError={setError}
                onUnreadChange={setInboxUnread}
                onFolderCountsChange={handleMailCountsChange}
                onMailExtrasChange={() => void loadMailExtras()}
                onSelectMailSection={handleSelectMailSection}
                onOpenMailerCompose={(opts) => {
                  const params = new URLSearchParams();
                  if (opts?.to?.trim()) params.set("to", opts.to.trim());
                  if (opts?.cc?.trim()) params.set("cc", opts.cc.trim());
                  const qs = params.toString();
                  void openMailerApp(qs ? `/compose?${qs}` : "/compose");
                }}
                initialThreadId={targetThreadId}
                initialMailboxUserId={targetMailboxUserId}
                activeMailboxUserId={isAsimUser ? asimActiveMailboxUserId : null}
                autoOpenReply={autoOpenReply}
                onThreadOpened={() => {
                  setTargetThreadId(null);
                  setTargetMailboxUserId(null);
                  setAutoOpenReply(false);
                  void pollUrgentEmails();
                }}
              />
            )}
            {tab === "calls" && selectedLeadId !== null && (
              <BuyerProfile
                leadId={selectedLeadId}
                onBack={handleBackFromProfile}
                onError={setError}
                onCallFollowUpSaved={handleCallFollowUpSaved}
                onOpenWhatsAppChat={handleOpenWhatsAppChat}
                canDiscover
              />
            )}
            {tab === "calls" && selectedLeadId === null && (
              <CallsPage
                onError={setError}
                onSelectLead={handleSelectLead}
                onCallFollowUpSaved={handleCallFollowUpSaved}
              />
            )}
            {tab === "client-history" && (
              <ClientHistoryPage
                onError={setError}
                onOpenClient={(buyerId) => {
                  setSelectedLeadId(buyerId);
                  setTab("table");
                }}
              />
            )}
            {tab === "helpful-guidance" && (
              <HelpfulGuidancePage onError={setError} />
            )}
            {tab === "horeka" && (
              <HorekaPage
                initialCategory={horekaCategory}
                onError={setError}
              />
            )}
            {tab === "catalogue" && (
              <CataloguePage
                isAdmin={isAdmin}
                initialCatalogueId={catalogueId === "all" ? null : catalogueId}
                onError={setError}
              />
            )}
            {tab === "chatbot" && (
              <ChatbotPage
                onError={setError}
                researchContacts={aiResearchContacts}
                researchSection={aiResearchReturnSection}
                onClearResearchContacts={() => setAiResearchContacts(null)}
                onReturnToTable={(leadIds) => {
                  const ids =
                    leadIds?.length
                      ? leadIds
                      : aiResearchContacts?.map((c) => c.id) ?? aiResearchRestoreIds ?? [];
                  returnToTableWithSelection(ids, aiResearchReturnSection);
                }}
              />
            )}
            {tab === "ai-mode" && (
              <AiModePage
                onError={setError}
                onPersonalizedCountChange={setPersonalizedEmailCount}
                onLeadsAssigned={() => {
                  void loadTableCounts();
                  setLeadsTableRefreshToken((token) => token + 1);
                }}
              />
            )}
            {tab === "ai-sales-agent" && (
              <AiSalesAgentPage onError={setError} masterType={masterType} />
            )}
            {tab === "ai-train" && <AiTrainPage onError={setError} />}
            {tab === "kpi" && <KpiPage onError={setError} />}
            {tab === "users" && isAdmin && (
              <UsersPage
                onError={setError}
                onUsersChanged={() => {
                  void loadAssigneeNavUsers();
                  void loadTableCounts();
                }}
              />
            )}
            {tab === "settings" && isAdmin && (
              <SettingsPage
                onError={setError}
                onOpenRestrictedAi={(next) => {
                  setTab(next);
                  setSelectedLeadId(null);
                }}
              />
            )}
          </main>
        </div>
      </div>
      {!urgentAlertDismissed && urgentEmails.length > 0 && (
        <UrgentEmailAlertModal
          urgentEmails={urgentEmails}
          onOpenAndReply={handleOpenUrgentAndReply}
          onDismiss={() => setUrgentAlertDismissed(true)}
        />
      )}
      {showAiResearchLog ? (
        <AiResearchLogModal
          entries={aiResearchLogEntries}
          onClose={() => setShowAiResearchLog(false)}
          onEntriesChange={setAiResearchLogEntries}
          onOpenContacts={(leadIds, section, searchHint) =>
            returnToTableWithSelection(leadIds, section, searchHint)
          }
          onError={setError}
        />
      ) : null}
      {showAiSalesAgentLog ? (
        <AiSalesAgentLogsModal
          onClose={() => {
            setShowAiSalesAgentLog(false);
            setError(null);
          }}
        />
      ) : null}
      <ManageModulesModal
        isOpen={showManageModulesModal}
        onClose={() => setShowManageModulesModal(false)}
        onModulesChanged={() => {
          void loadCustomModules();
          void loadTableCounts();
          setLeadsTableRefreshToken((t) => t + 1);
        }}
        onNavigateToModule={(key) => {
          handleSelectTableSection(key);
        }}
      />
      </CallQueueProvider>
    </TwilioVoiceProvider>
  );
}

export default function App() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-400 text-sm">
        Checking session…
      </div>
    );
  }

  if (!user) {
    return <LoginPage />;
  }

  return <DashboardApp />;
}
