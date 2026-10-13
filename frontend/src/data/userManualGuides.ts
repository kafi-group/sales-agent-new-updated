export interface UserManualGuide {
  whoFor: string;
  overview: string;
  steps: string[];
  tips?: string[];
}

export const SECTION_MANUAL_OVERVIEWS: Record<number, string> = {
  1: "WhatsApp is listed first in the sidebar: inbox, templates, and WhatsApp Activity (send log). Use templates for cold outbound; inbox for conversations.",
  2: "Discover Leads and Master table follow WhatsApp. Under Master table the sidebar lists Scrapped Leads, client outcome buckets, then Leads Sent To each sales user — in that order.",
  3: "Mail folders match the sidebar: Inbox, Sent, Drafts, Trash, Archive, Email Activity, Email templates, Personalized Emails, then any custom labels you create.",
  4: "Vercel mailer sits below Mail in the sidebar — a separate full mailer app with the same login session.",
  5: "Calls uses Twilio. Always set a call outcome after hanging up — it moves leads into the correct Master table bucket.",
  6: "Quotation agent opens in a new tab for ESSENCE PDF quotes with catalog line items.",
  7: "AI Research & Update is the in-app chatbot for product and export questions.",
  8: "AI Mode covers auto-reply and the company lifecycle tabs (New Lead through Interested). Admin sees all users' activity feeds.",
  9: "KPI Generation reports logged activity — calls, emails, outcomes — for you or the whole team.",
  10: "Users (admin only) — create accounts and assign leads, which creates Leads Sent To {username} under Master table.",
};

