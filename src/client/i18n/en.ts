export const en = {
  nav: {
    home: "Home",
    research: "Research",
    ask: "Ask ARI",
    projects: "Projects",
    profile: "Profile",
  },
  home: {
    title: "ATLAS PROOF",
    subtitle: "Research Intelligence for Digital Assets",
    demoCounter: (used: number, limit: number) =>
      `DEMO research used: ${used} of ${limit}`,
    coreActive: "ARI • CORE active",
    cta: "What do you want to understand?",
  },
  ask: {
    title: "What do you want to understand?",
    placeholder: "Ask about a project, token, or market mechanism…",
    helper: "Plain language is fine.",
    examplesTitle: "Example questions",
    examples: [
      "What could make this token more valuable?",
      "The project earns a lot. Do token holders benefit from it?",
      "What looks strong in this project, and what could be a weak point?",
      "What important things might I be missing?",
    ],
    submit: "Start Proof",
    disabledNote:
      "ARI is being connected — research will be available in an upcoming update.",
    // Фаза 4. Copy предложен реализацией; финальное утверждение — за
    // владельцем после просмотра реальных состояний UI.
    thinking: "ARI is reading your question…",
    understoodTitle: "Here is what I will research",
    assumptionsTitle: "Your assumptions I will test",
    clarifyTitle: "One question before I start",
    clarifyProjectFallback: "Which project or token do you mean?",
    clarifyPlaceholder: "Your answer…",
    clarifySubmit: "Send",
    clarifyLimit:
      "I couldn't define the research task precisely enough. Try asking a new question.",
    quickTitle: "Understood. This is an explanation, not a Proof.",
    outOfScope:
      "ATLAS researches how digital assets capture value — that question is outside what it can verify today. Try asking about a token's value mechanism.",
    invalid:
      "I couldn't find a research task in that. Try describing what you want to understand.",
    coreRequired: "This research requires ARI • CORE.",
    quotaExhausted: "Your DEMO research is used up. ARI • CORE removes the limit.",
    activeJob: "One research is already running. It will finish shortly.",
    error: "Couldn't process the question. Please try again.",
    newQuestion: "Ask another question",
    provisionalPrefix: "Understood so far:",
    clarifyAnswered: "This clarification was already answered in another window.",
    clarifyStale: "This question is already resolved. Ask a new one to continue.",
    checkOnProject: "Check this on a specific project",
    checkOnProjectDraft: "Check this on ",
  },
  research: {
    title: "Research",
    empty: "No research yet. Ask ARI your first question.",
    // Human-readable состояния: предложены планом Фазы 3 §6; финальное
    // утверждение copy — за владельцем до public release.
    states: {
      QUEUED: "Atlas is picking this up",
      AWAITING_CLARIFICATION: "Needs a clarification",
      SUCCEEDED: "Proof is ready",
      CANCELLED: "Stopped by you",
      FAILED: "Couldn't finish this research. Your attempt wasn't spent",
      BUDGET_LIMIT_REACHED: "Research hit its budget limit — showing an honest result",
    } as Record<string, string>,
    cancel: "Stop",
    stages: [
      "Understanding the question",
      "Checking accumulated experience",
      "Searching for missing evidence",
      "Weighing the evidence",
      "Building the Proof",
    ],
    detail: {
      loading: "Loading result…",
      error: "Couldn't load this result.",
      findingTitle: "Finding",
      mechanismTitle: "How it works",
      evidenceTitle: "Evidence",
      sourcesTitle: "Sources",
      noEvidence: "No evidence was admitted for this research.",
      // Shown when the displayed finding has NO structurally linked
      // supporting evidence. This section previously rendered the job's
      // entire evidence table, so an "insufficient evidence" finding could
      // appear to be backed by evidence belonging to another component.
      noSupportingEvidence: "No supporting evidence was established for this finding.",
      contradictingTitle: "Contradicting evidence",
      excludedTitle: "Considered but not admitted",
      excludedNote: "These were found but not admitted as proof for this finding:",
      exclusionLabel: {
        WRONG_COMPONENT: "belongs to a different component",
        WRONG_PROJECT: "belongs to a different project",
        LEGACY_CONTRACT_VERSION: "superseded evidence contract version",
        CLASS_NOT_ADMISSIBLE: "source class not admissible for this component",
        DIRECTNESS_INSUFFICIENT: "too indirect to establish the claim",
        RELATIONSHIP_NOT_SUPPORTING: "does not support the claim",
        NOT_CURRENT_STATE_BEARING: "does not carry current state",
        MISSING_PUBLICATION_DATE: "no publication date",
        STALE_FOR_CURRENT_STATE: "too old to establish current state",
        SUPERSEDED_BY_NEWER: "superseded by a newer source",
        DUPLICATE_UNIT: "duplicate of material already counted",
        ENTITY_NOT_CONFIRMED: "not confirmed to be about this asset",
      } as Record<string, string>,
      stepsTraced: (steps: number, components: number) =>
        `${steps} research step${steps === 1 ? "" : "s"} attempted, ${components} component${
          components === 1 ? "" : "s"
        } checked.`,
      debugTitle: "Research Debug",
      statusLabel: {
        SUPPORTED: "Supported by the evidence",
        PARTIALLY_SUPPORTED: "Partially supported by the evidence",
        NOT_SUPPORTED: "Not supported by the evidence",
        INSUFFICIENT_EVIDENCE: "Insufficient evidence to answer this",
      } as Record<string, string>,
      terminationLabel: {
        BUDGET_EXHAUSTED: "Stopped because it hit its research budget",
        WORK_QUEUE_EXHAUSTED: "Finished checking everything it could reach",
        SYSTEM_OR_PROVIDER_FAILURE: "Stopped because of a technical failure",
        CAPABILITY_BOUNDARY_NO_ELIGIBLE_WORK: "Nothing eligible left to research",
      } as Record<string, string>,
    },
  },
  projects: {
    title: "Projects",
    locked: "Available with ARI • CORE",
  },
  profile: {
    title: "Profile",
    language: "Language",
    level: "Access level",
    priceNote: (stars: number) => `ARI • CORE — ${stars} Stars / month`,
    privacy: "Privacy",
    privacyNote: "Your Proofs are private by default.",
    help: "Help",
    deleteAccount: "Delete account",
    deleteConfirm1: "Delete your account? Your research history will be removed.",
    deleteConfirm2: "This cannot be undone. Confirm deletion?",
    deleted: "Account deleted.",
  },
  onboarding: {
    skip: "Skip",
    next: "Next",
    start: "Start",
    screens: [
      {
        title: "ATLAS PROOF",
        body: "Research Intelligence for Digital Assets. ARI investigates how digital assets actually capture value — for anyone who wants evidence instead of opinions.",
      },
      {
        title: "How it works",
        body: "Ask a question in plain language. ARI researches it and builds a Proof: verdict, confidence, evidence, sources, and honest gaps.",
      },
      {
        title: "How ARI grows",
        body: "ATLAS develops through verified research experience: projects, topics, connections, scenarios.",
      },
    ],
  },
  common: { loading: "Loading…" },
};
export type Dict = typeof en;
