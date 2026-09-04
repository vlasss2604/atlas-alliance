import { and, eq } from "drizzle-orm";

import type { Database } from "../db/client";
import { projectMemoryItems, projects } from "../db/schema";
import {
  SUPPORTED_CHAINS,
  addressShapeMatchesChain,
  parseProjectIdentity,
  projectIdentityContentSchema,
  resolveConfirmedIdentity,
  type ConfirmedProjectIdentity,
  type SupportedChain,
} from "../domain/project-identity";
import { promoteProjectMemoryItem } from "./lifecycle";

// CONFIRMING A PROJECT'S IDENTITY — the owner decision, as code.
//
// D-133 exists because a live run found an unrelated Ethereum ERC-20 that
// merely matched a name and used it to support claims about a Solana
// asset. The cure was to address projects by a human-confirmed identifier
// instead of by name. But confirming one had no supported path at all:
// nothing in `src/` or `scripts/` ever inserted a PROJECT_IDENTITY row,
// while five owner scripts and the S4 acquisition plan read it and
// correctly refuse without it. The capability the architecture depends on
// could not be exercised. This module is that missing home.
//
// It represents exactly one human statement — "this project has this
// canonical chain and token identity" — and it discovers nothing. No
// chain query, no web query, no document, no model. A well-formed address
// is not a confirmed one; confirmation IS the human ACTIVE-row decision,
// and this tool only records that it was made.
//
// NO `network` FIELD EXISTS, and none is accepted. The content schema is
// `{ chain, tokenAddress?, ticker? }` and it is `.strict()`. Mainnet is
// implied by construction: every explorer in the code-owned chain map is a
// mainnet host and test networks are rejected again at classification
// time. Adding a network option would be inventing contract.

export type IdentityConfirmationRefusal =
  | "UNKNOWN_PROJECT"
  | "UNSUPPORTED_CHAIN"
  | "EMPTY_TOKEN"
  | "TOKEN_SHAPE_MISMATCH"
  | "TICKER_TOO_LONG"
  | "REJECTED_BY_SCHEMA"
  // One ACTIVE identity already exists. Never superseded automatically —
  // see the note on the guard below for why even an identical one is
  // refused rather than duplicated.
  | "ACTIVE_IDENTITY_EXISTS";

export interface IdentityConfirmationInput {
  projectSlug: string;
  chain: string;
  // Optional in the schema: a project may be confirmed on a chain before
  // its token address is known. Absent is a legitimate identity, not an
  // incomplete one.
  tokenAddress?: string;
  ticker?: string;
}

export type IdentityConfirmationResult =
  | {
      ok: false;
      refusal: IdentityConfirmationRefusal;
      detail: string;
      existing?: ConfirmedProjectIdentity;
    }
  | {
      ok: true;
      itemId: string;
      projectId: string;
      content: { chain: SupportedChain; tokenAddress?: string; ticker?: string };
      resolved: ConfirmedProjectIdentity | null;
    };

// ---- validation, pure -------------------------------------------------

function isSupportedChain(v: string): v is SupportedChain {
  return (SUPPORTED_CHAINS as readonly string[]).includes(v);
}

