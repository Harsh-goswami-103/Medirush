"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { Spinner } from "@/components/ui";
import { MarketingNav } from "./_components/MarketingNav";
import { Hero } from "./_components/Hero";
import { TrustBar } from "./_components/TrustBar";
import { HowItWorks } from "./_components/HowItWorks";
import { CategoryTiles } from "./_components/CategoryTiles";
import { WhyMedRush } from "./_components/WhyMedRush";
import { TrackingTeaser } from "./_components/TrackingTeaser";
import { Compliance } from "./_components/Compliance";
import { Faq } from "./_components/Faq";
import { FinalCta, SiteFooter } from "./_components/FinalCta";

/**
 * Public landing page. A signed-in customer never sees marketing — the session
 * check runs first and replaces the history entry with /shop, so Back from the
 * store does not bounce them through here again. While auth resolves we render
 * a neutral loader rather than flashing the hero.
 */
export default function LandingPage() {
  const router = useRouter();
  const { user, loading } = useAuth();

  useEffect(() => {
    if (!loading && user) router.replace("/shop");
  }, [loading, user, router]);

  if (loading || user) {
    return (
      <div
        className="flex min-h-dvh items-center justify-center bg-mesh"
        role="status"
        aria-live="polite"
      >
        <Spinner className="h-7 w-7 text-primary-600" />
        <span className="sr-only">Loading MedRush…</span>
      </div>
    );
  }

  return (
    <div className="bg-mesh">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-pill focus:bg-surface focus:px-5 focus:py-3 focus:text-sm focus:font-semibold focus:text-ink-900 focus:shadow-glass"
      >
        Skip to content
      </a>

      <MarketingNav />

      <main id="main">
        <Hero />
        <TrustBar />
        <HowItWorks />
        <CategoryTiles />
        <WhyMedRush />
        <TrackingTeaser />
        <Compliance />
        <Faq />
        <FinalCta />
      </main>

      <SiteFooter />
    </div>
  );
}
