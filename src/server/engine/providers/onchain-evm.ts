import { z } from "zod";

import { buildCanonicalOnchainUri } from "../onchain-uri";
import {
  brandOnchainArtifact,
  type OnchainArtifact,
  type OnchainEnvironment,
  type OnchainIntent,
  type TokenSupplyResult,
} from "./onchain-types";
import {
  OnchainRetrieverUnavailableError,
  type OnchainRetriever,
  type OnchainRpcTransport,
} from "./onchain-retriever";
import { canonicalJson, jsonRpcResult, sha256 } from "./onchain-jsonrpc";

// EVM adapter — implementation #2 of the deterministic evidence seam.
//
// The ONLY place EVM-specific mechanics live: hex validation, eth_chainId,
// eth_getBlockByNumber, eth_call, and ABI return-word decoding for a CLOSED
// set of methods. The Research Core above this module sees exactly what it
// sees from Solana: a TOKEN_SUPPLY result, a chain position, provenance.
// Nothing here is project-specific, and nothing here is a general contract
// caller — there is no "call any view function", and there is no path by
// which a caller could supply a selector.
//
// ONE PRIMITIVE. This adapter serves TOKEN_SUPPLY and nothing else. It does
// not read balances, logs, receipts, transfers or events, does not decode
// burns, does not resolve proxies, and does not read history. Each of
// those is a separate, separately-decided primitive; an intent kind this
// adapter does not serve is refused by `supports()` before any request
// exists, and again in `retrieve()` if it is handed one anyway.
//
// FOUR BOUNDED CALLS PER OBSERVATION, in a fixed order, each with a fixed
// method and closed parameters:
//
//   1. eth_chainId            — the endpoint must BE the declared chain.
//                               A wrong chain id fails closed; an endpoint
//                               is never trusted to be what its env var
//                               says it is.
//   2. eth_getBlockByNumber   — the FINALIZED block, by tag. A node that
//      ["finalized", false]     cannot serve the finalized tag returns an
//                               error or null, and this adapter fails
//                               closed rather than reading "latest" and
//                               calling it finalized.
//   3. eth_call totalSupply() — pinned to that block by explicit number.
//   4. eth_call decimals()    — pinned to the SAME block. Decimals are
//                               READ, never assumed 18.
//
// CHAIN POSITION. The finalized block number is the environment's ordinal
// (the seam's `slot` field; the persisted column keeps its name); the
// block hash and timestamp travel with it. Finality is "finalized" because
// the block was obtained by the finalized tag — the same commitment level
// the Solana adapter requests — so every downstream finality expectation
// (`NON_FINALIZED_OBSERVATION`, interval anchoring) holds without a special
// case.

// 20-byte address, 32-byte hash / ABI word, and a JSON-RPC QUANTITY
// (0x-prefixed hex, no leading zeros except "0x0" itself).
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX_32_BYTES = /^0x[0-9a-fA-F]{64}$/;
const HEX_QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;

// The closed method set. Selectors are the first four bytes of
// keccak256("totalSupply()") and keccak256("decimals()") — code-owned
// constants, not derived at runtime and not extensible from outside.
export const ERC20_TOTAL_SUPPLY_SELECTOR = "0x18160ddd";
export const ERC20_DECIMALS_SELECTOR = "0x313ce567";

const FINALIZED_BLOCK_TAG = "finalized";

// The EVM chain id each implemented environment must answer with. Keyed
// exactly as the environment table is; an environment absent here cannot
// construct an adapter at all.
const EXPECTED_CHAIN_ID: ReadonlyMap<string, bigint> = new Map([["ethereum/mainnet", BigInt(1)]]);

export function isValidEvmAddress(value: string): boolean {
  return EVM_ADDRESS.test(value);
}

// A JSON-RPC quantity to a BigInt, or null when it is not one. BigInt, not
// Number: a uint256 does not fit a double, and a silently rounded supply
// is a wrong fact that looks right.
function quantityToBigInt(value: unknown): bigint | null {
  if (typeof value !== "string" || !HEX_QUANTITY.test(value)) return null;
  return BigInt(value);
}

// One ABI return word (uint256) to a BigInt. EXACTLY 32 bytes: an empty
// return ("0x") is what a call to an address with no code produces, and a
// longer or shorter word is not the type the method declares. Neither is
// decoded; both fail closed.
function abiWordToBigInt(value: unknown): bigint | null {
  if (typeof value !== "string" || !HEX_32_BYTES.test(value)) return null;
  return BigInt(value);
}

const finalizedBlockSchema = z
  .object({
    number: z.string(),
    hash: z.string(),
    timestamp: z.string(),
  })
  .loose();

export interface EvmAdapterDeps {
  transport: OnchainRpcTransport;
  providerId: string;
  environment: OnchainEnvironment;
}

