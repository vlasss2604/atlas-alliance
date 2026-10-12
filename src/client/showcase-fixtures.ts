// EXPLORE ATLAS PROOFS — DEVELOPMENT FIXTURE (sample DATA, not a finding).
//
// The designer's sample values for the showcase strip (docs/design/v7,
// HANDOFF §6: "only Raydium is published with 'Partially supported ·
// Checked 1 Oct 2026'; the other four are in review"). They exist so the
// Verify screen can be built and judged before the server's
// `published_proofs` list exists (Phase 3). `showcaseProofs()` never serves
// them in a production build. Like the Pulse fixtures, this file is data,
// not a code path that knows a project.

import type { ShowcaseProof } from "./showcase-proofs";

// The Founder's project order (HANDOFF §1.10). Aave is the reserve.
export const SHOWCASE_DEV_FIXTURE: readonly ShowcaseProof[] = [
  {
    slug: "raydium",
    name: "Raydium",
    ticker: "RAY",
    topic: { EN: "Buybacks & fees", RU: "Выкуп и комиссии" },
    question: {
      EN: "Does Raydium really buy back RAY — and is it happening now?",
      RU: "Выкупает ли Raydium RAY на самом деле — и происходит ли это сейчас?",
    },
    published: { verdict: "PARTIALLY_SUPPORTED", checkedAt: "2026-10-01" },
  },
  {
    slug: "pump_fun",
    name: "Pump.fun",
    ticker: "PUMP",
    topic: { EN: "Revenue flows", RU: "Потоки выручки" },
    question: { EN: "Where does Pump.fun revenue actually go?", RU: "Куда на самом деле идёт выручка Pump.fun?" },
    published: null,
  },
  {
    slug: "lido",
    name: "Lido",
    ticker: "LDO",
    topic: { EN: "Revenue & LDO", RU: "Выручка и LDO" },
    question: { EN: "Does any Lido revenue reach LDO holders?", RU: "Доходит ли выручка Lido до держателей LDO?" },
    published: null,
  },
  {
    slug: "jupiter",
    name: "Jupiter",
    ticker: "JUP",
    topic: { EN: "Buyback, no burn", RU: "Выкуп без сжигания" },
    question: { EN: "Jupiter buys back JUP — but does supply shrink?", RU: "Jupiter выкупает JUP — но уменьшается ли предложение?" },
    published: null,
  },
  {
    slug: "jito",
    name: "Jito",
    ticker: "JTO",
    topic: { EN: "MEV & treasury", RU: "MEV и казна" },
    question: { EN: "Does Jito’s MEV revenue reach JTO holders?", RU: "Доходит ли MEV-доход Jito до держателей JTO?" },
    published: null,
  },
];
