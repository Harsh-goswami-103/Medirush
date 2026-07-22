"use client";

import { useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { setLocale } from "@/app/actions/locale";
import { LOCALES, LOCALE_LABELS, type Locale } from "@/i18n/config";
import { cn } from "@/lib/cn";

/**
 * Segmented language picker. Options are labelled in their own script — a user
 * who can't read English must still be able to find Hindi.
 */
export function LanguageToggle({ className }: { className?: string }) {
  const t = useTranslations("account");
  const active = useLocale() as Locale;
  const [pending, startTransition] = useTransition();

  return (
    <div className={cn("px-4 py-3.5", className)}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-ink-900">{t("language")}</p>
          <p className="mt-0.5 text-xs text-ink-400">{t("languageHint")}</p>
        </div>

        <div
          role="radiogroup"
          aria-label={t("language")}
          className={cn(
            "flex shrink-0 rounded-xl2 border border-line bg-surface-2 p-0.5",
            pending && "opacity-60",
          )}
        >
          {LOCALES.map((locale) => {
            const selected = locale === active;
            return (
              <button
                key={locale}
                type="button"
                role="radio"
                aria-checked={selected}
                lang={locale}
                disabled={pending}
                onClick={() => {
                  if (selected) return;
                  startTransition(() => {
                    void setLocale(locale);
                  });
                }}
                className={cn(
                  "press min-h-11 rounded-[0.65rem] px-3 text-sm font-semibold transition-colors",
                  selected ? "bg-surface text-primary-700 shadow-sm" : "text-ink-600",
                )}
              >
                {LOCALE_LABELS[locale]}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
