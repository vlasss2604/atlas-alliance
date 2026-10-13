import { notFound } from "next/navigation";

import { progressFixture } from "@/src/client/progress-fixtures";

import { ProgressStatesView } from "./view";

// DEV-ONLY ROUTE — THE RESEARCH SCREEN, ONE STATE AT A TIME.
//
// `?state=1..8` renders the SAME status, rail and "what happens next"
// components the product page uses, from an invented job record. What is
// reviewed here is the surface. IT DOES NOT EXIST IN A PRODUCTION BUILD
// (server-side notFound), touches no database, provider, model or research
// state, and renders constants. Stop does nothing here.
export const dynamic = "force-dynamic";

export default async function DevProgressStatesPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  if (process.env.NODE_ENV === "production") notFound();
  const params = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  return <ProgressStatesView fixtureKey={progressFixture(one(params.state)).key} />;
}
