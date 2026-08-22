-- MEDIUM-3 (Phase 6, S5 deep-audit fix package, phase-6-s5-audit.md,
-- D-095) — a Pattern v1 row seeded/migrated BEFORE this S5 round has no
-- "componentRequirements" key in its content jsonb at all (0000_init.sql's
-- seed used ON CONFLICT DO NOTHING — a pre-existing row's content was
-- never touched by later application code changes). componentRequirementsFor()
-- now correctly distinguishes "Pattern explicitly says this component
-- cannot establish" (an explicit entry with establishingClasses: [])
-- from "CORE was never configured for S5 at all" (no entry) — the latter
-- throws PatternConfigurationError instead of silently becoming a false
-- "researched, found nothing" conclusion. This migration is what actually
-- resolves that gap for an existing, already-seeded Pattern v1 database:
-- a one-time, deterministic, reviewed jsonb merge — never an implicit
-- runtime mutation of human-approved CORE (D-095's "human ownership"
-- discipline).
--
-- Scoped to version = 1 (Token Value Capture Pattern v1) ONLY, regardless
-- of status (ACTIVE or RETIRED) — a v2+ Pattern is a human/CORE-owned
-- artifact this migration must never touch. Scoped further to rows that
-- do NOT already carry a "componentRequirements" key at all — a row a
-- human already customized (even partially) is left untouched; this is
-- additive backfill, not an overwrite.
--
-- The embedded matrix is byte-identical to
-- PATTERN_V1_CONTENT.componentRequirements in
-- src/server/domain/pattern.ts at the time of this migration — the same
-- matrix already approved in phase-6-s5-plan.md §5 and used for every
-- fresh seed from this point forward (seed.ts inserts PATTERN_V1_CONTENT
-- unconditionally already; this migration only backfills what a
-- pre-existing row's ON CONFLICT DO NOTHING seed left behind).
UPDATE "research_patterns"
SET "content" = "content" || jsonb_build_object(
  'componentRequirements',
  '{
    "SOURCE_OF_VALUE": {"establishingClasses": ["OFFICIAL_DOCS", "GOVERNANCE", "ONCHAIN_VERIFIABLE"], "requiresCurrentState": false, "requiresLiveMechanismState": false, "freshnessClass": "LOW_CHANGE", "tokenStateSensitive": false, "requiredTokenState": null},
    "FLOW_PATH": {"establishingClasses": ["OFFICIAL_DOCS", "ONCHAIN_VERIFIABLE"], "requiresCurrentState": false, "requiresLiveMechanismState": false, "freshnessClass": "LOW_CHANGE", "tokenStateSensitive": false, "requiredTokenState": null},
    "MECHANISM_SPEC": {"establishingClasses": ["OFFICIAL_DOCS", "GOVERNANCE"], "requiresCurrentState": false, "requiresLiveMechanismState": false, "freshnessClass": "LOW_CHANGE", "tokenStateSensitive": false, "requiredTokenState": null},
    "GOVERNANCE_BASIS": {"establishingClasses": ["GOVERNANCE"], "requiresCurrentState": false, "requiresLiveMechanismState": false, "freshnessClass": "LOW_CHANGE", "tokenStateSensitive": false, "requiredTokenState": null},
    "EXECUTION_EVIDENCE": {"establishingClasses": ["ONCHAIN_VERIFIABLE", "OFFICIAL_REPORT"], "requiresCurrentState": false, "requiresLiveMechanismState": true, "freshnessClass": "MEDIUM_CHANGE", "tokenStateSensitive": false, "requiredTokenState": null},
    "CURRENT_STATE": {"establishingClasses": ["ONCHAIN_VERIFIABLE", "OFFICIAL_DOCS", "OFFICIAL_REPORT"], "requiresCurrentState": true, "requiresLiveMechanismState": false, "freshnessClass": "HIGH_CHANGE", "tokenStateSensitive": false, "requiredTokenState": null},
    "DESTINATION": {"establishingClasses": ["ONCHAIN_VERIFIABLE", "OFFICIAL_DOCS"], "requiresCurrentState": false, "requiresLiveMechanismState": false, "freshnessClass": "LOW_CHANGE", "tokenStateSensitive": true, "requiredTokenState": null},
    "RECIPIENT": {"establishingClasses": ["ONCHAIN_VERIFIABLE", "OFFICIAL_DOCS", "GOVERNANCE"], "requiresCurrentState": false, "requiresLiveMechanismState": false, "freshnessClass": "LOW_CHANGE", "tokenStateSensitive": true, "requiredTokenState": null},
    "NET_EFFECT": {"establishingClasses": ["ONCHAIN_VERIFIABLE", "OFFICIAL_REPORT", "DATA_PROVIDER"], "requiresCurrentState": false, "requiresLiveMechanismState": false, "freshnessClass": "LOW_CHANGE", "tokenStateSensitive": true, "requiredTokenState": null},
    "DURABILITY_BASIS": {"establishingClasses": ["GOVERNANCE", "OFFICIAL_DOCS"], "requiresCurrentState": false, "requiresLiveMechanismState": false, "freshnessClass": "LOW_CHANGE", "tokenStateSensitive": false, "requiredTokenState": null}
  }'::jsonb
)
WHERE "version" = 1
  AND NOT ("content" ? 'componentRequirements');
