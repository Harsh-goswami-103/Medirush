"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Notification } from "@medrush/contracts";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { isPushConfigured } from "@/lib/firebase";
import { enableWebPush } from "@/lib/push";
import { useNotifications } from "@/lib/notifications";
import { timeAgo } from "@/lib/format";
import { cn } from "@/lib/cn";
import { TopBar } from "@/components/AppShell";
import { Button, EmptyState, ErrorState, Skeleton, Spinner } from "@/components/ui";
import { useToast } from "@/components/toast";

/** Pull an `orderId` out of the opaque `data` payload for deep-linking (best-effort). */
function orderIdOf(data: unknown): string | null {
  if (data && typeof data === "object") {
    const v = (data as Record<string, unknown>).orderId;
    if (typeof v === "string") return v;
  }
  return null;
}

/** Notification center — GET /v1/notifications, mark-read on tap, mark-all-read. */
export default function NotificationsPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const { user, loading } = useAuth();

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  const notifQuery = useNotifications();

  // Push opt-in card — only when push is configured for this build AND the
  // browser hasn't decided yet ("default"). Local dev-token builds never show it.
  const [showPushCard, setShowPushCard] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  useEffect(() => {
    setShowPushCard(
      isPushConfigured &&
        typeof window !== "undefined" &&
        "Notification" in window &&
        Notification.permission === "default",
    );
  }, []);

  async function optIntoPush() {
    setPushBusy(true);
    try {
      const result = await enableWebPush();
      if (result === "enabled") {
        toast.push({ type: "success", message: "Push notifications enabled" });
        setShowPushCard(false);
      } else if (result === "denied") {
        toast.push({ type: "info", message: "Push stays off — you can enable it in browser settings" });
        setShowPushCard(false);
      } else {
        toast.push({ type: "info", message: "Push isn't supported in this browser" });
        setShowPushCard(false);
      }
    } catch {
      toast.push({ type: "error", message: "Couldn't enable push — please try again" });
    } finally {
      setPushBusy(false);
    }
  }

  const markRead = useMutation({
    mutationFn: (id: string) => api.post<{ ok: boolean }>(`/v1/notifications/${id}/read`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });

  const markAll = useMutation({
    mutationFn: () => api.post<{ ok: boolean }>("/v1/notifications/read-all"),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["notifications"] });
      toast.push({ type: "success", message: "All caught up" });
    },
    onError: (err) =>
      toast.push({
        type: "error",
        message: err instanceof ApiError ? err.message : "Could not update notifications",
      }),
  });

  if (loading || !user) {
    return (
      <div className="bg-mesh flex min-h-[calc(100dvh-4.5rem)] items-center justify-center">
        <Spinner className="h-6 w-6 text-primary-600" />
      </div>
    );
  }

  const notifications = notifQuery.data?.pages.flatMap((p) => p.data) ?? [];
  const hasUnread = notifications.some((n) => n.readAt === null);

  function openRow(n: Notification) {
    if (n.readAt === null) markRead.mutate(n.id);
    const orderId = orderIdOf(n.data);
    if (orderId) router.push(`/orders/${orderId}`);
  }

  return (
    <div>
      <TopBar
        back
        title="Notifications"
        right={
          hasUnread ? (
            <button
              onClick={() => markAll.mutate()}
              disabled={markAll.isPending}
              className="press -my-2 min-h-11 rounded-pill px-2.5 text-xs font-semibold text-primary-700 transition-colors hover:bg-primary-50 disabled:opacity-60"
            >
              Mark all read
            </button>
          ) : undefined
        }
      />

      <div className="bg-mesh min-h-[calc(100dvh-8rem)] p-4">
        {showPushCard && (
          <div className="mb-3 overflow-hidden rounded-xl2 border border-primary-600/15 bg-primary-50 p-4 shadow-card2">
            <div className="flex items-start gap-3">
              <span
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary-600 to-primary-500 text-white shadow-glow"
                aria-hidden
              >
                <svg
                  viewBox="0 0 24 24"
                  className="h-5 w-5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
                  <path d="M13.73 21a2 2 0 01-3.46 0" />
                </svg>
              </span>
              <div className="min-w-0">
                <p className="text-[15px] font-bold tracking-tight text-ink-900">
                  Get order updates instantly
                </p>
                <p className="mt-1 text-sm leading-6 text-ink-600">
                  Turn on push notifications to hear the moment your order is packed, picked up and
                  arriving.
                </p>
              </div>
            </div>
            <Button
              className="press mt-3 h-11 w-full rounded-card bg-gradient-to-r from-primary-600 to-primary-500 font-semibold shadow-glow disabled:bg-none"
              loading={pushBusy}
              onClick={() => void optIntoPush()}
            >
              Enable push notifications
            </Button>
          </div>
        )}
        {notifQuery.isError ? (
          <ErrorState
            message={(notifQuery.error as Error).message}
            onRetry={() => notifQuery.refetch()}
          />
        ) : notifQuery.isLoading ? (
          <ul className="space-y-2.5">
            {[0, 1, 2, 3].map((i) => (
              <li key={i} className="flex gap-3 rounded-xl2 border border-line/70 bg-surface p-4">
                <Skeleton className="h-10 w-10 shrink-0 rounded-full" />
                <div className="min-w-0 flex-1">
                  <Skeleton className="h-3.5 w-1/2 rounded" />
                  <Skeleton className="mt-2.5 h-3 w-4/5 rounded" />
                </div>
              </li>
            ))}
          </ul>
        ) : notifications.length === 0 ? (
          <EmptyState
            icon={
              <svg
                viewBox="0 0 24 24"
                className="h-10 w-10"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
                <path d="M13.73 21a2 2 0 01-3.46 0" />
              </svg>
            }
            title="No notifications yet"
            hint="Order updates and offers will show up here."
          />
        ) : (
          <>
            <p className="sr-only" role="status">
              {notifications.filter((n) => n.readAt === null).length} unread notifications
            </p>
            <ul className="space-y-2.5">
              {notifications.map((n) => {
                const unread = n.readAt === null;
                const linked = orderIdOf(n.data) !== null;
                return (
                  <li key={n.id}>
                    <button
                      onClick={() => openRow(n)}
                      className={cn(
                        "press flex w-full items-start gap-3 rounded-xl2 border p-4 text-left transition-colors",
                        unread
                          ? "border-primary-600/20 bg-primary-50 shadow-card2"
                          : "border-line/70 bg-surface shadow-sm hover:bg-surface-2",
                      )}
                    >
                      <span
                        className={cn(
                          "flex h-10 w-10 shrink-0 items-center justify-center rounded-full",
                          unread
                            ? "bg-gradient-to-br from-primary-600 to-primary-500 text-white shadow-glow"
                            : "bg-surface-2 text-ink-400",
                        )}
                        aria-hidden
                      >
                        <svg
                          viewBox="0 0 24 24"
                          className="h-5 w-5"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          {linked ? (
                            <path d="M7 3h10l2 4v13a1 1 0 01-1 1H6a1 1 0 01-1-1V7zM5 7h14M9 12h6" />
                          ) : (
                            <>
                              <path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
                              <path d="M13.73 21a2 2 0 01-3.46 0" />
                            </>
                          )}
                        </svg>
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-start justify-between gap-2">
                          <span
                            className={cn(
                              "text-[15px] leading-snug text-ink-900",
                              unread ? "font-bold" : "font-semibold",
                            )}
                          >
                            {n.title}
                          </span>
                          <span className="flex shrink-0 items-center gap-1.5 pt-0.5 text-xs text-ink-400">
                            {timeAgo(n.createdAt)}
                            {unread && (
                              <>
                                <span className="h-2 w-2 rounded-full bg-primary-600" aria-hidden />
                                <span className="sr-only">Unread</span>
                              </>
                            )}
                          </span>
                        </span>
                        <span className="mt-1 block text-sm leading-6 text-ink-600">{n.body}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>

            {notifQuery.hasNextPage && (
              <div className="mt-4 flex justify-center">
                <Button
                  variant="secondary"
                  className="press h-11 rounded-pill px-5 font-semibold shadow-sm"
                  loading={notifQuery.isFetchingNextPage}
                  onClick={() => notifQuery.fetchNextPage()}
                >
                  Load more
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
