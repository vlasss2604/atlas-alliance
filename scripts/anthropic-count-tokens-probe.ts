// ANTHROPIC count_tokens CAPABILITY PROBE — owner diagnostic tooling.
//
// Answers exactly one question: "can the currently configured Anthropic
// client successfully execute the same countTokens capability the
// EvidenceExtractor uses?" — outside any research process, with no
// document, no project, and no job. It exists because a live acquisition
// died at EVIDENCE_EXTRACTOR_COUNT_TOKENS and the capability had never
// been probed on its own. The sibling of renderer-selftest.ts, for the
// model-provider side.
//
// WHAT IT DOES NOT DO. No messages.create (generation) call, ever. No
// ContentFetcher, no SearchGateway, no renderer, no on-chain retriever,
// no research job, no Evidence, no Raydium anything — none of those
// modules is in this file's import graph. The database is opened for ONE
// read (the configured extractor model id) and closed BEFORE the live
// call, so the probe runs with no open handle to ATLAS data.
//
// PRODUCTION FIDELITY. The client is constructed exactly as
// evidence-extractor-anthropic.ts constructs it ({ apiKey, maxRetries: 0 }),
// the model id is the same product-config value the extractor resolves,
// and the call is wrapped in the SAME retry composition countThenGate
// uses — retryOnceIfTransient with isTransientAnthropicApiError — so a
// transient failure retries exactly once, like production. countThenGate
// itself returns void, so this probe composes the same exported
// primitives instead, to be able to REPORT the count; if countThenGate's
// composition ever changes, this file must follow it.
//
// MAXIMUM LIVE FOOTPRINT, stated for the operator: at most TWO Anthropic
// countTokens requests (one, plus one retry only if the first failure is
// transient: 429/5xx/no-response). Zero generation requests, zero
// non-Anthropic HTTP, zero DB writes, zero source opens, zero search,
// zero RPC.
//
// OUTPUT CONTRACT. SUCCESS prints the token count and the closed config
// values. FAILURE prints ONLY the closed diagnostic from token-gate.ts
// (plus the trusted status integer). Never the API key, never a raw
// provider message, body, header, request id, or stack.
//
// Run (owner-authorized, MantaRay ON): npx tsx scripts/anthropic-count-tokens-probe.ts
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

import Anthropic from "@anthropic-ai/sdk";

import { loadProductConfig } from "../src/server/config/product";
import { createDatabase } from "../src/server/db/client";
import {
  loadModelCostProfile,
  ModelCostProfileMissingError,
} from "../src/server/engine/model-cost-profile";
import {
  isTransientAnthropicApiError,
  retryOnceIfTransient,
} from "../src/server/engine/providers/retry";
import { classifyTokenCountFailure } from "../src/server/engine/providers/token-gate";

async function main(): Promise<void> {
  console.log("--- anthropic count_tokens capability probe ---");
  console.log("calls at most: 2 countTokens (1 + 1 transient retry); generation: 0");

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("REFUSED: ANTHROPIC_API_KEY is not set");
    process.exit(1);
  }

  // ONE config read; the pool is closed before any live call is made.
  const { db, pool } = createDatabase();
  let model: string;
  let maxInputTokens: number;
  try {
    const config = await loadProductConfig(db);
    model = config.evidence_extractor_model;
    try {
      maxInputTokens = loadModelCostProfile("EVIDENCE_EXTRACTOR", model).maxInputTokens;
    } catch (e) {
      if (e instanceof ModelCostProfileMissingError) {
        console.error("REFUSED: no cost profile for the configured extractor model");
        process.exit(1);
      }
      throw e;
    }
  } finally {
    await pool.end();
  }
  console.log("model:            " + model + "   (product config: evidence_extractor_model)");
  console.log("approved ceiling: " + maxInputTokens + " input tokens");

  // Same construction as evidence-extractor-anthropic.ts.
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });

  // Trivial, non-sensitive input. output_config is omitted — this probes
  // the capability (endpoint, credential, model id, reachability), not
  // the extractor's exact schema shape, and says so.
  let attempts = 0;
  try {
    const result = await retryOnceIfTransient(
      () => {
        attempts += 1;
        return client.messages.countTokens({
          model,
          system: "You are a connectivity probe.",
          messages: [{ role: "user", content: "ping" }],
        });
      },
      isTransientAnthropicApiError,
    );
    console.log("");
    console.log("SUCCESS");
    console.log("input_tokens:     " + result.input_tokens);
    console.log("attempts:         " + attempts);
    console.log("within ceiling:   " + (result.input_tokens <= maxInputTokens));
    console.log("");
    console.log("Established: the credential authenticates for count_tokens, the");
    console.log("configured model id is accepted, and Anthropic answered through this");
    console.log("network configuration. NOT established: that the earlier acquisition");
    console.log("failure had any particular cause, or that acquisition/generation");
    console.log("will succeed.");
  } catch (e) {
    // The ONLY things allowed out: the closed diagnostic and the trusted
    // status integer. The raw exception is never printed.
    const { diagnostic, httpStatus } = classifyTokenCountFailure(e);
    console.error("");
    console.error("FAILED: " + diagnostic + (httpStatus === null ? "" : ":" + httpStatus));
    console.error("attempts:         " + attempts);
    process.exit(1);
  }
}

main().catch(() => {
  // Even a completely unexpected throw prints nothing raw.
  console.error("FAILED: UNCLASSIFIED_PROVIDER_ERROR");
  process.exit(1);
});
