import { useCallback, useEffect, useState, type FormEvent } from "react";
import { client, type Contact, type ContactCreate, type ContactUpdate } from "../api/client";
import { CallLeadButton } from "./CallLeadButton";
import { DialpadPhoneText } from "./DialpadPhoneText";
import {
  autocorrectText,
  capitalizeFirstLetter,
  spellingInputProps,
} from "../utils/spelling";

interface ContactsPanelProps {
  leadId: number;
  onError: (message: string) => void;
  onContactsChange?: () => void;
}

const emptyForm = {
  full_name: "",
  designation: "",
  email: "",
  phone: "",
  consent_status: "unknown",
};

const CONSENT_LABELS: Record<string, string> = {
  unknown: "Unknown",
  granted: "Granted",
  denied: "Denied",
};

function ConsentBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    granted: "bg-emerald-500/10 border-emerald-500/30 text-emerald-300",
    denied: "bg-red-500/10 border-red-500/30 text-red-300",
    unknown: "bg-slate-700/50 border-slate-600 text-slate-400",
  };
  return (
    <span
      className={`px-2 py-0.5 rounded text-xs border ${styles[status] ?? styles.unknown}`}
      title="Permission for automated personal messages (birthdays, etc.)"
    >
      {CONSENT_LABELS[status] ?? status}
    </span>
  );
}

