import type {
  LeadsTableSection,
  MailSection,
  Tab,
  WhatsAppSection,
} from "../components/AppSidebar";

export type IndexAction =
  | { type: "tab"; tab: Tab }
  | { type: "table"; section: LeadsTableSection }
  | { type: "mail"; section: MailSection }
  | { type: "whatsapp"; section: WhatsAppSection }
  | {
      type: "ai-mode";
      panel?: "auto-reply" | "lifecycle" | "personalized";
      stage?: string;
    }
  | { type: "external"; url: string }
  | { type: "mailer" };

export type IndexIconKey =
  | "search"
  | "table"
  | "users"
  | "user"
  | "heart"
  | "phone"
  | "x-circle"
  | "message"
  | "template"
  | "inbox"
  | "activity"
  | "mail"
  | "mail-stack"
  | "calendar"
  | "call"
  | "robot"
  | "sparkles"
  | "chart"
  | "quote"
  | "settings";

export interface IndexItem {
  id: string;
  title: string;
  description: string;
  icon: IndexIconKey;
  action: IndexAction;
  adminOnly?: boolean;
}

export interface IndexSection {
  number: number;
  title: string;
  description: string;
  openAction: IndexAction;
  items: IndexItem[];
  adminOnly?: boolean;
}

/** Order matches sidebar: WhatsApp → Discover/Master table → Mail → Vercel mailer → Calls → … */
export const INDEX_SECTIONS: IndexSection[] = [
  {
    number: 1,
    title: "WhatsApp",
    description:
      "Essence brand WhatsApp — inbox, templates, and outbound send activity.",
    openAction: { type: "whatsapp", section: "whatsapp-inbox" },
    items: [
      {
        id: "1.1",
        title: "WhatsApp inbox",
        description: "Essence brand number — conversations and quick replies.",
        icon: "message",
        action: { type: "whatsapp", section: "whatsapp-inbox" },
      },
      {
        id: "1.2",
        title: "WhatsApp Templates Draft",
        description: "Meta-approved templates — bulk or single send from leads table.",
        icon: "template",
        action: { type: "whatsapp", section: "whatsapp-templates" },
      },
      {
        id: "1.3",
        title: "WhatsApp Activity",
        description: "Outbound WhatsApp send log — sent, failed, and bulk batches.",
        icon: "activity",
        action: { type: "whatsapp", section: "whatsapp-activity" },
      },
    ],
  },
  {
    number: 2,
    title: "Searched by AI & Master Table",
    description:
      "Prospect discovery, scrapped leads pool, client outcome buckets, and leads sent to each sales user.",
    openAction: { type: "table", section: "master" },
    items: [
      {
        id: "2.1",
        title: "Searched by AI",
        description: "Search and add new prospects from the web.",
        icon: "search",
        action: { type: "tab", tab: "leads" },
      },
      {
        id: "2.1b",
        title: "Target and Workspace",
        description: "Day-wise country target schedules and the 4-stage outreach funnel.",
        icon: "table",
        action: { type: "tab", tab: "target-workspace" },
      },
      {
        id: "2.2",
        title: "Master Table",
        description: "Overview — assign, score, call, and bulk outreach from one table.",
        icon: "table",
        action: { type: "table", section: "master" },
      },
      {
        id: "2.3",
        title: "New search lead",
        description: "Unassigned prospect pool under Master table.",
        icon: "table",
        action: { type: "table", section: "all" },
      },
      {
        id: "2.4",
        title: "Old clients",
        description: "Repeat buyers and assigned client pool.",
        icon: "users",
        action: { type: "table", section: "old_clients" },
      },
      {
        id: "2.4a",
        title: "Assigned",
        description: "Leads assigned to you — your working list for calls and follow-ups.",
        icon: "users",
        action: { type: "table", section: "my_assigned" },
      },
      {
        id: "2.5",
        title: "Follow up clients",
        description: "Next-call reminders — outcome Follow up, not interest.",
        icon: "phone",
        action: { type: "table", section: "interested_clients" },
      },
      {
        id: "2.6",
        title: "Interested Clients",
        description: "Clients marked interested — from call outcome or manual move.",
        icon: "heart",
        action: { type: "table", section: "sales_interested_clients" },
      },
      {
        id: "2.7",
        title: "Not interested",
        description: "Declined prospects — removed from active follow-up.",
        icon: "x-circle",
        action: { type: "table", section: "not_interested_clients" },
      },
      {
        id: "2.8",
        title: "Did not receive call",
        description: "Unreachable numbers — schedule a retry reminder.",
        icon: "phone",
        action: { type: "table", section: "not_received_call_clients" },
      },
    ],
  },
  {
    number: 3,
    title: "Emails",
    description:
      "Personal IMAP mailbox — inbox, folders, activity log, templates, and custom labels.",
    openAction: { type: "mail", section: "inbox" },
    items: [
      {
        id: "3.1",
        title: "Inbox",
        description: "Read, reply, and compose from your company mailbox.",
        icon: "inbox",
        action: { type: "mail", section: "inbox" },
      },
      {
        id: "3.2",
        title: "Sent",
        description: "Outbound messages already sent from this mailbox.",
        icon: "mail",
        action: { type: "mail", section: "sent" },
      },
      {
        id: "3.3",
        title: "Drafts",
        description: "Saved drafts waiting to be sent.",
        icon: "template",
        action: { type: "mail", section: "drafts" },
      },
      {
        id: "3.4",
        title: "Trash",
        description: "Deleted messages — recover or purge.",
        icon: "x-circle",
        action: { type: "mail", section: "trash" },
      },
      {
        id: "3.5",
        title: "Archive",
        description: "Archived threads kept out of the inbox.",
        icon: "inbox",
        action: { type: "mail", section: "archive" },
      },
      {
        id: "3.6",
        title: "Email Activity",
        description: "Send log — success, failures, and bulk batch status.",
        icon: "mail-stack",
        action: { type: "mail", section: "activity" },
      },
      {
        id: "3.7",
        title: "Email templates",
        description: "Saved templates with buyer merge fields for bulk outreach.",
        icon: "template",
        action: { type: "mail", section: "email-templates" },
      },
      {
        id: "3.8",
        title: "Custom mail labels",
        description: "User labels under Mail (e.g. LinkedIn) — filter inbox by label.",
        icon: "inbox",
        action: { type: "mail", section: "inbox" },
      },
    ],
  },
  {
    number: 4,
    title: "Bulk Email Sender",
    description: "Full mailer web app — labels, drafts, and advanced compose.",
    openAction: { type: "mailer" },
    items: [
      {
        id: "4.1",
        title: "Bulk Email Sender",
        description: "Opens the bulk email sender in the same session when configured.",
        icon: "mail",
        action: { type: "mailer" },
      },
    ],
  },
  {
    number: 5,
    title: "Call Center",
    description: "Twilio call log, floating dialpad, and post-call outcomes.",
    openAction: { type: "tab", tab: "calls" },
    items: [
      {
        id: "5.1",
        title: "Call Center",
        description: "Recent calls with outcomes, notes, and recordings.",
        icon: "call",
        action: { type: "tab", tab: "calls" },
      },
      {
        id: "5.2",
        title: "Floating dialpad",
        description: "Dial any lead from the table — available on every screen.",
        icon: "phone",
        action: { type: "tab", tab: "calls" },
      },
      {
        id: "5.3",
        title: "Call outcomes",
        description:
          "Client is Interested → Interested Clients; Follow up → Follow up clients.",
        icon: "heart",
        action: { type: "table", section: "sales_interested_clients" },
      },
      {
        id: "5.4",
        title: "Client History",
        description: "Past calls, emails, and outcomes per client.",
        icon: "call",
        action: { type: "tab", tab: "client-history" },
      },
      {
        id: "5.5",
        title: "SALES HELP MANAGER",
        description: "Coaching from call history, KPI trends, and voicemail cost tips.",
        icon: "chart",
        action: { type: "tab", tab: "helpful-guidance" },
      },
    ],
  },
  {
    number: 6,
    title: "CNF or FOB",
    description: "ESSENCE catalog quotations with carton specs and PDF export.",
    openAction: { type: "external", url: "__QUOTATION_AGENT__" },
    items: [
      {
        id: "6.1",
        title: "CNF or FOB",
        description: "Build ESSENCE quotations with carton specs and PDF export.",
        icon: "quote",
        action: { type: "external", url: "__QUOTATION_AGENT__" },
      },
    ],
  },
  {
    number: 7,
    title: "AI Research & Update",
    description: "Ask about Kafi / ESSENCE products, specs, and export guidance.",
    openAction: { type: "tab", tab: "chatbot" },
    items: [
      {
        id: "7.1",
        title: "AI Research & Update",
        description: "Chatbot for product and export questions.",
        icon: "robot",
        action: { type: "tab", tab: "chatbot" },
      },
    ],
  },
  {
    number: 8,
    title: "AI Mode",
    description:
      "Company lifecycle, personalized post-call emails, auto-reply, and team activity feeds.",
    openAction: { type: "ai-mode", panel: "lifecycle" },
    items: [
      {
        id: "8.1",
        title: "Company lifecycle",
        description: "New Lead queries through negotiation — team-wide lead stages.",
        icon: "sparkles",
        action: { type: "ai-mode", panel: "lifecycle" },
      },
      {
        id: "8.2",
        title: "Personalized Emails",
        description:
          "Post-call drafts from closed captions for Interested / Follow up — review then send email + WhatsApp.",
        icon: "sparkles",
        action: { type: "ai-mode", panel: "personalized" },
      },
      {
        id: "8.3",
        title: "Auto-reply settings",
        description: "Keywords, templates, and WhatsApp/email auto-reply toggles.",
        icon: "sparkles",
        action: { type: "ai-mode", panel: "auto-reply" },
      },
      {
        id: "8.4",
        title: "New Lead (queries)",
        description: "Inbox scan for buyer inquiry emails — reply from your mailbox.",
        icon: "inbox",
        action: { type: "ai-mode", panel: "lifecycle", stage: "new_lead" },
      },
      {
        id: "8.5",
        title: "Potential Clients",
        description: "AA/AAA scrapped leads — assign to sales users.",
        icon: "users",
        action: { type: "ai-mode", panel: "lifecycle", stage: "potential_clients" },
        adminOnly: true,
      },
      {
        id: "8.6",
        title: "Assigned / Calling / Follow-up feeds",
        description: "Per-user activity — transfers, calls, and follow-up placements.",
        icon: "activity",
        action: { type: "ai-mode", panel: "lifecycle", stage: "assigned" },
      },
      {
        id: "8.7",
        title: "Interested lifecycle feed",
        description: "Who added clients to Interested Clients — admin team scores.",
        icon: "heart",
        action: { type: "ai-mode", panel: "lifecycle", stage: "interested" },
      },
    ],
  },
  {
    number: 9,
    title: "KPI",
    description: "Per-user and team activity reports for calls, emails, and outcomes.",
    openAction: { type: "tab", tab: "kpi" },
    items: [
      {
        id: "9.1",
        title: "KPI",
        description: "Calls, emails, outcomes, and team rollup for admins.",
        icon: "chart",
        action: { type: "tab", tab: "kpi" },
      },
    ],
  },
  {
    number: 10,
    title: "Users",
    description: "Create sales accounts, mailboxes, roles, and lead assignment (admin).",
    openAction: { type: "tab", tab: "users" },
    adminOnly: true,
    items: [
      {
        id: "10.1",
        title: "Users",
        description: "Create sales accounts, mailboxes, and admin access.",
        icon: "user",
        action: { type: "tab", tab: "users" },
        adminOnly: true,
      },
      {
        id: "10.2",
        title: "Assign leads to sales users",
        description: "Transfer scrapped leads — appears as Leads Sent To {user} in sidebar.",
        icon: "users",
        action: { type: "table", section: "master" },
        adminOnly: true,
      },
    ],
  },
];

