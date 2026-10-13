import { useEffect, useMemo, useState } from "react";
import {
  IconBell,
  IconChevronDown,
  IconChevronRight,
  IconExternal,
  IconTrash,
  NavIcon,
} from "./icons/AppIcons";
import { mailLabelIdFromNavId } from "../lib/mailLabelRules";
import { AppBrand } from "./AppBrand";
import { client, type OrgAdminMasterList } from "../api/client";
import {
  loadOrgAdminLocal,
  localMasterListsForUser,
  mergeMasterListsForSidebar,
  ORG_ADMIN_CHANGED_EVENT,
} from "../lib/orgAdminLocalStore";
import { SearchableSelect } from "./SearchableSelect";
import { useAuth } from "../auth/AuthContext";

export type Tab =
  | "indexes"
  | "user-manual"
  | "whatsapp-qr"
  | "activity"
  | "email-templates"
  | "personalized-emails"
  | "whatsapp-templates"
  | "whatsapp-activity"
  | "whatsapp-inbox"
  | "whatsapp-mobile"
  | "telegram-mobile"
  | "telegram-templates"
  | "leads"
  | "data-synthesis"
  | "target-workspace"
  | "table"
  | "master-table"
  | "inbox"
  | "calls"
  | "client-history"
  | "helpful-guidance"
  | "horeka"
  | "catalogue"
  | "chatbot"
  | "kpi"
  | "ai-mode"
  | "ai-sales-agent"
  | "ai-train"
  | "users"
  | "settings"
  | "ai"
  | "others";

export type LeadsTableSection =
  | "all"
  | "master"
  | "old_clients"
  | "my_assigned"
  | "all_contacts"
  | "interested_clients"
  | "sales_interested_clients"
  | "not_interested_clients"
  | "not_received_call_clients"
  | "hyperstore_targeted"
  | "targeted_distributor"
  | "targeted_client"
  | "khalid_focused_sales"
  | "incomplete_archives"
  | "testing"
  | `assigned:${number}`
  | (string & {});

export const TARGETED_POOL_EXCLUDE =
  "old_clients,incomplete_archives,hyperstore_targeted,targeted_distributor,targeted_client,khalid_focused_sales";

export function isTargetedPoolSection(
  section: LeadsTableSection,
): section is "hyperstore_targeted" | "targeted_distributor" | "targeted_client" | "khalid_focused_sales" {
  return (
    section === "hyperstore_targeted" ||
    section === "targeted_distributor" ||
    section === "targeted_client" ||
    section === "khalid_focused_sales"
  );
}

export function isAssignedLeadsSection(
  section: string,
): section is `assigned:${number}` {
  return /^assigned:\d+$/.test(section);
}

export function assignedUserIdFromSection(section: LeadsTableSection): number | null {
  if (!isAssignedLeadsSection(section)) return null;
  const id = Number(section.slice("assigned:".length));
  return Number.isFinite(id) ? id : null;
}

export type MailSection =
    | "all"
    | "inbox"
    | "sent"
    | "trash"
    | "junk"
    | "archive"
    | "drafts"
    | "activity"
    | "email-templates"
    | "personalized-emails"
    | `label:${number}`
    | `label-linkedin:${number}`;

export type WhatsAppSection = "whatsapp-inbox" | "whatsapp-templates" | "whatsapp-activity";

export function isMailLabelSection(
  section: string,
): section is `label:${number}` | `label-linkedin:${number}` {
  return /^label(?:-linkedin)?:\d+$/.test(section);
}

export function mailLabelIdFromSection(section: MailSection): number | null {
  if (!isMailLabelSection(section)) return null;
  const id = Number(section.replace(/^label(?:-linkedin)?:/, ""));
  return Number.isFinite(id) ? id : null;
}

export type NavChild = {
  id: string;
  label: string;
  count?: number;
  alert?: boolean;
  external?: string;
  openMailer?: boolean;
};

