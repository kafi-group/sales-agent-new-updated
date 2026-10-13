import { useCallback, useEffect, useMemo, useState } from "react";
import {
  client,
  type CallFollowupDraft,
  type CallFollowupGroup,
  type CallFollowupMode,
  type CatalogueItem,
} from "../api/client";

interface CallFollowupsPanelProps {
  onError: (message: string) => void;
}

type DraftForm = {
  name: string;
  subject: string;
  body: string;
  whatsapp_text: string;
  attachment_mode: "none" | "auto" | "catalogue";
  catalogue_ids: string[];
  enabled: boolean;
};

function draftToForm(d: CallFollowupDraft): DraftForm {
  return {
    name: d.name,
    subject: d.subject,
    body: d.body,
    whatsapp_text: d.whatsapp_text,
    attachment_mode: d.attachment_mode,
    catalogue_ids: d.catalogue_ids || [],
    enabled: d.enabled,
  };
}

const EMPTY_DRAFT: DraftForm = {
  name: "",
  subject: "",
  body: "",
  whatsapp_text: "",
  attachment_mode: "none",
  catalogue_ids: [],
  enabled: true,
};

const inputCls =
  "w-full rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-emerald-500/60 focus:outline-none";
const labelCls = "block text-[11px] font-medium uppercase tracking-wide text-slate-400 mb-1";

