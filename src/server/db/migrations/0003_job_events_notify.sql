-- Фаза 3 (phase-3-plan §3): уведомления об изменениях research job.
-- PostgreSQL — source of truth; NOTIFY несёт ТОЛЬКО идентификаторы,
-- данные всегда перечитываются из БД. Журнальный триггер не меняется.

CREATE OR REPLACE FUNCTION research_job_notify() RETURNS trigger AS $$
BEGIN
  IF (OLD.state IS DISTINCT FROM NEW.state)
     OR (OLD.progress_stage IS DISTINCT FROM NEW.progress_stage)
     OR (OLD.memory_status IS DISTINCT FROM NEW.memory_status)
     OR (OLD.unread IS DISTINCT FROM NEW.unread) THEN
    PERFORM pg_notify(
      'research_job_events',
      json_build_object('job_id', NEW.id, 'user_id', NEW.user_id)::text
    );
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER trg_research_jobs_notify
  AFTER UPDATE OF state, progress_stage, memory_status, unread ON research_jobs
  FOR EACH ROW EXECUTE FUNCTION research_job_notify();
