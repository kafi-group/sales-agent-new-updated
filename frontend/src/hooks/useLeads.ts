import { useCallback, useEffect, useState } from "react";
import { client, type Lead } from "../api/client";

const DEFAULT_PAGE_SIZE = 20;

export function useLeads(pageSize = DEFAULT_PAGE_SIZE) {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadPage = useCallback(
    async (nextPage: number) => {
      setLoading(true);
      setError(null);
      try {
        const result = await client.listLeads({ page: nextPage, page_size: pageSize });
        setLeads(result.rows);
        setTotal(result.total);
        setTotalPages(result.total_pages);
        setPage(result.page);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load leads");
      } finally {
        setLoading(false);
      }
    },
    [pageSize],
  );

  useEffect(() => {
    void loadPage(page);
  }, [loadPage, page]);

  const refresh = useCallback(() => loadPage(page), [loadPage, page]);

  const goToPage = useCallback((nextPage: number) => {
    setPage(nextPage);
  }, []);

  return {
    leads,
    loading,
    error,
    refresh,
    page,
    pageSize,
    total,
    totalPages,
    goToPage,
  };
}
