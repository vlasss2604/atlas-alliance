import { createHash } from "node:crypto";

import { z } from "zod";

import { buildCanonicalOnchainUri } from "../onchain-uri";
import {
  brandOnchainArtifact,
  type AccountLifecycleRef,
  type BurnInstructionRef,
  type RawInstructionRef,
  type TokenBalanceRef,
  type TokenInstructionRef,
  type ParsedTokenAccountRef,
  type TokenAccountRelation,
  type TokenAccountRef,
  type OnchainArtifact,
  type OnchainIntent,
  type OnchainResult,
} from "./onchain-types";
import { OnchainRetrieverUnavailableError, type OnchainRpcTransport } from "./onchain-retriever";

// Solana adapter — the ONLY place Solana-specific encoding, RPC method
// names and response shapes live. The core contract knows about chains,
// intents, subjects and provenance; it knows nothing about base58, SPL, or
// getTokenSupply.
//
// Nothing here is project-specific. No mint, program or address is
// hard-coded anywhere in this file except the SPL Token program ids, which
// are chain infrastructure (the same two constants for every project on
// Solana), not any project's identity.

// SPL Token and Token-2022 program ids. Chain infrastructure constants.
const SPL_TOKEN_PROGRAM_IDS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
]);

// Base58 alphabet: no 0, O, I or l. Length bounds cover the 32-byte
// address space; signatures are 64 bytes and therefore longer.
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BASE58_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

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

// Exported so research logic can ask "is this account program-owned by an
// SPL Token program?" without an address literal of its own. The constants
// stay here, in the adapter, where chain infrastructure belongs.
export function isSplTokenProgramId(programId: string | null | undefined): boolean {
  return typeof programId === "string" && SPL_TOKEN_PROGRAM_IDS.has(programId);
}

export function isValidSolanaAddress(value: string): boolean {
  return BASE58_ADDRESS.test(value);
}

export function isValidSolanaSignature(value: string): boolean {
  return BASE58_SIGNATURE.test(value);
}

// Closed method set. There is no pass-through: an intent maps to exactly
// one of these, and nothing else can ever be sent to an endpoint.
const METHOD_FOR_INTENT = {
  TOKEN_SUPPLY: "getTokenSupply",
  ACCOUNT_INFO: "getAccountInfo",
  TOKEN_ACCOUNT_BALANCE: "getTokenAccountBalance",
  SIGNATURES_FOR_ADDRESS: "getSignaturesForAddress",
  TRANSACTION_DETAIL: "getTransaction",
  TOKEN_ACCOUNTS_BY_OWNER: "getTokenAccountsByOwner",
} as const satisfies Record<OnchainIntent["kind"], string>;

export const SOLANA_ALLOWED_RPC_METHODS: ReadonlySet<string> = new Set(
  Object.values(METHOD_FOR_INTENT),
);

// Hard bound on how many signatures one intent may request, so a
// paginating caller cannot turn a cheap RPC into an unbounded loop.
export const MAX_SIGNATURES_PER_INTENT = 25;

// ---- response schemas -------------------------------------------------
// Every response is validated before a single field is read. Unknown
// fields are ignored; a missing or malformed required field is a typed
// failure, never a default.

// JSON-RPC 2.0 envelope. `result` may legitimately be null (an account or
// transaction that does not exist), so its presence is not required — the
// discriminator is the absence of `error`.
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

const uiAmount = z.object({
  amount: z.string().regex(/^\d+$/),
  decimals: z.number().int().min(0).max(32),
});

const contextual = <T extends z.ZodTypeAny>(value: T) =>
  z.object({ context: z.object({ slot: z.number().int().min(0) }), value });

const tokenSupplySchema = contextual(uiAmount);
const tokenAccountBalanceSchema = contextual(uiAmount);

// ACCOUNT DATA HAS TWO VALID SHAPES, AND ONLY ONE WAS ACCEPTED.
//
// jsonParsed is a REQUEST, not a guarantee. The node parses account data
// when it has a parser for the owning program and otherwise falls back to
// the encoded form [<data>, <encoding>] — a standards-valid answer, not an
// error. A System-owned account has no parser at all, so the fallback is
// the ORDINARY case for exactly the addresses a documentary locator most
// often names. Accepting only the object form made the adapter reject a
// correct response and report "schema validation failed", which reads as a
// provider fault when the provider did nothing wrong.
//
// A UNION, NOT A LOOSENING. The fallback is admitted in its exact shape —
// a two-element tuple whose second element is one of the encodings this
// RPC actually emits — so an unknown shape is still refused. There is no
// z.any() and no passthrough anywhere on this path.
//
// The fallback carries NO parsed identity, which is the point: it says
// what the account is not parseable as, never what it is. Classification
// therefore falls to the program owner alone, and a token-program-owned
// account whose data could not be parsed stays UNRESOLVED rather than
// being demoted to an ordinary account.
const encodedAccountDataSchema = z.tuple([
  z.string(),
  // The encodings getAccountInfo genuinely returns for the array form.
  // Deliberately closed: a form this adapter cannot interpret must not be
  // silently accepted as if it had been understood.
  z.enum(["base64", "base58", "base64+zstd"]),
]);

