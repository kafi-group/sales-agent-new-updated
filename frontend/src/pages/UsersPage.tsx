import { useCallback, useEffect, useState, type FormEvent } from "react";
import { client, type AppUser } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { ColumnVisibilityMenu } from "../components/ColumnVisibilityMenu";
import {
  useColumnVisibility,
  type ColumnDef,
} from "../hooks/useColumnVisibility";

interface UsersPageProps {
  onError: (message: string) => void;
  onUsersChanged?: () => void;
}

const USERS_COLUMNS: ColumnDef[] = [
  { id: "username", label: "Username", locked: true },
  { id: "name", label: "Name" },
  { id: "mailbox", label: "Mailbox" },
  { id: "switch", label: "Switch", locked: true },
  { id: "role", label: "Role" },
  { id: "status", label: "Status" },
  { id: "actions", label: "Actions", locked: true },
];

export function UsersPage({ onError, onUsersChanged }: UsersPageProps) {
  const {
    user: authUser,
    switchToUser,
    switchBackToAdmin,
    impersonating,
    impersonatorLabel,
  } = useAuth();
  const columnsUi = useColumnVisibility("users", USERS_COLUMNS, authUser?.id);
  const [users, setUsers] = useState<AppUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [username, setUsername] = useState("");
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [mailboxEmail, setMailboxEmail] = useState("");
  const [mailboxPassword, setMailboxPassword] = useState("");
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editUsername, setEditUsername] = useState("");
  const [editFullName, setEditFullName] = useState("");
  const [editPassword, setEditPassword] = useState("");
  const [editMailboxEmail, setEditMailboxEmail] = useState("");
  const [editMailboxPassword, setEditMailboxPassword] = useState("");
  const [editActive, setEditActive] = useState(true);
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [switchingId, setSwitchingId] = useState<number | null>(null);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await client.listUsers();
      setUsers(rows);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to load users");
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setCreating(true);
    try {
      await client.createUser({
        username: username.trim(),
        full_name: fullName.trim(),
        password,
        ...(mailboxEmail.trim()
          ? {
              mailbox_email: mailboxEmail.trim(),
              mailbox_password: mailboxPassword || undefined,
              mailbox_display_name: fullName.trim(),
            }
          : {}),
      });
      setUsername("");
      setFullName("");
      setPassword("");
      setMailboxEmail("");
      setMailboxPassword("");
      await loadUsers();
      onUsersChanged?.();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to create user");
    } finally {
      setCreating(false);
    }
  }

  function startEdit(user: AppUser) {
    setEditingId(user.id);
    setEditUsername(user.username);
    setEditFullName(user.full_name);
    setEditPassword("");
    setEditMailboxEmail(user.mailbox_email || "");
    setEditMailboxPassword("");
    setEditActive(user.is_active);
    setEditError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditPassword("");
    setEditMailboxPassword("");
    setEditError(null);
  }

  async function handleSaveEdit(e: FormEvent) {
    e.preventDefault();
    if (editingId == null) return;
    setEditError(null);
    setSavingEdit(true);
    try {
      const payload: {
        username: string;
        full_name: string;
        password?: string;
        is_active: boolean;
        mailbox_email?: string | null;
        mailbox_password?: string;
        mailbox_display_name?: string | null;
      } = {
        username: editUsername.trim(),
        full_name: editFullName.trim(),
        is_active: editActive,
        mailbox_email: editMailboxEmail.trim() || null,
        mailbox_display_name: editFullName.trim(),
      };
      if (editPassword.trim()) {
        payload.password = editPassword;
      }
      if (editMailboxPassword.trim()) {
        payload.mailbox_password = editMailboxPassword;
      }
      await client.updateUser(editingId, payload);
      cancelEdit();
      await loadUsers();
      onUsersChanged?.();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Failed to update user");
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleDirectSwitch(targetUser: AppUser) {
    setSwitchingId(targetUser.id);
    try {
      await switchToUser(targetUser.id);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not switch user");
      setSwitchingId(null);
    }
  }

  async function handleDelete(user: AppUser) {
    const confirmed = window.confirm(
      `Delete user “${user.username}”? This cannot be undone.`,
    );
    if (!confirmed) return;
    setDeletingId(user.id);
    try {
      await client.deleteUser(user.id);
      if (editingId === user.id) cancelEdit();
      await loadUsers();
      onUsersChanged?.();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to delete user");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="space-y-8 w-full min-w-0">
      {impersonating && impersonatorLabel && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 flex flex-wrap items-center justify-between gap-3 text-amber-100">
          <div>
            <p className="text-sm font-medium">Currently viewing dashboard as {authUser?.full_name || authUser?.username}</p>
            <p className="text-xs text-amber-300/80 mt-0.5">Admin session saved ({impersonatorLabel})</p>
          </div>
          <button
            type="button"
            onClick={() => void switchBackToAdmin()}
            className="rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-medium text-xs px-3 py-2 transition"
          >
            Return to Admin ({impersonatorLabel})
          </button>
        </div>
      )}

      <div>
        <h2 className="text-xl font-semibold tracking-tight text-slate-100">Users</h2>
        <p className="mt-1 text-sm text-slate-400">
          Create, edit, or delete sales users. Assign each person their own @kafi-group.com
          mailbox so Inbox / Sent / outbound mail are private to them.
        </p>
      </div>

      <form
        onSubmit={handleCreate}
        className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 space-y-4 w-full"
      >
        <h3 className="text-sm font-medium text-slate-200">Create user</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block sm:col-span-1">
            <span className="text-xs text-slate-400">Username</span>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-emerald-500"
            />
          </label>
          <label className="block sm:col-span-1">
            <span className="text-xs text-slate-400">Full name</span>
            <input
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              required
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-emerald-500"
            />
          </label>
          <label className="block sm:col-span-2">
            <span className="text-xs text-slate-400">Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={4}
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-emerald-500"
            />
          </label>
          <label className="block sm:col-span-1">
            <span className="text-xs text-slate-400">Company mailbox</span>
            <input
              type="email"
              value={mailboxEmail}
              onChange={(e) => setMailboxEmail(e.target.value)}
              placeholder="name@kafi-group.com"
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-emerald-500"
            />
          </label>
          <label className="block sm:col-span-1">
            <span className="text-xs text-slate-400">Mailbox password</span>
            <input
              type="password"
              value={mailboxPassword}
              onChange={(e) => setMailboxPassword(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-emerald-500"
            />
          </label>
        </div>
        {formError && (
          <p className="text-sm text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
            {formError}
          </p>
        )}
        <button
          type="submit"
          disabled={creating}
          className="rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 px-3 py-2 text-sm font-medium"
        >
          {creating ? "Creating…" : "Create user"}
        </button>
      </form>

      <div className="rounded-xl border border-slate-800 overflow-x-auto">
        <div className="flex items-center justify-end gap-2 px-3 py-2 border-b border-slate-800/80 bg-slate-950/60">
          <ColumnVisibilityMenu
            columns={columnsUi.columns}
            isVisible={columnsUi.isVisible}
            toggle={columnsUi.toggle}
            showAll={columnsUi.showAll}
            resetDefaults={columnsUi.resetDefaults}
            hiddenCount={columnsUi.hiddenCount}
          />
        </div>
        {columnsUi.css ? <style>{columnsUi.css}</style> : null}
        <table className="w-full text-sm">
          <thead className="bg-slate-900/80 text-slate-400 text-left">
            <tr>
              <th data-col="username" className="px-4 py-3 font-medium">Username</th>
              <th data-col="name" className="px-4 py-3 font-medium">Name</th>
              <th data-col="mailbox" className="px-4 py-3 font-medium">Mailbox</th>
              <th data-col="switch" className="px-4 py-3 font-medium">Switch</th>
              <th data-col="role" className="px-4 py-3 font-medium">Role</th>
              <th data-col="status" className="px-4 py-3 font-medium">Status</th>
              <th data-col="actions" className="px-4 py-3 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-slate-500">
                  Loading…
                </td>
              </tr>
            ) : users.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-slate-500">
                  No users yet.
                </td>
              </tr>
            ) : (
              users.map((user) => (
                <tr key={user.id} className="border-t border-slate-800 align-top">
                  {editingId === user.id ? (
                    <td colSpan={7} className="px-4 py-4">
                      <form onSubmit={handleSaveEdit} className="space-y-3 w-full">
                        <div className="grid gap-3 sm:grid-cols-2">
                          <label className="block">
                            <span className="text-xs text-slate-400">Username</span>
                            <input
                              value={editUsername}
                              onChange={(e) => setEditUsername(e.target.value)}
                              required
                              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-emerald-500"
                            />
                          </label>
                          <label className="block">
                            <span className="text-xs text-slate-400">Full name</span>
                            <input
                              value={editFullName}
                              onChange={(e) => setEditFullName(e.target.value)}
                              required
                              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-emerald-500"
                            />
                          </label>
                          <label className="block sm:col-span-2">
                            <span className="text-xs text-slate-400">
                              New login password <span className="text-slate-500">(optional)</span>
                            </span>
                            <input
                              type="password"
                              value={editPassword}
                              onChange={(e) => setEditPassword(e.target.value)}
                              minLength={4}
                              placeholder="Leave blank to keep current password"
                              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-emerald-500"
                            />
                          </label>
                          <label className="block">
                            <span className="text-xs text-slate-400">Company mailbox</span>
                            <input
                              type="email"
                              value={editMailboxEmail}
                              onChange={(e) => setEditMailboxEmail(e.target.value)}
                              placeholder="name@kafi-group.com"
                              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-emerald-500"
                            />
                          </label>
                          <label className="block">
                            <span className="text-xs text-slate-400">
                              Mailbox password <span className="text-slate-500">(optional)</span>
                            </span>
                            <input
                              type="password"
                              value={editMailboxPassword}
                              onChange={(e) => setEditMailboxPassword(e.target.value)}
                              placeholder="Leave blank to keep current"
                              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-emerald-500"
                            />
                          </label>
                          {user.role !== "admin" && (
                            <label className="flex items-center gap-2 sm:col-span-2 text-sm text-slate-300">
                              <input
                                type="checkbox"
                                checked={editActive}
                                onChange={(e) => setEditActive(e.target.checked)}
                                className="rounded border-slate-600"
                              />
                              Active
                            </label>
                          )}
                        </div>
                        {editError && (
                          <p className="text-sm text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
                            {editError}
                          </p>
                        )}
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="submit"
                            disabled={savingEdit}
                            className="rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 px-3 py-1.5 text-xs font-medium"
                          >
                            {savingEdit ? "Saving…" : "Save"}
                          </button>
                          <button
                            type="button"
                            onClick={cancelEdit}
                            disabled={savingEdit}
                            className="rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 px-3 py-1.5 text-xs text-slate-300"
                          >
                            Cancel
                          </button>
                        </div>
                      </form>
                    </td>
                  ) : (
                    <>
                      <td data-col="username" className="px-4 py-3 text-slate-100">{user.username}</td>
                      <td data-col="name" className="px-4 py-3 text-slate-300">{user.full_name}</td>
                      <td data-col="mailbox" className="px-4 py-3 text-slate-300">
                        {user.mailbox_configured ? (
                          <span className="text-emerald-300">{user.mailbox_email}</span>
                        ) : user.mailbox_email ? (
                          <span className="text-amber-300">{user.mailbox_email} (needs password)</span>
                        ) : (
                          <span className="text-slate-500">Not set</span>
                        )}
                      </td>
                      <td data-col="switch" className="px-4 py-3">
                        {user.id === authUser?.id && !impersonating ? (
                          <span className="text-xs text-slate-500">You</span>
                        ) : !user.is_active ? (
                          <span className="text-xs text-slate-500">Inactive</span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => void handleDirectSwitch(user)}
                            disabled={switchingId === user.id}
                            className="text-xs px-2.5 py-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-200 disabled:opacity-50 transition"
                            title={`Switch directly to ${user.full_name || user.username}`}
                          >
                            {switchingId === user.id ? "Switching…" : "Switch"}
                          </button>
                        )}
                      </td>
                      <td data-col="role" className="px-4 py-3">
                        <span
                          className={`px-2 py-0.5 rounded text-xs font-medium border ${
                            user.role === "admin"
                              ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                              : "bg-slate-800 text-slate-300 border-slate-700"
                          }`}
                        >
                          {user.role}
                        </span>
                      </td>
                      <td data-col="status" className="px-4 py-3 text-slate-400">
                        {user.is_active ? "Active" : "Inactive"}
                      </td>
                      <td data-col="actions" className="px-4 py-3 text-right">
                        <div className="inline-flex flex-wrap justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => startEdit(user)}
                            className="text-xs px-2.5 py-1.5 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-300"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDelete(user)}
                            disabled={deletingId === user.id}
                            className="text-xs px-2.5 py-1.5 rounded-lg border border-red-500/40 bg-red-500/10 hover:bg-red-500/20 text-red-200 disabled:opacity-50"
                          >
                            {deletingId === user.id ? "Deleting…" : "Delete"}
                          </button>
                        </div>
                      </td>
                    </>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
