export const en = {
  nav: {
    home: "Home",
    research: "Research",
    ask: "Ask ARI",
    projects: "Projects",
    profile: "Profile",
    // D-171: the short labels of the primary navigation.
    askShort: "Ask",
    primary: "Primary",
    // D-172: the three places of the product loop.
    pulse: "Pulse",
    verify: "Verify",
    proofs: "Proofs",
    // V7 header lockup, second line (HANDOFF D1; shown uppercase).
    tagline: "Crypto Verification · Economics",
  },
  home: {
    title: "ATLAS PROOF",
    subtitle: "Research Intelligence for Digital Assets",
    tagline: "Crypto Verification",
    demoCounter: (used: number, limit: number) =>
      `DEMO research used: ${used} of ${limit}`,
    coreActive: "ARI • CORE active",
    // D-170: a private-beta user's own allowance, from the server's count.
    betaLabel: "Private Beta",
    betaRemaining: (n: number) => `${n} Research remaining`,
    betaAccessFull: "Private beta access is currently full.",
    // D-171: the states in which a beta user cannot start a new Research.
    // Each points to the Research Library, which always stays open.
    betaAtCapacity: "Private beta is at capacity for now.",
    betaPaused: "Private beta is temporarily paused. Your previous Research is still available in your Research Library.",
    betaExhausted: (n: number) =>
      `You've used your ${n} private-beta Research. Your completed Research remains available in Research Library.`,
    betaInviteUnavailable: "This private beta invite is no longer available.",
    openLibrary: "Open Research Library",
    cta: "What do you want to understand?",
    previouslyResearched: "Previously researched",
    viewAll: "View all",
    recentEmpty: "Nothing researched yet — ask a question above and the project will appear here.",
  },
  ask: {
    title: "What do you want to understand?",
    placeholder: "Ask about a project, token, or market mechanism…",
    helper: "Plain language is fine.",
    examplesTitle: "Example questions",
    // D-171: the private beta covers Raydium, Pump.fun and Lido; every
    // example names one of them, so none leads to a refusal or a question.
    examples: [
      "Does Raydium buy back RAY with its trading fees?",
      "Does the Pump.fun buyback reduce PUMP supply?",
      "Where do Lido staking rewards and fees go?",
    ],
    // The first step only reads the question; nothing starts yet.
    continue: "Continue",
    submit: "Start Proof",
    disabledNote:
      "Private beta is temporarily paused. Your previous Research is still available in your Research Library.",
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
    betaAccessRequired: "ATLAS PROOF is in private beta. Research needs a private beta invite.",
    betaProjectNotAvailable: "This project isn't in the private beta. The private beta covers Raydium, Pump.fun and Lido.",
    betaResearchLimitReached:
      "You've used all your private-beta Research. Your completed Research remains available in Research Library.",
    // D-170: the creator beta is full for everyone — never phrased as this
    // user's own allowance, never an upsell.
    globalBetaCapacity: "Private beta is at capacity for now. Your previous Research is still available in your Research Library.",
    error: "Couldn't process the question. Please try again.",
    newQuestion: "Ask another question",
    provisionalPrefix: "Understood so far:",
    clarifyAnswered: "This clarification was already answered in another window.",
    clarifyStale: "This question is already resolved. Ask a new one to continue.",
    checkOnProject: "Check this on a specific project",
    checkOnProjectDraft: "Check this on ",
    // A claim that arrived through the Telegram bot (research intake).
    intakeFrom: "From a Telegram message",
    intakeViewOriginal: "View original",
    intakeEditable: "Review or edit the question before starting.",
    intakeUnavailable: "That forwarded message is no longer available. Ask your question here.",
    intakeConsumed: "Research from that message has already been started. Ask a new question here.",
    intakeProjectNotAvailable: "{project} isn't in the private beta. The private beta covers Raydium, Pump.fun and Lido.",
  },
  research: {
    // THE RESEARCH LIBRARY (D-169): finished Research belongs to the user
    // and reopening it is a pure read — never another Research.
    title: "Research Library",
    subtitle: "Everything ATLAS has verified for you, grouped by project.",
    keepNote: "Your completed Research stays here. Reopening it never uses another Research.",
    loading: "Loading…",
    inProgress: "In progress",
    projectsResearched: "Projects researched",
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
        EXECUTION_NOT_STATED: "does not report a completed execution",
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
    // D-171: an account without any Research access today. No offer of a
    // plan or a DEMO allowance that cannot be used.
    noAccess: "Research is currently available by private beta invite.",
    priceNote: (stars: number) => `ARI • CORE — ${stars} Stars / month`,
    privacy: "Privacy",
    privacyNote: "Your Proofs are private by default.",
    help: "Help",
    deleteAccount: "Delete account",
    // Describes what the deletion does today: the account and everything
    // owned by it go; shared sources and project-level Research Memory are
    // not personal records and stay.
    deleteConfirm1: "Delete your account? Your Research and history will be removed. Shared sources and project-level Research Memory are not personal and remain.",
    deleteConfirm2: "This cannot be undone. Confirm deletion?",
    deleted: "Account deleted.",
  },
  // D-170: the one-time private-beta feedback prompt. Optional; skipping
  // is permanent and costs nothing.
  feedback: {
    title: "Help shape ATLAS",
    intro: "Two minutes, optional. It never affects your Research.",
    useful: "What was useful?",
    missing: "What was missing or what would you add?",
    keepUsing: "Would you keep using ATLAS?",
    yes: "Yes",
    no: "No",
    unsure: "Not sure",
    changeNeeded: "If not, what would need to change?",
    send: "Send feedback",
    requiredHint: "Answer “Would you keep using ATLAS?” to send.",
    banner: "Two quick questions about ATLAS — below your result.",
    skip: "Skip",
    thanks: "Thank you — your feedback was sent.",
    error: "Couldn't send. Please try again.",
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
  // D-171: every remaining creator-beta surface reads its copy from here.
  // English is the canonical default; Russian mirrors it key for key.
  // D-172: Pulse — fresh claims worth verifying. Discovery only; the
  // source text itself is never translated.
  pulse: {
    title: "Pulse",
    subtitle: "Fresh crypto claims worth verifying, selected from X.",
    note: "Pulse is for discovery only. Nothing here is verified until you run a Research.",
    fresh: "Last 48 hours",
    earlier: "Earlier",
    empty: "No new claims in the last 48 hours.",
    sourceTypes: { OFFICIAL_PROJECT: "Official", RESEARCH_DATA: "Research & data" } as Record<string, string>,
    sourceX: "X",
    verify: "Verify",
    openOnX: "Open on X",
    // On the Verify screen, when it was opened from a Pulse card.
    fromPulse: (handle: string) => `From Pulse · ${handle}`,
    fromPulseEditable: "Review or edit the claim before you continue.",
    unavailable: "That Pulse item is no longer available. Ask your question here.",
    // Phase A: the offline cards are invented examples, said so on screen.
    sampleTitle: "Sample data · prototype",
    sampleBody: "These cards are invented examples of the claims Pulse is meant to carry. They are not real posts.",
  },
  composer: {
    title: "What do you want to verify?",
    subtitle: "Ask about a project, a token, a claim or a link.",
    placeholder: "Ask or paste a link…",
    tryAsking: "Try asking",
  },
  // V7 — "Explore ATLAS Proofs" on Verify (HANDOFF §4.1a, §5a): the
  // published read-only Proofs, free to read.
  explore: {
    title: "Explore ATLAS Proofs",
    free: "Free to read",
    sub: "Real research you can open before running your own. Reading a Proof never uses a Research.",
    checked: "Checked",
    read: "Read the Proof",
    inReview: "In quality review · coming soon",
    note: "Checked on a date means what the evidence showed then, not that it holds now.",
  },
  // V7 — a published read-only Proof (HANDOFF §4.8, §5a).
  published: {
    label: "Published Proof · read-only",
    bannerTitle: "Published by ATLAS · free to read",
    bannerText: "A real research run, reviewed before publishing. Reading it does not use a Research.",
    dateNote: (date: string) => `Checked ${date}. The verdict describes the evidence on that date, not the state today.`,
    ownCta: "Run your own verification",
    ownNote: "Starts a new Research and uses one of your attempts — only after you confirm.",
    // Owner-approved 2026-10-13: a published route with no published
    // Proof behind it yet.
    unavailableTitle: "This Proof isn't published yet",
    unavailableText: "It is still in quality review. Nothing is shown until an approved Proof exists.",
  },
  progress: {
    title: "Research process",
    // Keyed by the presentation stage (research-model RESEARCH_STAGES);
    // PLANNING is the second stage while Research Memory is off.
    stages: {
      UNDERSTANDING: "Understanding the question",
      MEMORY: "Checking previous research",
      PLANNING: "Planning the research",
      SEARCH: "Searching sources",
      FETCH: "Reading evidence",
      EXTRACT: "Verifying the mechanism",
      VERDICT: "Building the answer",
    } as Record<string, string>,
    // V7 research screen (HANDOFF §4.2, §5).
    foundNote: "A found source isn't evidence yet. ATLAS reads it first and checks what it actually supports.",
    doneSub: "Your Proof has the verdict, confidence, evidence, sources and honest gaps.",
    failedTitle: "Couldn't finish this research",
    failedSub: "This is a failure of the run, not a finding about the project.",
    failedChip: "Your attempt wasn't spent",
    cancelledSub: "The research stopped before an answer. This is not a finding about the project.",
    // Owner-approved 2026-10-13: the Stop confirmation.
    cancelConfirm: "Stop the research? It will end now, before an answer.",
    // A budget-limited run that has a Proof opens it from the status screen.
    openProof: "Open Proof",
    tags: { now: "now", waiting: "waiting for you" },
    next: {
      title: "What happens next",
      ready: { title: "Proof is ready", text: "The result opens right on this screen." },
      clarify: { title: "Needs a clarification", text: "ARI asks one question — the research continues after your answer." },
      budget: { title: "Budget limit", text: "You get an honest result: what it managed to check." },
      failure: { title: "Failure", text: "Your attempt isn't spent. An unfinished check doesn't mean the mechanism is missing." },
    },
  },
  detailPage: {
    back: "Back",
    loading: "Loading…",
    loadError: "This research could not be loaded.",
    researching: "Researching",
    inProgress: "Research in progress",
    leaveNote: "You can leave this screen. ATLAS keeps working and the result will be here when you come back.",
    unresolvedProject: "Unresolved project",
    checked: (date: string) => `Checked ${date}`,
  },
  history: {
    runs: (n: number): string => `${n} ${n === 1 ? "run" : "runs"}`,
    questions: (n: number): string => `${n} questions`,
    lastResearched: (age: string): string => `last researched ${age}`,
  },
  // Keyed by research-model's OutcomeView.kind and by the verdict code.
  outcome: {
    IN_PROGRESS: "In progress",
    FAILED: "Research failed",
    CANCELLED: "Cancelled",
    STOPPED_AT_LIMIT: "Stopped early",
    NO_CONCLUSION: "No conclusion",
  } as Record<string, string>,
  verdict: {
    SUPPORTED: "Supported",
    PARTIALLY_SUPPORTED: "Partially supported",
    NOT_SUPPORTED: "Not supported",
    INSUFFICIENT_EVIDENCE: "Insufficient evidence",
    NOT_APPLICABLE: "Not applicable",
  } as Record<string, string>,
  // The Result screen's own words. Sentences built from the evidence and
  // the research record (answer, row facts, question labels, evidence
  // excerpts) are not here: they come from the record, not the interface.
  result: {
    label: "Research result",
    confidence: (word: string) => `${word} confidence`,
    // Keyed by the English confidence word result-surface returns.
    confidenceWords: { Low: "Low", Limited: "Limited", Strong: "Strong", "Very strong": "Very strong" } as Record<string, string>,
    figures: {
      checks: (n: number): string => (n === 1 ? "check" : "checks"),
      sources: (n: number): string => (n === 1 ? "source" : "sources"),
      items: (n: number): string => (n === 1 ? "evidence item" : "evidence items"),
      verified: "verified",
    },
    checkedOn: (date: string) => `Checked ${date}`,
    // Keyed by the evidence card's date label.
    dateLabels: { Published: "Published", Observed: "Observed", Checked: "Checked" } as Record<string, string>,
    newest: (label: string, date: string) => `Newest source ${label.toLowerCase()} ${date}`,
    pathTitle: "What the research followed",
    // English names the design step by the question's own mechanism noun
    // ("Buyback", "Burn"); a language without that noun table uses pathWords.
    pathNounFromQuestion: true as boolean,
    pathAria: "Research path",
    pathWords: {
      SOURCE_OF_VALUE: "Revenue",
      FLOW_PATH: "Flow",
      MECHANISM_SPEC: "Design",
      GOVERNANCE_BASIS: "Approval",
      CURRENT_STATE: "Active now",
      EXECUTION_EVIDENCE: "Execution",
      DESTINATION: "Where it goes",
      RECIPIENT: "Recipient",
      NET_EFFECT: "Supply impact",
      DURABILITY_BASIS: "Durability",
    } as Record<string, string>,
    checkedTitle: "What ATLAS checked",
    // The heading over each sentence of the answer, keyed by the branch
    // that wrote it (result-surface AnswerKind). The sentence itself is
    // unchanged; the heading only names which kind of statement it is.
    answerHeadings: {
      CONTRADICTED: "What the evidence contradicts",
      CONFIRMED: "What is confirmed",
      PARTIAL: "What is not fully confirmed",
      OPEN: "What is still unclear",
    } as Record<string, string>,
    counts: { CONFIRMED: "verified", PARTIAL: "partly", NOT_ESTABLISHED: "unresolved", CONTRADICTED: "contradicted" } as Record<string, string>,
    stateWords: { CONFIRMED: "Verified", PARTIAL: "Partly verified", NOT_ESTABLISHED: "Unresolved", CONTRADICTED: "Contradicted" } as Record<string, string>,
    stateFrom: (word: string, kind: string) => `${word} from ${kind}`,
    stateBy: (word: string, kind: string) => `${word} by ${kind}`,
    stateWith: (word: string, kind: string) => `${word} · ${kind}`,
    // Keyed by the English source-class label (research-model SOURCE_CLASS_LABELS).
    sourceKinds: {
      "Official docs": "official docs",
      Governance: "governance",
      "On-chain": "on-chain",
      "Official report": "official report",
      "Data provider": "data provider",
      "Research media": "research media",
      Social: "social",
      Unclassified: "unclassified",
    } as Record<string, string>,
    // The source-kind chip on an evidence card, keyed like sourceKinds.
    sourceKindChips: {
      "Official docs": "Official docs",
      Governance: "Governance",
      "On-chain": "On-chain",
      "Official report": "Official report",
      "Data provider": "Data provider",
      "Research media": "Research media",
      Social: "Social",
      Unclassified: "Unclassified",
    } as Record<string, string>,
    alsoConfirmed: "Also confirmed:",
    and: "and",
    hideEvidence: "Hide evidence",
    evidenceCount: (n: number) => `Evidence · ${n}`,
    noQualifyingSource: "No qualifying source",
    evidenceBehind: "Evidence behind this answer",
    sourcesCount: (n: number) => `${n} ${n === 1 ? "source" : "sources"}`,
    evidenceTitle: "Evidence",
    sourcesBehind: (n: number): string => `${n} ${n === 1 ? "source" : "sources"} behind the answer`,
    contradicts: "Contradicts",
    hideExcerpt: "Hide excerpt",
    viewExcerpt: "View excerpt",
    openOriginal: "Open original",
    snapshot: "Snapshot",
    unclearTitle: "What remains unclear",
    // D-171: plain words for the research boundary. The kind (and every
    // canonical reason behind it) is unchanged; only the wording is.
    unclearHeadings: {
      TECHNICAL: "Not every source could be checked",
      CONFIGURATION: "No supported source for this yet",
      SUBSTANTIVE: "Checked, not found",
    } as Record<string, string>,
    unclearCopy: {
      TECHNICAL: "This Research stopped before all relevant sources could be checked.",
      CONFIGURATION: "ATLAS doesn't yet have a supported source that can independently verify this point.",
      SUBSTANTIVE: "The available evidence does not settle this.",
    } as Record<string, string>,
    technicalRemaining: (n: number) =>
      `This Research stopped before ${n} known relevant ${n === 1 ? "source" : "sources"} could be checked.`,
    unclearNever: {
      TECHNICAL: "This is a limit of the research run, not a finding about the project.",
      CONFIGURATION: "This is a limit of what ATLAS can currently verify, not a finding that the mechanism is not executing.",
      SUBSTANTIVE: "This describes the evidence checked, not proof that the thing is absent.",
    } as Record<string, string>,
    openAudit: "Open full audit",
    // V7 "What remains unclear" (HANDOFF §4.3, §5): one card per unresolved
    // link. The chip is boundaryOf(...).kind and nothing else.
    unclearSub: "Open a link to see what is missing and what would help.",
    unclearLabels: { what: "Not established", why: "Why", help: "What could help" },
    boundaryChips: {
      SUBSTANTIVE: "Checked, not established",
      TECHNICAL: "Not fully checked",
      CONFIGURATION: "No supported verification route",
    } as Record<string, string>,
    boundaryHints: {
      SUBSTANTIVE: "Sources were read; none establishes this.",
      TECHNICAL: "The run stopped before every relevant source was checked.",
      CONFIGURATION: "ATLAS has no supported route to verify this yet.",
    } as Record<string, string>,
    // One template per boundary kind until the Founder approves richer
    // wording (D13): a direction for further checking, never a promise.
    helpTemplates: {
      SUBSTANTIVE:
        "Evidence that carries this specific point for this mechanism; any such source would be read and weighed like the others — no source type guarantees the outcome.",
      TECHNICAL:
        "A re-run when budget allows: known relevant sources were not read yet. This is a limit of the research run, not a finding about the project.",
      CONFIGURATION:
        "A supported verification route for this point. This is a limit of what ATLAS can verify today, not a finding about the project; the link stays unverified, not disproved.",
    } as Record<string, string>,
    excludedToggle: (n: number) => `${n} ${n === 1 ? "source" : "sources"} found, not admitted`,
    excludedHide: "Hide",
    unclearClosing:
      "These describe the evidence checked, not proof that the thing is absent. What would help is a direction for further checking, not a guarantee.",
    evidenceRows: { establishes: "What this establishes", notEstablishes: "What this does not establish" },
  },
  // D-171: the full audit and the source snapshot — the rest of the Proof
  // journey. The record's own words (projection labels and summary,
  // excerpts, URLs, hashes, the engine codes under Developer details) are
  // shown as written; the sentences built from statuses and reason codes
  // follow the display language through i18n/result-ru.ts.
  audit: {
    back: "Back to result",
    preparing: "Preparing research audit…",
    prepareError: "Full audit could not be prepared.",
    title: (project: string) => `Full audit · ${project}`,
    recordFallback: "Research record",
    completed: (date: string) => `Research completed ${date}`,
    prepared: (date: string) => ` · audit prepared ${date}`,
    points: "Research points",
    technicalRecord: "Technical record",
    technicalNote: "Coverage, every source read, raw on-chain observations, exclusion reasons and the engine trace.",
    projectionFailed:
      "Audit labels could not be prepared, so research points are shown under their canonical names. The record itself is complete.",
    evidence: "Evidence",
    limit: "Limit",
    limitRemaining: (n: number) =>
      `The research limit was reached before ${n} known relevant ${n === 1 ? "source" : "sources"} could be checked.`,
    // Keyed by boundary kind; the same sentences as result-surface BOUNDARY_COPY / BOUNDARY_NEVER.
    boundaryCopy: {
      SUBSTANTIVE: "The available evidence does not settle this.",
      TECHNICAL: "The research limit was reached before all relevant sources could be checked.",
      CONFIGURATION: "ATLAS currently lacks a source route that can independently verify this point.",
    } as Record<string, string>,
    boundaryNever: {
      SUBSTANTIVE: "This describes the evidence checked, not proof that the thing is absent.",
      TECHNICAL: "This is a limit of the research run, not a finding about the project.",
      CONFIGURATION: "This is a limit of what ATLAS can currently verify, not a finding that the mechanism is not executing.",
    } as Record<string, string>,
    // Keyed by audit-model AuditSectionId.
    sections: {
      SUMMARY: "Audit summary",
      COVERAGE: "Research coverage",
      EVIDENCE_MAP: "Evidence map",
      SOURCE_REGISTER: "Source register",
      OPEN_QUESTIONS: "Open questions, conflicts and limitations",
      ONCHAIN: "On-chain verification",
      TRACE: "Research trace",
    } as Record<string, string>,
    // Captions under a count.
    stats: {
      points: "research points",
      confirmed: "confirmed",
      partial: "partially confirmed",
      contradicted: "contradicted",
      unresolved: "unresolved",
    },
    blockedNote: (n: number) =>
      `${n} of the unresolved ${n === 1 ? "check was" : "checks were"} blocked by source-access limitations rather than by missing evidence.`,
    sourcesLine: (used: number, notUsed: number, exclusions: number) =>
      `${used} ${used === 1 ? "source" : "sources"} used${notUsed > 0 ? `, ${notUsed} checked and not used` : ""}${
        exclusions > 0 ? ` · ${exclusions} evidence ${exclusions === 1 ? "item" : "items"} excluded on admission` : ""
      }.`,
    coverageBlocked: "ATLAS could not access the source this check required.",
    howFar: "How far the check got: ",
    evidenceLabel: "Evidence: ",
    evidenceCounts: (s: number, c: number, x: number) => `${s} supporting · ${c} conflicting · ${x} excluded`,
    items: (n: number) => `${n} ${n === 1 ? "item" : "items"}`,
    noAdmitted: "No admitted evidence",
    excludedCount: (n: number) => `${n} excluded`,
    whatEstablishes: "What this establishes: ",
    notClassified: "Not classified.",
    outsideScope: "Outside its scope: ",
    notRecorded: "Not recorded.",
    legacyNote: "Legacy extractor note: ",
    excludedSummary: (n: number, domain: string) => `${n} ${n === 1 ? "item" : "items"} from ${domain} not admitted here`,
    sourcesUsed: "Sources used",
    checkedNotUsed: "Checked but not used",
    retrieved: (date: string) => ` · retrieved ${date}`,
    contributedTo: "Contributed to: ",
    sourceRole: "Source role: ",
    sourceLimit: "Source limit: ",
    notUsedDefault: "Read during research; no research point relied on it.",
    viewSnapshot: "View source snapshot",
    // Keyed by audit-model AuditOpenItemKind.
    openItemTitles: {
      CONFLICT: "Conflict",
      TECHNICAL_LIMITATION: "Research limitation",
      OPEN_EVIDENCE_QUESTION: "Evidence gap",
    } as Record<string, string>,
    neededToResolve: "Needed to resolve: ",
    traceCounts: (s: number, c: number, x: number) => `Supporting: ${s} · Conflicting: ${c} · Excluded: ${x}`,
    developerDetails: "Developer details",
  },
  snapshot: {
    unavailable: "No captured copy of this source is available.",
    eyebrow: "ATLAS source snapshot",
    captured: (date: string) => `Captured ${date}`,
    technical: "Technical details",
    rows: {
      type: "Type",
      response: "Response",
      size: "Size",
      captured: "Captured",
      retrievedFrom: "Retrieved from",
      landedOn: "Landed on",
      contentHash: "Content hash",
      textHash: "Text hash",
    },
    bytes: (n: string) => `${n} bytes`,
    capturedContent: "Captured content",
    extractedText: "Extracted text snapshot",
    showDocument: "Show as document",
    showExact: "Show exact captured text",
    flatNote:
      "This is the text representation ATLAS captured from the page. The original page structure was not preserved in this snapshot.",
    relevantExcerpt: "Relevant excerpt",
    hideFull: "Hide full captured text",
    showFull: "Show full captured text",
    characters: (n: string) => `(${n} characters)`,
    truncated: (shown: string, full: string) =>
      `Shown up to ${shown} of ${full} characters. The hashes above cover the whole capture.`,
    // What was actually preserved, keyed by the snapshot's representation.
    representation: {
      MARKDOWN_SOURCE:
        "Captured representation of the source ATLAS retrieved, and the one this research read. It is a preserved copy of the document, not the live page.",
      EXTRACTED_TEXT:
        "Captured representation of the source ATLAS retrieved, and the one this research read — the text extracted from the page. Layout, images and navigation were not kept, so this is not the page as it appears in a browser.",
      TEXT: "Captured representation of the source ATLAS retrieved, and the one this research read. It is a preserved copy, not the live page.",
    } as Record<string, string>,
  },
  common: { loading: "Loading…" },
};
export type Dict = typeof en;
