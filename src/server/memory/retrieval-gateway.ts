import { sql } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";

// MemoryRetrievalGateway (phase-5-plan.md §3.4, D-040). Interface с одной
// реализацией сегодня («structured») — гибрид добавляется второй
// реализацией БЕЗ изменения планировщика. pgvector/эмбеддинги не вводятся.

export type MatchedVia = "ontology" | "fts" | "trgm";

export type MemoryHealth = "OK" | "QUESTIONABLE" | "REVERIFY" | "STALE" | "DEPRECATED";

export interface RetrievalHit {
  memoryId: string;
  patternStep: number;
  // D-060: компонент шага Pattern — ключ раскладки покрытия в планировщике.
  component: string;
  claimKey: string;
  statement: string;
  mechanismState: string | null;
  // D-059: health извлекается вместе с записью — планировщик обязан знать,
  // может ли запись закрывать компонент (OK) или только направлять
  // перепроверку (QUESTIONABLE/REVERIFY/STALE). DEPRECATED сюда не попадает
  // никогда — исключён самим запросом.
  health: Exclude<MemoryHealth, "DEPRECATED">;
  freshnessClass: "LOW_CHANGE" | "MEDIUM_CHANGE" | "HIGH_CHANGE";
  verifiedAt: Date;
  dataAsOf: Date | null;
  // MEDIUM-1: интервал stale_after читается ЦЕЛИКОМ (секунды), а не
  // EXTRACT(DAY ...) — '3 months' и '36 hours' сохраняют смысл, а не
  // усекались в ноль дней.
  staleAfterSeconds: number | null;
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
  component: string;
  claim_key: string;
  statement: string;
  mechanism_state: string | null;
  health: Exclude<MemoryHealth, "DEPRECATED">;
  freshness_class: "LOW_CHANGE" | "MEDIUM_CHANGE" | "HIGH_CHANGE";
  verified_at: Date;
  data_as_of: Date | null;
  stale_after_seconds: number | null;
  confidence: number;
}

function toHit(r: Row, matchedVia: MatchedVia): RetrievalHit {
  return {
    memoryId: r.id,
    patternStep: r.pattern_step,
    component: r.component,
    claimKey: r.claim_key,
    statement: r.statement,
    mechanismState: r.mechanism_state,
    health: r.health,
    freshnessClass: r.freshness_class,
    // db.execute() — raw pg driver, не гарантированно Date (в отличие от
    // типизированного select()); приводим явно.
    verifiedAt: new Date(r.verified_at),
    dataAsOf: r.data_as_of ? new Date(r.data_as_of) : null,
    staleAfterSeconds: r.stale_after_seconds != null ? Number(r.stale_after_seconds) : null,
    confidence: r.confidence,
    matchedVia,
  };
}

// Общий список колонок обоих путей retrieval. EXTRACT(EPOCH ...) — полный
// интервал в секундах (MEDIUM-1): месяцы/годы считаются по правилам
// Postgres (30 дней/месяц), а не отбрасываются.
const SELECT_COLUMNS = sql`
  id, pattern_step, component, claim_key, statement, mechanism_state, health,
  freshness_class, verified_at, data_as_of,
  EXTRACT(EPOCH FROM stale_after)::double precision AS stale_after_seconds,
  confidence
`;

// project_id ВСЕГДА в WHERE, никогда не снимается: кросс-проектное
// переиспользование запрещено в v1 (D-042) — это структурная, а не
// договорная гарантия изоляции.
//
// D-059: health='DEPRECATED' исключается самим запросом — знание признано
// НЕВЕРНЫМ (не устаревшим) и не должно даже направлять перепроверку.
// История при этом сохраняется в хранилище: исключение из retrieval —
// не удаление.
//
// ORDER BY ..., id — стабильный финальный tiebreaker (L-1, D-052):
// состав memoryIds контракта воспроизводим между идентичными прогонами.
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
        SELECT ${SELECT_COLUMNS}
        FROM research_memory
        WHERE project_id = ${query.projectId}
          AND topic_id = ${query.topicId}
          AND lifecycle_state = 'ACTIVE'
          AND health <> 'DEPRECATED'
          ${claimFilter}
        ORDER BY pattern_step, confidence DESC, id
      `)
    ).rows as unknown as Row[];

    const hits = new Map<string, RetrievalHit>();
    for (const r of ontologyRows) hits.set(r.id, toHit(r, "ontology"));

    // Вторичный recall (§3.2, §3.4.2): FTS + pg_trgm по statement, та же
    // изоляция project_id/topic_id/ACTIVE и тот же health-фильтр.
    // Диагностический путь — в v1 ontology-фетч по (project, topic) уже
    // широк, но matchedVia фиксирует, что нашлось бы ТОЛЬКО по тексту
    // (триггер §3.4.4, §6).
    if (query.statementQuery?.trim()) {
      const textRows = (
        await db.execute(sql`
          SELECT ${SELECT_COLUMNS}
          FROM research_memory
          WHERE project_id = ${query.projectId}
            AND topic_id = ${query.topicId}
            AND lifecycle_state = 'ACTIVE'
            AND health <> 'DEPRECATED'
            AND (
              to_tsvector('simple', statement) @@ plainto_tsquery('simple', ${query.statementQuery})
              OR similarity(statement, ${query.statementQuery}) > 0.3
            )
          ORDER BY pattern_step, confidence DESC, id
        `)
      ).rows as unknown as Row[];
      for (const r of textRows) {
        if (!hits.has(r.id)) hits.set(r.id, toHit(r, "fts"));
      }
    }

    // Top-K на шаг (§5.5: пороги в конфиг, не в код) — читатель передаёт
    // значение из product_config; здесь только применяем ограничение.
    // Отбор и порядок внутри шага детерминированы: confidence DESC, id ASC
    // (L-1) — слияние двух путей не должно возвращать нестабильный состав.
    const byStep = new Map<number, RetrievalHit[]>();
    for (const hit of hits.values()) {
      const list = byStep.get(hit.patternStep) ?? [];
      list.push(hit);
      byStep.set(hit.patternStep, list);
    }
    const result: RetrievalHit[] = [];
    for (const list of byStep.values()) {
      list.sort(
        (a, b) => b.confidence - a.confidence || (a.memoryId < b.memoryId ? -1 : a.memoryId > b.memoryId ? 1 : 0),
      );
      result.push(...list.slice(0, opts.topKPerStep));
    }
    return result.sort(
      (a, b) =>
        a.patternStep - b.patternStep ||
        b.confidence - a.confidence ||
        (a.memoryId < b.memoryId ? -1 : a.memoryId > b.memoryId ? 1 : 0),
    );
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
