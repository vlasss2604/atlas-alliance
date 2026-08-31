"use client";

import { useState } from "react";

import { summariseComponents } from "../research-model";
import { ComponentStatusCard } from "./component-status-card";

// MECHANISM BREAKDOWN — compact by default, complete on demand.
//
// Ten component cards is the analyst's view and it is worth keeping exactly
// as it is. It is not the first thing an ordinary reader needs, so the
// default is the count, and the full grid is one click away. Progressive
// disclosure, not deletion: nothing analytical was removed.
export function ComponentBreakdown({
  components,
  evidenceCountByComponent,
}: {
  components: { patternStep: number; component: string; status: string }[];
  evidenceCountByComponent: Map<string, number>;
}) {
  const [open, setOpen] = useState(false);
  const summary = summariseComponents(components);
  if (components.length === 0) return null;

  return (
    <section className="panel p-5 sm:p-6" data-testid="component-breakdown">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="eyebrow">Mechanism breakdown</p>
          <p
            className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.85rem]"
            data-testid="component-summary"
          >
            <span className="flex items-center gap-1.5">
              <span className="dot dot-supported" aria-hidden />
              {summary.established} established
            </span>
            {summary.partial > 0 && (
              <span className="flex items-center gap-1.5">
                <span className="dot dot-partial" aria-hidden />
                {summary.partial} partial
              </span>
            )}
            {summary.contradicted > 0 && (
              <span className="flex items-center gap-1.5">
                <span className="dot dot-negative" aria-hidden />
                {summary.contradicted} contradicted
              </span>
            )}
            <span className="flex items-center gap-1.5">
              <span className="dot dot-insufficient" aria-hidden />
              {summary.unresolved} unresolved
            </span>
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          data-testid="toggle-breakdown"
          className="pill row-card px-4 py-2 text-[0.78rem] text-[var(--atlas-text-dim)] hover:text-[var(--atlas-text)]"
        >
          {open ? "Hide mechanism breakdown" : "View mechanism breakdown"}
        </button>
      </div>

      {open && (
        <div
          className="mt-5 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3"
          data-testid="component-grid"
        >
          {components.map((c) => (
            <ComponentStatusCard
              key={`${c.patternStep}:${c.component}`}
              component={c.component}
              status={c.status}
              evidenceCount={evidenceCountByComponent.get(c.component) ?? 0}
            />
          ))}
        </div>
      )}
    </section>
  );
}
