import type { Metadata } from "next";
import { TopBar } from "@/components/AppShell";
import { LastUpdated, LegalList, LegalProse, LegalSection, Op } from "@/components/legal";

export const metadata: Metadata = { title: "Privacy Policy — MedRush" };

const LAST_UPDATED = "2026-07-12";

/**
 * Privacy Policy aligned to India's Digital Personal Data Protection Act, 2023
 * for a licensed online pharmacy. Static prose — the business fills every
 * [OPERATOR: …] placeholder (entity name, addresses, grievance officer) before
 * go-live. Server-rendered; TopBar is the only client boundary.
 */
export default function PrivacyPage() {
  return (
    <div>
      <TopBar back title="Privacy Policy" />
      <LegalProse>
        <div className="space-y-2">
          <p className="text-sm leading-6 text-ink-600">
            This Privacy Policy explains how <Op>legal entity name</Op> (&ldquo;MedRush&rdquo;,
            &ldquo;we&rdquo;, &ldquo;us&rdquo;), a licensed online pharmacy operating from{" "}
            <Op>registered office address</Op>, collects, uses, shares and protects your personal
            data when you use our app and delivery service. We act as a Data Fiduciary under the
            Digital Personal Data Protection Act, 2023 (&ldquo;DPDP Act&rdquo;) and process your
            data in accordance with applicable law.
          </p>
          <LastUpdated date={LAST_UPDATED} />
        </div>

        <LegalSection title="Data we collect">
          <p>We collect only the data needed to fulfil your orders and run a compliant pharmacy:</p>
          <LegalList>
            <li>
              <span className="font-medium text-ink-900">Identity</span> — your name and, where
              required by a prescription, age/sex.
            </li>
            <li>
              <span className="font-medium text-ink-900">Contact</span> — mobile number (used for
              sign-in) and email for receipts and invoices.
            </li>
            <li>
              <span className="font-medium text-ink-900">Address &amp; location</span> — delivery
              addresses and the delivery-point coordinates you drop on the map.
            </li>
            <li>
              <span className="font-medium text-ink-900">Prescriptions &amp; health data</span> —
              prescription images and prescriber details you upload for prescription (Rx)
              medicines. This is sensitive medical data and is treated with heightened care.
            </li>
            <li>
              <span className="font-medium text-ink-900">Payment metadata</span> — order amount,
              payment status and a payment-gateway reference. We do <span className="font-medium">not</span>{" "}
              store your full card, UPI or bank credentials.
            </li>
            <li>
              <span className="font-medium text-ink-900">Device &amp; usage</span> — app version,
              device type and basic diagnostics needed for security and reliability.
            </li>
          </LegalList>
        </LegalSection>

        <LegalSection title="Purpose &amp; lawful basis">
          <p>
            We process your data on the basis of your consent and the &ldquo;legitimate uses&rdquo;
            permitted by the DPDP Act, for the following purposes:
          </p>
          <LegalList>
            <li>To create and secure your account and verify your identity.</li>
            <li>To accept, review and fulfil your orders, including pharmacist review of Rx items.</li>
            <li>To arrange delivery to your chosen address and keep you updated on order status.</li>
            <li>To process payments and issue tax invoices.</li>
            <li>To provide customer support and handle grievances.</li>
            <li>To comply with pharmacy, drug, tax and other legal obligations, and for safety.</li>
          </LegalList>
          <p>
            Where processing relies on your consent, you may withdraw it at any time (see{" "}
            <span className="font-medium text-ink-900">Your rights</span>); withdrawal does not
            affect processing already carried out.
          </p>
        </LegalSection>

        <LegalSection title="Prescriptions &amp; medical data">
          <p>
            Prescription images and related health information are accessed only by our registered
            pharmacist and authorised staff for the purpose of validating and dispensing your
            medicines. We may decline to dispense where a prescription is invalid, unclear or
            expired. Prescription records are retained for the period required under the Drugs and
            Cosmetics Rules and other applicable law, after which they are deleted or anonymised.
          </p>
        </LegalSection>

        <LegalSection title="How we share your data">
          <p>We share personal data only as necessary, with:</p>
          <LegalList>
            <li>
              <span className="font-medium text-ink-900">Delivery partners</span> — your name,
              delivery address, contact number and location, so your order can be delivered.
            </li>
            <li>
              <span className="font-medium text-ink-900">Payment processor</span> — our payment
              gateway, to authorise and reconcile payments.
            </li>
            <li>
              <span className="font-medium text-ink-900">Service providers</span> — vetted cloud,
              hosting and communications providers acting as Data Processors on our instructions.
            </li>
            <li>
              <span className="font-medium text-ink-900">Regulators &amp; authorities</span> — where
              required by law, court order, or a lawful request from a competent authority.
            </li>
          </LegalList>
          <p>We do not sell your personal data or share it for third-party advertising.</p>
        </LegalSection>

        <LegalSection title="How long we keep your data">
          <LegalList>
            <li>Account &amp; profile data — for as long as your account is active.</li>
            <li>Order &amp; invoice records — for the period required under tax and accounting law.</li>
            <li>Prescription records — for the statutory retention period noted above.</li>
          </LegalList>
          <p>
            When data is no longer required for these purposes or a legal obligation, we delete or
            anonymise it.
          </p>
        </LegalSection>

        <LegalSection title="Your rights">
          <p>Subject to the DPDP Act, you may:</p>
          <LegalList>
            <li>Access a summary of the personal data we process about you.</li>
            <li>Request correction, completion or updating of inaccurate data.</li>
            <li>Request erasure of data that is no longer necessary, subject to legal retention.</li>
            <li>Withdraw consent and nominate another person to exercise your rights.</li>
            <li>Raise a grievance with our Grievance Officer (below).</li>
          </LegalList>
          <p>
            To exercise any right, contact our Grievance Officer. If you are not satisfied with our
            response, you may escalate to the Data Protection Board of India.
          </p>
        </LegalSection>

        <LegalSection title="Cookies &amp; analytics">
          <p>
            We use only essential storage needed to keep you signed in and remember your cart, plus
            limited, privacy-respecting analytics to keep the service reliable. We do not use
            cookies for cross-site advertising.
          </p>
        </LegalSection>

        <LegalSection title="Children">
          <p>
            Our service is intended for users aged 18 and above. We do not knowingly process the
            personal data of children without verifiable consent of a parent or lawful guardian as
            required by the DPDP Act. If you believe a child has used the service, contact us so we
            can act.
          </p>
        </LegalSection>

        <LegalSection title="Security">
          <p>
            We use reasonable technical and organisational safeguards — including encryption in
            transit, access controls and least-privilege access to prescription data — to protect
            your personal data. No method of transmission or storage is completely secure, but we
            work to protect your data and will notify affected users and authorities of a
            reportable data breach as required by law.
          </p>
        </LegalSection>

        <LegalSection title="Grievance Officer">
          <p>
            In line with the DPDP Act and the Information Technology Act, you may contact our
            Grievance Officer for any privacy question, request or complaint:
          </p>
          <div className="rounded-card border border-line bg-surface-2 p-3">
            <p>
              <span className="font-medium text-ink-900">Grievance Officer:</span>{" "}
              <Op>grievance officer name</Op>
            </p>
            <p>
              <span className="font-medium text-ink-900">Email:</span>{" "}
              <Op>grievance officer email</Op>
            </p>
            <p>
              <span className="font-medium text-ink-900">Phone:</span>{" "}
              <Op>grievance officer phone</Op>
            </p>
            <p>
              <span className="font-medium text-ink-900">Address:</span>{" "}
              <Op>registered office address</Op>
            </p>
            <p>
              <span className="font-medium text-ink-900">Data Protection Officer:</span>{" "}
              <Op>DPO name/email, if appointed</Op>
            </p>
          </div>
        </LegalSection>

        <LegalSection title="Changes to this policy">
          <p>
            We may update this Privacy Policy from time to time. Material changes will be notified
            in the app, and the &ldquo;Last updated&rdquo; date above will reflect the latest
            version.
          </p>
        </LegalSection>
      </LegalProse>
    </div>
  );
}
