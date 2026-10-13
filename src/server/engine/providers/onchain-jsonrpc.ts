import { createHash } from "node:crypto";

import { z } from "zod";

import { OnchainRetrieverUnavailableError } from "./onchain-retriever";

// JSON-RPC 2.0 envelope handling and artifact encoding, shared by every
// deterministic on-chain adapter.
//
// Nothing here knows a chain. An adapter hands in the raw text a transport
// returned and gets back either the `result` or a typed refusal; and it
// hands in a normalized result and gets back the byte-identical canonical
// text the artifact hash is computed over. Stated once so implementation
// #2 cannot drift from implementation #1 on the two things every artifact
// must agree about: what counts as a node error, and what the artifact
// hash is a hash OF.

// A node answered, parsed our request, and refused it. Distinct from a
// transport failure (the request never completed) and from a schema
// failure (the response was not the shape we expect): this one means WE
// asked for something the node would not serve, which is almost always our
// bug, not theirs.
//
// Carries the numeric JSON-RPC code and nothing else. -32602 (invalid
// params) is the code the first live smoke produced, and preserving it is
// what turns "something went wrong" into a one-line diagnosis.
export class OnchainRpcError extends OnchainRetrieverUnavailableError {
  constructor(
    public readonly method: string,
    public readonly rpcCode: number | null,
  ) {
    super(
      `rpc returned error code ${rpcCode ?? "unknown"} for ${method}`,
      // -32005 is a node-defined rate limit; treat only that as transient.
      // Nothing here retries automatically — the flag is classification.
      rpcCode === -32005,
    );
    this.name = "OnchainRpcError";
  }
}

const envelopeSchema = z.object({
  jsonrpc: z.literal("2.0"),
  result: z.unknown().optional(),
  // The numeric CODE is preserved; the message is not. A JSON-RPC code is
  // a small integer from a defined range (-32700..-32000 plus
  // implementation-defined values) — it carries no provider text and
  // cannot contain an endpoint, a key, or response content, so it is safe
  // to surface and is exactly what makes a failed call diagnosable. The
  // accompanying `message` is provider-controlled free text and stays
  // discarded. `.loose()` tolerates the extra fields real nodes attach
  // (e.g. `data`) without reading any of them.
  error: z
    .object({ code: z.number().optional() })
    .loose()
    .optional(),
});

// The `result` of one JSON-RPC 2.0 response, or a refusal. A node answers
// {jsonrpc,id,result} on success and {jsonrpc,id,error} on failure — an
// `error` body is a provider failure, never a result, and must not be
// normalized into a fact. The error's own message is deliberately not
// interpolated: it is provider-controlled text.
export function jsonRpcResult(method: string, rawText: string): unknown {
  let envelope: unknown;
  try {
    envelope = JSON.parse(rawText);
  } catch {
    throw new OnchainRetrieverUnavailableError("rpc response is not valid JSON");
  }
  const rpc = envelopeSchema.safeParse(envelope);
  if (!rpc.success) {
    throw new OnchainRetrieverUnavailableError("rpc response is not a JSON-RPC 2.0 envelope");
  }
  if (rpc.data.error !== undefined) {
    throw new OnchainRpcError(method, rpc.data.error.code ?? null);
  }
  return rpc.data.result;
}

export function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

// Canonical JSON: key-sorted, so the same observation always serializes
// byte-identically and the artifact hash is reproducible.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}
