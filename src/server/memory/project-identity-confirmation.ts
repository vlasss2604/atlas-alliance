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
  // D-158 — a confirmed activity->program entry that is unusable. Refused
  // whole rather than partially admitted: a half-accepted program list
  // would look confirmed while missing what the human actually approved.
  | "EMPTY_PROGRAM_ACTIVITY"
  | "EMPTY_PROGRAM_ID"
  | "PROGRAM_SHAPE_MISMATCH"
  | "DUPLICATE_PROGRAM_ACTIVITY"
  | "TOO_MANY_PROGRAMS"
  | "EMPTY_PROGRAM_ALIAS"
  | "TOO_MANY_PROGRAM_ALIASES"
  | "DUPLICATE_PROGRAM_ALIAS"
  | "REJECTED_BY_SCHEMA"
  // One ACTIVE identity already exists. Never superseded automatically —
  // see the note on the guard below for why even an identical one is
  // refused rather than duplicated.
  | "ACTIVE_IDENTITY_EXISTS";

// Bounded on purpose. A project's revenue-bearing programs are a short
// list; an unbounded one would be a contract registry, which this is not.
export const MAX_CONFIRMED_PROGRAMS = 16;

// D-158 PHASE 2 — aliases are a small human convenience, not a dictionary.
// A handful of names a human vouched for; anything longer is a sign the
// activity itself is wrong rather than under-named.
export const MAX_PROGRAM_ALIASES = 8;

export interface IdentityConfirmationInput {
  projectSlug: string;
  chain: string;
  // Optional in the schema: a project may be confirmed on a chain before
  // its token address is known. Absent is a legitimate identity, not an
  // incomplete one.
  tokenAddress?: string;
  ticker?: string;
  // D-158 — human-confirmed activity -> on-chain program mapping. The ONLY
  // way an entry reaches the record: this function is called from the
  // owner confirmation path, and no extraction output, document or model
  // can invoke it. Absent means the human confirmed no programs, which is
  // a legitimate identity, not an incomplete one.
  programs?: { activity: string; programId: string; aliases?: string[] }[];
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
      content: {
      chain: SupportedChain;
      tokenAddress?: string;
      ticker?: string;
      programs?: { activity: string; programId: string; aliases?: string[] }[];
    };
      resolved: ConfirmedProjectIdentity | null;
    };

// ---- validation, pure -------------------------------------------------

function isSupportedChain(v: string): v is SupportedChain {
  return (SUPPORTED_CHAINS as readonly string[]).includes(v);
}

export function validateIdentityInput(
  input: IdentityConfirmationInput,
):
  | { ok: true; content: {
      chain: SupportedChain;
      tokenAddress?: string;
      ticker?: string;
      programs?: { activity: string; programId: string; aliases?: string[] }[];
    } }
  | { ok: false; refusal: IdentityConfirmationRefusal; detail: string } {
  const chain = input.chain.trim().toLowerCase();
  if (!isSupportedChain(chain)) {
    return {
      ok: false,
      refusal: "UNSUPPORTED_CHAIN",
      detail: `chain must be one of: ${SUPPORTED_CHAINS.join(", ")}`,
    };
  }

  const content: {
      chain: SupportedChain;
      tokenAddress?: string;
      ticker?: string;
      programs?: { activity: string; programId: string; aliases?: string[] }[];
    } = { chain };

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

  if (input.programs !== undefined) {
    if (input.programs.length > MAX_CONFIRMED_PROGRAMS) {
      return {
        ok: false,
        refusal: "TOO_MANY_PROGRAMS",
        detail: `at most ${MAX_CONFIRMED_PROGRAMS} programs may be confirmed at once`,
      };
    }
    const entries: { activity: string; programId: string; aliases?: string[] }[] = [];
    const seen = new Set();
    for (const raw of input.programs) {
      const activity = raw.activity.trim();
      if (activity.length === 0 || activity.length > 64) {
        return {
          ok: false,
          refusal: "EMPTY_PROGRAM_ACTIVITY",
          detail: "each program activity must be 1..64 characters",
        };
      }
      const programId = raw.programId.trim();
      if (programId.length === 0) {
        return {
          ok: false,
          refusal: "EMPTY_PROGRAM_ID",
          detail: `program for activity "${activity}" was given but is empty`,
        };
      }
      // THE SAME CHECK tokenAddress GETS, and for the same reason: an
      // address that cannot belong to this chain is not a program on it.
      if (!addressShapeMatchesChain(chain, programId)) {
        return {
          ok: false,
          refusal: "PROGRAM_SHAPE_MISMATCH",
          detail: `program id for activity "${activity}" is not a valid ${chain} address`,
        };
      }
      // One program per activity label. Two entries claiming the same
      // activity would make "which program is PumpSwap" ambiguous, and a
      // silent last-wins would decide it invisibly.
      const key = activity.toLowerCase();
      if (seen.has(key)) {
        return {
          ok: false,
          refusal: "DUPLICATE_PROGRAM_ACTIVITY",
          detail: `activity "${activity}" was given more than once`,
        };
      }
      seen.add(key);

      // ALIASES — other names for the SAME activity, each one a human
      // statement. Validated exactly as the activity is, and never
      // generated: nothing in this codebase derives an alias, and no model
      // output reaches this input.
      let aliases: string[] | undefined;
      if (raw.aliases !== undefined) {
        if (raw.aliases.length > MAX_PROGRAM_ALIASES) {
          return {
            ok: false,
            refusal: "TOO_MANY_PROGRAM_ALIASES",
            detail: `activity "${activity}" may carry at most ${MAX_PROGRAM_ALIASES} aliases`,
          };
        }
        const cleaned: string[] = [];
        // Collision is checked against every name already accepted for
        // ANY activity, the activity labels included. Two activities that
        // answer to one name would make the binding ambiguous in exactly
        // the way one activity with two programs would.
        for (const rawAlias of raw.aliases) {
          const alias = rawAlias.trim();
          if (alias.length === 0 || alias.length > 64) {
            return {
              ok: false,
              refusal: "EMPTY_PROGRAM_ALIAS",
              detail: `each alias for activity "${activity}" must be 1..64 characters`,
            };
          }
          const aliasKey = alias.toLowerCase();
          if (seen.has(aliasKey)) {
            return {
              ok: false,
              refusal: "DUPLICATE_PROGRAM_ALIAS",
              detail: `name "${alias}" is already used by another activity or alias`,
            };
          }
          seen.add(aliasKey);
          cleaned.push(alias);
        }
        if (cleaned.length > 0) aliases = cleaned;
      }

      entries.push(
        aliases === undefined
          ? { activity, programId }
          : { activity, programId, aliases },
      );
    }
    if (entries.length > 0) content.programs = entries;
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