export const USER_MANUAL_GUIDES: Record<string, UserManualGuide> = {
  "1.1": {
    whoFor: "Admin and sales users",
    overview:
      "WhatsApp inbox for the Essence brand number — view threads and reply when configured.",
    steps: [
      "Open WhatsApp → WhatsApp inbox in the sidebar (first section).",
      "Browse conversations linked to your Meta WhatsApp Business account.",
      "Reply within the 24-hour session window or use an approved template to re-open.",
      "Inbound messages may require a public webhook URL on production — outbound works from localhost.",
    ],
    tips: ["Only send marketing messages to contacts with opt-in where required."],
  },
  "1.2": {
    whoFor: "Admin and sales users",
    overview:
      "Send Meta-approved WhatsApp templates to one or many leads from the leads table.",
    steps: [
      "Open WhatsApp → WhatsApp templates to sync and preview approved templates.",
      "In any leads table, select rows and choose bulk WhatsApp, or use the WA button on a single row.",
      "Fill template variables (name, product, etc.) and confirm send.",
      "Skipped sends usually mean missing phone number or opt-in — check the lead contact.",
    ],
    tips: ["Templates must be approved in Meta Business Manager before they appear here."],
  },
  "1.3": {
    whoFor: "Admin and sales users",
    overview: "WhatsApp send activity — successes, failures, and bulk batches (not under Email Activity).",
    steps: [
      "Open WhatsApp → WhatsApp Activity in the sidebar.",
      "Review sent / failed / bulk events for WhatsApp only.",
      "Use Mark read or Insights the same way as Email Activity.",
    ],
    tips: [
      "Email Activity under Mail no longer shows WhatsApp events.",
      "If you see “Cloud API is not configured”, set WHATSAPP_ACCESS_TOKEN on Railway.",
    ],
  },
  "2.1": {
    whoFor: "Admin only",
    overview:
      "Find new importers and distributors online and add them as scrapped leads before assignment.",
    steps: [
      "Open Discover Leads in the sidebar (below WhatsApp).",
      "Search by company name, country, or product keywords relevant to Kafi.",
      "Review results and open a lead profile for website signals and product fit.",
      "Use Create lead for trade-show cards or manual entry.",
      "New leads land in Scrapped Leads / Master table until assigned.",
    ],
    tips: ["Prefer warm sources (trade shows, referrals) over cold scraping where possible."],
  },
  "2.2": {
    whoFor: "Admin only",
    overview:
      "Master table is the parent view in the sidebar — grade, assign, call, and bulk-email from here.",
    steps: [
      "Click Master table in the sidebar to open the full admin leads view.",
      "Use filters and search by country, grade, or assignee.",
      "Set Assigned to to transfer leads to a sales user (logged in AI Mode → Assigned).",
      "Use row actions: call, email, WhatsApp, edit contact, or open buyer profile.",
      "Bulk-select rows for bulk email or bulk WhatsApp.",
    ],
    tips: ["AA/AAA graded leads also appear under AI Mode → Potential Clients."],
  },
  "2.3": {
    whoFor: "Admin only",
    overview:
      "Scrapped Leads is the first child under Master table — unassigned prospect pool.",
    steps: [
      "Expand Master table in the sidebar and click Scrapped Leads.",
      "Review unassigned scrapped rows before distributing to sales users.",
      "Assign from here or from the main Master table view.",
      "Counts on the sidebar badge reflect rows in this pool.",
    ],
    tips: ["Assign in batches before a campaign so KPIs attribute work correctly."],
  },
  "2.4": {
    whoFor: "Admin and sales users",
    overview:
      "Old clients (admin) or Clients (sales) — repeat buyers and assigned active prospects.",
    steps: [
      "Under Master table, click Old clients / Clients.",
      "Sales users only see leads assigned to them; admin sees all old clients.",
      "Click a row to open buyer profile — history, contacts, calls, research.",
      "Update remarks, schedule follow-ups, and log calls from the profile or table.",
    ],
    tips: ["Keep phone numbers and emails up to date before bulk outreach."],
  },
  "2.5": {
    whoFor: "Admin and sales users",
    overview:
      "Follow up clients — next call scheduled, not the same as Interested Clients.",
    steps: [
      "On post-call remarks, select outcome Follow up (not Client is Interested).",
      "Optionally set a follow-up date on the lead row or buyer profile.",
      "When due, a reminder toast appears if notifications are enabled.",
      "AI Mode → Follow-up tab logs who placed each lead in this bucket.",
    ],
    tips: ["Do not use Follow up when the client is genuinely interested."],
  },
  "2.6": {
    whoFor: "Admin and sales users",
    overview: "Interested Clients — buyer showed buying intent.",
    steps: [
      "After a call, choose outcome Client is Interested in the post-call modal.",
      "Or select rows → Move to Interested Clients from any table.",
      "View under Master table → Interested Clients in the sidebar.",
      "AI Mode → Interested feed tracks who added each client (admin sees all users).",
    ],
    tips: ["Client is Interested ≠ Follow up — use the correct outcome every time."],
  },
  "2.7": {
    whoFor: "Admin and sales users",
    overview: "Prospects who declined — keeps the pipeline clean.",
    steps: [
      "Set call outcome Not interested after the call.",
      "The lead moves to Not interested under Master table automatically.",
      "Correct mistaken outcomes on the latest call if needed.",
    ],
    tips: ["Add a short remark so the team knows why they declined."],
  },
  "2.8": {
    whoFor: "Admin and sales users",
    overview: "No answer — retry later without marking interest or decline.",
    steps: [
      "Set outcome Did not receive call when the line did not connect.",
      "Schedule a follow-up date for your retry.",
      "Leads appear under Did not receive call in the sidebar.",
    ],
    tips: ["Try different times of day before marking Not interested."],
  },
  "2.assignee": {
    whoFor: "Admin only",
    overview:
      "Leads Sent To {username} — each sales user has their own assigned list under Master table.",
    steps: [
      "Expand Master table in the sidebar — each active user appears as Leads Sent To {username}.",
      "Click a user to see only leads assigned to them.",
      "Assign from Master table or Scrapped Leads using the Assigned to dropdown.",
      "Transfers appear in AI Mode → Assigned feed.",
      "Sales users see their assigned leads under Clients, not these admin assignee views.",
    ],
    tips: ["Balance load across reps using KPI and Assigned feed counts."],
  },
  "3.1": {
    whoFor: "Admin and sales users",
    overview: "Primary IMAP inbox — read, search, and reply.",
    steps: [
      "Open Mail → Inbox in the sidebar.",
      "Unread count and new-mail toasts poll when the app is open.",
      "Open a message, reply, or compose from the leads table email button.",
    ],
    tips: ["Use Refresh in the top bar if counts look stale."],
  },
  "3.2": {
    whoFor: "Admin and sales users",
    overview: "Sent folder — outbound messages from your mailbox.",
    steps: [
      "Open Mail → Sent under the Mail section.",
      "Review messages already delivered from this account.",
      "Open a thread to confirm content or follow up manually.",
    ],
  },
  "3.3": {
    whoFor: "Admin and sales users",
    overview: "Drafts — messages saved but not yet sent.",
    steps: [
      "Open Mail → Drafts.",
      "Resume editing and send, or delete unwanted drafts.",
    ],
  },
  "3.4": {
    whoFor: "Admin and sales users",
    overview: "Trash — deleted messages.",
    steps: [
      "Open Mail → Trash.",
      "Recover mistakenly deleted mail or leave to purge per mailbox rules.",
    ],
  },
  "3.5": {
    whoFor: "Admin and sales users",
    overview: "Archive — threads moved out of the inbox.",
    steps: [
      "Open Mail → Archive.",
      "Search archived conversations when a buyer references an old thread.",
    ],
  },
  "3.6": {
    whoFor: "Admin and sales users",
    overview: "Email Activity — send audit trail.",
    steps: [
      "Open Mail → Email Activity.",
      "Admin sees all users; sales see only their own sends.",
      "Filter by event type — sent, failed, bulk completed, etc.",
    ],
    tips: ["Fix SMTP/IMAP credentials in Users if authentication failures appear."],
  },
  "3.7": {
    whoFor: "Admin and sales users",
    overview: "Reusable email templates with merge fields.",
    steps: [
      "Open Mail → Email templates.",
      "Create or edit templates with contact/company placeholders.",
      "Use Template tab in bulk email from the leads table.",
    ],
  },
  "3.8": {
    whoFor: "Admin and sales users",
    overview:
      "Post-call personalized drafts from closed captions for Interested and Follow up clients.",
    steps: [
      "After a call, mark the outcome as Interested or Follow up (not Not interested / Did not receive).",
      "Open Mail → Personalized Emails when captions or remarks are ready.",
      "Review/edit the draft, then click Send email + WhatsApp.",
    ],
    tips: [
      "Nothing auto-sends — you always approve the message first.",
      "Email and WhatsApp stay synchronized — one message is sent on both channels.",
      "WhatsApp free-text may fail outside the 24-hour session window; email can still succeed.",
    ],
  },
  "3.9": {
    whoFor: "Admin and sales users",
    overview: "Custom labels under Mail (e.g. LinkedIn) — filter by label.",
    steps: [
      "Custom labels appear at the bottom of the Mail submenu after you create them.",
      "Click a label to filter messages tagged with it.",
      "Manage labels from the mailer or inbox label controls when available.",
    ],
    tips: ["Label names and counts match what you configured in your mailbox."],
  },
  "4.1": {
    whoFor: "Admin and sales users",
    overview: "Vercel mailer — separate full mail UI below Mail in the sidebar.",
    steps: [
      "Click Vercel mailer — session exchanges automatically when configured.",
      "Use for advanced threading, labels, and compose flows.",
      "Compose links from the leads table can open the mailer directly.",
    ],
  },
  "5.1": {
    whoFor: "Admin and sales users",
    overview: "Calls log — rolling history with outcomes and recordings.",
    steps: [
      "Open Calls in the sidebar (below Vercel mailer).",
      "Review recent calls with company, contact, duration, and outcome.",
      "Click a row to open buyer profile or play recording.",
    ],
    tips: ["Each call also appears in AI Mode → Calling for admin."],
  },
  "5.2": {
    whoFor: "Admin and sales users",
    overview: "Floating dialpad on every screen.",
    steps: [
      "Click the floating phone button after logging in.",
      "Dial from a lead row or enter a number manually.",
      "Complete post-call remarks and outcome when the call ends.",
    ],
  },
  "5.3": {
    whoFor: "Admin and sales users",
    overview: "Four outcomes control Master table buckets and AI Mode feeds.",
    steps: [
      "Client is Interested → Interested Clients + AI Mode Interested.",
      "Follow up → Follow up clients only.",
      "Not interested → Not interested table.",
      "Did not receive call → Did not receive call bucket.",
    ],
  },
  "6.1": {
    whoFor: "Admin and sales users",
    overview: "Quotation agent — ESSENCE PDF quotes (opens new tab).",
    steps: [
      "Click Quotation agent in the sidebar.",
      "Add catalog SKUs, incoterms, validity, and carton notes.",
      "Download PDF and share with the buyer.",
    ],
    tips: ["Carton dimensions come from the imported CARTONS SIZE LIST."],
  },
  "7.1": {
    whoFor: "Admin and sales users",
    overview: "AI Research & Update chatbot for Kafi product questions.",
    steps: [
      "Open AI Research & Update in the sidebar.",
      "Ask about products, categories, certifications, or specs.",
      "Use answers to draft emails or call scripts — confirm pricing with admin.",
    ],
  },
  "8.1": {
    whoFor: "Admin and sales users",
    overview: "AI Mode auto-reply for query emails.",
    steps: [
      "Open AI Mode → Auto-reply panel.",
      "Toggle AI Mode ON and configure keywords and templates.",
      "Save and test with Scan mailbox on the lifecycle tab.",
    ],
  },
  "8.2": {
    whoFor: "Admin and sales users",
    overview: "New Lead (queries) — keyword-matched inquiry emails.",
    steps: [
      "AI Mode → Company lifecycle → New Lead (Queries).",
      "Scan mailbox for latest keyword matches.",
      "Select a query, read the email, and send a personal reply.",
    ],
  },
  "8.3": {
    whoFor: "Admin only",
    overview: "Potential Clients — AA/AAA scrapped leads for assignment.",
    steps: [
      "AI Mode → Potential Clients.",
      "Review dual AA/AAA grades.",
      "Assign using the dropdown — updates Master table and Assigned feed.",
    ],
  },
  "8.4": {
    whoFor: "Admin and sales users",
    overview: "Assigned, Calling, and Follow-up lifecycle activity feeds.",
    steps: [
      "Assigned — lead transfer batches to each user.",
      "Calling — every logged call statement.",
      "Follow-up — Follow up client placements and scheduled dates.",
    ],
  },
  "8.5": {
    whoFor: "Admin and sales users",
    overview: "Interested lifecycle feed — mirrors Interested Clients with per-user scores.",
    steps: [
      "AI Mode → Interested tab.",
      "Admin sees per-user chips (e.g. Asim: 3, Usman: 5).",
      "Sales users see their own feed and placement count.",
    ],
  },
  "9.1": {
    whoFor: "Admin and sales users",
    overview: "KPI Generation — activity report for a date range.",
    steps: [
      "Open KPI Generation in the sidebar.",
      "Sales: own metrics. Admin: pick a user or team rollup.",
      "Generate and export PDF for reviews.",
    ],
  },
  "10.1": {
    whoFor: "Admin only",
    overview: "User accounts, roles, and mailbox credentials.",
    steps: [
      "Open Users (last item in sidebar for admin).",
      "Add username, role, password, and IMAP/SMTP settings.",
      "Deactivate users when they leave — do not share logins.",
    ],
  },
  "10.2": {
    whoFor: "Admin only",
    overview: "Assigning leads creates Leads Sent To {user} under Master table.",
    steps: [
      "From Master table or Scrapped Leads, set Assigned to on each row.",
      "Or bulk-assign from AI Mode → Potential Clients.",
      "Each user gets a Leads Sent To {username} entry in the sidebar.",
    ],
  },
};

export function guideForIndexItem(indexId: string): UserManualGuide | null {
  const section2Assignee = indexId.match(/^2\.(\d+)$/);
  if (section2Assignee && Number(section2Assignee[1]) >= 9) {
    return USER_MANUAL_GUIDES["2.assignee"] ?? null;
  }
  return USER_MANUAL_GUIDES[indexId] ?? null;
}
