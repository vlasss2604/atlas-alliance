import { sql } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";

// MemoryRetrievalGateway (phase-5-plan.md §3.4, D-040). Interface с одной
// реализацией сегодня («structured») — гибрид добавляется второй
// реализацией БЕЗ изменения планировщика. pgvector/эмбеддинги не вводятся.

export type MatchedVia = "ontology" | "fts" | "trgm";

export interface RetrievalHit {
  memoryId: string;
  patternStep: number;
  claimKey: string;
  statement: string;
  mechanismState: string | null;
  freshnessClass: "LOW_CHANGE" | "MEDIUM_CHANGE" | "HIGH_CHANGE";
  verifiedAt: Date;
  dataAsOf: Date | null;
  staleAfterDays: number | null;
  confidence: number;
  matchedVia: MatchedVia;
}

export interface RetrievalQuery {
  projectId: string;
  topicId: string;
  // Свободный текст запроса (understood_summary/research_task) — путь
  // recall для формулировок, не покрытых claim_key (§3.2, вторичный путь).
  statementQuery?: string;
  // Сужение по конкретным claim-ключам, когда планировщик уже знает,
  // что ищет (иначе — все ACTIVE записи проекта+темы).
  claimKeys?: string[];
}

export interface MemoryRetrievalGateway {
  readonly name: string;
  retrieve(
    db: Database | Transaction,
    query: RetrievalQuery,
    opts: { topKPerStep: number },
  ): Promise<RetrievalHit[]>;
}

interface Row {
  id: string;
  pattern_step: number;
  claim_key: string;
  statement: string;
  mechanism_state: string | null;
  freshness_class: "LOW_CHANGE" | "MEDIUM_CHANGE" | "HIGH_CHANGE";
  verified_at: Date;
  data_as_of: Date | null;
  stale_after_days: number | null;
  confidence: number;
}

function toHit(r: Row, matchedVia: MatchedVia): RetrievalHit {
  return {
    memoryId: r.id,
    patternStep: r.pattern_step,
    claimKey: r.claim_key,
    statement: r.statement,
    mechanismState: r.mechanism_state,
    freshnessClass: r.freshness_class,
    // db.execute() — raw pg driver, не гарантированно Date (в отличие от
    // типизированного select()); приводим явно.
    verifiedAt: new Date(r.verified_at),
    dataAsOf: r.data_as_of ? new Date(r.data_as_of) : null,
    staleAfterDays: r.stale_after_days,
    confidence: r.confidence,
    matchedVia,
  };
}

// project_id ВСЕГДА в WHERE, никогда не снимается: кросс-проектное
// переиспользование запрещено в v1 (D-042) — это структурная, а не
// договорная гарантия изоляции.
export const structuredMemoryRetrievalGateway: MemoryRetrievalGateway = {
  name: "structured",
  async retrieve(db, query, opts) {
    const claimFilter = query.claimKeys?.length
      ? sql`AND claim_key IN (${sql.join(
          query.claimKeys.map((k) => sql`${k}`),
          sql`, `,
        )})`
      : sql``;

    const ontologyRows = (
      await db.execute(sql`
        SELECT id, pattern_step, claim_key, statement, mechanism_state,
               freshness_class, verified_at, data_as_of,
               EXTRACT(DAY FROM stale_after)::int AS stale_after_days, confidence
        FROM research_memory
        WHERE project_id = ${query.projectId}
          AND topic_id = ${query.topicId}
          AND lifecycle_state = 'ACTIVE'
          ${claimFilter}
        ORDER BY pattern_step, confidence DESC
      `)
    ).rows as unknown as Row[];

    const hits = new Map<string, RetrievalHit>();
    for (const r of ontologyRows) hits.set(r.id, toHit(r, "ontology"));

    // Вторичный recall (§3.2, §3.4.2): FTS + pg_trgm по statement, та же
    // изоляция project_id/topic_id/ACTIVE. Диагностический путь — в v1
    // ontology-фетч по (project, topic) уже широк, но matchedVia
    // фиксирует, что нашлось бы ТОЛЬКО по тексту (триггер §3.4.4, §6).
    if (query.statementQuery?.trim()) {
      const textRows = (
        await db.execute(sql`
          SELECT id, pattern_step, claim_key, statement, mechanism_state,
                 freshness_class, verified_at, data_as_of,
                 EXTRACT(DAY FROM stale_after)::int AS stale_after_days, confidence
          FROM research_memory
          WHERE project_id = ${query.projectId}
            AND topic_id = ${query.topicId}
            AND lifecycle_state = 'ACTIVE'
            AND (
              to_tsvector('simple', statement) @@ plainto_tsquery('simple', ${query.statementQuery})
              OR similarity(statement, ${query.statementQuery}) > 0.3
            )
          ORDER BY pattern_step, confidence DESC
        `)
      ).rows as unknown as Row[];
      for (const r of textRows) {
        if (!hits.has(r.id)) hits.set(r.id, toHit(r, "fts"));
      }
    }

    // Top-K на шаг (§5.5: пороги в конфиг, не в код) — читатель передаёт
    // значение из product_config; здесь только применяем ограничение.
    const byStep = new Map<number, RetrievalHit[]>();
    for (const hit of hits.values()) {
      const list = byStep.get(hit.patternStep) ?? [];
      list.push(hit);
      byStep.set(hit.patternStep, list);
    }
    const result: RetrievalHit[] = [];
    for (const list of byStep.values()) {
      result.push(...list.slice(0, opts.topKPerStep));
    }
    return result.sort((a, b) => a.patternStep - b.patternStep);
  },
};

let _override: MemoryRetrievalGateway | null = null;

// Только для тестов: подмена gateway (тот же приём, что interpreter/gateway.ts).
export function __setMemoryRetrievalGateway(g: MemoryRetrievalGateway | null): void {
  _override = g;
}

export function resolveMemoryRetrievalGateway(): MemoryRetrievalGateway {
  return _override ?? structuredMemoryRetrievalGateway;
}
