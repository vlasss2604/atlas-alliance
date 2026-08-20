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
  },
  research: {
    title: "Research",
    empty: "No research yet. Ask ARI your first question.",
    stages: [
      "Understanding the question",
      "Checking accumulated experience",
      "Searching for missing evidence",
      "Weighing the evidence",
      "Building the Proof",
    ],
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
