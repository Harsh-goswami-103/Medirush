"use client";

import Link from "next/link";
import { useStore } from "@/lib/store";
import { formatPaise } from "@/lib/format";
import { Container, Eyebrow } from "./primitives";
import { IconArrowRight, IconBolt, IconCheck, IconRider, IconShieldCheck } from "./icons";

/**
 * Hero. The mesh gradient is deliberately busy, so a fixed ink scrim sits
 * between it and every piece of copy — white-on-scrim stays above 6:1 even at
 * the gradient's lightest sweep (§20.6 / WCAG 1.4.3).
 */
export function Hero() {
  const { store } = useStore();

  // Only claim what the live store config actually says — no placeholder
  // promises while /v1/store is still in flight or unreachable.
  const liveChips: string[] = [];
  if (store) {
    if (store.featureFlags.codEnabled) liveChips.push("Cash on delivery");
    liveChips.push(`Free delivery over ${formatPaise(store.freeDeliveryAbovePaise)}`);
  }

  return (
    <section className="relative isolate overflow-hidden bg-mesh-hero bg-mesh-animated">
      <div
        aria-hidden
        className="absolute inset-0 bg-gradient-to-b from-ink-900/55 via-ink-900/35 to-ink-900/60"
      />

      <Container className="relative grid gap-12 pb-24 pt-28 sm:pb-28 sm:pt-32 lg:grid-cols-[1.05fr_1fr] lg:items-center lg:gap-16 lg:pb-36 lg:pt-40">
        <div>
          <Eyebrow tone="light">
            <IconBolt className="h-3.5 w-3.5" />
            40-minute delivery
          </Eyebrow>

          <h1 className="mt-5 text-[2.15rem] font-bold leading-[1.08] tracking-tight text-white sm:text-5xl lg:text-[3.4rem]">
            Medicines at your door in 40&nbsp;minutes.
          </h1>

          <p className="mt-5 max-w-xl text-base leading-7 text-white/85 sm:text-lg sm:leading-8">
            Order prescription and everyday medicines from a licensed neighbourhood pharmacy. A
            registered pharmacist checks every prescription, and you follow your rider live all the
            way to your door.
          </p>

          <div className="mt-9 flex flex-col gap-3 sm:flex-row sm:items-center">
            <Link
              href="/shop"
              className="press inline-flex h-14 items-center justify-center gap-2 rounded-pill bg-white px-8 text-base font-semibold text-primary-700 shadow-[0_14px_40px_-10px_rgba(255,255,255,0.5)] transition-colors hover:bg-primary-50"
            >
              Start shopping
              <IconArrowRight className="h-5 w-5" />
            </Link>
            <a
              href="#how-it-works"
              className="press glass-dark inline-flex h-14 items-center justify-center rounded-pill px-8 text-base font-semibold text-white transition-colors hover:bg-white/15"
            >
              How it works
            </a>
          </div>

          <ul className="mt-9 flex flex-wrap gap-2">
            {["Licensed pharmacy", "Pharmacist-verified Rx", ...liveChips].map((chip) => (
              <li
                key={chip}
                className="glass-dark inline-flex items-center gap-1.5 rounded-pill px-3.5 py-2 text-xs font-medium text-white"
              >
                <IconCheck className="h-3.5 w-3.5 text-primary-200" />
                {chip}
              </li>
            ))}
          </ul>
        </div>

        <MockOrderStack />
      </Container>
    </section>
  );
}

/**
 * Illustrative order card + ETA badge. This is decorative artwork, not data —
 * hidden from assistive tech so a screen reader never announces a made-up
 * order as if it were the visitor's own.
 */
function MockOrderStack() {
  return (
    <div aria-hidden className="relative mx-auto w-full max-w-[23rem] lg:max-w-[26rem]">
      <div
        className="glass-dark mb-4 ml-auto flex w-fit animate-float items-center gap-2 rounded-pill px-4 py-2 text-xs font-semibold text-white"
        style={{ animationDelay: "2.4s" }}
      >
        <IconShieldCheck className="h-4 w-4 text-primary-200" />
        Pharmacist verified
      </div>

      <div className="glass-dark animate-float rounded-sheet2 p-5 text-white shadow-glass sm:p-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[11px] uppercase tracking-[0.16em] text-white/65">Order</p>
            <p className="text-lg font-semibold">#MR-2418</p>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-pill bg-primary-500/25 px-3 py-1.5 text-xs font-semibold text-primary-100">
            <span className="h-1.5 w-1.5 rounded-pill bg-primary-200" />
            Out for delivery
          </span>
        </div>

        <ol className="mt-6 space-y-4">
          {[
            { label: "Order confirmed", meta: "9:04 PM", done: true },
            { label: "Pharmacist verified Rx", meta: "9:09 PM", done: true },
            { label: "Rider on the way", meta: "arriving soon", done: false },
          ].map((step) => (
            <li key={step.label} className="flex items-center gap-3">
              <span
                className={
                  step.done
                    ? "grid h-7 w-7 shrink-0 place-items-center rounded-pill bg-primary-500 text-white"
                    : "grid h-7 w-7 shrink-0 place-items-center rounded-pill border-2 border-primary-200/70 text-primary-100"
                }
              >
                {step.done ? (
                  <IconCheck className="h-3.5 w-3.5" />
                ) : (
                  <span className="h-2 w-2 rounded-pill bg-primary-200" />
                )}
              </span>
              <span className="flex-1 text-sm font-medium">{step.label}</span>
              <span className="text-xs text-white/60">{step.meta}</span>
            </li>
          ))}
        </ol>

        <div className="mt-6 flex items-center gap-3 border-t border-white/15 pt-4">
          <span className="grid h-10 w-10 place-items-center rounded-pill bg-white/15 text-sm font-semibold">
            RS
          </span>
          <div className="flex-1">
            <p className="text-sm font-semibold">Ravi S.</p>
            <p className="text-xs text-white/65">1.8 km away · on the way</p>
          </div>
          <IconRider className="h-6 w-6 text-primary-200" />
        </div>
      </div>

      <div
        className="glass-dark -mt-7 ml-1 w-fit animate-float rounded-xl2 px-5 py-4 text-white shadow-glass lg:-ml-10"
        style={{ animationDelay: "1.2s" }}
      >
        <div className="flex items-baseline gap-1.5">
          <span className="text-3xl font-bold leading-none">~40</span>
          <span className="text-sm font-semibold text-primary-100">min</span>
        </div>
        <p className="mt-1 text-[11px] uppercase tracking-[0.14em] text-white/70">Estimated arrival</p>
      </div>
    </div>
  );
}
