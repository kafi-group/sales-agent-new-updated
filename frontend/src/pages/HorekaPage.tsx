import { useEffect, useMemo, useState } from "react";
import {
  client,
  type EmailAttachment,
  type HorekaLineItemData,
} from "../api/client";
import { ComposeMailModal } from "../components/ComposeMailModal";
import {
  IconDownload,
  IconEdit,
  IconPlus,
  IconSearch,
  IconSend,
  IconTag,
  IconTrash,
  IconWhatsApp,
} from "../components/icons/AppIcons";

interface HorekaPageProps {
  initialCategory?: string | null;
  onError: (msg: string) => void;
}

export function HorekaPage({ initialCategory, onError }: HorekaPageProps) {
  const [items, setItems] = useState<HorekaLineItemData[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedCategory, setSelectedCategory] = useState<string>(initialCategory || "All");
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");
  const [savingId, setSavingId] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Edit / Add modal state
  const [showAddModal, setShowAddModal] = useState(false);
  const [newItem, setNewItem] = useState({
    category: "Spices Masala",
    product_name: "",
    item_code: "",
    packaging: "Standard Export Master Carton",
    unit: "USD/carton",
    standard_price: 18.0,
    bulk_tier1_price: 16.5,
    moq: "50 Master Cartons",
    stock_status: "In Stock",
    notes: "",
  });

  // Direct edit modal state
  const [editingItem, setEditingItem] = useState<HorekaLineItemData | null>(null);

  // Email / WhatsApp dispatch modal state
  const [showEmailModal, setShowEmailModal] = useState(false);
  const [emailAttachments, setEmailAttachments] = useState<EmailAttachment[]>([]);
  const [showWhatsAppModal, setShowWhatsAppModal] = useState(false);
  const [whatsAppRecipient, setWhatsAppRecipient] = useState("");
  const [whatsAppMessage, setWhatsAppMessage] = useState("");

  const loadData = async () => {
    setLoading(true);
    try {
      const res = await client.listHorekaItems({
        category: selectedCategory === "All" ? undefined : selectedCategory,
        search: searchTerm.trim() || undefined,
        stock_status: statusFilter === "All" ? undefined : statusFilter,
        limit: 1000,
      });
      setItems(res.items);
      setCategories(["All", ...res.categories]);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to load Horeka items");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, [selectedCategory, statusFilter]);

  const filteredItems = useMemo(() => {
    if (!searchTerm.trim()) return items;
    const q = searchTerm.toLowerCase();
    return items.filter(
      (it) =>
        it.product_name.toLowerCase().includes(q) ||
        (it.item_code && it.item_code.toLowerCase().includes(q)) ||
        it.category.toLowerCase().includes(q) ||
        it.packaging.toLowerCase().includes(q)
    );
  }, [items, searchTerm]);

  async function handleQuickPriceSave(item: HorekaLineItemData, newPrice: number) {
    if (isNaN(newPrice) || newPrice < 0) return;
    setSavingId(item.id);
    try {
      await client.updateHorekaItem(item.id, { standard_price: newPrice });
      setItems((prev) =>
        prev.map((it) => (it.id === item.id ? { ...it, standard_price: newPrice } : it))
      );
      setNotice(`Updated ${item.product_name} price to $${newPrice.toFixed(2)}`);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to update price");
    } finally {
      setSavingId(null);
    }
  }

  async function handleAddItem() {
    if (!newItem.product_name.trim()) {
      onError("Please enter a product name");
      return;
    }
    try {
      await client.createHorekaItem(newItem);
      setShowAddModal(false);
      setNotice(`Added new line item "${newItem.product_name}"`);
      void loadData();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to create line item");
    }
  }

  async function handleUpdateEditingItem() {
    if (!editingItem) return;
    try {
      await client.updateHorekaItem(editingItem.id, editingItem);
      setEditingItem(null);
      setNotice(`Updated "${editingItem.product_name}"`);
      void loadData();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to save line item");
    }
  }

  async function handleDeleteItem(id: number, name: string) {
    if (!confirm(`Are you sure you want to delete "${name}" from the price list?`)) return;
    try {
      await client.deleteHorekaItem(id);
      setItems((prev) => prev.filter((it) => it.id !== id));
      setNotice(`Deleted "${name}"`);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to delete line item");
    }
  }

  async function handleOpenEmailComposer() {
    try {
      const att = await client.attachHorekaPriceList("excel");
      setEmailAttachments([att]);
      setShowEmailModal(true);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to attach Horeka price list");
    }
  }

  function handleOpenWhatsApp() {
    setWhatsAppMessage(
      `Hello! 👋 Greetings from *Kafi Commodities (Pvt.) Ltd. (Brand: ESSENCE)*.\n\n` +
      `Here is our latest *Horeka & B2B Wholesale Export Price List* covering 177+ line items (Basmati Rice, Himalayan Salt, Spices, Pickles, Chutneys, Pastes, Sauces, and Food Service ingredients).\n\n` +
      `Let us know your required quantities or destination port for customized CNF/FOB container pricing.`
    );
    setShowWhatsAppModal(true);
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto bg-slate-950 text-slate-100 p-4 sm:p-6 lg:p-8 space-y-6">
      {/* Header Banner */}
      <div className="rounded-2xl border border-slate-800 bg-gradient-to-r from-slate-900 via-slate-900/90 to-amber-950/40 p-6 shadow-xl relative overflow-hidden">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 relative z-10">
          <div className="space-y-1.5 max-w-2xl">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-300 text-xs font-semibold">
              <IconTag size="xs" />
              <span>B2B & Food Service Wholesale Pricing</span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white">
              Horeka B2B Price List Manager
            </h1>
            <p className="text-sm text-slate-300">
              Line-item pricing per SKU across all 177+ FMCG categories with packaging specifications, MOQ tiers, live in-place edits, and 1-click Excel / Email / WhatsApp dispatch.
            </p>
          </div>

          <div className="flex items-center gap-2.5 flex-wrap">
            <a
              href="/api/horeka/export-excel"
              download="Kafi_Horeka_B2B_Price_List.xlsx"
              className="px-3.5 py-2 rounded-xl border border-emerald-500/40 bg-emerald-500/15 hover:bg-emerald-500/25 text-xs font-semibold text-emerald-200 transition cursor-pointer flex items-center gap-1.5 shadow-sm"
            >
              <IconDownload size="xs" />
              <span>Export Excel (.xlsx)</span>
            </a>
            <button
              type="button"
              onClick={() => setShowAddModal(true)}
              className="px-3.5 py-2 rounded-xl border border-slate-700 bg-slate-800/90 hover:bg-slate-700 text-xs font-semibold text-slate-100 transition cursor-pointer flex items-center gap-1.5 shadow-sm"
            >
              <IconPlus size="xs" />
              <span>Add Line Item</span>
            </button>
            <button
              type="button"
              onClick={() => void handleOpenEmailComposer()}
              className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold text-white transition shadow-sm cursor-pointer flex items-center gap-1.5"
            >
              <IconSend size="xs" />
              <span>Send via Email</span>
            </button>
            <button
              type="button"
              onClick={handleOpenWhatsApp}
              className="px-4 py-2 rounded-xl bg-emerald-700/80 hover:bg-emerald-600 border border-emerald-500/40 text-xs font-semibold text-white transition shadow-sm cursor-pointer flex items-center gap-1.5"
            >
              <IconWhatsApp size="xs" />
              <span>WhatsApp</span>
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

      {/* Category Tabs & Filter Toolbar */}
      <div className="space-y-3">
        {/* Category Pills */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1.5 text-xs no-scrollbar">
          {categories.map((cat) => {
            const isSelected = selectedCategory === cat;
            return (
              <button
                key={cat}
                type="button"
                onClick={() => setSelectedCategory(cat)}
                className={`shrink-0 px-3.5 py-1.5 rounded-xl font-medium transition cursor-pointer ${
                  isSelected
                    ? "bg-emerald-600 text-white font-semibold shadow-sm shadow-emerald-950/30"
                    : "bg-slate-900 border border-slate-800 text-slate-300 hover:bg-slate-800 hover:text-white"
                }`}
              >
                {cat}
              </button>
            );
          })}
        </div>

        {/* Search & Status Bar */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 p-3 rounded-xl border border-slate-800 bg-slate-900/60 text-xs">
          <div className="flex-1 w-full flex items-center gap-2">
            <div className="relative flex-1">
              <IconSearch
                size="xs"
                className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
              />
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Search products by name, item code, packaging, category…"
                className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              />
            </div>
            {searchTerm && (
              <button
                type="button"
                onClick={() => setSearchTerm("")}
                className="text-slate-400 hover:text-white"
              >
                Clear
              </button>
            )}
          </div>

          <div className="flex items-center gap-3 w-full sm:w-auto justify-between sm:justify-end text-xs text-slate-400">
            <span className="font-semibold text-slate-200">
              Showing {filteredItems.length} SKUs
            </span>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="rounded-lg bg-slate-950 border border-slate-700 px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            >
              <option value="All">All Stock Statuses</option>
              <option value="In Stock">In Stock</option>
              <option value="Low Stock">Low Stock</option>
              <option value="Made to Order">Made to Order</option>
            </select>
          </div>
        </div>
      </div>

      {/* Line Items Table */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/80 shadow-lg overflow-hidden">
        {loading ? (
          <div className="py-24 flex flex-col items-center justify-center gap-3 text-slate-400">
            <div className="w-8 h-8 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin" />
            <span className="text-sm">Loading price list…</span>
          </div>
        ) : filteredItems.length === 0 ? (
          <div className="py-20 text-center text-slate-400 text-sm">
            No line items match your current filter.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="border-b border-slate-800 bg-slate-950/80 text-slate-400 font-semibold uppercase tracking-wider text-[11px]">
                  <th className="px-4 py-3">Code</th>
                  <th className="px-4 py-3">Category</th>
                  <th className="px-4 py-3">Product Name</th>
                  <th className="px-4 py-3">Packaging / Specs</th>
                  <th className="px-4 py-3">Unit</th>
                  <th className="px-4 py-3 text-right">Standard Price</th>
                  <th className="px-4 py-3 text-right">Bulk Tier 1</th>
                  <th className="px-4 py-3">MOQ</th>
                  <th className="px-4 py-3 text-center">Status</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {filteredItems.map((it) => {
                  const isSaving = savingId === it.id;
                  return (
                    <tr
                      key={it.id}
                      className="hover:bg-slate-800/40 transition group"
                    >
                      <td className="px-4 py-2.5 font-mono text-[11px] text-slate-400 whitespace-nowrap">
                        {it.item_code || `KAF-${String(it.id).padStart(3, "0")}`}
                      </td>
                      <td className="px-4 py-2.5 text-slate-300 font-medium whitespace-nowrap">
                        <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700 text-[10px]">
                          {it.category}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-slate-100 font-semibold max-w-[220px] truncate" title={it.product_name}>
                        {it.product_name}
                      </td>
                      <td className="px-4 py-2.5 text-slate-400 max-w-[240px] truncate" title={it.packaging}>
                        {it.packaging}
                      </td>
                      <td className="px-4 py-2.5 text-slate-400 whitespace-nowrap">
                        {it.unit}
                      </td>
                      <td className="px-4 py-2.5 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1 justify-end">
                          <span className="text-slate-400">$</span>
                          <input
                            type="number"
                            step="0.1"
                            defaultValue={it.standard_price}
                            onBlur={(e) =>
                              handleQuickPriceSave(it, parseFloat(e.target.value))
                            }
                            className="w-16 px-1.5 py-0.5 rounded bg-slate-950 border border-slate-700 text-right font-mono font-bold text-emerald-400 focus:outline-none focus:ring-1 focus:ring-emerald-500 text-xs"
                          />
                          {isSaving && (
                            <div className="w-3 h-3 border border-emerald-400 border-t-transparent rounded-full animate-spin shrink-0" />
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-slate-300 whitespace-nowrap">
                        {it.bulk_tier1_price != null ? `$${it.bulk_tier1_price.toFixed(2)}` : "—"}
                      </td>
                      <td className="px-4 py-2.5 text-slate-400 text-[11px] whitespace-nowrap">
                        {it.moq || "10 Cartons"}
                      </td>
                      <td className="px-4 py-2.5 text-center whitespace-nowrap">
                        <span className="px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 text-[10px] font-semibold border border-emerald-500/30">
                          {it.stock_status}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right whitespace-nowrap">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => setEditingItem(it)}
                            className="p-1 rounded text-slate-400 hover:text-emerald-300 hover:bg-slate-800 transition"
                            title="Edit full item specs"
                          >
                            <IconEdit size="xs" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteItem(it.id, it.product_name)}
                            className="p-1 rounded text-slate-400 hover:text-rose-400 hover:bg-slate-800 transition"
                            title="Delete item"
                          >
                            <IconTrash size="xs" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Add Line Item Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2 text-emerald-400 font-semibold text-sm">
                <IconPlus size="sm" />
                <span>Add Horeka Line Item</span>
              </div>
              <button
                type="button"
                onClick={() => setShowAddModal(false)}
                className="text-slate-400 hover:text-white"
              >
                ✕
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <label className="block space-y-1">
                  <span className="text-slate-400">Category</span>
                  <input
                    type="text"
                    value={newItem.category}
                    onChange={(e) => setNewItem({ ...newItem, category: e.target.value })}
                    className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-1.5 text-xs text-slate-100"
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-slate-400">Item Code</span>
                  <input
                    type="text"
                    value={newItem.item_code}
                    onChange={(e) => setNewItem({ ...newItem, item_code: e.target.value })}
                    placeholder="e.g. KAF-SPC-045"
                    className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-1.5 text-xs text-slate-100"
                  />
                </label>
              </div>

              <label className="block space-y-1">
                <span className="text-slate-400">Product Name</span>
                <input
                  type="text"
                  value={newItem.product_name}
                  onChange={(e) => setNewItem({ ...newItem, product_name: e.target.value })}
                  placeholder="e.g. Biryani Masala 100g Box"
                  className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-1.5 text-xs text-slate-100 font-medium"
                />
              </label>

              <label className="block space-y-1">
                <span className="text-slate-400">Packaging Specification</span>
                <input
                  type="text"
                  value={newItem.packaging}
                  onChange={(e) => setNewItem({ ...newItem, packaging: e.target.value })}
                  placeholder="e.g. 100 GMS X 48 PACKS IN MASTER CARTON"
                  className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-1.5 text-xs text-slate-100"
                />
              </label>

              <div className="grid grid-cols-3 gap-3">
                <label className="block space-y-1">
                  <span className="text-slate-400">Unit</span>
                  <input
                    type="text"
                    value={newItem.unit}
                    onChange={(e) => setNewItem({ ...newItem, unit: e.target.value })}
                    className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-1.5 text-xs text-slate-100"
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-slate-400">Standard Price ($)</span>
                  <input
                    type="number"
                    step="0.1"
                    value={newItem.standard_price}
                    onChange={(e) =>
                      setNewItem({ ...newItem, standard_price: parseFloat(e.target.value) || 0 })
                    }
                    className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-1.5 text-xs text-emerald-400 font-bold font-mono"
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-slate-400">Bulk Tier 1 ($)</span>
                  <input
                    type="number"
                    step="0.1"
                    value={newItem.bulk_tier1_price}
                    onChange={(e) =>
                      setNewItem({ ...newItem, bulk_tier1_price: parseFloat(e.target.value) || 0 })
                    }
                    className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-1.5 text-xs text-slate-100 font-mono"
                  />
                </label>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <label className="block space-y-1">
                  <span className="text-slate-400">MOQ</span>
                  <input
                    type="text"
                    value={newItem.moq}
                    onChange={(e) => setNewItem({ ...newItem, moq: e.target.value })}
                    className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-1.5 text-xs text-slate-100"
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-slate-400">Stock Status</span>
                  <select
                    value={newItem.stock_status}
                    onChange={(e) => setNewItem({ ...newItem, stock_status: e.target.value })}
                    className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-1.5 text-xs text-slate-100"
                  >
                    <option value="In Stock">In Stock</option>
                    <option value="Low Stock">Low Stock</option>
                    <option value="Made to Order">Made to Order</option>
                  </select>
                </label>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-800">
              <button
                type="button"
                onClick={() => setShowAddModal(false)}
                className="px-3.5 py-2 rounded-lg border border-slate-700 text-xs text-slate-300 hover:bg-slate-800"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleAddItem()}
                className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold text-white shadow-sm"
              >
                Add Item
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Line Item Modal */}
      {editingItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2 text-emerald-400 font-semibold text-sm">
                <IconEdit size="sm" />
                <span>Edit Line Item Specs</span>
              </div>
              <button
                type="button"
                onClick={() => setEditingItem(null)}
                className="text-slate-400 hover:text-white"
              >
                ✕
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <label className="block space-y-1">
                  <span className="text-slate-400">Category</span>
                  <input
                    type="text"
                    value={editingItem.category}
                    onChange={(e) => setEditingItem({ ...editingItem, category: e.target.value })}
                    className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-1.5 text-xs text-slate-100"
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-slate-400">Item Code</span>
                  <input
                    type="text"
                    value={editingItem.item_code || ""}
                    onChange={(e) => setEditingItem({ ...editingItem, item_code: e.target.value })}
                    className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-1.5 text-xs text-slate-100"
                  />
                </label>
              </div>

              <label className="block space-y-1">
                <span className="text-slate-400">Product Name</span>
                <input
                  type="text"
                  value={editingItem.product_name}
                  onChange={(e) => setEditingItem({ ...editingItem, product_name: e.target.value })}
                  className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-1.5 text-xs text-slate-100 font-medium"
                />
              </label>

              <label className="block space-y-1">
                <span className="text-slate-400">Packaging Specification</span>
                <input
                  type="text"
                  value={editingItem.packaging}
                  onChange={(e) => setEditingItem({ ...editingItem, packaging: e.target.value })}
                  className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-1.5 text-xs text-slate-100"
                />
              </label>

              <div className="grid grid-cols-3 gap-3">
                <label className="block space-y-1">
                  <span className="text-slate-400">Unit</span>
                  <input
                    type="text"
                    value={editingItem.unit}
                    onChange={(e) => setEditingItem({ ...editingItem, unit: e.target.value })}
                    className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-1.5 text-xs text-slate-100"
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-slate-400">Standard Price ($)</span>
                  <input
                    type="number"
                    step="0.1"
                    value={editingItem.standard_price}
                    onChange={(e) =>
                      setEditingItem({
                        ...editingItem,
                        standard_price: parseFloat(e.target.value) || 0,
                      })
                    }
                    className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-1.5 text-xs text-emerald-400 font-bold font-mono"
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-slate-400">Bulk Tier 1 ($)</span>
                  <input
                    type="number"
                    step="0.1"
                    value={editingItem.bulk_tier1_price || 0}
                    onChange={(e) =>
                      setEditingItem({
                        ...editingItem,
                        bulk_tier1_price: parseFloat(e.target.value) || 0,
                      })
                    }
                    className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-1.5 text-xs text-slate-100 font-mono"
                  />
                </label>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <label className="block space-y-1">
                  <span className="text-slate-400">MOQ</span>
                  <input
                    type="text"
                    value={editingItem.moq || ""}
                    onChange={(e) => setEditingItem({ ...editingItem, moq: e.target.value })}
                    className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-1.5 text-xs text-slate-100"
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-slate-400">Stock Status</span>
                  <select
                    value={editingItem.stock_status}
                    onChange={(e) => setEditingItem({ ...editingItem, stock_status: e.target.value })}
                    className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-1.5 text-xs text-slate-100"
                  >
                    <option value="In Stock">In Stock</option>
                    <option value="Low Stock">Low Stock</option>
                    <option value="Made to Order">Made to Order</option>
                  </select>
                </label>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-800">
              <button
                type="button"
                onClick={() => setEditingItem(null)}
                className="px-3.5 py-2 rounded-lg border border-slate-700 text-xs text-slate-300 hover:bg-slate-800"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleUpdateEditingItem()}
                className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold text-white shadow-sm"
              >
                Save Changes
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Compose Mail Modal */}
      {showEmailModal && (
        <ComposeMailModal
          fromEmail="Your configured mailbox"
          initialDraft={{
            to_addrs: "",
            cc_addrs: "",
            subject: `Horeka B2B Export Wholesale Price List — Kafi Commodities (ESSENCE)`,
            body:
              `<p>Dear Valued Client,</p>` +
              `<p>Please find attached our latest <strong>Horeka & B2B Wholesale Export Price List</strong> for <strong>Kafi Commodities (Brand: ESSENCE)</strong>.</p>` +
              `<p>This sheet details our complete line-item pricing, master carton dimensions, and MOQ tiers across Basmati Rice, Himalayan Salt, Spices, Pickles, Chutneys, Pastes, Sauces, and Desserts.</p>` +
              `<p>Please feel free to share your destination port and required order quantities so we can prepare custom CNF/FOB container quotations.</p>` +
              `<p>Best Regards,<br/><strong>Export Sales Team</strong><br/>Kafi Commodities (Pvt.) Ltd.<br/>Website: <a href="https://www.kafi-group.com">www.kafi-group.com</a></p>`,
            attachments: emailAttachments,
            updated_at: new Date().toISOString(),
          }}
          onClose={() => {
            setShowEmailModal(false);
            setEmailAttachments([]);
          }}
          onSent={(msg) => {
            setNotice(msg);
            setShowEmailModal(false);
            setEmailAttachments([]);
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
                <IconWhatsApp size="sm" />
                <span>Send Horeka Price List via WhatsApp</span>
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
                onClick={() => {
                  const cleaned = whatsAppRecipient.replace(/[^0-9+]/g, "");
                  const url = cleaned
                    ? `https://wa.me/${cleaned.replace(/^\+/, "")}?text=${encodeURIComponent(whatsAppMessage)}`
                    : `https://api.whatsapp.com/send?text=${encodeURIComponent(whatsAppMessage)}`;
                  window.open(url, "_blank");
                  setShowWhatsAppModal(false);
                  setNotice("WhatsApp web dispatch launched.");
                }}
                className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold text-white flex items-center gap-1.5 shadow-sm"
              >
                <IconWhatsApp size="xs" />
                <span>Open in WhatsApp</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