export interface AssigneeIndexInput {
  id: number;
  username: string;
}

function assigneeIndexItems(assignees: AssigneeIndexInput[]): IndexItem[] {
  return assignees.map((user, index) => ({
    id: `2.${9 + index}`,
    title: `Leads Sent To ${user.username}`,
    description: `Leads assigned to ${user.username} — open their working list.`,
    icon: "users" as const,
    action: {
      type: "table" as const,
      section: `assigned:${user.id}` as LeadsTableSection,
    },
  }));
}

export function visibleIndexSections(
  isAdmin: boolean,
  assignees: AssigneeIndexInput[] = [],
  opts: { hideOutcomeBuckets?: boolean } = {},
): IndexSection[] {
  const hiddenOutcomeIds = new Set(["2.5", "2.6", "2.7", "2.8"]);
  return INDEX_SECTIONS.filter((section) => !section.adminOnly || isAdmin).map(
    (section) => {
      let items = section.items.filter((item) => !item.adminOnly || isAdmin);
      if (opts.hideOutcomeBuckets) {
        items = items.filter((item) => !hiddenOutcomeIds.has(item.id));
      }
      if (section.number === 2 && assignees.length > 0) {
        items = [...items, ...assigneeIndexItems(assignees)];
      }
      return { ...section, items };
    },
  );
}
