import type { ReactNode } from "react";

import { AppProvider } from "@/src/client/app-context";
import { AtlasNavigation } from "@/src/client/components/atlas-navigation";

// UI V1 shell. One responsive container — no phone frame, no fixed 430px
// column: the same markup is a comfortable single column on a handset and a
// wide, two-column intelligence surface on a desktop.
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <AppProvider>
      <div className="atlas-field" aria-hidden>
        <span className="atlas-grid" />
        <AtlasArcs />
      </div>
      <div className="relative z-10 mx-auto w-full max-w-[760px] px-4 pb-32 sm:px-6 lg:max-w-[1120px] lg:px-8">
        {children}
      </div>
      <AtlasNavigation />
    </AppProvider>
  );
}

// The evidence-network filaments behind the whole app: violet sweeping in
// from the left, cyan from the right, echoing the way a proof converges from
// separate sources. Decorative only — aria-hidden on the container above.
function AtlasArcs() {
  return (
    <svg
      className="atlas-arcs"
      viewBox="0 0 1440 900"
      preserveAspectRatio="xMidYMin slice"
      fill="none"
    >
      <defs>
        <linearGradient id="arc-violet" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#a78bfa" stopOpacity="0" />
          <stop offset="35%" stopColor="#a78bfa" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#7c3aed" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="arc-cyan" x1="1" y1="0" x2="0" y2="0">
          <stop offset="0%" stopColor="#67e8f9" stopOpacity="0" />
          <stop offset="35%" stopColor="#22d3ee" stopOpacity="0.5" />
          <stop offset="100%" stopColor="#0891b2" stopOpacity="0" />
        </linearGradient>
      </defs>
      <g stroke="url(#arc-violet)" strokeWidth="1">
        <path d="M-80 470C140 430 300 330 420 170" />
        <path d="M-80 530C160 500 340 400 470 220" />
        <path d="M-80 600C180 570 380 470 520 280" />
        <path d="M-60 380C120 350 250 270 350 130" />
      </g>
      <g stroke="url(#arc-cyan)" strokeWidth="1">
        <path d="M1520 430C1300 390 1140 300 1020 150" />
        <path d="M1520 500C1280 470 1100 380 970 210" />
        <path d="M1520 580C1260 550 1060 450 920 270" />
        <path d="M1500 350C1320 320 1190 240 1090 110" />
      </g>
    </svg>
  );
}
