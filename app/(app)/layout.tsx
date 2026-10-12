import type { ReactNode } from "react";

import { AppProvider } from "@/src/client/app-context";
import { AppHeader, AtlasDock, DockFade } from "@/src/client/components/app-chrome";
import { AtlasField } from "@/src/client/components/atlas-field";

// THE SHELL. One calm page background, a header that carries the brand
// and the three anchors, a single reading column, and — on a handset — a
// dock at the bottom with the same anchors. The column is sized for
// reading a research result, not for filling a monitor.
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <AppProvider>
      <AtlasField />
      <div className="app-column relative z-10 mx-auto w-full max-w-[920px] px-4 sm:px-8">
        <AppHeader />
        {children}
      </div>
      <DockFade />
      <AtlasDock />
    </AppProvider>
  );
}
