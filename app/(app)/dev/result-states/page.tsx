import Link from "next/link";
import { notFound } from "next/navigation";

import { ResearchResult } from "@/src/client/components/research-result";
import { RESULT_FIXTURE_NOTICE, RESULT_FIXTURES, resultFixture } from "@/src/client/result-surface-fixtures";

// DEV-ONLY ROUTE — THE RESULT SURFACE, ONE PRESENTATION STATE AT A TIME.
//
// `?state=1..8` renders the SAME `ResearchResult` component the product
// page uses, from an invented detail payload shaped exactly like the
// production response. What is reviewed here is the surface: how a
// confirmed, partially confirmed, substantively unestablished, technically
// bounded, configuration-bounded, contradicted, documentary-plus-on-chain
// and evidence-heavy result each read. No finding here is real.
//
// IT DOES NOT EXIST IN A PRODUCTION BUILD (server-side notFound), touches
// no database, provider, model or research state, and renders constants.
export const dynamic = "force-dynamic";

export default async function DevResultStatesPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  if (process.env.NODE_ENV === "production") notFound();
  const params = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const fixture = resultFixture(one(params.state));

  return (
    <main className="enter flex flex-col gap-4 pb-6" data-testid="result-states-page">
      <section
        className="rounded-xl border px-3.5 py-2.5"
        style={{ borderColor: "rgba(226, 179, 79, 0.32)", background: "rgba(226, 179, 79, 0.07)" }}
        data-testid="fixture-banner"
      >
        <p className="text-[0.8rem] font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--atlas-amber)" }}>
          {RESULT_FIXTURE_NOTICE.title}
        </p>
        <p className="mt-0.5 text-[0.85rem] leading-snug text-[var(--atlas-text-dim)]">{RESULT_FIXTURE_NOTICE.body}</p>
      </section>

      <nav className="flex flex-wrap gap-2" data-testid="fixture-picker">
        {RESULT_FIXTURES.map((f) => (
          <Link
            key={f.key}
            href={`/dev/result-states?state=${f.key}`}
            className="rounded-lg border px-2.5 py-1 text-[0.82rem]"
            style={{
              borderColor: f.key === fixture.key ? "var(--atlas-cyan)" : "var(--hairline)",
              color: f.key === fixture.key ? "var(--atlas-cyan-strong)" : "var(--atlas-text-dim)",
            }}
          >
            {f.key} · {f.title}
          </Link>
        ))}
      </nav>

      <p className="px-1 text-[0.85rem] leading-snug text-[var(--atlas-text-dim)]" data-testid="fixture-note">
        <span className="font-medium text-[var(--atlas-text)]/80">State {fixture.key} · {fixture.title}.</span> {fixture.note}
      </p>

      <ResearchResult detail={fixture.detail} jobId={null} />
    </main>
  );
}
