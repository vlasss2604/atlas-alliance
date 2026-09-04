"use client";

import { useSyncExternalStore } from "react";

import type { ResearchJobDetail } from "../api";

// DEVELOPER DETAILS — engine internals, and NOT part of the normal result.
//
// Everything a normal reader should never meet lives here: component reason
// codes as raw enums, job state, acquisition phase, termination reason and
// the entire response payload as JSON.
//
// "Collapsed by default" was not enough. A <details> element still renders
// its summary on every result for every user, so the last thing on the
// screen after the answer was an invitation labelled "Developer details" —
// and one click printed the whole engine payload. This is a development
// tool; it is now behind an explicit opt-in and is absent from the normal
// flow entirely.
//
// It is NOT renamed into a user-facing audit. The audit a reader wants is
// the evidence section: sources, verbatim fragments, and why each one was
// used or refused. A JSON dump answers a different question, for a different
// person, and conflating the two would make the product look like it was
// showing its work when it was showing its plumbing.
//
// The opt-in is read from the URL rather than held in state, so a shared
// link never carries it and a reload never keeps it by accident.
//
// `useSyncExternalStore` rather than an effect: the URL is an external
// value, and this is exactly the read-with-a-server-snapshot case it
// exists for. Reading it in an effect would set state on the first render
// (a cascading render the lint rule rightly refuses), and reading it in a
// useState initialiser would render `true` on the client against the
// server's `false` and produce a hydration mismatch. The server snapshot
// is `false`, which is also the correct answer for every reader who did
// not ask for this.
const subscribeToNothing = () => () => {};

function readDebugFlag(): boolean {
  try {
    return new URLSearchParams(window.location.search).get("debug") === "1";
  } catch {
    return false;
  }
}

function useDeveloperOptIn(): boolean {
  return useSyncExternalStore(subscribeToNothing, readDebugFlag, () => false);
}

export function DeveloperDetails({ detail }: { detail: ResearchJobDetail }) {
  const enabled = useDeveloperOptIn();
  if (!enabled) return null;
  return (
    <details className="panel px-5 py-4" data-testid="developer-details">
      <summary className="cursor-pointer select-none text-[0.8rem] text-[var(--atlas-text-dim)]">
        Developer details
      </summary>

      <div className="mt-4 flex flex-col gap-4 text-[0.78rem]">
        <div className="grid gap-2 sm:grid-cols-2">
          <Kv label="Job state" value={detail.job.state} />
          <Kv label="Acquisition phase" value={detail.job.acquisitionPhase ?? "—"} />
          <Kv label="Progress stage" value={String(detail.job.progressStage)} />
          <Kv label="Memory status" value={detail.job.memoryStatus} />
          <Kv label="Termination reason" value={detail.job.terminationReason ?? "—"} />
          <Kv label="Error code" value={detail.job.errorCode ?? "—"} />
          <Kv label="Verification status" value={detail.proof?.verificationStatus ?? "—"} />
          <Kv
            label="Confidence encoding"
            value={
              detail.proof ? `${detail.proof.confidence.band ?? "—"} (${detail.proof.confidence.score})` : "—"
            }
          />
        </div>

        <div>
          <p className="eyebrow">Component results</p>
          <ul className="mt-2 flex flex-col gap-1 font-mono text-[0.7rem] text-[var(--atlas-text-dim)]">
            {detail.components.map((c) => (
              <li key={`${c.patternStep}:${c.component}`}>
                {c.patternStep} / {c.component}: {c.status}
                {Array.isArray(c.reasonCodes) && c.reasonCodes.length > 0
                  ? ` [${(c.reasonCodes as unknown[]).join(", ")}]`
                  : ""}
              </li>
            ))}
            {detail.components.length === 0 && <li>none</li>}
          </ul>
        </div>

        <div>
          <p className="eyebrow">Raw</p>
          <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-xl border border-[var(--hairline)] bg-[rgba(6,14,25,0.7)] p-3 font-mono text-[0.65rem] text-[var(--atlas-text-dim)]">
            {JSON.stringify(detail, null, 2)}
          </pre>
        </div>
      </div>
    </details>
  );
}

function Kv({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[var(--hairline)] px-3 py-2">
      <p className="text-[0.65rem] uppercase tracking-wider text-[var(--atlas-text-dim)]">
        {label}
      </p>
      <p className="mt-0.5 font-mono text-[0.75rem]">{value}</p>
    </div>
  );
}
