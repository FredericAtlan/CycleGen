"use client";

/** Map-style endpoint pin + small UI icons for Trajet step. */

type PinTone = "A" | "B";

const PIN_FILL: Record<PinTone, string> = {
  A: "#16a34a", // match MapView markerAIcon
  B: "#dc2626", // match MapView markerBIcon
};

export function RouteEndpointPin({
  tone,
  size = 28,
}: {
  tone: PinTone;
  size?: number;
}) {
  const fill = PIN_FILL[tone];
  const label = tone;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 32"
      className="shrink-0 drop-shadow-sm"
      aria-hidden
    >
      <path
        d="M12 0C6.5 0 2 4.4 2 9.8c0 6.6 8.2 15.8 9.3 17a1 1 0 0 0 1.4 0C13.8 25.6 22 16.4 22 9.8 22 4.4 17.5 0 12 0z"
        fill={fill}
      />
      <circle cx="12" cy="10" r="5.2" fill="#fff" />
      <text
        x="12"
        y="13.2"
        textAnchor="middle"
        fontSize="8.5"
        fontWeight="700"
        fontFamily="system-ui,sans-serif"
        fill={fill}
      >
        {label}
      </text>
    </svg>
  );
}

/** Same footprint as RouteEndpointPin (28×28) — amber clock pin for heure de départ. */
export function TimeEndpointPin({ size = 28 }: { size?: number }) {
  const fill = "#d97706"; // amber-600
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 32"
      className="shrink-0 drop-shadow-sm"
      aria-hidden
    >
      <path
        d="M12 0C6.5 0 2 4.4 2 9.8c0 6.6 8.2 15.8 9.3 17a1 1 0 0 0 1.4 0C13.8 25.6 22 16.4 22 9.8 22 4.4 17.5 0 12 0z"
        fill={fill}
      />
      <circle cx="12" cy="10" r="5.2" fill="#fff" />
      {/* clock hands — centered in white disc */}
      <path
        d="M12 7.2v3.2l2.1 1.3"
        fill="none"
        stroke={fill}
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ClockIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

export function RouterIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M4 17h10a4 4 0 0 0 0-8H9" />
      <path d="M7 17 4 14l3-3" />
      <path d="M20 7H10a4 4 0 0 0 0 8h5" />
      <path d="m17 7 3 3-3 3" />
    </svg>
  );
}

export function RulerIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M3 16 16 3l5 5L8 21 3 16z" />
      <path d="m7.5 11.5 2 2M10 9l2 2M12.5 6.5l2 2" />
    </svg>
  );
}

export function DurationIcon({
  className = "h-3.5 w-3.5",
}: {
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M12 6v6l4 2" />
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}
