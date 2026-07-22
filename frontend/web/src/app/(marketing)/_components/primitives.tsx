import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { LogoMark } from "./icons";

/** Landing-page surfaces come in two flavours: light page, dark teal panel. */
export type Tone = "ink" | "light";

export function Wordmark({ tone = "ink", className }: { tone?: Tone; className?: string }) {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl2 bg-gradient-to-br from-primary-600 to-primary-800 text-white shadow-glow">
        <LogoMark />
      </span>
      <span
        className={cn(
          "text-lg font-bold tracking-tight",
          tone === "light" ? "text-white" : "text-ink-900",
        )}
      >
        Med
        <span className={tone === "light" ? "text-primary-200" : "text-primary-600"}>Rush</span>
      </span>
    </span>
  );
}

export function Eyebrow({
  children,
  tone = "ink",
  className,
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-pill border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.14em]",
        tone === "light"
          ? "border-white/25 bg-white/10 text-primary-100"
          : "border-primary-600/20 bg-primary-50 text-primary-700",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Centred section header: optional eyebrow, an `id`-anchored h2, and subcopy. */
export function SectionHeading({
  id,
  eyebrow,
  title,
  subtitle,
  tone = "ink",
  className,
}: {
  id: string;
  eyebrow?: ReactNode;
  title: string;
  subtitle?: string;
  tone?: Tone;
  className?: string;
}) {
  return (
    <div className={cn("mx-auto max-w-2xl text-center", className)}>
      {eyebrow && <Eyebrow tone={tone}>{eyebrow}</Eyebrow>}
      <h2
        id={id}
        className={cn(
          "mt-4 text-[1.7rem] font-bold leading-tight tracking-tight sm:text-4xl",
          tone === "light" ? "text-white" : "text-ink-900",
        )}
      >
        {title}
      </h2>
      {subtitle && (
        <p
          className={cn(
            "mx-auto mt-4 max-w-xl text-base leading-7",
            tone === "light" ? "text-white/85" : "text-ink-600",
          )}
        >
          {subtitle}
        </p>
      )}
    </div>
  );
}

/** The page's single horizontal rhythm — every section shares this container. */
export function Container({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("mx-auto w-full max-w-6xl px-4 sm:px-6", className)}>{children}</div>;
}
