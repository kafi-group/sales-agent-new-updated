import { useCallback, useEffect, useState } from "react";
import { client, type DraftInteraction } from "../api/client";

interface UseDraftsOptions {
  page?: number;
  pageSize?: number;
}

export function useDrafts(options: UseDraftsOptions = {}) {
  const page = options.page ?? 1;
  const pageSize = options.pageSize ?? 20;
  const [drafts, setDrafts] = useState<DraftInteraction[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await client.listDrafts({ page, page_size: pageSize });
      setDrafts(result.rows);
      setTotal(result.total);
      setTotalPages(result.total_pages);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load drafts");
    } finally {
      setLoading(false);
    }
  }, [page, pageSize]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { drafts, total, totalPages, page, pageSize, loading, error, refresh };
}
