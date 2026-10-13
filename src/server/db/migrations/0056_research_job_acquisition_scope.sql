-- RESEARCH RELIABILITY V1 (B2) — TARGETED SECOND PASS SCOPE.
--
-- The phased runtime cannot open anything new in its EXTRACTING replay, so
-- a targeted second pass (one bounded recovery attempt per unresolved
-- critical component with a known admissible path left) is carried across
-- a second SEARCH -> FETCH -> EXTRACT cycle. The plan is persisted here
-- when the first EXTRACTING cycle defers it and read by the scoped cycle.
-- Nullable, additive, never backfilled: a job with no scope ran one cycle.
ALTER TABLE "research_jobs" ADD COLUMN "acquisition_scope" jsonb;