export type NavItem =
  | {
    id: Tab | string;
    label: string;
    count: number;
    alert?: boolean;
    external?: string;
    openMailer?: boolean;
    children?: NavChild[];
  }
  | { id: "quotation-agent"; label: string; count: number; external: string }
  | {
    id: "mail";
    label: string;
    count: number;
    alert?: boolean;
    openMailer: true;
  }
  | {
    id: "sales-assistant";
    label: string;
    count: number;
    alert?: boolean;
    children?: NavChild[];
    openSalesAssistant: true;
  };

interface AppSidebarProps {
  navItems: NavItem[];
  activeTab: Tab;
  tableSection?: LeadsTableSection;
  /** Section opened when the table parent is clicked. Admins: "master"; sales users: "old_clients". */
  defaultTableSection?: LeadsTableSection;
  mailSection?: MailSection;
  onSelectTab: (tab: Tab) => void;
  onSelectTableSection?: (section: LeadsTableSection) => void;
  onSelectMailSection?: (section: MailSection) => void;
  onDeleteMailLabel?: (labelId: number) => void;
  onSelectWhatsAppSection?: (section: WhatsAppSection) => void;
  horekaCategory?: string;
  onSelectHorekaCategory?: (category: string) => void;
  catalogueId?: string;
  onSelectCatalogueItem?: (catalogueId: string) => void;
  /** Open Vercel mailer (same tab) with session exchange. */
  onOpenMailer?: () => void;
  /** Open floating sales assistant panel (code required). */
  onOpenSalesAssistant?: () => void;
  userLabel?: string;
  userRole?: string;
  /** Mobile drawer open state (< lg). Ignored on desktop. */
  mobileOpen?: boolean;
  onMobileClose?: () => void;
  /** Desktop sidebar visible (< lg always uses mobile drawer). */
  desktopOpen?: boolean;
  onToggleDesktop?: () => void;
  masterType?: string;
  onMasterTypeChange?: (masterType: string) => void;
  onOpenManageModules?: () => void;
}

