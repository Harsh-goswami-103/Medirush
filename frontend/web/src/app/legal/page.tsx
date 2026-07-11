import type { Metadata } from "next";
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
        <p className="text-sm leading-6 text-ink-600">
          MedRush is a licensed online pharmacy. The statutory registration details below are
          published in line with the Drugs and Cosmetics Act and Rules, the GST law and food-safety
          requirements.
        </p>

        <LicensingCard />

        <LegalSection title="About these details">
          <p>
            Prescription medicines are dispensed only against a valid prescription and after review
            by our registered pharmacist named above. If you have a question about our licences or
            registrations, please contact support through the app.
          </p>
        </LegalSection>
      </LegalProse>
    </div>
  );
}
