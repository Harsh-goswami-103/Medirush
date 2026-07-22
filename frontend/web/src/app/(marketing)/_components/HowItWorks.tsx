import type { ReactNode } from "react";
import { Reveal } from "@/components/motion";
import { Container, SectionHeading } from "./primitives";
import { IconCart, IconPin, IconSearch } from "./icons";

const STEPS: { n: string; title: string; body: string; icon: ReactNode }[] = [
  {
    n: "01",
    title: "Search",
    body: "Find a medicine by brand, salt or symptom. We show the price, the pack size and whether a prescription is needed before you add anything.",
    icon: <IconSearch className="h-7 w-7" />,
  },
  {
    n: "02",
    title: "Order",
    body: "Add to cart and upload your prescription if one is required. Our registered pharmacist reviews it before the order is packed.",
    icon: <IconCart className="h-7 w-7" />,
  },
  {
    n: "03",
    title: "Track live",
    body: "Watch the order move from packing to your doorstep on a live map, with your rider's position updating the whole way.",
    icon: <IconPin className="h-7 w-7" />,
  },
];

export function HowItWorks() {
  return (
    <section
      id="how-it-works"
      aria-labelledby="how-it-works-title"
      className="scroll-mt-24 py-20 sm:py-24"
    >
      <Container>
        <SectionHeading
          id="how-it-works-title"
          eyebrow="How it works"
          title="Three steps, forty minutes."
          subtitle="No queue, no phone calls, no guessing where your order is."
        />

        <div className="relative mt-14">
          <div
            aria-hidden
            className="absolute left-[16%] right-[16%] top-[4.75rem] hidden border-t-2 border-dashed border-primary-600/25 lg:block"
          />
          <ol className="relative grid gap-6 sm:grid-cols-2 lg:grid-cols-3 lg:gap-8">
            {STEPS.map((step, i) => (
              <Reveal
                as="li"
                key={step.n}
                delayMs={i * 110}
                className="glass flex flex-col rounded-xl2 p-6 shadow-card2 sm:p-7"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="grid h-14 w-14 place-items-center rounded-xl2 bg-gradient-to-br from-primary-500 to-primary-700 text-white shadow-glow">
                    {step.icon}
                  </span>
                  <span className="text-3xl font-bold tabular-nums text-primary-600/25">
                    {step.n}
                  </span>
                </div>
                <h3 className="mt-5 text-xl font-semibold tracking-tight text-ink-900">
                  {step.title}
                </h3>
                <p className="mt-2 text-sm leading-6 text-ink-600">{step.body}</p>
              </Reveal>
            ))}
          </ol>
        </div>
      </Container>
    </section>
  );
}
