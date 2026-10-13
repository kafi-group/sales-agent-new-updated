import { useEffect, useRef, useState, type ChangeEvent } from "react";
import {
  client,
  type CatalogueItem,
  type EmailAttachment,
} from "../api/client";
import { ComposeMailModal } from "../components/ComposeMailModal";
import {
  IconBookOpen,
  IconCheck,
  IconDownload,
  IconEye,
  IconRefresh,
  IconSend,
  IconWhatsApp,
  IconTelegram,
  IconUpload,
} from "../components/icons/AppIcons";

interface CataloguePageProps {
  initialCatalogueId?: string | null;
  /** Only admins can replace a catalogue PDF. */
  isAdmin?: boolean;
  onError: (msg: string) => void;
  onNavigateToMail?: (initialThreadId?: string) => void;
}

function normalizeWhatsAppPhone(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  let digits = trimmed.replace(/[^\d+]/g, "");
  if (digits.startsWith("00")) digits = `+${digits.slice(2)}`;
  if (digits.startsWith("03") && digits.length === 11) return `+92${digits.slice(1)}`;
  if (/^3\d{9}$/.test(digits)) return `+92${digits}`;
  if (digits.startsWith("92") && !digits.startsWith("+")) return `+${digits}`;
  if (digits.startsWith("+")) return digits;
  return trimmed;
}

