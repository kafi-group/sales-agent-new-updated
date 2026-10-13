import { useEffect, useState } from "react";
import { client, type CatalogueItem, type EmailAttachment } from "../api/client";
import { IconBookOpen, IconPaperclip, IconX } from "./icons/AppIcons";

interface AttachCatalogueModalProps {
  onClose: () => void;
  onAttach: (attachments: EmailAttachment[]) => void;
  onError: (msg: string) => void;
}

export function AttachCatalogueModal({
  onClose,
  onAttach,
  onError,
}: AttachCatalogueModalProps) {
  const [catalogues, setCatalogues] = useState<CatalogueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [attaching, setAttaching] = useState(false);
  const [selectedCats, setSelectedCats] = useState<string[]>([]);
  const [includeHoreka, setIncludeHoreka] = useState(false);

  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const list = await client.listCatalogues();
        if (mounted) {
          setCatalogues(list);
          // Default select the main catalogue
          setSelectedCats(["all_products"]);
        }
      } catch (err) {
        if (mounted) onError(err instanceof Error ? err.message : "Failed to load catalogues");
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [onError]);

  function toggleCat(id: string) {
    setSelectedCats((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  function handleSelectAll() {
    setSelectedCats(catalogues.map((c) => c.id));
    setIncludeHoreka(true);
  }

  function handleDeselectAll() {
    setSelectedCats([]);
    setIncludeHoreka(false);
  }

  async function handleConfirm() {
    const totalSelected = selectedCats.length + (includeHoreka ? 1 : 0);
    if (totalSelected === 0) {
      onClose();
      return;
    }

    setAttaching(true);
    try {
      const added: EmailAttachment[] = [];

      if (selectedCats.length > 0) {
        const attachable = catalogues.filter(
          (c) => selectedCats.includes(c.id) && c.size > 0 && c.size <= 20 * 1024 * 1024,
        );
        const skipped = catalogues.filter(
          (c) => selectedCats.includes(c.id) && (!c.size || c.size > 20 * 1024 * 1024),
        );
        if (attachable.length > 0) {
          const catAtts = await client.attachCatalogues(attachable.map((c) => c.id));
          added.push(...catAtts);
        }
        if (skipped.length > 0) {
          onError(
            `${skipped.map((c) => c.title).join(", ")} ${skipped.length === 1 ? "is" : "are"} too large to attach (mailbox ~25 MB). Share the Catalogue download link instead.`,
          );
        }
      }

      if (includeHoreka) {
        const horekaAtt = await client.attachHorekaPriceList("excel");
        added.push(horekaAtt);
      }

      onAttach(added);
      onClose();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to attach catalogue");
    } finally {
      setAttaching(false);
    }
  }

  function formatSize(bytes: number): string {
    if (!bytes) return "PDF";
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  const totalCount = selectedCats.length + (includeHoreka ? 1 : 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm">
      <div className="w-full max-w-xl rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800 bg-slate-950/60">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
              <IconBookOpen size="sm" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-slate-100">Attach Catalogue / Price List</h3>
              <p className="text-xs text-slate-400">Select official product catalogues or B2B price lists to attach</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition cursor-pointer"
          >
            <IconX size="sm" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-4 overflow-y-auto flex-1">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Choose documents to include with this email:</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleSelectAll}
                className="text-emerald-400 hover:text-emerald-300 font-medium transition cursor-pointer"
              >
                Select All
              </button>
              <span>•</span>
              <button
                type="button"
                onClick={handleDeselectAll}
                className="text-slate-400 hover:text-slate-300 transition cursor-pointer"
              >
                Deselect
              </button>
            </div>
          </div>

          {loading ? (
            <div className="py-12 flex flex-col items-center justify-center gap-3 text-slate-400 text-sm">
              <div className="w-6 h-6 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin" />
              <span>Loading catalogues…</span>
            </div>
          ) : (
            <div className="space-y-2.5">
              {/* 4 Official Catalogues */}
              {catalogues.map((cat) => {
                const isSelected = selectedCats.includes(cat.id);
                return (
                  <label
                    key={cat.id}
                    className={`flex items-start gap-3 p-3.5 rounded-xl border transition cursor-pointer ${
                      isSelected
                        ? "border-emerald-500/60 bg-emerald-500/10 shadow-sm"
                        : "border-slate-800 bg-slate-950/40 hover:border-slate-700 hover:bg-slate-800/40"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleCat(cat.id)}
                      className="mt-1 w-4 h-4 rounded border-slate-700 text-emerald-600 focus:ring-emerald-500 cursor-pointer"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <span className="text-sm font-medium text-slate-100 truncate">{cat.title}</span>
                        <div className="flex items-center gap-1.5">
                          <span className="text-[11px] font-mono text-slate-400 bg-slate-800 px-2 py-0.5 rounded">
                            {formatSize(cat.size)}
                          </span>
                          <span className="text-[11px] font-semibold text-emerald-400 bg-emerald-500/15 border border-emerald-500/30 px-2 py-0.5 rounded">
                            {cat.badge}
                          </span>
                        </div>
                      </div>
                      <p className="text-xs text-slate-400 mt-1 line-clamp-2">{cat.description}</p>
                    </div>
                  </label>
                );
              })}

              {/* Horeka Price List Option */}
              <label
                className={`flex items-start gap-3 p-3.5 rounded-xl border transition cursor-pointer ${
                  includeHoreka
                    ? "border-emerald-500/60 bg-emerald-500/10 shadow-sm"
                    : "border-slate-800 bg-slate-950/40 hover:border-slate-700 hover:bg-slate-800/40"
                }`}
              >
                <input
                  type="checkbox"
                  checked={includeHoreka}
                  onChange={() => setIncludeHoreka(!includeHoreka)}
                  className="mt-1 w-4 h-4 rounded border-slate-700 text-emerald-600 focus:ring-emerald-500 cursor-pointer"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="text-sm font-medium text-slate-100">
                      Horeka B2B Wholesale Price List (Live Sheet)
                    </span>
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] font-mono text-slate-400 bg-slate-800 px-2 py-0.5 rounded">
                        Excel .xlsx
                      </span>
                      <span className="text-[11px] font-semibold text-amber-400 bg-amber-500/15 border border-amber-500/30 px-2 py-0.5 rounded">
                        177 Line Items
                      </span>
                    </div>
                  </div>
                  <p className="text-xs text-slate-400 mt-1">
                    Live B2B export price list per line item with packaging specs, MOQ, and standard/bulk tiers.
                  </p>
                </div>
              </label>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 px-5 py-4 border-t border-slate-800 bg-slate-950/60">
          <span className="text-xs text-slate-400">
            {totalCount > 0 ? (
              <span className="text-emerald-400 font-medium">
                {totalCount} document{totalCount > 1 ? "s" : ""} selected
              </span>
            ) : (
              "No documents selected"
            )}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={attaching}
              className="px-3.5 py-2 rounded-lg border border-slate-700 text-xs font-medium text-slate-300 hover:bg-slate-800 transition cursor-pointer disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleConfirm()}
              disabled={attaching || totalCount === 0}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold text-white transition shadow-sm cursor-pointer disabled:opacity-50"
            >
              <IconPaperclip size="xs" />
              <span>{attaching ? "Attaching…" : `Attach Selected (${totalCount})`}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
