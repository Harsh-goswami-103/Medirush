"use client";

import { useEffect, useId, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RefillReminder, UpsertRefillBody } from "@medrush/contracts";
import { api, apiErrorMessage, type Envelope } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/cn";
import { formatDateTime } from "@/lib/format";
import { TopBar } from "@/components/AppShell";
import { Badge, Button, EmptyState, ErrorState, Skeleton, Spinner } from "@/components/ui";
import { ProductImage } from "@/components/shop";
import { Reveal } from "@/components/motion";
import { useToast } from "@/components/toast";

const REFILLS_KEY = ["refills"] as const;

/** Contract bounds — RefillIntervalDaysSchema (7…180 days). */
const MIN_DAYS = 7;
const MAX_DAYS = 180;
const PRESETS = [7, 15, 30, 45, 60, 90] as const;

const CTA =
  "press inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-input bg-gradient-to-br from-primary-700 to-primary-800 px-4 text-sm font-semibold text-white shadow-glow transition-colors hover:from-primary-800 hover:to-primary-900";

function ClockIcon({ className }: { className?: string }) {
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
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

/** Calendar-day difference, so "due today" flips at midnight rather than at +24h. */
function daysUntil(iso: string): number {
  const target = new Date(iso);
  const now = new Date();
  const startOfTarget = new Date(target.getFullYear(), target.getMonth(), target.getDate()).getTime();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.round((startOfTarget - startOfToday) / 86_400_000);
}

function dueLabel(iso: string): { text: string; tone: "red" | "amber" | "teal" } {
  const days = daysUntil(iso);
  if (days < 0) {
    const late = Math.abs(days);
    return { text: `Overdue by ${late} ${late === 1 ? "day" : "days"}`, tone: "red" };
  }
  if (days === 0) return { text: "Due today", tone: "amber" };
  if (days === 1) return { text: "Due tomorrow", tone: "amber" };
  return { text: `Due in ${days} days`, tone: days <= 7 ? "amber" : "teal" };
}

/** Refill reminders — GET /v1/refills, upsert interval via POST, drop via DELETE. */
export default function RefillsPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const { user, loading } = useAuth();
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  const refillsQuery = useQuery({
    queryKey: REFILLS_KEY,
    queryFn: () => api.get<RefillReminder[]>("/v1/refills"),
    enabled: Boolean(user),
  });

  const upsert = useMutation({
    mutationFn: (body: UpsertRefillBody) => api.post<RefillReminder>("/v1/refills", body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: REFILLS_KEY });
      setEditingId(null);
      toast.push({ type: "success", message: "Reminder updated" });
    },
    onError: (err) =>
      toast.push({ type: "error", message: apiErrorMessage(err, "Could not save the reminder") }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del<{ ok: true }>(`/v1/refills/${id}`),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: REFILLS_KEY });
      const previous = qc.getQueryData<Envelope<RefillReminder[]>>(REFILLS_KEY);
      qc.setQueryData<Envelope<RefillReminder[]>>(REFILLS_KEY, (old) =>
        old ? { ...old, data: old.data.filter((r) => r.id !== id) } : old,
      );
      return { previous };
    },
    onError: (err, _id, ctx) => {
      if (ctx?.previous) qc.setQueryData(REFILLS_KEY, ctx.previous);
      toast.push({ type: "error", message: apiErrorMessage(err, "Could not remove the reminder") });
    },
    onSuccess: () => toast.push({ type: "success", message: "Reminder removed" }),
    onSettled: () => void qc.invalidateQueries({ queryKey: REFILLS_KEY }),
  });

  // Most urgent first — an overdue or same-week refill is the reason to open this screen.
  const reminders = useMemo(() => {
    const list = refillsQuery.data?.data ?? [];
    return [...list].sort((a, b) => Date.parse(a.nextDueAt) - Date.parse(b.nextDueAt));
  }, [refillsQuery.data]);

  if (loading || !user) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-mesh">
        <Spinner className="h-6 w-6 text-primary-600" />
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-mesh">
      <TopBar title="Refill reminders" back />

      <div className="space-y-4 p-4">
        <Reveal as="section">
          <div className="glass rounded-xl2 p-4 shadow-glass">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-50 text-primary-700">
                <ClockIcon className="h-5 w-5" />
              </span>
              <p className="text-sm font-semibold text-ink-900">Never run out mid-course</p>
            </div>
            <p className="mt-2 text-sm text-ink-600">
              We send a notification when each medicine is due, on the interval you choose. Reminders
              never place an order or charge you on their own — you always confirm.
            </p>
          </div>
        </Reveal>

        {refillsQuery.isError ? (
          <ErrorState
            message={apiErrorMessage(refillsQuery.error, "Could not load your reminders")}
            onRetry={() => void refillsQuery.refetch()}
          />
        ) : refillsQuery.isLoading ? (
          <ul className="space-y-3">
            {[0, 1, 2].map((i) => (
              <li key={i} className="rounded-xl2 bg-surface p-4 shadow-card2">
                <div className="flex gap-3">
                  <Skeleton className="h-14 w-14 rounded-input" />
                  <div className="flex-1">
                    <Skeleton className="h-3.5 w-3/4 rounded" />
                    <Skeleton className="mt-2 h-3 w-1/3 rounded" />
                    <Skeleton className="mt-3 h-5 w-2/3 rounded-pill" />
                  </div>
                </div>
                <Skeleton className="mt-3 h-10 w-full rounded-input" />
              </li>
            ))}
          </ul>
        ) : reminders.length === 0 ? (
          <EmptyState
            icon={<ClockIcon className="h-10 w-10" />}
            title="No refill reminders yet"
            hint="Open a medicine you take regularly and choose “Remind me to refill” — we'll nudge you before it runs out."
            action={
              <Link href="/shop" className={CTA}>
                Find a medicine
              </Link>
            }
          />
        ) : (
          <>
            <p className="text-xs font-medium text-ink-600" aria-live="polite">
              {reminders.length} active {reminders.length === 1 ? "reminder" : "reminders"}
            </p>
            <ul className="space-y-3">
              {reminders.map((reminder, i) => (
                <Reveal as="li" key={reminder.id} delayMs={(i % 6) * 60}>
                  <RefillCard
                    reminder={reminder}
                    editing={editingId === reminder.id}
                    onToggleEdit={() =>
                      setEditingId((id) => (id === reminder.id ? null : reminder.id))
                    }
                    onSave={(intervalDays) =>
                      upsert.mutate({ productId: reminder.product.id, intervalDays })
                    }
                    onRemove={() => remove.mutate(reminder.id)}
                    saving={upsert.isPending && upsert.variables?.productId === reminder.product.id}
                    removing={remove.isPending && remove.variables === reminder.id}
                  />
                </Reveal>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

function RefillCard({
  reminder,
  editing,
  onToggleEdit,
  onSave,
  onRemove,
  saving,
  removing,
}: {
  reminder: RefillReminder;
  editing: boolean;
  onToggleEdit: () => void;
  onSave: (intervalDays: number) => void;
  onRemove: () => void;
  saving: boolean;
  removing: boolean;
}) {
  const panelId = useId();
  const { product } = reminder;
  const due = dueLabel(reminder.nextDueAt);
  const [draft, setDraft] = useState(String(reminder.intervalDays));
  const [confirming, setConfirming] = useState(false);

  const parsed = Number(draft);
  const valid = Number.isInteger(parsed) && parsed >= MIN_DAYS && parsed <= MAX_DAYS;

  return (
    <article className="rounded-xl2 bg-surface p-4 shadow-card2">
      <div className="flex gap-3">
        <div className="h-14 w-14 shrink-0 overflow-hidden rounded-input border border-line">
          <ProductImage url={product.imageUrl} name={product.name} />
        </div>
        <div className="min-w-0 flex-1">
          <Link
            href={`/p/${product.slug}`}
            className="line-clamp-2 text-sm font-semibold leading-snug text-ink-900"
          >
            {product.name}
          </Link>
          <p className="text-xs text-ink-400">{product.packSize}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Badge tone="teal">Every {reminder.intervalDays} days</Badge>
            <Badge tone={due.tone}>{due.text}</Badge>
            {!reminder.isActive && <Badge tone="neutral">Paused</Badge>}
          </div>
        </div>
      </div>

      <p className="mt-2.5 text-xs text-ink-600">
        Next reminder {formatDateTime(reminder.nextDueAt)}
      </p>

      {confirming ? (
        <div className="mt-3 rounded-xl2 border border-danger/20 bg-danger/5 p-3">
          <p className="text-sm font-medium text-ink-900">Remove this reminder?</p>
          <p className="mt-0.5 text-xs text-ink-600">
            You can set it up again from the product page any time.
          </p>
          <div className="mt-3 flex gap-2">
            <Button
              variant="danger"
              className="press min-h-11 flex-1"
              loading={removing}
              onClick={onRemove}
            >
              Remove
            </Button>
            <Button
              variant="secondary"
              className="press min-h-11"
              onClick={() => setConfirming(false)}
            >
              Keep it
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex gap-2">
          <Button
            variant="secondary"
            className="press min-h-11 flex-1"
            onClick={onToggleEdit}
            aria-expanded={editing}
            aria-controls={panelId}
          >
            {editing ? "Close" : "Change interval"}
          </Button>
          <Button
            variant="ghost"
            className="press min-h-11 text-danger hover:bg-danger/10"
            onClick={() => setConfirming(true)}
          >
            Remove
          </Button>
        </div>
      )}

      {editing && (
        <div id={panelId} className="mt-3 rounded-xl2 bg-primary-50 p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-primary-800">
            Remind me every
          </p>
          <div
            role="group"
            aria-label="Refill interval presets"
            className="mt-2 flex flex-wrap gap-2"
          >
            {PRESETS.map((days) => (
              <button
                key={days}
                type="button"
                aria-pressed={parsed === days}
                onClick={() => setDraft(String(days))}
                className={cn(
                  "press min-h-11 rounded-pill border px-3.5 text-sm font-medium transition-colors",
                  parsed === days
                    ? "border-primary-700 bg-primary-700 text-white"
                    : "border-line bg-surface text-ink-600 hover:bg-surface-2",
                )}
              >
                {days} days
              </button>
            ))}
          </div>

          <label className="mt-3 block">
            <span className="mb-1 block text-xs font-medium text-ink-900">
              Or a custom interval ({MIN_DAYS}–{MAX_DAYS} days)
            </span>
            <input
              type="number"
              inputMode="numeric"
              min={MIN_DAYS}
              max={MAX_DAYS}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              aria-invalid={!valid}
              className="min-h-11 w-28 rounded-input border border-line bg-surface px-3 text-sm tabular-nums text-ink-900 outline-none focus:border-primary-600"
            />
          </label>
          {!valid && (
            <p className="mt-1 text-xs text-danger" role="alert">
              Pick a whole number between {MIN_DAYS} and {MAX_DAYS} days.
            </p>
          )}

          <Button
            className="press mt-3 min-h-11 w-full"
            loading={saving}
            disabled={!valid}
            onClick={() => onSave(parsed)}
          >
            Save interval
          </Button>
        </div>
      )}
    </article>
  );
}
