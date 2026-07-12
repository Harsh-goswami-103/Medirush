-- e2e setup: keep the seeded store open 24x7 so golden-path runs never hit the
-- STORE_CLOSED checkout gate outside 08:00-22:00 IST (open == close means
-- "always open" — backend/api/src/core/storeInfo.ts isStoreOpenNow()).
-- Idempotent; re-running the seed restores the human hours.
UPDATE "StoreConfig"
SET "openTime" = '00:00',
    "closeTime" = '00:00',
    "isOpen"    = true
WHERE "id" = 'store';
