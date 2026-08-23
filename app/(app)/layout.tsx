import type { ReactNode } from "react";

import { AppProvider } from "@/src/client/app-context";
import { BottomNav } from "@/src/client/bottom-nav";

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <AppProvider>
      <div className="mx-auto min-h-dvh w-full max-w-[430px] px-4 pb-28 pt-6">
        {children}
      </div>
      <BottomNav />
    </AppProvider>
  );
}