const parsedAccountDataSchema = z
  .object({
    program: z.string().optional(),
    parsed: z
      .object({
        type: z.string().optional(),
        info: z.record(z.string(), z.unknown()).optional(),
      })
      .optional(),
  })
  .loose();

const accountInfoSchema = contextual(
  z
    .object({
      owner: z.string(),
      executable: z.boolean(),
      lamports: z.number().int().min(0),
      data: z.union([parsedAccountDataSchema, encodedAccountDataSchema]).optional(),
    })
    .nullable(),
);

// Hard bound on memo text entering an artifact. A memo is arbitrary,
// externally-authored content; without a ceiling a single transaction
// could inflate normalizedText without limit. Truncation is visible in the
// value rather than silent, so a reader can never mistake a cut string for
// the whole memo.
const MAX_MEMO_CHARS = 256;
const MEMO_TRUNCATION_SUFFIX = "…[truncated]";

function boundMemo(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length <= MAX_MEMO_CHARS) return trimmed;
  return trimmed.slice(0, MAX_MEMO_CHARS) + MEMO_TRUNCATION_SUFFIX;
}

const signaturesSchema = z.array(
  z.object({
    signature: z.string(),
    slot: z.number().int().min(0),
    blockTime: z.number().int().nullable().optional(),
    err: z.unknown().nullable().optional(),
    // Declared so it survives the projection. zod strips undeclared keys,
    // which is why this field was silently discarded before. Typed as
    // unknown-nullable rather than string: a node that returns a non-string
    // here must yield null, not a parse failure that loses the whole page.
    memo: z.unknown().nullable().optional(),
  }),
);

// getTokenAccountsByOwner (jsonParsed). Every field the binding check
// below needs is REQUIRED here — a missing owner, mint or amount is a
// malformed entry, not a defaulted one. `amount` is a STRING in the RPC
// response and is kept a string all the way through: parsing a u64
// balance into a double loses precision silently, and a silently
// rounded balance is a wrong fact that looks right.
const tokenAccountsByOwnerSchema = contextual(
  z.array(
    z.object({
      pubkey: z.string(),
      account: z.object({
        owner: z.string(),
        data: z.object({
          parsed: z.object({
            info: z.object({
              owner: z.string(),
              mint: z.string(),
              tokenAmount: z.object({
                amount: z.string(),
                decimals: z.number().int().min(0),
              }),
            }),
          }),
        }),
      }),
    }),
  ),
);

