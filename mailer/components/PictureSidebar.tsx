"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  fetchPictureLibrary,
  type PictureLibraryGroup,
  type PictureLibraryImage,
} from "@/lib/pictureLibrary";
import { useAuth } from "@/components/AuthProvider";
import { getStoredToken, loginFromHandoff } from "@/lib/api";

export type PictureSidebarProps = {
  isOpen: boolean;
  onClose: () => void;
  onInsert: (url: string, filename: string) => void;
  disabled?: boolean;
};

function formatSize(bytes?: number): string {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function readHandoffTokenFromUrl(): string {
  if (typeof window === "undefined") return "";
  try {
    return (new URLSearchParams(window.location.search).get("token") || "").trim();
  } catch {
    return "";
  }
}

export function PictureSidebar({
  isOpen,
  onClose,
  onInsert,
  disabled = false,
}: PictureSidebarProps) {
  const { token, loading: authLoading, adoptSession } = useAuth();
  const [groups, setGroups] = useState<PictureLibraryGroup[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [lastInsertedId, setLastInsertedId] = useState<string | null>(null);

  const searchInputRef = useRef<HTMLInputElement>(null);

  const loadLibrary = useCallback(async () => {
    setLoading(true);
    try {
      const urlTok = readHandoffTokenFromUrl();
      let tok = token || getStoredToken();
      if (urlTok && !tok) {
        try {
          const res = await loginFromHandoff(urlTok);
          adoptSession(res.token, res.user);
          tok = res.token;
        } catch {
          // ignore
        }
      }
      const data = await fetchPictureLibrary({ token: tok });
      setGroups(data.groups || []);
    } catch {
      setGroups([]);
    } finally {
      setLoading(false);
    }
  }, [token, adoptSession]);

  useEffect(() => {
    if (!authLoading) {
      void loadLibrary();
    }
  }, [authLoading, loadLibrary]);

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => searchInputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  // Aggregate images based on group and search
  const allImages: Array<{ image: PictureLibraryImage; groupName: string }> = [];
  for (const g of groups) {
    if (selectedGroupId === "all" || selectedGroupId === g.id) {
      for (const img of g.images || []) {
        allImages.push({ image: img, groupName: g.name });
      }
    }
  }

  const query = search.trim().toLowerCase();
  const filtered = allImages.filter(({ image, groupName }) => {
    if (!query) return true;
    const caption = (image.caption || "").toLowerCase();
    const filename = (image.filename || "").toLowerCase();
    const group = groupName.toLowerCase();
    return caption.includes(query) || filename.includes(query) || group.includes(query);
  });

  const totalImageCount = groups.reduce((acc, g) => acc + (g.images?.length || 0), 0);

  function handleSelectImage(e: ReactMouseEvent, img: PictureLibraryImage) {
    e.preventDefault();
    e.stopPropagation();
    onInsert(img.url, img.caption || img.filename);
    setLastInsertedId(img.id);
    // Keep panel open so user can insert 1, 2, 3 or more pictures successively!
    setTimeout(() => {
      setLastInsertedId(null);
    }, 1500);
  }

  if (!isOpen) return null;

  return (
    <aside
      className="picture-library-sidebar"
      style={{
        width: "340px",
        minWidth: "300px",
        maxWidth: "90vw",
        borderLeft: "1px solid var(--border, #334155)",
        background: "color-mix(in srgb, var(--panel, #0f172a) 95%, black)",
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: "100dvh",
        position: "sticky",
        top: 0,
        right: 0,
        zIndex: 50,
        boxShadow: "-8px 0 24px rgba(0, 0, 0, 0.45)",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "0.85rem 1rem",
          borderBottom: "1px solid var(--border, #334155)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "0.5rem",
          background: "color-mix(in srgb, var(--panel, #0f172a) 98%, black)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <span style={{ fontSize: "1.1rem" }}>🖼️</span>
          <div>
            <h3 style={{ margin: 0, fontSize: "0.95rem", fontWeight: 700, color: "var(--text, #f8fafc)" }}>
              Picture library
            </h3>
            <span style={{ fontSize: "0.72rem", color: "var(--muted, #94a3b8)" }}>
              {totalImageCount} picture{totalImageCount === 1 ? "" : "s"} available
            </span>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
          <button
            type="button"
            className="btn ghost small"
            onClick={() => void loadLibrary()}
            title="Refresh picture library"
            style={{ fontSize: "0.75rem", padding: "0.2rem 0.5rem" }}
          >
            ↻
          </button>
          <button
            type="button"
            className="btn ghost small"
            onClick={onClose}
            title="Close picture library sidebar"
            style={{ fontSize: "0.85rem", padding: "0.2rem 0.5rem", fontWeight: "bold" }}
          >
            ✕
          </button>
        </div>
      </div>

      {/* Guide note */}
      <div
        style={{
          padding: "0.45rem 1rem",
          fontSize: "0.72rem",
          color: "var(--muted, #94a3b8)",
          background: "rgba(56, 189, 248, 0.05)",
          borderBottom: "1px solid var(--border, #334155)",
        }}
      >
        Click any picture to insert at cursor. You can insert multiple pictures.
      </div>

      {/* Search Input */}
      <div style={{ padding: "0.75rem 1rem 0.4rem" }}>
        <input
          ref={searchInputRef}
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by caption or filename…"
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "0.5rem 0.75rem",
            fontSize: "0.82rem",
            borderRadius: "7px",
            border: "1px solid var(--border, #334155)",
            background: "#080e1a",
            color: "var(--text, #f8fafc)",
            outline: "none",
          }}
        />
      </div>

      {/* Group Dropdown */}
      {groups.length > 0 && (
        <div style={{ padding: "0.3rem 1rem 0.6rem" }}>
          <select
            value={selectedGroupId}
            onChange={(e) => setSelectedGroupId(e.target.value)}
            style={{
              width: "100%",
              padding: "0.4rem 0.75rem",
              fontSize: "0.82rem",
              borderRadius: "7px",
              border: "1px solid var(--border, #334155)",
              background: "#080e1a",
              color: "var(--text, #f8fafc)",
              outline: "none",
              cursor: "pointer",
            }}
          >
            <option value="all">All ({totalImageCount})</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name} ({g.images?.length || 0})
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Picture Grid */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "0.5rem 1rem 1rem",
          display: "flex",
          flexDirection: "column",
          gap: "0.75rem",
        }}
      >
        {loading ? (
          <div style={{ textAlign: "center", padding: "2rem 0", color: "var(--muted, #94a3b8)", fontSize: "0.85rem" }}>
            Loading pictures…
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: "center", padding: "2rem 1rem", color: "var(--muted, #94a3b8)", fontSize: "0.82rem" }}>
            {totalImageCount === 0 ? (
              <div>
                <p style={{ margin: "0 0 0.4rem", fontWeight: 500 }}>No pictures in library yet.</p>
                <p style={{ margin: 0, fontSize: "0.75rem", opacity: 0.8 }}>
                  Create groups and upload pictures in Sales Agent under <strong>Email templates → Picture library</strong>.
                </p>
              </div>
            ) : (
              "No pictures match your search."
            )}
          </div>
        ) : (
          filtered.map(({ image, groupName }) => {
            const isJustInserted = lastInsertedId === image.id;
            return (
              <div
                key={image.id}
                style={{
                  border: isJustInserted ? "2px solid #10b981" : "1px solid var(--border, #334155)",
                  borderRadius: "8px",
                  background: isJustInserted
                    ? "rgba(16, 185, 129, 0.15)"
                    : "color-mix(in srgb, var(--panel, #0f172a) 85%, black)",
                  overflow: "hidden",
                  transition: "all 0.15s ease",
                  boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
                }}
              >
                {/* Image preview click button */}
                <button
                  type="button"
                  disabled={disabled}
                  onClick={(e) => handleSelectImage(e, image)}
                  title={`Click to paste "${image.caption || image.filename}" into message body`}
                  style={{
                    display: "block",
                    width: "100%",
                    padding: 0,
                    border: 0,
                    background: "#080e1a",
                    cursor: "pointer",
                    textAlign: "center",
                    position: "relative",
                  }}
                >
                  <img
                    src={image.url}
                    alt={image.caption || image.filename}
                    loading="lazy"
                    style={{
                      width: "100%",
                      height: "150px",
                      objectFit: "contain",
                      display: "block",
                      background: "#050912",
                    }}
                  />
                  <div
                    style={{
                      position: "absolute",
                      inset: 0,
                      background: "rgba(0, 0, 0, 0.35)",
                      opacity: 0,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      transition: "opacity 0.15s ease",
                      color: "#fff",
                      fontWeight: 600,
                      fontSize: "0.85rem",
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
                    onMouseLeave={(e) => (e.currentTarget.style.opacity = "0")}
                  >
                    + Click to insert
                  </div>
                </button>

                {/* Caption / Metadata Bar */}
                <div style={{ padding: "0.55rem 0.7rem", display: "flex", flexDirection: "column", gap: "0.3rem" }}>
                  <div
                    style={{
                      fontWeight: 600,
                      fontSize: "0.8rem",
                      color: "var(--text, #f8fafc)",
                      lineHeight: 1.25,
                      wordBreak: "break-word",
                    }}
                  >
                    {image.caption || image.filename}
                  </div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      fontSize: "0.68rem",
                      color: "var(--muted, #94a3b8)",
                    }}
                  >
                    <span
                      style={{
                        padding: "0.1rem 0.35rem",
                        borderRadius: "4px",
                        background: "rgba(255,255,255,0.06)",
                        maxWidth: "140px",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      📁 {groupName}
                    </span>
                    <span>{formatSize(image.size)}</span>
                  </div>

                  {/* Insert Button */}
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={(e) => handleSelectImage(e, image)}
                    className={isJustInserted ? "btn small" : "btn ghost small"}
                    style={{
                      marginTop: "0.2rem",
                      width: "100%",
                      justifyContent: "center",
                      fontSize: "0.75rem",
                      padding: "0.3rem 0.5rem",
                      background: isJustInserted ? "#10b981" : undefined,
                      borderColor: isJustInserted ? "#10b981" : undefined,
                      color: isJustInserted ? "#fff" : undefined,
                    }}
                  >
                    {isJustInserted ? "✓ Inserted into email!" : "Insert into email"}
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Footer link to Sales Agent */}
      <div
        style={{
          padding: "0.65rem 1rem",
          borderTop: "1px solid var(--border, #334155)",
          fontSize: "0.72rem",
          color: "var(--muted, #94a3b8)",
          textAlign: "center",
          background: "color-mix(in srgb, var(--panel, #0f172a) 98%, black)",
        }}
      >
        To upload or manage photos:
        <br />
        <span style={{ color: "var(--text, #f8fafc)", fontWeight: 500 }}>
          Sales Agent → Email templates → Picture library
        </span>
      </div>
    </aside>
  );
}
