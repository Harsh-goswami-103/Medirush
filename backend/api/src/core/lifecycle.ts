/**
 * Shared readiness flag (§11 zero-downtime deploys).
 * SIGTERM flips this first so `/readyz` returns 503 and the load balancer
 * drains traffic before the server closes.
 */

let shuttingDown = false;

export function setShuttingDown(): void {
  shuttingDown = true;
}

export function isShuttingDown(): boolean {
  return shuttingDown;
}
