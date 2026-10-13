// RESEARCH-SCREEN STATES — DEVELOPMENT FIXTURES (invented, not a finding).
//
// One job record per state of the V7 research screen (docs/design/v7
// screenshots 02-research-1…9), shaped exactly like the fields the screen
// reads from a real job: state, progressStage, acquisitionPhase and the
// subject line. The project is a neutral placeholder, so nothing here can
// be mistaken for research about a real project. Rendered only by the dev
// route /dev/progress-states, which does not exist in a production build.

import type { StatusJob } from "./components/research-status";

const SUBJECT = {
  projectName: "Example Protocol",
  projectTicker: "EXP",
  projectSlug: null,
  originalQuestion: "Does Example Protocol use its fees to buy back EXP, and is that happening now?",
} as const;

export interface ProgressFixture {
  key: string;
  title: string;
  job: StatusJob;
}

export const PROGRESS_FIXTURES: readonly ProgressFixture[] = [
  { key: "1", title: "Queued", job: { ...SUBJECT, state: "QUEUED", progressStage: 1, acquisitionPhase: null } },
  { key: "2", title: "Running · searching", job: { ...SUBJECT, state: "RUNNING", progressStage: 3, acquisitionPhase: "SEARCHING" } },
  { key: "3", title: "Running · verifying", job: { ...SUBJECT, state: "RUNNING", progressStage: 4, acquisitionPhase: "EXTRACTING" } },
  { key: "4", title: "Succeeded", job: { ...SUBJECT, state: "SUCCEEDED", progressStage: 5, acquisitionPhase: null } },
  { key: "5", title: "Cancelled", job: { ...SUBJECT, state: "CANCELLED", progressStage: 3, acquisitionPhase: null } },
  { key: "6", title: "Awaiting clarification", job: { ...SUBJECT, state: "AWAITING_CLARIFICATION", progressStage: 1, acquisitionPhase: null } },
  { key: "7", title: "Budget limit", job: { ...SUBJECT, state: "BUDGET_LIMIT_REACHED", progressStage: 5, acquisitionPhase: null } },
  { key: "8", title: "Failed", job: { ...SUBJECT, state: "FAILED", progressStage: 4, acquisitionPhase: null } },
];

export function progressFixture(key: string | undefined): ProgressFixture {
  return PROGRESS_FIXTURES.find((f) => f.key === key) ?? PROGRESS_FIXTURES[2];
}

export const PROGRESS_FIXTURE_NOTICE = {
  title: "Development fixture",
  body: "Invented job states for reviewing the research screen. No research ran; nothing here is a finding.",
};
