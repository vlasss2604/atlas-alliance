-- Исправление дефекта ревью Фазы 5 (D-065/MEDIUM-5): триггер 0006/0007
-- проверял только "promoted_by IS NOT NULL" — любой существующий user_id
-- (не обязательно ADMIN) мог быть подставлен напрямую через SQL в обход
-- assertAdmin() из lifecycle.ts. Прикладная проверка полезна (быстрый,
-- понятный отказ до похода в БД), но недостаточна (D-055: единственный
-- надёжный барьер — БД, не дисциплина кода) — тот же принцип, что уже
-- держит сам граф переходов lifecycle. Функция та же (CREATE OR REPLACE,
-- триггер trg_research_memory_lifecycle_guard уже на неё указывает,
-- пересоздавать триггер не нужно), тот же приём, что 0004 использовал
-- для исправления дефекта 0001.
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
    -- D-065: promoted_by обязан ссылаться на актёра, чья роль СЕЙЧАС ADMIN —
    -- не просто на существующего пользователя. Прикладной assertAdmin()
    -- остаётся полезным (ранний, понятный отказ), но не единственным барьером.
    IF NOT EXISTS (
      SELECT 1 FROM users WHERE id = NEW.promoted_by AND role = 'ADMIN'
    ) THEN
      RAISE EXCEPTION 'promotion to ACTIVE requires promoted_by to reference an ADMIN user (D-065)'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
