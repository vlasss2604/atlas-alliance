// EXPLORE ATLAS PROOFS — THE SHOWCASE LIST (HANDOFF §4.1a).
//
// One entry per showcase project: the one researched question, and — only
// when the Founder has approved and published that project's Proof — the
// published verdict and the date it was checked. A project without an
// approved published Proof carries NO verdict: it reads "In quality review".
// The client never derives a verdict itself; it shows what the list says.
//
// THE REAL LIST DOES NOT EXIST YET. It will come from the server's
// `published_proofs` (Phase 3, D16): the Founder publishes a completed job
// by hand, one by one. Until then the development fixture
// (showcase-fixtures.ts) lets the screen be built and judged; a production
// build serves an empty list and Verify hides the section — nothing on a
// real user's screen claims a verdict no approved Proof backs.

import { SHOWCASE_DEV_FIXTURE } from "./showcase-fixtures";

export type ShowcaseText = { EN: string; RU: string };

export interface ShowcaseProof {
  slug: string;
  name: string;
  ticker: string | null;
  topic: ShowcaseText;
  question: ShowcaseText;
  // Present only for an approved, published Proof.
  published: {
    verdict: "SUPPORTED" | "PARTIALLY_SUPPORTED" | "INSUFFICIENT_EVIDENCE" | "NOT_SUPPORTED";
    checkedAt: string; // ISO date the research was completed
  } | null;
}

// Published first, then in review; within each, the given (Founder's) order.
export function orderShowcase(list: readonly ShowcaseProof[]): ShowcaseProof[] {
  return list
    .map((p, i) => ({ p, i }))
    .sort((a, b) => Number(b.p.published !== null) - Number(a.p.published !== null) || a.i - b.i)
    .map(({ p }) => p);
}

export function showcaseProofs(env: string | undefined = process.env.NODE_ENV): ShowcaseProof[] {
  return env === "production" ? [] : orderShowcase(SHOWCASE_DEV_FIXTURE);
}

// Where "Read the Proof" leads: the read-only published route (HANDOFF §4.8,
// built in step 5).
export function publishedProofPath(slug: string): string {
  return `/proofs/published/${encodeURIComponent(slug)}`;
}