export function CallFollowupsPanel({ onError }: CallFollowupsPanelProps) {
  const [groups, setGroups] = useState<CallFollowupGroup[]>([]);
  const [placeholders, setPlaceholders] = useState<string[]>([]);
  const [mode, setMode] = useState<CallFollowupMode>("test_only");
  const [catalogues, setCatalogues] = useState<CatalogueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Group editor
  const [groupName, setGroupName] = useState("");
  const [groupDesc, setGroupDesc] = useState("");
  const [groupEnabled, setGroupEnabled] = useState(true);

  // Draft editor: null = closed, "new" = creating, number = editing that draft id
  const [draftEditing, setDraftEditing] = useState<number | "new" | null>(null);
  const [draftForm, setDraftForm] = useState<DraftForm>(EMPTY_DRAFT);

  const selected = useMemo(
    () => groups.find((g) => g.id === selectedId) || null,
    [groups, selectedId],
  );

  const load = useCallback(
    async (keepSelected?: number | null) => {
      try {
        const data = await client.listCallFollowups();
        setGroups(data.groups || []);
        setPlaceholders(data.placeholders || []);
        if (data.mode) setMode(data.mode);
        setSelectedId((prev) => {
          const want = keepSelected !== undefined ? keepSelected : prev;
          if (want && data.groups.some((g) => g.id === want)) return want;
          return data.groups.length ? data.groups[0].id : null;
        });
      } catch (e) {
        onError(e instanceof Error ? e.message : "Failed to load call follow-ups");
      } finally {
        setLoading(false);
      }
    },
    [onError],
  );

  useEffect(() => {
    void load();
    void client
      .listCatalogues()
      .then((list) => setCatalogues(list))
      .catch(() => setCatalogues([]));
  }, [load]);

  // Sync the group editor when the selection (or its saved data) changes.
  useEffect(() => {
    if (selected) {
      setGroupName(selected.name);
      setGroupDesc(selected.description);
      setGroupEnabled(selected.enabled);
    } else {
      setGroupName("");
      setGroupDesc("");
      setGroupEnabled(true);
    }
    setDraftEditing(null);
  }, [selected?.id, selected?.updated_at]); // eslint-disable-line react-hooks/exhaustive-deps

  function flash(msg: string) {
    setNotice(msg);
    window.setTimeout(() => setNotice(null), 3500);
  }

  async function changeMode(next: CallFollowupMode) {
    const prev = mode;
    setMode(next);
    try {
      await client.setCallFollowupMode(next);
      flash(
        next === "off"
          ? "Off — Sara and Rayan send the old generic follow-up."
          : next === "test_only"
            ? "Test calls only — situations are used for test calls; real calls keep the old follow-up."
            : "All calls — every call now uses these situations.",
      );
    } catch (e) {
      setMode(prev);
      onError(e instanceof Error ? e.message : "Could not change the sending mode");
    }
  }

  async function addGroup() {
    const name = window.prompt("Name of the new situation group:");
    if (!name || !name.trim()) return;
    setBusy(true);
    try {
      const g = await client.createCallFollowupGroup({
        name: name.trim(),
        description: "",
        enabled: true,
      });
      await load(g.id);
      flash("Situation group added — describe when to use it, then add a draft.");
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not add group");
    } finally {
      setBusy(false);
    }
  }

  async function saveGroup() {
    if (!selected) return;
    if (!groupName.trim()) {
      onError("Situation name cannot be empty.");
      return;
    }
    setBusy(true);
    try {
      await client.updateCallFollowupGroup(selected.id, {
        name: groupName.trim(),
        description: groupDesc,
        enabled: groupEnabled,
      });
      await load(selected.id);
      flash("Situation saved.");
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not save group");
    } finally {
      setBusy(false);
    }
  }

  async function removeGroup() {
    if (!selected) return;
    const n = selected.drafts.length;
    if (
      !window.confirm(
        `Delete the situation "${selected.name}"${n ? ` and its ${n} draft${n === 1 ? "" : "s"}` : ""}?`,
      )
    )
      return;
    setBusy(true);
    try {
      await client.deleteCallFollowupGroup(selected.id);
      await load(null);
      flash("Situation deleted.");
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not delete group");
    } finally {
      setBusy(false);
    }
  }

  function startNewDraft() {
    setDraftForm({ ...EMPTY_DRAFT });
    setDraftEditing("new");
  }

  function startEditDraft(d: CallFollowupDraft) {
    setDraftForm(draftToForm(d));
    setDraftEditing(d.id);
  }

  async function saveDraft() {
    if (!selected || draftEditing === null) return;
    if (!draftForm.name.trim()) {
      onError("Draft name cannot be empty.");
      return;
    }
    setBusy(true);
    try {
      const payload = { ...draftForm, name: draftForm.name.trim() };
      if (draftEditing === "new") {
        await client.createCallFollowupDraft(selected.id, payload);
      } else {
        await client.updateCallFollowupDraft(draftEditing, payload);
      }
      setDraftEditing(null);
      await load(selected.id);
      flash("Draft saved.");
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not save draft");
    } finally {
      setBusy(false);
    }
  }

  async function removeDraft(d: CallFollowupDraft) {
    if (!window.confirm(`Delete the draft "${d.name}"?`)) return;
    setBusy(true);
    try {
      await client.deleteCallFollowupDraft(d.id);
      if (draftEditing === d.id) setDraftEditing(null);
      await load(selected?.id ?? null);
      flash("Draft deleted.");
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not delete draft");
    } finally {
      setBusy(false);
    }
  }

  function toggleCatalogue(id: string) {
    setDraftForm((f) => ({
      ...f,
      catalogue_ids: f.catalogue_ids.includes(id)
        ? f.catalogue_ids.filter((x) => x !== id)
        : [...f.catalogue_ids, id],
    }));
  }

  if (loading) {
    return <p className="text-sm text-slate-400">Loading call follow-ups…</p>;
  }

  return (
    <div className="space-y-4">
      {notice && (
        <p className="text-sm text-emerald-300/90 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3">
          {notice}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-800 bg-slate-900/50 px-4 py-3">
        <label className="text-sm font-medium text-slate-300" htmlFor="followup-mode">
          Sara &amp; Rayan send these after a call:
        </label>
        <select
          id="followup-mode"
          className="rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-1.5 text-sm text-slate-100 focus:border-emerald-500/60 focus:outline-none"
          value={mode}
          onChange={(e) => void changeMode(e.target.value as CallFollowupMode)}
        >
          <option value="off">Off (old generic follow-up)</option>
          <option value="test_only">Test calls only</option>
          <option value="all">All calls</option>
        </select>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.4fr)]">
        {/* Situation list */}
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium text-slate-300">Situations</h3>
            <button
              type="button"
              onClick={() => void addGroup()}
              disabled={busy}
              className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-medium disabled:opacity-50"
            >
              + New situation
            </button>
          </div>
          <ul className="max-h-[70vh] overflow-y-auto divide-y divide-slate-800/70">
            {groups.length === 0 && (
              <li className="px-4 py-6 text-sm text-slate-500">No situations yet.</li>
            )}
            {groups.map((g) => (
              <li key={g.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(g.id)}
                  className={`w-full text-left px-4 py-3 transition-colors ${
                    g.id === selectedId ? "bg-emerald-600/15" : "hover:bg-slate-800/40"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-slate-100">{g.name}</span>
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded-full font-mono ${
                        g.drafts.length
                          ? "bg-slate-800 text-slate-300"
                          : "bg-amber-900/40 text-amber-200"
                      }`}
                    >
                      {g.drafts.length} draft{g.drafts.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-slate-500 line-clamp-2">
                    {g.enabled ? "" : "Off · "}
                    {g.description || "No description yet."}
                  </p>
                </button>
              </li>
            ))}
          </ul>
        </div>

        {/* Selected situation */}
        <div className="space-y-4 min-w-0">
          {!selected ? (
            <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-6 text-sm text-slate-500">
              Select a situation, or add a new one.
            </div>
          ) : (
            <>
              <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4 space-y-3">
                <div>
                  <label className={labelCls}>Situation name</label>
                  <input
                    className={inputCls}
                    value={groupName}
                    onChange={(e) => setGroupName(e.target.value)}
                    maxLength={120}
                  />
                </div>
                <div>
                  <label className={labelCls}>When to use this</label>
                  <textarea
                    className={`${inputCls} min-h-[84px]`}
                    value={groupDesc}
                    onChange={(e) => setGroupDesc(e.target.value)}
                    placeholder="Describe the call situation in plain words — the AI reads this to choose the right group."
                  />
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <label className="inline-flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={groupEnabled}
                      onChange={(e) => setGroupEnabled(e.target.checked)}
                    />
                    Enabled
                  </label>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => void removeGroup()}
                      disabled={busy}
                      className="px-3 py-1.5 rounded-lg bg-red-900/40 hover:bg-red-800/50 text-xs font-medium text-red-200 disabled:opacity-50"
                    >
                      Delete situation
                    </button>
                    <button
                      type="button"
                      onClick={() => void saveGroup()}
                      disabled={busy}
                      className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-medium disabled:opacity-50"
                    >
                      Save situation
                    </button>
                  </div>
                </div>
              </div>

              <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-sm font-medium text-slate-300">
                    Email drafts ({selected.drafts.length})
                  </h3>
                  <button
                    type="button"
                    onClick={startNewDraft}
                    disabled={busy}
                    className="px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-xs font-medium disabled:opacity-50"
                  >
                    + Add draft
                  </button>
                </div>

                {selected.drafts.length === 0 && draftEditing !== "new" && (
                  <p className="text-sm text-slate-500">
                    No drafts yet — nothing would be sent for this situation.
                  </p>
                )}

                {selected.drafts.map((d) => (
                  <div
                    key={d.id}
                    className="rounded-lg border border-slate-800 bg-slate-950/40 p-3 space-y-2"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-slate-100">
                          {d.name}
                          {!d.enabled && <span className="ml-2 text-xs text-slate-500">(off)</span>}
                        </p>
                        <p className="text-xs text-slate-400 truncate">
                          {d.subject || "No subject"}
                        </p>
                        <p className="text-[11px] text-slate-500 mt-0.5">
                          Attachment:{" "}
                          {d.attachment_mode === "none"
                            ? "none"
                            : d.attachment_mode === "auto"
                              ? "automatic (by product, full range if unsure)"
                              : `${d.catalogue_ids.length} catalogue${d.catalogue_ids.length === 1 ? "" : "s"}`}
                        </p>
                      </div>
                      <div className="flex gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => startEditDraft(d)}
                          className="px-3 py-1 rounded-md bg-slate-800 hover:bg-slate-700 text-xs"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => void removeDraft(d)}
                          className="px-3 py-1 rounded-md bg-red-900/40 hover:bg-red-800/50 text-xs text-red-200"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                    {draftEditing === d.id && renderDraftForm()}
                  </div>
                ))}

                {draftEditing === "new" && (
                  <div className="rounded-lg border border-sky-700/40 bg-sky-950/20 p-3">
                    <p className="text-xs font-medium text-sky-200 mb-2">New draft</p>
                    {renderDraftForm()}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );

  function renderDraftForm() {
    return (
      <div className="space-y-3 pt-2">
        <div>
          <label className={labelCls}>Draft name</label>
          <input
            className={inputCls}
            value={draftForm.name}
            onChange={(e) => setDraftForm((f) => ({ ...f, name: e.target.value }))}
            maxLength={160}
          />
        </div>
        <div>
          <label className={labelCls}>Email subject</label>
          <input
            className={inputCls}
            value={draftForm.subject}
            onChange={(e) => setDraftForm((f) => ({ ...f, subject: e.target.value }))}
            maxLength={500}
          />
        </div>
        <div>
          <label className={labelCls}>Email body</label>
          <textarea
            className={`${inputCls} min-h-[220px] font-mono text-[13px]`}
            value={draftForm.body}
            onChange={(e) => setDraftForm((f) => ({ ...f, body: e.target.value }))}
          />
          {placeholders.length > 0 && (
            <p className="mt-1 text-[11px] text-slate-500">
              Placeholders:{" "}
              {placeholders.map((p) => (
                <code key={p} className="mr-1 text-slate-400">
                  [{p}]
                </code>
              ))}
            </p>
          )}
        </div>
        <div>
          <label className={labelCls}>WhatsApp text (optional — sent only if WhatsApp is connected)</label>
          <textarea
            className={`${inputCls} min-h-[80px]`}
            value={draftForm.whatsapp_text}
            onChange={(e) => setDraftForm((f) => ({ ...f, whatsapp_text: e.target.value }))}
          />
        </div>
        <div>
          <label className={labelCls}>Attachment</label>
          <select
            className={inputCls}
            value={draftForm.attachment_mode}
            onChange={(e) =>
              setDraftForm((f) => ({
                ...f,
                attachment_mode: e.target.value as DraftForm["attachment_mode"],
              }))
            }
          >
            <option value="none">No attachment</option>
            <option value="auto">Automatic — catalogue for the product discussed (full range if unsure)</option>
            <option value="catalogue">Specific catalogues (choose below)</option>
          </select>
          {draftForm.attachment_mode === "catalogue" && (
            <div className="mt-2 space-y-1 rounded-lg border border-slate-800 p-2">
              {catalogues.length === 0 && (
                <p className="text-xs text-slate-500">No catalogues found.</p>
              )}
              {catalogues.map((c) => (
                <label key={c.id} className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={draftForm.catalogue_ids.includes(c.id)}
                    onChange={() => toggleCatalogue(c.id)}
                  />
                  {c.title}
                </label>
              ))}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="inline-flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={draftForm.enabled}
              onChange={(e) => setDraftForm((f) => ({ ...f, enabled: e.target.checked }))}
            />
            Draft enabled
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setDraftEditing(null)}
              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void saveDraft()}
              disabled={busy}
              className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-medium disabled:opacity-50"
            >
              Save draft
            </button>
          </div>
        </div>
      </div>
    );
  }
}
