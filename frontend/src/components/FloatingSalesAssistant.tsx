import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  client,
  type SalesAssistantAction,
  type SalesAssistantHistoryMessage,
} from "../api/client";
import type { IndexAction } from "../data/indexSections";

const STORAGE_KEY = "kafi_sales_assistant_code";
export const OPEN_SALES_ASSISTANT_EVENT = "kafi:open-sales-assistant";
const PANEL_WIDTH = 520;
const PANEL_OFFSET = { left: 16, bottom: 24 };

type UiMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  loading?: boolean;
};

function msgId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

type Props = {
  onNavigate: (action: IndexAction) => void;
  onError: (message: string) => void;
};

export function FloatingSalesAssistant({ onNavigate, onError }: Props) {
  const [open, setOpen] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const [codeInput, setCodeInput] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [llmEnabled, setLlmEnabled] = useState<boolean | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    setUnlocked(Boolean(sessionStorage.getItem(STORAGE_KEY)));
  }, []);

  useEffect(() => {
    void client
      .getSalesAssistantStatus()
      .then((s) => setLlmEnabled(s.enabled))
      .catch(() => setLlmEnabled(false));
  }, []);

  useEffect(() => {
    const openPanel = () => setOpen(true);
    window.addEventListener(OPEN_SALES_ASSISTANT_EVENT, openPanel);
    return () => window.removeEventListener(OPEN_SALES_ASSISTANT_EVENT, openPanel);
  }, []);

  useEffect(() => {
    if (!open) return;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, open]);

  useEffect(() => {
    if (open && unlocked) {
      window.setTimeout(() => inputRef.current?.focus(), 80);
    }
  }, [open, unlocked]);

  const tryUnlock = useCallback(async () => {
    const code = codeInput.trim();
    if (!code) return;
    setUnlocking(true);
    setUnlockError(null);
    try {
      await client.unlockSalesAssistant(code);
      sessionStorage.setItem(STORAGE_KEY, code);
      setUnlocked(true);
      setCodeInput("");
      setMessages([
        {
          id: msgId(),
          role: "assistant",
          content:
            "FAQ ready. Ask about calls, team activity, or say “open WhatsApp” / “go to inbox”.",
        },
      ]);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Invalid access code";
      setUnlockError(message);
      onError(message);
    } finally {
      setUnlocking(false);
    }
  }, [codeInput, onError]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || sending || !unlocked) return;
    const accessCode = sessionStorage.getItem(STORAGE_KEY) || "";
    if (!accessCode) return;

    const userMsg: UiMessage = { id: msgId(), role: "user", content: text };
    const thinking: UiMessage = { id: msgId(), role: "assistant", content: "", loading: true };
    setMessages((prev) => [...prev, userMsg, thinking]);
    setInput("");
    setSending(true);

    const history: SalesAssistantHistoryMessage[] = messages
      .filter((m) => !m.loading && m.content.trim())
      .slice(-12)
      .map((m) => ({ role: m.role, content: m.content }));

    try {
      const result = await client.sendSalesAssistantMessage({
        message: text,
        access_code: accessCode,
        history,
      });
      setMessages((prev) =>
        prev
          .filter((m) => m.id !== thinking.id)
          .concat({ id: msgId(), role: "assistant", content: result.reply }),
      );
      for (const action of result.actions as SalesAssistantAction[]) {
        if (action && typeof action === "object" && "type" in action) {
          onNavigate(action as IndexAction);
        }
      }
    } catch (e) {
      setMessages((prev) => prev.filter((m) => m.id !== thinking.id));
      onError(e instanceof Error ? e.message : "FAQ could not respond");
    } finally {
      setSending(false);
    }
  }, [input, sending, unlocked, messages, onNavigate, onError]);

  const panel = (
    <div
      className="fixed z-[90] flex flex-col rounded-2xl border border-violet-500/30 bg-slate-950/95 shadow-2xl shadow-violet-950/40 backdrop-blur-md"
      style={{
        left: PANEL_OFFSET.left,
        bottom: PANEL_OFFSET.bottom,
        width: PANEL_WIDTH,
        maxWidth: "calc(100vw - 32px)",
        maxHeight: "min(640px, calc(100dvh - 96px))",
      }}
    >
      <div className="flex items-center justify-between gap-2 border-b border-slate-800 px-3 py-2.5">
        <div>
          <p className="text-base font-semibold text-violet-200">FAQ (Management & Sales)</p>
          <p className="text-xs text-slate-500">Calls · activity · navigation</p>
        </div>
        <button
          type="button"
          className="rounded-lg px-2 py-1 text-xs text-slate-400 hover:bg-slate-800 hover:text-slate-200"
          onClick={() => setOpen(false)}
        >
          Close
        </button>
      </div>

      {!unlocked ? (
        <div className="flex flex-col gap-3 p-4">
          <p className="text-base text-slate-300">Enter access code to open the assistant.</p>
          {llmEnabled === false && (
            <p className="text-xs text-amber-400/90">
              AI replies need <code className="text-amber-200/90">SALES_ASSISTANT_GEMINI_API_KEY</code> on
              Railway — you can still unlock; chat works once the key is set.
            </p>
          )}
          {unlockError ? (
            <p className="text-xs text-red-300 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2">
              {unlockError}
            </p>
          ) : null}
          <input
            type="password"
            inputMode="numeric"
            value={codeInput}
            onChange={(e) => setCodeInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void tryUnlock();
            }}
            placeholder="Access code"
            className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2.5 text-base text-slate-100 outline-none focus:border-violet-500"
          />
          <button
            type="button"
            disabled={unlocking || !codeInput.trim()}
            onClick={() => void tryUnlock()}
            className="rounded-lg bg-violet-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {unlocking ? "Checking…" : "Unlock"}
          </button>
        </div>
      ) : (
        <>
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-[260px]">
            {messages.length === 0 && (
              <p className="text-base text-slate-500 leading-relaxed">
                Try: “How many calls today?”, “What did Usman do?”, “Open WhatsApp”.
              </p>
            )}
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[92%] rounded-xl px-4 py-2.5 text-base leading-relaxed whitespace-pre-wrap ${
                    msg.role === "user"
                      ? "bg-violet-700/80 text-white"
                      : "bg-slate-800 text-slate-100 border border-slate-700"
                  }`}
                >
                  {msg.loading ? (
                    <span className="text-slate-400 animate-pulse">Thinking…</span>
                  ) : (
                    msg.content
                  )}
                </div>
              </div>
            ))}
          </div>
          <div className="border-t border-slate-800 p-4 flex gap-2">
            <textarea
              ref={inputRef}
              rows={3}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void sendMessage();
                }
              }}
              placeholder="Ask or say where to go…"
              className="flex-1 resize-none rounded-lg border border-slate-700 bg-slate-900 px-3 py-2.5 text-base text-slate-100 outline-none focus:border-violet-500"
            />
            <button
              type="button"
              disabled={sending || !input.trim()}
              onClick={() => void sendMessage()}
              className="self-end rounded-lg bg-violet-600 px-4 py-2.5 text-base font-medium text-white disabled:opacity-50"
            >
              Send
            </button>
          </div>
        </>
      )}
    </div>
  );

  return createPortal(
    <>
      {open && panel}
    </>,
    document.body,
  );
}
