"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import type { ReferralReward, ReferralSummary } from "@medrush/contracts";
import { api, apiErrorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/cn";
import { formatPaise } from "@/lib/format";
import { TopBar } from "@/components/AppShell";
import { Badge, ErrorState, Skeleton, Spinner } from "@/components/ui";
import { CountUp, Reveal } from "@/components/motion";
import { useToast } from "@/components/toast";

function CopyIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className ?? "h-4 w-4"}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4a1 1 0 01-1-1V4a1 1 0 011-1h10a1 1 0 011 1v1" />
    </svg>
  );
}

function ShareIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className ?? "h-4 w-4"}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" />
    </svg>
  );
}

function GiftIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className ?? "h-4 w-4"}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M20 12v9H4v-9M2 7h20v5H2zM12 21V7M12 7H7.5a2.5 2.5 0 010-5C11 2 12 7 12 7zM12 7h4.5a2.5 2.5 0 000-5C13 2 12 7 12 7z" />
    </svg>
  );
}

/** Refer &amp; earn — GET /v1/referrals (code, funnel counts, earned coupons). */
export default function ReferralsPage() {
  const router = useRouter();
  const toast = useToast();
  const { user, loading } = useAuth();

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  const referralQuery = useQuery({
    queryKey: ["referrals"],
    queryFn: () => api.get<ReferralSummary>("/v1/referrals"),
    enabled: Boolean(user),
    staleTime: 60_000,
  });

  const [copied, setCopied] = useState<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, []);

  const copy = useCallback(
    async (value: string, label: string) => {
      try {
        if (!navigator.clipboard) throw new Error("clipboard unavailable");
        await navigator.clipboard.writeText(value);
        setCopied(label);
        if (copyTimer.current) clearTimeout(copyTimer.current);
        copyTimer.current = setTimeout(() => setCopied(null), 2500);
        toast.push({ type: "success", message: "Copied to clipboard" });
      } catch {
        toast.push({ type: "error", message: "Couldn't copy — long-press the code to select it" });
      }
    },
    [toast],
  );

  if (loading || !user) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-mesh">
        <Spinner className="h-6 w-6 text-primary-600" />
      </div>
    );
  }

  const summary = referralQuery.data?.data;

  async function share(s: ReferralSummary) {
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    const text = `I get my medicines delivered with MedRush — genuine, fast and tracked. Use my code ${s.code} for ${formatPaise(s.refereeRewardPaise)} off your first order.`;
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      try {
        await navigator.share({ title: "MedRush", text, url: origin });
        return;
      } catch (err) {
        // User dismissed the sheet — not an error worth surfacing.
        if (err instanceof Error && err.name === "AbortError") return;
      }
    }
    await copy(origin ? `${text} ${origin}` : text, "invite");
  }

  return (
    <div className="min-h-dvh bg-mesh">
      <TopBar title="Refer & earn" back />

      <div className="space-y-4 p-4">
        {referralQuery.isError ? (
          <ErrorState
            message={apiErrorMessage(referralQuery.error, "Could not load your referral code")}
            onRetry={() => void referralQuery.refetch()}
          />
        ) : !summary ? (
          <ReferralsSkeleton />
        ) : (
          <>
            <Reveal as="section">
              <div className="relative overflow-hidden rounded-sheet2 bg-mesh-hero bg-mesh-animated shadow-glass">
                {/* Scrim keeps white/mint copy ≥4.5:1 over the brightest teal in the mesh. */}
                <div className="absolute inset-0 bg-ink-900/40" aria-hidden />
                <div className="relative p-5">
                  <p className="text-xs font-semibold uppercase tracking-widest text-primary-100">
                    Refer &amp; earn
                  </p>
                  <h2 className="mt-1.5 text-2xl font-bold leading-tight text-white">
                    Give {formatPaise(summary.refereeRewardPaise)}, get{" "}
                    {formatPaise(summary.rewardPaise)}
                  </h2>
                  <p className="mt-1.5 text-sm text-primary-100">
                    Your friend saves on their first order. You earn a coupon the moment it lands.
                  </p>

                  <div className="glass-dark mt-4 rounded-xl2 px-4 py-3">
                    <p className="text-[11px] font-medium uppercase tracking-widest text-primary-100">
                      Your code
                    </p>
                    <p className="mt-0.5 break-all font-mono text-2xl font-bold tracking-[0.18em] text-white">
                      {summary.code}
                    </p>
                  </div>

                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => void copy(summary.code, "code")}
                      className="press inline-flex min-h-11 items-center justify-center gap-2 rounded-input border border-white/40 bg-white/10 px-3 text-sm font-semibold text-white"
                    >
                      <CopyIcon />
                      {copied === "code" ? "Copied" : "Copy code"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void share(summary)}
                      className="press inline-flex min-h-11 items-center justify-center gap-2 rounded-input bg-white px-3 text-sm font-semibold text-primary-800 shadow-card2"
                    >
                      <ShareIcon />
                      {copied === "invite" ? "Copied" : "Share invite"}
                    </button>
                  </div>
                  <p className="sr-only" aria-live="polite">
                    {copied ? "Copied to clipboard" : ""}
                  </p>
                </div>
              </div>
            </Reveal>

            <Reveal as="section" delayMs={60}>
              <ul className="grid grid-cols-3 gap-2">
                <StatTile label="Friends joined" value={<CountUp to={summary.signedUp} />} />
                <StatTile label="Rewards unlocked" value={<CountUp to={summary.rewarded} />} />
                <StatTile
                  label="Coupons earned"
                  value={formatPaise(summary.rewards.reduce((sum, r) => sum + r.valuePaise, 0))}
                />
              </ul>
            </Reveal>

            <Reveal as="section" delayMs={120}>
              <h2 className="mb-2 text-sm font-semibold text-ink-900">Your rewards</h2>
              {summary.rewards.length === 0 ? (
                <div className="rounded-xl2 border border-dashed border-line bg-surface/70 px-4 py-8 text-center">
                  <span className="mx-auto mb-2 flex h-11 w-11 items-center justify-center rounded-full bg-primary-50 text-primary-700">
                    <GiftIcon className="h-5 w-5" />
                  </span>
                  <p className="text-sm font-medium text-ink-900">No rewards yet</p>
                  <p className="mt-0.5 text-sm text-ink-600">
                    Share your code — the coupon lands here once your friend&apos;s first order is
                    delivered.
                  </p>
                </div>
              ) : (
                <ul className="space-y-3">
                  {summary.rewards.map((reward, i) => (
                    <Reveal as="li" key={reward.code} delayMs={(i % 6) * 60}>
                      <RewardCard
                        reward={reward}
                        copied={copied === reward.code}
                        onCopy={() => void copy(reward.code, reward.code)}
                      />
                    </Reveal>
                  ))}
                </ul>
              )}
            </Reveal>

            <Reveal as="section" delayMs={180}>
              <div className="glass rounded-xl2 p-4 shadow-glass">
                <h2 className="text-sm font-semibold text-ink-900">How it works</h2>
                <ol className="mt-3 space-y-3">
                  {[
                    {
                      title: "Share your code",
                      body: `Your friend gets ${formatPaise(summary.refereeRewardPaise)} off their first MedRush order.`,
                    },
                    {
                      title: "They order",
                      body: "The code applies at checkout and their medicines are delivered.",
                    },
                    {
                      title: "You get paid back",
                      body: `${formatPaise(summary.rewardPaise)} lands here as a coupon, ready for your next order.`,
                    },
                  ].map((step, i) => (
                    <li key={step.title} className="flex gap-3">
                      <span
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary-700 text-xs font-bold text-white"
                        aria-hidden
                      >
                        {i + 1}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-ink-900">{step.title}</span>
                        <span className="block text-sm text-ink-600">{step.body}</span>
                      </span>
                    </li>
                  ))}
                </ol>
                <p className="mt-3 text-xs text-ink-400">
                  Rewards are issued as personal coupons and expire on the date shown. One code per
                  new customer.
                </p>
              </div>
            </Reveal>
          </>
        )}
      </div>
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: ReactNode }) {
  return (
    <li className="glass rounded-xl2 px-3 py-3 text-center shadow-glass">
      <p className="text-xl font-bold tabular-nums text-primary-800">{value}</p>
      <p className="mt-0.5 text-[11px] font-medium leading-tight text-ink-600">{label}</p>
    </li>
  );
}

