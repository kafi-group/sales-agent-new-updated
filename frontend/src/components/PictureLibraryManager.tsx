import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import {
  client,
  type PictureLibraryGroup,
  type PictureLibraryImage,
} from "../api/client";

interface PictureLibraryManagerProps {
  onError: (message: string) => void;
  onTotalPicturesChange?: (count: number) => void;
}

function formatBytes(bytes?: number): string {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function PictureLibraryManager({
  onError,
  onTotalPicturesChange,
}: PictureLibraryManagerProps) {
  const [groups, setGroups] = useState<PictureLibraryGroup[]>([]);
  const [activeGroupId, setActiveGroupId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [previewImage, setPreviewImage] = useState<PictureLibraryImage | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const totalPictures = groups.reduce((acc, g) => acc + (g.images?.length || 0), 0);

  useEffect(() => {
    onTotalPicturesChange?.(totalPictures);
  }, [totalPictures, onTotalPicturesChange]);

  const loadLibrary = useCallback(async () => {
    setLoading(true);
    try {
      const res = await client.listPictureLibrary();
      const list = res?.groups || [];
      setGroups(list);
      setActiveGroupId((prev) => {
        if (prev && list.some((g) => g.id === prev)) return prev;
        return list[0]?.id || "";
      });
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to load picture library");
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    void loadLibrary();
  }, [loadLibrary]);

  const activeGroup = groups.find((g) => g.id === activeGroupId) || null;

  const query = search.trim().toLowerCase();
  const filteredImages = (activeGroup?.images || []).filter((img) => {
    if (!query) return true;
    const nameMatch = (img.filename || "").toLowerCase().includes(query);
    const captionMatch = (img.caption || "").toLowerCase().includes(query);
    return nameMatch || captionMatch;
  });

  async function handleCreateGroup() {
    const name = newGroupName.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      const res = await client.createPictureGroup(name);
      if (res?.group) {
        setGroups((prev) => [...prev, res.group]);
        setActiveGroupId(res.group.id);
        setNewGroupName("");
        setNotice(`Group “${res.group.name}” created.`);
        setTimeout(() => setNotice(null), 3500);
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to create group");
    } finally {
      setBusy(false);
    }
  }

  async function handleRenameGroup(group: PictureLibraryGroup) {
    const nextName = window.prompt("Rename group", group.name)?.trim();
    if (!nextName || nextName === group.name) return;
    setBusy(true);
    try {
      const res = await client.renamePictureGroup(group.id, nextName);
      if (res?.group) {
        setGroups((prev) =>
          prev.map((g) => (g.id === group.id ? { ...g, name: nextName } : g)),
        );
        setNotice(`Group renamed to “${nextName}”.`);
        setTimeout(() => setNotice(null), 3000);
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to rename group");
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteGroup(group: PictureLibraryGroup) {
    const count = group.images?.length || 0;
    const msg = count > 0
      ? `Delete group “${group.name}” and all ${count} picture(s) inside it?`
      : `Delete group “${group.name}”?`;
    if (!window.confirm(msg)) return;
    setBusy(true);
    try {
      await client.deletePictureGroup(group.id);
      setGroups((prev) => {
        const next = prev.filter((g) => g.id !== group.id);
        if (activeGroupId === group.id) {
          setActiveGroupId(next[0]?.id || "");
        }
        return next;
      });
      setNotice(`Group “${group.name}” deleted.`);
      setTimeout(() => setNotice(null), 3000);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to delete group");
    } finally {
      setBusy(false);
    }
  }

  async function handleUploadFiles(files: FileList | File[]) {
    if (!activeGroup || !files.length) return;
    setUploading(true);
    setNotice("Uploading pictures…");
    const uploadedImages: PictureLibraryImage[] = [];
    let failed = 0;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file.type.startsWith("image/")) {
        continue;
      }
      try {
        const img = await client.uploadPictureToGroup(activeGroup.id, file);
        if (img) uploadedImages.push(img);
      } catch (e) {
        failed++;
      }
    }

    if (uploadedImages.length > 0) {
      setGroups((prev) =>
        prev.map((g) =>
          g.id === activeGroup.id
            ? { ...g, images: [...(g.images || []), ...uploadedImages] }
            : g,
        ),
      );
      setNotice(
        `Uploaded ${uploadedImages.length} picture(s)${
          failed > 0 ? ` (${failed} failed)` : ""
        }.`,
      );
      setTimeout(() => setNotice(null), 4000);
    } else if (failed > 0) {
      onError(`Failed to upload ${failed} file(s). Check file format & size.`);
      setNotice(null);
    } else {
      setNotice(null);
    }
    setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleUpdateCaption(imageId: string, nextCaption: string) {
    if (!activeGroup) return;
    try {
      await client.updatePictureCaption(activeGroup.id, imageId, nextCaption);
      setGroups((prev) =>
        prev.map((g) => {
          if (g.id !== activeGroup.id) return g;
          return {
            ...g,
            images: g.images.map((img) =>
              img.id === imageId ? { ...img, caption: nextCaption } : img,
            ),
          };
        }),
      );
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to update caption");
    }
  }

  async function handleDeleteImage(imageId: string, filename: string) {
    if (!activeGroup) return;
    if (!window.confirm(`Delete “${filename || "this picture"}”?`)) return;
    try {
      await client.deletePictureFromGroup(activeGroup.id, imageId);
      setGroups((prev) =>
        prev.map((g) => {
          if (g.id !== activeGroup.id) return g;
          return {
            ...g,
            images: g.images.filter((img) => img.id !== imageId),
          };
        }),
      );
      setNotice("Picture deleted.");
      setTimeout(() => setNotice(null), 3000);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to delete picture");
    }
  }

  async function handleSaveLibrary() {
    setSaving(true);
    setNotice("Publishing picture library to server…");
    try {
      const res = await client.savePictureLibrary(groups);
      if (res?.library?.groups) {
        setGroups(res.library.groups);
      }
      setNotice("Picture library saved & published to shared server.");
      setTimeout(() => setNotice(null), 4000);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to save picture library");
    } finally {
      setSaving(false);
    }
  }

  function handleCopyUrl(img: PictureLibraryImage) {
    if (!img.url) return;
    navigator.clipboard.writeText(img.url);
    setCopiedId(img.id);
    setTimeout(() => setCopiedId(null), 2000);
  }

  return (
    <div className="space-y-6 w-full min-w-0">
      {/* Top Banner & Actions */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <p className="text-sm text-slate-400 max-w-2xl">
            Upload and organize product photos, brochures, and marketing images into groups.
            These images can be inserted directly into outreach messages in the Bulk Mailer.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={saving || loading || groups.length === 0}
            onClick={() => void handleSaveLibrary()}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-sm font-medium text-white transition shadow-sm"
            title="Publish current library state to shared server"
          >
            {saving ? (
              <>
                <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                <span>Saving…</span>
              </>
            ) : (
              <>
                <span>💾 Save library</span>
              </>
            )}
          </button>
        </div>
      </div>

      {notice && (
        <div className="text-sm text-emerald-300 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 flex items-center justify-between">
          <span>{notice}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="text-xs text-emerald-400 hover:text-emerald-200 ml-3"
          >
            ✕
          </button>
        </div>
      )}

      {/* 2-Column Layout */}
      <div className="grid gap-6 lg:grid-cols-[minmax(280px,340px)_minmax(0,1fr)]">
        {/* Left Column: Groups List */}
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 overflow-hidden flex flex-col h-[740px]">
          <div className="px-4 py-3.5 border-b border-slate-800 bg-slate-900/80 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-slate-200 flex items-center gap-2">
                <span>📁 Picture Groups</span>
              </h3>
              <span className="text-xs px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 font-mono">
                {groups.length} groups · {totalPictures} pics
              </span>
            </div>

            {/* Add Group Form */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void handleCreateGroup();
              }}
              className="flex items-center gap-2"
            >
              <input
                type="text"
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                placeholder="New group name…"
                disabled={busy}
                className="flex-1 rounded-lg bg-slate-950 border border-slate-700/80 px-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-slate-500"
              />
              <button
                type="submit"
                disabled={busy || !newGroupName.trim()}
                className="px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-xs font-medium text-white transition"
              >
                + Add
              </button>
            </form>
          </div>

          {/* Groups list */}
          <div className="p-3 space-y-1.5 flex-1 overflow-y-auto">
            {loading ? (
              <p className="text-xs text-slate-500 p-3 text-center">Loading groups…</p>
            ) : groups.length === 0 ? (
              <div className="text-center p-6 border border-dashed border-slate-800 rounded-lg">
                <p className="text-xs text-slate-400 font-medium">No groups yet</p>
                <p className="text-[11px] text-slate-500 mt-1">
                  Create a group above (e.g. “Rice Products”, “Spices”, or “Certificates”).
                </p>
              </div>
            ) : (
              groups.map((g) => {
                const isActive = g.id === activeGroupId;
                const count = g.images?.length || 0;
                return (
                  <div
                    key={g.id}
                    className={`group/item rounded-lg border px-3 py-2.5 flex items-center justify-between gap-2 transition cursor-pointer ${
                      isActive
                        ? "border-emerald-500/50 bg-emerald-500/10 text-slate-100"
                        : "border-slate-800/80 bg-slate-950/70 hover:bg-slate-900/60 text-slate-300"
                    }`}
                    onClick={() => setActiveGroupId(g.id)}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium truncate">{g.name}</span>
                      </div>
                      <span className="text-[11px] text-slate-500">
                        {count} {count === 1 ? "picture" : "pictures"}
                      </span>
                    </div>

                    <div className="flex items-center gap-1 opacity-0 group-hover/item:opacity-100 transition">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleRenameGroup(g);
                        }}
                        title="Rename group"
                        className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200 text-xs"
                      >
                        ✏️
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleDeleteGroup(g);
                        }}
                        title="Delete group"
                        className="p-1 rounded hover:bg-rose-950/60 text-slate-400 hover:text-rose-400 text-xs"
                      >
                        🗑️
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Right Column: Active Group Images Gallery */}
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 overflow-hidden flex flex-col h-[740px]">
          {activeGroup ? (
            <>
              {/* Group Header & Toolbar */}
              <div className="px-5 py-3.5 border-b border-slate-800 bg-slate-900/80 flex items-center justify-between gap-4 flex-wrap">
                <div className="flex items-center gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                      <span>{activeGroup.name}</span>
                      <span className="text-xs font-normal text-slate-400">
                        ({filteredImages.length}
                        {query ? ` of ${activeGroup.images?.length || 0}` : ""}{" "}
                        {filteredImages.length === 1 ? "picture" : "pictures"})
                      </span>
                    </h3>
                  </div>
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                  {/* Search within group */}
                  <input
                    type="search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search caption / file…"
                    className="w-48 rounded-lg bg-slate-950 border border-slate-700/80 px-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-slate-500"
                  />

                  {/* Hidden file input for uploading */}
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept="image/*"
                    onChange={(e: ChangeEvent<HTMLInputElement>) => {
                      if (e.target.files?.length) {
                        void handleUploadFiles(e.target.files);
                      }
                    }}
                    className="hidden"
                  />

                  <button
                    type="button"
                    disabled={uploading}
                    onClick={() => fileInputRef.current?.click()}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-xs font-medium text-white transition shadow-sm"
                  >
                    {uploading ? (
                      <>
                        <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        <span>Uploading…</span>
                      </>
                    ) : (
                      <>
                        <span>+ Upload to group</span>
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* Drop area / Gallery grid */}
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDragging(true);
                }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setIsDragging(false);
                  if (e.dataTransfer.files?.length) {
                    void handleUploadFiles(e.dataTransfer.files);
                  }
                }}
                className={`flex-1 p-5 overflow-y-auto transition ${
                  isDragging
                    ? "bg-emerald-950/20 border-2 border-dashed border-emerald-500/60"
                    : ""
                }`}
              >
                {filteredImages.length === 0 ? (
                  <div className="h-full min-h-[300px] flex flex-col items-center justify-center text-center p-8 border border-dashed border-slate-800 rounded-xl bg-slate-950/30">
                    <span className="text-3xl mb-2">🖼️</span>
                    <p className="text-sm font-medium text-slate-300">
                      {query ? "No pictures match your search" : "No pictures in this group yet"}
                    </p>
                    <p className="text-xs text-slate-500 mt-1 max-w-sm">
                      {query
                        ? "Try clearing the search box to view all pictures in this group."
                        : "Click “Upload to group” above or drag and drop image files directly onto this area."}
                    </p>
                    {!query && (
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className="mt-4 px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 font-medium transition"
                      >
                        Choose files to upload
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                    {filteredImages.map((img) => (
                      <div
                        key={img.id}
                        className="group rounded-xl border border-slate-800 bg-slate-950 overflow-hidden flex flex-col hover:border-slate-700 transition shadow-sm"
                      >
                        {/* Image Preview Container */}
                        <div
                          className="relative aspect-video bg-slate-900 overflow-hidden cursor-pointer"
                          onClick={() => setPreviewImage(img)}
                          title="Click to preview large"
                        >
                          <img
                            src={img.url}
                            alt={img.caption || img.filename}
                            loading="lazy"
                            className="w-full h-full object-contain p-1 group-hover:scale-105 transition duration-200"
                          />
                          <div className="absolute top-2 left-2 px-1.5 py-0.5 rounded bg-black/60 backdrop-blur-sm text-[10px] text-slate-300 font-mono">
                            {formatBytes(img.size)}
                          </div>
                          <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleCopyUrl(img);
                              }}
                              className="px-2 py-1 rounded bg-black/70 hover:bg-black text-[10px] text-slate-200"
                              title="Copy hosted image link"
                            >
                              {copiedId === img.id ? "✓ Copied" : "🔗 Copy link"}
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                void handleDeleteImage(img.id, img.filename || img.caption || "");
                              }}
                              className="p-1 rounded bg-black/70 hover:bg-rose-900/80 text-rose-300 text-xs"
                              title="Delete picture"
                            >
                              🗑️
                            </button>
                          </div>
                        </div>

                        {/* Caption and filename */}
                        <div className="p-3 border-t border-slate-800/80 space-y-1.5 flex-1 flex flex-col justify-between">
                          <label className="block">
                            <span className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">
                              Caption
                            </span>
                            <input
                              type="text"
                              defaultValue={img.caption || ""}
                              placeholder="Enter caption or product label…"
                              onBlur={(e) => {
                                const next = e.target.value.trim();
                                if (next !== (img.caption || "")) {
                                  void handleUpdateCaption(img.id, next);
                                }
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.currentTarget.blur();
                                }
                              }}
                              className="mt-1 w-full rounded bg-slate-900 border border-slate-800 px-2 py-1 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-slate-600"
                            />
                          </label>

                          <div className="flex items-center justify-between text-[11px] text-slate-500 pt-1">
                            <span className="truncate max-w-[170px]" title={img.filename}>
                              {img.filename}
                            </span>
                            <button
                              type="button"
                              onClick={() => setPreviewImage(img)}
                              className="text-sky-400 hover:text-sky-300 text-[11px]"
                            >
                              View large ↗
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="h-full flex flex-col items-center justify-center text-center p-8 text-slate-500">
              <span className="text-4xl mb-3">📁</span>
              <p className="text-sm font-medium text-slate-400">Select or create a group</p>
              <p className="text-xs text-slate-500 mt-1 max-w-sm">
                Choose a group on the left to view, manage, and upload pictures.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Enlarged Picture Modal */}
      {previewImage && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
          onClick={() => setPreviewImage(null)}
        >
          <div
            className="max-w-4xl max-h-[90vh] bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden flex flex-col shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-3 border-b border-slate-800 flex items-center justify-between">
              <div>
                <h4 className="text-sm font-medium text-slate-200">
                  {previewImage.caption || previewImage.filename}
                </h4>
                <p className="text-xs text-slate-500 font-mono">
                  {previewImage.filename} · {formatBytes(previewImage.size)}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleCopyUrl(previewImage)}
                  className="px-3 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 font-medium transition"
                >
                  {copiedId === previewImage.id ? "✓ Copied" : "Copy URL"}
                </button>
                <button
                  type="button"
                  onClick={() => setPreviewImage(null)}
                  className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-400 hover:text-slate-100"
                >
                  ✕
                </button>
              </div>
            </div>
            <div className="p-4 flex items-center justify-center max-h-[75vh] overflow-hidden bg-black/50">
              <img
                src={previewImage.url}
                alt={previewImage.caption || previewImage.filename}
                className="max-h-[70vh] max-w-full object-contain rounded-lg"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
