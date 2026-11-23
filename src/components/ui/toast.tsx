"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";

/**
 * App-wide notifications, so no action ever looks like it did nothing.
 *
 * Rendered by <ToastProvider> in the root layout and pushed from anywhere with
 * `useToast()`. Mutations call it inside the query hooks themselves, so every
 * screen gets the same feedback without repeating the wiring at the call site.
 */

export type ToastTone = "success" | "error" | "warn" | "info";

export interface ToastInput {
  title: string;
  description?: string | null;
  tone?: ToastTone;
  /** Auto-dismiss delay. Errors stay longer (default 4.5s / 9s). */
  durationMs?: number;
  action?: { label: string; onClick: () => void };
}

interface ToastItem {
  id: number;
  title: string;
  description: string | null;
  tone: ToastTone;
  durationMs: number;
  action?: { label: string; onClick: () => void };
}

interface ToastApi {
  push: (input: ToastInput) => number;
  dismiss: (id: number) => void;
  success: (title: string, description?: string | null) => number;
  error: (title: string, description?: string | null) => number;
  warn: (title: string, description?: string | null) => number;
  info: (title: string, description?: string | null) => number;
}

const ToastContext = createContext<ToastApi | null>(null);

const VISIBLE_MAX = 4;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const [paused, setPaused] = useState(false);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const push = useCallback(
    (input: ToastInput) => {
      const tone = input.tone ?? "info";
      const id = nextId.current++;
      const item: ToastItem = {
        id,
        title: input.title,
        description: input.description ?? null,
        tone,
        durationMs:
          input.durationMs ?? (tone === "error" ? 9_000 : tone === "warn" ? 7_000 : 4_500),
        action: input.action,
      };
      setItems((current) => [...current.slice(-(VISIBLE_MAX - 1)), item]);
      return id;
    },
    [],
  );

  const api = useMemo<ToastApi>(
    () => ({
      push,
      dismiss,
      success: (title, description) => push({ title, description, tone: "success" }),
      error: (title, description) => push({ title, description, tone: "error" }),
      warn: (title, description) => push({ title, description, tone: "warn" }),
      info: (title, description) => push({ title, description, tone: "info" }),
    }),
    [push, dismiss],
  );

  // One timer per toast; a paused viewport (hover / focus inside) holds them
  // open until the pointer leaves, so nothing disappears mid-read.
  useEffect(() => {
    if (paused) return;
    for (const item of items) {
      if (timers.current.has(item.id)) continue;
      const timer = setTimeout(() => dismiss(item.id), item.durationMs);
      timers.current.set(item.id, timer);
    }
  }, [items, paused, dismiss]);

  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const timer of map.values()) clearTimeout(timer);
      map.clear();
    };
  }, []);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        role="region"
        aria-label="Notifications"
        className="pointer-events-none fixed inset-x-3 bottom-3 z-[70] flex flex-col items-stretch gap-2 sm:inset-x-auto sm:right-4 sm:bottom-4 sm:w-[380px]"
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
        onFocusCapture={() => setPaused(true)}
        onBlurCapture={() => setPaused(false)}
      >
        {items.map((item) => (
          <Toast key={item.id} item={item} onDismiss={() => dismiss(item.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

const TONE: Record<ToastTone, { ring: string; chip: string; icon: string; label: string }> = {
  success: { ring: "border-brand/45", chip: "bg-brand/15 text-brand", icon: "✓", label: "Done" },
  error: { ring: "border-danger/50", chip: "bg-danger/15 text-danger", icon: "!", label: "Failed" },
  warn: { ring: "border-warn/50", chip: "bg-warn/15 text-warn", icon: "▲", label: "Heads up" },
  info: { ring: "border-line", chip: "bg-surface-2 text-muted", icon: "i", label: "Info" },
};

function Toast({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const tone = TONE[item.tone];

  return (
    <div
      role={item.tone === "error" ? "alert" : "status"}
      aria-live={item.tone === "error" ? "assertive" : "polite"}
      className={cn(
        "pointer-events-auto animate-toast-in rounded-xl border bg-surface/95 p-3 shadow-2xl backdrop-blur",
        tone.ring,
      )}
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className={cn("mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-bold", tone.chip)}
        >
          {tone.icon}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium leading-snug text-ink">{item.title}</p>
          {item.description ? (
            <p className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-muted">
              {item.description}
            </p>
          ) : null}
          {item.action ? (
            <button
              type="button"
              onClick={() => {
                item.action?.onClick();
                onDismiss();
              }}
              className="mt-2 text-xs font-medium text-brand underline-offset-2 hover:underline focus-ring"
            >
              {item.action.label}
            </button>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={`Dismiss: ${item.title}`}
          className="-m-1 rounded-md p-1 text-muted transition hover:bg-surface-2 hover:text-ink focus-ring"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used inside <ToastProvider> (see components/providers).");
  }
  return context;
}
