import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

const MARGIN = 8;
const DEFAULT_WIDTH = 352;

export interface DraggableFloatProps {
  children: ReactNode;
  /** Persist position across calls in this browser tab. */
  storageKey?: string;
  className?: string;
  /** Card width used for clamping (approx). */
  widthPx?: number;
}

function loadPosition(storageKey: string | undefined): { x: number; y: number } | null {
  if (!storageKey || typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { x?: unknown; y?: unknown };
    if (typeof parsed.x === "number" && typeof parsed.y === "number") {
      return { x: parsed.x, y: parsed.y };
    }
  } catch {
    /* ignore */
  }
  return null;
}

function defaultBottomRight(widthPx: number): { x: number; y: number } {
  if (typeof window === "undefined") return { x: MARGIN, y: MARGIN };
  return {
    x: Math.max(MARGIN, window.innerWidth - widthPx - 16),
    y: Math.max(MARGIN, window.innerHeight - 420),
  };
}

function clampPosition(
  x: number,
  y: number,
  widthPx: number,
  heightPx: number,
): { x: number; y: number } {
  const maxX = Math.max(MARGIN, window.innerWidth - widthPx - MARGIN);
  const maxY = Math.max(MARGIN, window.innerHeight - heightPx - MARGIN);
  return {
    x: Math.min(maxX, Math.max(MARGIN, x)),
    y: Math.min(maxY, Math.max(MARGIN, y)),
  };
}

/**
 * Fixed-position shell you can drag anywhere.
 * Drag from elements marked with `data-drag-handle`.
 */
export function DraggableFloat({
  children,
  storageKey,
  className = "",
  widthPx = DEFAULT_WIDTH,
}: DraggableFloatProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const posRef = useRef(loadPosition(storageKey) ?? defaultBottomRight(widthPx));
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);

  const [pos, setPos] = useState(posRef.current);
  const [dragging, setDragging] = useState(false);

  const persist = useCallback(
    (next: { x: number; y: number }) => {
      posRef.current = next;
      if (!storageKey) return;
      try {
        sessionStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        /* ignore */
      }
    },
    [storageKey],
  );

  const reclamp = useCallback(() => {
    const el = shellRef.current;
    const height = el?.offsetHeight ?? 320;
    setPos((prev) => {
      const next = clampPosition(prev.x, prev.y, widthPx, height);
      persist(next);
      return next;
    });
  }, [persist, widthPx]);

  useEffect(() => {
    window.addEventListener("resize", reclamp);
    return () => window.removeEventListener("resize", reclamp);
  }, [reclamp]);

  useEffect(() => {
    reclamp();
  }, [reclamp]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest("button, a, input, textarea, select, label")) return;
    if (!target?.closest("[data-drag-handle]")) return;

    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      origX: posRef.current.x,
      origY: posRef.current.y,
    };
    setDragging(true);
    shellRef.current?.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const el = shellRef.current;
    const height = el?.offsetHeight ?? 320;
    const next = clampPosition(
      drag.origX + (e.clientX - drag.startX),
      drag.origY + (e.clientY - drag.startY),
      widthPx,
      height,
    );
    posRef.current = next;
    setPos(next);
  };

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    persist(posRef.current);
    try {
      shellRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  return (
    <div
      ref={shellRef}
      className={`fixed z-[60] w-[min(100vw-2rem,22rem)] pointer-events-auto ${
        dragging ? "cursor-grabbing select-none" : ""
      } ${className}`.trim()}
      style={{ left: pos.x, top: pos.y, touchAction: "none" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {children}
    </div>
  );
}
