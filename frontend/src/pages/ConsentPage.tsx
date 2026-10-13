import { useCallback, useEffect, useState } from "react";
import { client, type ComplianceContact, type ConsentSummary } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { ColumnVisibilityMenu } from "../components/ColumnVisibilityMenu";
import {
  useColumnVisibility,
  type ColumnDef,
} from "../hooks/useColumnVisibility";

interface ConsentPageProps {
  onError: (message: string) => void;
  onSelectLead: (leadId: number) => void;
}

const CONSENT_OPTIONS = [
  { value: "", label: "All consent statuses" },
  { value: "unknown", label: "Unknown" },
  { value: "granted", label: "Granted" },
  { value: "denied", label: "Denied" },
];

const CONSENT_COLUMNS: ColumnDef[] = [
  { id: "select", label: "Select", locked: true },
  { id: "company", label: "Company", locked: true },
  { id: "contact", label: "Contact" },
  { id: "email", label: "Email" },
  { id: "message_status", label: "Message status" },
  { id: "birthday", label: "Birthday" },
  { id: "birthday_ok", label: "Birthday OK" },
];

export function ConsentPage({ onError, onSelectLead }: ConsentPageProps) {
  const { user } = useAuth();
  const columnsUi = useColumnVisibility("consent", CONSENT_COLUMNS, user?.id);
  const [summary, setSummary] = useState<ConsentSummary | null>(null);
  const [contacts, setContacts] = useState<ComplianceContact[]>([]);
  const [loading, setLoading] = useState(true);
  const [consentFilter, setConsentFilter] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [summaryData, contactRows] = await Promise.all([
        client.getConsentSummary(),
        client.listComplianceContacts({
          consent: consentFilter || undefined,
          q: search.trim() || undefined,
        }),
      ]);
      setSummary(summaryData);
      setContacts(contactRows);
      setSelected(new Set());
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to load compliance data");
    } finally {
      setLoading(false);
    }
  }, [consentFilter, onError, search]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  function toggleSelected(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    if (selected.size === contacts.length) {
      setSelected(new Set());
      return;
    }
    setSelected(new Set(contacts.map((c) => c.id)));
  }

  async function bulkSetConsent(status: "granted" | "denied" | "unknown") {
    const ids = [...selected];
    if (ids.length === 0) return;
    const label = status === "granted" ? "grant" : status === "denied" ? "deny" : "reset";
    if (!window.confirm(`${label} consent for ${ids.length} contact(s)?`)) return;

    setSaving(true);
    setNotice(null);
    try {
      const result = await client.bulkUpdateConsent(ids, status);
      setNotice(`Updated consent for ${result.updated_count} contact(s).`);
      await loadData();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Bulk consent update failed");
    } finally {
      setSaving(false);
    }
  }

  async function updateContactField(
    contact: ComplianceContact,
    field: "consent_status" | "date_of_birth" | "nationality",
    value: string,
  ) {
    setSaving(true);
    try {
      await client.updateComplianceContact(contact.id, { [field]: value || undefined });
      await loadData();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to update contact");
    } finally {
      setSaving(false);
    }
  }

  const allSelected = contacts.length > 0 && selected.size === contacts.length;

  return (
    <section className="space-y-4 w-full min-w-0">
      <div>
        <h2 className="text-lg font-medium text-slate-100">Automated messages</h2>
        <p className="text-sm text-slate-500 mt-1">
          Control who can receive scheduled personal messages (birthdays, national days, follow-ups).
          Grant permission and add date of birth where needed for birthday drafts.
        </p>
      </div>

      {summary && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {[
            { label: "Total contacts", value: summary.total, tone: "text-slate-200" },
            { label: "Granted", value: summary.granted, tone: "text-emerald-300" },
            { label: "Unknown", value: summary.unknown, tone: "text-slate-400" },
            { label: "Denied", value: summary.denied, tone: "text-red-300" },
            { label: "With birthday", value: summary.with_birthday, tone: "text-slate-300" },
          ].map((item) => (
            <div
              key={item.label}
              className="rounded-xl border border-slate-800 bg-slate-900 px-4 py-3"
            >
              <p className="text-xs text-slate-500">{item.label}</p>
              <p className={`text-2xl font-semibold mt-1 ${item.tone}`}>{item.value}</p>
            </div>
          ))}
        </div>
      )}

      {notice && (
        <p className="text-sm text-emerald-300/90 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3">
          {notice}
        </p>
      )}

      <div className="rounded-xl border border-slate-800 bg-slate-900 p-4 space-y-3">
        <div className="flex flex-wrap gap-3 items-end">
          <label className="block text-xs text-slate-400 min-w-[160px]">
            Message status
            <select
              value={consentFilter}
              onChange={(e) => setConsentFilter(e.target.value)}
              className="mt-1 w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-200"
            >
              {CONSENT_OPTIONS.map((opt) => (
                <option key={opt.value || "all"} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs text-slate-400 flex-1 min-w-[200px]">
            Search
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Company, contact, email…"
              className="mt-1 w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-200"
            />
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void bulkSetConsent("granted")}
            disabled={selected.size === 0 || saving}
            className="px-3 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-sm disabled:opacity-50"
          >
            Grant selected ({selected.size})
          </button>
          <button
            type="button"
            onClick={() => void bulkSetConsent("denied")}
            disabled={selected.size === 0 || saving}
            className="px-3 py-1.5 rounded-lg bg-red-900/60 hover:bg-red-800 border border-red-800/60 text-sm text-red-200 disabled:opacity-50"
          >
            Deny selected
          </button>
          <button
            type="button"
            onClick={() => void bulkSetConsent("unknown")}
            disabled={selected.size === 0 || saving}
            className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-sm disabled:opacity-50"
          >
            Reset to unknown
          </button>
          <ColumnVisibilityMenu
            className="ml-auto"
            columns={columnsUi.columns}
            isVisible={columnsUi.isVisible}
            toggle={columnsUi.toggle}
            showAll={columnsUi.showAll}
            resetDefaults={columnsUi.resetDefaults}
            hiddenCount={columnsUi.hiddenCount}
          />
        </div>
      </div>

      {loading ? (
        <p className="text-slate-400 text-sm">Loading contacts…</p>
      ) : contacts.length === 0 ? (
        <p className="text-slate-500 text-sm">No contacts match your filters.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-800">
          {columnsUi.css ? <style>{columnsUi.css}</style> : null}
          <table className="w-full text-sm">
            <thead className="bg-slate-900 text-slate-400">
              <tr>
                <th data-col="select" className="p-3 text-left">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleSelectAll}
                    aria-label="Select all contacts"
                  />
                </th>
                <th data-col="company" className="p-3 text-left">Company</th>
                <th data-col="contact" className="p-3 text-left">Contact</th>
                <th data-col="email" className="p-3 text-left">Email</th>
                <th data-col="message_status" className="p-3 text-left">Message status</th>
                <th data-col="birthday" className="p-3 text-left">Birthday</th>
                <th data-col="birthday_ok" className="p-3 text-left">Birthday OK</th>
              </tr>
            </thead>
            <tbody>
              {contacts.map((contact) => (
                <tr key={contact.id} className="border-t border-slate-800 bg-slate-950/40">
                  <td data-col="select" className="p-3">
                    <input
                      type="checkbox"
                      checked={selected.has(contact.id)}
                      onChange={() => toggleSelected(contact.id)}
                      aria-label={`Select ${contact.full_name}`}
                    />
                  </td>
                  <td data-col="company" className="p-3">
                    <button
                      type="button"
                      onClick={() => onSelectLead(contact.buyer_id)}
                      className="text-emerald-400 hover:text-emerald-300 text-left"
                    >
                      {contact.company_name}
                    </button>
                    {contact.country && (
                      <p className="text-xs text-slate-500 mt-0.5">{contact.country}</p>
                    )}
                  </td>
                  <td data-col="contact" className="p-3 text-slate-200">{contact.full_name}</td>
                  <td data-col="email" className="p-3 text-slate-400">{contact.email ?? "—"}</td>
                  <td data-col="message_status" className="p-3">
                    <select
                      value={contact.consent_status}
                      onChange={(e) =>
                        void updateContactField(contact, "consent_status", e.target.value)
                      }
                      disabled={saving}
                      className="rounded-md bg-slate-900 border border-slate-700 px-2 py-1 text-xs text-slate-200"
                    >
                      <option value="unknown">Unknown</option>
                      <option value="granted">Granted</option>
                      <option value="denied">Denied</option>
                    </select>
                  </td>
                  <td data-col="birthday" className="p-3">
                    <input
                      type="date"
                      value={contact.date_of_birth ?? ""}
                      onChange={(e) =>
                        void updateContactField(contact, "date_of_birth", e.target.value)
                      }
                      disabled={saving}
                      className="rounded-md bg-slate-900 border border-slate-700 px-2 py-1 text-xs text-slate-200"
                    />
                  </td>
                  <td data-col="birthday_ok" className="p-3">
                    {contact.birthday_outreach_ok ? (
                      <span className="text-xs text-emerald-300">Ready</span>
                    ) : (
                      <span className="text-xs text-slate-500">Needs consent + DOB</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
