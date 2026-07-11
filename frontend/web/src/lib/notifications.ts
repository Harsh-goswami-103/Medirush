"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { Notification, UnreadCount } from "@medrush/contracts";
import { api, qs } from "./api";
import { useAuth } from "./auth";

/**
 * Notification-center data hooks (§7.2). The unread count feeds the TopBar bell
 * badge (polled ~30s); the list drives `/notifications` via cursor pagination
 * over the `{ data, meta.nextCursor }` envelope. Both are gated on an auth token
 * and share the `["notifications", …]` key prefix so the socket layer can
 * invalidate everything on an `order:status` push.
 */

/** Shared query-key prefix — socket invalidation targets this to refresh badge + list. */
export const NOTIFICATIONS_KEY = ["notifications"] as const;

/** Bell badge: poll the unread count while a session is present. */
export function useUnreadCount() {
  const { user } = useAuth();
  return useQuery({
    queryKey: [...NOTIFICATIONS_KEY, "unread-count"],
    queryFn: () => api.get<UnreadCount>("/v1/notifications/unread-count"),
    enabled: Boolean(user),
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
}

/** Paginated notification list for the center screen. */
export function useNotifications() {
  const { user } = useAuth();
  return useInfiniteQuery({
    queryKey: [...NOTIFICATIONS_KEY, "list"],
    queryFn: ({ pageParam }) =>
      api.get<Notification[]>(`/v1/notifications${qs({ cursor: pageParam, limit: 20 })}`),
    enabled: Boolean(user),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.meta?.nextCursor ?? undefined,
    // The center has no socket of its own; poll so newly-arrived rows appear and
    // stay consistent with the bell badge (which polls unread-count every 30s).
    refetchInterval: 30_000,
  });
}
