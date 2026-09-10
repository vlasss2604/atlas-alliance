import Link from "next/link";
import { notFound } from "next/navigation";

import { composeAudit } from "@/src/client/audit-composition";
import { AuditCompositionView } from "@/src/client/components/result-blocks/audit-composition";
import { RealJobPlan } from "@/src/client/components/result-blocks/real-job-plan";
import { SelectedBlocks } from "@/src/client/components/result-blocks/selected-blocks";
import { chooseAnalyticalBlocks } from "@/src/client/output-plan";
import { OUTPUT_PLAN_FIXTURES, outputPlanFixture } from "@/src/client/output-plan-fixtures";

// DEV-ONLY ROUTE — THE SELECTOR CHOOSING, FROM FIVE FIXTURES OR ONE REAL JOB.
//
// Same gate and same discipline as /dev/result-showcase: absent from a
// production build by a server-side notFound(). Where the showcase shows
// every block at once to display the language, this page shows
// `chooseAnalyticalBlocks` selecting — and declining — blocks from records
// that do not justify everything. The plan's own decisions are printed
// above the result so a reader can check the page against them.
//
// TWO MODES, ONE SELECTOR.
//
//   ?fixture=A..E  invented records, rendered on the server from constants.
//                  Touches no database, provider, model or research state.
//
//   ?job=<uuid>    a REAL completed Research, read in the browser through
//                  the same endpoint and the same session the result screen
//                  uses. This page adds no server route and no query of its
//                  own: ownership is enforced exactly where it always was,
//                  and the payload is the production response. It is a
//                  READ — no job is started, nothing is written.
//
// A real record is a HISTORICAL run. Its component statuses were reduced by
// the semantics in force when it ran, and engine rules move; the banner in
// that mode says so, because a stale status rendered confidently is exactly
// what this product must not ship.
export const dynamic = "force-dynamic";

export default async function DevOutputPlanPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  if (process.env.NODE_ENV === "production") notFound();
  const params = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  // ONE MORE PARAMETER, NOT ONE MORE PAGE. `view=verification` renders the
  // same record through the verification composition: same selector, same
  // plan, same blocks, a different order and a few small
  // verification-only blocks. `audit` is accepted as the older spelling.
  const raw = one(params.view);
  const view: "result" | "verification" = raw === "verification" || raw === "audit" ? "verification" : "result";
  const jobId = one(params.job);
  if (jobId) return <RealJobPage jobId={jobId} view={view} />;

  const fixture = outputPlanFixture(one(params.fixture));
  const plan = chooseAnalyticalBlocks(fixture.input);

  return (
    <main className="enter flex flex-col gap-4 pb-6" data-testid="output-plan-page">
      <section
        className="rounded-xl border px-3.5 py-2.5"
        style={{ borderColor: "rgba(251, 191, 36, 0.32)", background: "rgba(251, 191, 36, 0.07)" }}
        data-testid="fixture-banner"
      >
        <p className="text-[0.68rem] font-semibold uppercase tracking-[0.08em]" style={{ color: "#fcd34d" }}>
          Design fixture · not a real research result
        </p>
        <p className="mt-0.5 text-[0.7rem] leading-snug text-[var(--atlas-text-dim)]">
          Every value below is invented. This page shows which blocks the selector chose for an invented
          record, and which it declined.
        </p>
      </section>

      <nav className="flex flex-wrap gap-2" data-testid="fixture-picker">
        <ViewToggle view={view} href={(v) => `/dev/output-plan?fixture=${fixture.key}&view=${v}`} />
        {OUTPUT_PLAN_FIXTURES.map((f) => (
          <Link
            key={f.key}
            href={`/dev/output-plan?fixture=${f.key}&view=${view}`}
            className="rounded-lg border px-2.5 py-1 text-[0.72rem]"
            style={{
              borderColor: f.key === fixture.key ? "#5eead4" : "var(--hairline)",
              color: f.key === fixture.key ? "#5eead4" : "var(--atlas-text-dim)",
            }}
          >
            {f.key} · {f.title}
          </Link>
        ))}
      </nav>

      <details className="panel px-4 py-3 sm:px-5" data-testid="plan-summary">
        <summary className="eyebrow cursor-pointer" style={{ color: "var(--atlas-text-dim)" }}>
          Selector decision · fixture {fixture.key} · show
        </summary>
        <p className="mt-1 text-[0.78rem]">
          <span className="text-[var(--atlas-text-dim)]">Selected: </span>
          {plan.orderedBlocks.map((b) => b.type).join(" → ")}
        </p>
        <ul className="mt-1 text-[0.72rem] text-[var(--atlas-text-dim)]">
          {plan.rejected.map((r) => (
            <li key={r.type} data-testid="rejected-block">
              Not shown: {r.type} — {r.reason.replace(/_/g, " ").toLowerCase()}
            </li>
          ))}
          {plan.rejected.length === 0 && <li>Nothing declined.</li>}
        </ul>
      </details>

      {view === "verification" ? (
        <AuditCompositionView
          audit={composeAudit({ input: fixture.input, components: fixture.input.components, outcomeKind: "VERDICT", plan })}
          input={fixture.input}
          asOf="Fixture · no run"
        />
      ) : (
        <SelectedBlocks plan={plan} input={fixture.input} answer={fixture.answer} asOf="Fixture · no run" />
      )}
    </main>
  );
}