export function ContactsPanel({ leadId, onError, onContactsChange }: ContactsPanelProps) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState(emptyForm);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState(emptyForm);
  const [savingId, setSavingId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const loadContacts = useCallback(async () => {
    setLoading(true);
    try {
      setContacts(await client.listLeadContacts(leadId));
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to load contacts");
    } finally {
      setLoading(false);
    }
  }, [leadId, onError]);

  useEffect(() => {
    loadContacts();
  }, [loadContacts]);

  function notifyChange() {
    onContactsChange?.();
  }

  async function handleAdd(event: FormEvent) {
    event.preventDefault();
    if (!addForm.full_name.trim()) {
      onError("Contact name is required");
      return;
    }

    setAdding(true);
    try {
      const payload: ContactCreate = {
        buyer_id: leadId,
        full_name: autocorrectText(addForm.full_name, "name"),
        designation: autocorrectText(addForm.designation, "prose") || undefined,
        email: addForm.email.trim() || undefined,
        phone: addForm.phone.trim() || undefined,
        consent_status: addForm.consent_status,
      };
      await client.createContact(payload);
      setAddForm(emptyForm);
      setShowAdd(false);
      await loadContacts();
      notifyChange();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to add contact");
    } finally {
      setAdding(false);
    }
  }

  function startEdit(contact: Contact) {
    setEditingId(contact.id);
    setEditForm({
      full_name: contact.full_name,
      designation: contact.designation ?? "",
      email: contact.email ?? "",
      phone: contact.phone ?? "",
      consent_status: contact.consent_status ?? "unknown",
    });
  }

  function cancelEdit() {
    setEditingId(null);
    setEditForm(emptyForm);
  }

  async function handleSaveEdit(contactId: number) {
    if (!editForm.full_name.trim()) {
      onError("Contact name is required");
      return;
    }

    setSavingId(contactId);
    try {
      const payload: ContactUpdate = {
        full_name: autocorrectText(editForm.full_name, "name"),
        designation: autocorrectText(editForm.designation, "prose") || undefined,
        email: editForm.email.trim() || undefined,
        phone: editForm.phone.trim() || undefined,
        consent_status: editForm.consent_status,
      };
      await client.updateContact(contactId, payload);
      setEditingId(null);
      await loadContacts();
      notifyChange();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to update contact");
    } finally {
      setSavingId(null);
    }
  }

  async function handleDelete(contact: Contact) {
    const confirmed = window.confirm(
      `Remove ${contact.full_name}? Any drafts linked to this contact will also be removed.`,
    );
    if (!confirmed) return;

    setDeletingId(contact.id);
    try {
      await client.deleteContact(contact.id);
      await loadContacts();
      notifyChange();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to delete contact");
    } finally {
      setDeletingId(null);
    }
  }

  const hasEmailContact = contacts.some((c) => c.email?.trim());

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
      <div className="flex items-center justify-between gap-3 mb-4">
        <div>
          <h3 className="text-sm font-medium text-slate-300">Contacts</h3>
          <p className="text-xs text-slate-500 mt-0.5">
            At least one email is required to send outreach.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowAdd((v) => !v)}
          className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-sm shrink-0"
        >
          {showAdd ? "Cancel" : "Add contact"}
        </button>
      </div>

      {!hasEmailContact && contacts.length > 0 && (
        <p className="text-sm text-amber-300/90 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 mb-4">
          No contact has an email yet — add one before sending email.
        </p>
      )}

      {loading ? (
        <p className="text-sm text-slate-400">Loading contacts…</p>
      ) : contacts.length === 0 && !showAdd ? (
        <p className="text-sm text-slate-500">
          No contacts yet. Add a person to send emails to this lead.
        </p>
      ) : (
        <ul className="space-y-3">
          {contacts.map((contact) =>
            editingId === contact.id ? (
              <li
                key={contact.id}
                className="rounded-lg border border-emerald-500/30 bg-slate-950 p-4 space-y-3"
              >
                <ContactFormFields
                  form={editForm}
                  onChange={(field, value) => setEditForm((prev) => ({ ...prev, [field]: value }))}
                />
                <div className="flex gap-2 justify-end">
                  <button
                    type="button"
                    onClick={cancelEdit}
                    className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-sm"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSaveEdit(contact.id)}
                    disabled={savingId === contact.id}
                    className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-medium disabled:opacity-50"
                  >
                    {savingId === contact.id ? "Saving…" : "Save"}
                  </button>
                </div>
              </li>
            ) : (
              <li
                key={contact.id}
                className="rounded-lg border border-slate-800 bg-slate-950 p-4 flex flex-wrap items-start justify-between gap-3"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-medium text-slate-200">{contact.full_name}</p>
                    <ConsentBadge status={contact.consent_status} />
                  </div>
                  {contact.designation && (
                    <p className="text-xs text-slate-500 mt-0.5">{contact.designation}</p>
                  )}
                  <div className="mt-2 space-y-0.5 text-sm">
                    {contact.email ? (
                      <a
                        href={`mailto:${contact.email}`}
                        className="text-emerald-400 hover:text-emerald-300 block truncate"
                      >
                        {contact.email}
                      </a>
                    ) : (
                      <p className="text-slate-500">No email</p>
                    )}
                    {contact.phone ? (
                      <div className="flex items-center gap-2 flex-wrap">
                        <DialpadPhoneText
                          phone={contact.phone}
                          contactName={contact.full_name}
                          className="text-slate-400 hover:text-sky-300 hover:underline cursor-pointer"
                        />
                        <CallLeadButton
                          leadId={leadId}
                          phone={contact.phone}
                          contactId={contact.id}
                          onError={onError}
                          compact
                        />
                      </div>
                    ) : null}
                  </div>
                </div>
                <div className="flex gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => startEdit(contact)}
                    className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(contact)}
                    disabled={deletingId === contact.id}
                    className="px-2.5 py-1 rounded-lg bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 text-red-300 text-xs disabled:opacity-50"
                  >
                    {deletingId === contact.id ? "…" : "Remove"}
                  </button>
                </div>
              </li>
            ),
          )}
        </ul>
      )}

      {showAdd && (
        <form onSubmit={handleAdd} className="mt-4 rounded-lg border border-emerald-500/30 bg-slate-950 p-4 space-y-3">
          <p className="text-sm font-medium text-slate-300">New contact</p>
          <ContactFormFields
            form={addForm}
            onChange={(field, value) => setAddForm((prev) => ({ ...prev, [field]: value }))}
          />
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={() => {
                setShowAdd(false);
                setAddForm(emptyForm);
              }}
              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-sm"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={adding}
              className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-medium disabled:opacity-50"
            >
              {adding ? "Adding…" : "Add contact"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

function ContactFormFields({
  form,
  onChange,
}: {
  form: typeof emptyForm;
  onChange: (field: keyof typeof emptyForm, value: string) => void;
}) {
  const inputClass =
    "mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600";

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="block sm:col-span-2">
        <span className="text-sm text-slate-400">Full name *</span>
        <input
          type="text"
          required
          value={form.full_name}
          onChange={(e) =>
            onChange("full_name", capitalizeFirstLetter(e.target.value))
          }
          onBlur={(e) => onChange("full_name", autocorrectText(e.target.value, "name"))}
          placeholder="e.g. Ahmed Al-Rashid"
          className={inputClass}
          {...spellingInputProps("name")}
        />
      </label>
      <label className="block">
        <span className="text-sm text-slate-400">Email</span>
        <input
          type="email"
          value={form.email}
          onChange={(e) => onChange("email", e.target.value)}
          placeholder="name@company.com"
          className={inputClass}
          {...spellingInputProps("off")}
        />
      </label>
      <label className="block">
        <span className="text-sm text-slate-400">Phone</span>
        <input
          type="tel"
          value={form.phone}
          onChange={(e) => onChange("phone", e.target.value)}
          placeholder="+971..."
          className={inputClass}
          {...spellingInputProps("off")}
        />
      </label>
      <label className="block sm:col-span-2">
        <span className="text-sm text-slate-400">Designation</span>
        <input
          type="text"
          value={form.designation}
          onChange={(e) =>
            onChange("designation", capitalizeFirstLetter(e.target.value))
          }
          onBlur={(e) =>
            onChange("designation", autocorrectText(e.target.value, "prose"))
          }
          placeholder="e.g. Procurement Manager"
          className={inputClass}
          {...spellingInputProps("prose")}
        />
      </label>
      <label className="block sm:col-span-2">
        <span className="text-sm text-slate-400">Automated messages</span>
        <select
          value={form.consent_status}
          onChange={(e) => onChange("consent_status", e.target.value)}
          className={inputClass}
        >
          <option value="unknown">Unknown</option>
          <option value="granted">Granted — OK for birthdays &amp; personal messages</option>
          <option value="denied">Denied — no automated personal messages</option>
        </select>
      </label>
    </div>
  );
}
