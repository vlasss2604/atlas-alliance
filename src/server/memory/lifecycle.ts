import { and, eq, sql } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";
import {
  evidence as evidenceTable,
  projectMemoryItems,
  researchMemory,
  researchMemoryProvenance,
  researchPatterns,
  users,
} from "../db/schema";
import { patternContentSchema } from "../domain/pattern";

// Фаза 5 — lifecycle-операции памяти (phase-5-plan.md §2.3, §5).
// Переходы состояния гарантирует триггер БД (0007_memory_lifecycle_guard.sql);
// здесь — прикладные шаги вокруг него: наблюдение кандидата, копирование
// provenance, промоушен человеком. Обойти lifecycle отсюда невозможно —
// тот же барьер держит и прямой SQL, и эти функции.

export class NotAdminError extends Error {
  constructor(userId: string) {
    super(`user is not ADMIN: ${userId}`);
    this.name = "NotAdminError";
  }
}

// D-055: единственная проверка «контролируемости» скрипта — актёр обязан
// быть ADMIN. Ничего сложнее (полноценный admin UI) в Фазе 5 не строится.
export async function assertAdmin(
  db: Database | Transaction,
  userId: string,
): Promise<void> {
  const [u] = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, userId));
  if (!u || u.role !== "ADMIN") {
    throw new NotAdminError(userId);
  }
}

export class InvalidPatternComponentError extends Error {
  constructor(
    patternStep: number,
    component: string,
    allowed: readonly string[],
  ) {
    super(
      `component '${component}' is not valid for pattern step ${patternStep} — allowed: ${allowed.join(", ")}`,
    );
    this.name = "InvalidPatternComponentError";
  }
}

export interface ObserveMemoryInput {
  projectId: string;
  topicId: string;
  patternStep: number;
  // Компонент шага (D-060) — валидируется против requiredComponents
  // активного Pattern для этого topic ниже, до вставки.
  component: string;
  claimKey: string;
  statement: string;
  mechanismState?: string | null;
  freshnessClass: "LOW_CHANGE" | "MEDIUM_CHANGE" | "HIGH_CHANGE";
  verifiedAt: Date;
  dataAsOf?: Date | null;
  // Postgres interval-литерал ('36 hours', '3 months', '10 days', …) — не
  // только целые дни (MEDIUM-1): make_interval(days=>N) не мог выразить
  // дробные/иные единицы, требуемые сценариями регрессии.
  staleAfter?: string | null;
  confidence: number;
  originKind: string;
}

// Кандидат наблюдается всегда как OBSERVED — извлечение НЕ ограничено
// VERIFIED (D-023): порог извлечения и промоушена разные.
export async function observeMemoryCandidate(
  db: Database | Transaction,
  input: ObserveMemoryInput,
): Promise<{ id: string }> {
  // (pattern_step, component) обязана быть валидной парой против активного
  // Pattern (D-060) — claim_key больше не решает принадлежность к шагу.
  const [activePattern] = await db
    .select({ content: researchPatterns.content })
    .from(researchPatterns)
    .where(
      and(
        eq(researchPatterns.topicId, input.topicId),
        eq(researchPatterns.status, "ACTIVE"),
      ),
    );
  if (!activePattern) {
    throw new Error(`no ACTIVE research_pattern for topic ${input.topicId}`);
  }
  const pattern = patternContentSchema.parse(activePattern.content);
  const step = pattern.steps.find((s) => s.step === input.patternStep);
  if (!step) {
    throw new Error(`pattern has no step ${input.patternStep}`);
  }
  if (!step.requiredComponents.includes(input.component)) {
    throw new InvalidPatternComponentError(
      input.patternStep,
      input.component,
      step.requiredComponents,
    );
  }

  const [row] = await db
    .insert(researchMemory)
    .values({
      projectId: input.projectId,
      topicId: input.topicId,
      patternStep: input.patternStep,
      component: input.component,
      claimKey: input.claimKey,
      statement: input.statement,
      mechanismState: input.mechanismState ?? null,
      freshnessClass: input.freshnessClass,
      verifiedAt: input.verifiedAt,
      dataAsOf: input.dataAsOf ?? null,
      staleAfter:
        input.staleAfter != null ? sql`${input.staleAfter}::interval` : null,
      confidence: input.confidence,
      originKind: input.originKind,
    })
    .returning({ id: researchMemory.id });
  return row;
}

export interface CopyProvenanceInput {
  memoryId: string;
  sourceId: string;
  retrievedUrl: string;
  contentHash: string;
  fragment?: string | null;
  fetchedAt: Date;
  observedAt?: Date | null;
  dataAsOf?: Date | null;
  // Аудит-след БЕЗ FK (§5.1): строка evidence может исчезнуть при
  // удалении пользователя, provenance продолжает работать.
  originEvidenceId?: string | null;
}

