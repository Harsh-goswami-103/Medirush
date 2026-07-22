"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** Centered modal dialog with a backdrop; closes on Escape or backdrop click. */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const [entered, setEntered] = useState(false);

  // Consumers pass an inline `onClose`; keeping it in a ref means the trap
  // effect runs once per open instead of re-focusing the panel on every render.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) {
      setEntered(false);
      return;
    }
    const opener = document.activeElement as HTMLElement | null;
    const raf = requestAnimationFrame(() => {
      setEntered(true);
      panelRef.current?.focus();
    });

    // Escape closes; Tab is trapped inside the panel so focus can never fall
    // behind the backdrop onto the inert page beneath it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (items.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      opener?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div
      className={cn(
        "fixed inset-0 z-50 flex items-center justify-center bg-ink-900/50 p-4 backdrop-blur-sm transition-opacity duration-200",
        entered ? "opacity-100" : "opacity-0",
      )}
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="w-full max-w-lg animate-reveal-up rounded-sheet2 border border-white/60 bg-surface/95 shadow-glass outline-none backdrop-blur-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-line/70 px-5 py-4">
          <h2 id={titleId} className="text-base font-semibold tracking-tight text-ink-900">
            {title}
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="press -mr-1.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-ink-400 transition-colors hover:bg-surface-2 hover:text-ink-900"
          >
            <svg
              viewBox="0 0 24 24"
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden
            >
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="max-h-[70vh] overflow-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="flex justify-end gap-2 border-t border-line/70 px-5 py-4">{footer}</div>
        )}
      </div>
    </div>
  );
}
