import { BulkCallQueuePanel } from "./BulkCallQueuePanel";
import { useCallQueueOptional } from "../hooks/useCallQueue";

/**
 * App-level host so the bulk queue survives Calls / Leads table remounts.
 */
export function BulkCallQueueHost({ onError }: { onError?: (message: string) => void }) {
  const queue = useCallQueueOptional();
  if (!queue || queue.status === "idle") return null;

  const remaining = Math.max(0, queue.queue.length - queue.currentIndex - 1);
  const statusLabel =
    queue.status === "paused"
      ? "paused"
      : queue.status === "between"
        ? "remarks"
        : queue.status === "running"
          ? "calling"
          : queue.status;

  if (queue.panelHidden) {
    return (
      <div className="fixed bottom-4 right-4 z-[55] pointer-events-auto">
        <button
          type="button"
          onClick={() => queue.showPanel()}
          className="rounded-full border border-sky-600/50 bg-slate-900 px-4 py-2 text-sm text-sky-100 shadow-xl hover:bg-slate-800"
        >
          Bulk call {statusLabel} · {remaining} left · Resume panel
        </button>
      </div>
    );
  }

  if (queue.panelMinimized) {
    return (
      <div className="fixed bottom-4 right-4 z-[55] pointer-events-auto">
        <button
          type="button"
          onClick={() => queue.toggleMinimize()}
          className="rounded-full border border-sky-600/50 bg-slate-900 px-4 py-2 text-sm text-sky-100 shadow-xl hover:bg-slate-800"
        >
          Bulk call {statusLabel} · {remaining} left · Expand
        </button>
      </div>
    );
  }

  return (
    <div className="fixed top-16 left-3 right-3 md:left-auto md:right-4 md:w-[min(100vw-2rem,44rem)] z-[55] pointer-events-auto max-h-[min(70vh,36rem)] overflow-y-auto shadow-2xl">
      <BulkCallQueuePanel queue={queue} onClose={() => queue.hidePanel()} onError={onError} />
    </div>
  );
}
