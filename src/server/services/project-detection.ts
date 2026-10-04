import type { Database } from "../db/client";
import { resolveProjectSlug } from "../interpreter/interpret";

// DETERMINISTIC PROJECT DETECTION — THE CATALOG, AND NOTHING ELSE.
//
// Before a user opens the Mini App, the entry surface may say which
// catalog project a handed-in text names. This asks the SAME question the
// Interpreter's server-side resolution asks (`resolveProjectSlug`: slug,
// name, ticker and aliases, case- and punctuation-insensitive), once per
// candidate token and once per adjacent pair, so "Pump.fun", "pump fun"
// and "PUMP" all resolve the way they do on the Ask screen. No model call,
// no heuristics beyond the catalog, no guessing:
//
//   exactly one distinct project named  → that slug
//   none, or more than one              → null
//
// "More than one" is null on purpose: a comparison or a list is not a
// detection, and the Interpreter will sort it out with the user. A result
// here is ADVISORY — it words a bot reply and a note on the Ask screen.
// The Interpreter and the gates decide what Research may start.
const MAX_TOKENS = 80;
const MIN_TOKEN_CHARS = 3;

function tokensOf(text: string): string[] {
  return text
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}.]+$/gu, "").replace(/['’]s$/u, ""))
    .filter((t) => t.length >= MIN_TOKEN_CHARS)
    .slice(0, MAX_TOKENS);
}

export async function detectProjectSlug(db: Database, text: string): Promise<string | null> {
  const tokens = tokensOf(text);
  const candidates = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    candidates.add(tokens[i]);
    if (i + 1 < tokens.length) candidates.add(`${tokens[i]} ${tokens[i + 1]}`);
  }
  const found = new Set<string>();
  const seenKeys = new Set<string>();
  for (const candidate of candidates) {
    const key = candidate.toLowerCase();
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    const r = await resolveProjectSlug(db, candidate);
    if (r.slug) found.add(r.slug);
    if (found.size > 1) return null;
  }
  return found.size === 1 ? [...found][0] : null;
}
