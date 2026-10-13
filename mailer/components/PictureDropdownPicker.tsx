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

export type PictureDropdownPickerProps = {
  onInsert: (url: string, filename: string) => void;
  disabled?: boolean;
  className?: string;
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

export function PictureDropdownPicker({
  onInsert,
  disabled = false,
  className = "",
}: PictureDropdownPickerProps) {
  const { token, loading: authLoading, adoptSession } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
  const [groups, setGroups] = useState<PictureLibraryGroup[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [lastInsertedId, setLastInsertedId] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
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
      setTimeout(() => searchInputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  // Close on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
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
    setTimeout(() => {
      setLastInsertedId(null);
      setIsOpen(false);
    }, 400);
  }

  return (
    <div
      ref={containerRef}
      className={`picture-dropdown-picker-wrap ${className}`}
      style={{ position: "relative", display: "inline-block" }}
    >
      <button
        type="button"
        disabled={disabled}
        onClick={() => setIsOpen((prev) => !prev)}
        className="btn ghost small"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "0.4rem",
          fontWeight: 500,
        }}
        title="Browse hosted pictures and insert into email"
      >
        <span>🖼️ Insert picture</span>
        {totalImageCount > 0 && (
          <span
            style={{
              fontSize: "0.75rem",
              background: "var(--border)",
              padding: "0.1rem 0.35rem",
              borderRadius: "999px",
            }}
          >
            {totalImageCount}
          </span>
        )}
        <span style={{ fontSize: "0.7rem", opacity: 0.7 }}>{isOpen ? "▲" : "▼"}</span>
      </button>

      {isOpen && (
        <div
          className="picture-dropdown-popover"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: 0,
            zIndex: 1000,
            width: "420px",
            maxWidth: "92vw",
            background: "var(--panel, #0f172a)",
            border: "1px solid var(--border, #334155)",
            borderRadius: "10px",
            boxShadow: "0 12px 30px rgba(0,0,0,0.5)",
            padding: "0.75rem",
            display: "flex",
            flexDirection: "column",
            gap: "0.6rem",
          }}
        >
          {/* Popover Header */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              borderBottom: "1px solid var(--border, #334155)",
              paddingBottom: "0.5rem",
            }}
          >
            <div style={{ fontWeight: 600, fontSize: "0.85rem", color: "var(--text, #f1f5f9)" }}>
              Select a picture to insert
            </div>
            <button
              type="button"
              className="btn ghost small"
              onClick={() => void loadLibrary()}
              title="Refresh pictures from server"
              style={{ fontSize: "0.75rem", padding: "0.2rem 0.4rem" }}
            >
              ↻ Refresh
            </button>
          </div>

          {/* Search Box */}
          <div>
            <input
              ref={searchInputRef}
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by caption or filename…"
              style={{
                width: "100%",
                padding: "0.45rem 0.6rem",
                fontSize: "0.8rem",
                borderRadius: "6px",
                border: "1px solid var(--border, #334155)",
                background: "color-mix(in srgb, var(--panel, #0f172a) 80%, black)",
                color: "var(--text, #f1f5f9)",
                outline: "none",
              }}
            />
          </div>

          {/* Group Filter Chips */}
          {groups.length > 1 && (
            <div
              style={{
                display: "flex",
                gap: "0.3rem",
                overflowX: "auto",
                paddingBottom: "0.2rem",
              }}
            >
              <button
                type="button"
                onClick={() => setSelectedGroupId("all")}
                style={{
                  fontSize: "0.75rem",
                  padding: "0.2rem 0.5rem",
                  borderRadius: "999px",
                  border: "1px solid var(--border, #334155)",
                  background:
                    selectedGroupId === "all" ? "var(--accent, #0284c7)" : "transparent",
                  color: selectedGroupId === "all" ? "#fff" : "var(--muted, #94a3b8)",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                All ({totalImageCount})
              </button>
              {groups.map((g) => {
                const isSelected = selectedGroupId === g.id;
                const count = g.images?.length || 0;
                return (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => setSelectedGroupId(g.id)}
                    style={{
                      fontSize: "0.75rem",
                      padding: "0.2rem 0.5rem",
                      borderRadius: "999px",
                      border: "1px solid var(--border, #334155)",
                      background: isSelected ? "var(--accent, #0284c7)" : "transparent",
                      color: isSelected ? "#fff" : "var(--muted, #94a3b8)",
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {g.name} ({count})
                  </button>
                );
              })}
            </div>
          )}

          {/* Pictures List / Grid */}
          <div
            style={{
              maxHeight: "260px",
              overflowY: "auto",
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(115px, 1fr))",
              gap: "0.5rem",
              padding: "0.25rem 0",
            }}
          >
            {loading ? (
              <div
                style={{
                  gridColumn: "1 / -1",
                  textAlign: "center",
                  padding: "1.5rem",
                  color: "var(--muted, #94a3b8)",
                  fontSize: "0.8rem",
                }}
              >
                Loading pictures…
              </div>
            ) : filtered.length === 0 ? (
              <div
                style={{
                  gridColumn: "1 / -1",
                  textAlign: "center",
                  padding: "1.5rem",
                  color: "var(--muted, #94a3b8)",
                  fontSize: "0.8rem",
                }}
              >
                {totalImageCount === 0 ? (
                  <div>
                    <p style={{ margin: "0 0 0.3rem" }}>No pictures in library yet.</p>
                    <p style={{ margin: 0, fontSize: "0.75rem", opacity: 0.8 }}>
                      Upload images in Sales Agent → Email templates → Picture library.
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
                  <button
                    key={image.id}
                    type="button"
                    onClick={(e) => handleSelectImage(e, image)}
                    title={`Click to insert into email: ${image.caption || image.filename}`}
                    style={{
                      border: isJustInserted
                        ? "2px solid #10b981"
                        : "1px solid var(--border, #334155)",
                      borderRadius: "6px",
                      background: isJustInserted
                        ? "rgba(16, 185, 129, 0.15)"
                        : "color-mix(in srgb, var(--panel, #0f172a) 85%, black)",
                      padding: "0.3rem",
                      cursor: "pointer",
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      gap: "0.25rem",
                      textAlign: "center",
                      transition: "transform 0.1s, border-color 0.1s",
                    }}
                  >
                    <div
                      style={{
                        width: "100%",
                        aspectRatio: "4/3",
                        background: "#000",
                        borderRadius: "4px",
                        overflow: "hidden",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <img
                        src={image.url}
                        alt={image.caption || image.filename}
                        loading="lazy"
                        style={{
                          width: "100%",
                          height: "100%",
                          objectFit: "contain",
                        }}
                      />
                    </div>
                    <div
                      style={{
                        fontSize: "0.7rem",
                        color: "var(--text, #f1f5f9)",
                        lineHeight: 1.2,
                        width: "100%",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {image.caption || image.filename}
                    </div>
                    <div
                      style={{
                        fontSize: "0.65rem",
                        color: "var(--muted, #94a3b8)",
                        display: "flex",
                        justifyContent: "space-between",
                        width: "100%",
                        padding: "0 0.1rem",
                      }}
                    >
                      <span
                        style={{
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          maxWidth: "60px",
                        }}
                      >
                        {groupName}
                      </span>
                      <span>{formatSize(image.size)}</span>
                    </div>
                    {isJustInserted && (
                      <span
                        style={{
                          fontSize: "0.65rem",
                          color: "#10b981",
                          fontWeight: 600,
                        }}
                      >
                        ✓ Inserted
                      </span>
                    )}
                  </button>
                );
              })
            )}
          </div>

          {/* Footer Guide Note */}
          <div
            style={{
              borderTop: "1px solid var(--border, #334155)",
              paddingTop: "0.5rem",
              fontSize: "0.72rem",
              color: "var(--muted, #94a3b8)",
              textAlign: "center",
            }}
          >
            Manage groups &amp; upload images in{" "}
            <strong style={{ color: "var(--text, #f1f5f9)" }}>
              Sales Agent → Email templates → Picture library
            </strong>
          </div>
        </div>
      )}
    </div>
  );
}
