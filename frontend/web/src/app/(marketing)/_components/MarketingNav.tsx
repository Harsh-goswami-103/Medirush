"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { cn } from "@/lib/cn";
import { Wordmark } from "./primitives";

const LINKS = [
  { href: "#how-it-works", label: "How it works" },
  { href: "#why-us", label: "Why us" },
  { href: "#faq", label: "FAQ" },
];

/**
 * Sticky top nav. Transparent while it sits over the deep-teal hero, then
 * frosts to `.glass` once the page scrolls so link text keeps its contrast
 * against the light sections below.
 */
export function MarketingNav() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={cn(
        "fixed inset-x-0 top-0 z-50 transition-[background-color,box-shadow,backdrop-filter] duration-300",
        scrolled ? "glass shadow-glass" : "border-b border-transparent bg-transparent",
      )}
    >
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
        <Link
          href="/"
          className="press -m-1 flex items-center rounded-xl2 p-1"
          aria-label="MedRush — home"
        >
          <Wordmark tone={scrolled ? "ink" : "light"} />
        </Link>

        <nav aria-label="Primary" className="hidden items-center gap-1 md:flex">
          {LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className={cn(
                "inline-flex h-11 items-center rounded-pill px-3.5 text-sm font-medium transition-colors",
                scrolled
                  ? "text-ink-600 hover:bg-ink-900/5 hover:text-ink-900"
                  : "text-white/90 hover:bg-white/15 hover:text-white",
              )}
            >
              {link.label}
            </a>
          ))}
        </nav>

        <Link
          href="/shop"
          className={cn(
            "press inline-flex h-11 shrink-0 items-center justify-center rounded-pill px-5 text-sm font-semibold transition-colors",
            scrolled
              ? "bg-gradient-to-r from-primary-700 to-primary-800 text-white shadow-glow hover:to-primary-900"
              : "bg-white text-primary-700 shadow-[0_8px_24px_-8px_rgba(255,255,255,0.55)] hover:bg-primary-50",
          )}
        >
          Order now
        </Link>
      </div>
    </header>
  );
}
