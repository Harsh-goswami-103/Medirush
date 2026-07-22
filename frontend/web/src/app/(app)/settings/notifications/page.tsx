"use client";

import { useEffect, useId, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  NotificationPreferences,
  UpdateNotificationPrefsBody,
} from "@medrush/contracts";
import { api, ApiError, apiErrorMessage, type Envelope } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/cn";
import { formatDateTime } from "@/lib/format";
import { useToast } from "@/components/toast";
import { NotificationBell } from "@/components/AppShell";
import { Button, ErrorState, Skeleton, Spinner } from "@/components/ui";
import { Reveal } from "@/components/motion";
import { Field, Textarea, TextInput } from "@/components/kit";
import { Modal } from "@/components/modal";

const PREFS_KEY = ["notification-prefs"] as const;
/** Must match ACCOUNT_DELETE_CONFIRMATION in the preferences contract. */
const CONFIRM_PHRASE = "DELETE";

/* ---------------------------------------------------------------- toggle */

function Toggle({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  const labelId = useId();
  return (
    <div className="flex items-start gap-3 px-4 py-3.5">
      <span className="min-w-0 flex-1">
        <span id={labelId} className="block text-sm font-medium text-ink-900">
          {label}
        </span>
        <span className="mt-0.5 block text-xs text-ink-600">{hint}</span>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className="press -my-2 -mr-2 flex h-11 w-14 shrink-0 items-center justify-center disabled:opacity-50"
      >
        <span
          className={cn(
            "flex h-7 w-12 items-center rounded-pill p-0.5 transition-colors",
            checked ? "bg-primary-600 shadow-glow" : "bg-ink-400/50",
          )}
        >
          <span
            className={cn(
              "h-6 w-6 rounded-full bg-white shadow-sm transition-transform",
              checked && "translate-x-5",
            )}
          />
        </span>
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ page */

export default function NotificationSettingsPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const { user, loading: authLoading, logout } = useAuth();

  const [deleteOpen, setDeleteOpen] = useState(false);

  useEffect(() => {
    if (!authLoading && !user) router.replace("/login");
  }, [authLoading, user, router]);

  const prefsQuery = useQuery({
    queryKey: PREFS_KEY,
    queryFn: () => api.get<NotificationPreferences>("/v1/me/notification-prefs"),
    enabled: Boolean(user),
  });

  const savePrefs = useMutation({
    mutationFn: (body: UpdateNotificationPrefsBody) =>
      api.patch<NotificationPreferences>("/v1/me/notification-prefs", body),
    // Optimistic: the switch flips instantly and rolls back if the PATCH fails.
    onMutate: async (body) => {
      await qc.cancelQueries({ queryKey: PREFS_KEY });
      const prev = qc.getQueryData<Envelope<NotificationPreferences>>(PREFS_KEY);
      if (prev) {
        qc.setQueryData<Envelope<NotificationPreferences>>(PREFS_KEY, {
          ...prev,
          data: { ...prev.data, ...body },
        });
      }
      return { prev };
    },
    onError: (err, _body, ctx) => {
      if (ctx?.prev) qc.setQueryData(PREFS_KEY, ctx.prev);
      toast.push({ type: "error", message: apiErrorMessage(err, "Could not save your preference") });
    },
    onSuccess: (res) => qc.setQueryData(PREFS_KEY, res),
    onSettled: () => void qc.invalidateQueries({ queryKey: PREFS_KEY }),
  });

  if (authLoading || !user) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-mesh">
        <Spinner className="h-6 w-6 text-primary-600" />
      </div>
    );
  }

  const prefs = prefsQuery.data?.data;

  return (
    <div className="min-h-dvh bg-mesh pb-10">
      <header className="sticky top-0 z-30 flex items-center gap-2 border-b border-line bg-surface/90 px-4 py-3 backdrop-blur">
        <Link href="/account" aria-label="Back to account" className="press -ml-1 p-1 text-ink-600">
          <svg
            viewBox="0 0 24 24"
            className="h-5 w-5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </Link>
        <h1 className="flex-1 truncate text-base font-semibold text-ink-900">Notifications</h1>
        <NotificationBell />
      </header>

      <div className="space-y-5 p-4">
        <Reveal>
          <section>
            <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-ink-400">
              What we send you
            </h2>

            {prefsQuery.isError ? (
              <ErrorState
                message={(prefsQuery.error as Error).message}
                onRetry={() => prefsQuery.refetch()}
              />
            ) : !prefs ? (
              <div className="divide-y divide-line overflow-hidden rounded-xl2 bg-surface shadow-card2">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="flex items-center gap-3 px-4 py-3.5">
                    <span className="min-w-0 flex-1">
                      <Skeleton className="h-4 w-32 rounded" />
                      <Skeleton className="mt-2 h-3 w-48 rounded" />
                    </span>
                    <Skeleton className="h-7 w-12 rounded-pill" />
                  </div>
                ))}
              </div>
            ) : (
              <div
                className="divide-y divide-line overflow-hidden rounded-xl2 bg-surface shadow-card2"
                aria-live="polite"
              >
                <Toggle
                  label="Order updates"
                  hint="Placed, packed, out for delivery, prescription review and refunds."
                  checked={prefs.orderUpdates}
                  disabled={savePrefs.isPending}
                  onChange={(v) => savePrefs.mutate({ orderUpdates: v })}
                />
                <Toggle
                  label="Offers & promotions"
                  hint="Coupons, campaigns and seasonal deals."
                  checked={prefs.promotions}
                  disabled={savePrefs.isPending}
                  onChange={(v) => savePrefs.mutate({ promotions: v })}
                />
                <Toggle
                  label="Refill reminders"
                  hint="A nudge when your regular medicine is due to run out."
                  checked={prefs.refillReminders}
                  disabled={savePrefs.isPending}
                  onChange={(v) => savePrefs.mutate({ refillReminders: v })}
                />
              </div>
            )}

            <p className="mt-2 px-1 text-xs leading-5 text-ink-400">
              We still send messages that are essential to a live order — delivery arrival,
              prescription rejection and refund notices — so your medicines reach you safely.
              {prefs ? ` Last updated ${formatDateTime(prefs.updatedAt)}.` : ""}
            </p>
          </section>
        </Reveal>

        {/* ----------------------------------------------------- danger zone */}
        <Reveal delayMs={80}>
          <section>
            <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-danger">
              Danger zone
            </h2>
            <div className="rounded-xl2 border border-danger/25 bg-danger/5 p-4 shadow-card2">
              <p className="text-sm font-semibold text-ink-900">Delete my account</p>
              <p className="mt-1 text-sm leading-6 text-ink-600">
                Your name, phone, email, addresses, patient profiles and prescription files are
                removed permanently. Records a licensed pharmacy must keep by law — invoices, the
                GST record and the Schedule-H1 prescription register — are retained for their
                statutory period with your personal details anonymised. You cannot sign back into
                this account afterwards.
              </p>
              <Button
                variant="danger"
                className="mt-3 min-h-11 w-full press"
                onClick={() => setDeleteOpen(true)}
              >
                Delete my account
              </Button>
            </div>
          </section>
        </Reveal>
      </div>

      <DeleteAccountModal
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onDeleted={() => {
          setDeleteOpen(false);
          toast.push({ type: "success", message: "Your account has been deleted" });
          logout();
          router.replace("/");
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------ delete account modal */

function DeleteAccountModal({
  open,
  onClose,
  onDeleted,
}: {
  open: boolean;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [confirm, setConfirm] = useState("");
  const [reason, setReason] = useState("");
  const [blocked, setBlocked] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setConfirm("");
    setReason("");
    setBlocked(null);
  }, [open]);

  const del = useMutation({
    mutationFn: () =>
      api.del<{ ok: true }>("/v1/me", {
        body: { confirm: CONFIRM_PHRASE, reason: reason.trim() || undefined },
      }),
    onSuccess: onDeleted,
    onError: (err) => {
      // 409 = an order is still live; erasure would strand a dispatch in progress.
      if (err instanceof ApiError && err.status === 409) {
        setBlocked(
          "You have an order in progress. We can’t delete the account until it is delivered or cancelled — please try again once it’s complete.",
        );
        return;
      }
      setBlocked(apiErrorMessage(err, "Could not delete your account — please try again."));
    },
  });

  const typedOk = confirm.trim() === CONFIRM_PHRASE;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Delete my account"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Keep my account
          </Button>
          <Button
            variant="danger"
            disabled={!typedOk}
            loading={del.isPending}
            onClick={() => del.mutate()}
          >
            Delete permanently
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm leading-6 text-ink-600">
          This removes your personal data — profile, addresses, patient profiles, prescription files
          and saved preferences. Invoices, the GST record and the Schedule-H1 prescription register
          are kept in anonymised form because a licensed pharmacy is legally required to retain
          them. This cannot be undone.
        </p>
        {blocked && (
          <p role="alert" className="rounded-input border border-danger/25 bg-danger/5 px-3 py-2 text-sm text-danger">
            {blocked}
          </p>
        )}
        <Field
          label={`Type ${CONFIRM_PHRASE} to confirm`}
          hint="Case-sensitive — this stops an accidental tap erasing your account."
        >
          <TextInput
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            placeholder={CONFIRM_PHRASE}
          />
        </Field>
        <Field label="Reason (optional)" hint="Only stored in our audit log — it helps us improve.">
          <Textarea
            rows={2}
            maxLength={300}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Tell us why you’re leaving"
          />
        </Field>
      </div>
    </Modal>
  );
}