function RewardCard({
  reward,
  copied,
  onCopy,
}: {
  reward: ReferralReward;
  copied: boolean;
  onCopy: () => void;
}) {
  const expiry = new Date(reward.endsAt).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  return (
    <article
      className={cn(
        "rounded-xl2 bg-surface p-4 shadow-card2",
        reward.used && "opacity-70 shadow-sm",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-base font-bold text-ink-900">{formatPaise(reward.valuePaise)} off</p>
          <p className="mt-0.5 text-xs text-ink-600">
            {reward.description ??
              (reward.minOrderPaise > 0
                ? `On orders above ${formatPaise(reward.minOrderPaise)}`
                : "On any order")}
          </p>
        </div>
        <Badge tone={reward.used ? "neutral" : "green"}>{reward.used ? "Used" : "Ready"}</Badge>
      </div>

      <div className="mt-3 flex items-center gap-2 border-t border-dashed border-line pt-3">
        <span className="flex-1 truncate rounded-input border border-dashed border-accent bg-accent/5 px-2.5 py-2 font-mono text-sm font-semibold tracking-wide text-ink-900">
          {reward.code}
        </span>
        <button
          type="button"
          onClick={onCopy}
          disabled={reward.used}
          aria-label={`Copy coupon code ${reward.code}`}
          className="press inline-flex min-h-11 items-center gap-1.5 rounded-input border border-line bg-surface px-3 text-sm font-medium text-ink-900 hover:bg-surface-2 disabled:opacity-50"
        >
          <CopyIcon />
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="mt-2 text-xs text-ink-400">
        {reward.used ? "Already redeemed" : `Valid till ${expiry}`}
      </p>
    </article>
  );
}

function ReferralsSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-64 w-full rounded-sheet2" />
      <div className="grid grid-cols-3 gap-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-20 rounded-xl2" />
        ))}
      </div>
      <Skeleton className="h-32 w-full rounded-xl2" />
    </div>
  );
}
