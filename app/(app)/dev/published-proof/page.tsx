import { notFound } from "next/navigation";

import { resultFixture } from "@/src/client/result-surface-fixtures";

import { PublishedProofPreview } from "./view";

// DEV-ONLY ROUTE — THE PUBLISHED, READ-ONLY PROOF (HANDOFF §4.8).
//
// `?state=1..8` renders the SAME ResearchResult in `published` mode from
// the invented result fixtures, so the published presentation can be
// reviewed before Phase 3 brings real published Proofs. IT DOES NOT EXIST
// IN A PRODUCTION BUILD (server-side notFound), touches no database,
// provider, model or research state. No finding here is real.
export const dynamic = "force-dynamic";

export default async function DevPublishedProofPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  if (process.env.NODE_ENV === "production") notFound();
  const params = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  return <PublishedProofPreview fixtureKey={resultFixture(one(params.state)).key} />;
}
