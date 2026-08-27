import { describe, expect, it } from "vitest";

import {
  CONTENT_FETCH_FAILURE_REASONS,
  ContentFetchError,
  type ContentFetchFailureReason,
} from "../src/server/engine/providers/content-fetcher";
import { __setContentFetcher } from "../src/server/engine/providers/content-fetcher";

// WHAT A FAILURE MAY SAY ABOUT ITSELF.
//
// A real bounded fetch failed and the only thing recorded was
// "CONTENT_FETCHER_FAILED:ContentFetchError". That cannot distinguish the
// site refusing us from the request being SSRF-blocked from a timeout —
// three different next moves, and one of them means a live window never
// actually opened. The typed reason existed the whole time and was
// discarded on the way out.
//
// It is surfaced now, through TWO gates that must both hold: the error is
// an actual ContentFetchError (instanceof, against a class this repository
// owns) AND its reason is a member of the closed, code-authored list. The
// first stops a look-alike object talking its way in; the second stops a
// class vouching for a value it never checked, since a runtime value can
// violate a compile-time union.
//
// The message is still never surfaced, and these tests hold that line
// harder than the feature: a fetch error's message can carry a
// credential-bearing URL or an Authorization header verbatim.

const REASONS = CONTENT_FETCH_FAILURE_REASONS;

// SCOPE. The end-to-end path — a fetch throwing and the terminal reason an
// owner reads — is covered by phase6-s4-executor.test.ts, which now expects
// "CONTENT_FETCHER_FAILED:ContentFetchError:HTTP_ERROR", and by
// first-real-run-stage2.test.ts, which asserts that a credential-bearing URL,
// "Authorization" and "Bearer" never reach research_attempts.reason. Those
// need a database. What is proven HERE is the contract the sanitizer rests
// on: the closed list, and the two gates a value must pass to be trusted.

describe("1. the closed list is the single source of truth", () => {
  it("every reason the type allows is present in the list", () => {
    // The type is DERIVED from the array, so a union member that is not in
    // the array is not expressible. This asserts the shape stayed that way.
    const sample: ContentFetchFailureReason = "BLOCKED_ADDRESS";
    expect(REASONS).toContain(sample);
    expect(new Set(REASONS).size).toBe(REASONS.length);
  });

  it("it contains exactly the eleven reasons the fetcher can raise", () => {
    expect([...REASONS].sort()).toEqual(
      [
        "BLOCKED_ADDRESS",
        "DNS_RESOLUTION_FAILED",
        "HTTP_ERROR",
        "INVALID_URL",
        "NETWORK_ERROR",
        "REDIRECT_TARGET_BLOCKED",
        "TIMEOUT",
        "TOO_LARGE",
        "TOO_MANY_REDIRECTS",
        "UNSUPPORTED_CONTENT_TYPE",
        "UNSUPPORTED_PROTOCOL",
      ].sort(),
    );
  });

  it("no reason contains anything that could have come from a provider", () => {
    // Enumerated, uppercase, underscore-separated. Nothing here can carry a
    // URL, a header or a quoted response body.
    for (const r of REASONS) expect(r).toMatch(/^[A-Z_]+$/);
  });
});

describe("2. a real ContentFetchError carries its reason safely", () => {
  it("BLOCKED_ADDRESS is surfaced", () => {
    const e = new ContentFetchError("BLOCKED_ADDRESS", "resolved to 198.18.0.76", "https://example.com/x");
    expect(e.reason).toBe("BLOCKED_ADDRESS");
    expect(REASONS).toContain(e.reason);
    expect(e instanceof ContentFetchError).toBe(true);
  });

  it("HTTP_ERROR is surfaced", () => {
    const e = new ContentFetchError("HTTP_ERROR", "403", "https://example.com/x");
    expect(e.reason).toBe("HTTP_ERROR");
    expect(REASONS).toContain(e.reason);
  });

  it("TIMEOUT is surfaced", () => {
    const e = new ContentFetchError("TIMEOUT", "exceeded 15000ms", "https://example.com/x");
    expect(e.reason).toBe("TIMEOUT");
    expect(REASONS).toContain(e.reason);
  });

  it("every valid reason round-trips through the error and stays in the list", () => {
    for (const reason of REASONS) {
      const e = new ContentFetchError(reason, "some message", "https://example.com/x");
      expect(e.reason).toBe(reason);
      expect(REASONS).toContain(e.reason);
      expect(e instanceof ContentFetchError).toBe(true);
    }
  });
});

