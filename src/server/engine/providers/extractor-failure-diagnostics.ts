import { isHttpStatusCode } from "./content-fetcher";
import {
  isExtractorOutputDiagnostic,
  isExtractorSchemaField,
  type ExtractorOutputDiagnostic,
  type ExtractorSchemaField,
} from "./evidence-extractor";
import { isTokenCountDiagnostic, type TokenCountDiagnostic } from "./token-gate";

// THE EXTRACTOR FAILURE DIAGNOSTIC, AS A PERSISTABLE CODE.
//
// THE DEFECT THIS CLOSES, measured on the fresh post-fix Raydium run (job
// 8eb1e920-…): D3 correctly rescued an official documentation page that
// the old code would have paid for and never read, extraction of it
// failed, and the durable record said only
// `EXTRACT_FAILED / PROVIDER_ERROR`. The classified WHY did exist — the
// throw site had already produced it and s4-executor's safeFailureDetail
// had already gated it — but it travelled ONLY in the attempt's
// observation string, and on the very path D3 created (source opens
// exhausted, extraction runs, the SAME budget error is then thrown) that
// string is never returned. The one flow that needed the diagnostic most
// was the one flow that could not keep it.
//
// This module does not invent a vocabulary. It states, in ONE place, the
// exact set of strings `safeFailureDetail` can build for an extractor
// failure, so the trace writer can admit them by rule instead of by
// trust. Every half of every value below is decided by a closed,
// code-owned membership test that already exists:
//
//   TokenCountDiagnostic          the shared raw-provider classifier's
//                                 own closed list (token-gate.ts)
//   ExtractorOutputDiagnostic     the generation path's own closed list
//                                 (evidence-extractor.ts)
//   ExtractorSchemaField          the code-authored schema field names
//                                 (evidence-extractor.ts)
//   <http status>                 a trusted integer in 100..599, by the
//                                 same rule both transports use
//                                 (content-fetcher.ts's isHttpStatusCode)
//
// NOTHING model-derived, provider-derived or free-text can pass. The value
// is split at its one separator and each half is then decided by a closed
// membership test — there is no sanitisation and no escaping here to get
// subtly wrong, and a half that is not a known member fails the value
// whole.
export type ExtractorFailureDiagnosticCode =
  | TokenCountDiagnostic
  | `${TokenCountDiagnostic}:${number}`
  | ExtractorOutputDiagnostic
  | `OUTPUT_SCHEMA_INVALID:${ExtractorSchemaField}`;

// Exactly the two composite shapes safeFailureDetail composes, each half
// decided separately. Deliberately NOT a materialised set: the http-status
// half is a 500-value code-owned RANGE, and enumerating it would say
// nothing the range rule does not already say — while a composite whose
// head is not a known class, or whose tail is not a known field or a
// trusted status, is refused here exactly as a materialised set would
// refuse it.
export function isExtractorFailureDiagnosticCode(
  value: unknown,
): value is ExtractorFailureDiagnosticCode {
  if (typeof value !== "string") return false;
  const separator = value.indexOf(":");
  if (separator === -1) {
    return isTokenCountDiagnostic(value) || isExtractorOutputDiagnostic(value);
  }
  const head = value.slice(0, separator);
  const tail = value.slice(separator + 1);
  // The schema-field refinement belongs to exactly one class; asserted
  // beside any other it is a contradiction and the value is refused
  // whole, never reconciled into something plausible.
  if (head === "OUTPUT_SCHEMA_INVALID") return isExtractorSchemaField(tail);
  if (!isTokenCountDiagnostic(head)) return false;
  // Digits only, then the SAME numeric rule both acquisition transports
  // use — so "007", "4e2" and " 404" are not statuses, and neither is
  // anything outside 100..599.
  if (!/^[0-9]+$/.test(tail)) return false;
  return isHttpStatusCode(Number(tail));
}
