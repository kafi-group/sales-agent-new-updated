import { useState } from "react";
import {
  client,
  type CnfLivePricingResponse,
  type EmailAttachment,
} from "../api/client";
import { IconPaperclip, IconX } from "./icons/AppIcons";

interface AttachCnfCardModalProps {
  onClose: () => void;
  onAttach: (attachments: EmailAttachment[]) => void;
  onError: (msg: string) => void;
  initialSku?: string;
}

export function AttachCnfCardModal({
  onClose,
  onAttach,
  onError,
  initialSku = "",
}: AttachCnfCardModalProps) {
  const [activeTab, setActiveTab] = useState<"price_card" | "quotation_card">("price_card");

  // Single SKU Price Card State
  const [sku, setSku] = useState(initialSku);
  const [skuFormat, setSkuFormat] = useState<"image" | "pdf">("image");
  const [loadingPricing, setLoadingPricing] = useState(false);
  const [pricingData, setPricingData] = useState<CnfLivePricingResponse | null>(null);
  const [attachingSku, setAttachingSku] = useState(false);

  // Full Container Quotation Card State
  const [quotationId, setQuotationId] = useState("");
  const [quoteFormat, setQuoteFormat] = useState<"pdf" | "image">("pdf");
  const [attachingQuote, setAttachingQuote] = useState(false);

  // Quick preset SKUs for convenience
  const quickSkus = [
    { sku: "SKU-FI-29", name: "Green Chilli Chutney 330g" },
    { sku: "SKU-FI-01", name: "Kafi Basmati Rice 5kg" },
    { sku: "SKU-FI-12", name: "Himalayan Pink Salt 800g" },
    { sku: "SKU-FI-45", name: "Mango Pickle 1kg Jar" },
    { sku: "SKU-FI-88", name: "Chaat Masala 100g Box" },
  ];

  async function handleLookupPricing(targetSku?: string) {
    const querySku = (targetSku || sku).trim();
    if (!querySku) {
      onError("Please enter a SKU code to check live pricing.");
      return;
    }
    setLoadingPricing(true);
    setPricingData(null);
    try {
      const data = await client.getLiveCnfPricing(querySku);
      setPricingData(data);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to fetch live pricing");
    } finally {
      setLoadingPricing(false);
    }
  }

  async function handleAttachPriceCard() {
    const querySku = sku.trim();
    if (!querySku) {
      onError("Please enter a SKU code.");
      return;
    }
    setAttachingSku(true);
    try {
      const att = await client.attachCnfPriceCard(querySku, skuFormat);
      onAttach([att]);
      onClose();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to generate price card");
    } finally {
      setAttachingSku(false);
    }
  }

  async function handleAttachQuotationCard() {
    const qid = quotationId.trim();
    if (!qid) {
      onError("Please enter a Quotation ID.");
      return;
    }
    setAttachingQuote(true);
    try {
      const att = await client.attachCnfQuotationCard(qid, quoteFormat);
      onAttach([att]);
      onClose();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to generate quotation card");
    } finally {
      setAttachingQuote(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm">
      <div className="w-full max-w-xl rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800 bg-slate-950/50">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-cyan-500/10 border border-cyan-500/20 text-cyan-400">
              <IconPaperclip className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-semibold text-white text-base">CNF / FOB Live Cards</h3>
                <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 uppercase tracking-wider">
                  Live Engine
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                Direct two-way handshake with Kafi Costing Engine (kafiai-agents.vercel.app)
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <IconX className="w-5 h-5" />
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="flex border-b border-slate-800 bg-slate-950/30 px-5 pt-3 gap-2">
          <button
            type="button"
            onClick={() => setActiveTab("price_card")}
            className={`pb-2.5 px-3 text-xs font-medium border-b-2 transition-colors ${
              activeTab === "price_card"
                ? "border-cyan-500 text-cyan-400 font-semibold"
                : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            🏷️ Single Product Price Card
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("quotation_card")}
            className={`pb-2.5 px-3 text-xs font-medium border-b-2 transition-colors ${
              activeTab === "quotation_card"
                ? "border-cyan-500 text-cyan-400 font-semibold"
                : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            🚢 Full Container CNF Quotation
          </button>
        </div>

        {/* Body */}
        <div className="p-5 overflow-y-auto space-y-4">
          {activeTab === "price_card" ? (
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  Enter SKU Code or Product ID
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={sku}
                    onChange={(e) => setSku(e.target.value)}
                    placeholder="e.g. SKU-FI-29, SKU-FI-01..."
                    className="flex-1 rounded-xl bg-slate-950 border border-slate-700 px-3.5 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500"
                  />
                  <button
                    type="button"
                    onClick={() => void handleLookupPricing()}
                    disabled={loadingPricing || !sku.trim()}
                    className="px-4 py-2 rounded-xl text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 disabled:opacity-50 transition-colors"
                  >
                    {loadingPricing ? "Fetching…" : "Check FOB Price"}
                  </button>
                </div>
              </div>

              {/* Quick SKU presets */}
              <div>
                <span className="text-[11px] font-medium text-slate-400 block mb-1.5">
                  Popular SKUs:
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {quickSkus.map((item) => (
                    <button
                      key={item.sku}
                      type="button"
                      onClick={() => {
                        setSku(item.sku);
                        void handleLookupPricing(item.sku);
                      }}
                      className="px-2.5 py-1 rounded-lg text-[11px] bg-slate-800/80 hover:bg-cyan-950/40 text-slate-300 hover:text-cyan-300 border border-slate-700 hover:border-cyan-500/40 transition-colors"
                    >
                      {item.sku} • {item.name}
                    </button>
                  ))}
                </div>
              </div>

              {/* Live pricing result box */}
              {pricingData && (
                <div className="p-3.5 rounded-xl bg-cyan-950/20 border border-cyan-500/30 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-cyan-300">
                      {pricingData.name || pricingData.sku}
                    </span>
                    <span className="text-xs font-bold text-emerald-400 bg-emerald-950/40 px-2 py-0.5 rounded border border-emerald-500/30">
                      ${pricingData.pricePerUnit?.toFixed(2)} / {pricingData.unit || "unit"} {pricingData.currency || "USD"}
                    </span>
                  </div>
                  {pricingData.packaging && (
                    <p className="text-[11px] text-slate-400">Packaging: {pricingData.packaging}</p>
                  )}
                  <p className="text-[10px] text-slate-500">
                    Live FOB calculated on-the-fly from Kafi Costing Engine
                  </p>
                </div>
              )}

              {/* Format selection */}
              <div className="flex items-center justify-between pt-2 border-t border-slate-800">
                <span className="text-xs text-slate-300 font-medium">Render Format:</span>
                <div className="flex gap-2">
                  <label className="flex items-center gap-1.5 text-xs text-slate-300 cursor-pointer">
                    <input
                      type="radio"
                      name="skuFormat"
                      value="image"
                      checked={skuFormat === "image"}
                      onChange={() => setSkuFormat("image")}
                      className="text-cyan-500 focus:ring-cyan-500"
                    />
                    PNG Image Card (WhatsApp friendly)
                  </label>
                  <label className="flex items-center gap-1.5 text-xs text-slate-300 cursor-pointer">
                    <input
                      type="radio"
                      name="skuFormat"
                      value="pdf"
                      checked={skuFormat === "pdf"}
                      onChange={() => setSkuFormat("pdf")}
                      className="text-cyan-500 focus:ring-cyan-500"
                    />
                    PDF Document
                  </label>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  Enter Quotation ID from CNF Costing App
                </label>
                <input
                  type="text"
                  value={quotationId}
                  onChange={(e) => setQuotationId(e.target.value)}
                  placeholder="e.g. Q-2026-0891, 1042..."
                  className="w-full rounded-xl bg-slate-950 border border-slate-700 px-3.5 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500"
                />
                <p className="text-[11px] text-slate-400 mt-1">
                  Pulls the full multi-product container quotation breakdown with freight and packing.
                </p>
              </div>

              {/* Format selection */}
              <div className="flex items-center justify-between pt-2 border-t border-slate-800">
                <span className="text-xs text-slate-300 font-medium">Render Format:</span>
                <div className="flex gap-2">
                  <label className="flex items-center gap-1.5 text-xs text-slate-300 cursor-pointer">
                    <input
                      type="radio"
                      name="quoteFormat"
                      value="pdf"
                      checked={quoteFormat === "pdf"}
                      onChange={() => setQuoteFormat("pdf")}
                      className="text-cyan-500 focus:ring-cyan-500"
                    />
                    PDF Document (Standard)
                  </label>
                  <label className="flex items-center gap-1.5 text-xs text-slate-300 cursor-pointer">
                    <input
                      type="radio"
                      name="quoteFormat"
                      value="image"
                      checked={quoteFormat === "image"}
                      onChange={() => setQuoteFormat("image")}
                      className="text-cyan-500 focus:ring-cyan-500"
                    />
                    PNG Image Card
                  </label>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3.5 border-t border-slate-800 bg-slate-950/50">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            Cancel
          </button>
          {activeTab === "price_card" ? (
            <button
              type="button"
              onClick={() => void handleAttachPriceCard()}
              disabled={attachingSku || !sku.trim()}
              className="flex items-center gap-2 px-5 py-2 rounded-xl text-xs font-semibold bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white shadow-lg shadow-cyan-900/30 disabled:opacity-50 transition-all"
            >
              <IconPaperclip className="w-3.5 h-3.5" />
              {attachingSku ? "Rendering & Attaching…" : "Attach Live Price Card"}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void handleAttachQuotationCard()}
              disabled={attachingQuote || !quotationId.trim()}
              className="flex items-center gap-2 px-5 py-2 rounded-xl text-xs font-semibold bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white shadow-lg shadow-cyan-900/30 disabled:opacity-50 transition-all"
            >
              <IconPaperclip className="w-3.5 h-3.5" />
              {attachingQuote ? "Rendering & Attaching…" : "Attach CNF Quotation Card"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