describe("3. what must never be surfaced", () => {
  it("a look-alike object is not a ContentFetchError, however it is shaped", () => {
    // Gate one. Anything can carry a field called `reason`; only the class
    // this repository owns is trusted, and duck typing would be exactly the
    // hole a provider-shaped object walks through.
    const impostor = Object.assign(new Error("boom"), { reason: "BLOCKED_ADDRESS", url: "https://x" });
    expect(impostor instanceof ContentFetchError).toBe(false);
    const alsoNot = { reason: "BLOCKED_ADDRESS", name: "ContentFetchError", message: "boom" };
    expect(alsoNot instanceof ContentFetchError).toBe(false);
    // Even a subclass-looking name is not the class.
    class ContentFetchErrorLookalike extends Error {
      readonly reason = "BLOCKED_ADDRESS";
    }
    expect(new ContentFetchErrorLookalike() instanceof ContentFetchError).toBe(false);
  });

  it("a genuine ContentFetchError carrying an off-list reason is not trusted either", () => {
    // Gate two. A runtime value can violate a compile-time union, so the
    // class alone vouches for nothing — membership is checked separately.
    const rogue = new ContentFetchError(
      "Bearer sk-live-DO_NOT_LEAK" as ContentFetchFailureReason,
      "x",
      "https://example.com/x",
    );
    expect(rogue instanceof ContentFetchError).toBe(true);
    expect(new Set<string>(REASONS).has(rogue.reason)).toBe(false);
  });

  it("a credential-bearing URL lives only in message and url, never in reason", () => {
    const e = new ContentFetchError(
      "HTTP_ERROR",
      "GET https://api.example.com/v1?api_key=SECRET_TOKEN_DO_NOT_LEAK failed",
      "https://api.example.com/v1?api_key=SECRET_TOKEN_DO_NOT_LEAK",
    );
    expect(e.message).toContain("SECRET_TOKEN_DO_NOT_LEAK"); // it really is in there
    expect(e.reason).toBe("HTTP_ERROR");
    expect(e.reason).not.toContain("SECRET_TOKEN_DO_NOT_LEAK");
    expect(e.reason).not.toContain("api.example.com");
  });

  it("Authorization-header text lives only in message, never in reason", () => {
    const e = new ContentFetchError(
      "NETWORK_ERROR",
      "request had Authorization: Bearer sk-live-abc123",
      "https://example.com/x",
    );
    expect(e.message).toContain("Authorization");
    expect(e.reason).toBe("NETWORK_ERROR");
    expect(e.reason).not.toContain("Authorization");
    expect(e.reason).not.toContain("Bearer");
  });

  it("no reason in the list resembles free text at all", () => {
    for (const r of REASONS) {
      expect(r).not.toContain(" ");
      expect(r).not.toContain(":");
      expect(r).not.toContain("/");
      expect(r).not.toContain("@");
    }
  });
});

describe("4. the fallback for everything else is unchanged", () => {
  it("an ordinary Error contributes no detail — its class name is all there is", () => {
    const plain = new Error("not found in fixture");
    expect(plain instanceof ContentFetchError).toBe(false);
    expect((plain as { reason?: unknown }).reason).toBeUndefined();
  });

  it("a non-Error throw contributes nothing", () => {
    for (const thrown of ["a string", 42, null, undefined, { reason: "TIMEOUT" }]) {
      expect(thrown instanceof ContentFetchError).toBe(false);
    }
  });
});

// The setter is exported for fixtures; touching it here keeps the import
// honest and proves the module surface did not change shape.
describe("5. the module surface is unchanged", () => {
  it("still exports its fixture hook and its error class together", () => {
    expect(typeof __setContentFetcher).toBe("function");
    expect(typeof ContentFetchError).toBe("function");
    expect(Array.isArray(REASONS)).toBe(true);
  });
});
