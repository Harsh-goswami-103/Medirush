import type { ReactNode } from "react";

/** Shared heading for the shop's browse rails and the results grid. */
export function SectionHeader({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-2.5 flex items-end justify-between gap-3 px-4">
      <div className="min-w-0">
        <h2 className="truncate text-[15px] font-bold tracking-tight text-ink-900">{title}</h2>
        {hint && <p className="mt-0.5 truncate text-xs text-ink-600">{hint}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
