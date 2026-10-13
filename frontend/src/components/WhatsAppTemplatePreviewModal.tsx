import { useMemo, useState } from "react";
import type { WhatsAppTemplate } from "../api/client";
import {
  renderWhatsAppTemplatePreview,
  suggestWhatsAppTemplateVariables,
  type WhatsAppLeadContext,
} from "../utils/whatsappTemplateVariables";
import { IconCopy, IconEdit, IconSparkles, IconTrash, IconX } from "./icons/AppIcons";
import { ActionButton } from "./ui/ActionButton";

interface WhatsAppTemplatePreviewModalProps {
  template: WhatsAppTemplate | null;
  onClose: () => void;
  leadContext?: WhatsAppLeadContext | null;
  onSelectTemplate?: (template: WhatsAppTemplate) => void;
  onDuplicateTemplate?: (template: WhatsAppTemplate) => void;
  onEditTemplate?: (template: WhatsAppTemplate) => void;
  onDeleteTemplate?: (template: WhatsAppTemplate) => void;
  deleting?: boolean;
}

export function WhatsAppTemplatePreviewModal({
  template,
  onClose,
  leadContext,
  onSelectTemplate,
  onDuplicateTemplate,
  onEditTemplate,
  onDeleteTemplate,
  deleting = false,
}: WhatsAppTemplatePreviewModalProps) {
  const [copied, setCopied] = useState(false);
  const initialVars = useMemo(() => {
    if (!template) return [];
    const count = template.variable_count || 0;
    if (leadContext) {
      return suggestWhatsAppTemplateVariables(template.body_text, count, leadContext);
    }
    return Array.from({ length: count }, (_, i) =>
      i === 0 ? "John Doe" : i === 1 ? "Acme Imports Ltd." : `Sample Value ${i + 1}`,
    );
  }, [template, leadContext]);

  const [sampleVars, setSampleVars] = useState<string[]>(initialVars);

  const previewText = useMemo(() => {
    if (!template?.body_text) return "";
    return renderWhatsAppTemplatePreview(template.body_text, sampleVars);
  }, [template?.body_text, sampleVars]);

  if (!template) return null;

  const handleCopy = async () => {
    if (!previewText) return;
    try {
      await navigator.clipboard.writeText(previewText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  const statusColor =
    template.status === "approved"
      ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40"
      : template.status === "rejected"
        ? "bg-red-500/20 text-red-300 border-red-500/40"
        : "bg-amber-500/20 text-amber-300 border-amber-500/40";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 overflow-y-auto"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="relative w-full max-w-2xl rounded-2xl border border-slate-700/80 bg-slate-900 shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Modal Header */}
        <div className="flex items-center justify-between border-b border-slate-800 bg-slate-950/80 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400 text-xl font-bold">
              WA
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-lg font-bold text-slate-100">{template.name}</h3>
                <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold border ${statusColor}`}>
                  {template.status}
                </span>
                {template.category && (
                  <span className="px-2 py-0.5 rounded text-xs border border-slate-700 bg-slate-800 text-slate-300 font-medium">
                    {template.category}
                  </span>
                )}
                <span className="text-xs text-slate-400 font-mono">{template.language}</span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">Meta Approved WhatsApp Message Template</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-100 transition"
            aria-label="Close"
          >
            <IconX size="md" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 overflow-y-auto space-y-5 flex-1">
          {template.rejection_reason && (
            <div className="rounded-xl border border-red-500/40 bg-red-950/30 p-3 text-xs text-red-200">
              <span className="font-bold">Rejection Reason:</span> {template.rejection_reason}
            </div>
          )}

          {/* WhatsApp Chat Preview Bubble */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
                <IconSparkles size="sm" className="text-emerald-400" />
                Live WhatsApp Message Preview
              </span>
              <button
                type="button"
                onClick={handleCopy}
                className="text-xs text-emerald-400 hover:text-emerald-300 flex items-center gap-1 font-medium transition"
              >
                <IconCopy size="xs" />
                {copied ? "Copied!" : "Copy Full Text"}
              </button>
            </div>

            <div className="rounded-2xl border border-slate-700/60 bg-slate-950 p-5 relative overflow-hidden bg-radial-gradient">
              {/* WhatsApp Message Bubble Mock */}
              <div className="max-w-md ml-auto sm:ml-4 rounded-2xl rounded-tl-sm bg-[#005c4b] border border-[#005c4b]/80 p-4 text-slate-100 shadow-lg space-y-2">
                <div className="text-sm sm:text-base leading-relaxed whitespace-pre-wrap font-sans text-slate-100 selection:bg-emerald-300 selection:text-slate-950">
                  {previewText || <span className="italic text-emerald-200/60">No body text specified.</span>}
                </div>
                <div className="flex items-center justify-end gap-1 text-[10px] text-emerald-200/70 pt-1">
                  <span>12:00 PM</span>
                  <span>✓✓</span>
                </div>
              </div>
            </div>
          </div>

          {/* Variables Sandbox (If template contains {{1}}, {{2}}...) */}
          {(template.variable_count > 0 || (sampleVars && sampleVars.length > 0)) && (
            <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-300 uppercase tracking-wider">
                  Template Variables ({sampleVars.length})
                </span>
                <span className="text-[11px] text-slate-500">Edit below to preview replacements</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {sampleVars.map((val, idx) => (
                  <div key={idx} className="space-y-1">
                    <label className="text-xs text-slate-400 font-mono">
                      {`{{${idx + 1}}}`} variable:
                    </label>
                    <input
                      type="text"
                      value={val}
                      onChange={(e) => {
                        const next = [...sampleVars];
                        next[idx] = e.target.value;
                        setSampleVars(next);
                      }}
                      placeholder={`e.g. Value for {{${idx + 1}}}`}
                      className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-slate-100 focus:border-emerald-500 focus:outline-none"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Raw Template Spec Details */}
          <div className="rounded-xl border border-slate-800/80 bg-slate-950/40 p-3 space-y-1.5 text-xs text-slate-400">
            <div className="flex justify-between">
              <span>Template Code Name:</span>
              <span className="font-mono text-slate-200 font-semibold">{template.name}</span>
            </div>
            {template.meta_template_id && (
              <div className="flex justify-between">
                <span>Meta Template ID:</span>
                <span className="font-mono text-slate-300">{template.meta_template_id}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span>Category / Language:</span>
              <span className="text-slate-300">
                {template.category || "GENERAL"} · {template.language}
              </span>
            </div>
            {template.synced_at && (
              <div className="flex justify-between">
                <span>Last Synced:</span>
                <span className="text-slate-400">{new Date(template.synced_at).toLocaleString()}</span>
              </div>
            )}
          </div>
        </div>

        {/* Modal Footer */}
        <div className="border-t border-slate-800 bg-slate-950/80 px-6 py-4 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            {onDuplicateTemplate ? (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onDuplicateTemplate(template);
                }}
                className="px-3.5 py-2 rounded-lg border border-violet-500/40 bg-violet-500/10 text-violet-200 hover:bg-violet-500/20 text-xs font-semibold transition inline-flex items-center gap-1.5"
              >
                <IconCopy size="xs" />
                Duplicate
              </button>
            ) : null}
            {onEditTemplate ? (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onEditTemplate(template);
                }}
                disabled={template.status === "pending"}
                className="px-3.5 py-2 rounded-lg border border-sky-500/40 bg-sky-500/10 text-sky-200 hover:bg-sky-500/20 text-xs font-semibold transition inline-flex items-center gap-1.5 disabled:opacity-40"
              >
                <IconEdit size="xs" />
                Edit
              </button>
            ) : null}
            {onDeleteTemplate ? (
              <button
                type="button"
                onClick={() => void onDeleteTemplate(template)}
                disabled={deleting}
                className="px-3.5 py-2 rounded-lg border border-red-500/40 bg-red-500/10 text-red-200 hover:bg-red-500/20 text-xs font-semibold transition inline-flex items-center gap-1.5 disabled:opacity-50"
              >
                <IconTrash size="xs" />
                {deleting ? "Deleting…" : "Delete"}
              </button>
            ) : null}
            {!onDuplicateTemplate && !onEditTemplate && !onDeleteTemplate ? <div /> : null}
          </div>

          <div className="flex items-center gap-2">
            <ActionButton icon={IconX} size="md" variant="ghost" onClick={onClose}>
              Close
            </ActionButton>
            {onSelectTemplate && (
              <button
                type="button"
                onClick={() => {
                  onSelectTemplate(template);
                  onClose();
                }}
                className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold transition shadow-md shadow-emerald-950/50"
              >
                Use This Template
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
