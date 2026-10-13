import Link from "next/link";
import { notFound } from "next/navigation";

import { composeAudit } from "@/src/client/audit-composition";
import { AuditCompositionView } from "@/src/client/components/result-blocks/audit-composition";
import { chooseAnalyticalBlocks } from "@/src/client/output-plan";
import { GOLDEN_AUDIT_FIXTURE } from "@/src/client/output-plan-fixtures";

// DEV-ONLY ROUTE — THE GOLDEN VERIFICATION.
//
// What verification can express when the record supports it: an invented,
// balanced record with every state verification has to present, structured
// enough that the SAME selector justifies four metrics, a flow, a table, a
// chart and a timeline. Next to it, the real historical job at
// /dev/output-plan?job=…&view=verification is the sparsity test — the same
// composition, constrained by what its evidence actually holds.
//
// Same gate and same discipline as /dev/result-showcase: absent from a
// production build by a server-side notFound(), touches no database,
// provider, model or research state, and renders constants.
export const dynamic = "force-dynamic";

const REAL_SPARSE_JOB = "1302b67e-273d-4a38-b02c-78c9d8155a77";

export default function DevVerificationShowcasePage() {
  if (process.env.NODE_ENV === "production") notFound();
  const f = GOLDEN_AUDIT_FIXTURE;
  const plan = chooseAnalyticalBlocks(f.input);
  const audit = composeAudit({
    input: f.input,
    components: f.auditComponents ?? f.input.components,
    outcomeKind: "VERDICT",
    plan,
  });

  return (
    <main className="enter flex flex-col gap-4 pb-6" data-testid="verification-showcase-page">
      <section
        className="rounded-xl border px-3.5 py-2.5"
        style={{ borderColor: "rgba(251, 191, 36, 0.32)", background: "rgba(251, 191, 36, 0.07)" }}
        data-testid="fixture-banner"
      >
        <p className="text-[0.68rem] font-semibold uppercase tracking-[0.08em]" style={{ color: "#fcd34d" }}>
          Golden verification · design fixture · not a real research result
        </p>
        <p className="mt-0.5 text-[0.7rem] leading-snug text-[var(--atlas-text-dim)]">
          Every value below is invented. This page shows what verification can express when the record
          supports it; the real historical job shows the same composition constrained by its evidence.
        </p>
      </section>

      <nav className="flex flex-wrap gap-2" data-testid="fixture-picker">
        <span className="rounded-lg border px-2.5 py-1 text-[0.72rem]" style={{ borderColor: "#c4b5fd", color: "#c4b5fd" }}>
          Golden verification
        </span>
        <Link
          href={`/dev/output-plan?job=${REAL_SPARSE_JOB}&view=verification`}
          className="rounded-lg border px-2.5 py-1 text-[0.72rem]"
          style={{ borderColor: "var(--hairline)", color: "var(--atlas-text-dim)" }}
        >
          Real sparse verification →
        </Link>
        <Link
          href="/dev/result-showcase"
          className="rounded-lg border px-2.5 py-1 text-[0.72rem]"
          style={{ borderColor: "var(--hairline)", color: "var(--atlas-text-dim)" }}
        >
          Golden research result
        </Link>
      </nav>

      <AuditCompositionView audit={audit} input={f.input} asOf="Fixture · no run" />
    </main>
  );
}
