-- Raw-SQL migration beyond Prisma (docs/BLUEPRINT.md §6.3, verbatim).
-- Applied as a hand-written migration once the initial Prisma migration exists
-- against live Postgres (Phase 1 integration).

-- Fuzzy product search
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX product_search_trgm ON "Product"
  USING GIN ((name || ' ' || coalesce(brand,'') || ' ' || "composition" || ' ' || "searchKeywords") gin_trgm_ops);

-- Ledger safety nets
ALTER TABLE "Wallet"  ADD CONSTRAINT wallet_nonneg  CHECK ("balancePaise" >= 0);
ALTER TABLE "Product" ADD CONSTRAINT stock_nonneg   CHECK ("stockQty" >= 0);
ALTER TABLE "Batch"   ADD CONSTRAINT batch_nonneg   CHECK ("qtyAvailable" >= 0);
