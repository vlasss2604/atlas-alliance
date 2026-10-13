// PULSE — PHASE A OFFLINE FIXTURES (D-172).
//
// Pulse is a curated feed of fresh crypto claims from X that are worth
// verifying. It is DISCOVERY INPUT ONLY: a card is never a Source, never
// Evidence, never a Proof, never an ATLAS endorsement. The only way a card
// changes anything is the user tapping Verify, which prefills the existing
// Verify (Home) input with the text, verbatim and editable; Research starts
// only through the unchanged explicit start flow.
//
// SAMPLE DATA, SAID SO. Every card below is an invented example written to
// look like the posts the live feed is meant to carry — realistic
// subjects (fees, buybacks, burns, staking economics, treasury flows,
// governance execution), real project and account identities — so the
// screen can be judged as a product. The TEXT and NUMBERS are not real
// posts. No post id, no x.com/…/status URL and no "Open on X" exist here,
// because inventing provenance is exactly what this product must never do:
// `sourceUrl` is null on every fixture and the card renders a link only
// when a genuine one exists.
//
// NO X API, no worker, no scheduler, no table, no model call. Live
// ingestion is a separate Founder decision (Phase C).

export type PulseSourceType = "OFFICIAL_PROJECT" | "RESEARCH_DATA";

export interface PulseItem {
  // Stable local id; the only thing that travels in a URL (`?pulse=<id>`).
  id: string;
  project: { slug: string | null; name: string; ticker: string | null };
  source: { displayName: string; handle: string; type: PulseSourceType };
  // The source text, verbatim. Never summarised, never paraphrased.
  text: string;
  // Age at render, in hours — the fixture models freshness, not a date.
  ageHours: number;
  // A genuine post URL when one exists. Always null for a fixture.
  sourceUrl: string | null;
  // V7 claim-led card (HANDOFF §4.6): the question a Research would answer
  // about this claim, in both display languages. Fixture data, not i18n —
  // ATLAS's framing of the claim, never a summary of it.
  // Optional: a card without one prefills its claim text instead.
  verifyQuestion?: { EN: string; RU: string };
}

// The intended live window: a card is "fresh" for about 48 hours; older
// cards, if shown at all, sit under a separate "Earlier" heading. 8–12 is
// a cap and the normal size of a good day — never a minimum.
export const PULSE_FRESH_HOURS = 48;
export const PULSE_MAX_FRESH = 12;
export const PULSE_MAX_EARLIER = 8;