export function createEvmOnchainAdapter(deps: EvmAdapterDeps): OnchainRetriever {
  const env = deps.environment;
  const environmentKey = `${env.chain}/${env.network}`;
  const expectedChainId = EXPECTED_CHAIN_ID.get(environmentKey);
  if (expectedChainId === undefined) {
    throw new OnchainRetrieverUnavailableError(
      `evm adapter has no chain id declared for ${environmentKey}`,
    );
  }

  return {
    name: `evm-rpc:${deps.providerId}`,

    supports(chain: string, network: string, kind: string): boolean {
      return chain === env.chain && network === env.network && kind === "TOKEN_SUPPLY";
    },

    async retrieve(intent: OnchainIntent): Promise<OnchainArtifact> {
      if (intent.chain !== env.chain || intent.network !== env.network) {
        throw new OnchainRetrieverUnavailableError(
          `evm adapter for ${environmentKey} cannot serve ${intent.chain}/${intent.network}`,
        );
      }
      if (intent.kind !== "TOKEN_SUPPLY" || intent.subjectKind !== "token") {
        throw new OnchainRetrieverUnavailableError(
          `evm adapter serves TOKEN_SUPPLY only; refused ${intent.kind}`,
        );
      }
      // Validate BEFORE any call: a malformed address never reaches an
      // endpoint, so it cannot become a request at all.
      if (!isValidEvmAddress(intent.projectAnchor)) {
        throw new OnchainRetrieverUnavailableError("invalid project anchor address");
      }
      if (!isValidEvmAddress(intent.subject)) {
        throw new OnchainRetrieverUnavailableError("invalid subject address");
      }

      const retrievedAt = new Date();
      const call = async (method: string, params: unknown[]) => {
        const raw = await deps.transport.call(method, params);
        return { raw, result: jsonRpcResult(method, raw) };
      };

      // 1. The endpoint must be the declared chain.
      const chainId = await call("eth_chainId", []);
      const observedChainId = quantityToBigInt(chainId.result);
      if (observedChainId === null) {
        throw new OnchainRetrieverUnavailableError("eth_chainId did not return a quantity");
      }
      if (observedChainId !== expectedChainId) {
        throw new OnchainRetrieverUnavailableError(
          `endpoint reports chain id ${observedChainId.toString()} but ${environmentKey} requires ${expectedChainId.toString()}`,
        );
      }

      // 2. The finalized block, by tag. Null or an error is "finality not
      // available here", and that is a refusal — never a fallback to latest.
      const block = await call("eth_getBlockByNumber", [FINALIZED_BLOCK_TAG, false]);
      if (block.result === null || block.result === undefined) {
        throw new OnchainRetrieverUnavailableError("finalized block is not available from this endpoint");
      }
      const parsedBlock = finalizedBlockSchema.safeParse(block.result);
      if (!parsedBlock.success) {
        throw new OnchainRetrieverUnavailableError("eth_getBlockByNumber returned an unusable block");
      }
      const blockNumberBig = quantityToBigInt(parsedBlock.data.number);
      const blockTimeBig = quantityToBigInt(parsedBlock.data.timestamp);
      if (
        blockNumberBig === null ||
        blockTimeBig === null ||
        !HEX_32_BYTES.test(parsedBlock.data.hash) ||
        blockNumberBig > BigInt(Number.MAX_SAFE_INTEGER) ||
        blockTimeBig > BigInt(Number.MAX_SAFE_INTEGER)
      ) {
        throw new OnchainRetrieverUnavailableError("finalized block carries no usable position");
      }
      const blockNumber = Number(blockNumberBig);
      const blockTime = Number(blockTimeBig);
      const blockHash = parsedBlock.data.hash.toLowerCase();
      // Both reads are pinned to THIS block by explicit number, not by
      // re-asking for the tag, so they cannot land on two different blocks.
      const blockTag = `0x${blockNumberBig.toString(16)}`;

      // 3. totalSupply() at that block.
      const supply = await call("eth_call", [
        { to: intent.subject, data: ERC20_TOTAL_SUPPLY_SELECTOR },
        blockTag,
      ]);
      const totalSupply = abiWordToBigInt(supply.result);
      if (totalSupply === null) {
        throw new OnchainRetrieverUnavailableError(
          "totalSupply() returned no decodable uint256 word (no code at the address, or not an ERC-20)",
        );
      }

      // 4. decimals() at the SAME block. Read, never assumed.
      const decimals = await call("eth_call", [
        { to: intent.subject, data: ERC20_DECIMALS_SELECTOR },
        blockTag,
      ]);
      const decimalsBig = abiWordToBigInt(decimals.result);
      if (decimalsBig === null || decimalsBig > BigInt(255)) {
        throw new OnchainRetrieverUnavailableError(
          "decimals() returned no decodable uint8 word (no code at the address, or not an ERC-20)",
        );
      }

      const result: TokenSupplyResult = {
        kind: "TOKEN_SUPPLY",
        mint: intent.subject,
        amountRaw: totalSupply.toString(),
        decimals: Number(decimalsBig),
      };
      const normalizedText = canonicalJson(result);

      return brandOnchainArtifact({
        canonicalUri: buildCanonicalOnchainUri(intent),
        intent,
        result,
        normalizedText,
        provenance: {
          chain: intent.chain,
          network: intent.network,
          projectAnchor: intent.projectAnchor,
          subjectKind: intent.subjectKind,
          subject: intent.subject,
          // The finalized block number is this environment's ordinal.
          slot: blockNumber,
          blockTime,
          blockHash,
          finality: "finalized",
          retrievalMethod: "RPC",
          // A code-owned LABEL, never the endpoint URL and never a key.
          providerId: deps.providerId,
          providerMethod: "eth_call",
          // Addresses, selectors and a block number — nothing
          // credential-bearing exists in these parameter lists.
          requestParams: {
            subject: intent.subject,
            chainId: Number(expectedChainId),
            block: blockNumber,
            totalSupplySelector: ERC20_TOTAL_SUPPLY_SELECTOR,
            decimalsSelector: ERC20_DECIMALS_SELECTOR,
          },
          transactionSignature: null,
          retrievedAt,
          // The observation is four responses; the hash covers all four,
          // keyed by the call that produced each, exactly as received.
          rawResponseHash: sha256(
            canonicalJson({
              eth_chainId: chainId.raw,
              eth_getBlockByNumber: block.raw,
              totalSupply: supply.raw,
              decimals: decimals.raw,
            }),
          ),
          artifactHash: sha256(normalizedText),
        },
      });
    },
  };
}

export const __testing = { quantityToBigInt, abiWordToBigInt };
