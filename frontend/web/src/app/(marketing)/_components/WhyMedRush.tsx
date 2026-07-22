import type { ReactNode } from "react";
import { Reveal } from "@/components/motion";
import { Container, SectionHeading } from "./primitives";
import {
  IconBell,
  IconCalendarCheck,
  IconPin,
  IconRepeat,
  IconRx,
  IconShieldCheck,
} from "./icons";

type Accent = "teal" | "violet" | "amber";

const ACCENTS: Record<Accent, string> = {
  teal: "bg-primary-50 text-primary-700 ring-primary-600/15",
  violet: "bg-rx/10 text-rx ring-rx/15",
  amber: "bg-accent/10 text-accent ring-accent/20",
};

const FEATURES: { title: string; body: string; icon: ReactNode; accent: Accent }[] = [
  {
    title: "Rx upload + pharmacist review",
    body: "Upload a photo or PDF of your prescription. A registered pharmacist reviews it against your order before anything is dispensed — and tells you if something needs changing.",
    icon: <IconRx className="h-6 w-6" />,
    accent: "violet",
  },
  {
    title: "Live rider tracking",
    body: "From packed to picked up to at your door, follow the rider on a live map with an ETA that updates as they move.",
    icon: <IconPin className="h-6 w-6" />,
    accent: "teal",
  },
  {
    title: "FEFO freshness & expiry safety",
    body: "Stock is picked first-expiry-first-out. The batch number and expiry date of what you actually received are recorded on your order and printed on the invoice.",
    icon: <IconCalendarCheck className="h-6 w-6" />,
    accent: "teal",
  },
  {
    title: "Secure payments & COD",
    body: "Pay by UPI, card or net banking through an encrypted gateway — we never see your card details. Cash on delivery is available on eligible orders.",
    icon: <IconShieldCheck className="h-6 w-6" />,
    accent: "teal",
  },
  {
    title: "Back-in-stock alerts",
    body: "Out of stock is not a dead end. Ask to be told the moment a medicine returns and we will send a notification straight away.",
    icon: <IconBell className="h-6 w-6" />,
    accent: "amber",
  },
  {
    title: "Refill reminders",
    body: "For medicines you take every month, set a reminder once and reorder the same items in a couple of taps when it is due.",
    icon: <IconRepeat className="h-6 w-6" />,
    accent: "amber",
  },
];

export function WhyMedRush() {
  return (
    <section id="why-us" aria-labelledby="why-us-title" className="scroll-mt-24 py-20 sm:py-24">
      <Container>
        <SectionHeading
          id="why-us-title"
          eyebrow="Why MedRush"
          title="Built like a pharmacy, not a corner shop."
          subtitle="Speed only counts if the medicine is right, in date and dispensed by someone qualified to hand it over."
        />

        <ul className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-3 lg:gap-6">
          {FEATURES.map((f, i) => (
            <Reveal
              as="li"
              key={f.title}
              delayMs={(i % 3) * 90}
              className="glass flex flex-col rounded-xl2 p-6 shadow-card2 transition-shadow hover:shadow-glass"
            >
              <span
                className={`grid h-12 w-12 place-items-center rounded-xl2 ring-1 ${ACCENTS[f.accent]}`}
              >
                {f.icon}
              </span>
              <h3 className="mt-5 text-base font-semibold tracking-tight text-ink-900">{f.title}</h3>
              <p className="mt-2 text-sm leading-6 text-ink-600">{f.body}</p>
            </Reveal>
          ))}
        </ul>
      </Container>
    </section>
  );
}
