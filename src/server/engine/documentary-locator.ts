// EXACT DOCUMENTARY LOCATOR — the deterministic check that decides whether
// a fact may carry a concrete on-chain locator.
//
// THE DEFECT THIS CLOSES. A confirmed OFFICIAL_DOCS page rendered
// "99mRw3…pm4F3c" as the visible text of an anchor whose href carried the
// full 44-character account. Extraction quoted what it saw. The resulting
// Evidence was a true documentary observation and a useless locator: the
// middle characters are simply not knowable from it, and no amount of
// model instruction changes that. A prompt can prefer the exact value;
// only code can refuse the truncated one.
//
// This module is that code. It is the AUTHORITY: extraction may propose a
// locator, and nothing it proposes is trusted until this function agrees.
// A model that ignores its instruction produces no locator here, not a
// bad one.
//
// THE RULES, in order, each with its own reason so a rejection is
// diagnosable rather than merely a "no":
//
//   1. A truncated display form is never a locator. Not repaired, not
//      approximated, not looked up — refused.
//   2. A locator must be a COMPLETE machine-readable identifier.
//   3. It must appear LITERALLY in the normalized document text. This is
//      what makes reconstruction structurally impossible: a value with a
//      guessed middle does not appear in the document, so it cannot pass.
//      Where it appears — ordinary prose, an exact anchor href, a safe
//      data-* value, or the bounded link appendix — is deliberately not
//      constrained, because all four are the document literally stating
//      it. A page that writes the address out in prose needs no appendix.
//
// CASE SENSITIVITY IS LOAD-BEARING. Base58 is case-significant: two
// identifiers differing only in case are different accounts. The
// containment check here is exact, unlike D-076's traceability check,
// which lowercases because it compares human-readable prose.
//
// NO PROJECT KNOWLEDGE. There is no host, no project and no mechanism in
// this file. It decides shape and literal presence, nothing else. Whether
// a well-formed identifier is the RIGHT account, on the right chain, for
// the right project remains D-134's question, and this module deliberately
// cannot answer it — passing here means "the document states this
// identifier", never "this identifier is what it claims".
//
// ENVIRONMENT-AWARE SHAPE. What counts as a complete identifier depends
// on the chain family (base58 for Solana, 0x-hex for EVM), and the family
// rules live in ONE place — domain/identifier-shape.ts. A caller that
// knows the project's confirmed chain passes it, and only that chain's
// family is recognised: an 0x address proposed for a Solana project is
// "not an identifier" here, exactly as it always was. A caller with no
// confirmed chain gets the union of families — still a shape check, and
// still never a chain attribution.

import {
  identifierBoundaryCharOfFamily,
  identifierFamilyOfValue,
  identifierShapeForChain,
  identifierShapeOfAnyFamily,
} from "../domain/identifier-shape";
import type { SupportedChain } from "../domain/project-identity";

// The elision markers a page uses when it abbreviates an identifier for
// display. A complete base58 identifier can contain none of them, so any
// one is decisive on its own. This list exists to produce a PRECISE
// reason: anything it misses still fails the shape test below, just with
// the blunter "not an identifier".
const TRUNCATION_MARKERS = ["…", "⋯", "···", "..", "•••", "‥"];

export type LocatorShape = "ADDRESS_LIKE" | "SIGNATURE_LIKE";

export type LocatorRejection =
  // The fact claims no locator at all — the ordinary case, and not a
  // defect. Most documentary evidence identifies no account.
  | "NOT_CLAIMED"
  // "99mRw3…pm4F3c" and every other abbreviated rendering.
  | "TRUNCATED_DISPLAY_FORM"
  // Not an identifier this system recognises the shape of.
  | "NOT_A_COMPLETE_IDENTIFIER"
  // Well-formed, but the document does not contain it. A reconstructed,
  // guessed or externally-supplied value lands here.
  | "NOT_LITERAL_IN_DOCUMENT";

export type DocumentaryLocatorOutcome =
  | { locator: "CONFIRMED"; value: string; shape: LocatorShape }
  | { locator: "NONE"; reason: LocatorRejection };

export function isTruncatedDisplayForm(value: string): boolean {
  return TRUNCATION_MARKERS.some((marker) => value.includes(marker));
}

// The shape of a value FOR A CHAIN when one is known, or in whichever
// family it structurally fits when none is. Solana base58 recognition is
// exactly what it always was in both forms.
export function completeIdentifierShape(
  value: string,
  chain: SupportedChain | null = null,
): LocatorShape | null {
  return chain === null ? identifierShapeOfAnyFamily(value) : identifierShapeForChain(chain, value);
}

// Exact, case-sensitive containment with an identifier boundary on both
// sides, where "identifier character" is decided by the value's own family
// (base58 for a base58 value, hex for an 0x value).
//
// The boundary is not decoration. Without it a 44-character address would
// "appear literally" inside an 88-character signature that merely happens
// to contain those characters, and a fact could claim an account the
// document never names. A neighbouring identifier character means the
// match is part of a longer identifier, so it is not this identifier.
export function literallyPresent(documentText: string, value: string): boolean {
  if (value.length === 0) return false;
  const boundaryChar = identifierBoundaryCharOfFamily(identifierFamilyOfValue(value) ?? "BASE58");
  let from = documentText.indexOf(value);
  while (from >= 0) {
    const before = from === 0 ? "" : documentText[from - 1];
    const afterIndex = from + value.length;
    const after = afterIndex >= documentText.length ? "" : documentText[afterIndex];
    const boundedLeft = before === "" || !boundaryChar.test(before);
    const boundedRight = after === "" || !boundaryChar.test(after);
    if (boundedLeft && boundedRight) return true;
    from = documentText.indexOf(value, from + 1);
  }
  return false;
}

export interface DocumentaryLocatorInput {
  // What extraction proposed, verbatim and untrusted. null/absent is the
  // normal case.
  claimedLocator: string | null | undefined;
  // The EXACT text the extractor was given — the same value D-076's
  // traceability check runs against, so "the document" means one thing.
  documentText: string;
  // The project's confirmed chain, when one exists. Decides which
  // identifier family a proposal must fit. Absent means "no confirmed
  // chain": any family's complete shape is accepted, none is attributed.
  chain?: SupportedChain | null;
}

export function validateDocumentaryLocator(
  input: DocumentaryLocatorInput,
): DocumentaryLocatorOutcome {
  const raw = input.claimedLocator;
  if (typeof raw !== "string") return { locator: "NONE", reason: "NOT_CLAIMED" };
  const value = raw.trim();
  if (value.length === 0) return { locator: "NONE", reason: "NOT_CLAIMED" };

  // Checked BEFORE the shape test so an abbreviated identifier reports
  // what it actually is, rather than the generic "not an identifier".
  if (isTruncatedDisplayForm(value)) {
    return { locator: "NONE", reason: "TRUNCATED_DISPLAY_FORM" };
  }
  const shape = completeIdentifierShape(value, input.chain ?? null);
  if (!shape) return { locator: "NONE", reason: "NOT_A_COMPLETE_IDENTIFIER" };
  if (!literallyPresent(input.documentText, value)) {
    return { locator: "NONE", reason: "NOT_LITERAL_IN_DOCUMENT" };
  }
  return { locator: "CONFIRMED", value, shape };
}
