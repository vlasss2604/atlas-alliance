import https from "node:https";

import {
  endpointEnvVarFor,
  isAcceptableEndpoint,
  OnchainRetrieverUnavailableError,
  type OnchainRetriever,
  type OnchainRpcTransport,
} from "./onchain-retriever";
import { createEvmOnchainAdapter } from "./onchain-evm";
import { createSolanaOnchainAdapter, type SolanaAdapterDeps } from "./onchain-solana";

// Production HTTPS JSON-RPC transport for structured on-chain retrieval.
//
// This is the ONLY module in the on-chain path that touches the network,
// and it is deliberately the least clever one: it takes a method name and
// parameters, posts them to ONE endpoint that came from server-side
// configuration, and returns the raw body as text. It has no notion of
// chains, intents, evidence or research.
//
// Every safety property is structural rather than conventional:
//
//   * The endpoint is never a parameter. It is read from an environment
//     variable whose NAME comes from a code-owned allowlist keyed by
//     (chain, network) — so no user, model, search result or adapter can
//     influence where a request goes, and no unlisted network is
//     addressable at all.
//   * POST only, to a fixed path, with a JSON body. There is no GET, no
//     query string, and no way to express an arbitrary URL.
//   * Redirects are NOT followed. A 3xx is a failure, full stop: following
//     one would let a server relocate our request to a host the allowlist
//     never approved (the SSRF property content-fetcher.ts protects by
//     re-validating every hop; here the cheaper and stricter answer is to
//     refuse entirely).
//   * Bounded timeout and a hard response-size cap, enforced while the
//     body streams so an oversized response is aborted rather than
//     buffered.
//   * ZERO automatic retries. One call in, at most one request out. A
//     retry loop over a metered RPC is exactly the unbounded-cost shape
//     the budget model exists to prevent, and the caller already reserves
//     one sourceOpen per operation.
//   * No secret can escape. The endpoint URL is never logged, never
//     returned in an error, never written to trace, and never placed in
//     provenance — provenance carries a code-owned LABEL instead. This
//     matters because some providers embed an API key in the URL path, so
//     the URL itself must be treated as a credential.

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 2_000_000; // 2 MB, same bound as content-fetcher

export interface OnchainTransportOptions {
  timeoutMs?: number;
  maxBytes?: number;
}

export type OnchainTransportFailure =
  | "TIMEOUT"
  | "TOO_LARGE"
  | "REDIRECT_REFUSED"
  | "HTTP_ERROR"
  | "NETWORK_ERROR";

// Errors deliberately carry a reason code and NEVER the endpoint, the
// request body, or any response content — an RPC endpoint may itself be a
// credential.
export class OnchainTransportError extends OnchainRetrieverUnavailableError {
  constructor(
    public readonly reason: OnchainTransportFailure,
    public readonly providerId: string,
    transient = false,
  ) {
    super(`onchain rpc transport failed (${reason}) for provider ${providerId}`, transient);
    this.name = "OnchainTransportError";
  }
}

// Builds a transport bound to ONE endpoint. The endpoint string never
// leaves this closure.
export function createHttpsRpcTransport(
  endpoint: string,
  providerId: string,
  opts: OnchainTransportOptions = {},
): OnchainRpcTransport {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  return {
    call(method: string, params: unknown[]): Promise<string> {
      // Parsed once here, not stored anywhere a caller could read it.
      const url = new URL(endpoint);
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });

      return new Promise<string>((resolve, reject) => {
        const req = https.request(
          {
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port || 443,
            path: `${url.pathname}${url.search}`,
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(body),
              Accept: "application/json",
              "User-Agent": "AtlasProofResearchEngine/1 (+onchain-rpc)",
            },
            timeout: timeoutMs,
          },
          (res) => {
            const status = res.statusCode ?? 0;
            // A redirect is refused, never followed.
            if (status >= 300 && status < 400) {
              res.destroy();
              reject(new OnchainTransportError("REDIRECT_REFUSED", providerId));
              return;
            }
            if (status < 200 || status >= 300) {
              res.destroy();
              // 429/5xx are transient in kind; the CALLER still performs no
              // automatic retry — the flag is for honest classification only.
              reject(
                new OnchainTransportError(
                  "HTTP_ERROR",
                  providerId,
                  status === 429 || status >= 500,
                ),
              );
              return;
            }

            const chunks: Buffer[] = [];
            let received = 0;
            res.on("data", (chunk: Buffer) => {
              received += chunk.length;
              if (received > maxBytes) {
                res.destroy();
                reject(new OnchainTransportError("TOO_LARGE", providerId));
                return;
              }
              chunks.push(chunk);
            });
            res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
            res.on("error", () => reject(new OnchainTransportError("NETWORK_ERROR", providerId, true)));
          },
        );

        req.on("timeout", () => {
          req.destroy();
          reject(new OnchainTransportError("TIMEOUT", providerId, true));
        });
        // The raw socket error is swallowed on purpose: its message can
        // contain the host, and the host can be the credential.
        req.on("error", () => reject(new OnchainTransportError("NETWORK_ERROR", providerId, true)));
        req.write(body);
        req.end();
      });
    },
  };
}

// WHICH IMPLEMENTATION SERVES WHICH ENVIRONMENT. Code-owned and explicit:
// one factory per implemented (chain, network), keyed exactly as the
// retriever registry's allowlist is. A key present in the allowlist but
// absent here is a programming error surfaced as "no retriever" — never
// as another chain's adapter. Solana mainnet is implementation #1;
// Ethereum mainnet (TOKEN_SUPPLY only) is implementation #2, registered
// under its own key.
type AdapterDeps = Pick<SolanaAdapterDeps, "transport" | "providerId">;
const IMPLEMENTATION_BY_ENVIRONMENT: ReadonlyMap<string, (deps: AdapterDeps) => OnchainRetriever> =
  new Map([
    ["solana/mainnet", (deps) => createSolanaOnchainAdapter({ ...deps, finality: "finalized" })],
    [
      "ethereum/mainnet",
      (deps) => createEvmOnchainAdapter({ ...deps, environment: { chain: "ethereum", network: "mainnet" } }),
    ],
  ]);

// Resolves a production retriever for (chain, network) from server-side
// configuration, or returns null when this deployment has not enabled it.
// Returning null rather than throwing keeps an unconfigured environment a
// configuration boundary, not a research failure.
//
// `env` is the environment the endpoint is read from — the process's own
// by default. The capability installer passes the environment it decided
// from, so presence and value are read from one place.
export function createProductionOnchainRetriever(
  chain: string,
  network: string,
  opts: OnchainTransportOptions = {},
  env: Readonly<Record<string, string | undefined>> = process.env,
): OnchainRetriever | null {
  const envVar = endpointEnvVarFor(chain, network);
  if (!envVar) return null; // unlisted (chain, network) — structurally unreachable
  const endpoint = env[envVar];
  if (!endpoint || !isAcceptableEndpoint(endpoint)) return null;

  // The label that reaches provenance and trace. Derived from the
  // allowlist key, NEVER from the endpoint string, so no part of a
  // credential-bearing URL can leak downstream.
  const providerId = `${chain}-${network}-rpc`;
  const transport = createHttpsRpcTransport(endpoint, providerId, opts);

  const implementation = IMPLEMENTATION_BY_ENVIRONMENT.get(`${chain}/${network}`);
  if (!implementation) return null; // allowlisted but unimplemented — never another chain's adapter
  return implementation({ transport, providerId });
}
