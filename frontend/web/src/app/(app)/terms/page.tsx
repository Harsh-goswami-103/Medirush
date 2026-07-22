import type { Metadata } from "next";
import { TopBar } from "@/components/AppShell";
import { LastUpdated, LegalContents, LegalList, LegalProse, LegalSection, Op } from "@/components/legal";

export const metadata: Metadata = { title: "Terms & Conditions — MedRush" };

const LAST_UPDATED = "2026-07-12";

/** Jump-list labels — must match each <LegalSection title> verbatim. */
const SECTIONS = [
  "Eligibility",
  "Your account",
  "Ordering & prescriptions",
  "Pricing, payment & COD",
  "Delivery & serviceability",
  "Cancellation & refunds",
  "No medical advice",
  "Prohibited use",
  "Intellectual property",
  "Disclaimers & limitation of liability",
  "Governing law & jurisdiction",
  "Changes to these terms",
  "Contact",
];

/**
 * Terms & Conditions for the MedRush pharmacy delivery service. Static prose;
 * the business fills each [OPERATOR: …] placeholder (entity name, governing-law
 * city, contact) before go-live. Server-rendered.
 */
export default function TermsPage() {
  return (
    <div>
      <TopBar back title="Terms & Conditions" />
      <LegalProse>
        <div className="space-y-3">
          <p className="text-[15px] leading-7 text-ink-600">
            These Terms &amp; Conditions govern your use of the MedRush app and delivery service,
            operated by <Op>legal entity name</Op> (&ldquo;MedRush&rdquo;, &ldquo;we&rdquo;,
            &ldquo;us&rdquo;), a licensed pharmacy. By creating an account or placing an order, you
            agree to these terms. Please read them together with our Privacy Policy.
          </p>
          <LastUpdated date={LAST_UPDATED} />
        </div>

        <LegalContents items={SECTIONS} />

        <LegalSection title="Eligibility">
          <p>
            You must be at least 18 years old and capable of entering a binding contract to use the
            service. Certain medicines may be dispensed only to persons of a minimum age and against
            valid identification.
          </p>
        </LegalSection>

        <LegalSection title="Your account">
          <p>
            You register using your mobile number and are responsible for keeping access to it
            secure. You agree to provide accurate profile, address and contact details and to keep
            them up to date. You are responsible for orders placed from your account.
          </p>
        </LegalSection>

        <LegalSection title="Ordering & prescriptions">
          <LegalList>
            <li>
              Prescription (Rx) medicines can be dispensed only against a valid prescription from a
              registered medical practitioner, which you upload at checkout.
            </li>
            <li>
              Every Rx order is reviewed by our registered pharmacist before it is dispensed. We may
              contact you or your prescriber to verify details.
            </li>
            <li>
              We may refuse, cancel or partially fulfil an order — for example where a prescription
              is invalid, expired, unclear, or where an item is out of stock or restricted.
            </li>
            <li>
              Where a prescribed item is unavailable, any substitution will be made only in
              accordance with law and with appropriate consent.
            </li>
          </LegalList>
        </LegalSection>

        <LegalSection title="Pricing, payment & COD">
          <LegalList>
            <li>
              Prices are shown in Indian Rupees and are inclusive of applicable taxes unless stated
              otherwise. Prices and availability may change before an order is confirmed.
            </li>
            <li>
              You can pay online through our payment gateway or by Cash on Delivery (COD) where
              offered. COD may be unavailable above an order-value limit shown at checkout.
            </li>
            <li>A tax invoice is issued for each completed order.</li>
          </LegalList>
        </LegalSection>

        <LegalSection title="Delivery & serviceability">
          <LegalList>
            <li>
              We deliver only within our serviceable area around the store. Serviceability and
              delivery fees are shown at checkout based on your delivery location.
            </li>
            <li>
              Delivery time estimates are indicative and not guaranteed; they may vary with demand,
              weather, traffic and address accuracy.
            </li>
            <li>
              Someone must be available at the delivery address to receive the order. For certain
              medicines, our delivery partner may verify the recipient&rsquo;s identity or age.
            </li>
          </LegalList>
        </LegalSection>

        <LegalSection title="Cancellation & refunds">
          <p>
            You may cancel an order before it is dispatched, subject to the cancellation and refund
            policy shown in the app at the time of your order. Refunds for eligible cancellations or
            failed deliveries are processed to your original payment method within the timelines
            stated there. Due to safety and regulatory requirements, dispensed medicines generally
            cannot be returned once delivered, except where the item is damaged, incorrect or
            defective.
          </p>
        </LegalSection>

        <LegalSection title="No medical advice">
          <p>
            The app provides product information for convenience only and is not a substitute for
            professional medical advice, diagnosis or treatment. Always follow your doctor&rsquo;s
            advice and the directions on the label. In an emergency, contact your doctor or local
            emergency services.
          </p>
        </LegalSection>

        <LegalSection title="Prohibited use">
          <p>You agree not to:</p>
          <LegalList>
            <li>Use false information, another person&rsquo;s identity, or a forged prescription.</li>
            <li>Resell medicines obtained through the service or use it for any unlawful purpose.</li>
            <li>Interfere with, probe or disrupt the app, its security or its infrastructure.</li>
          </LegalList>
        </LegalSection>

        <LegalSection title="Intellectual property">
          <p>
            The MedRush name, app, content and design are owned by us or our licensors and are
            protected by law. You may use them only to access the service for your personal,
            non-commercial use.
          </p>
        </LegalSection>

        <LegalSection title="Disclaimers & limitation of liability">
          <p>
            The service is provided on an &ldquo;as is&rdquo; and &ldquo;as available&rdquo; basis.
            To the maximum extent permitted by law, we are not liable for indirect, incidental or
            consequential losses, and our total liability arising from an order is limited to the
            value of that order. Nothing in these terms limits any liability that cannot be excluded
            under applicable law, including in relation to death or personal injury caused by
            negligence.
          </p>
        </LegalSection>

        <LegalSection title="Governing law & jurisdiction">
          <p>
            These terms are governed by the laws of India. Subject to applicable law, the courts at{" "}
            <Op>governing-law city</Op> shall have exclusive jurisdiction over any dispute arising
            from these terms or your use of the service.
          </p>
        </LegalSection>

        <LegalSection title="Changes to these terms">
          <p>
            We may update these terms from time to time. Continued use of the service after an
            update constitutes acceptance of the revised terms, which take effect from the
            &ldquo;Last updated&rdquo; date above.
          </p>
        </LegalSection>

        <LegalSection title="Contact">
          <p>
            For questions about these terms or your order, contact us at <Op>support email</Op> or{" "}
            <Op>support phone</Op>. Licensing and compliance details are available on the Licensing
            &amp; Compliance page in the app.
          </p>
        </LegalSection>
      </LegalProse>
    </div>
  );
}
