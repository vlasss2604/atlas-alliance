import Link from "next/link";
import { notFound } from "next/navigation";

import { ResearchAudit } from "@/src/client/components/research-audit";
import { RESULT_FIXTURE_NOTICE, RESULT_FIXTURES, resultFixture } from "@/src/client/result-surface-fixtures";

// DEV-ONLY ROUTE — THE FULL AUDIT, ONE PRESENTATION STATE AT A TIME.
//
// `?state=1..8` renders the SAME `ResearchAudit` component the product
// route uses, from the same invented detail payload the result fixtures
// use, with no audit projection (so every point stands under its
// canonical label). What is reviewed here is the surface: the research
// points in the Result's own words, then the technical record beneath.
// No finding here is real.
//
// IT DOES NOT EXIST IN A PRODUCTION BUILD (server-side notFound), touches
// no database, provider, model or research state, and renders constants.
export const dynamic = "force-dynamic";

export default async function DevAuditStatesPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  if (process.env.NODE_ENV === "production") notFound();
  const params = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const fixture = resultFixture(one(params.state));

  return (
    <main className="enter flex flex-col gap-4 pb-6" data-testid="audit-states-page">
      <section
        className="rounded-xl border px-3.5 py-2.5"
        style={{ borderColor: "rgba(251, 191, 36, 0.32)", background: "rgba(251, 191, 36, 0.07)" }}
        data-testid="fixture-banner"
      >
        <p className="text-[0.8rem] font-semibold uppercase tracking-[0.08em]" style={{ color: "#fcd34d" }}>
          {RESULT_FIXTURE_NOTICE.title}
        </p>
        <p className="mt-0.5 text-[0.85rem] leading-snug text-[var(--atlas-text-dim)]">{RESULT_FIXTURE_NOTICE.body}</p>
      </section>

      <nav className="flex flex-wrap gap-2" data-testid="fixture-picker">
        {RESULT_FIXTURES.map((f) => (
          <Link
            key={f.key}
            href={`/dev/result-states/audit?state=${f.key}`}
            className="rounded-lg border px-2.5 py-1 text-[0.82rem]"
            style={{
              borderColor: f.key === fixture.key ? "#5eead4" : "var(--hairline)",
              color: f.key === fixture.key ? "#5eead4" : "var(--atlas-text-dim)",
            }}
          >
            {f.key} · {f.title}
          </Link>
        ))}
        <Link
          href={`/dev/result-states?state=${fixture.key}`}
          className="rounded-lg border border-[var(--hairline)] px-2.5 py-1 text-[0.82rem] text-[var(--atlas-cyan)]"
        >
          ← Result for state {fixture.key}
        </Link>
      </nav>

      <ResearchAudit jobId={null} detail={fixture.detail} projection={null} />
    </main>
  );
}
