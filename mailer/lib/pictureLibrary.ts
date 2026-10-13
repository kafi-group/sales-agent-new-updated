/** Shared mailer picture library — groups of hosted images (Railway). */

import { ApiError, getApiBase, getStoredToken } from "./api";

export type PictureLibraryImage = {
  id: string;
  url: string;
  filename: string;
  content_type: string;
  size: number;
  /** Free-text label shown above the thumbnail (editable by any user). */
  caption?: string;
  uploaded_by?: string;
  created_at?: string;
};

export type PictureLibraryGroup = {
  id: string;
  name: string;
  created_at?: string;
  created_by?: string;
  images: PictureLibraryImage[];
};

export type PictureLibrary = {
  groups: PictureLibraryGroup[];
};

type AuthOpts = {
  /** Prefer the live AuthProvider token — localStorage can lag or be cleared. */
  token?: string | null;
};

async function authFetch<T>(
  path: string,
  init: RequestInit = {},
  opts: AuthOpts = {},
): Promise<T> {
  const base = getApiBase();
  if (!base) {
    throw new ApiError(
      500,
      "KAFI_API_BASE_URL / NEXT_PUBLIC_KAFI_API_BASE_URL is not set on the mailer.",
    );
  }
  const token = (opts.token || getStoredToken() || "").trim();
  if (!token) {
    throw new ApiError(401, "Not authenticated");
  }
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Bearer ${token}`);
  // Do not force JSON Content-Type — multipart uploads need the browser boundary.
  if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(`${base}${path.startsWith("/") ? path : `/${path}`}`, {
    ...init,
    headers,
    cache: "no-store",
  });

  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!res.ok) {
    const detail =
      data && typeof data === "object" && data !== null && "detail" in data
        ? String((data as { detail: unknown }).detail)
        : text || res.statusText;
    throw new ApiError(res.status, detail);
  }
  return data as T;
}

export async function fetchPictureLibrary(opts: AuthOpts = {}): Promise<PictureLibrary> {
  return authFetch<PictureLibrary>("/mailer/picture-library", {}, opts);
}

export async function createPictureGroup(
  name: string,
  opts: AuthOpts = {},
): Promise<PictureLibraryGroup> {
  const data = await authFetch<{ group: PictureLibraryGroup }>(
    "/mailer/picture-library/groups",
    { method: "POST", body: JSON.stringify({ name }) },
    opts,
  );
  return data.group;
}

export async function renamePictureGroup(
  groupId: string,
  name: string,
  opts: AuthOpts = {},
): Promise<PictureLibraryGroup> {
  const data = await authFetch<{ group: PictureLibraryGroup }>(
    `/mailer/picture-library/groups/${encodeURIComponent(groupId)}/rename`,
    { method: "POST", body: JSON.stringify({ name }) },
    opts,
  );
  return data.group;
}

export async function deletePictureGroup(
  groupId: string,
  opts: AuthOpts = {},
): Promise<void> {
  await authFetch(
    `/mailer/picture-library/groups/${encodeURIComponent(groupId)}/delete`,
    { method: "POST" },
    opts,
  );
}

export async function uploadPictureToGroup(
  groupId: string,
  file: File,
  opts: AuthOpts = {},
): Promise<PictureLibraryImage> {
  const form = new FormData();
  form.append("file", file);
  const data = await authFetch<{ image: PictureLibraryImage }>(
    `/mailer/picture-library/groups/${encodeURIComponent(groupId)}/images`,
    { method: "POST", body: form },
    opts,
  );
  return data.image;
}

export async function deletePictureFromGroup(
  groupId: string,
  mediaId: string,
  opts: AuthOpts = {},
): Promise<void> {
  await authFetch(
    `/mailer/picture-library/groups/${encodeURIComponent(groupId)}/images/${encodeURIComponent(mediaId)}/delete`,
    { method: "POST" },
    opts,
  );
}

export async function updatePictureCaption(
  groupId: string,
  mediaId: string,
  caption: string,
  opts: AuthOpts = {},
): Promise<PictureLibraryImage> {
  const data = await authFetch<{ image: PictureLibraryImage }>(
    `/mailer/picture-library/groups/${encodeURIComponent(groupId)}/images/${encodeURIComponent(mediaId)}/caption`,
    { method: "POST", body: JSON.stringify({ caption }) },
    opts,
  );
  return data.image;
}

/** Publish full library to the shared server (works in any browser / incognito). */
export async function savePictureLibrary(
  groups: PictureLibraryGroup[],
  opts: AuthOpts = {},
): Promise<PictureLibrary> {
  const data = await authFetch<{ ok: boolean; library: PictureLibrary }>(
    "/mailer/picture-library/save",
    {
      method: "POST",
      body: JSON.stringify({ groups }),
    },
    opts,
  );
  return data.library;
}
