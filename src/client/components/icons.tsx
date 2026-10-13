"use client";

// THE ATLAS ICON FAMILY — one stroke weight, one grid, currentColor.
//
// Sixteen-unit line icons drawn on a 20×20 box at 1.6px, rounded caps, so
// every icon on every surface reads as one set. An icon exists only where
// it helps scanning: the kind of a source, an action a reader can take,
// a place in the product. Nothing decorative.

type IconProps = { size?: number; className?: string; strokeWidth?: number };

function Svg({ size = 16, className, strokeWidth = 1.6, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      {children}
    </svg>
  );
}

/* ---- source kinds ------------------------------------------------ */

export function DocsIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M5.5 3h6l3.5 3.5V17h-9.5z" />
      <path d="M11.5 3v3.5H15M7.5 10h5M7.5 13h5" />
    </Svg>
  );
}
export function GovernanceIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="3.5" y="4" width="13" height="12" rx="2" />
      <path d="m7 10 2 2 4-4.5" />
    </Svg>
  );
}
export function ChainIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="5.5" cy="10" r="2.2" />
      <circle cx="14.5" cy="5.5" r="2.2" />
      <circle cx="14.5" cy="14.5" r="2.2" />
      <path d="m7.5 9 5-2.6M7.5 11l5 2.6" />
    </Svg>
  );
}
export function ReportIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="4" y="3.5" width="12" height="13" rx="2" />
      <path d="M7 12.5v-2M10 12.5V8M13 12.5v-4" />
    </Svg>
  );
}
export function DataIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3.5 15.5 8 10.5l3 3 5.5-6.5" />
      <path d="M13.5 7h3v3" />
    </Svg>
  );
}
export function MediaIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="3.5" y="4.5" width="13" height="11" rx="1.8" />
      <path d="M6.5 8h3v3.5h-3zM12 8h2M12 11.5h2" />
    </Svg>
  );
}
export function SocialIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 5.5h12v8H9.5L6 16.5v-3H4z" />
    </Svg>
  );
}

// The icon for a source-class LABEL, as `sourceClassLabel` renders it.
// Anything unfamiliar falls back to the document icon — never to nothing.
export function SourceKindIcon({ label, size = 14, className }: { label: string; size?: number; className?: string }) {
  const l = label.toLowerCase();
  if (l.includes("chain")) return <ChainIcon size={size} className={className} />;
  if (l.includes("govern")) return <GovernanceIcon size={size} className={className} />;
  if (l.includes("report")) return <ReportIcon size={size} className={className} />;
  if (l.includes("data")) return <DataIcon size={size} className={className} />;
  if (l.includes("media") || l.includes("news") || l.includes("research")) return <MediaIcon size={size} className={className} />;
  if (l.includes("social")) return <SocialIcon size={size} className={className} />;
  return <DocsIcon size={size} className={className} />;
}

// The visual family of a source kind — one of four accents, so a reader
// learns "cyan is documentation, indigo is governance, teal is the chain,
// silver is everything measured or reported" once.
export function sourceKindFamily(label: string): "docs" | "governance" | "chain" | "data" {
  const l = label.toLowerCase();
  if (l.includes("chain")) return "chain";
  if (l.includes("govern")) return "governance";
  if (l.includes("data") || l.includes("report") || l.includes("media") || l.includes("news") || l.includes("social")) return "data";
  return "docs";
}

/* ---- actions ------------------------------------------------------ */

export function ExternalIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M8.5 5H5.5A1.5 1.5 0 0 0 4 6.5v8A1.5 1.5 0 0 0 5.5 16h8a1.5 1.5 0 0 0 1.5-1.5v-3" />
      <path d="M11 4h5v5M16 4l-6.5 6.5" />
    </Svg>
  );
}
export function SnapshotIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3.5 7V5.5A2 2 0 0 1 5.5 3.5H7M13 3.5h1.5a2 2 0 0 1 2 2V7M16.5 13v1.5a2 2 0 0 1-2 2H13M7 16.5H5.5a2 2 0 0 1-2-2V13" />
      <circle cx="10" cy="10" r="2.5" />
    </Svg>
  );
}
export function QuoteIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4.5 12.5V9a3 3 0 0 1 3-3M4.5 12.5h3v-3h-3zM11.5 12.5V9a3 3 0 0 1 3-3M11.5 12.5h3v-3h-3z" />
    </Svg>
  );
}
export function CalendarIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="3.5" y="4.5" width="13" height="12" rx="2" />
      <path d="M3.5 8.5h13M7 3v3M13 3v3" />
    </Svg>
  );
}
export function EvidenceIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M10 3 4.5 5.2v4.3c0 3.4 2.3 6.2 5.5 7.5 3.2-1.3 5.5-4.1 5.5-7.5V5.2z" />
      <path d="m7.5 10 1.8 1.8 3.4-3.6" />
    </Svg>
  );
}
export function ChevronIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="m7.5 4.5 5 5.5-5 5.5" />
    </Svg>
  );
}
export function ChevronDownIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="m4.5 7.5 5.5 5 5.5-5" />
    </Svg>
  );
}

/* ---- places ------------------------------------------------------- */

export function AskIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="9" cy="9" r="5.5" />
      <path d="m13.2 13.2 3.3 3.3" />
    </Svg>
  );
}
export function ResearchIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="4.5" y="3" width="11" height="14" rx="2.5" />
      <path d="M7.5 7.5h5M7.5 10.5h5M7.5 13.5h3" />
    </Svg>
  );
}
export function AnalyticsIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3.5 16.5h13" />
      <path d="M5.5 13.5v-4M9.5 13.5V6M13.5 13.5V9.5" />
    </Svg>
  );
}
export function ProfileIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="10" cy="7.2" r="3" />
      <path d="M4.4 16.4a5.8 5.8 0 0 1 11.2 0" />
    </Svg>
  );
}
export function ArrowIcon(p: IconProps) {
  return (
    <Svg {...p} strokeWidth={1.8}>
      <path d="M4 10h11m0 0-4.2-4.2M15 10l-4.2 4.2" />
    </Svg>
  );
}
