"use client";

import { componentLabel } from "../research-model";

// COULD NOT VERIFY.
//
// A gap is a research finding, not an application error, and it is written
// that way: "ATLAS could not verify X", never "failed" and never a claim
// that X is false. Nothing here promises future monitoring — the product
// does not watch anything, and saying so would be a lie the UI told.
export function GapCard({
  component,
  detail,
}: {
  component: string | null;
  detail?: string | null;
}) {
  return (
    <div className="row-card px-4 py-3.5" data-testid="gap-card">
      <div className="flex items-start gap-3">
        <span className="dot dot-insufficient mt-2" aria-hidden />
        <div className="min-w-0">
          <p className="text-[0.9rem]">
            {component
              ? `ATLAS could not verify ${componentLabel(component).toLowerCase()} from the sources it was able to admit.`
              : "ATLAS could not close this part of the chain from the sources it was able to admit."}
          </p>
          {detail && (
            <p className="mt-1 text-[0.76rem] text-[var(--atlas-text-dim)]">{detail}</p>
          )}
        </div>
      </div>
    </div>
  );
}