const PULSE_FIXTURES: readonly PulseItem[] = [
  {
    id: "raydium-buyback-week",
    project: { slug: "raydium", name: "Raydium", ticker: "RAY" },
    source: { displayName: "Raydium", handle: "@RaydiumProtocol", type: "OFFICIAL_PROJECT" },
    text: "12% of trading fees across all Raydium pools go to RAY buybacks. This week: 1.9M RAY bought on-market and sent to the buyback account.",
    ageHours: 3,
    sourceUrl: null,
    verifyQuestion: {
      EN: "Does the documented mechanism match actual execution?",
      RU: "Соответствует ли задокументированный механизм реальному исполнению?",
    },
  },
  {
    id: "lido-revenue-split",
    project: { slug: "lido", name: "Lido", ticker: "LDO" },
    source: { displayName: "Token Terminal", handle: "@tokenterminal", type: "RESEARCH_DATA" },
    text: "Lido 30-day protocol revenue is up 18% MoM. The protocol keeps 10% of staking rewards: 5% to the DAO treasury, 5% to node operators. None of it currently reaches LDO holders.",
    ageHours: 7,
    sourceUrl: null,
    verifyQuestion: {
      EN: "Is it established that none of this revenue reaches LDO holders?",
      RU: "Установлено ли, что эта выручка не доходит до держателей LDO?",
    },
  },
  {
    id: "pump-fun-daily-buybacks",
    project: { slug: "pump_fun", name: "Pump.fun", ticker: "PUMP" },
    source: { displayName: "pump.fun", handle: "@pumpdotfun", type: "OFFICIAL_PROJECT" },
    text: "Buybacks are live: 25% of protocol revenue now goes to PUMP buybacks every day, executed on-chain from the fee wallet.",
    ageHours: 14,
    sourceUrl: null,
    verifyQuestion: {
      EN: "Is the daily buyback executing on-chain as claimed?",
      RU: "Исполняется ли ежедневный выкуп ончейн, как заявлено?",
    },
  },
  {
    id: "aave-weekly-buyback-executed",
    project: { slug: "aave", name: "Aave", ticker: "AAVE" },
    source: { displayName: "Aave", handle: "@aave", type: "OFFICIAL_PROJECT" },
    text: "The Aave Finance Committee executed the first $1M weekly AAVE buyback under the approved Aavenomics proposal. Purchased tokens are held in the Ecosystem Reserve.",
    ageHours: 26,
    sourceUrl: null,
    verifyQuestion: {
      EN: "Is the execution established, and where are the tokens held?",
      RU: "Установлено ли исполнение, и где хранятся токены?",
    },
  },
  {
    id: "jupiter-litterbox-buybacks",
    project: { slug: "jupiter", name: "Jupiter", ticker: "JUP" },
    source: { displayName: "DefiLlama", handle: "@DefiLlama", type: "RESEARCH_DATA" },
    text: "Jupiter routes 50% of protocol fees to JUP buybacks through the Litterbox trust. Cumulative buybacks passed $60M. No burn: bought tokens are locked for three years.",
    ageHours: 41,
    sourceUrl: null,
    verifyQuestion: {
      EN: "Buyback without a burn: what does it do to JUP supply?",
      RU: "Выкуп без сжигания: что это даёт предложению JUP?",
    },
  },
  {
    id: "jito-tiprouter-treasury",
    project: { slug: "jito", name: "Jito", ticker: "JTO" },
    source: { displayName: "Messari", handle: "@MessariCrypto", type: "RESEARCH_DATA" },
    text: "Jito's TipRouter sends 2.7% of MEV tips to the JTO DAO treasury and 0.3% to restakers. Treasury inflow was about $4.5M in Q3; nothing is distributed to JTO holders yet.",
    ageHours: 70,
    sourceUrl: null,
    verifyQuestion: {
      EN: "Does any of this flow reach JTO holders?",
      RU: "Доходит ли что-то из этого потока до держателей JTO?",
    },
  },
  {
    id: "lido-dual-governance-vote",
    project: { slug: "lido", name: "Lido", ticker: "LDO" },
    source: { displayName: "Lido", handle: "@LidoFinance", type: "OFFICIAL_PROJECT" },
    text: "The DAO vote to activate Dual Governance passed with 94% in favour. The fee split stays 5% treasury / 5% node operators; no change to LDO value accrual.",
    ageHours: 110,
    sourceUrl: null,
    verifyQuestion: {
      EN: "Does this decision change how LDO captures value?",
      RU: "Меняет ли это решение то, как LDO получает ценность?",
    },
  },
];

// The smallest existing production guard (the `/dev/*` showcases use the
// same check): sample cards exist only outside a production build. In
// production the feed is honestly empty until live Pulse exists.
export function pulseItems(): PulseItem[] {
  if (process.env.NODE_ENV === "production") return [];
  return [...PULSE_FIXTURES].sort((a, b) => a.ageHours - b.ageHours);
}

export function pulseItemById(id: string): PulseItem | null {
  return pulseItems().find((item) => item.id === id) ?? null;
}

// Newest first inside each group; fresh and earlier never mix.
export function splitPulseFeed(items: readonly PulseItem[]): { fresh: PulseItem[]; earlier: PulseItem[] } {
  const sorted = [...items].sort((a, b) => a.ageHours - b.ageHours);
  return {
    fresh: sorted.filter((i) => i.ageHours <= PULSE_FRESH_HOURS).slice(0, PULSE_MAX_FRESH),
    earlier: sorted.filter((i) => i.ageHours > PULSE_FRESH_HOURS).slice(0, PULSE_MAX_EARLIER),
  };
}

// WHAT A PULSE CARD PUTS IN THE VERIFY FIELD (owner decision, step 8
// review): its verify question in the display language — the question a
// Research would answer — and, only when the card has none, the claim text
// verbatim. Either way it is editable and starts nothing; the claim itself
// is shown above the field as context.
export function pulsePrefill(item: PulseItem, language: "EN" | "RU"): string {
  const question = item.verifyQuestion?.[language]?.trim();
  return question ? question : item.text;
}

// The instant a fixture "was published", derived from its age at render.
export function pulsePublishedAt(item: PulseItem, now = Date.now()): string {
  return new Date(now - item.ageHours * 60 * 60 * 1000).toISOString();
}
