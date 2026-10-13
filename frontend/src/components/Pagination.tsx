interface PaginationProps {
  page: number;
  totalPages: number;
  totalItems: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  disabled?: boolean;
}

function pageNumbers(current: number, total: number): number[] {
  if (total <= 1) return total === 1 ? [1] : [];

  const windowSize = 5;
  let start = Math.max(1, current - Math.floor(windowSize / 2));
  let end = start + windowSize - 1;

  if (end > total) {
    end = total;
    start = Math.max(1, end - windowSize + 1);
  }

  const pages: number[] = [];
  for (let i = start; i <= end; i += 1) {
    pages.push(i);
  }
  return pages;
}

export function Pagination({
  page,
  totalPages,
  totalItems,
  pageSize,
  onPageChange,
  disabled = false,
}: PaginationProps) {
  if (totalItems === 0) return null;

  const pages = pageNumbers(page, totalPages);
  const rangeStart = (page - 1) * pageSize + 1;
  const rangeEnd = Math.min(page * pageSize, totalItems);

  return (
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-4 border-t border-slate-800">
      <p className="text-sm text-slate-500">
        Showing {rangeStart}–{rangeEnd} of {totalItems}
        {totalPages > 1 ? ` · Page ${page} of ${totalPages}` : ""}
      </p>
      {totalPages > 1 && (
        <nav className="flex flex-wrap items-center gap-1" aria-label="Pagination">
          <button
            type="button"
            onClick={() => onPageChange(page - 1)}
            disabled={disabled || page <= 1}
            className="px-3 py-1.5 rounded-lg text-sm border border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800 disabled:opacity-40"
          >
            Previous
          </button>
          {pages[0] > 1 && (
            <>
              <button
                type="button"
                onClick={() => onPageChange(1)}
                disabled={disabled}
                className="min-w-[2.25rem] px-2 py-1.5 rounded-lg text-sm border border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800 disabled:opacity-40"
              >
                1
              </button>
              {pages[0] > 2 && <span className="px-1 text-slate-600">…</span>}
            </>
          )}
          {pages.map((pageNumber) => (
            <button
              key={pageNumber}
              type="button"
              onClick={() => onPageChange(pageNumber)}
              disabled={disabled}
              aria-current={pageNumber === page ? "page" : undefined}
              className={`min-w-[2.25rem] px-2 py-1.5 rounded-lg text-sm border ${
                pageNumber === page
                  ? "border-sky-500/50 bg-sky-500/15 text-sky-200"
                  : "border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800"
              } disabled:opacity-40`}
            >
              {pageNumber}
            </button>
          ))}
          {pages[pages.length - 1] < totalPages && (
            <>
              {pages[pages.length - 1] < totalPages - 1 && (
                <span className="px-1 text-slate-600">…</span>
              )}
              <button
                type="button"
                onClick={() => onPageChange(totalPages)}
                disabled={disabled}
                className="min-w-[2.25rem] px-2 py-1.5 rounded-lg text-sm border border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800 disabled:opacity-40"
              >
                {totalPages}
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => onPageChange(page + 1)}
            disabled={disabled || page >= totalPages}
            className="px-3 py-1.5 rounded-lg text-sm border border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800 disabled:opacity-40"
          >
            Next
          </button>
        </nav>
      )}
    </div>
  );
}
