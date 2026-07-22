import type { Metadata } from "next";
import Link from "next/link";
import { TopBar } from "@/components/AppShell";
import { LegalProse, LegalSection } from "@/components/legal";
import { LicensingCard } from "./LicensingCard";

export const metadata: Metadata = { title: "Licensing & Compliance — MedRush" };

/**
 * Licensing & Compliance — displays the pharmacy's statutory identifiers. The
 * identifiers themselves are rendered live from the store config via
 * {@link LicensingCard} (a client component); the surrounding prose is
 * server-rendered.
 */
export default function LegalPage() {
  return (
    <div>
      <TopBar back title="Licensing & Compliance" />
      <LegalProse>
        <div className="flex items-start gap-3 rounded-xl2 border border-primary-600/15 bg-primary-50 p-4">
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary-600/10 text-primary-700"
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
              <path d="M12 3l7.5 3v5.2c0 4.4-3 8.3-7.5 9.8-4.5-1.5-7.5-5.4-7.5-9.8V6L12 3z" />
              <path d="M9.3 12.2l1.9 1.9 3.7-3.9" />
            </svg>
          </span>
          <p className="text-[15px] leading-7 text-ink-600">
            MedRush is a licensed online pharmacy. The statutory registration details below are
            published in line with the Drugs and Cosmetics Act and Rules, the GST law and food-safety
            requirements.
          </p>
        </div>

        <LicensingCard />

        <LegalSection title="About these details">
          <p>
            Prescription medicines are dispensed only against a valid prescription and after review
            by our registered pharmacist named above. If you have a question about our licences or
            registrations, please contact support through the app.
          </p>
        </LegalSection>

        <nav aria-label="Related policies" className="grid grid-cols-2 gap-3">
          {[
            { href: "/privacy", label: "Privacy Policy" },
            { href: "/terms", label: "Terms & Conditions" },
          ].map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="press flex min-h-11 items-center justify-between gap-2 rounded-xl2 border border-line/70 bg-surface px-4 py-3 text-sm font-semibold text-ink-900 shadow-sm transition-colors hover:bg-surface-2"
            >
              {l.label}
              <svg
                viewBox="0 0 24 24"
                className="h-4 w-4 shrink-0 text-ink-400"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M9 18l6-6-6-6" />
              </svg>
            </Link>
          ))}
        </nav>
      </LegalProse>
    </div>
  );
}
