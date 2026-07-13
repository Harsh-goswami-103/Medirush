import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { OrderStatus, RxStatus } from "@medrush/contracts";
import { cn } from "@/lib/cn";

/* ------------------------------------------------------------------ Button */

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-primary-600 text-white hover:bg-primary-700 disabled:bg-ink-400",
  secondary: "bg-surface text-ink-900 border border-line hover:bg-surface-2",
  ghost: "text-ink-600 hover:bg-surface-2",
  danger: "bg-danger text-white hover:brightness-95 disabled:bg-ink-400",
};

export function Button({
  variant = "primary",
  className,
  loading,
  disabled,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; loading?: boolean }) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-input px-3.5 py-2 text-sm font-medium",
        "transition-colors disabled:cursor-not-allowed disabled:opacity-70",
        BUTTON_VARIANTS[variant],
        className,
      )}
      {...props}
      disabled={loading || disabled}
    >
      {loading && <Spinner className="h-4 w-4" />}
      {children}
    </button>
  );
}

/* -------------------------------------------------------------------- Card */

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn("rounded-card border border-line bg-surface shadow-sm", className)}>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ Spinner */

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-block animate-spin rounded-full border-2 border-current border-t-transparent",
        className ?? "h-5 w-5",
      )}
      aria-hidden
    />
  );
}

/* -------------------------------------------------------------------- Badge */

type BadgeTone = "neutral" | "teal" | "green" | "amber" | "red" | "violet" | "blue";

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: "bg-surface-2 text-ink-600 border-line",
  teal: "bg-primary-600/10 text-primary-700 border-primary-600/20",
  green: "bg-success/10 text-success border-success/20",
  amber: "bg-warning/10 text-warning border-warning/20",
  red: "bg-danger/10 text-danger border-danger/20",
  violet: "bg-rx/10 text-rx border-rx/20",
  blue: "bg-info/10 text-info border-info/20",
};

export function Badge({ tone = "neutral", children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-pill border px-2 py-0.5 text-xs font-medium",
        BADGE_TONES[tone],
      )}
    >
      {children}
    </span>
  );
}

const ORDER_STATUS_TONE: Record<OrderStatus, BadgeTone> = {
  PENDING_PAYMENT: "amber",
  PLACED: "blue",
  RX_REVIEW: "violet",
  PACKING: "teal",
  READY: "teal",
  ASSIGNED: "blue",
  PICKED_UP: "blue",
  DELIVERED: "green",
  CANCELLED: "red",
};

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  return <Badge tone={ORDER_STATUS_TONE[status]}>{status.replace(/_/g, " ")}</Badge>;
}

const RX_TONE: Record<RxStatus, BadgeTone> = {
  NA: "neutral",
  PENDING: "amber",
  APPROVED: "green",
  REJECTED: "red",
};

export function RxBadge({ status }: { status: RxStatus }) {
  if (status === "NA") return null;
  return <Badge tone={RX_TONE[status]}>Rx {status.toLowerCase()}</Badge>;
}

/* -------------------------------------------------------------- state views */

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 rounded-card border border-dashed border-line bg-surface px-6 py-16 text-center">
      <p className="font-medium text-ink-900">{title}</p>
      {hint && <p className="text-sm text-ink-600">{hint}</p>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-card border border-danger/20 bg-danger/5 px-6 py-12 text-center">
      <p className="text-sm font-medium text-danger">{message}</p>
      {onRetry && (
        <Button variant="secondary" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- glyphs */

/** WhatsApp glyph for support deep-links (inherits `currentColor`). */
export function WhatsAppIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn("h-4 w-4", className)} fill="currentColor" aria-hidden>
      <path d="M12.04 2c-5.46 0-9.9 4.44-9.9 9.9 0 1.75.46 3.45 1.32 4.95L2 22l5.28-1.38a9.86 9.86 0 0 0 4.76 1.21c5.46 0 9.9-4.44 9.9-9.9S17.5 2 12.04 2Zm0 18.02c-1.5 0-2.97-.4-4.25-1.16l-.3-.18-3.13.82.83-3.05-.2-.31a8.2 8.2 0 0 1-1.26-4.36c0-4.54 3.7-8.23 8.24-8.23 4.54 0 8.23 3.69 8.23 8.23 0 4.54-3.69 8.4-8.23 8.4Zm4.52-6.16c-.25-.13-1.47-.72-1.7-.8-.23-.09-.39-.13-.56.12-.16.25-.64.8-.79.97-.14.16-.29.18-.54.06-.25-.13-1.05-.39-1.99-1.23-.74-.66-1.23-1.47-1.38-1.72-.14-.25-.02-.39.11-.51.11-.11.25-.29.37-.43.13-.15.17-.25.25-.42.08-.16.04-.31-.02-.43-.06-.13-.56-1.35-.77-1.85-.2-.48-.41-.42-.56-.43l-.48-.01c-.16 0-.43.06-.66.31-.23.25-.86.85-.86 2.07 0 1.22.89 2.4 1.01 2.57.13.16 1.75 2.67 4.23 3.74.59.26 1.05.41 1.41.52.59.19 1.13.16 1.56.1.47-.07 1.47-.6 1.68-1.18.2-.58.2-1.07.14-1.18-.06-.11-.22-.17-.47-.29Z" />
    </svg>
  );
}