// An instruction arrives in one of two shapes. A program the node knows
// comes back parsed, with no data or accounts; anything else comes back
// with the account list and the opaque blob instead. Both are accepted,
// and which one arrived is what decides whether an instruction can be
// decoded now or only preserved for later.
const parsedInstructionSchema = z.object({
  programId: z.string().optional(),
  parsed: z
    .object({
      type: z.string().optional(),
      info: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  accounts: z.array(z.string()).optional(),
  data: z.string().optional(),
});

// jsonParsed account keys arrive as objects ({ pubkey, signer, writable })
// on modern nodes and as bare strings on older ones. Both are accepted;
// anything else yields no key rather than a guess.
const accountKeySchema = z.union([
  z.string(),
  z.object({ pubkey: z.string() }).loose(),
]);

const tokenBalanceSchema = z.object({
  accountIndex: z.number().int().min(0),
  mint: z.string(),
  owner: z.string().optional(),
  uiTokenAmount: z.object({
    amount: z.string(),
    decimals: z.number().int().min(0),
  }),
});

const transactionSchema = z
  .object({
    slot: z.number().int().min(0),
    blockTime: z.number().int().nullable().optional(),
    transaction: z.object({
      signatures: z.array(z.string()).min(1),
      message: z.object({
        instructions: z.array(parsedInstructionSchema).default([]),
        accountKeys: z.array(accountKeySchema).default([]),
      }),
    }),
    meta: z
      .object({
        err: z.unknown().nullable().optional(),
        // `index` is the ordinal of the OUTER instruction these were
        // invoked from. Optional because a node that omits it must not
        // fail the whole read — the linkage is then simply absent, which
        // is different from being reconstructed.
        innerInstructions: z
          .array(
            z.object({
              index: z.number().int().min(0).optional(),
              instructions: z.array(parsedInstructionSchema).default([]),
            }),
          )
          .optional(),
        preTokenBalances: z.array(tokenBalanceSchema).nullable().optional(),
        postTokenBalances: z.array(tokenBalanceSchema).nullable().optional(),
      })
      .nullable()
      .optional(),
  })
  .nullable();

// Bounds on what one transaction may contribute to an artifact. A
// transaction is externally authored; without ceilings a pathological
// one could inflate the stored result without limit.
const MAX_TX_ACCOUNT_KEYS = 128;
const MAX_TX_INSTRUCTIONS = 128;
const MAX_TX_TOKEN_BALANCES = 128;
// Ceilings for a preserved unparsed instruction. An instruction beyond
// them is DROPPED rather than shortened: a truncated blob still looks
// decodable, and something that looks decodable and is not is worse than
// nothing at all.
const MAX_RAW_INSTRUCTION_ACCOUNTS = 64;
const MAX_RAW_INSTRUCTION_DATA_CHARS = 4096;

// Base58 with no length bound — an instruction blob is not an address.
const BASE58_BLOB = /^[1-9A-HJ-NP-Za-km-z]+$/;

// Where an instruction sat, carried alongside it so every decoder can
// record the position without re-deriving it.
interface InstructionPosition {
  inner: boolean;
  instructionIndex: number;
  parentIndex: number | null;
}

// The SPL Token instruction types this adapter recognises. A closed set:
// an unrecognised type is simply not reported, never guessed at.
const RECOGNISED_TOKEN_INSTRUCTIONS = new Set([
  "burn",
  "burnChecked",
  "transfer",
  "transferChecked",
  "closeAccount",
]);

function firstString(info: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = info[k];
    if (typeof v === "string") return v;
  }
  return null;
}

// Decodes ONE parsed instruction into a typed reference. Decoding is not
// interpretation: a transfer to an address someone calls a burn address
// is reported as a transfer, and nothing here can say otherwise.
function decodeTokenInstruction(
  raw: unknown,
  inner: boolean,
  pos?: InstructionPosition,
): TokenInstructionRef | null {
  const parsed = parsedInstructionSchema.safeParse(raw);
  if (!parsed.success) return null;
  const ix = parsed.data;
  const programId = ix.programId;
  if (!programId || !SPL_TOKEN_PROGRAM_IDS.has(programId)) return null;
  const type = ix.parsed?.type;
  if (!type || !RECOGNISED_TOKEN_INSTRUCTIONS.has(type)) return null;
  const info = ix.parsed?.info ?? {};
  const tokenAmount = info.tokenAmount as { amount?: unknown; decimals?: unknown } | undefined;
  const amountRaw =
    typeof info.amount === "string"
      ? info.amount
      : typeof tokenAmount?.amount === "string"
        ? tokenAmount.amount
        : null;
  const decimals =
    typeof info.decimals === "number"
      ? info.decimals
      : typeof tokenAmount?.decimals === "number"
        ? tokenAmount.decimals
        : null;
  return {
    programId,
    type,
    mint: firstString(info, ["mint"]),
    account: firstString(info, ["account", "source"]),
    destination: firstString(info, ["destination"]),
    authority: firstString(info, ["authority", "owner", "multisigAuthority"]),
    amountRaw,
    decimals,
    inner,
    ...positionOf(pos),
  };
}

// ---- account lifecycle decoding ---------------------------------------
// System, Associated Token Account and SPL Token instructions that
// establish how an account came to exist and who owns it.
//
// THE ONLY PATH TO AN OWNER. Nothing else in this adapter can populate
// AccountLifecycleRef.owner: not a transfer authority, not a close
// authority, not a close destination, not a payer. Those are all separate
// fields on separate types, and an ephemeral account whose transaction
// contains no initialization simply has no recoverable owner here.

// Chain infrastructure constants, like the token program ids above.
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

// Closed sets, per program. An unrecognised type is not reported.
const SYSTEM_LIFECYCLE_TYPES = new Set([
  "createAccount",
  "createAccountWithSeed",
  "transfer",
]);
const ATA_LIFECYCLE_TYPES = new Set(["create", "createIdempotent"]);
const TOKEN_LIFECYCLE_TYPES = new Set([
  "initializeAccount",
  "initializeAccount2",
  "initializeAccount3",
  "syncNative",
]);

// The instruction types whose `owner`/`wallet` field is the token
// account's owner by protocol definition. Deliberately a set rather than a
// condition spread through the decoder: adding a type to it is the single
// visible act that grants a new instruction ownership-establishing power.
const OWNER_ESTABLISHING_TYPES = new Set([
  "initializeAccount",
  "initializeAccount2",
  "initializeAccount3",
  "create",
  "createIdempotent",
]);

function lamportsOf(info: Record<string, unknown>): string | null {
  const v = info["lamports"];
  if (typeof v === "string") return v;
  // The RPC emits lamports as a JSON number. Converting through a string
  // keeps the stored shape uniform with every other amount; values above
  // 2^53 cannot survive the node's own JSON either, so nothing is lost
  // here that was not already lost upstream.
  if (typeof v === "number" && Number.isSafeInteger(v)) return String(v);
  return null;
}

function decodeLifecycleInstruction(
  raw: unknown,
  inner: boolean,
  pos?: InstructionPosition,
): AccountLifecycleRef | null {
  const parsed = parsedInstructionSchema.safeParse(raw);
  if (!parsed.success) return null;
  const ix = parsed.data;
  const programId = ix.programId;
  const type = ix.parsed?.type;
  if (!programId || !type) return null;
  const info = ix.parsed?.info ?? {};

  const isSystem = programId === SYSTEM_PROGRAM_ID && SYSTEM_LIFECYCLE_TYPES.has(type);
  const isAta =
    programId === ASSOCIATED_TOKEN_PROGRAM_ID && ATA_LIFECYCLE_TYPES.has(type);
  const isToken = SPL_TOKEN_PROGRAM_IDS.has(programId) && TOKEN_LIFECYCLE_TYPES.has(type);
  if (!isSystem && !isAta && !isToken) return null;

  // System createAccount names the account under `newAccount`; ATA
  // creation and token initialization both use `account`.
  const account = firstString(info, ["newAccount", "account"]);

  // OWNER IS GATED ON THE INSTRUCTION TYPE, not on which key happens to be
  // present. System createAccount also carries an `owner` key, and it
  // means the assigned program — reading it here would name the SPL Token
  // program as the owner of every token account ever created.
  const owner = OWNER_ESTABLISHING_TYPES.has(type)
    ? firstString(info, isAta ? ["wallet"] : ["owner"])
    : null;

  const assignedProgram = isSystem ? firstString(info, ["owner"]) : null;

  // ATA creation names the funder as `source`; System createAccount uses
  // `source` for the funding account as well. Neither is an owner.
  const payer = isSystem || isAta ? firstString(info, ["source", "payer"]) : null;

  return {
    programId,
    type,
    inner,
    account,
    mint: firstString(info, ["mint"]),
    owner,
    assignedProgram,
    payer,
    source: firstString(info, ["source"]),
    destination: firstString(info, ["destination"]),
    lamports: lamportsOf(info),
    tokenProgram: isAta ? firstString(info, ["tokenProgram"]) : null,
    ...positionOf(pos),
  };
}

// Classifies the account's relationship to SPL token accounts, and reads
// the parsed identity when there is one.
//
// THREE OUTCOMES, NEVER TWO. The program owner decides whether this is a
// token account at all; the parsed data decides whether we know WHICH mint.
// Those are separate questions, and the second failing does not answer the
// first in the negative.
//
// The program-owner gate comes first for a reason: any program may return
// parsed data containing a field called "mint", and only an SPL Token
// program's account is an SPL token account.
function classifyTokenAccount(
  ownerProgram: string | null,
  // Either shape the RPC may return. The encoded fallback is an ARRAY and
  // carries no parsed identity, so it can only ever narrow to "unresolved"
  // — never to a mint, and never to "not a token account".
  data:
    | { program?: string; parsed?: { type?: string; info?: Record<string, unknown> } }
    | [string, string]
    | undefined,
): { tokenAccountRelation: TokenAccountRelation; tokenAccount: ParsedTokenAccountRef | null } {
  if (!ownerProgram || !SPL_TOKEN_PROGRAM_IDS.has(ownerProgram)) {
    // Established: not a token account.
    return { tokenAccountRelation: "NOT_TOKEN_PROGRAM_OWNED", tokenAccount: null };
  }
  // From here on we KNOW it is a token account. Every remaining failure is
  // "which mint?" going unanswered — never a demotion to ordinary.
  const unresolved = {
    tokenAccountRelation: "TOKEN_PROGRAM_OWNED_UNRESOLVED" as const,
    tokenAccount: null,
  };
  // An encoded fallback is not a parsed object: no identity, no mint, and
  // no basis for anything but the unresolved answer.
  const parsedData = Array.isArray(data) ? undefined : data;
  const info = parsedData?.parsed?.info;
  if (!info) return unresolved;
  const mint = typeof info.mint === "string" ? info.mint : null;
  if (!mint || !BASE58_ADDRESS.test(mint)) return unresolved;
  const owner = typeof info.owner === "string" && BASE58_ADDRESS.test(info.owner) ? info.owner : null;
  const amount = info.tokenAmount as { amount?: unknown; decimals?: unknown } | undefined;
  return {
    tokenAccountRelation: "TOKEN_ACCOUNT_PARSED",
    tokenAccount: {
      mint,
      owner,
      amountRaw: typeof amount?.amount === "string" ? amount.amount : null,
      decimals: typeof amount?.decimals === "number" ? amount.decimals : null,
      state: typeof info.state === "string" ? info.state : null,
    },
  };
}

function programIdOf(raw: unknown): string | null {
  const parsed = parsedInstructionSchema.safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data.programId ?? null;
}

// ---- SPL burn decoding -----------------------------------------------
// Owner instruction, explicit: a BURN fact may come ONLY from a genuine
// SPL Token Burn / BurnChecked instruction. A transfer to an address that
// looks like a burn address is a TRANSFER — calling it a burn would be an
// economic interpretation, and this layer does not interpret.
function decodeBurnInstruction(
  raw: unknown,
  pos?: InstructionPosition,
): BurnInstructionRef | null {
  const parsed = parsedInstructionSchema.safeParse(raw);
  if (!parsed.success) return null;
  const ix = parsed.data;
  const programId = ix.programId;
  if (!programId || !SPL_TOKEN_PROGRAM_IDS.has(programId)) return null;
  const type = ix.parsed?.type;
  if (type !== "burn" && type !== "burnChecked") return null;
  const info = ix.parsed?.info ?? {};

  const mint = typeof info.mint === "string" ? info.mint : null;
  const sourceAccount = typeof info.account === "string" ? info.account : null;
  if (!mint || !sourceAccount) return null;

  // `amount` (burn) and `tokenAmount.amount` (burnChecked) are the two
  // shapes the RPC emits. Anything else is not decodable and must not be
  // guessed into a number.
  let amountRaw: string | null = null;
  let decimals: number | null = null;
  if (typeof info.amount === "string" && /^\d+$/.test(info.amount)) {
    amountRaw = info.amount;
  }
  const tokenAmount = info.tokenAmount;
  if (tokenAmount && typeof tokenAmount === "object") {
    const ta = tokenAmount as { amount?: unknown; decimals?: unknown };
    if (typeof ta.amount === "string" && /^\d+$/.test(ta.amount)) amountRaw = ta.amount;
    if (typeof ta.decimals === "number") decimals = ta.decimals;
  }
  if (amountRaw === null) return null;

  return {
    programId,
    instructionType: type === "burn" ? "Burn" : "BurnChecked",
    mint,
    sourceAccount,
    authority: typeof info.authority === "string" ? info.authority : null,
    amountRaw,
    decimals,
    ...positionOf(pos),
  };
}

// Spread into a decoded reference. Returns nothing at all when the
// caller did not supply a position, so a ref stays exactly the shape it
// was before this existed rather than gaining undefined fields.
function positionOf(pos: InstructionPosition | undefined): {
  instructionIndex?: number;
  parentIndex?: number | null;
} {
  if (pos === undefined) return {};
  return { instructionIndex: pos.instructionIndex, parentIndex: pos.parentIndex };
}

// PRESERVATION, NOT DECODING.
//
// Only an instruction the node did NOT parse: a parsed one carries no
// data or accounts to keep, and its meaning is already recorded by the
// decoders above. Everything here is copied as reported and nothing is
// inferred from it.
//
// FAIL CLOSED, ALWAYS BY DROPPING. A missing program id, a missing or
// non-base58 blob, a missing account list, an account that is not a
// valid address, or anything past the ceilings — each means this
// instruction is not recorded. A partial record of an opaque instruction
// would be indistinguishable from a complete one later, which is exactly
// the kind of quiet corruption that outlives the code that caused it.
function decodeRawInstruction(
  raw: unknown,
  pos: InstructionPosition,
): RawInstructionRef | null {
  const parsed = parsedInstructionSchema.safeParse(raw);
  if (!parsed.success) return null;
  const ix = parsed.data;
  if (ix.parsed !== undefined) return null; // the node read it; not ours to keep raw
  const programId = ix.programId;
  if (!programId || !isValidSolanaAddress(programId)) return null;
  const data = ix.data;
  if (typeof data !== "string" || data.length === 0 || !BASE58_BLOB.test(data)) return null;
  if (data.length > MAX_RAW_INSTRUCTION_DATA_CHARS) return null;
  const accounts = ix.accounts;
  if (accounts === undefined) return null;
  if (accounts.length > MAX_RAW_INSTRUCTION_ACCOUNTS) return null;
  if (!accounts.every((a) => isValidSolanaAddress(a))) return null;
  return {
    programId,
    accounts: [...accounts],
    data,
    inner: pos.inner,
    instructionIndex: pos.instructionIndex,
    parentIndex: pos.parentIndex,
  };
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

// Canonical JSON: key-sorted, so the same observation always serializes
// byte-identically and the artifact hash is reproducible.
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export interface SolanaAdapterDeps {
  transport: OnchainRpcTransport;
  providerId: string;
  finality: "finalized" | "confirmed";
}

// Per-method parameter construction.
//
// The first bounded live smoke failed here: three intents shared one
// branch that sent `{ encoding: "jsonParsed" }` to all of them. That is
// valid for getAccountInfo, but solana-core validates config objects
// STRICTLY and rejects an unknown field — so getTokenSupply answered with
// a JSON-RPC error rather than a supply. A fixture transport could never
// have caught it, because a fixture validates our REQUEST against nothing;
// only a real node does. The regression tests added alongside this fix
// assert the exact outbound method and config, which is the offline
// equivalent of that check.
//
// Each method now states only the config Solana actually accepts for it.
export function rpcParamsFor(
  intent: OnchainIntent,
  commitment: "finalized" | "confirmed",
): unknown[] {
  switch (intent.kind) {
    // getTokenSupply config: { commitment } ONLY — no encoding.
    case "TOKEN_SUPPLY":
      return [intent.subject, { commitment }];
    // getTokenAccountBalance config: { commitment } ONLY — no encoding.
    case "TOKEN_ACCOUNT_BALANCE":
      return [intent.subject, { commitment }];
    // getAccountInfo DOES accept encoding; jsonParsed is what makes the
    // owner/executable fields readable without base64 decoding.
    case "ACCOUNT_INFO":
      return [intent.subject, { encoding: "jsonParsed", commitment }];
    case "SIGNATURES_FOR_ADDRESS":
      return [
        intent.subject,
        {
          limit: Math.min(intent.limit ?? MAX_SIGNATURES_PER_INTENT, MAX_SIGNATURES_PER_INTENT),
          commitment,
        },
      ];
    // getTransaction accepts encoding and requires an explicit
    // maxSupportedTransactionVersion to return versioned transactions.
    case "TRANSACTION_DETAIL":
      return [
        intent.subject,
        { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment },
      ];
    // getTokenAccountsByOwner takes owner, a FILTER, then config. The
    // filter's mint is intent.projectAnchor and nothing else — there is
    // no parameter here a caller could point at a different mint, so
    // "only the confirmed project mint" is a property of the shape
    // rather than a rule someone has to remember.
    case "TOKEN_ACCOUNTS_BY_OWNER":
      return [
        intent.subject,
        { mint: intent.projectAnchor },
        { encoding: "jsonParsed", commitment },
      ];
  }
}

function normalize(intent: OnchainIntent, raw: unknown): { result: OnchainResult; slot: number } {
  switch (intent.kind) {
    case "TOKEN_SUPPLY": {
      const parsed = tokenSupplySchema.parse(raw);
      return {
        slot: parsed.context.slot,
        result: {
          kind: "TOKEN_SUPPLY",
          mint: intent.subject,
          amountRaw: parsed.value.amount,
          decimals: parsed.value.decimals,
        },
      };
    }
    case "ACCOUNT_INFO": {
      const parsed = accountInfoSchema.parse(raw);
      return {
        slot: parsed.context.slot,
        result: {
          kind: "ACCOUNT_INFO",
          address: intent.subject,
          exists: parsed.value !== null,
          ownerProgram: parsed.value?.owner ?? null,
          executable: parsed.value?.executable ?? null,
          lamports: parsed.value ? String(parsed.value.lamports) : null,
          ...classifyTokenAccount(parsed.value?.owner ?? null, parsed.value?.data),
        },
      };
    }
    case "TOKEN_ACCOUNT_BALANCE": {
      const parsed = tokenAccountBalanceSchema.parse(raw);
      return {
        slot: parsed.context.slot,
        result: {
          kind: "TOKEN_ACCOUNT_BALANCE",
          account: intent.subject,
          // getTokenAccountBalance does not echo the mint; the caller's
          // anchor is recorded in provenance instead of being invented here.
          mint: null,
          amountRaw: parsed.value.amount,
          decimals: parsed.value.decimals,
        },
      };
    }
    case "TOKEN_ACCOUNTS_BY_OWNER": {
      const parsed = tokenAccountsByOwnerSchema.parse(raw);
      const accounts: TokenAccountRef[] = [];
      let rejectedCount = 0;
      for (const entry of parsed.value) {
        const info = entry.account.data.parsed.info;
        // Four independent checks, every one of them against what WE
        // asked for. A node that answers about a different owner, a
        // different mint, or an account owned by something that is not
        // an SPL Token program has not answered our question — and an
        // entry that fails is DROPPED, never included with a caveat.
        const wellFormed = BASE58_ADDRESS.test(entry.pubkey);
        const splOwned = SPL_TOKEN_PROGRAM_IDS.has(entry.account.owner);
        const ownerMatches = info.owner === intent.subject;
        const mintMatches = info.mint === intent.projectAnchor;
        if (!wellFormed || !splOwned || !ownerMatches || !mintMatches) {
          rejectedCount += 1;
          continue;
        }
        accounts.push({
          account: entry.pubkey,
          owner: info.owner,
          mint: info.mint,
          amountRaw: info.tokenAmount.amount,
          decimals: info.tokenAmount.decimals,
        });
      }
      return {
        slot: parsed.context.slot,
        result: {
          kind: "TOKEN_ACCOUNTS_BY_OWNER",
          owner: intent.subject,
          mint: intent.projectAnchor,
          accounts,
          rejectedCount,
        },
      };
    }
    case "SIGNATURES_FOR_ADDRESS": {
      const parsed = signaturesSchema.parse(raw);
      const capped = parsed.slice(0, MAX_SIGNATURES_PER_INTENT);
      return {
        // A signature list carries no context slot; the newest entry's slot
        // is the observation position, and an empty list has none.
        slot: capped[0]?.slot ?? 0,
        result: {
          kind: "SIGNATURES_FOR_ADDRESS",
          address: intent.subject,
          signatures: capped.map((s) => ({
            signature: s.signature,
            slot: s.slot,
            blockTime: s.blockTime ?? null,
            err: s.err !== null && s.err !== undefined,
            memo: boundMemo(typeof s.memo === "string" ? s.memo : null),
          })),
        },
      };
    }
    case "TRANSACTION_DETAIL": {
      const parsed = transactionSchema.parse(raw);
      if (parsed === null) {
        throw new OnchainRetrieverUnavailableError("transaction not found");
      }
      // POSITION IS CARRIED, NOT RECOVERED LATER.
      //
      // The inner instructions used to be flattened straight into one list,
      // which threw away the group index — the ordinal of the outer
      // instruction each was invoked from. Nothing downstream could then say
      // that two movements happened inside ONE invocation rather than merely
      // in one transaction, and the difference is not recoverable from a
      // stored artifact afterwards.
      //
      // Ordering is unchanged: outer instructions first, then inner ones in
      // group order, exactly as before.
      const positioned: { raw: unknown; pos: InstructionPosition }[] =
        parsed.transaction.message.instructions
          .slice(0, MAX_TX_INSTRUCTIONS)
          .map((ix, i) => ({
            raw: ix,
            pos: { inner: false, instructionIndex: i, parentIndex: null },
          }));
      const innerPositioned: { raw: unknown; pos: InstructionPosition }[] = [];
      for (const group of parsed.meta?.innerInstructions ?? []) {
        // A group whose index the node omitted yields inner instructions with
        // no parent recorded. `inner` still says what they are.
        const parentIndex = group.index ?? null;
        group.instructions.forEach((ix, i) => {
          innerPositioned.push({
            raw: ix,
            pos: { inner: true, instructionIndex: i, parentIndex },
          });
        });
      }
      positioned.push(...innerPositioned.slice(0, MAX_TX_INSTRUCTIONS));

      const burns = positioned
        .map((p) => decodeBurnInstruction(p.raw, p.pos))
        .filter((b): b is BurnInstructionRef => b !== null);
      const tokenInstructions = positioned
        .map((p) => decodeTokenInstruction(p.raw, p.pos.inner, p.pos))
        .filter((i): i is TokenInstructionRef => i !== null);
      const lifecycleInstructions = positioned
        .map((p) => decodeLifecycleInstruction(p.raw, p.pos.inner, p.pos))
        .filter((i): i is AccountLifecycleRef => i !== null);
      // Everything the node did not parse, kept as given and read by nothing.
      // An empty array here is a real observation; the field being absent
      // altogether is what an artifact stored before this looks like.
      const rawInstructions = positioned
        .map((p) => decodeRawInstruction(p.raw, p.pos))
        .filter((i): i is RawInstructionRef => i !== null);
      const programs = [
        ...new Set(
          positioned
            .map((p) => programIdOf(p.raw))
            .filter((id): id is string => id !== null),
        ),
      ];
      const accountKeys = parsed.transaction.message.accountKeys
        .slice(0, MAX_TX_ACCOUNT_KEYS)
        .map((k) => (typeof k === "string" ? k : k.pubkey));
      const balance = (b: {
        accountIndex: number;
        mint: string;
        owner?: string;
        uiTokenAmount: { amount: string; decimals: number };
      }): TokenBalanceRef => ({
        accountIndex: b.accountIndex,
        // Resolved through the account-key table when the index is in
        // range; null rather than a guess when it is not.
        account: accountKeys[b.accountIndex] ?? null,
        mint: b.mint,
        owner: b.owner ?? null,
        amountRaw: b.uiTokenAmount.amount,
        decimals: b.uiTokenAmount.decimals,
      });
      return {
        slot: parsed.slot,
        result: {
          kind: "TRANSACTION_DETAIL",
          signature: parsed.transaction.signatures[0],
          slot: parsed.slot,
          blockTime: parsed.blockTime ?? null,
          succeeded: !parsed.meta?.err,
          burns,
          programs,
          accountKeys,
          tokenInstructions,
          lifecycleInstructions,
          rawInstructions,
          preTokenBalances: (parsed.meta?.preTokenBalances ?? [])
            .slice(0, MAX_TX_TOKEN_BALANCES)
            .map(balance),
          postTokenBalances: (parsed.meta?.postTokenBalances ?? [])
            .slice(0, MAX_TX_TOKEN_BALANCES)
            .map(balance),
        },
      };
    }
  }
}

export function createSolanaOnchainAdapter(deps: SolanaAdapterDeps) {
  return {
    name: `solana-rpc:${deps.providerId}`,

    supports(chain: string, network: string, kind: string): boolean {
      return chain === "solana" && network === "mainnet" && kind in METHOD_FOR_INTENT;
    },

    async retrieve(intent: OnchainIntent): Promise<OnchainArtifact> {
      if (intent.chain !== "solana" || intent.network !== "mainnet") {
        throw new OnchainRetrieverUnavailableError(
          `solana adapter cannot serve ${intent.chain}/${intent.network}`,
        );
      }
      // Validate BEFORE any call: a malformed address never reaches an
      // endpoint, so it cannot become a request at all.
      if (!isValidSolanaAddress(intent.projectAnchor)) {
        throw new OnchainRetrieverUnavailableError("invalid project anchor address");
      }
      const subjectValid =
        intent.subjectKind === "tx"
          ? isValidSolanaSignature(intent.subject)
          : isValidSolanaAddress(intent.subject);
      if (!subjectValid) {
        throw new OnchainRetrieverUnavailableError("invalid subject address/signature");
      }

      const method = METHOD_FOR_INTENT[intent.kind];
      const params = rpcParamsFor(intent, deps.finality);
      const retrievedAt = new Date();

      const rawText = await deps.transport.call(method, params);
      let envelope: unknown;
      try {
        envelope = JSON.parse(rawText);
      } catch {
        throw new OnchainRetrieverUnavailableError("rpc response is not valid JSON");
      }
      // JSON-RPC 2.0 envelope. A node answers {jsonrpc,id,result} on
      // success and {jsonrpc,id,error} on failure — an `error` body is a
      // provider failure, never a result, and must not be normalized into
      // a fact. The error's own message is deliberately not interpolated:
      // it is provider-controlled text.
      const rpc = envelopeSchema.safeParse(envelope);
      if (!rpc.success) {
        throw new OnchainRetrieverUnavailableError("rpc response is not a JSON-RPC 2.0 envelope");
      }
      if (rpc.data.error !== undefined) {
        throw new OnchainRpcError(method, rpc.data.error.code ?? null);
      }
      const raw = rpc.data.result;

      let normalized: { result: OnchainResult; slot: number };
      try {
        normalized = normalize(intent, raw);
      } catch (e) {
        if (e instanceof OnchainRetrieverUnavailableError) throw e;
        throw new OnchainRetrieverUnavailableError(
          `rpc response failed schema validation for ${method}`,
        );
      }

      const normalizedText = canonicalJson(normalized.result);
      const blockTime =
        normalized.result.kind === "TRANSACTION_DETAIL" ? normalized.result.blockTime : null;

      return brandOnchainArtifact({
        canonicalUri: buildCanonicalOnchainUri(intent),
        intent,
        result: normalized.result,
        normalizedText,
        provenance: {
          chain: intent.chain,
          network: intent.network,
          projectAnchor: intent.projectAnchor,
          subjectKind: intent.subjectKind,
          subject: intent.subject,
          slot: normalized.slot,
          blockTime,
          blockHash: null,
          finality: deps.finality,
          retrievalMethod: "RPC",
          // A code-owned LABEL, never the endpoint URL and never a key.
          providerId: deps.providerId,
          providerMethod: method,
          // Addresses and limits only — nothing credential-bearing exists
          // in an RPC parameter list for these five methods.
          requestParams: {
            subject: intent.subject,
            ...(intent.limit ? { limit: Math.min(intent.limit, MAX_SIGNATURES_PER_INTENT) } : {}),
          },
          transactionSignature: intent.subjectKind === "tx" ? intent.subject : null,
          retrievedAt,
          rawResponseHash: sha256(rawText),
          artifactHash: sha256(normalizedText),
        },
      });
    },
  };
}

export const __testing = { canonicalJson, decodeBurnInstruction, decodeLifecycleInstruction };
