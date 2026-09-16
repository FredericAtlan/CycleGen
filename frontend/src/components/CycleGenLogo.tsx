"use client";

type CycleGenLogoProps = {
  className?: string;
};

/**
 * Journey A → B whose two branches form a diamond (Renault-inspired geometry).
 * Original CycleGen mark — not a trademark reproduction.
 */
export default function CycleGenLogo({ className }: CycleGenLogoProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 40 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      {/* Upper branch A → top → B */}
      <path
        d="M5 20 L20 5 L35 20"
        stroke="currentColor"
        strokeWidth="2.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Lower branch A → bottom → B (closes the lozenge) */}
      <path
        d="M5 20 L20 35 L35 20"
        stroke="currentColor"
        strokeWidth="2.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {/* Departure A */}
      <circle cx="5" cy="20" r="3.35" fill="currentColor" />
      <circle cx="5" cy="20" r="1.25" fill="var(--logo-cut, #2563eb)" />
      <text
        x="5"
        y="13.2"
        textAnchor="middle"
        fill="currentColor"
        fontSize="6.5"
        fontWeight="800"
        fontFamily="system-ui,sans-serif"
      >
        A
      </text>

      {/* Arrival B */}
      <circle cx="35" cy="20" r="3.35" fill="currentColor" />
      <circle cx="35" cy="20" r="1.25" fill="var(--logo-cut, #2563eb)" />
      <text
        x="35"
        y="13.2"
        textAnchor="middle"
        fill="currentColor"
        fontSize="6.5"
        fontWeight="800"
        fontFamily="system-ui,sans-serif"
      >
        B
      </text>
    </svg>
  );
}
