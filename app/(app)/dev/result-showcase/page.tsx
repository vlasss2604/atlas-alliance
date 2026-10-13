import { notFound } from "next/navigation";

import { ResultShowcase } from "@/src/client/components/result-blocks/result-showcase";

// DEV-ONLY ROUTE — THE RESULT PRESENTATION SHOWCASE.
//
// A design fixture for judging the STRUCTURE of an ATLAS result before the
// presentation language is wired to the engine. It renders every analytical
// block at once from invented values.
//
// IT DOES NOT EXIST IN A PRODUCTION BUILD. The gate is a server-side
// `notFound()` rather than a hidden link, because a page full of
// confident-looking invented figures must not be reachable by anyone who
// guesses the URL on a deployed instance.
//
// IT TOUCHES NOTHING. No database read or write, no provider or model call,
// no research job, no persisted state — the route renders a constant. It is
// therefore absent from research history by construction rather than by
// filtering, since no history row was ever created.
export const dynamic = "force-dynamic";

export default function DevResultShowcasePage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <ResultShowcase />;
}
