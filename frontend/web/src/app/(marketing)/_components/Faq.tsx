"use client";

import { useId, useState, type ReactNode } from "react";
import Link from "next/link";
import { cn } from "@/lib/cn";
import { Container, SectionHeading } from "./primitives";
import { IconChevronDown } from "./icons";

const LINK_CLASS = "font-semibold text-primary-700 underline underline-offset-2 hover:text-primary-800";

const QUESTIONS: { q: string; a: ReactNode }[] = [
  {
    q: "How fast is delivery, really?",
    a: (
      <>
        Most orders inside our service radius reach you in about 40 minutes. Prescription orders
        wait for a pharmacist to review the Rx first, and heavy rain or traffic can add a few
        minutes — the live ETA on your order is always the honest one.
      </>
    ),
  },
  {
    q: "Do I need a prescription?",
    a: (
      <>
        For prescription-only medicines, yes. Products that need one are marked{" "}
        <span className="font-semibold text-rx">Rx</span> in the catalogue, and we cannot dispense
        them without a valid prescription from a registered medical practitioner. Everyday items
        like vitamins, first-aid and personal care need nothing.
      </>
    ),
  },
  {
    q: "How do I upload my prescription?",
    a: (
      <>
        Add your items, then attach a clear photo or PDF of the prescription at checkout. Our
        registered pharmacist reviews it before the order is packed. If anything is unclear or the
        prescription does not cover an item, we will tell you and refund that item rather than
        guess.
      </>
    ),
  },
  {
    q: "What payment methods do you accept?",
    a: (
      <>
        UPI, cards and net banking through an encrypted payment gateway — card details never touch
        our servers. Cash on delivery is available on eligible orders up to a limit shown at
        checkout.
      </>
    ),
  },
  {
    q: "Can I return a medicine?",
    a: (
      <>
        Medicines are returnable only within safety limits: unopened, in original packaging, and
        not temperature-sensitive. Anything delivered damaged, expired or simply wrong is always
        our problem — report it from the order and we will refund it. The details are in our{" "}
        <Link href="/terms" className={LINK_CLASS}>
          terms
        </Link>
        .
      </>
    ),
  },
  {
    q: "How do you make sure medicines aren’t close to expiry?",
    a: (
      <>
        We pick stock first-expiry-first-out, so the oldest in-date batch goes first. The batch
        number and expiry of the exact pack you received are recorded against your order and
        printed on the invoice, so you can check them any time.
      </>
    ),
  },
];

export function Faq() {
  const baseId = useId();
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  return (
    <section id="faq" aria-labelledby="faq-title" className="scroll-mt-24 py-20 sm:py-24">
      <Container>
        <SectionHeading
          id="faq-title"
          eyebrow="FAQ"
          title="Questions people actually ask."
          subtitle="If yours isn’t here, message us — a human replies."
        />

        <ul className="mx-auto mt-12 max-w-3xl space-y-3">
          {QUESTIONS.map((item, i) => {
            const open = openIndex === i;
            const buttonId = `${baseId}-q${i}`;
            const panelId = `${baseId}-a${i}`;
            return (
              <li key={item.q} className="glass overflow-hidden rounded-xl2 shadow-card2">
                <h3>
                  <button
                    type="button"
                    id={buttonId}
                    aria-expanded={open}
                    aria-controls={panelId}
                    onClick={() => setOpenIndex(open ? null : i)}
                    className="press flex min-h-[3.5rem] w-full items-center justify-between gap-4 px-5 py-4 text-left sm:px-6"
                  >
                    <span className="text-base font-semibold leading-snug text-ink-900">
                      {item.q}
                    </span>
                    <IconChevronDown
                      className={cn(
                        "h-5 w-5 shrink-0 text-primary-600 transition-transform duration-300",
                        open && "rotate-180",
                      )}
                    />
                  </button>
                </h3>
                <div
                  id={panelId}
                  role="region"
                  aria-labelledby={buttonId}
                  hidden={!open}
                  className="px-5 pb-5 sm:px-6"
                >
                  <p className="max-w-2xl text-sm leading-6 text-ink-600">{item.a}</p>
                </div>
              </li>
            );
          })}
        </ul>
      </Container>
    </section>
  );
}
