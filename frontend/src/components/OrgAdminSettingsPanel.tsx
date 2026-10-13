import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  client,
  type OrgAdminAiSalesAgent,
  type OrgAdminMasterList,
  type OrgAdminUserRow,
} from "../api/client";
import { ActionButton } from "./ui/ActionButton";
import { IconList, IconPlus, IconRobot } from "./icons/AppIcons";
import { SearchableSelect, stringOptions } from "./SearchableSelect";
import {
  deleteLocalAgent,
  deleteLocalMasterList,
  loadOrgAdminLocal,
  mergeAgentMasterAccess,
  notifyOrgAdminChanged,
  orgAdminPinValid,
  ORG_ADMIN_PIN,
  saveOrgAdminLocal,
  setLocalAgentAccess,
  setLocalUserAccess,
  upsertLocalAgent,
  upsertLocalMasterList,
  type LocalOrgAdminStore,
} from "../lib/orgAdminLocalStore";

interface OrgAdminSettingsPanelProps {
  onError: (message: string) => void;
}

function fromLocal(store: LocalOrgAdminStore): {
  masterLists: OrgAdminMasterList[];
  userAccess: Record<string, string[]>;
  agentAccess: Record<string, string[]>;
  agents: OrgAdminAiSalesAgent[];
} {
  return {
    masterLists: store.master_lists,
    userAccess: store.user_master_access,
    agentAccess: store.agent_master_access || {},
    agents: store.ai_sales_agents,
  };
}

