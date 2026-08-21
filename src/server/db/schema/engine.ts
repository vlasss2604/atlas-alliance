import { sql } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { researchAttemptStatus } from "./enums";
import { researchJobs } from "./research";

// Фаза 6, S3 (phase-6-plan.md §19 S3, §6.3 item 5) — сырой журнал попыток
// исполнения контроллера: персист для idempotent-enough семантики и
// resume после рестарта воркера. НЕ Evidence (то — наблюдение о мире) и
// НЕ research_component_results (то — сопоставление, S5): это лог
// "что контроллер уже пытался сделать по этому (job, step, component)".
export const researchAttempts = pgTable(
  "research_attempts",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    researchJobId: uuid("research_job_id")
      .notNull()
      .references(() => researchJobs.id, { onDelete: "cascade" }),
    patternStep: smallint("pattern_step").notNull(),
    component: text("component").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    status: researchAttemptStatus("status").notNull().default("STARTED"),
    // Детерминированная причина остановки/пропуска этой попытки —
    // человекочитаемая строка кода (D-070), не свободный текст модели.
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    // Идемпотентность: одна и та же (job, step, component, попытка №N) не
    // может быть заведена дважды — повторная доставка задачи контроллера
    // не плодит дублирующиеся попытки.
    uniqueIndex("uq_research_attempts_job_step_component_attempt").on(
      t.researchJobId,
      t.patternStep,
      t.component,
      t.attemptNumber,
    ),
    index("ix_research_attempts_job").on(t.researchJobId),
  ],
);