export function validateIdentityInput(
  input: IdentityConfirmationInput,
):
  | { ok: true; content: { chain: SupportedChain; tokenAddress?: string; ticker?: string } }
  | { ok: false; refusal: IdentityConfirmationRefusal; detail: string } {
  const chain = input.chain.trim().toLowerCase();
  if (!isSupportedChain(chain)) {
    return {
      ok: false,
      refusal: "UNSUPPORTED_CHAIN",
      detail: `chain must be one of: ${SUPPORTED_CHAINS.join(", ")}`,
    };
  }

  const content: { chain: SupportedChain; tokenAddress?: string; ticker?: string } = { chain };

  if (input.tokenAddress !== undefined) {
    const token = input.tokenAddress.trim();
    if (token.length === 0) {
      return { ok: false, refusal: "EMPTY_TOKEN", detail: "token was given but is empty" };
    }
    // The SAME shape check the domain module applies when reading a stored
    // record back. An 0x… address filed under solana is exactly the
    // cross-chain contamination D-133 exists to prevent, and it is
    // refused here rather than stored and silently ignored later.
    if (!addressShapeMatchesChain(chain, token)) {
      return {
        ok: false,
        refusal: "TOKEN_SHAPE_MISMATCH",
        detail: `that identifier is not structurally valid for ${chain}`,
      };
    }
    content.tokenAddress = token;
  }

  if (input.ticker !== undefined) {
    const ticker = input.ticker.trim();
    if (ticker.length === 0 || ticker.length > 32) {
      return { ok: false, refusal: "TICKER_TOO_LONG", detail: "ticker must be 1..32 characters" };
    }
    content.ticker = ticker;
  }

  // The authoritative gate: the domain schema itself, `.strict()`, so any
  // field the contract does not define — `network` included — is refused
  // here rather than stored and ignored.
  const parsed = projectIdentityContentSchema.safeParse(content);
  if (!parsed.success) {
    return { ok: false, refusal: "REJECTED_BY_SCHEMA", detail: "content does not satisfy the identity contract" };
  }
  return { ok: true, content };
}

// ---- the confirmation itself ------------------------------------------

// WHY A SECOND ACTIVE IDENTITY IS REFUSED OUTRIGHT, identical or not.
//
// `resolveConfirmedIdentity` selects every ACTIVE PROJECT_IDENTITY row,
// sorts by `createdAt` and returns the FIRST structurally-valid one. So a
// second ACTIVE row does not replace anything and does not conflict
// loudly — it is silently ignored, and the older record keeps deciding
// what the project is. An owner who "confirmed" a corrected identity would
// get no error and no effect, which is worse than a refusal.
//
// Superseding is therefore a separate, deliberate owner act with its own
// consequences, exactly as it is for routes. This tool will not do it.
export async function confirmProjectIdentity(
  db: Database,
  input: IdentityConfirmationInput,
): Promise<IdentityConfirmationResult> {
  const validated = validateIdentityInput(input);
  if (!validated.ok) return validated;

  const [project] = await db.select().from(projects).where(eq(projects.slug, input.projectSlug));
  if (!project) {
    return {
      ok: false,
      refusal: "UNKNOWN_PROJECT",
      detail: `no project with slug "${input.projectSlug}"`,
    };
  }

  const activeRows = await db
    .select()
    .from(projectMemoryItems)
    .where(
      and(
        eq(projectMemoryItems.projectId, project.id),
        eq(projectMemoryItems.kind, "PROJECT_IDENTITY"),
        eq(projectMemoryItems.lifecycleState, "ACTIVE"),
      ),
    );
  if (activeRows.length > 0) {
    // Reported through the real resolver, so the operator is told what
    // the project's identity actually resolves to rather than what some
    // row happens to contain.
    const existing = await resolveConfirmedIdentity(db, project.id);
    return {
      ok: false,
      refusal: "ACTIVE_IDENTITY_EXISTS",
      detail:
        `${activeRows.length} ACTIVE PROJECT_IDENTITY row(s) already exist for this project. ` +
        `A second one would be silently ignored — the earliest valid record keeps deciding ` +
        `identity — so superseding is a separate owner act, not a side effect of confirming.`,
      ...(existing ? { existing } : {}),
    };
  }

  // Inserted as OBSERVED because the database guard permits nothing else,
  // then walked to ACTIVE by the EXISTING lifecycle function. No
  // transition is re-implemented here.
  const [row] = await db
    .insert(projectMemoryItems)
    .values({
      projectId: project.id,
      kind: "PROJECT_IDENTITY",
      content: validated.content,
      lifecycleState: "OBSERVED",
    })
    .returning();

  await promoteProjectMemoryItem(db, row.id);

  // Verified through the production resolver, never assumed from what was
  // written — it is the thing every consumer actually calls.
  const resolved = await resolveConfirmedIdentity(db, project.id);
  return {
    ok: true,
    itemId: row.id,
    projectId: project.id,
    content: validated.content,
    resolved,
  };
}

// Re-exported so a caller can read a stored record back through the same
// parser the domain module uses, without importing two modules.
export { parseProjectIdentity };