// Копирование, не ссылка — исправление дефекта плана (§5.1). Вызывается
// В МОМЕНТ промоушена, не при чтении: копия переживает удаление
// пользовательского evidence/Proof.
export async function copyProvenance(
  db: Database | Transaction,
  input: CopyProvenanceInput,
): Promise<void> {
  await db.insert(researchMemoryProvenance).values({
    memoryId: input.memoryId,
    sourceId: input.sourceId,
    retrievedUrl: input.retrievedUrl,
    contentHash: input.contentHash,
    fragment: input.fragment ?? null,
    fetchedAt: input.fetchedAt,
    observedAt: input.observedAt ?? null,
    dataAsOf: input.dataAsOf ?? null,
    originEvidenceId: input.originEvidenceId ?? null,
  });
}

// Удобство: копирует provenance напрямую из существующей строки evidence
// (пользовательский Proof, обычно VERIFIED) — поля переносятся по значению,
// FK на evidence НЕ создаётся (originEvidenceId остаётся простым uuid).
export async function copyProvenanceFromEvidence(
  db: Database | Transaction,
  memoryId: string,
  evidenceId: string,
): Promise<void> {
  const [row] = await db
    .select()
    .from(evidenceTable)
    .where(eq(evidenceTable.id, evidenceId));
  if (!row) throw new Error(`evidence not found: ${evidenceId}`);
  await copyProvenance(db, {
    memoryId,
    sourceId: row.sourceId,
    retrievedUrl: row.retrievedUrl,
    contentHash: row.contentHash,
    // Публичный фрагмент источника, не переписка пользователя (§5.1).
    fragment: row.fragment,
    fetchedAt: row.fetchedAt,
    observedAt: row.observedAt,
    dataAsOf: row.dataAsOf,
    originEvidenceId: row.id,
  });
}

// OBSERVED -> CANDIDATE. Не гейтится VERIFIED (D-023) и не требует человека
// (LOCKED §11 гейтит только вход в ACTIVE) — но в Фазе 5 ничего не делает
// это автоматически; вызывается только явно, из скрипта промоушена.
export async function promoteToCandidate(
  db: Database | Transaction,
  memoryId: string,
): Promise<void> {
  await db
    .update(researchMemory)
    .set({ lifecycleState: "CANDIDATE" })
    .where(eq(researchMemory.id, memoryId));
}

// CANDIDATE -> ACTIVE, только человеком (D-021, D-055). adminUserId
// проверяется явно (не полагаемся только на триггер БД, чтобы дать
// вызывающему коду понятную ошибку раньше похода в БД); триггер остаётся
// последним барьером на случай прямого SQL в обход этой функции.
export async function promoteToActive(
  db: Database,
  memoryId: string,
  adminUserId: string,
): Promise<{ id: string; lifecycleState: string; promotedBy: string | null }> {
  await assertAdmin(db, adminUserId);
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ lifecycleState: researchMemory.lifecycleState })
      .from(researchMemory)
      .where(eq(researchMemory.id, memoryId));
    if (!current) throw new Error(`research_memory not found: ${memoryId}`);
    if (current.lifecycleState === "OBSERVED") {
      await promoteToCandidate(tx, memoryId);
    }
    const [row] = await tx
      .update(researchMemory)
      .set({
        lifecycleState: "ACTIVE",
        promotedBy: adminUserId,
        promotedAt: sql`now()`,
      })
      .where(eq(researchMemory.id, memoryId))
      .returning({
        id: researchMemory.id,
        lifecycleState: researchMemory.lifecycleState,
        promotedBy: researchMemory.promotedBy,
      });
    return row;
  });
}

export async function deprecateMemory(
  db: Database | Transaction,
  memoryId: string,
): Promise<void> {
  await db
    .update(researchMemory)
    .set({ lifecycleState: "DEPRECATED" })
    .where(eq(researchMemory.id, memoryId));
}

// Зеркало для project_memory_items — тот же граф, без promoted_by
// (RESEARCH MEMORY, не FACT MEMORY; см. 0007_memory_lifecycle_guard.sql).
export async function promoteProjectMemoryItem(
  db: Database,
  itemId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [current] = await tx
      .select({ lifecycleState: projectMemoryItems.lifecycleState })
      .from(projectMemoryItems)
      .where(eq(projectMemoryItems.id, itemId));
    if (!current) throw new Error(`project_memory_item not found: ${itemId}`);
    if (current.lifecycleState === "OBSERVED") {
      await tx
        .update(projectMemoryItems)
        .set({ lifecycleState: "CANDIDATE" })
        .where(eq(projectMemoryItems.id, itemId));
    }
    await tx
      .update(projectMemoryItems)
      .set({ lifecycleState: "ACTIVE" })
      .where(eq(projectMemoryItems.id, itemId));
  });
}
