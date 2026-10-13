import { z } from "zod";

import { buildCanonicalOnchainUri } from "../onchain-uri";
import {
  brandOnchainArtifact,
  type OnchainArtifact,
  type OnchainEnvironment,
  EVM_ZERO_ADDRESS,
  type EvmTokenTransferRef,
  type OnchainIntent,
  type TokenSupplyResult,
  type TransactionDetailResult,
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
// TWO PRIMITIVES, EACH SEPARATELY DECIDED (EVM V1, Founder-approved):
//
//   TOKEN_SUPPLY        total supply at the finalized head, or — only when
//                       the intent names one — at an explicit historical
//                       block that is at or below the finalized block.
//                       Historical state needs an archive-capable node; one
//                       that cannot serve it errors, and that error is a
//                       bounded technical stop, never a reading.
//   TRANSACTION_DETAIL  one transaction's receipt, for a hash the caller
//                       obtained from an admitted source, reduced to its
//                       success flag and the ERC-20 Transfer logs emitted by
//                       the CONFIRMED PROJECT-TOKEN CONTRACT. Logs of every
//                       other contract are not decoded and not kept.
//
// It does not read balances, does not discover logs (no eth_getLogs), does
// not decode exchanges, does not decode burns, and does not resolve proxies.
// An intent kind this adapter does not serve is refused by `supports()`
// before any request exists, and again in `retrieve()` if it is handed one
// anyway.
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
// topic0 of Transfer(address,address,uint256) — keccak256 of the signature,
// a code-owned constant. ERC-721 emits the same topic0 with FOUR topics
// (the token id is indexed); an ERC-20 Transfer has exactly three.
export const ERC20_TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const EVM_TRANSACTION_HASH = /^0x[0-9a-fA-F]{64}$/;
// An indexed address topic: 12 zero bytes, then the 20-byte address.
const ADDRESS_TOPIC = /^0x0{24}([0-9a-fA-F]{40})$/;

const FINALIZED_BLOCK_TAG = "finalized";

// The EVM chain id each implemented environment must answer with. Keyed
// exactly as the environment table is; an environment absent here cannot
// construct an adapter at all.
const EXPECTED_CHAIN_ID: ReadonlyMap<string, bigint> = new Map([["ethereum/mainnet", BigInt(1)]]);

export { EVM_ZERO_ADDRESS };

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

const receiptSchema = z
  .object({
    transactionHash: z.string(),
    blockNumber: z.string(),
    blockHash: z.string(),
    status: z.string(),
    logs: z.array(z.unknown()),
  })
  .loose();

const logSchema = z
  .object({
    address: z.string(),
    topics: z.array(z.string()),
    data: z.string(),
    logIndex: z.string(),
    transactionHash: z.string(),
    blockNumber: z.string(),
    removed: z.boolean().optional(),
  })
  .loose();

// ONE log, decoded as an ERC-20 Transfer of `anchor`, or null. Null is "not
// a Transfer of the project token that this adapter can read" — a foreign
// contract, another event, an ERC-721 shape, a malformed word — and never
// a statement that nothing moved.
function decodeAnchorTransfer(
  raw: unknown,
  anchor: string,
  receipt: { transactionHash: string; blockNumber: string },
): EvmTokenTransferRef | null {
  const parsed = logSchema.safeParse(raw);
  if (!parsed.success) return null;
  const log = parsed.data;
  if (log.removed === true) return null;
  if (log.address.toLowerCase() !== anchor.toLowerCase()) return null;
  if (log.transactionHash.toLowerCase() !== receipt.transactionHash.toLowerCase()) return null;
  if (log.blockNumber.toLowerCase() !== receipt.blockNumber.toLowerCase()) return null;
  if (log.topics.length !== 3) return null;
  if (log.topics[0].toLowerCase() !== ERC20_TRANSFER_TOPIC) return null;
  const from = ADDRESS_TOPIC.exec(log.topics[1]);
  const to = ADDRESS_TOPIC.exec(log.topics[2]);
  if (!from || !to) return null;
  const amount = abiWordToBigInt(log.data);
  const logIndex = quantityToBigInt(log.logIndex);
  if (amount === null || logIndex === null || logIndex > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return {
    logIndex: Number(logIndex),
    // The confirmed anchor exactly as confirmed. The log's address was just
    // checked equal to it ignoring case — an EIP-55 checksum is a spelling
    // of the same 20 bytes — so downstream identity is one exact comparison.
    token: anchor,
    from: `0x${from[1].toLowerCase()}`,
    to: `0x${to[1].toLowerCase()}`,
    amountRaw: amount.toString(),
  };
}

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
      return (
        chain === env.chain &&
        network === env.network &&
        (kind === "TOKEN_SUPPLY" || kind === "TRANSACTION_DETAIL")
      );
    },

    async retrieve(intent: OnchainIntent): Promise<OnchainArtifact> {
      if (intent.chain !== env.chain || intent.network !== env.network) {
        throw new OnchainRetrieverUnavailableError(
          `evm adapter for ${environmentKey} cannot serve ${intent.chain}/${intent.network}`,
        );
      }
      // Validate BEFORE any call: a malformed address never reaches an
      // endpoint, so it cannot become a request at all.
      if (!isValidEvmAddress(intent.projectAnchor)) {
        throw new OnchainRetrieverUnavailableError("invalid project anchor address");
      }
      if (intent.kind === "TRANSACTION_DETAIL" && intent.subjectKind === "tx") {
        if (intent.block !== undefined) {
          throw new OnchainRetrieverUnavailableError("a transaction read takes no block selector");
        }
        if (!EVM_TRANSACTION_HASH.test(intent.subject)) {
          throw new OnchainRetrieverUnavailableError("invalid transaction hash");
        }
        return retrieveTransaction(intent);
      }
      if (intent.kind !== "TOKEN_SUPPLY" || intent.subjectKind !== "token") {
        throw new OnchainRetrieverUnavailableError(
          `evm adapter serves TOKEN_SUPPLY and TRANSACTION_DETAIL only; refused ${intent.kind}`,
        );
      }
      if (!isValidEvmAddress(intent.subject)) {
        throw new OnchainRetrieverUnavailableError("invalid subject address");
      }
      if (
        intent.block !== undefined &&
        (!Number.isSafeInteger(intent.block) || intent.block < 0)
      ) {
        throw new OnchainRetrieverUnavailableError("invalid explicit block");
      }
      return retrieveSupply(intent);
    },
  };

  async function call(method: string, params: unknown[]) {
    const raw = await deps.transport.call(method, params);
    return { raw, result: jsonRpcResult(method, raw) };
  }

  // 1. The endpoint must be the declared chain.
  async function checkChainId() {
    const chainId = await call("eth_chainId", []);
    const observedChainId = quantityToBigInt(chainId.result);
    if (observedChainId === null) {
      throw new OnchainRetrieverUnavailableError("eth_chainId did not return a quantity");
    }
    if (observedChainId !== expectedChainId) {
      throw new OnchainRetrieverUnavailableError(
        `endpoint reports chain id ${observedChainId.toString()} but ${environmentKey} requires ${expectedChainId!.toString()}`,
      );
    }
    return chainId;
  }

  // A block, by tag or by explicit number, reduced to its position. Null or
  // an error is "not available here", and that is a refusal — never a
  // fallback to latest.
  async function readBlock(tag: string, unavailable: string) {
    const block = await call("eth_getBlockByNumber", [tag, false]);
    if (block.result === null || block.result === undefined) {
      throw new OnchainRetrieverUnavailableError(unavailable);
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
      throw new OnchainRetrieverUnavailableError("block carries no usable position");
    }
    return {
      raw: block.raw,
      number: blockNumberBig,
      time: Number(blockTimeBig),
      hash: parsedBlock.data.hash.toLowerCase(),
    };
  }

  async function retrieveSupply(intent: OnchainIntent): Promise<OnchainArtifact> {
    const retrievedAt = new Date();
    const chainId = await checkChainId();

    // 2. The finalized block, by tag.
    const finalized = await readBlock(
      FINALIZED_BLOCK_TAG,
      "finalized block is not available from this endpoint",
    );

    // 2b. AN EXPLICIT BLOCK, only when the intent names one. It must be at
    // or below the finalized block — a block above it is not final and is
    // refused, never read and called finalized — and it is then read by
    // number so its own hash and timestamp stand in the provenance.
    let pinned: Awaited<ReturnType<typeof readBlock>> | null = null;
    if (intent.block !== undefined) {
      if (BigInt(intent.block) > finalized.number) {
        throw new OnchainRetrieverUnavailableError("explicit block is not finalized");
      }
      pinned = await readBlock(
        `0x${BigInt(intent.block).toString(16)}`,
        "explicit block is not available from this endpoint",
      );
      if (pinned.number !== BigInt(intent.block)) {
        throw new OnchainRetrieverUnavailableError("endpoint returned a different block than requested");
      }
    }
    const position = pinned ?? finalized;
    const blockNumber = Number(position.number);
    // Both reads are pinned to THIS block by explicit number, not by
    // re-asking for the tag, so they cannot land on two different blocks.
    const blockTag = `0x${position.number.toString(16)}`;

    // 3. totalSupply() at that block. At a historical block this needs
    // archive state; a node without it answers with an error, which fails
    // the read as a technical limitation.
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
        // The observed block number is this environment's ordinal.
        slot: blockNumber,
        blockTime: position.time,
        blockHash: position.hash,
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
          ...(pinned === null ? {} : { explicitBlock: true }),
        },
        transactionSignature: null,
        retrievedAt,
        // The observation's responses; the hash covers all of them, keyed by
        // the call that produced each, exactly as received. A head read
        // hashes the same four keys it always did.
        rawResponseHash: sha256(
          canonicalJson({
            eth_chainId: chainId.raw,
            eth_getBlockByNumber: finalized.raw,
            ...(pinned === null ? {} : { eth_getBlockByNumber_explicit: pinned.raw }),
            totalSupply: supply.raw,
            decimals: decimals.raw,
          }),
        ),
        artifactHash: sha256(normalizedText),
      },
    });
  }

  // ONE RECEIPT, FOUR BOUNDED CALLS: chain id; the receipt; the finalized
  // block (the receipt's block must be at or below it); the receipt's block
  // by number (its hash must equal the receipt's, so the transaction is on
  // the canonical chain). Anything else fails closed and no artifact exists.
  async function retrieveTransaction(intent: OnchainIntent): Promise<OnchainArtifact> {
    const retrievedAt = new Date();
    const chainId = await checkChainId();

    const receiptCall = await call("eth_getTransactionReceipt", [intent.subject]);
    if (receiptCall.result === null || receiptCall.result === undefined) {
      throw new OnchainRetrieverUnavailableError("transaction receipt is not available from this endpoint");
    }
    const parsedReceipt = receiptSchema.safeParse(receiptCall.result);
    if (!parsedReceipt.success) {
      throw new OnchainRetrieverUnavailableError("eth_getTransactionReceipt returned an unusable receipt");
    }
    const receipt = parsedReceipt.data;
    if (receipt.transactionHash.toLowerCase() !== intent.subject.toLowerCase()) {
      throw new OnchainRetrieverUnavailableError("receipt is for a different transaction");
    }
    const receiptBlock = quantityToBigInt(receipt.blockNumber);
    if (
      receiptBlock === null ||
      receiptBlock > BigInt(Number.MAX_SAFE_INTEGER) ||
      !HEX_32_BYTES.test(receipt.blockHash)
    ) {
      throw new OnchainRetrieverUnavailableError("receipt carries no usable position");
    }
    // Post-Byzantium receipts carry status 0x1 (success) or 0x0 (reverted).
    // Anything else is not a status this adapter can read.
    if (receipt.status !== "0x1" && receipt.status !== "0x0") {
      throw new OnchainRetrieverUnavailableError("receipt carries no usable status");
    }
    const succeeded = receipt.status === "0x1";

    const finalized = await readBlock(
      FINALIZED_BLOCK_TAG,
      "finalized block is not available from this endpoint",
    );
    if (receiptBlock > finalized.number) {
      throw new OnchainRetrieverUnavailableError("transaction is not in a finalized block");
    }
    const block = await readBlock(
      `0x${receiptBlock.toString(16)}`,
      "the transaction's block is not available from this endpoint",
    );
    if (block.number !== receiptBlock || block.hash !== receipt.blockHash.toLowerCase()) {
      throw new OnchainRetrieverUnavailableError("the transaction's block is not on the canonical chain");
    }

    // Only the project token's Transfer logs, and none at all from a
    // reverted transaction: a reverted transaction moved nothing.
    const evmTokenTransfers: EvmTokenTransferRef[] = [];
    if (succeeded) {
      for (const raw of receipt.logs) {
        const transfer = decodeAnchorTransfer(raw, intent.projectAnchor, receipt);
        if (transfer !== null) evmTokenTransfers.push(transfer);
      }
      evmTokenTransfers.sort((a, b) => a.logIndex - b.logIndex);
    }

    const signature = intent.subject.toLowerCase();
    const slot = Number(receiptBlock);
    const result: TransactionDetailResult = {
      kind: "TRANSACTION_DETAIL",
      signature,
      slot,
      blockTime: block.time,
      succeeded,
      // Solana-shaped fields stay empty: nothing of the kind was decoded,
      // and an empty list here is never a finding.
      burns: [],
      programs: [],
      accountKeys: [],
      tokenInstructions: [],
      lifecycleInstructions: [],
      preTokenBalances: [],
      postTokenBalances: [],
      evmTokenTransfers,
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
        slot,
        blockTime: block.time,
        blockHash: block.hash,
        finality: "finalized",
        retrievalMethod: "RPC",
        providerId: deps.providerId,
        providerMethod: "eth_getTransactionReceipt",
        requestParams: {
          subject: intent.subject,
          chainId: Number(expectedChainId),
          block: slot,
          transferTopic: ERC20_TRANSFER_TOPIC,
        },
        transactionSignature: signature,
        retrievedAt,
        rawResponseHash: sha256(
          canonicalJson({
            eth_chainId: chainId.raw,
            eth_getTransactionReceipt: receiptCall.raw,
            eth_getBlockByNumber: finalized.raw,
            eth_getBlockByNumber_transaction: block.raw,
          }),
        ),
        artifactHash: sha256(normalizedText),
      },
    });
  }
}

export const __testing = { quantityToBigInt, abiWordToBigInt };
