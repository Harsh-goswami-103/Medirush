"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import type { Category } from "@medrush/contracts";
import { api } from "@/lib/api";
import { Reveal } from "@/components/motion";
import { EmptyState, ErrorState, Skeleton } from "@/components/ui";
import { Container, SectionHeading } from "./primitives";
import { IconArrowRight, IconSearch } from "./icons";

/** Enough to fill three rows on desktop without turning the section into a wall. */
const MAX_TILES = 12;

export function CategoryTiles() {
  const query = useQuery({
    queryKey: ["categories"],
    queryFn: () => api.get<Category[]>("/v1/categories"),
    staleTime: 5 * 60_000,
  });

  const categories = query.data?.data ?? [];

  return (
    <section id="categories" aria-labelledby="categories-title" className="scroll-mt-24 py-20 sm:py-24">
      <Container>
        <SectionHeading
          id="categories-title"
          eyebrow="Shop by category"
          title="Everything a pharmacy counter stocks."
          subtitle="Prescription medicines, daily essentials and health devices — all from one licensed store."
        />

        {/* aria-busy, not aria-live: announcing a twelve-tile grid on first
            paint would flood a screen reader for no benefit. */}
        <div className="mt-12" aria-busy={query.isLoading}>
          {query.isLoading ? (
            <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
              {Array.from({ length: 6 }).map((_, i) => (
                <li key={i} className="glass rounded-xl2 p-3 shadow-card2">
                  <Skeleton className="aspect-square w-full rounded-xl2" />
                  <Skeleton className="mx-auto mt-3 h-3.5 w-3/4" />
                  <Skeleton className="mx-auto mb-1 mt-2 h-3.5 w-1/2" />
                </li>
              ))}
            </ul>
          ) : query.isError ? (
            <ErrorState
              message="Couldn’t load categories right now."
              onRetry={() => void query.refetch()}
            />
          ) : categories.length === 0 ? (
            <EmptyState
              icon={<IconSearch className="h-8 w-8" />}
              title="Categories are on their way"
              hint="Our catalogue is being set up. You can still browse everything in the store."
              action={
                <Link
                  href="/shop"
                  className="press inline-flex h-11 w-full items-center justify-center rounded-pill bg-gradient-to-r from-primary-500 to-primary-600 px-5 text-sm font-semibold text-white shadow-glow"
                >
                  Browse the store
                </Link>
              }
            />
          ) : (
            <>
              <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
                {categories.slice(0, MAX_TILES).map((c, i) => (
                  <Reveal as="li" key={c.id} delayMs={Math.min(i, 6) * 60}>
                    <Link
                      href={`/shop?category=${encodeURIComponent(c.slug)}`}
                      className="press group flex h-full flex-col rounded-xl2 bg-surface/80 p-3 shadow-card2 ring-1 ring-white/60 transition-shadow hover:shadow-glass"
                    >
                      <span className="block aspect-square w-full overflow-hidden rounded-xl2 bg-mint">
                        {c.imageUrl ? (
                          // Plain img — external CDN URLs need no next/image remote config.
                          <img
                            src={c.imageUrl}
                            alt=""
                            loading="lazy"
                            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                          />
                        ) : (
                          <span
                            aria-hidden
                            className="flex h-full w-full items-center justify-center text-3xl font-bold text-primary-600"
                          >
                            {c.name.slice(0, 1).toUpperCase()}
                          </span>
                        )}
                      </span>
                      <span className="mt-3 line-clamp-2 px-1 pb-1 text-center text-sm font-semibold leading-snug text-ink-900">
                        {c.name}
                      </span>
                    </Link>
                  </Reveal>
                ))}
              </ul>

              <div className="mt-10 text-center">
                <Link
                  href="/shop"
                  className="press inline-flex h-12 items-center justify-center gap-2 rounded-pill border border-primary-600/25 bg-primary-50 px-6 text-sm font-semibold text-primary-700 transition-colors hover:bg-primary-100"
                >
                  See the full catalogue
                  <IconArrowRight className="h-4 w-4" />
                </Link>
              </div>
            </>
          )}
        </div>
      </Container>
    </section>
  );
}