export function AppSidebar({
  navItems,
  activeTab,
  tableSection = "master",
  defaultTableSection = "master",
  mailSection = "inbox",
  onSelectTab,
  onSelectTableSection,
  onSelectMailSection,
  onDeleteMailLabel,
  onSelectWhatsAppSection,
  horekaCategory,
  onSelectHorekaCategory,
  catalogueId,
  onSelectCatalogueItem,
  onOpenMailer,
  onOpenSalesAssistant,
  onOpenManageModules,
  userLabel: _userLabel,
  userRole: _userRole,
  desktopOpen = true,
  onToggleDesktop,
  mobileOpen = false,
  onMobileClose,
  masterType = "fmcg",
  onMasterTypeChange,
}: AppSidebarProps) {
  const { user, isAdmin } = useAuth();
  const [masterLists, setMasterLists] = useState<OrgAdminMasterList[]>([
    { key: "fmcg", label: "Master FMCG", enabled: true, sort_order: 0 },
    { key: "minerals_ores", label: "Minerals & Ores", enabled: true, sort_order: 1 },
    { key: "other_items", label: "Other Items", enabled: true, sort_order: 2 },
  ]);
  const [leadsMenuOpen, setLeadsMenuOpen] = useState(activeTab === "table");
  const [mailMenuOpen, setMailMenuOpen] = useState(
    activeTab === "inbox" ||
    activeTab === "activity" ||
    activeTab === "email-templates",
  );
  const [whatsappMenuOpen, setWhatsappMenuOpen] = useState(
    activeTab === "whatsapp-inbox" ||
    activeTab === "whatsapp-templates" ||
    activeTab === "whatsapp-activity" ||
    activeTab === "whatsapp-mobile",
  );
  const [telegramMenuOpen, setTelegramMenuOpen] = useState(
    activeTab === "telegram-mobile" || activeTab === "telegram-templates",
  );
  const [callsMenuOpen, setCallsMenuOpen] = useState(activeTab === "calls");
  const [aiMenuOpen, setAiMenuOpen] = useState(
    activeTab === "ai-mode" ||
    activeTab === "leads" ||
    activeTab === "data-synthesis" ||
    activeTab === "ai-sales-agent" ||
    activeTab === "ai-train" ||
    activeTab === "chatbot",
  );
  const [othersMenuOpen, setOthersMenuOpen] = useState(
    activeTab === "catalogue" ||
    activeTab === "client-history" ||
    activeTab === "helpful-guidance" ||
    activeTab === "target-workspace" ||
    activeTab === "kpi" ||
    activeTab === "users",
  );
  const [indexesMenuOpen, setIndexesMenuOpen] = useState(
    activeTab === "indexes" || activeTab === "user-manual",
  );
  const [horekaMenuOpen, setHorekaMenuOpen] = useState(activeTab === "horeka");
  const [catalogueMenuOpen, setCatalogueMenuOpen] = useState(activeTab === "catalogue");

  useEffect(() => {
    let cancelled = false;

    function applyMerged(apiRows: OrgAdminMasterList[]) {
      const local = localMasterListsForUser(
        loadOrgAdminLocal(),
        user?.id ?? null,
        Boolean(isAdmin),
      );
      const merged = mergeMasterListsForSidebar(apiRows, local);
      if (!cancelled && merged.length) setMasterLists(merged);
    }

    function refresh() {
      void client
        .getMyMasterLists()
        .then((res) => {
          if (cancelled) return;
          applyMerged(res.master_lists || []);
        })
        .catch(() => {
          if (cancelled) return;
          const local = localMasterListsForUser(
            loadOrgAdminLocal(),
            user?.id ?? null,
            Boolean(isAdmin),
          );
          if (local.length) setMasterLists(local);
        });
    }

    refresh();
    const onChanged = () => refresh();
    window.addEventListener(ORG_ADMIN_CHANGED_EVENT, onChanged);
    window.addEventListener("storage", onChanged);
    return () => {
      cancelled = true;
      window.removeEventListener(ORG_ADMIN_CHANGED_EVENT, onChanged);
      window.removeEventListener("storage", onChanged);
    };
  }, [user?.id, isAdmin]);

  const masterListOptions = useMemo(
    () => masterLists.map((m) => ({ value: m.key, label: m.label })),
    [masterLists],
  );

  useEffect(() => {
    if (activeTab === "table") {
      setLeadsMenuOpen(true);
    }
  }, [activeTab]);

  useEffect(() => {
    if (
      activeTab === "inbox" ||
      activeTab === "activity" ||
      activeTab === "email-templates"
    ) {
      setMailMenuOpen(true);
    }
  }, [activeTab]);

  useEffect(() => {
    if (
      activeTab === "whatsapp-inbox" ||
      activeTab === "whatsapp-templates" ||
      activeTab === "whatsapp-activity" ||
      activeTab === "whatsapp-mobile"
    ) {
      setWhatsappMenuOpen(true);
    }
  }, [activeTab]);

  useEffect(() => {
    if (activeTab === "telegram-mobile" || activeTab === "telegram-templates") {
      setTelegramMenuOpen(true);
    }
  }, [activeTab]);

  useEffect(() => {
    if (activeTab === "calls") {
      setCallsMenuOpen(true);
    }
  }, [activeTab]);

  useEffect(() => {
    if (
      activeTab === "ai-mode" ||
      activeTab === "leads" ||
      activeTab === "data-synthesis" ||
      activeTab === "ai-sales-agent" ||
      activeTab === "ai-train" ||
      activeTab === "chatbot"
    ) {
      setAiMenuOpen(true);
    }
  }, [activeTab]);

  useEffect(() => {
    if (
      activeTab === "catalogue" ||
      activeTab === "client-history" ||
      activeTab === "helpful-guidance" ||
      activeTab === "target-workspace" ||
      activeTab === "kpi" ||
      activeTab === "users"
    ) {
      setOthersMenuOpen(true);
    }
  }, [activeTab]);

  useEffect(() => {
    if (activeTab === "indexes" || activeTab === "user-manual") {
      setIndexesMenuOpen(true);
    }
  }, [activeTab]);

  useEffect(() => {
    if (activeTab === "horeka") {
      setHorekaMenuOpen(true);
    }
  }, [activeTab]);

  useEffect(() => {
    if (activeTab === "catalogue") {
      setCatalogueMenuOpen(true);
    }
  }, [activeTab]);

  useEffect(() => {
    if (!mobileOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [mobileOpen]);

  function closeMobile() {
    onMobileClose?.();
  }

  function navIconClass(highlighted: boolean, activeGroup = false) {
    if (highlighted) return "text-white";
    if (activeGroup) return "text-emerald-300";
    return "text-slate-400 group-hover:text-slate-200";
  }

  function closeSidebar() {
    onToggleDesktop?.();
    closeMobile();
  }

  return (
    <>
      <div
        className={`fixed inset-0 z-40 bg-black/60 lg:hidden transition-opacity ${mobileOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
          }`}
        aria-hidden={!mobileOpen}
        onClick={closeMobile}
      />

      <aside
        className={`fixed inset-y-0 left-0 z-50 flex flex-col border-r border-slate-800 bg-slate-950 h-dvh transition-[width,transform] duration-200 ease-out overflow-hidden
          w-[min(20rem,88vw)]
          ${mobileOpen ? "translate-x-0" : "-translate-x-full"}
          lg:sticky lg:top-0 lg:h-screen lg:translate-x-0 lg:bg-slate-900/50
          ${desktopOpen ? "lg:w-80 lg:border-r" : "lg:w-0 lg:border-0"}
        `}
        aria-label="Main navigation"
        aria-hidden={!mobileOpen && !desktopOpen}
      >
        <div
          className={`w-[min(20rem,88vw)] lg:w-80 shrink-0 flex flex-col h-full ${desktopOpen ? "" : "lg:pointer-events-none lg:opacity-0"
            }`}
        >
          <div className="px-5 py-5 sm:py-6 border-b border-slate-800 flex items-start justify-between gap-3">
            <AppBrand variant="sidebar" className="flex-1" />
            <button
              type="button"
              onClick={closeSidebar}
              className="shrink-0 rounded-lg p-2 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
              aria-label="Close sidebar"
              title="Close sidebar"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>

          <nav className="flex-1 overflow-y-auto overscroll-contain px-3 py-4 space-y-1">
            {/* Active Master List Selection — hidden from view on request. Kept mounted (display:none)
                so nothing that depends on it changes; only the build id below stays visible. */}
            <div className="px-3 py-1 mb-2">
              <div className="hidden" aria-hidden="true">
                <label className="block text-[10px] uppercase font-bold tracking-wider text-slate-500 mb-1">
                  Active Master List
                </label>
                <SearchableSelect
                  value={
                    masterLists.some((m) => m.key === masterType)
                      ? masterType
                      : masterLists[0]?.key || masterType
                  }
                  onChange={(next) => onMasterTypeChange?.(next)}
                  options={masterListOptions}
                  multiSelect={false}
                  allowEmpty={false}
                  placeholder="Search master lists…"
                />
              </div>
              <p className="text-[9px] text-slate-600 font-mono truncate" title="Deploy build id — Chrome and Edge should match">
                build {typeof __KAFI_BUILD_ID__ !== "undefined" ? __KAFI_BUILD_ID__ : "dev"}
              </p>
            </div>
            {navItems.map((item) => {
              if ("openMailer" in item && item.openMailer) {
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      onOpenMailer?.();
                      closeMobile();
                    }}
                    className="w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-lg text-sm font-medium text-left transition text-slate-300 hover:bg-slate-800 hover:text-slate-100 group"
                  >
                    <span className="flex items-center gap-2.5 truncate min-w-0">
                      <NavIcon navId="mail" className={navIconClass(false)} />
                      <span className="truncate">{item.label}</span>
                    </span>
                    <IconExternal size="xs" className="text-slate-500 shrink-0" />
                  </button>
                );
              }
              if ("openSalesAssistant" in item && item.openSalesAssistant) {
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      onOpenSalesAssistant?.();
                      closeMobile();
                    }}
                    className="w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-lg text-sm font-medium text-left transition text-slate-300 hover:bg-slate-800 hover:text-slate-100 group"
                  >
                    <span className="flex items-center gap-2.5 truncate min-w-0">
                      <NavIcon navId="sales-assistant" className={navIconClass(false)} />
                      <span className="truncate">{item.label}</span>
                    </span>
                  </button>
                );
              }
              if ("external" in item) {
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      window.open(item.external, "_blank", "noopener,noreferrer");
                      closeMobile();
                    }}
                    className="w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-lg text-sm font-medium text-left transition text-slate-300 hover:bg-slate-800 hover:text-slate-100 group"
                  >
                    <span className="flex items-center gap-2.5 truncate min-w-0">
                      <NavIcon navId="quotation-agent" className={navIconClass(false)} />
                      <span className="truncate">{item.label}</span>
                    </span>
                    <IconExternal size="xs" className="text-slate-500 shrink-0" />
                  </button>
                );
              }

              const isActive =
                item.id === "inbox"
                  ? activeTab === "inbox" ||
                    activeTab === "activity" ||
                    activeTab === "email-templates"
                  : item.id === "whatsapp-inbox"
                    ? activeTab === "whatsapp-inbox" ||
                      activeTab === "whatsapp-templates" ||
                      activeTab === "whatsapp-activity" ||
                      activeTab === "whatsapp-mobile"
                    : item.id === "telegram-mobile"
                      ? activeTab === "telegram-mobile" ||
                        activeTab === "telegram-templates"
                    : item.id === "calls"
                      ? activeTab === "calls"
                      : item.id === "ai"
                        ? activeTab === "ai-mode" ||
                          activeTab === "leads" ||
                          activeTab === "data-synthesis" ||
                          activeTab === "ai-sales-agent" ||
                          activeTab === "ai-train" ||
                          activeTab === "chatbot"
                        : item.id === "others"
                          ? activeTab === "catalogue" ||
                            activeTab === "client-history" ||
                            activeTab === "helpful-guidance" ||
                            activeTab === "target-workspace" ||
                            activeTab === "kpi" ||
                            activeTab === "users"
                          : item.id === "indexes"
                            ? activeTab === "indexes" || activeTab === "user-manual"
                            : activeTab === item.id;
              const hasAlert = Boolean(item.alert);
              const hasChildren = Boolean(item.children?.length);
              const isTableParent = item.id === "table" && hasChildren;
              const isMailParent = item.id === "inbox" && hasChildren;
              const isWhatsAppParent = item.id === "whatsapp-inbox" && hasChildren;
              const isTelegramParent = item.id === "telegram-mobile" && hasChildren;
              const isCallsParent = item.id === "calls" && hasChildren;
              const isAiParent = (item.id === "ai" || item.id === "ai-group") && hasChildren;
              const isOthersParent = item.id === "others" && hasChildren;
              const isIndexesParent = item.id === "indexes" && hasChildren;
              const isHorekaParent = item.id === "horeka" && hasChildren;
              const isCatalogueParent = item.id === "catalogue" && hasChildren;
              const isExpandableParent =
                isTableParent ||
                isMailParent ||
                isWhatsAppParent ||
                isTelegramParent ||
                isCallsParent ||
                isAiParent ||
                isOthersParent ||
                isIndexesParent ||
                isHorekaParent ||
                isCatalogueParent;
              const menuOpen = isTableParent
                ? leadsMenuOpen
                : isMailParent
                  ? mailMenuOpen
                  : isWhatsAppParent
                    ? whatsappMenuOpen
                    : isTelegramParent
                      ? telegramMenuOpen
                    : isCallsParent
                      ? callsMenuOpen
                      : isAiParent
                        ? aiMenuOpen
                        : isOthersParent
                          ? othersMenuOpen
                          : isIndexesParent
                            ? indexesMenuOpen
                            : isHorekaParent
                              ? horekaMenuOpen
                              : isCatalogueParent
                                ? catalogueMenuOpen
                                : false;
              const setMenuOpen = isTableParent
                ? setLeadsMenuOpen
                : isMailParent
                  ? setMailMenuOpen
                  : isWhatsAppParent
                    ? setWhatsappMenuOpen
                    : isTelegramParent
                      ? setTelegramMenuOpen
                    : isCallsParent
                      ? setCallsMenuOpen
                      : isAiParent
                        ? setAiMenuOpen
                        : isOthersParent
                          ? setOthersMenuOpen
                          : isIndexesParent
                            ? setIndexesMenuOpen
                            : isHorekaParent
                              ? setHorekaMenuOpen
                              : isCatalogueParent
                                ? setCatalogueMenuOpen
                                : undefined;
              const defaultChildId = isTableParent
                ? defaultTableSection
                : isWhatsAppParent
                  ? "whatsapp-inbox"
                  : isTelegramParent
                    ? "telegram-mobile"
                  : isCallsParent
                    ? "calls"
                    : isAiParent
                      ? "ai-sales-agent"
                      : isIndexesParent
                        ? "indexes"
                        : isOthersParent
                          ? "quotation-agent"
                          : isHorekaParent
                            ? "horeka-all"
                            : isCatalogueParent
                              ? "catalogue-all"
                              : "inbox";
              const activeChildId = isTableParent
                ? tableSection
                : isMailParent
                  ? activeTab === "activity"
                    ? "activity"
                    : activeTab === "email-templates"
                      ? "email-templates"
                      : mailSection
                  : isWhatsAppParent
                    ? activeTab === "whatsapp-templates"
                      ? "whatsapp-templates"
                      : activeTab === "whatsapp-activity"
                        ? "whatsapp-activity"
                        : activeTab === "whatsapp-mobile"
                          ? "whatsapp-mobile"
                          : "whatsapp-inbox"
                    : isTelegramParent
                      ? activeTab === "telegram-templates"
                        ? "telegram-templates"
                        : "telegram-mobile"
                    : isCallsParent
                      ? "calls"
                      : isAiParent
                        ? activeTab
                        : isIndexesParent
                          ? activeTab === "user-manual"
                            ? "user-manual"
                            : "indexes"
                          : isOthersParent
                            ? activeTab
                            : isHorekaParent
                              ? horekaCategory
                                ? `horeka-${horekaCategory}`
                                : "horeka-all"
                              : isCatalogueParent
                                ? catalogueId
                                  ? `catalogue-${catalogueId}`
                                  : "catalogue-all"
                                : null;
              const parentHighlighted =
                isExpandableParent && isActive && (activeChildId === defaultChildId || !activeChildId)
                  ? true
                  : !isExpandableParent && isActive;

              return (
                <div key={item.id} className="space-y-1">
                  <div
                    className={`w-full flex items-center rounded-lg text-sm font-medium transition group ${
                      parentHighlighted
                        ? "bg-emerald-600 text-white shadow-sm shadow-emerald-900/30"
                        : isExpandableParent && isActive
                          ? "bg-emerald-700/35 text-emerald-100"
                          : "text-slate-300 hover:bg-slate-800 hover:text-slate-100"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        if (isTableParent) {
                          setLeadsMenuOpen((open) => !open);
                          onSelectTab("table");
                          onSelectTableSection?.(defaultTableSection);
                          closeMobile();
                          return;
                        }
                        if (isMailParent) {
                          setMailMenuOpen((open) => !open);
                          onSelectTab("inbox");
                          onSelectMailSection?.("inbox");
                          closeMobile();
                          return;
                        }
                        if (isWhatsAppParent) {
                          setWhatsappMenuOpen((open) => !open);
                          onSelectWhatsAppSection?.("whatsapp-inbox");
                          closeMobile();
                          return;
                        }
                        if (isTelegramParent) {
                          setTelegramMenuOpen((open) => !open);
                          onSelectTab("telegram-mobile");
                          closeMobile();
                          return;
                        }
                        if (isCallsParent) {
                          setCallsMenuOpen((open) => !open);
                          onSelectTab("calls");
                          closeMobile();
                          return;
                        }
                        if (isAiParent) {
                          setAiMenuOpen((open) => !open);
                          onSelectTab("ai-sales-agent");
                          closeMobile();
                          return;
                        }
                        if (isOthersParent) {
                          setOthersMenuOpen((open) => !open);
                          closeMobile();
                          return;
                        }
                        if (isIndexesParent) {
                          setIndexesMenuOpen((open) => !open);
                          onSelectTab("indexes");
                          closeMobile();
                          return;
                        }
                        if (isHorekaParent) {
                          setHorekaMenuOpen((open) => !open);
                          onSelectTab("horeka");
                          onSelectHorekaCategory?.("All");
                          closeMobile();
                          return;
                        }
                        if (isCatalogueParent) {
                          setCatalogueMenuOpen((open) => !open);
                          onSelectTab("catalogue");
                          onSelectCatalogueItem?.("all");
                          closeMobile();
                          return;
                        }
                        if ("openSalesAssistant" in item) return;
                        onSelectTab(item.id as Tab);
                        closeMobile();
                      }}
                      className="flex-1 min-w-0 flex items-center justify-between gap-2 px-3 py-2.5 text-left rounded-lg group"
                    >
                      <span className="flex items-center gap-2.5 truncate min-w-0">
                        {hasAlert && (
                          <span
                            aria-label="new messages"
                            className={`shrink-0 ${
                              parentHighlighted ? "text-white" : "text-emerald-400"
                            } animate-pulse`}
                          >
                            <IconBell size="xs" />
                          </span>
                        )}
                        <NavIcon
                          navId={item.id}
                          label={item.label}
                          className={navIconClass(parentHighlighted, isExpandableParent && isActive)}
                        />
                        <span className="truncate">{item.label}</span>
                      </span>
                      {!isExpandableParent && item.count > 0 ? (
                        <span
                          className={`shrink-0 text-xs tabular-nums px-1.5 py-0.5 rounded ${
                            hasAlert && !parentHighlighted
                              ? "bg-emerald-500/20 text-emerald-300"
                              : parentHighlighted
                                ? "bg-emerald-500/30 text-emerald-50"
                                : "bg-slate-800 text-slate-400"
                          }`}
                        >
                          {item.count}
                        </span>
                      ) : null}
                    </button>

                    {isExpandableParent && setMenuOpen && (
                      <button
                        type="button"
                        aria-label={
                          menuOpen
                            ? `Collapse ${item.label} menu`
                            : `Expand ${item.label} menu`
                        }
                        onClick={(e) => {
                          e.stopPropagation();
                          setMenuOpen((open: boolean) => !open);
                        }}
                        className={`shrink-0 px-2.5 py-2.5 rounded-r-lg ${
                          parentHighlighted || (isExpandableParent && isActive)
                            ? "text-emerald-50/90 hover:bg-emerald-500/20"
                            : "text-slate-400 hover:text-slate-200"
                        }`}
                      >
                        {menuOpen ? (
                          <IconChevronDown size="xs" />
                        ) : (
                          <IconChevronRight size="xs" />
                        )}
                      </button>
                    )}
                  </div>

                  {isExpandableParent && menuOpen && item.children && (
                    <div className="ml-3 pl-2 border-l border-slate-700 space-y-0.5">
                      {item.children.map((child) => {
                        const childActive = isActive && activeChildId === child.id;
                        const mailLabelId = isMailParent ? mailLabelIdFromNavId(child.id) : null;
                        return (
                          <div
                            key={child.id}
                            className={`group/label flex items-center gap-0.5 rounded-lg ${
                              childActive ? "bg-emerald-600 shadow-sm shadow-emerald-900/30" : ""
                            }`}
                          >
                            <button
                              type="button"
                              onClick={() => {
                                if (isTableParent) {
                                  setLeadsMenuOpen(true);
                                  onSelectTab("table");
                                  onSelectTableSection?.(child.id as LeadsTableSection);
                                } else if (isMailParent) {
                                  if (child.id === "mail" || child.openMailer) {
                                    onOpenMailer?.();
                                  } else if (child.id === "activity") {
                                    setMailMenuOpen(true);
                                    onSelectTab("activity");
                                  } else if (child.id === "email-templates") {
                                    setMailMenuOpen(true);
                                    onSelectTab("email-templates");
                                  } else {
                                    setMailMenuOpen(true);
                                    onSelectTab("inbox");
                                    onSelectMailSection?.(child.id as MailSection);
                                  }
                                } else if (isWhatsAppParent) {
                                  setWhatsappMenuOpen(true);
                                  if (child.id === "whatsapp-mobile") {
                                    onSelectTab("whatsapp-mobile");
                                  } else {
                                    onSelectWhatsAppSection?.(child.id as WhatsAppSection);
                                  }
                                } else if (isTelegramParent) {
                                  setTelegramMenuOpen(true);
                                  onSelectTab(child.id as Tab);
                                } else if (isCallsParent) {
                                  setCallsMenuOpen(true);
                                  onSelectTab(child.id as Tab);
                                } else if (isAiParent) {
                                  setAiMenuOpen(true);
                                  onSelectTab(child.id as Tab);
                                } else if (isIndexesParent) {
                                  setIndexesMenuOpen(true);
                                  onSelectTab(child.id as Tab);
                                } else if (isOthersParent) {
                                  if (child.external) {
                                    window.open(child.external, "_blank", "noopener,noreferrer");
                                  } else if (child.id === "catalogue") {
                                    setOthersMenuOpen(true);
                                    onSelectTab("catalogue");
                                    onSelectCatalogueItem?.("all");
                                  } else {
                                    setOthersMenuOpen(true);
                                    onSelectTab(child.id as Tab);
                                  }
                                } else if (isHorekaParent) {
                                  setHorekaMenuOpen(true);
                                  onSelectTab("horeka");
                                  const catName = child.id.startsWith("horeka-")
                                    ? child.id.replace(/^horeka-/, "")
                                    : child.id;
                                  onSelectHorekaCategory?.(catName === "all" ? "All" : child.label);
                                } else if (isCatalogueParent) {
                                  setCatalogueMenuOpen(true);
                                  onSelectTab("catalogue");
                                  const catId = child.id.startsWith("catalogue-")
                                    ? child.id.replace(/^catalogue-/, "")
                                    : child.id;
                                  onSelectCatalogueItem?.(catId);
                                }
                                closeMobile();
                              }}
                              className={`flex-1 min-w-0 flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-sm text-left transition ${childActive
                                  ? "text-white"
                                  : "text-slate-400 hover:bg-slate-800 hover:text-slate-100"
                                }`}
                            >
                              <span className="flex items-center gap-2.5 truncate min-w-0">
                                <NavIcon
                                  navId={child.id}
                                  label={child.label}
                                  className={
                                    childActive
                                      ? "text-white"
                                      : navIconClass(false)
                                  }
                                />
                                <span className="truncate">{child.label}</span>
                              </span>
                              {child.external ? (
                                <IconExternal size="xs" className="text-slate-500 shrink-0" />
                              ) : null}
                              {child.openMailer ? (
                                <IconExternal size="xs" className="text-slate-500 shrink-0" />
                              ) : null}
                              {child.count != null && child.count > 0 ? (
                                <span
                                  className={`shrink-0 text-xs tabular-nums px-1.5 py-0.5 rounded min-w-[1.25rem] text-center ${childActive
                                      ? "bg-emerald-500/30 text-emerald-50"
                                      : child.id === "whatsapp-inbox"
                                        ? "bg-emerald-500 text-white font-semibold"
                                        : "bg-slate-800/80 text-slate-300"
                                    }`}
                                >
                                  {child.count}
                                </span>
                              ) : null}
                            </button>
                            {mailLabelId != null && onDeleteMailLabel ? (
                              <button
                                type="button"
                                title={`Delete label “${child.label}”`}
                                aria-label={`Delete label ${child.label}`}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  onDeleteMailLabel(mailLabelId);
                                }}
                                className={`shrink-0 mr-1 rounded-md p-1.5 transition opacity-0 group-hover/label:opacity-100 focus:opacity-100 ${childActive
                                    ? "text-emerald-100 hover:bg-emerald-500/30"
                                    : "text-slate-500 hover:bg-slate-800 hover:text-rose-300"
                                  }`}
                              >
                                <IconTrash size="sm" />
                              </button>
                            ) : null}
                          </div>
                        );
                      })}
                      {isTableParent && onOpenManageModules && (
                        <div className="pt-1 px-0.5">
                          <button
                            type="button"
                            onClick={() => {
                              onOpenManageModules();
                              closeMobile();
                            }}
                            className="w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-emerald-400 hover:text-emerald-300 hover:bg-slate-800/90 transition-all border border-dashed border-emerald-500/40 shadow-sm"
                            title="Add, remove, or toggle modules under Old clients"
                          >
                            <span>⚙️</span>
                            <span>Manage / Add Lists</span>
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </nav>
        </div>
      </aside>
    </>
  );
}
