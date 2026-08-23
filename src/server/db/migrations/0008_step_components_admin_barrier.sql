-- Фаза 5, пакет исправлений ревью (phase-5-review-findings.md).
-- 1) D-060: research_memory.component + requiredComponents в content
--    активного Pattern v1 + триггер валидации пары (pattern_step, component)
--    против активного Pattern.
-- 2) D-065: барьер промоушена в БД — promoted_by обязан разрешаться в
--    пользователя с ролью ADMIN, а не просто быть непустым.
-- Историческая миграция 0007 не переписывается: функция lifecycle-guard
-- заменяется через CREATE OR REPLACE, триггер остаётся прежним.

-- D-060, шаг 1: колонка добавляется nullable, бэкфилл существующих строк —
-- первичный компонент их шага (для многокомпонентных шагов 3 и 6 это
-- честно означает, что одна старая запись больше не закрывает весь шаг:
-- частичное покрытие -> REQUIRED_FRESH по D-060).
ALTER TABLE "research_memory" ADD COLUMN "component" text;--> statement-breakpoint
UPDATE "research_memory" SET "component" = CASE "pattern_step"
  WHEN 1 THEN 'SOURCE_OF_VALUE'
  WHEN 2 THEN 'FLOW_PATH'
  WHEN 3 THEN 'MECHANISM_SPEC'
  WHEN 4 THEN 'EXECUTION_EVIDENCE'
  WHEN 5 THEN 'CURRENT_STATE'
  WHEN 6 THEN 'DESTINATION'
  WHEN 7 THEN 'NET_EFFECT'
  WHEN 8 THEN 'DURABILITY_BASIS'
END WHERE "component" IS NULL;--> statement-breakpoint
ALTER TABLE "research_memory" ALTER COLUMN "component" SET NOT NULL;--> statement-breakpoint

-- D-060, шаг 2: список компонентов живёт в research_patterns.content
-- (внутри CORE, D-022). Существующая ACTIVE-версия Pattern v1 темы
-- Token Value Capture дополняется requiredComponents, если поля ещё нет.
-- На БД, где Pattern не засеян (апгрейд с Фазы 4), UPDATE затрагивает
-- 0 строк — Pattern с requiredComponents придёт из сида (обязательный
-- повторный прогон сида после апгрейда, phase-5-review-findings.md L-6).
UPDATE "research_patterns" SET "content" = "content" || jsonb_build_object(
  'requiredComponents', jsonb_build_object(
    '1', jsonb_build_array('SOURCE_OF_VALUE'),
    '2', jsonb_build_array('FLOW_PATH'),
    '3', jsonb_build_array('MECHANISM_SPEC', 'GOVERNANCE_BASIS'),
    '4', jsonb_build_array('EXECUTION_EVIDENCE'),
    '5', jsonb_build_array('CURRENT_STATE'),
    '6', jsonb_build_array('DESTINATION', 'RECIPIENT'),
    '7', jsonb_build_array('NET_EFFECT'),
    '8', jsonb_build_array('DURABILITY_BASIS')
  )
)
WHERE "status" = 'ACTIVE'
  AND "version" = 1
  AND NOT ("content" ? 'requiredComponents')
  AND "topic_id" IN (SELECT id FROM "topics" WHERE slug = 'token_value_capture');--> statement-breakpoint

-- D-060, шаг 3: пара (pattern_step, component) валидируется при записи
-- против активного Pattern — инвариант в БД, не дисциплина кода (D-010).
-- Запись памяти без активного Pattern с requiredComponents отклоняется:
-- непроверяемая пара не может попасть в хранилище.
CREATE OR REPLACE FUNCTION research_memory_component_guard() RETURNS trigger AS $$
DECLARE
  allowed jsonb;
BEGIN
  SELECT rp.content -> 'requiredComponents' -> NEW.pattern_step::text INTO allowed
  FROM research_patterns rp
  WHERE rp.topic_id = NEW.topic_id AND rp.status = 'ACTIVE';
  IF allowed IS NULL THEN
    RAISE EXCEPTION 'no ACTIVE pattern with requiredComponents for topic %, cannot validate (pattern_step, component)', NEW.topic_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT (allowed ? NEW.component) THEN
    RAISE EXCEPTION 'component % does not belong to pattern step % (D-060)', NEW.component, NEW.pattern_step
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER trg_research_memory_component_guard
  BEFORE INSERT OR UPDATE OF pattern_step, component, topic_id ON research_memory
  FOR EACH ROW EXECUTE FUNCTION research_memory_component_guard();
--> statement-breakpoint

-- D-065: промоушен в ACTIVE санкционирует ADMIN — проверяется в БД, а не
-- только в assertAdmin приложения. Все прежние проверки графа сохранены
-- дословно (прямая вставка ACTIVE, пропуск CANDIDATE, ACTIVE без
-- promoted_by, реактивация DEPRECATED — проверены независимым ревью).
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
  IF NEW.lifecycle_state = 'ACTIVE' THEN
    IF NEW.promoted_by IS NULL THEN
      RAISE EXCEPTION 'promotion to ACTIVE requires promoted_by (human decision, D-021/D-055)'
        USING ERRCODE = 'check_violation';
    END IF;
    -- D-065: непустого promoted_by недостаточно — актёр обязан быть ADMIN
    -- по действующей модели ролей на момент перехода.
    IF NOT EXISTS (SELECT 1 FROM users u WHERE u.id = NEW.promoted_by AND u.role = 'ADMIN') THEN
      RAISE EXCEPTION 'promotion to ACTIVE must be sanctioned by an ADMIN actor (D-065), promoted_by=%', NEW.promoted_by
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
