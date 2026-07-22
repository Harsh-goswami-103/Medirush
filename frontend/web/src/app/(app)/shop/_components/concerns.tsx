"use client";

import { useQuery } from "@tanstack/react-query";
import type { HealthConcern } from "@medrush/contracts";
import { api } from "@/lib/api";
import { Skeleton } from "@/components/ui";
import { Reveal } from "@/components/motion";
import { cn } from "@/lib/cn";
import { SectionHeader } from "./section";

/**
 * "Shop by health concern" rail — a second browse dimension alongside category.
 * Selecting a concern filters the grid via `?concern=<slug>` on /v1/products.
 * The rail is supplementary, so an error or an empty catalogue hides it rather
 * than pushing a failure state in front of the store.
 */
export function ConcernRail({
  activeSlug,
  onSelect,
}: {
  activeSlug: string | undefined;
  onSelect: (concern: HealthConcern | undefined) => void;
}) {
  const concernsQuery = useQuery({
    queryKey: ["concerns"],
    queryFn: () => api.get<HealthConcern[]>("/v1/concerns"),
    staleTime: 5 * 60_000,
    retry: false,
  });

  if (concernsQuery.isLoading) {
    return (
      <section className="pb-4">
        <SectionHeader title="Shop by health concern" />
        <div className="no-scrollbar flex gap-3 overflow-x-auto px-4">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="w-[68px] shrink-0">
              <Skeleton className="h-[68px] w-[68px] rounded-full" />
              <Skeleton className="mx-auto mt-2 h-2.5 w-12 rounded" />
            </div>
          ))}
        </div>
      </section>
    );
  }

  const concerns = concernsQuery.data?.data ?? [];
  if (concernsQuery.isError || concerns.length === 0) return null;

  return (
    <Reveal as="section" className="pb-4">
      <SectionHeader
        title="Shop by health concern"
        hint="Curated picks for what you're treating"
        action={
          activeSlug ? (
            <button
              type="button"
              onClick={() => onSelect(undefined)}
              className="press rounded-pill px-2 py-1 text-xs font-semibold text-primary-700"
            >
              Clear
            </button>
          ) : undefined
        }
      />
      <ul className="no-scrollbar flex gap-3 overflow-x-auto px-4 pb-1">
        {concerns.map((c) => {
          const active = activeSlug === c.slug;
          return (
            <li key={c.id} className="w-[68px] shrink-0">
              <button
                type="button"
                onClick={() => onSelect(active ? undefined : c)}
                aria-pressed={active}
                className="press flex w-full flex-col items-center gap-1.5"
              >
                <span
                  className={cn(
                    "grid h-[68px] w-[68px] place-items-center overflow-hidden rounded-full bg-mint",
                    active
                      ? "shadow-glow ring-2 ring-primary-600 ring-offset-2 ring-offset-surface"
                      : "shadow-card2 ring-1 ring-primary-100",
                  )}
                >
                  {c.imageUrl ? (
                    // Plain img — external CDN URLs need no next/image remote config.
                    <img src={c.imageUrl} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <span className="text-lg font-bold text-primary-700">
                      {c.name.slice(0, 1).toUpperCase()}
                    </span>
                  )}
                </span>
                <span
                  className={cn(
                    "line-clamp-2 text-center text-[11px] leading-tight",
                    active ? "font-semibold text-primary-800" : "text-ink-600",
                  )}
                >
                  {c.name}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </Reveal>
  );
}
