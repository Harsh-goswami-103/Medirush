import { Container, Eyebrow } from "./primitives";
import { IconCheck } from "./icons";

/**
 * Route geometry. The dot's keyframe waypoints are the segment endpoints and
 * the exact quadratic midpoints ((P0 + 2·P1 + P2) / 4), so it tracks the drawn
 * path rather than drifting near it.
 */
const ROUTE =
  "M28 126 Q96 126 112 92 Q128 58 180 58 Q236 58 252 92 Q268 126 292 126";

/**
 * Scoped keyframes for the route animation. The global reduced-motion block in
 * globals.css collapses these to ~0ms, and because the resting transform is
 * declared on the class itself the dot simply parks at the pharmacy instead of
 * jumping to the SVG origin.
 */
const ROUTE_CSS = `
.mr-lt-dot {
  transform: translate(28px, 126px);
  animation: mr-lt-travel 6s cubic-bezier(.42,0,.58,1) infinite;
}
@keyframes mr-lt-travel {
  0%   { transform: translate(28px, 126px); }
  12%  { transform: translate(83px, 117.5px); }
  25%  { transform: translate(112px, 92px); }
  37%  { transform: translate(137px, 66.5px); }
  50%  { transform: translate(180px, 58px); }
  63%  { transform: translate(226px, 66.5px); }
  75%  { transform: translate(252px, 92px); }
  88%  { transform: translate(270px, 117.5px); }
  100% { transform: translate(292px, 126px); }
}
.mr-lt-ping {
  transform-origin: 0 0;
  animation: mr-lt-ping 2s ease-out infinite;
}
@keyframes mr-lt-ping {
  0%   { transform: scale(.5); opacity: .55; }
  100% { transform: scale(2.4); opacity: 0; }
}
.mr-lt-flow {
  stroke-dasharray: 5 9;
  animation: mr-lt-flow 1.1s linear infinite;
}
@keyframes mr-lt-flow {
  to { stroke-dashoffset: -28; }
}
`;

const POINTS = [
  "Pharmacist verifies your prescription before packing",
  "Rider assigned, with their live position on the map",
  "Delivery OTP confirms the handover at your door",
];

export function TrackingTeaser() {
  return (
    <section aria-labelledby="tracking-title" className="py-20 sm:py-24">
      <Container>
        <div className="relative isolate overflow-hidden rounded-sheet2 bg-mesh-hero shadow-glass">
          <div
            aria-hidden
            className="absolute inset-0 bg-gradient-to-br from-ink-900/60 via-ink-900/40 to-ink-900/65"
          />
          <div className="relative grid gap-10 p-6 sm:p-10 lg:grid-cols-2 lg:items-center lg:gap-14 lg:p-14">
            <div>
              <Eyebrow tone="light">Live tracking</Eyebrow>
              <h2
                id="tracking-title"
                className="mt-4 text-[1.7rem] font-bold leading-tight tracking-tight text-white sm:text-4xl"
              >
                Watch it come to you.
              </h2>
              <p className="mt-4 max-w-lg text-base leading-7 text-white/85">
                The moment your order leaves the counter you get a live map, the rider&rsquo;s name
                and an ETA that keeps itself honest. No &ldquo;out for delivery&rdquo; and then
                silence.
              </p>
              <ul className="mt-7 space-y-3">
                {POINTS.map((p) => (
                  <li key={p} className="flex items-start gap-3 text-sm leading-6 text-white/90">
                    <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-pill bg-primary-500/30 text-primary-100">
                      <IconCheck className="h-3.5 w-3.5" />
                    </span>
                    {p}
                  </li>
                ))}
              </ul>
            </div>

            <div className="glass-dark rounded-xl2 p-4 shadow-glass sm:p-6">
              <style dangerouslySetInnerHTML={{ __html: ROUTE_CSS }} />
              <svg
                viewBox="0 0 320 168"
                className="h-auto w-full"
                role="img"
                aria-label="Illustration of a delivery route running from the pharmacy to your door, with the rider partway along it."
              >
                <g aria-hidden fill="rgba(255,255,255,0.06)">
                  <rect x="46" y="18" width="52" height="34" rx="8" />
                  <rect x="118" y="96" width="46" height="30" rx="8" />
                  <rect x="196" y="14" width="40" height="28" rx="8" />
                  <rect x="252" y="26" width="56" height="22" rx="8" />
                  <rect x="8" y="66" width="34" height="30" rx="8" />
                  <rect x="182" y="104" width="66" height="24" rx="8" />
                </g>

                <path
                  d={ROUTE}
                  fill="none"
                  stroke="rgba(255,255,255,0.22)"
                  strokeWidth="7"
                  strokeLinecap="round"
                />
                <path
                  d={ROUTE}
                  className="mr-lt-flow"
                  fill="none"
                  stroke="#99F6E4"
                  strokeWidth="3"
                  strokeLinecap="round"
                />

                <g transform="translate(28 126)">
                  <circle r="14" fill="rgba(255,255,255,0.18)" />
                  <circle r="10" fill="#ffffff" />
                  <path
                    d="M-3.4 0h6.8M0 -3.4v6.8"
                    stroke="#0D9488"
                    strokeWidth="2.6"
                    strokeLinecap="round"
                  />
                </g>

                <g transform="translate(292 126)">
                  <circle r="14" fill="rgba(255,255,255,0.18)" />
                  <circle r="10" fill="#ffffff" />
                  <path d="M-4.6 0.6 0 -4 4.6 0.6V5.2h-9.2Z" fill="#0D9488" />
                </g>

                <g className="mr-lt-dot">
                  <circle className="mr-lt-ping" r="9" fill="#5EEAD4" />
                  <circle r="9" fill="#ffffff" />
                  <circle r="5" fill="#0D9488" />
                </g>

                <text
                  x="28"
                  y="154"
                  textAnchor="middle"
                  fontSize="11"
                  fontWeight="600"
                  fill="rgba(255,255,255,0.78)"
                >
                  Pharmacy
                </text>
                <text
                  x="292"
                  y="154"
                  textAnchor="middle"
                  fontSize="11"
                  fontWeight="600"
                  fill="rgba(255,255,255,0.78)"
                >
                  Your door
                </text>
              </svg>

              <div className="mt-4 flex items-center justify-between gap-3 border-t border-white/15 pt-4">
                <p className="text-sm font-semibold text-white">Arriving in ~14 min</p>
                <span className="rounded-pill bg-primary-500/25 px-3 py-1 text-xs font-semibold text-primary-100">
                  Sample route
                </span>
              </div>
            </div>
          </div>
        </div>
      </Container>
    </section>
  );
}
