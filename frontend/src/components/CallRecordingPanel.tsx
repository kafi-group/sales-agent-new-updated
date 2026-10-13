import { useCallback, useEffect, useRef, useState } from "react";
import { client, type CallHistoryItem } from "../api/client";

interface CallRecordingPanelProps {
  call: CallHistoryItem;
  onUpdated?: (call: CallHistoryItem) => void;
  onError: (message: string) => void;
  compact?: boolean;
}

function transcriptStatusLabel(status: string | null | undefined): string {
  switch (status) {
    case "ready":
      return "Closed captions ready";
    case "processing":
    case "pending":
      return "Generating closed captions…";
    case "failed":
      return "Caption generation failed";
    default:
      return "No captions yet";
  }
}

function isTranscriptInProgress(status: string | null | undefined): boolean {
  return status === "processing" || status === "pending";
}

export function CallRecordingPanel({
  call,
  onUpdated,
  onError,
  compact = false,
}: CallRecordingPanelProps) {
  const [showCaptions, setShowCaptions] = useState(Boolean(call.transcript));
  const [transcribing, setTranscribing] = useState(false);
  const [polling, setPolling] = useState(false);
  const [audioSrc, setAudioSrc] = useState<string | null>(null);
  const [audioLoading, setAudioLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const kickoffRef = useRef(false);

  const refreshCall = useCallback(async () => {
    const updated = await client.getCallHistoryItem(call.id);
    onUpdated?.(updated);
    if (updated.transcript) setShowCaptions(true);
    return updated;
  }, [call.id, onUpdated]);

  useEffect(() => {
    if (!call.recording_available) {
      setAudioSrc((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      return;
    }

    let cancelled = false;
    let objectUrl: string | null = null;
    setAudioLoading(true);

    void client
      .fetchCallRecordingBlob(call.id, false)
      .then(({ blob }) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setAudioSrc((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return objectUrl;
        });
      })
      .catch((e) => {
        if (!cancelled) {
          onError(e instanceof Error ? e.message : "Failed to load recording");
        }
      })
      .finally(() => {
        if (!cancelled) setAudioLoading(false);
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [call.id, call.recording_available, onError]);

  // Auto-start background transcription when recording is ready but CC not started.
  useEffect(() => {
    if (!call.recording_available) return;
    if (call.transcript_status !== "pending") return;
    if (kickoffRef.current) return;
    kickoffRef.current = true;
    void client
      .transcribeCall(call.id, false)
      .then((updated) => onUpdated?.(updated))
      .catch(() => {
        kickoffRef.current = false;
      });
  }, [call.id, call.recording_available, call.transcript_status, onUpdated]);

  useEffect(() => {
    if (!call.recording_available) return;
    if (!isTranscriptInProgress(call.transcript_status)) {
      setPolling(false);
      return;
    }

    setPolling(true);
    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;
      void refreshCall()
        .then((updated) => {
          if (
            updated.transcript_status === "ready" ||
            updated.transcript_status === "failed"
          ) {
            window.clearInterval(timer);
            setPolling(false);
            if (updated.transcript_status === "failed" && updated.transcript_error) {
              onError(updated.transcript_error);
            }
          } else if (attempts >= 90) {
            window.clearInterval(timer);
            setPolling(false);
            onError(
              "Closed captions are taking longer than expected. Click Regenerate CC or refresh the page.",
            );
          }
        })
        .catch(() => {
          /* ignore transient poll errors */
        });
    }, 2000);

    return () => {
      window.clearInterval(timer);
      setPolling(false);
    };
  }, [call.id, call.recording_available, call.transcript_status, onError, refreshCall]);

  async function generateCaptions() {
    setTranscribing(true);
    try {
      const updated = await client.transcribeCall(call.id, false);
      onUpdated?.(updated);
      if (updated.transcript_status === "ready" && updated.transcript) {
        setShowCaptions(true);
        return;
      }
      if (updated.transcript_status === "failed" && updated.transcript_error) {
        onError(updated.transcript_error);
        return;
      }
      setPolling(true);
      await refreshCall();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to start closed captions");
    } finally {
      setTranscribing(false);
    }
  }

  async function downloadRecording() {
    setDownloading(true);
    try {
      const { blob, filename } = await client.fetchCallRecordingBlob(call.id, true);
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to download recording");
    } finally {
      setDownloading(false);
    }
  }

  const hasTranscript = Boolean((call.transcript || "").trim());

  if (!call.recording_available && !hasTranscript) {
    return (
      <div className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2">
        <p className="text-xs text-slate-500">
          Recording & closed captions appear here after the call ends (AI Sales Agent and
          manual calls).
        </p>
      </div>
    );
  }

  return (
    <div className={`space-y-3 ${compact ? "" : "pt-1"}`}>
      {call.recording_available ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <label className="text-xs text-slate-500">Call recording</label>
            {call.recording_duration_seconds ? (
              <span className="text-xs text-slate-500">
                {Math.floor(call.recording_duration_seconds / 60)}m{" "}
                {call.recording_duration_seconds % 60}s
              </span>
            ) : null}
          </div>
          {audioLoading && !audioSrc ? (
            <p className="text-xs text-slate-500">Loading recording…</p>
          ) : audioSrc ? (
            <audio controls preload="metadata" className="w-full h-10" src={audioSrc}>
              Your browser does not support audio playback.
            </audio>
          ) : (
            <p className="text-xs text-slate-500">Recording unavailable right now.</p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void downloadRecording()}
              disabled={downloading}
              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs text-slate-200 disabled:opacity-50"
            >
              {downloading ? "Downloading…" : "Download recording"}
            </button>
            <button
              type="button"
              onClick={() => setShowCaptions((open) => !open)}
              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs text-slate-200"
            >
              {showCaptions ? "Hide closed captions" : "Show closed captions (CC)"}
            </button>
            <button
              type="button"
              disabled={transcribing || polling}
              onClick={() => void generateCaptions()}
              className="px-3 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 border border-emerald-600/50 text-xs text-white disabled:opacity-50"
            >
              {transcribing || polling
                ? "Generating CC…"
                : call.transcript
                  ? "Regenerate CC"
                  : "Generate CC"}
            </button>
          </div>
          <p className="text-xs text-slate-500">
            {transcriptStatusLabel(call.transcript_status)}
            {polling ? " · Checking every few seconds…" : ""}
            {call.transcript_error ? ` — ${call.transcript_error}` : ""}
          </p>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2 items-center">
          <button
            type="button"
            onClick={() => setShowCaptions((open) => !open)}
            className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs text-slate-200"
          >
            {showCaptions ? "Hide closed captions" : "Show closed captions (CC)"}
          </button>
          <span className="text-xs text-slate-500">
            {transcriptStatusLabel(call.transcript_status)}
          </span>
        </div>
      )}

      {(showCaptions || (hasTranscript && !call.recording_available)) && (
        <div className="rounded-lg border border-slate-700 bg-slate-950 p-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-xs font-medium uppercase tracking-wide text-slate-400">
              Closed captions
            </h4>
            {call.transcript && (
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(call.transcript ?? "");
                }}
                className="text-xs text-sky-400 hover:text-sky-300"
              >
                Copy
              </button>
            )}
          </div>
          {call.transcript ? (
            <pre className="whitespace-pre-wrap text-sm text-slate-200 font-sans leading-relaxed max-h-64 overflow-y-auto">
              {call.transcript}
            </pre>
          ) : (
            <p className="text-sm text-slate-500">
              {isTranscriptInProgress(call.transcript_status)
                ? "Closed captions are being generated from the recording…"
                : "No closed captions yet. Click Generate CC to create a full word-for-word transcript."}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
