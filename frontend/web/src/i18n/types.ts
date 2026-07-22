import type en from "../messages/en.json";
import type hi from "../messages/hi.json";
import type { Locale } from "./config";

/**
 * Typed message keys: `useTranslations("shop")("noProducts")` is checked against
 * en.json, so a typo or a removed key is a build failure, not a runtime
 * `shop.noProducts` string rendered to a customer.
 */
declare module "next-intl" {
  interface AppConfig {
    Messages: typeof en;
    Locale: Locale;
  }
}

/**
 * Compile-time catalog parity, checked in BOTH directions.
 *
 * `hi extends en` catches the dangerous case: an English string added without a
 * translation, which silently falls back to English for Hindi users. `en
 * extends hi` catches the merely wasteful one: a Hindi key whose English
 * counterpart was renamed or deleted, leaving dead copy nobody will ever see.
 * One direction alone lets the other drift silently.
 */
type HiCoversEn = typeof hi extends typeof en ? true : false;
type EnCoversHi = typeof en extends typeof hi ? true : false;

const _hiCoversEn: HiCoversEn = true;
const _enCoversHi: EnCoversHi = true;
void _hiCoversEn;
void _enCoversHi;
