/** Browser-durable picture library — survives reloads until the user deletes. */

import type { PictureLibrary, PictureLibraryGroup } from "./pictureLibrary";

const STORAGE_KEY = "kafi.mailer.picture_library.v1";

/** Clear browser cache after a successful shared save (optional). */
export function clearLocalPictureLibrary(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export function loadLocalPictureLibrary(): PictureLibrary {
  if (typeof window === "undefined") return { groups: [] };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { groups: [] };
    const parsed = JSON.parse(raw) as Partial<PictureLibrary>;
    const groups = Array.isArray(parsed.groups) ? parsed.groups : [];
    return {
      groups: groups
        .filter((g): g is PictureLibraryGroup => Boolean(g && typeof g === "object" && g.id))
        .map((g) => ({
          id: String(g.id),
          name: String(g.name || g.id),
          created_at: g.created_at,
          created_by: g.created_by,
          images: Array.isArray(g.images)
            ? g.images.filter((img) => img && img.id && img.url)
            : [],
        })),
    };
  } catch {
    return { groups: [] };
  }
}

export function saveLocalPictureLibrary(library: PictureLibrary): void {
  if (typeof window === "undefined") return;
  const payload: PictureLibrary = {
    groups: (library.groups || []).map((g) => ({
      id: g.id,
      name: g.name,
      created_at: g.created_at,
      created_by: g.created_by,
      images: (g.images || []).map((img) => ({
        id: img.id,
        url: img.url,
        filename: img.filename,
        content_type: img.content_type,
        size: img.size,
        caption: img.caption || "",
        uploaded_by: img.uploaded_by,
        created_at: img.created_at,
      })),
    })),
  };
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

/** Prefer local saved groups; fill gaps from API so shared uploads still appear. */
export function mergePictureLibraries(
  local: PictureLibrary,
  remote: PictureLibrary | null | undefined,
): PictureLibrary {
  const byId = new Map<string, PictureLibraryGroup>();
  for (const g of remote?.groups || []) {
    byId.set(g.id, {
      ...g,
      images: [...(g.images || [])],
    });
  }
  for (const g of local.groups || []) {
    const existing = byId.get(g.id);
    if (!existing) {
      byId.set(g.id, { ...g, images: [...(g.images || [])] });
      continue;
    }
    const imgById = new Map(existing.images.map((i) => [i.id, i]));
    for (const img of g.images || []) {
      const prior = imgById.get(img.id);
      if (!prior) {
        imgById.set(img.id, img);
      } else {
        imgById.set(img.id, {
          ...prior,
          ...img,
          // Prefer non-empty caption from either side.
          caption: (img.caption || "").trim() || (prior.caption || "").trim() || "",
        });
      }
    }
    byId.set(g.id, {
      ...existing,
      name: g.name || existing.name,
      images: Array.from(imgById.values()),
    });
  }
  return { groups: Array.from(byId.values()) };
}

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Could not read image"));
    reader.readAsDataURL(file);
  });
}
