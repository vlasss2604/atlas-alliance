-- State machine research_jobs: граф переходов, автожурнал, append-only журнал,
-- guard переходов резервации квоты. Источник: phase-1-plan.md §4.3–4.4.

-- 1. Валидация переходов состояния job.
--    Разрешённый граф (phase-1-plan.md):
--      QUEUED                 -> RUNNING | CANCELLED
--      RUNNING                -> AWAITING_CLARIFICATION | SUCCEEDED | FAILED
--                                | CANCELLED | BUDGET_LIMIT_REACHED
--      AWAITING_CLARIFICATION -> RUNNING | FAILED | CANCELLED
--      терминальные           -> переходов нет
CREATE OR REPLACE FUNCTION research_job_state_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.state = NEW.state THEN
    RETURN NEW;
  END IF;
  IF NOT (
    (OLD.state = 'QUEUED' AND NEW.state IN ('RUNNING', 'CANCELLED')) OR
    (OLD.state = 'RUNNING' AND NEW.state IN
      ('AWAITING_CLARIFICATION', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'BUDGET_LIMIT_REACHED')) OR
    (OLD.state = 'AWAITING_CLARIFICATION' AND NEW.state IN ('RUNNING', 'FAILED', 'CANCELLED'))
  ) THEN
    RAISE EXCEPTION 'forbidden research_job state transition: % -> %', OLD.state, NEW.state
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER trg_research_jobs_state_guard
  BEFORE UPDATE OF state ON research_jobs
  FOR EACH ROW EXECUTE FUNCTION research_job_state_guard();
--> statement-breakpoint

-- 2. Автожурнал: смена state физически неразделима с записью в журнал.
--    note передаётся через SET LOCAL atlas.transition_note (опционально).
CREATE OR REPLACE FUNCTION research_job_state_log() RETURNS trigger AS $$
BEGIN
  IF OLD.state IS DISTINCT FROM NEW.state THEN
    INSERT INTO research_job_transitions (job_id, from_state, to_state, note)
    VALUES (NEW.id, OLD.state, NEW.state,
            NULLIF(current_setting('atlas.transition_note', true), ''));
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER trg_research_jobs_state_log
  AFTER UPDATE OF state ON research_jobs
  FOR EACH ROW EXECUTE FUNCTION research_job_state_log();
--> statement-breakpoint

-- 3. Журнал append-only.
CREATE OR REPLACE FUNCTION research_job_transitions_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'research_job_transitions is append-only'
    USING ERRCODE = 'check_violation';
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER trg_research_job_transitions_append_only
  BEFORE UPDATE OR DELETE ON research_job_transitions
  FOR EACH ROW EXECUTE FUNCTION research_job_transitions_append_only();
--> statement-breakpoint

-- 4. Резервация квоты: RESERVED -> CONSUMED | RELEASED; терминальные неизменны.
CREATE OR REPLACE FUNCTION demo_quota_reservation_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.state = NEW.state THEN
    RETURN NEW;
  END IF;
  IF NOT (OLD.state = 'RESERVED' AND NEW.state IN ('CONSUMED', 'RELEASED')) THEN
    RAISE EXCEPTION 'forbidden quota reservation transition: % -> %', OLD.state, NEW.state
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER trg_demo_quota_reservations_guard
  BEFORE UPDATE OF state ON demo_quota_reservations
  FOR EACH ROW EXECUTE FUNCTION demo_quota_reservation_guard();
