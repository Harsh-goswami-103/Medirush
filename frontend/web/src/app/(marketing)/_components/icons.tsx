/**
 * Inline 24px stroke icons for the public landing page. Kept local to the
 * marketing route so the app bundle never pays for them; all decorative, so
 * every glyph is aria-hidden and colour comes from `currentColor`.
 */

const S = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

type IconProps = { className?: string };

const SIZE = "h-6 w-6";

export function IconSearch({ className = SIZE }: IconProps) {
  return (
    <svg {...S} className={className}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20.5 20.5-4-4" />
    </svg>
  );
}

export function IconCart({ className = SIZE }: IconProps) {
  return (
    <svg {...S} className={className}>
      <path d="M3 4h2l2.2 10.2a1.5 1.5 0 0 0 1.5 1.2h7.9a1.5 1.5 0 0 0 1.5-1.2L20 7H6" />
      <circle cx="9.5" cy="19.4" r="1.4" />
      <circle cx="17" cy="19.4" r="1.4" />
    </svg>
  );
}

export function IconPin({ className = SIZE }: IconProps) {
  return (
    <svg {...S} className={className}>
      <path d="M12 21s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11Z" />
      <circle cx="12" cy="10" r="2.6" />
    </svg>
  );
}

export function IconRx({ className = SIZE }: IconProps) {
  return (
    <svg {...S} className={className}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5" />
      <path d="M9 12h2.2a1.65 1.65 0 0 1 0 3.3H9V12Zm0 3.3V18m2.2-2.7L14.4 18" />
    </svg>
  );
}

export function IconCalendarCheck({ className = SIZE }: IconProps) {
  return (
    <svg {...S} className={className}>
      <rect x="3" y="5" width="18" height="16" rx="2.5" />
      <path d="M8 3v4M16 3v4M3 10h18" />
      <path d="m9 15.5 2 2 4-4" />
    </svg>
  );
}

export function IconShieldCheck({ className = SIZE }: IconProps) {
  return (
    <svg {...S} className={className}>
      <path d="M12 3 19 6v5.5c0 4.4-3 8-7 9.5-4-1.5-7-5.1-7-9.5V6l7-3Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

export function IconBell({ className = SIZE }: IconProps) {
  return (
    <svg {...S} className={className}>
      <path d="M18 9a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6Z" />
      <path d="M10.4 19.5a2 2 0 0 0 3.2 0" />
    </svg>
  );
}

export function IconRepeat({ className = SIZE }: IconProps) {
  return (
    <svg {...S} className={className}>
      <path d="M4 12a8 8 0 0 1 13.7-5.6L20 8" />
      <path d="M20 4v4h-4" />
      <path d="M20 12a8 8 0 0 1-13.7 5.6L4 16" />
      <path d="M4 20v-4h4" />
    </svg>
  );
}

export function IconRider({ className = SIZE }: IconProps) {
  return (
    <svg {...S} className={className}>
      <path d="M3 16V7a1 1 0 0 1 1-1h9v10" />
      <path d="M13 9h3.6l3.4 3.6V16" />
      <circle cx="7" cy="17.6" r="2" />
      <circle cx="17.2" cy="17.6" r="2" />
      <path d="M9 17.6h6.2" />
    </svg>
  );
}

export function IconChevronDown({ className = SIZE }: IconProps) {
  return (
    <svg {...S} className={className}>
      <path d="m6 9.5 6 6 6-6" />
    </svg>
  );
}

export function IconArrowRight({ className = SIZE }: IconProps) {
  return (
    <svg {...S} className={className}>
      <path d="M4 12h15" />
      <path d="m13 6 6 6-6 6" />
    </svg>
  );
}

export function IconCheck({ className = SIZE }: IconProps) {
  return (
    <svg {...S} className={className}>
      <path d="m5 12.5 4.5 4.5L19 7" />
    </svg>
  );
}

export function IconBolt({ className = SIZE }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      <path d="M13.2 2 4.4 13.7a.6.6 0 0 0 .5 1h5.4l-.9 7.5a.6.6 0 0 0 1.1.4l8.7-11.7a.6.6 0 0 0-.5-1h-5.4l.9-7.5a.6.6 0 0 0-1-.4Z" />
    </svg>
  );
}

export function IconPhone({ className = SIZE }: IconProps) {
  return (
    <svg {...S} className={className}>
      <path d="M5 3h3.4l1.8 4.3-2.2 1.5a12.2 12.2 0 0 0 6.2 6.2l1.5-2.2L20 14.6V18a3 3 0 0 1-3 3A15.6 15.6 0 0 1 2 6a3 3 0 0 1 3-3Z" />
    </svg>
  );
}

/** The MedRush mark: a medicine cross leaning into three speed lines. */
export function LogoMark({ className = "h-5 w-5" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className}>
      <g fill="currentColor">
        <rect x="12.4" y="4" width="5.2" height="16" rx="2" />
        <rect x="7" y="9.4" width="16" height="5.2" rx="2" />
      </g>
      <path
        d="M1 7h4.6M1 12h2.8M1 17h4.6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}
