-- Исправление дефекта Фазы 1, найденного e2e Фазы 3: append-only-триггер
-- журнала блокировал каскадный DELETE при удалении job/аккаунта — право
-- на удаление (B7) не работало для пользователей с историей переходов.
-- Журнал остаётся append-only для ПРЯМЫХ операций (tampering запрещён);
-- каскад от удаления родительской строки (вложенность в RI-триггер) проходит.

CREATE OR REPLACE FUNCTION research_job_transitions_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD; -- каскад ON DELETE CASCADE (наш триггер вложен в RI-триггер: depth > 1);
    -- прямой DELETE видит depth = 1 и отклоняется
  END IF;
  RAISE EXCEPTION 'research_job_transitions is append-only'
    USING ERRCODE = 'check_violation';
END $$ LANGUAGE plpgsql;
