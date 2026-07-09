import { useEffect, useState } from "react";

/**
 * Seconds remaining until `expiresAtIso`, ticking every second, floored at 0.
 * Used for offer expiry countdowns. Recomputes from the absolute timestamp each
 * tick so it stays accurate across re-renders and background/foreground.
 */
export function useSecondsLeft(expiresAtIso: string): number {
  const compute = () =>
    Math.max(0, Math.round((new Date(expiresAtIso).getTime() - Date.now()) / 1000));
  const [left, setLeft] = useState(compute);

  useEffect(() => {
    setLeft(compute());
    const id = setInterval(() => setLeft(compute()), 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expiresAtIso]);

  return left;
}