function ViewToggle({ view, href }: { view: "result" | "verification"; href: (v: "result" | "verification") => string }) {
  return (
    <span className="flex gap-1" data-testid="view-toggle">
      {(["result", "verification"] as const).map((v) => (
        <Link
          key={v}
          href={href(v)}
          className="rounded-lg border px-2.5 py-1 text-[0.72rem] uppercase tracking-[0.05em]"
          style={{
            borderColor: v === view ? "#c4b5fd" : "var(--hairline)",
            color: v === view ? "#c4b5fd" : "var(--atlas-text-dim)",
          }}
        >
          {v}
        </Link>
      ))}
    </span>
  );
}

// THE REAL-JOB MODE. A banner, then the bridge. Everything analytical is
// decided by the selector in the browser from the real payload; nothing on
// this page decides anything.
function RealJobPage({ jobId, view }: { jobId: string; view: "result" | "verification" }) {
  return (
    <main className="enter flex flex-col gap-4 pb-6" data-testid="output-plan-page">
      <section
        className="rounded-xl border px-3.5 py-2.5"
        style={{ borderColor: "rgba(251, 191, 36, 0.32)", background: "rgba(251, 191, 36, 0.07)" }}
        data-testid="real-job-banner"
      >
        <p className="text-[0.68rem] font-semibold uppercase tracking-[0.08em]" style={{ color: "#fcd34d" }}>
          Dev bridge · real completed research · historical record
        </p>
        <p className="mt-0.5 text-[0.7rem] leading-snug text-[var(--atlas-text-dim)]">
          Every value below is real and was produced by an earlier run. Its component statuses were
          reduced by the engine semantics in force at that time and are not re-derived here, so a row
          may differ from what the same evidence would yield today. This is a presentation test of
          block selection, not a current research finding.
        </p>
      </section>

      <nav className="flex flex-wrap gap-2" data-testid="fixture-picker">
        <ViewToggle view={view} href={(v) => `/dev/output-plan?job=${jobId}&view=${v}`} />
        <Link
          href="/dev/verification-showcase"
          className="rounded-lg border px-2.5 py-1 text-[0.72rem]"
          style={{ borderColor: "var(--hairline)", color: "var(--atlas-text-dim)" }}
        >
          Golden verification →
        </Link>
        <Link
          href="/dev/output-plan"
          className="rounded-lg border px-2.5 py-1 text-[0.72rem]"
          style={{ borderColor: "var(--hairline)", color: "var(--atlas-text-dim)" }}
        >
          ← Fixtures A–E
        </Link>
      </nav>

      <RealJobPlan jobId={jobId} view={view} />
    </main>
  );
}
