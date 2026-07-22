"use client";

import { createContext, useCallback, useContext, useState } from "react";
import { cn } from "@/lib/cn";

type ToastType = "success" | "error" | "info";
interface Toast {
  id: number;
  type: ToastType;
  message: string;
}

const ToastContext = createContext<{ push: (t: { type: ToastType; message: string }) => void } | null>(
  null,
);

let seq = 0;

const ICON_TONES: Record<ToastType, string> = {
  success: "bg-success/10 text-success",
  error: "bg-danger/10 text-danger",
  info: "bg-primary-600/10 text-primary-700",
};

const ICON_PATHS: Record<ToastType, string> = {
  success: "M20 6L9 17l-5-5",
  error: "M12 8v5M12 16.5v.5M10.3 3.9L2.5 17.5A2 2 0 004.2 20.5h15.6a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z",
  info: "M12 16v-5M12 8v.5M12 21a9 9 0 100-18 9 9 0 000 18z",
};

function ToastIcon({ type }: { type: ToastType }) {
  return (
    <span
      className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-full", ICON_TONES[type])}
      aria-hidden
    >
      <svg
        viewBox="0 0 24 24"
        className="h-4 w-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={ICON_PATHS[type]} />
      </svg>
    </span>
  );
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((t: { type: ToastType; message: string }) => {
    const id = ++seq;
    setToasts((list) => [...list, { ...t, id }]);
    setTimeout(() => setToasts((list) => list.filter((x) => x.id !== id)), 4000);
  }, []);

  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      {/* Above the 4.5rem tab bar; the wrapper never swallows taps meant for the page. */}
      <div
        className="pointer-events-none fixed inset-x-0 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-[60] flex flex-col items-center gap-2 px-4"
        aria-live="polite"
        aria-atomic="false"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.type === "error" ? "alert" : "status"}
            className="glass pointer-events-auto flex w-full max-w-sm animate-reveal-up items-center gap-3 rounded-pill py-2.5 pl-2.5 pr-4 shadow-glass"
          >
            <ToastIcon type={t.type} />
            <p className="text-sm font-medium leading-snug text-ink-900">{t.message}</p>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): { push: (t: { type: ToastType; message: string }) => void } {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within <ToastProvider>");
  return ctx;
}