export function OrgAdminSettingsPanel({ onError }: OrgAdminSettingsPanelProps) {
  const [pin, setPin] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [usingLocal, setUsingLocal] = useState(true);
  const [localStore, setLocalStore] = useState<LocalOrgAdminStore>(() => loadOrgAdminLocal());

  const [masterLists, setMasterLists] = useState<OrgAdminMasterList[]>([]);
  const [users, setUsers] = useState<OrgAdminUserRow[]>([]);
  const [userAccess, setUserAccess] = useState<Record<string, string[]>>({});
  const [agentAccess, setAgentAccess] = useState<Record<string, string[]>>({});
  const [agents, setAgents] = useState<OrgAdminAiSalesAgent[]>([]);

  const [newListLabel, setNewListLabel] = useState("");
  const [editListKey, setEditListKey] = useState<string | null>(null);
  const [editListLabel, setEditListLabel] = useState("");

  const [newAgentName, setNewAgentName] = useState("");
  const [newAgentFocus, setNewAgentFocus] = useState("");
  const [editAgentId, setEditAgentId] = useState<string | null>(null);
  const [editAgentName, setEditAgentName] = useState("");
  const [editAgentFocus, setEditAgentFocus] = useState("");
  const [productFocusOptions, setProductFocusOptions] = useState<string[]>([]);
  const [productFocusLoading, setProductFocusLoading] = useState(false);

  const applyLocal = useCallback((store: LocalOrgAdminStore) => {
    setLocalStore(store);
    const mapped = fromLocal(store);
    setMasterLists(mapped.masterLists);
    setUserAccess(mapped.userAccess);
    setAgentAccess(mapped.agentAccess);
    setAgents(mapped.agents);
    setUsingLocal(true);
  }, []);

  const loadAdmin = useCallback(
    async (accessPin: string) => {
      // Prefer API when live; never block Settings unlock if API is down.
      try {
        // Push any browser-local lists (Meat, Rice, …) up to Railway before reload,
        // so the sidebar Active Master List matches Settings.
        const local = loadOrgAdminLocal();
        try {
          const existing = await client.getOrgAdminMasterListsAdmin(accessPin);
          const apiByKey = new Map(
            (existing.master_lists || []).map((m) => [m.key, m] as const),
          );
          for (const m of local.master_lists || []) {
            const apiRow = apiByKey.get(m.key);
            if (!apiRow) {
              await client.upsertOrgMasterList({
                pin: accessPin,
                key: m.key,
                label: m.label,
                enabled: m.enabled,
              });
            } else if (
              apiRow.label !== m.label ||
              Boolean(apiRow.enabled) !== Boolean(m.enabled)
            ) {
              await client.upsertOrgMasterList({
                pin: accessPin,
                key: m.key,
                label: m.label,
                enabled: m.enabled,
              });
            }
          }
        } catch {
          /* sync best-effort */
        }

        const data = await client.getOrgAdminMasterListsAdmin(accessPin);
        const localStill = loadOrgAdminLocal();
        const apiLists = data.master_lists || [];
        const apiKeys = new Set(apiLists.map((m) => m.key));
        // Never wipe browser-only lists (Rice, Meat, …) if server sync failed mid-502.
        const localOnly = (localStill.master_lists || []).filter((m) => !apiKeys.has(m.key));
        const mergedLists = [...apiLists, ...localOnly].sort(
          (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.label.localeCompare(b.label),
        );
        setMasterLists(mergedLists);
        setUsers(data.users || []);
        setUserAccess(data.user_master_access || {});
        // Empty API `{}` must not wipe Sara/Rayan FMCG ticks saved in the browser.
        const mergedAgentAccess = mergeAgentMasterAccess(
          data.agent_master_access,
          localStill.agent_master_access,
        );
        // Push browser ticks to Railway when server is missing that agent’s lists.
        const apiAccess = data.agent_master_access || {};
        for (const [aid, keys] of Object.entries(mergedAgentAccess)) {
          const serverKeys = apiAccess[aid];
          if (serverKeys == null || (serverKeys.length === 0 && keys.length > 0)) {
            try {
              await client.setOrgAgentMasterAccess(accessPin, aid, keys);
            } catch {
              /* best-effort */
            }
          }
        }
        setAgentAccess(mergedAgentAccess);
        const ag = await client.listOrgAiSalesAgents(false);
        const apiAgents = ag.agents || [];
        const mergedAgents =
          apiAgents.length > 0 ? apiAgents : localStill.ai_sales_agents || [];
        setAgents(mergedAgents);
        setUsingLocal(localOnly.length > 0);
        saveOrgAdminLocal({
          master_lists: mergedLists,
          user_master_access: data.user_master_access || localStill.user_master_access || {},
          agent_master_access: mergedAgentAccess,
          ai_sales_agents: mergedAgents.length ? mergedAgents : localStill.ai_sales_agents,
        });
        return;
      } catch {
        /* fall through to local */
      }
      try {
        const usersRes = await client.listUsers();
        setUsers(
          (usersRes || []).map((u) => ({
            id: u.id,
            username: u.username,
            display_name: u.full_name || u.username,
            role: u.role,
          })),
        );
      } catch {
        setUsers([]);
      }
      applyLocal(loadOrgAdminLocal());
    },
    [applyLocal],
  );

  useEffect(() => {
    if (!unlocked || !pin) return;
    let cancelled = false;
    void loadAdmin(pin).catch((err) => {
      if (!cancelled) onError(err instanceof Error ? err.message : "Failed to load org admin");
    });
    return () => {
      cancelled = true;
    };
  }, [unlocked, pin, loadAdmin, onError]);

  useEffect(() => {
    if (!unlocked) return;
    let cancelled = false;
    setProductFocusLoading(true);
    void client
      .getLeadTableColumnValues("product", {})
      .then((res) => {
        if (cancelled) return;
        const values = (res.unique_values || [])
          .map((row) => String(row.value || "").trim())
          .filter(Boolean);
        setProductFocusOptions(values);
      })
      .catch(() => {
        if (!cancelled) setProductFocusOptions([]);
      })
      .finally(() => {
        if (!cancelled) setProductFocusLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [unlocked]);

  const productFocusSelectOptions = useMemo(() => {
    const base = stringOptions(productFocusOptions);
    // Keep any custom/saved focus that isn't in the current Product column yet.
    const extras = [newAgentFocus, editAgentFocus, ...agents.map((a) => a.product_focus || "")]
      .flatMap((raw) => raw.split(",").map((s) => s.trim()).filter(Boolean))
      .filter((v) => !productFocusOptions.some((p) => p.toLowerCase() === v.toLowerCase()));
    const seen = new Set(base.map((o) => o.value.toLowerCase()));
    for (const v of extras) {
      const key = v.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      base.push({ value: v, label: v });
    }
    return base;
  }, [productFocusOptions, newAgentFocus, editAgentFocus, agents]);

  async function handleUnlock(e: FormEvent) {
    e.preventDefault();
    setPinError(null);
    setUnlocking(true);
    try {
      const code = pin.trim();
      if (!orgAdminPinValid(code)) {
        setPinError(`Invalid access code. Please use access code: ${ORG_ADMIN_PIN}`);
        setUnlocked(false);
        return;
      }
      // Unlock locally first so Settings always works without Railway.
      setUnlocked(true);
      await loadAdmin(code);
    } catch (err) {
      setPinError(err instanceof Error ? err.message : "Invalid access code");
      setUnlocked(false);
    } finally {
      setUnlocking(false);
    }
  }

  async function saveMasterList(opts: {
    key?: string | null;
    label: string;
    enabled?: boolean;
  }) {
    if (!pin) return;
    setBusy(true);
    try {
      if (!usingLocal) {
        try {
          await client.upsertOrgMasterList({
            pin,
            key: opts.key ?? null,
            label: opts.label,
            enabled: opts.enabled ?? true,
          });
          await loadAdmin(pin);
          notifyOrgAdminChanged();
          setNewListLabel("");
          setEditListKey(null);
          setEditListLabel("");
          return;
        } catch {
          /* fall back to local */
        }
      }
      const next = upsertLocalMasterList(localStore, opts);
      applyLocal(next);
      setNewListLabel("");
      setEditListKey(null);
      setEditListLabel("");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not save master list");
    } finally {
      setBusy(false);
    }
  }

  async function removeMasterList(key: string) {
    if (!pin) return;
    if (!window.confirm(`Remove master list “${key}”? Built-in lists cannot be deleted.`)) return;
    setBusy(true);
    try {
      if (!usingLocal) {
        try {
          await client.deleteOrgMasterList(pin, key);
          await loadAdmin(pin);
          return;
        } catch {
          /* local */
        }
      }
      applyLocal(deleteLocalMasterList(localStore, key));
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not delete master list");
    } finally {
      setBusy(false);
    }
  }

  async function toggleListEnabled(row: OrgAdminMasterList) {
    await saveMasterList({ key: row.key, label: row.label, enabled: !row.enabled });
  }

  async function toggleUserAccess(userId: number, listKey: string, checked: boolean) {
    if (!pin) return;
    const uid = String(userId);
    const current =
      userAccess[uid] ?? masterLists.filter((m) => m.enabled).map((m) => m.key);
    const nextKeys = checked
      ? Array.from(new Set([...current, listKey]))
      : current.filter((k) => k !== listKey);
    setBusy(true);
    try {
      if (!usingLocal) {
        try {
          await client.setOrgUserMasterAccess(pin, userId, nextKeys);
          setUserAccess((prev) => ({ ...prev, [uid]: nextKeys }));
          return;
        } catch {
          /* local */
        }
      }
      applyLocal(setLocalUserAccess(localStore, userId, nextKeys));
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not update user access");
    } finally {
      setBusy(false);
    }
  }

  async function toggleAgentAccess(agentId: string, listKey: string, checked: boolean) {
    if (!pin) return;
    const aid = String(agentId);
    // Unset = all enabled lists (same default as people). First edit materializes the list.
    const current =
      agentAccess[aid] ?? masterLists.filter((m) => m.enabled).map((m) => m.key);
    const nextKeys = checked
      ? Array.from(new Set([...current, listKey]))
      : current.filter((k) => k !== listKey);
    setBusy(true);
    try {
      if (!usingLocal) {
        try {
          await client.setOrgAgentMasterAccess(pin, aid, nextKeys);
          setAgentAccess((prev) => ({ ...prev, [aid]: nextKeys }));
          const mirrored = setLocalAgentAccess(loadOrgAdminLocal(), aid, nextKeys);
          setLocalStore(mirrored);
          return;
        } catch {
          /* local */
        }
      }
      applyLocal(setLocalAgentAccess(localStore, aid, nextKeys));
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not update agent access");
    } finally {
      setBusy(false);
    }
  }

  async function saveAgent(opts: {
    id?: string | null;
    name: string;
    active?: boolean;
    product_focus?: string;
  }) {
    if (!pin) return;
    setBusy(true);
    try {
      if (!usingLocal) {
        try {
          await client.upsertOrgAiSalesAgent({
            pin,
            id: opts.id ?? null,
            name: opts.name,
            active: opts.active ?? true,
            product_focus: opts.product_focus ?? "",
          });
          await loadAdmin(pin);
          setNewAgentName("");
          setNewAgentFocus("");
          setEditAgentId(null);
          setEditAgentName("");
          setEditAgentFocus("");
          return;
        } catch {
          /* local */
        }
      }
      applyLocal(upsertLocalAgent(localStore, opts));
      setNewAgentName("");
      setNewAgentFocus("");
      setEditAgentId(null);
      setEditAgentName("");
      setEditAgentFocus("");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not save AI Sales Agent");
    } finally {
      setBusy(false);
    }
  }

  async function removeAgent(id: string) {
    if (!pin) return;
    if (!window.confirm("Remove this AI Sales Agent? Sara and Rayan cannot be deleted.")) return;
    setBusy(true);
    try {
      if (!usingLocal) {
        try {
          await client.deleteOrgAiSalesAgent(pin, id);
          await loadAdmin(pin);
          return;
        } catch {
          /* local */
        }
      }
      applyLocal(deleteLocalAgent(localStore, id));
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not remove agent");
    } finally {
      setBusy(false);
    }
  }

  if (!unlocked) {
    return (
      <section className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-5 space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-emerald-200">
            Active Master Lists &amp; AI Sales Agents
          </h3>
          <p className="mt-1 text-xs text-slate-400 leading-relaxed">
            Add or edit sidebar master lists, choose which users can open each list, and manage AI
            Sales Agents (Sara, Rayan, and product specialists). Unlock with access code {ORG_ADMIN_PIN}.
          </p>
        </div>
        <form onSubmit={(e) => void handleUnlock(e)} className="flex flex-wrap items-end gap-2">
          <div className="min-w-[12rem] flex-1">
            <label className="block text-xs font-medium text-slate-300 mb-1.5">Access code</label>
            <input
              type="password"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              placeholder="Enter code…"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 font-mono tracking-widest focus:border-emerald-500 focus:outline-none"
            />
          </div>
          <ActionButton type="submit" icon={IconList} disabled={unlocking || !pin.trim()}>
            {unlocking ? "Unlocking…" : "Unlock"}
          </ActionButton>
        </form>
        {pinError && (
          <p className="text-xs text-red-400 bg-red-950/40 border border-red-900/60 rounded-md px-3 py-1.5">
            {pinError}
          </p>
        )}
      </section>
    );
  }

  const enabledKeys = masterLists.filter((m) => m.enabled).map((m) => m.key);

  return (
    <section className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-5 space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-emerald-200">
            Active Master Lists &amp; AI Sales Agents
          </h3>
          <p className="mt-1 text-xs text-slate-400">
            Unlocked for this session.
            {usingLocal
              ? " Saved in this browser (API sync unavailable)."
              : " Synced with server."}{" "}
            Queues, WhatsApp, email, and Twilio are untouched.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setUnlocked(false);
            setPin("");
          }}
          className="text-xs text-slate-400 hover:text-slate-200"
        >
          Lock
        </button>
      </div>

      <div className="space-y-3">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          Active Master List
        </h4>
        <p className="text-xs text-slate-500">
          Lists must be saved on the server to appear in Incognito or on other PCs. Unlock Settings
          (PIN) while online to sync this browser&apos;s lists up — they now persist on Railway disk
          across redeploys.
        </p>
        {usingLocal ? (
          <p className="text-xs text-amber-300/90 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5">
            Showing browser-local lists (not fully on the server yet). Unlock again or click Add list
            while the API is up so Incognito / other machines see Meat, Seeds, Salt, Rice, etc.
          </p>
        ) : null}
        <ul className="space-y-2">
          {masterLists.map((row) => (
            <li
              key={row.key}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2"
            >
              {editListKey === row.key ? (
                <>
                  <input
                    value={editListLabel}
                    onChange={(e) => setEditListLabel(e.target.value)}
                    className="flex-1 min-w-[8rem] rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-100"
                  />
                  <button
                    type="button"
                    disabled={busy || !editListLabel.trim()}
                    onClick={() =>
                      void saveMasterList({
                        key: row.key,
                        label: editListLabel.trim(),
                        enabled: row.enabled,
                      })
                    }
                    className="text-xs text-emerald-300 hover:text-emerald-200"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditListKey(null)}
                    className="text-xs text-slate-500"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <span className="flex-1 min-w-[8rem] text-sm text-slate-100">{row.label}</span>
                  <span className="text-[10px] font-mono text-slate-500">{row.key}</span>
                  <label className="flex items-center gap-1.5 text-xs text-slate-400">
                    <input
                      type="checkbox"
                      checked={row.enabled}
                      disabled={busy}
                      onChange={() => void toggleListEnabled(row)}
                    />
                    Enabled
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      setEditListKey(row.key);
                      setEditListLabel(row.label);
                    }}
                    className="text-xs text-sky-300 hover:text-sky-200"
                  >
                    Edit
                  </button>
                  {!["fmcg", "minerals_ores", "other_items"].includes(row.key) && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void removeMasterList(row.key)}
                      className="text-xs text-red-400 hover:text-red-300"
                    >
                      Remove
                    </button>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (busy || !newListLabel.trim()) return;
            void saveMasterList({ label: newListLabel.trim(), enabled: true });
          }}
        >
          <input
            value={newListLabel}
            onChange={(e) => setNewListLabel(e.target.value)}
            placeholder="New list label (e.g. Rice Master)"
            className="flex-1 min-w-[12rem] rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100"
          />
          <ActionButton
            type="submit"
            icon={IconPlus}
            disabled={busy || !newListLabel.trim()}
          >
            Add list
          </ActionButton>
        </form>
        <p className="text-[11px] text-slate-500">
          Press Enter or click Add list. Changes sync to the sidebar automatically; unlock Settings
          while the API is up so lists stay on the server for everyone.
        </p>
      </div>

      <div className="space-y-3">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          Access to master lists
        </h4>
        <p className="text-xs text-slate-500">
          Tick which people and AI Sales Agents may use each master list. Agents default to{" "}
          <strong>all</strong> lists until you change them — untick a list (e.g. Rice) to hide
          Sara/Rayan there. Admins always see every enabled list in the sidebar.
        </p>
        <div className="overflow-x-auto rounded-lg border border-slate-800">
          <table className="min-w-full text-xs">
            <thead className="bg-slate-950/80 text-slate-400">
              <tr>
                <th className="text-left px-3 py-2 font-medium">Person / AI Agent</th>
                {masterLists.map((m) => (
                  <th key={m.key} className="text-left px-2 py-2 font-medium whitespace-nowrap">
                    {m.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const uid = String(u.id);
                const assigned = userAccess[uid];
                const effective = assigned ?? enabledKeys;
                const isAdminUser = u.role === "admin";
                return (
                  <tr key={`user-${u.id}`} className="border-t border-slate-800/80">
                    <td className="px-3 py-2 text-slate-200">
                      {u.display_name || u.username}
                      {isAdminUser ? (
                        <span className="ml-1 text-[10px] text-slate-500">(admin)</span>
                      ) : (
                        <span className="ml-1 text-[10px] text-slate-500">(user)</span>
                      )}
                    </td>
                    {masterLists.map((m) => (
                      <td key={m.key} className="px-2 py-2">
                        <input
                          type="checkbox"
                          disabled={busy || isAdminUser || !m.enabled}
                          checked={isAdminUser || effective.includes(m.key)}
                          onChange={(e) =>
                            void toggleUserAccess(u.id, m.key, e.target.checked)
                          }
                        />
                      </td>
                    ))}
                  </tr>
                );
              })}
              {agents.map((ag) => {
                const assigned = agentAccess[ag.id];
                const effective = assigned ?? enabledKeys;
                return (
                  <tr
                    key={`agent-${ag.id}`}
                    className={`border-t border-slate-800/80 ${ag.active ? "" : "opacity-50"}`}
                  >
                    <td className="px-3 py-2 text-slate-200">
                      {ag.name}
                      <span className="ml-1 text-[10px] text-emerald-400/90">(AI Sales Agent)</span>
                      {!ag.active && (
                        <span className="ml-1 text-[10px] text-slate-500">inactive</span>
                      )}
                    </td>
                    {masterLists.map((m) => (
                      <td key={m.key} className="px-2 py-2">
                        <input
                          type="checkbox"
                          disabled={busy || !m.enabled || !ag.active}
                          checked={effective.includes(m.key)}
                          onChange={(e) =>
                            void toggleAgentAccess(ag.id, m.key, e.target.checked)
                          }
                        />
                      </td>
                    ))}
                  </tr>
                );
              })}
              {users.length === 0 && agents.length === 0 ? (
                <tr>
                  <td
                    colSpan={Math.max(1, masterLists.length + 1)}
                    className="px-3 py-3 text-amber-200/80"
                  >
                    No users or AI agents loaded yet — add an AI Sales Agent below, then assign lists
                    here.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      <div className="space-y-3">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          AI Sales Agents
        </h4>
        <p className="text-xs text-slate-500">
          Registry of all agents (active / inactive). Assign which master lists each agent may use
          in Access to master lists above — the AI Sales Agent page only shows agents ticked for the
          Active Master List (e.g. Rice agents when Rice is selected).
        </p>
        <ul className="space-y-2">
          {agents.map((ag) => (
            <li
              key={ag.id}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2"
            >
              {editAgentId === ag.id ? (
                <>
                  <input
                    value={editAgentName}
                    onChange={(e) => setEditAgentName(e.target.value)}
                    className="min-w-[8rem] flex-1 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs"
                    placeholder="Name"
                  />
                  <div className="min-w-[12rem] flex-[1.2]">
                    <SearchableSelect
                      value={editAgentFocus}
                      onChange={setEditAgentFocus}
                      options={productFocusSelectOptions}
                      allowEmpty
                      emptyLabel="No product focus"
                      placeholder={
                        productFocusLoading ? "Loading products…" : "Search Product…"
                      }
                      disabled={busy || productFocusLoading}
                      multiSelect
                    />
                  </div>
                  <button
                    type="button"
                    disabled={busy || !editAgentName.trim()}
                    onClick={() =>
                      void saveAgent({
                        id: ag.id,
                        name: editAgentName.trim(),
                        active: ag.active,
                        product_focus: editAgentFocus.trim(),
                      })
                    }
                    className="text-xs text-emerald-300"
                  >
                    Save
                  </button>
                  <button type="button" onClick={() => setEditAgentId(null)} className="text-xs text-slate-500">
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <span className="text-sm text-slate-100 font-medium">{ag.name}</span>
                  <span className="text-[10px] font-mono text-slate-500">{ag.id}</span>
                  {ag.product_focus ? (
                    <span className="text-xs text-amber-200/80">Focus: {ag.product_focus}</span>
                  ) : null}
                  <label className="flex items-center gap-1.5 text-xs text-slate-400 ml-auto">
                    <input
                      type="checkbox"
                      checked={ag.active}
                      disabled={busy}
                      onChange={() =>
                        void saveAgent({
                          id: ag.id,
                          name: ag.name,
                          active: !ag.active,
                          product_focus: ag.product_focus,
                        })
                      }
                    />
                    Active
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      setEditAgentId(ag.id);
                      setEditAgentName(ag.name);
                      setEditAgentFocus(ag.product_focus || "");
                    }}
                    className="text-xs text-sky-300"
                  >
                    Edit
                  </button>
                  {!ag.protected && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void removeAgent(ag.id)}
                      className="text-xs text-red-400"
                    >
                      Remove
                    </button>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2 items-end">
          <input
            value={newAgentName}
            onChange={(e) => setNewAgentName(e.target.value)}
            placeholder="Agent name (e.g. Mitch)"
            className="min-w-[10rem] flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs"
          />
          <div className="min-w-[14rem] flex-[1.4]">
            <SearchableSelect
              value={newAgentFocus}
              onChange={setNewAgentFocus}
              options={productFocusSelectOptions}
              allowEmpty
              emptyLabel="No product focus"
              placeholder={productFocusLoading ? "Loading products…" : "Search Product…"}
              disabled={busy || productFocusLoading}
              multiSelect
            />
          </div>
          <ActionButton
            type="button"
            icon={IconRobot}
            disabled={busy || !newAgentName.trim()}
            onClick={() =>
              void saveAgent({
                name: newAgentName.trim(),
                product_focus: newAgentFocus.trim(),
                active: true,
              })
            }
          >
            Add agent
          </ActionButton>
        </div>
      </div>
    </section>
  );
}
