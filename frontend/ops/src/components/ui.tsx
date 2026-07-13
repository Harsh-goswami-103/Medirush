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
