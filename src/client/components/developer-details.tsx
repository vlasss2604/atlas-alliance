"use client";

import type { ResearchJobDetail } from "../api";

// DEVELOPER DETAILS — engine internals, closed by default.
//
// Everything a normal reader should never meet lives here: component reason
// codes, job state, acquisition phase, termination reason and the raw
// payload. Keeping it in the page (rather than deleting it) is what lets
// engine work continue against the real UI without leaking reason codes into
// the product surface.
export function DeveloperDetails({ detail }: { detail: ResearchJobDetail }) {
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
