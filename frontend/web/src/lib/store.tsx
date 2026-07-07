"use client";

import { useQuery } from "@tanstack/react-query";
import type { StoreInfo } from "@medrush/contracts";
import { api } from "./api";

/** Public store info + feature flags (cached 5 min). */
export function useStore() {
  const query = useQuery({
    queryKey: ["store"],
    queryFn: () => api.get<StoreInfo>("/v1/store"),
    staleTime: 5 * 60_000,
  });
  return { store: query.data?.data, isLoading: query.isLoading, error: query.error };
}
