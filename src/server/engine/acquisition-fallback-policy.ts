import { type AcquisitionStrategy } from "./acquired-documents";
import { RENDER_ON_REFUSAL_STATUSES } from "./rendered-docs-policy";

// THE ONE ACQUISITION FALLBACK POLICY, AND WHY IT LIVES HERE.
//
// This decision — "a fetch failed this way; what, if anything, may be
// asked next" — was reachable only from the PHASED path, because it sat
// in acquisition-phases.ts and that module imports the single-process
// executor. The executor could not import it back without a cycle, so the
// same document was recoverable in one path and permanently unreachable
// in the other: a confirmed OFFICIAL_DOCS page whose html exceeds the
// transport cap ended a single-process attempt with no fallback of any
// kind, while the phased path would have negotiated and then rendered it.
//
// Moving the policy into a module that imports neither caller is what
// makes ONE policy serve both. Nothing about the decision changed in the
// move: the same diagnostics, the same order, the same bounds, the same
// security stops. A second copy of this reasoning is exactly what must
// never exist, which is why the executor imports this and states no rule
// of its own.

// WHICH FAILURES JUSTIFY WHICH FALLBACK.
//
// A fallback is justified by the failure CLASS, never by hope. The two
// security refusals terminate the chain outright: every strategy shares
// the same address classifier, so another transport could only "succeed"
// by weakening the boundary the first one correctly enforced — that is
// the one thing a fallback must never become.
//
// Deterministic refusals (a malformed url, an unsupported scheme, a
// redirect loop, a 404 or a 5xx) end the chain too: the server or the
// policy already answered, and asking again through a different pipe
// cannot change the answer.
//
// AN OVERSIZED BODY WAS IN THAT LIST AND DOES NOT BELONG THERE. The
// reasoning above holds for a class whose answer is fixed however it is
// asked; TOO_LARGE is not one. It is a property of the REPRESENTATION
// this request asked for, not of the resource: the origin was mid-reply
// with a document it was willing to serve, and our own cap ended the
// read. A different representation of the same resource is a different
// number of bytes, so asking for one is not asking the same question
// again. That is exactly the case UNSUPPORTED_CONTENT_TYPE below already
// makes, and TOO_LARGE is its sibling — "this fetcher cannot READ what
// was offered" and "this fetcher cannot ACCEPT what was offered" differ
// in the verb and nothing else.
//
// Found live: a human-registered, human-classified OFFICIAL_DOCS page was
// permanently unreachable because its HTML bundle exceeds the cap, with
// no second attempt of any kind. No limit moves to fix it.
//
// What remains is the honest middle: a connection that broke mid-message
// or timed out (the class where a complete document demonstrably exists
// but this transport could not finish it), a representation this fetcher
// cannot read, and the refusal statuses the canonical render-on-refusal
// policy already recognises.
export function plannedFallbacks(
  diagnostic: string | null,
  httpStatus: number | null,
  // WHICH STRATEGY PRODUCED THIS FAILURE. Null when it is not known —
  // which is the fail-closed reading: a transition that requires a
  // specific predecessor is not licensed by an unattributed failure.
  //
  // Defaulted so every existing caller and contract test keeps its exact
  // meaning: with no strategy named, TOO_LARGE still buys negotiation and
  // nothing more.
  failedStrategy: AcquisitionStrategy | null = null,
): AcquisitionStrategy[] {
  switch (diagnostic) {
    // SECURITY STOP. Never anything after these.
    case "BLOCKED_ADDRESS":
    case "REDIRECT_TARGET_BLOCKED":
      return [];
    // The transport could not finish a message the origin was sending.
    case "NETWORK_ERROR":
    case "TIMEOUT":
      return ["CONTENT_NEGOTIATION", "ISOLATED_RENDER"];
    // This fetcher cannot read what was offered; ask for a representation
    // it can. A browser would face the same allowlist, so no render.
    case "UNSUPPORTED_CONTENT_TYPE":
      return ["CONTENT_NEGOTIATION"];
    // This fetcher cannot ACCEPT what was offered; ask for a
    // representation small enough to accept, under the very same cap.
    //
    // AND THEN, IF THAT IS ALSO TOO LARGE, THE RENDERED REPRESENTATION.
    //
    // The earlier reasoning here — "a render produces the same document
    // or a larger one, and its output faces the identical cap at seal" —
    // was refuted by measurement, and it was wrong about WHICH quantity
    // each cap measures. The transport cap is on RESPONSE BYTES: 2 MB of
    // html raises TOO_LARGE while the stream is still being consumed. The
    // seal cap is on NORMALIZED TEXT CHARACTERS, and the renderer bounds
    // its own text independently (maxRenderedTextLength, plus a
    // separately bounded link appendix). Rendering is precisely the step
    // that converts the oversized quantity into the bounded one, so a
    // page too large to transport can be small enough to seal. A live
    // probe read one such confirmed OFFICIAL_DOCS page — 2,080,298 html
    // bytes — successfully, while acquisition had already given up.
    //
    // THE TRANSITION IS EARNED, NOT ASSUMED. A first TOO_LARGE still buys
    // only negotiation: asking the origin for a smaller textual
    // representation is cheaper than a browser and often enough. Only
    // when that NEGOTIATED representation is ALSO oversized has the
    // origin effectively said no textual representation of this document
    // exists under the cap — and at that point the browser's own rendered
    // text is the one remaining bounded representation. That is a generic
    // statement about representations, not about any host.
    //
    // Bounded by construction, exactly as before: each strategy is added
    // to the plan at most once, strategyAlreadyAttempted refuses a repeat
    // across deliveries, MAX_RENDER_ATTEMPTS_PER_JOB caps renders job-
    // wide, and MAX_FALLBACK_ATTEMPTS_PER_URL caps this chain at two
    // fallbacks — which this transition exactly fills and cannot exceed.
    // No cap is raised, no new strategy or provider exists, and the
    // render still has to pass every renderer eligibility gate on its own
    // terms (see the ISOLATED_RENDER branch below).
    case "TOO_LARGE":
      return failedStrategy === "CONTENT_NEGOTIATION"
        ? ["ISOLATED_RENDER"]
        : ["CONTENT_NEGOTIATION"];
    // The server answered, and the answer decides. Only the canonical
    // refusal statuses admit the renderer.
    case "HTTP_ERROR":
      return httpStatus !== null && RENDER_ON_REFUSAL_STATUS_SET.has(httpStatus)
        ? ["ISOLATED_RENDER"]
        : [];
    // Deterministic policy refusals, resolver failure, and anything
    // untyped: fail closed with no fallback. (Environmental classes may
    // earn a later re-attempt under D-146 Slice 3; that is a separate
    // decision and is deliberately not implemented here.)
    default:
      return [];
  }
}

// The hard bound on how many fallbacks one url may consume, wherever the
// chain runs. Exported so both callers count against the same number
// rather than each choosing one.
export const MAX_FALLBACK_ATTEMPTS_PER_URL = 2;

// Read from the canonical policy module rather than restated here.
const RENDER_ON_REFUSAL_STATUS_SET = RENDER_ON_REFUSAL_STATUSES;
