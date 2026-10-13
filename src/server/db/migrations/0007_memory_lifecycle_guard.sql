-- Research Memory lifecycle guard (phase-5-plan.md §2.3, §5, D-025, D-021).
-- Тот же приём, что уже держит state machine job'ов (0001_state_machine.sql):
-- граф переходов — констрейнт в БД, не дисциплина кода. Lifecycle не
-- обходится никогда, даже в тестах — единственный барьер против отравления.

-- research_memory: граф OBSERVED -> CANDIDATE -> ACTIVE -> {DEPRECATED,
-- SUPERSEDED}; CANDIDATE/OBSERVED могут уйти прямо в DEPRECATED.
-- Прямая вставка ACTIVE (или любого состояния кроме OBSERVED) отклоняется.
-- Переход в ACTIVE обязан нести promoted_by — переход делает человек
-- (LOCKED §11), а не модель и не миграция.
CREATE OR REPLACE FUNCTION research_memory_lifecycle_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.lifecycle_state <> 'OBSERVED' THEN
      RAISE EXCEPTION 'research_memory must be inserted as OBSERVED, not %', NEW.lifecycle_state
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.lifecycle_state = NEW.lifecycle_state THEN
    RETURN NEW;
  END IF;
  IF NOT (
    (OLD.lifecycle_state = 'OBSERVED' AND NEW.lifecycle_state IN ('CANDIDATE', 'DEPRECATED')) OR
    (OLD.lifecycle_state = 'CANDIDATE' AND NEW.lifecycle_state IN ('ACTIVE', 'DEPRECATED')) OR
    (OLD.lifecycle_state = 'ACTIVE' AND NEW.lifecycle_state IN ('DEPRECATED', 'SUPERSEDED'))
  ) THEN
    RAISE EXCEPTION 'forbidden research_memory lifecycle transition: % -> %', OLD.lifecycle_state, NEW.lifecycle_state
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.lifecycle_state = 'ACTIVE' AND NEW.promoted_by IS NULL THEN
    RAISE EXCEPTION 'promotion to ACTIVE requires promoted_by (human decision, D-021/D-055)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER trg_research_memory_lifecycle_guard
  BEFORE INSERT OR UPDATE OF lifecycle_state ON research_memory
  FOR EACH ROW EXECUTE FUNCTION research_memory_lifecycle_guard();
--> statement-breakpoint

-- project_memory_items: тот же граф, без promoted_by (RESEARCH MEMORY —
-- «как исследовать», не FACT MEMORY; аудит промоушена не в объёме Фазы 5
-- для этой таблицы — только барьер против отравления).
CREATE OR REPLACE FUNCTION project_memory_items_lifecycle_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.lifecycle_state <> 'OBSERVED' THEN
      RAISE EXCEPTION 'project_memory_items must be inserted as OBSERVED, not %', NEW.lifecycle_state
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.lifecycle_state = NEW.lifecycle_state THEN
    RETURN NEW;
  END IF;
  IF NOT (
    (OLD.lifecycle_state = 'OBSERVED' AND NEW.lifecycle_state IN ('CANDIDATE', 'DEPRECATED')) OR
    (OLD.lifecycle_state = 'CANDIDATE' AND NEW.lifecycle_state IN ('ACTIVE', 'DEPRECATED')) OR
    (OLD.lifecycle_state = 'ACTIVE' AND NEW.lifecycle_state IN ('DEPRECATED', 'SUPERSEDED'))
  ) THEN
    RAISE EXCEPTION 'forbidden project_memory_items lifecycle transition: % -> %', OLD.lifecycle_state, NEW.lifecycle_state
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER trg_project_memory_items_lifecycle_guard
  BEFORE INSERT OR UPDATE OF lifecycle_state ON project_memory_items
  FOR EACH ROW EXECUTE FUNCTION project_memory_items_lifecycle_guard();
