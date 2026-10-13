-- Phase 6, S7 (phase-6-s7-plan.md §6, D-105) — a Pattern v1 row
-- seeded/migrated BEFORE this S7 round has no "intentRequirements" key
-- in its content jsonb at all (same shape as the pre-S5 gap migration
-- 0015 closed: seed.ts's ON CONFLICT DO NOTHING left an already-existing
-- row untouched by later application code changes). intentRequirementsFor()
-- distinguishes "CORE explicitly has no requirement set for this intent"
-- (the 3 out-of-scope intents, never looked up here at all) from "CORE
-- was never configured for S7 evaluation of this in-scope intent" (no
-- entry at all) — the latter throws IntentConfigurationError instead of
-- silently becoming a false INSUFFICIENT_EVIDENCE result for every job
-- carrying that intent. This migration is what actually resolves that
-- gap for an existing, already-seeded Pattern v1 database: a one-time,
-- deterministic, reviewed jsonb merge — never an implicit runtime
-- mutation of human-approved CORE (D-105's "human ownership" discipline,
-- same as D-095).
--
-- Scoped to version = 1 (Token Value Capture Pattern v1) ONLY, regardless
-- of status (ACTIVE or RETIRED) — a v2+ Pattern is a human/CORE-owned
-- artifact this migration must never touch. Scoped further to rows that
-- do NOT already carry an "intentRequirements" key at all — a row a
-- human already customized (even partially) is left untouched; this is
-- additive backfill, not an overwrite.
--
-- The embedded matrix is byte-identical to
-- PATTERN_V1_CONTENT.intentRequirements in src/server/domain/pattern.ts
-- at the time of this migration — the 8 in-scope v1 intents from
-- phase-6-s7-plan.md §28, human-authored CORE data.
UPDATE "research_patterns"
SET "content" = "content" || jsonb_build_object(
  'intentRequirements',
  '{
    "PROTOCOL_REVENUE_TO_TOKEN": {
      "requirements": [
        {"requirementId": "PRT-1", "kind": "COMPONENT_ESTABLISHED", "optionality": "REQUIRED", "components": ["SOURCE_OF_VALUE"]},
        {"requirementId": "PRT-2", "kind": "FLOW_RELATIONSHIP", "optionality": "REQUIRED", "relationshipFrom": "SOURCE_OF_VALUE", "relationshipTo": "DESTINATION"}
      ]
    },
    "PASSIVE_HOLDER_OUTCOME": {
      "requirements": [
        {"requirementId": "PHO-1", "kind": "FLOW_ATTRIBUTE", "optionality": "REQUIRED", "attribute": "recipientKind", "expectedValues": ["PASSIVE_HOLDER"]}
      ]
    },
    "REWARD_SOURCE": {
      "requirements": [
        {"requirementId": "RS-1", "kind": "COMPONENT_ESTABLISHED", "optionality": "REQUIRED", "components": ["SOURCE_OF_VALUE"]},
        {"requirementId": "RS-2", "kind": "FLOW_RELATIONSHIP", "optionality": "REQUIRED", "relationshipFrom": "SOURCE_OF_VALUE", "relationshipTo": "DESTINATION"}
      ]
    },
    "BURN_OR_SUPPLY_EFFECT": {
      "requirements": [
        {"requirementId": "BSE-1", "kind": "NET_EFFECT_ESTABLISHED", "optionality": "REQUIRED"}
      ]
    },
    "MECHANISM_CURRENT_STATE": {
      "requirements": [
        {"requirementId": "MCS-1", "kind": "LIFECYCLE", "optionality": "REQUIRED", "expectedLifecycle": "CURRENT"}
      ]
    },
    "USAGE_TO_TOKEN_LINKAGE": {
      "requirements": [
        {"requirementId": "UTL-1", "kind": "COMPONENT_ESTABLISHED", "optionality": "REQUIRED", "components": ["SOURCE_OF_VALUE"]},
        {"requirementId": "UTL-2", "kind": "FLOW_RELATIONSHIP", "optionality": "REQUIRED", "relationshipFrom": "SOURCE_OF_VALUE", "relationshipTo": "DESTINATION"}
      ]
    },
    "VALUE_CAPTURE": {
      "requirements": [
        {"requirementId": "VC-1", "kind": "COMPONENT_ESTABLISHED", "optionality": "REQUIRED", "components": ["SOURCE_OF_VALUE"]},
        {"requirementId": "VC-2", "kind": "FLOW_RELATIONSHIP", "optionality": "REQUIRED", "relationshipFrom": "SOURCE_OF_VALUE", "relationshipTo": "DESTINATION"},
        {"requirementId": "VC-3", "kind": "NET_EFFECT_ESTABLISHED", "optionality": "REQUIRED"}
      ]
    },
    "TOKEN_UTILITY": {
      "requirements": [
        {"requirementId": "TU-1", "kind": "COMPONENT_ESTABLISHED", "optionality": "REQUIRED", "components": ["SOURCE_OF_VALUE"]},
        {"requirementId": "TU-2", "kind": "FLOW_ATTRIBUTE", "optionality": "OPTIONAL", "attribute": "recipientKind", "expectedValues": ["PASSIVE_HOLDER", "STAKER", "NODE_OPERATOR", "TREASURY", "LP", "EXTERNAL"]}
      ]
    }
  }'::jsonb
)
WHERE "version" = 1
  AND NOT ("content" ? 'intentRequirements');
