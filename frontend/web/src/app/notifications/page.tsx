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
import { Button, EmptyState, ErrorState, Spinner } from "@/components/ui";
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
      <div className="flex min-h-dvh items-center justify-center">
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
              className="text-xs font-medium text-primary-700 disabled:opacity-60"
            >
              Mark all read
            </button>
          ) : undefined
        }
      />

      <div className="p-4">
        {showPushCard && (
          <div className="mb-3 rounded-card border border-primary-600/20 bg-primary-600/5 p-4">
            <p className="text-sm font-semibold text-ink-900">Get order updates instantly</p>
            <p className="mt-1 text-sm text-ink-600">
              Turn on push notifications to hear the moment your order is packed, picked up and
              arriving.
            </p>
            <Button className="mt-3" loading={pushBusy} onClick={() => void optIntoPush()}>
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
          <ul className="space-y-2">
            {[0, 1, 2, 3].map((i) => (
              <li key={i} className="animate-pulse rounded-card border border-line bg-surface p-4">
                <div className="h-3.5 w-1/3 rounded bg-surface-2" />
                <div className="mt-2 h-3 w-3/4 rounded bg-surface-2" />
              </li>
            ))}
          </ul>
        ) : notifications.length === 0 ? (
          <EmptyState
            title="No notifications yet"
            hint="Order updates and offers will show up here."
          />
        ) : (
          <>
            <ul className="space-y-2">
              {notifications.map((n) => {
                const unread = n.readAt === null;
                return (
                  <li key={n.id}>
                    <button
                      onClick={() => openRow(n)}
                      className={cn(
                        "flex w-full items-start gap-3 rounded-card border p-4 text-left transition-colors",
                        unread
                          ? "border-primary-600/20 bg-primary-600/5"
                          : "border-line bg-surface hover:bg-surface-2",
                      )}
                    >
                      <span
                        className={cn(
                          "mt-1.5 h-2 w-2 shrink-0 rounded-full",
                          unread ? "bg-primary-600" : "bg-transparent",
                        )}
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-start justify-between gap-2">
                          <span
                            className={cn(
                              "text-sm text-ink-900",
                              unread ? "font-semibold" : "font-medium",
                            )}
                          >
                            {n.title}
                          </span>
                          <span className="shrink-0 text-xs text-ink-400">
                            {timeAgo(n.createdAt)}
                          </span>
                        </span>
                        <span className="mt-0.5 block text-sm text-ink-600">{n.body}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>

            {notifQuery.hasNextPage && (
              <div className="mt-3 flex justify-center">
                <Button
                  variant="secondary"
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
