import { useCallback, useEffect, useMemo, useState } from "react";

export type ColumnDef = {
  id: string;
  label: string;
  /** Always shown; cannot be toggled off. */
  locked?: boolean;
  defaultHidden?: boolean;
};

function storageKey(userId: number | string | null | undefined, tableId: string): string {
  return `kafi.tableColumns:${userId ?? "anon"}:${tableId}`;
}

function defaultHiddenSet(columns: ColumnDef[]): Set<string> {
  return new Set(columns.filter((c) => c.defaultHidden && !c.locked).map((c) => c.id));
}

function loadHidden(
  userId: number | string | null | undefined,
  tableId: string,
  columns: ColumnDef[],
): Set<string> {
  const defaults = defaultHiddenSet(columns);
  try {
    const raw = localStorage.getItem(storageKey(userId, tableId));
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as { hidden?: string[] };
    if (!Array.isArray(parsed.hidden)) return defaults;
    const valid = new Set(columns.map((c) => c.id));
    const locked = new Set(columns.filter((c) => c.locked).map((c) => c.id));
    return new Set(
      parsed.hidden.filter((id) => typeof id === "string" && valid.has(id) && !locked.has(id)),
    );
  } catch {
    return defaults;
  }
}

function persistHidden(
  userId: number | string | null | undefined,
  tableId: string,
  hidden: Set<string>,
) {
  try {
    localStorage.setItem(
      storageKey(userId, tableId),
      JSON.stringify({ hidden: Array.from(hidden) }),
    );
  } catch {
    /* ignore quota / private mode */
  }
}

/** Build a `<style>` body that hides `[data-col="…"]` cells for hidden columns. */
export function columnVisibilityCss(hiddenIds: Iterable<string>): string {
  return Array.from(hiddenIds)
    .map((id) => {
      const safe = id.replace(/[^a-zA-Z0-9_-]/g, "");
      if (!safe) return "";
      return `[data-col="${safe}"]{display:none!important}`;
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Per-user column hide/show preferences (localStorage).
 * Pair with `data-col="{id}"` on `<th>` / `<td>` and inject `columnVisibilityCss`.
 */
export function useColumnVisibility(
  tableId: string,
  columns: ColumnDef[],
  userId: number | string | null | undefined,
) {
  const columnsKey = columns
    .map((c) => `${c.id}:${c.locked ? 1 : 0}:${c.defaultHidden ? 1 : 0}`)
    .join("|");
  const [hidden, setHidden] = useState<Set<string>>(() =>
    loadHidden(userId, tableId, columns),
  );

  useEffect(() => {
    setHidden(loadHidden(userId, tableId, columns));
    // columns identity changes often; columnsKey captures catalog changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, tableId, columnsKey]);

  const isVisible = useCallback((id: string) => !hidden.has(id), [hidden]);

  const toggle = useCallback(
    (id: string) => {
      const col = columns.find((c) => c.id === id);
      if (!col || col.locked) return;
      setHidden((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        persistHidden(userId, tableId, next);
        return next;
      });
    },
    [columns, tableId, userId],
  );

  const showAll = useCallback(() => {
    const next = new Set<string>();
    setHidden(next);
    persistHidden(userId, tableId, next);
  }, [tableId, userId]);

  const hideOptional = useCallback(() => {
    const next = new Set(columns.filter((c) => !c.locked).map((c) => c.id));
    setHidden(next);
    persistHidden(userId, tableId, next);
  }, [columns, tableId, userId]);

  const resetDefaults = useCallback(() => {
    const defaults = defaultHiddenSet(columns);
    setHidden(defaults);
    persistHidden(userId, tableId, defaults);
  }, [columns, tableId, userId]);

  const css = useMemo(() => columnVisibilityCss(hidden), [hidden]);

  return {
    columns,
    hidden,
    hiddenCount: hidden.size,
    isVisible,
    toggle,
    showAll,
    hideOptional,
    resetDefaults,
    css,
  };
}
