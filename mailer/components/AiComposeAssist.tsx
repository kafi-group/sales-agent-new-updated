"use client";

import { useState } from "react";
import { getStoredToken, ApiError } from "@/lib/api";
import { emailBodyHasContent } from "@/components/EmailBodyEditor";

export type ComposeWriteMode = "free" | "ai";

type AiComposeAssistProps = {
  mode: ComposeWriteMode;
  onModeChange: (mode: ComposeWriteMode) => void;
  toHint?: string;
  contextHint?: string;
  subject: string;
  body: string;
  onDraft: (draft: { subject: string; body: string }) => void;
  onNotice?: (message: string | null) => void;
  onError?: (message: string | null) => void;
  /** Bulk send: mention placeholders in the AI prompt tip. */
  bulkPlaceholders?: boolean;
};

function plainTextToEditorHtml(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped
    .split(/\n{2,}/)
    .map((para) => `<p>${para.replace(/\n/g, "<br>")}</p>`)
    .join("");
}

export function AiComposeAssist({
  mode,
  onModeChange,
  toHint,
  contextHint,
  subject,
  body,
  onDraft,
  onNotice,
  onError,
  bulkPlaceholders = false,
}: AiComposeAssistProps) {
  const [prompt, setPrompt] = useState("");
  const [drafting, setDrafting] = useState(false);

  async function draftWithAi() {
    const cleaned = prompt.trim();
    if (cleaned.length < 8) {
      onError?.("Write a short prompt describing the email you want (at least a sentence).");
      return;
    }
    if (
      (subject.trim() || emailBodyHasContent(body)) &&
      !window.confirm("Replace the current subject and body with the AI draft?")
    ) {
      return;
    }

    setDrafting(true);
    onError?.(null);
    onNotice?.(null);
    try {
      const token = getStoredToken();
      const res = await fetch("/api/ai-draft", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          prompt: cleaned,
          to: toHint?.trim() || undefined,
          context: contextHint?.trim() || undefined,
        }),
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
      const result = data as { subject: string; body: string };
      onDraft({
        subject: result.subject,
        body: plainTextToEditorHtml(result.body),
      });
      onNotice?.("AI draft loaded — edit before send if needed");
    } catch (e) {
      onError?.(e instanceof Error ? e.message : "AI draft failed");
    } finally {
      setDrafting(false);
    }
  }

  return (
    <div className="compose-mode">
      <div className="compose-mode-toggle" role="group" aria-label="Compose mode">
        <button
          type="button"
          className={mode === "free" ? "active" : ""}
          onClick={() => onModeChange("free")}
        >
          Free text
        </button>
        <button
          type="button"
          className={mode === "ai" ? "active" : ""}
          onClick={() => onModeChange("ai")}
        >
          AI Suggestion
        </button>
      </div>

      {mode === "ai" ? (
        <div className="ai-draft-box">
          <label htmlFor="ai-compose-prompt">Describe the email</label>
          <textarea
            id="ai-compose-prompt"
            rows={3}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={
              bulkPlaceholders
                ? "e.g. Follow up on ESSENCE pink salt samples for UAE importers. Use {{contact_name}} and {{company_name}}."
                : "e.g. Draft a polite follow-up about basmati rice samples for a Dubai importer, ask for their preferred pack sizes."
            }
          />
          <p className="muted small">
            AI fills subject and body below. You can still edit everything before send.
            {bulkPlaceholders
              ? " For bulk, you can ask the AI to include {{company_name}} / {{contact_name}}."
              : null}
          </p>
          <button
            type="button"
            className="btn"
            disabled={drafting}
            onClick={() => void draftWithAi()}
          >
            {drafting ? "Drafting…" : "Draft with AI"}
          </button>
        </div>
      ) : (
        <p className="muted small compose-mode-hint">
          Write freely in the body, or load an email template above.
        </p>
      )}
    </div>
  );
}
