"use client";

import Link from "next/link";
import { useStore } from "@/lib/store";
import { whatsappUrl } from "@/lib/env";
import { WhatsAppIcon } from "@/components/ui";
import { Container, Eyebrow, Wordmark } from "./primitives";
import { IconArrowRight, IconPhone } from "./icons";

const FOOTER_LINK =
  "inline-flex min-h-[2.75rem] items-center gap-2 text-sm text-white/70 transition-colors hover:text-white";

export function FinalCta() {
  const support = whatsappUrl("Hi MedRush — I have a question about ordering.");

  return (
    <section aria-labelledby="final-cta-title" className="pb-20 pt-4 sm:pb-24">
      <Container>
        <div className="glass relative isolate overflow-hidden rounded-sheet2 px-6 py-14 text-center shadow-glass sm:px-12 sm:py-20">
          <div
            aria-hidden
            className="absolute -top-24 left-1/2 h-64 w-[36rem] max-w-[140%] -translate-x-1/2 rounded-pill bg-primary-200/45 blur-3xl"
          />
          <div className="relative">
            <Eyebrow>Ready when you are</Eyebrow>
            <h2
              id="final-cta-title"
              className="mx-auto mt-4 max-w-2xl text-[1.8rem] font-bold leading-tight tracking-tight text-ink-900 sm:text-4xl"
            >
              Your medicines, forty minutes from now.
            </h2>
            <p className="mx-auto mt-4 max-w-lg text-base leading-7 text-ink-600">
              Browse the full catalogue, upload a prescription and track the rider to your door.
            </p>
            <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link
                href="/shop"
                className="press inline-flex h-14 w-full items-center justify-center gap-2 rounded-pill bg-gradient-to-r from-primary-700 to-primary-800 px-8 text-base font-semibold text-white shadow-glow transition-colors hover:to-primary-900 sm:w-auto"
              >
                Start shopping
                <IconArrowRight className="h-5 w-5" />
              </Link>
              <Link
                href="/login"
                className="press inline-flex h-14 w-full items-center justify-center rounded-pill border border-line bg-surface px-8 text-base font-semibold text-ink-900 transition-colors hover:bg-surface-2 sm:w-auto"
              >
                Sign in
              </Link>
            </div>
            {support && (
              <a
                href={support}
                target="_blank"
                rel="noreferrer noopener"
                className="press mt-6 inline-flex min-h-[2.75rem] items-center gap-2 text-sm font-semibold text-primary-700 hover:text-primary-800"
              >
                <WhatsAppIcon />
                Message us on WhatsApp
              </a>
            )}
          </div>
        </div>
      </Container>
    </section>
  );
}

export function SiteFooter() {
  const { store } = useStore();
  const support = whatsappUrl("Hi MedRush — I need help with an order.");

  return (
    <footer className="bg-ink-900 py-14 text-white/70">
      <Container>
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
          <div className="lg:col-span-2">
            <Wordmark tone="light" />
            <p className="mt-4 max-w-sm text-sm leading-6 text-white/70">
              A licensed neighbourhood pharmacy, delivered. Prescription medicines are dispensed
              only against a valid prescription, reviewed by our registered pharmacist.
            </p>
            {store?.address && (
              <address className="mt-4 max-w-sm text-sm not-italic leading-6 text-white/55">
                {store.address}
              </address>
            )}
          </div>

          <nav aria-label="Shop">
            <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-white/50">Shop</h2>
            <ul className="mt-2">
              <li>
                <Link href="/shop" className={FOOTER_LINK}>
                  All medicines
                </Link>
              </li>
              <li>
                <Link href="/offers" className={FOOTER_LINK}>
                  Offers &amp; coupons
                </Link>
              </li>
              <li>
                <Link href="/orders" className={FOOTER_LINK}>
                  Track an order
                </Link>
              </li>
            </ul>
          </nav>

          <nav aria-label="Legal and support">
            <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-white/50">
              Legal &amp; support
            </h2>
            <ul className="mt-2">
              <li>
                <Link href="/privacy" className={FOOTER_LINK}>
                  Privacy policy
                </Link>
              </li>
              <li>
                <Link href="/terms" className={FOOTER_LINK}>
                  Terms of service
                </Link>
              </li>
              <li>
                <Link href="/legal" className={FOOTER_LINK}>
                  Licensing &amp; compliance
                </Link>
              </li>
              {support && (
                <li>
                  <a href={support} target="_blank" rel="noreferrer noopener" className={FOOTER_LINK}>
                    <WhatsAppIcon />
                    WhatsApp support
                  </a>
                </li>
              )}
              {store?.supportPhone && (
                <li>
                  <a href={`tel:${store.supportPhone}`} className={FOOTER_LINK}>
                    <IconPhone className="h-4 w-4" />
                    {store.supportPhone}
                  </a>
                </li>
              )}
            </ul>
          </nav>
        </div>

        <div className="mt-12 flex flex-col gap-2 border-t border-white/10 pt-6 text-xs text-white/50 sm:flex-row sm:items-center sm:justify-between">
          <p>© {new Date().getFullYear()} MedRush. All rights reserved.</p>
          {store?.drugLicenseNo && <p className="tabular-nums">Drug licence {store.drugLicenseNo}</p>}
        </div>
      </Container>
    </footer>
  );
}
