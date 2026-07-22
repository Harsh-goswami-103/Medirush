"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Scroll-reveal wrapper (§20.2 "respect prefers-reduced-motion").
 *
 * CSS-only motion driven by one IntersectionObserver per element — no
 * animation library, so the PWA bundle stays small. Reveals once and then
 * disconnects; if IntersectionObserver is unavailable (or the user prefers
 * reduced motion) the content is shown immediately rather than hidden, so
 * content can never be stranded invisible.
 */
export function Reveal({
  children,
  className,
  /** Stagger within a group, in ms. */
  delayMs = 0,
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  delayMs?: number;
  as?: "div" | "section" | "li" | "article";
}) {
  const ref = useRef<HTMLElement | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setShown(true);
      return;
    }
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setShown(true);
          io.disconnect();
        }
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.05 },
    );
    io.observe(node);
    return () => io.disconnect();
  }, []);

  return (
    <Tag
      ref={ref as never}
      className={cn("reveal", shown && "reveal-in", className)}
      style={delayMs ? { transitionDelay: `${delayMs}ms` } : undefined}
    >
      {children}
    </Tag>
  );
}

/**
 * Count-up number for hero/trust stats. Respects reduced motion by jumping
 * straight to the final value, and only animates once it scrolls into view.
 */
export function CountUp({
  to,
  durationMs = 1200,
  suffix = "",
  className,
}: {
  to: number;
  durationMs?: number;
  suffix?: string;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [value, setValue] = useState(0);

  useEffect(() => {
    const node = ref.current;
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (!node || reduce || typeof IntersectionObserver === "undefined") {
      setValue(to);
      return;
    }
    let raf = 0;
    const io = new IntersectionObserver((entries) => {
      if (!entries[0]?.isIntersecting) return;
      io.disconnect();
      const start = performance.now();
      const tick = (now: number) => {
        const t = Math.min(1, (now - start) / durationMs);
        // easeOutCubic — fast then settles, reads as "counting up".
        setValue(Math.round(to * (1 - Math.pow(1 - t, 3))));
        if (t < 1) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    });
    io.observe(node);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [to, durationMs]);

  return (
    <span ref={ref} className={className}>
      {value.toLocaleString("en-IN")}
      {suffix}
    </span>
  );
}
