import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import { Card } from "@/components/ui";

/* --------------------------------------------------------------- headers */

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-4 flex items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold text-ink-900">{title}</h1>
        {subtitle && <p className="text-sm text-ink-600">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

/* ---------------------------------------------------------- stat tile (KPI) */

/**
 * KPI stat tile (dataviz "stat tile" form): the number is the hero in ink-900;
 * label + hint wear muted text tokens; an optional `tone` tints only the value
 * for status emphasis (reserved status colors), never the whole card.
 */
export function StatCard({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: "default" | "good" | "warning" | "danger";
}) {
  const valueTone = {
    default: "text-ink-900",
    good: "text-success",
    warning: "text-warning",
    danger: "text-danger",
  }[tone];
  return (
    <Card className="p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-400">{label}</p>
      <p className={cn("mt-1 text-2xl font-semibold tabular-nums", valueTone)}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-ink-600">{hint}</p>}
    </Card>
  );
}

/* --------------------------------------------------------------- form bits */

export function Field({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-ink-900">{label}</span>
      {children}
      {error ? (
        <span className="mt-1 block text-xs text-danger">{error}</span>
      ) : (
        hint && <span className="mt-1 block text-xs text-ink-400">{hint}</span>
      )}
    </label>
  );
}

const INPUT_CLS =
  "w-full rounded-input border border-line bg-surface px-3 py-2 text-sm text-ink-900 outline-none focus:border-primary-600 disabled:bg-surface-2";

export function TextInput({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(INPUT_CLS, className)} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(INPUT_CLS, className)} {...props} />;
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn(INPUT_CLS, "pr-8", className)} {...props}>
      {children}
    </select>
  );
}

/* ------------------------------------------------------------------- table */

export function Table({ children }: { children: ReactNode }) {
  return (
    <Card className="overflow-x-auto">
      <table className="w-full text-sm">{children}</table>
    </Card>
  );
}

export function THead({ children }: { children: ReactNode }) {
  return (
    <thead className="border-b border-line bg-surface-2 text-left text-xs uppercase tracking-wide text-ink-400">
      {children}
    </thead>
  );
}

export function Th({ children, right }: { children: ReactNode; right?: boolean }) {
  return <th className={cn("px-4 py-2.5 font-medium", right && "text-right")}>{children}</th>;
}

export function Tr({ children }: { children: ReactNode }) {
  return <tr className="border-b border-line last:border-0 hover:bg-surface-2">{children}</tr>;
}

export function Td({
  children,
  right,
  className,
}: {
  children: ReactNode;
  right?: boolean;
  className?: string;
}) {
  return (
    <td className={cn("px-4 py-2.5 align-top", right && "text-right tabular-nums", className)}>
      {children}
    </td>
  );
}