function formatSize(bytes: number): string {
  if (!bytes) return "PDF";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Gmail/Outlook reject ~25 MB messages — keep a buffer for body + MIME. */
const EMAIL_ATTACH_MAX_BYTES = 20 * 1024 * 1024;

function catalogueIsEmailAttachable(cat: CatalogueItem): boolean {
  return Boolean(cat.size) && cat.size <= EMAIL_ATTACH_MAX_BYTES;
}

function cataloguePublicUrl(cat: CatalogueItem): string {
  if (cat.download_url.startsWith("http")) return cat.download_url;
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}${cat.download_url.startsWith("/") ? "" : "/"}${cat.download_url}`;
}

export function CataloguePage({
  initialCatalogueId,
  isAdmin = false,
  onError,
}: CataloguePageProps) {
  const [catalogues, setCatalogues] = useState<CatalogueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedCatIds, setSelectedCatIds] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  // Replace a catalogue PDF (admin)
  const replaceInputRef = useRef<HTMLInputElement | null>(null);
  const replaceTargetRef = useRef<string | null>(null);
  const [replacingId, setReplacingId] = useState<string | null>(null);

  // Send modal state
  const [showCompose, setShowCompose] = useState(false);
  const [composeAttachments, setComposeAttachments] = useState<EmailAttachment[]>([]);
  const [composeSubject, setComposeSubject] = useState("");
  const [composeBody, setComposeBody] = useState("");

  // WhatsApp / Telegram send modal state
  const [showWhatsAppModal, setShowWhatsAppModal] = useState(false);
  const [shareChannel, setShareChannel] = useState<"whatsapp" | "telegram">("whatsapp");
  const [whatsAppRecipient, setWhatsAppRecipient] = useState("");
  const [whatsAppMessage, setWhatsAppMessage] = useState("");
  const [whatsAppSending, setWhatsAppSending] = useState(false);

  const loadData = async () => {
    setLoading(true);
    try {
      const list = await client.listCatalogues();
      setCatalogues(list);
      if (initialCatalogueId) {
        setSelectedCatIds([initialCatalogueId]);
      } else {
        setSelectedCatIds(["all_products"]);
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to load catalogues");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, [initialCatalogueId]);

  function handlePickReplacement(catId: string) {
    replaceTargetRef.current = catId;
    replaceInputRef.current?.click();
  }

  async function handleReplacementChosen(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    const catId = replaceTargetRef.current;
    e.target.value = "";
    replaceTargetRef.current = null;
    if (!file || !catId) return;
    const cat = catalogues.find((c) => c.id === catId);
    if (!cat) return;
    if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
      onError("Please choose a PDF file.");
      return;
    }
    const ok = window.confirm(
      `Replace "${cat.title}" (${formatSize(cat.size)}) with "${file.name}" (${formatSize(file.size)})?\n\n` +
        "This becomes the file that Email, WhatsApp and the AI agent send from now on. " +
        "You can go back to the original at any time.",
    );
    if (!ok) return;
    setReplacingId(catId);
    setNotice(null);
    try {
      const updated = await client.uploadCataloguePdf(catId, file);
      setCatalogues((prev) => prev.map((c) => (c.id === catId ? { ...c, ...updated } : c)));
      setNotice(
        `${cat.title} replaced — now ${formatSize(updated.size || file.size)} (was ${formatSize(cat.size)}).`,
      );
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not replace the catalogue");
    } finally {
      setReplacingId(null);
    }
  }

  async function handleRestoreOriginal(cat: CatalogueItem) {
    if (!window.confirm(`Go back to the original "${cat.title}" PDF? The uploaded version will be removed.`)) {
      return;
    }
    setReplacingId(cat.id);
    setNotice(null);
    try {
      const updated = await client.restoreCatalogueOriginal(cat.id);
      setCatalogues((prev) => prev.map((c) => (c.id === cat.id ? { ...c, ...updated } : c)));
      setNotice(`${cat.title} is back to the original PDF.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not restore the original catalogue");
    } finally {
      setReplacingId(null);
    }
  }

  function toggleSelect(id: string) {
    setSelectedCatIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  function handleSelectAll() {
    setSelectedCatIds(catalogues.map((c) => c.id));
  }

  function handleDeselectAll() {
    setSelectedCatIds([]);
  }

  async function handleOpenEmailComposer(specificCatId?: string) {
    const idsToAttach = specificCatId ? [specificCatId] : selectedCatIds;
    if (idsToAttach.length === 0) {
      onError("Please select at least one catalogue to send");
      return;
    }

    try {
      const selected = catalogues.filter((c) => idsToAttach.includes(c.id));
      const attachable = selected.filter(catalogueIsEmailAttachable);
      const linkOnly = selected.filter((c) => !catalogueIsEmailAttachable(c));

      const atts =
        attachable.length > 0
          ? await client.attachCatalogues(attachable.map((c) => c.id))
          : [];
      setComposeAttachments(atts);

      const titles = selected.map((c) => c.title).join(" & ");
      const linkHtml = linkOnly
        .map(
          (c) =>
            `<li><a href="${cataloguePublicUrl(c)}">${c.title}</a> (${formatSize(c.size)} — download link; too large to attach)</li>`,
        )
        .join("");

      setComposeSubject(`Product Catalogue & Company Profile — Kafi Commodities (${titles})`);
      setComposeBody(
        `<p>Dear Valued Partner,</p>` +
        `<p>Thank you for your interest in <strong>Kafi Commodities (Pvt.) Ltd. (Brand: ESSENCE)</strong>.</p>` +
        (attachable.length > 0
          ? `<p>Please find attached our latest <strong>${attachable.map((c) => c.title).join(" & ")}</strong> containing complete product specifications, packaging options, and private labeling details.</p>`
          : `<p>Please use the download link below for our latest <strong>${titles}</strong> containing complete product specifications, packaging options, and private labeling details.</p>`) +
        (linkHtml
          ? `<p>The following catalogue${linkOnly.length === 1 ? " is" : "s are"} too large for email attachment (mailbox limit ~25 MB). Please download:</p><ul>${linkHtml}</ul>`
          : "") +
        `<p>We would be pleased to provide you with customized FOB/CNF pricing and discuss MOQ requirements for your target market.</p>` +
        `<p>Looking forward to collaborating with your organization.</p>` +
        `<p>Best Regards,<br/><strong>Export Sales Team</strong><br/>Kafi Commodities (Pvt.) Ltd.<br/>Website: <a href="https://www.kafi-group.com">www.kafi-group.com</a></p>`
      );
      setShowCompose(true);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to attach catalogues");
    }
  }

  function handleOpenWhatsApp(specificCatId?: string) {
    const idsToAttach = specificCatId ? [specificCatId] : selectedCatIds;
    const selected = catalogues.filter((c) => idsToAttach.includes(c.id));
    const titles = selected.map((c) => c.title).join(" & ") || "product catalogue";
    const links = selected
      .map((c) => {
        return `• ${c.title}: ${cataloguePublicUrl(c)}`;
      })
      .join("\n");

    setShareChannel("whatsapp");
    setWhatsAppRecipient("");
    setWhatsAppMessage(
      `Hello! 👋 Greetings from *Kafi Commodities (Pvt.) Ltd. (Brand: ESSENCE)*.\n\n` +
      `Here is our official *${titles}*.\n\n` +
      (links ? `Download PDF:\n${links}\n\n` : "") +
      `Our range covers Basmati Rice, Himalayan Pink Salt, Spices, Pickles, Chutneys, Pastes, Sauces, and Desserts.\n\n` +
      `Let us know your destination port and quantity requirements so we can share instant CNF/FOB quotations.`
    );
    setShowWhatsAppModal(true);
  }

  function handleOpenTelegram(specificCatId?: string) {
    const idsToAttach = specificCatId ? [specificCatId] : selectedCatIds;
    const selected = catalogues.filter((c) => idsToAttach.includes(c.id));
    const titles = selected.map((c) => c.title).join(" & ") || "product catalogue";
    const links = selected
      .map((c) => {
        return `• ${c.title}: ${cataloguePublicUrl(c)}`;
      })
      .join("\n");

    setShareChannel("telegram");
    setWhatsAppRecipient("");
    setWhatsAppMessage(
      `Hello! Greetings from Kafi Commodities (Pvt.) Ltd. (Brand: ESSENCE).\n\n` +
      `Here is our official ${titles}.\n\n` +
      (links ? `Download PDF:\n${links}\n\n` : "") +
      `Our range covers Basmati Rice, Himalayan Pink Salt, Spices, Pickles, Chutneys, Pastes, Sauces, and Desserts.\n\n` +
      `Let us know your destination port and quantity requirements so we can share instant CNF/FOB quotations.`
    );
    setShowWhatsAppModal(true);
  }

  async function handleSendPersonalWhatsApp() {
    const phone = normalizeWhatsAppPhone(whatsAppRecipient);
    if (!phone) {
      onError("Enter a recipient phone number, e.g. +923001234567");
      return;
    }
    if (!whatsAppMessage.trim()) {
      onError("Message text is required");
      return;
    }
    setWhatsAppSending(true);
    try {
      if (shareChannel === "telegram") {
        await client.sendTelegramPersonal(phone, whatsAppMessage.trim());
        setNotice("Catalogue sent via Telegram Mobile.");
      } else {
        await client.sendWhatsAppPersonal({
          to_phone: phone,
          message: whatsAppMessage.trim(),
        });
        setNotice("Catalogue sent from your scanned personal WhatsApp.");
      }
      setShowWhatsAppModal(false);
    } catch (err) {
      onError(
        err instanceof Error
          ? err.message
          : shareChannel === "telegram"
            ? "Failed to send catalogue via Telegram"
            : "Failed to send catalogue via personal WhatsApp",
      );
    } finally {
      setWhatsAppSending(false);
    }
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto bg-slate-950 text-slate-100 p-4 sm:p-6 lg:p-8 space-y-6">
      {/* Header Banner */}
      <div className="rounded-2xl border border-slate-800 bg-gradient-to-r from-slate-900 via-slate-900/90 to-emerald-950/40 p-6 shadow-xl relative overflow-hidden">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 relative z-10">
          <div className="space-y-1.5 max-w-2xl">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-xs font-semibold">
              <IconBookOpen size="xs" />
              <span>Official Export Catalogues & Profiles</span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white">
              Product Catalogues & Brand Folios
            </h1>
            <p className="text-sm text-slate-300">
              High-resolution export catalogues ready for direct download, preview, and 1-click dispatch to clients across Email and WhatsApp.
            </p>
          </div>

          <div className="flex items-center gap-2.5 flex-wrap">
            <button
              type="button"
              onClick={() => void loadData()}
              className="px-3 py-2 rounded-xl border border-slate-700 bg-slate-800/80 hover:bg-slate-700 text-xs font-medium text-slate-200 transition cursor-pointer flex items-center gap-1.5"
            >
              <IconRefresh size="xs" />
              <span>Refresh</span>
            </button>
            <button
              type="button"
              onClick={() => void handleOpenEmailComposer()}
              disabled={selectedCatIds.length === 0}
              className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold text-white transition shadow-sm cursor-pointer disabled:opacity-40 flex items-center gap-1.5"
            >
              <IconSend size="xs" />
              <span>Send Selected via Email ({selectedCatIds.length})</span>
            </button>
            <button
              type="button"
              onClick={() => handleOpenWhatsApp()}
              disabled={selectedCatIds.length === 0}
              className="px-4 py-2 rounded-xl bg-emerald-700/80 hover:bg-emerald-600 border border-emerald-500/40 text-xs font-semibold text-white transition shadow-sm cursor-pointer disabled:opacity-40 flex items-center gap-1.5"
            >
              <IconWhatsApp size="xs" />
              <span>Share on WhatsApp ({selectedCatIds.length})</span>
            </button>
            <button
              type="button"
              onClick={() => handleOpenTelegram()}
              disabled={selectedCatIds.length === 0}
              className="px-4 py-2 rounded-xl bg-sky-700/80 hover:bg-sky-600 border border-sky-500/40 text-xs font-semibold text-white transition shadow-sm cursor-pointer disabled:opacity-40 flex items-center gap-1.5"
            >
              <IconTelegram size="xs" />
              <span>Share on Telegram ({selectedCatIds.length})</span>
            </button>
          </div>
        </div>

        {notice && (
          <div className="mt-4 p-3 rounded-xl bg-emerald-500/20 border border-emerald-500/40 text-emerald-200 text-xs flex items-center justify-between">
            <span>{notice}</span>
            <button type="button" onClick={() => setNotice(null)} className="text-slate-400 hover:text-white">✕</button>
          </div>
        )}
      </div>

      {/* Multi-Select Control Bar */}
      <div className="flex items-center justify-between gap-4 p-3 rounded-xl border border-slate-800 bg-slate-900/60 text-xs text-slate-300">
        <div className="flex items-center gap-3">
          <span className="font-semibold text-slate-200">
            Selected: {selectedCatIds.length} of {catalogues.length} Catalogues
          </span>
          <span>•</span>
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
            className="text-slate-400 hover:text-slate-200 transition cursor-pointer"
          >
            Clear Selection
          </button>
        </div>

        <span className="text-[11px] text-slate-400 font-mono hidden sm:inline">
          Format: High-Definition PDF Documents
        </span>
      </div>

      {/* Catalogues Grid */}
      {loading ? (
        <div className="py-24 flex flex-col items-center justify-center gap-3 text-slate-400">
          <div className="w-8 h-8 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin" />
          <span className="text-sm">Loading catalogues…</span>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {catalogues.map((cat) => {
            const isSelected = selectedCatIds.includes(cat.id);
            return (
              <div
                key={cat.id}
                className={`rounded-2xl border transition flex flex-col overflow-hidden ${
                  isSelected
                    ? "border-emerald-500/60 bg-slate-900/95 shadow-lg shadow-emerald-950/20"
                    : "border-slate-800 bg-slate-900/60 hover:border-slate-700"
                }`}
              >
                <div className="p-5 flex-1 flex flex-col justify-between space-y-4">
                  <div className="space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <label className="flex items-center gap-2.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleSelect(cat.id)}
                          className="w-4 h-4 rounded border-slate-700 text-emerald-600 focus:ring-emerald-500 cursor-pointer"
                        />
                        <div className="w-9 h-9 rounded-xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
                          <IconBookOpen size="sm" />
                        </div>
                        <div>
                          <h3 className="text-base font-bold text-slate-100 group-hover:text-emerald-400 transition">
                            {cat.title}
                          </h3>
                          <span className="text-xs text-slate-400">{cat.category}</span>
                        </div>
                      </label>

                      <div className="flex items-center gap-1.5">
                        <span className="text-[11px] font-mono text-slate-300 bg-slate-800 px-2 py-0.5 rounded border border-slate-700">
                          {formatSize(cat.size)}
                        </span>
                        <span className="text-[11px] font-semibold text-emerald-400 bg-emerald-500/15 border border-emerald-500/30 px-2 py-0.5 rounded">
                          {cat.badge}
                        </span>
                      </div>
                    </div>

                    {!catalogueIsEmailAttachable(cat) ? (
                      <p className="text-[11px] text-amber-200/90 bg-amber-500/10 border border-amber-500/25 rounded-lg px-2.5 py-1.5">
                        Too large for email attachment (mailbox ~25 MB). Email and WhatsApp send a download link instead of the PDF file.
                      </p>
                    ) : null}

                    <p className="text-xs text-slate-300 leading-relaxed">
                      {cat.description}
                    </p>

                    {cat.custom ? (
                      <p className="text-[11px] text-amber-200/90 flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="px-1.5 py-0.5 rounded border border-amber-500/30 bg-amber-500/10">
                          Uploaded PDF
                          {cat.updated_at ? ` · ${new Date(cat.updated_at).toLocaleDateString()}` : ""}
                        </span>
                        {isAdmin ? (
                          <button
                            type="button"
                            onClick={() => void handleRestoreOriginal(cat)}
                            disabled={replacingId !== null}
                            className="underline text-slate-400 hover:text-slate-200 disabled:opacity-50"
                          >
                            Restore original
                          </button>
                        ) : null}
                      </p>
                    ) : null}
                  </div>

                  <div className="flex items-center justify-between gap-2 pt-2 border-t border-slate-800 text-xs">
                    <span className="text-[11px] text-slate-400 truncate max-w-[200px]" title={cat.filename}>
                      📄 {cat.filename}
                    </span>
                    <span className="text-[11px] text-emerald-400 font-medium flex items-center gap-1">
                      <IconCheck size="xs" /> Ready for Export
                    </span>
                  </div>
                </div>

                {/* Actions Bar */}
                <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-slate-800 bg-slate-950/60">
                  <div className="flex items-center gap-2">
                    <a
                      href={cat.download_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-800/80 hover:bg-slate-700 text-xs font-medium text-slate-200 transition flex items-center gap-1.5"
                      title="Preview in Browser"
                    >
                      <IconEye size="xs" />
                      <span>Preview</span>
                    </a>
                    <a
                      href={cat.download_url}
                      download={cat.filename}
                      className="px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-800/80 hover:bg-slate-700 text-xs font-medium text-slate-200 transition flex items-center gap-1.5"
                      title="Download PDF"
                    >
                      <IconDownload size="xs" />
                      <span>Download</span>
                    </a>
                    {isAdmin ? (
                      <button
                        type="button"
                        onClick={() => handlePickReplacement(cat.id)}
                        disabled={replacingId !== null}
                        className="px-3 py-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20 disabled:opacity-50 text-xs font-medium text-amber-200 transition flex items-center gap-1.5"
                        title="Upload a new (for example compressed) PDF to replace this catalogue"
                      >
                        <IconUpload size="xs" />
                        <span>{replacingId === cat.id ? "Uploading…" : "Replace PDF"}</span>
                      </button>
                    ) : null}
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void handleOpenEmailComposer(cat.id)}
                      className="px-3 py-1.5 rounded-lg bg-emerald-600/90 hover:bg-emerald-500 text-xs font-semibold text-white transition flex items-center gap-1.5 cursor-pointer shadow-sm"
                    >
                      <IconSend size="xs" />
                      <span>Email</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleOpenWhatsApp(cat.id)}
                      className="px-3 py-1.5 rounded-lg bg-emerald-700/80 hover:bg-emerald-600 border border-emerald-500/40 text-xs font-semibold text-white transition flex items-center gap-1.5 cursor-pointer shadow-sm"
                    >
                      <IconWhatsApp size="xs" />
                      <span>WhatsApp</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleOpenTelegram(cat.id)}
                      className="px-3 py-1.5 rounded-lg bg-sky-700/80 hover:bg-sky-600 border border-sky-500/40 text-xs font-semibold text-white transition flex items-center gap-1.5 cursor-pointer shadow-sm"
                    >
                      <IconTelegram size="xs" />
                      <span>Telegram</span>
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {isAdmin ? (
        <input
          ref={replaceInputRef}
          type="file"
          accept="application/pdf,.pdf"
          className="hidden"
          onChange={(e) => void handleReplacementChosen(e)}
        />
      ) : null}

      {/* Compose Mail Modal */}
      {showCompose && (
        <ComposeMailModal
          fromEmail="Your configured mailbox"
          initialDraft={{
            to_addrs: "",
            cc_addrs: "",
            subject: composeSubject,
            body: composeBody,
            attachments: composeAttachments,
            updated_at: new Date().toISOString(),
          }}
          onClose={() => {
            setShowCompose(false);
            setComposeAttachments([]);
          }}
          onSent={(msg) => {
            setNotice(msg);
            setShowCompose(false);
            setComposeAttachments([]);
          }}
          onError={onError}
        />
      )}

      {/* WhatsApp Send Dialog */}
      {showWhatsAppModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2 text-emerald-400 font-semibold text-sm">
                {shareChannel === "telegram" ? <IconTelegram size="sm" /> : <IconWhatsApp size="sm" />}
                <span>
                  {shareChannel === "telegram"
                    ? "Share Catalogue on Telegram"
                    : "Share Catalogue on WhatsApp"}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setShowWhatsAppModal(false)}
                className="text-slate-400 hover:text-white"
              >
                ✕
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <p className="text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-3 py-2">
                {shareChannel === "telegram"
                  ? "Sends from your connected Telegram Mobile account."
                  : "Sends from your scanned WhatsApp Mobile session — not WhatsApp Web."}
              </p>
              <label className="block space-y-1">
                <span className="text-slate-400">Recipient Phone Number (e.g. +971501234567 or +923330313518)</span>
                <input
                  type="text"
                  value={whatsAppRecipient}
                  onChange={(e) => setWhatsAppRecipient(e.target.value)}
                  placeholder="+971501234567"
                  className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                />
              </label>

              <label className="block space-y-1">
                <span className="text-slate-400">Message Text</span>
                <textarea
                  rows={6}
                  value={whatsAppMessage}
                  onChange={(e) => setWhatsAppMessage(e.target.value)}
                  className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-xs text-slate-100 focus:outline-none focus:ring-1 focus:ring-emerald-500 font-sans"
                />
              </label>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-800">
              <button
                type="button"
                onClick={() => setShowWhatsAppModal(false)}
                className="px-3.5 py-2 rounded-lg border border-slate-700 text-xs text-slate-300 hover:bg-slate-800"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleSendPersonalWhatsApp()}
                disabled={whatsAppSending || !whatsAppRecipient.trim() || !whatsAppMessage.trim()}
                className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-xs font-semibold text-white flex items-center gap-1.5 shadow-sm"
              >
                {shareChannel === "telegram" ? <IconTelegram size="xs" /> : <IconWhatsApp size="xs" />}
                <span>
                  {whatsAppSending
                    ? "Sending…"
                    : shareChannel === "telegram"
                      ? "Send via Telegram"
                      : "Send from personal"}
                </span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
