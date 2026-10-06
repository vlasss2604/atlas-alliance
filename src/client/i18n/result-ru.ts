// THE RESULT'S CODE-OWNED SENTENCES, IN RUSSIAN (D-171).
//
// The Result, the full audit and the evidence cards are built from persisted
// statuses and closed reason codes through a deterministic phrasebook
// (research-model.ts, result-surface.ts, audit-model.ts,
// mechanism-typed-value.ts). The English phrasebook stays where it is and is
// byte-for-byte unchanged; this file is its Russian twin, chosen only when
// the user's saved display language is RU (display-language.ts).
//
// Translation only. Every entry restates exactly the English entry it
// mirrors — same claim, same polarity, same limit, never stronger — and the
// keys are the same closed codes, pinned equal by a test. Nothing here reads
// evidence text: what a source or the model wrote (evidence summaries,
// excerpts, source titles, projection labels, v1 "does not prove" claims,
// chain caveats) stays in its original language wherever it is shown.
//
// Russian product vocabulary (D-171): «исследование», «закрытая бета»,
// «Библиотека исследований»; Proof, ATLAS, ARI untranslated.

/* ------------------------------------------------------------------ *
 * research-model.ts
 * ------------------------------------------------------------------ */

// REASON_CODE_EXPLANATIONS — one sentence per persisted reason code.
export const RU_REASON_CODE_EXPLANATIONS: Record<string, string> = {
  NO_EVIDENCE_FOUND: "В проверенных здесь источниках по этому пункту ничего не нашлось.",
  SEARCH_BUDGET_EXHAUSTED: "Исследование достигло предела поиска раньше, чем удалось проверить этот пункт.",
  NO_ADMISSIBLE_ROUTE: "Пока нет подтверждённого пути к источникам, через который можно было бы проверить этот пункт.",
  EXTRACTION_NOT_COMPLETED:
    "Источники, открытые по этому пункту, не удалось прочитать до конца, поэтому ничего не было проверено.",
  ALL_EVIDENCE_EXCLUDED: "Источники это обсуждали, но ни один не соответствовал стандарту, которого требует это утверждение.",
  MISSING_EXECUTION_EVIDENCE: "Механизм описан, но ничто из проверенного не показывает, что он действительно работает.",
  MISSING_CURRENT_STATE: "Ничто из проверенного не говорит, действует ли это сейчас.",
  STALE_CURRENT_STATE: "Единственные источники, которые это описывают, слишком старые, чтобы говорить о настоящем.",
  INSUFFICIENT_AUTHORITY: "Утверждение встречается только в источниках, которые не могут его подтвердить.",
  MECHANICAL_PROVENANCE_NOT_ESTABLISHED:
    "Источники это описывают, но ничто из прочитанного в блокчейне не связывает произошедшее с самим задокументированным механизмом.",
  INDIRECT_ONLY: "Источники упоминают это косвенно, не утверждая прямо.",
  STATE_NOT_FULLY_LIVE: "Описано внедрение или подготовка, а не полностью действующее состояние.",
  PROPOSED_STATE_ONLY: "Источники описывают это как предложение, а не как принятое или действующее решение.",
  APPROVAL_NOT_ESTABLISHED:
    "Источники показывают, что управление обсуждало или описывало это, но ничто из проверенного не показывает решения о его одобрении.",
  APPROVAL_LATER_WITHDRAWN:
    "Более ранняя запись управления одобрила это, а более поздняя приостановила, признала устаревшим или отозвала, поэтому одобрение, действующее сейчас, не показано.",
  CONFLICTING_STATE: "Источники расходятся в том, каково текущее состояние.",
  TOKEN_STATE_UNQUALIFIED: "Состояние токена упоминается, но недостаточно точно, чтобы решить вопрос о рассматриваемом эффекте.",
  SUPPLY_REDUCTION_NOT_ESTABLISHED:
    "Ничто из проверенного здесь не показывает уничтожения токенов — покупка, хранение или перевод перемещают токены, не сокращая предложение.",
  NET_SUPPLY_CHANGE_NOT_ESTABLISHED:
    "Токены были уничтожены, но ничто из проверенного не показывает, что общее предложение в целом сократилось — сколько ещё было выпущено или разблокировано за тот же период, не наблюдалось.",
  NET_SUPPLY_CHANGE_NOT_ATTRIBUTED:
    "Токены были уничтожены, и общее предложение в конце измеренного периода было ниже, чем в начале, — но ничто из проверенного не показывает, что его сократил именно этот механизм.",
  NET_SUPPLY_NOT_REDUCED_OVER_INTERVAL:
    "Токены были уничтожены, но общее предложение в конце измеренного периода было не ниже, чем в начале, — значит, за этот период было выпущено не меньше, чем уничтожено.",
  CONFLICTING_SUPPLY_DELTA:
    "Измерения предложения за этот период расходятся в том, в какую сторону изменился общий объём, поэтому ни одно из них не использовано.",
  ZERO_ADDRESS_TRANSFER_SUPPLY_DECREASE_NOT_ATTRIBUTED:
    "Зафиксирован перевод токена проекта на нулевой адрес, и общее предложение в конце измеренного периода было ниже, чем в начале, — но доказательства не устанавливают, что его сократил именно этот перевод или что заявленный механизм был исполнен.",
  ZERO_ADDRESS_TRANSFER_SUPPLY_NOT_REDUCED:
    "Зафиксирован перевод токена проекта на нулевой адрес, и общее предложение в конце измеренного периода было не ниже, чем в начале.",
};

// SOURCE_CLASS_CAVEATS — what a class of source can and cannot settle.
export const RU_SOURCE_CLASS_CAVEATS: Record<string, { from: string; can: string; cannot: string }> = {
  OFFICIAL_DOCS: {
    from: "Это взято из собственной документации проекта.",
    can: "Показывает, что проект официально документирует.",
    cannot: "Одна лишь документация не устанавливает, что задокументированное действительно происходит.",
  },
  GOVERNANCE: {
    from: "Это взято из официального решения управления.",
    can: "Показывает, что решение было официально одобрено.",
    cannot: "Одобренное решение не доказывает, что оно было исполнено.",
  },
  ONCHAIN_VERIFIABLE: {
    from: "Это взято из записей в блокчейне.",
    can: "Показывает транзакции и состояние, записанные в блокчейне.",
    cannot: "Чтобы связать запись с конкретным механизмом, может понадобиться больше доказательств.",
  },
  OFFICIAL_REPORT: {
    from: "Это взято из собственной отчётности проекта.",
    can: "Показывает, что проект сообщает о себе.",
    cannot: "Отчётность самого проекта не является независимым подтверждением.",
  },
  DATA_PROVIDER: {
    from: "Это взято у стороннего поставщика данных.",
    can: "Показывает измеренные данные в рамках методологии этого поставщика.",
    cannot: "Методология, стоящая за цифрами, здесь сама не проверяется.",
  },
  RESEARCH_MEDIA: {
    from: "Это взято из вторичных публикаций.",
    can: "Полезно для контекста и для поиска зацепок, которые стоит проверить.",
    cannot: "Публикации не заменяют первичных доказательств, которых требует утверждение.",
  },
  SOCIAL: {
    from: "Это взято из публичного заявления.",
    can: "Показывает, что заявление было сделано, и кем.",
    cannot: "Сам факт заявления не доказывает, что оно верно.",
  },
};

// EXCLUSION_LABELS — why a source was read and then refused.
export const RU_EXCLUSION_LABELS: Record<string, string> = {
  WRONG_COMPONENT: "Относится к другой части механизма",
  WRONG_PROJECT: "Относится к другому проекту",
  LEGACY_CONTRACT_VERSION: "Прочитано по старому контракту доказательств, поэтому не использовано повторно",
  CLASS_NOT_ADMISSIBLE: "Источник такого типа не может установить этот шаг",
  DIRECTNESS_INSUFFICIENT: "Упоминает это лишь косвенно",
  RELATIONSHIP_NOT_SUPPORTING: "Упоминает это, не подтверждая",
  NOT_CURRENT_STATE_BEARING: "Не говорит, верно ли это сейчас",
  MISSING_PUBLICATION_DATE: "Без даты, поэтому не может установить текущее состояние",
  STALE_FOR_CURRENT_STATE: "Слишком старое, чтобы установить текущее состояние",
  SUPERSEDED_BY_NEWER: "Заменено более свежим источником",
  DUPLICATE_UNIT: "Тот же фрагмент уже был учтён",
  ENTITY_NOT_CONFIRMED: "Не привязано к подтверждённой идентичности этого проекта в блокчейне",
};
export const RU_EXCLUSION_FALLBACK = "Не соответствовало стандарту доказательств для этого шага";

// COMPONENT_LABELS — the canonical name of a check (the audit's technical record).
export const RU_COMPONENT_LABELS: Record<string, string> = {
  SOURCE_OF_VALUE: "Источник ценности",
  FLOW_PATH: "Путь ценности",
  MECHANISM_SPEC: "Описание механизма",
  GOVERNANCE_BASIS: "Основание в управлении",
  EXECUTION_EVIDENCE: "Доказательство исполнения",
  CURRENT_STATE: "Текущее состояние",
  DESTINATION: "Назначение",
  RECIPIENT: "Получатель",
  NET_EFFECT: "Итоговый эффект",
  DURABILITY_BASIS: "Основание устойчивости",
};

// CLAIM_LABELS — the ladder rows' claims (MECHANISM_ROWS / VALUE_ROWS).
export const RU_CLAIM_LABELS: Record<string, string> = {
  MECHANISM_SPEC: "Проект документирует механизм",
  GOVERNANCE_BASIS: "Решение управления его санкционирует",
  CURRENT_STATE: "Механизм действует сейчас",
  EXECUTION_EVIDENCE: "Исполнение зафиксировано",
  SOURCE_OF_VALUE: "Откуда берётся ценность",
  FLOW_PATH: "Путь, который проходит ценность",
  DESTINATION: "Куда должна идти ценность",
  RECIPIENT: "Кто её получает",
  NET_EFFECT: "Влияние на предложение токена",
  DURABILITY_BASIS: "Насколько устойчиво это устройство",
};
export const RU_CLAIM_LABEL_NO_COMPONENT = "Это исследование";

// COMPONENT_PHRASES — what each check means, as a phrase. In Russian these
// follow a colon ("Подтверждено: …"), so a noun phrase and a clause both read.
export const RU_COMPONENT_PHRASES: Record<string, string> = {
  SOURCE_OF_VALUE: "откуда берётся экономическая ценность",
  FLOW_PATH: "путь, который ценность проходит через протокол",
  MECHANISM_SPEC: "что указано в собственной документации проекта",
  GOVERNANCE_BASIS: "решение управления, на котором основан механизм",
  EXECUTION_EVIDENCE: "исполнялся ли механизм на самом деле",
  CURRENT_STATE: "действует ли механизм сейчас",
  DESTINATION: "куда в итоге попадает ценность",
  RECIPIENT: "кто в итоге её получает",
  NET_EFFECT: "устойчивое влияние на предложение токена",
  DURABILITY_BASIS: "насколько устойчив механизм",
};

// ResultRow sentences (buildRow).
export const RU_ROW = {
  blockedReason: "ATLAS не смог завершить проверки по этому шагу, поэтому доказательства здесь неполные.",
  shows: (phrase: string) => `Проверенные доказательства устанавливают: ${phrase}.`,
  showsPartly: (phrase: string) => `Проверенные доказательства частично устанавливают: ${phrase}.`,
  showsOtherWay: (phrase: string) => `Проверенные доказательства указывают на обратное: ${phrase}.`,
  checkedBlocked: "Источники для этого шага не удалось открыть.",
  checkedNone: "Ни один прочитанный ATLAS источник не содержал доказательств для этого шага.",
  checkedUsed: (n: number) => `${ruCount(n, "источник использован", "источника использованы", "источников использовано")} как доказательство.`,
  checkedRead: (n: number) => `${ruCount(n, "источник прочитан", "источника прочитаны", "источников прочитано")}, но не ${ruPlural(n, "использован", "использованы", "использовано")}.`,
  checkedBoth: (used: number, read: number) =>
    `${ruCount(used, "источник использован", "источника использованы", "источников использовано")} как доказательство, ещё ${ruCount(read, "прочитан и не использован", "прочитаны и не использованы", "прочитано и не использовано")}.`,
  limitation:
    "Во время этого шага не удалось получить доступ к нужным источникам. Это ограничение данного исследования, а не доказательство за или против проекта.",
};

// passageLimitLine — the frame for a v1 claim, which itself stays verbatim.
export const RU_DOES_NOT_ESTABLISH = (claim: string) => `Не устанавливает: ${claim}`;

// researchAnswer — the answer for a run that did not end in a verdict.
export const RU_ANSWER = {
  subjectFallback: "этот проект",
  and: "и",
  or: "или",
  inProgress: (s: string) => `Исследование по этому вопросу о ${s} ещё идёт.`,
  failedNothing: (s: string) => `Это исследование не завершилось, поэтому оно ничего не подтвердило о ${s}.`,
  failedIsRun: "Сбой — это проблема самого запуска, а не вывод о проекте.",
  failedPartly: (s: string) => `Это исследование не завершилось, поэтому оно ответило не на весь вопрос о ${s}.`,
  contradicted: (list: string) => `Доказательства указывают на обратное: ${list}.`,
  failedBoth: (v: string, p: string) => `До сбоя источники подтвердили: ${v}; частично подтвердили: ${p}.`,
  failedVerified: (v: string) => `До сбоя источники подтвердили: ${v}.`,
  failedPartial: (p: string) => `До сбоя источники частично подтвердили: ${p}.`,
  failedSome: "Некоторые выводы были подтверждены до сбоя; они перечислены ниже.",
  cancelled: "Это исследование было отменено до того, как пришло к выводу.",
  confirmed: (list: string) => `Подтверждено: ${list}.`,
  unresolved: (list: string) => `Имеющиеся доказательства не устанавливают: ${list}.`,
  stoppedAtLimit: (s: string) => `Это исследование остановилось на своём пределе, не охватив всего, что собиралось проверить о ${s}.`,
  noConclusion: (s: string) => `Это исследование завершилось, не построив Proof для ${s}.`,
};

/* ------------------------------------------------------------------ *
 * result-surface.ts
 * ------------------------------------------------------------------ */

// The mechanism noun is read from the question in result-surface
// (`mechanismNounOf`, an English key such as "the buyback"); these are its
// Russian forms. Gender drives the past-tense and short-participle endings.
interface RuNoun {
  nom: string;
  gender: "m" | "n";
}
const RU_NOUNS: Record<string, RuNoun> = {
  "the buyback": { nom: "выкуп", gender: "m" },
  "the burn": { nom: "сжигание", gender: "n" },
  "the revenue share": { nom: "распределение выручки", gender: "n" },
  "the reward": { nom: "вознаграждение", gender: "n" },
  "the fee switch": { nom: "переключатель комиссий", gender: "m" },
  "the mechanism": { nom: "механизм", gender: "m" },
};
function nounOf(key: string): RuNoun {
  return RU_NOUNS[key] ?? RU_NOUNS["the mechanism"];
}
const g = (n: RuNoun, m: string, neuter: string) => (n.gender === "m" ? m : neuter);

// questionLabelFor — what a reader asks, per check.
export function ruQuestionLabel(component: string, nounKey: string): string | null {
  const n = nounOf(nounKey);
  const buyback = nounKey === "the buyback";
  switch (component) {
    case "SOURCE_OF_VALUE":
      return `За счёт чего финансируется ${n.nom}?`;
    case "FLOW_PATH":
      return "Как ценность туда поступает?";
    case "MECHANISM_SPEC":
      return `Как ${g(n, "устроен", "устроено")} ${n.nom}?`;
    case "GOVERNANCE_BASIS":
      return "Кто это одобрил?";
    case "CURRENT_STATE":
      return `Действует ли ${n.nom} сейчас?`;
    case "EXECUTION_EVIDENCE":
      return `${g(n, "Был", "Было")} ли ${n.nom} фактически ${g(n, "исполнен", "исполнено")}?`;
    case "DESTINATION":
      return buyback ? "Куда идут выкупленные токены?" : "Куда идёт ценность?";
    case "RECIPIENT":
      return "Кто в итоге получает эту ценность?";
    case "NET_EFFECT":
      return "Действительно ли сокращается общее предложение?";
    case "DURABILITY_BASIS":
      return "Насколько это устойчиво?";
    default:
      return null;
  }
}

// statementPhraseFor — the same checks as clauses ("Источники подтверждают, …").
export function ruStatementPhrase(component: string, nounKey: string): string | null {
  const n = nounOf(nounKey);
  const buyback = nounKey === "the buyback";
  switch (component) {
    case "SOURCE_OF_VALUE":
      return `за счёт чего финансируется ${n.nom}`;
    case "FLOW_PATH":
      return "как ценность туда поступает";
    case "MECHANISM_SPEC":
      return `как ${g(n, "устроен", "устроено")} ${n.nom}`;
    case "GOVERNANCE_BASIS":
      return "кто это одобрил";
    case "CURRENT_STATE":
      return `что ${n.nom} действует сейчас`;
    case "EXECUTION_EVIDENCE":
      return `что ${n.nom} фактически ${g(n, "был исполнен", "было исполнено")}`;
    case "DESTINATION":
      return buyback ? "куда идут выкупленные токены" : "куда идёт ценность";
    case "RECIPIENT":
      return "кто в итоге получает эту ценность";
    case "NET_EFFECT":
      return "что общее предложение действительно сокращается";
    case "DURABILITY_BASIS":
      return "насколько это устойчиво";
    default:
      return null;
  }
}

// stopStatePhrase — a current state established as a stop.
export function ruStopStatePhrase(state: "PAUSED" | "DEPRECATED" | "REMOVED", nounKey: string): string {
  const n = nounOf(nounKey);
  if (state === "PAUSED") return `что ${n.nom} сейчас ${g(n, "приостановлен", "приостановлено")}`;
  if (state === "DEPRECATED") return `что ${n.nom} ${g(n, "признан устаревшим", "признано устаревшим")}`;
  return `что ${n.nom} ${g(n, "отменён", "отменено")}`;
}

const RU_STOP_WORDS = { DEPRECATED: "признано устаревшим", REMOVED: "отменено" } as const;

export const RU_SURFACE = {
  and: "и",
  or: "или",
  projectFallback: "этот проект",
  // Row limits and ceilings (one sentence each, never a finding about the project).
  levelReadingLimit: "Одно измерение общего предложения не может этого показать.",
  burnEventOnlyLimit:
    "Зафиксировано сжигание токена проекта, но имеющиеся доказательства не устанавливают, что его выполнил заявленный механизм.",
  stateUnstatedLimit:
    "Проверенные источники не говорят, происходит ли это сейчас; одна лишь свежая дата страницы этого не показывает.",
  dateUntrustedLimit: "У проверенных источников нет даты публикации, которая могла бы показать, что это происходит сейчас.",
  rowLimit: {
    TECHNICAL: "Исследование остановилось раньше, чем удалось проверить этот пункт.",
    CONFIGURATION: "У ATLAS пока нет поддерживаемого источника, который мог бы независимо проверить этот пункт.",
  },
  boundaryCopy: {
    SUBSTANTIVE: "Имеющиеся доказательства этого не решают.",
    TECHNICAL: "Исследование остановилось раньше, чем удалось проверить все релевантные источники.",
    CONFIGURATION: "У ATLAS пока нет поддерживаемого источника, который мог бы независимо проверить этот пункт.",
  },
  boundaryNever: {
    SUBSTANTIVE: "Это описание проверенных доказательств, а не доказательство того, что чего-то нет.",
    TECHNICAL: "Это ограничение данного исследования, а не вывод о проекте.",
    CONFIGURATION: "Это ограничение того, что ATLAS может проверить сейчас, а не вывод о том, что механизм не работает.",
  },
  // The answer cell's own fallbacks.
  sourcesConfirm: (phrase: string) => `Источники подтверждают, ${phrase}.`,
  partialGapFallback: "Источники, на которые можно опереться, не подтверждают утверждение целиком.",
  coversPart: (gap: string) => `Источники подтверждают это лишь частично. ${gap}`,
  otherWay: "Доказательства указывают на обратное.",
  doesNotSettle: "Имеющиеся доказательства этого не решают.",
  // Current-state notes.
  pausedLatest: (when: string | null) =>
    `Последнее официальное состояние — приостановлено${when ? ` (запись от ${when})` : ""}; из этого не следует, что это происходит сейчас.`,
  pausedStated: "Официальная запись указывает, что это приостановлено; из этого не следует, что это происходит сейчас.",
  stoppedLatest: (state: "DEPRECATED" | "REMOVED", when: string | null) =>
    `Официальная запись${when ? ` от ${when}` : ""} указывает, что это ${RU_STOP_WORDS[state]}; более новые записи не показывают, что это снова действует.`,
  stoppedStated: (state: "DEPRECATED" | "REMOVED") => `Официальная запись указывает, что это ${RU_STOP_WORDS[state]}.`,
  lastPaused: (when: string) => `Последний раз это было зафиксировано как приостановленное ${when}; текущее состояние неизвестно.`,
  lastStopped: (state: "DEPRECATED" | "REMOVED", when: string) =>
    `Официальная запись от ${when} указывает, что это ${RU_STOP_WORDS[state]}; более новые записи не показывают, что это снова действует.`,
  lastActive: (when: string) =>
    `Последняя запись о том, что это действует, датирована ${when}; ничто недавнее не подтверждает, что это действует сейчас.`,
  // Execution-time notes.
  executionDated: (when: string) =>
    `Подтверждающие доказательства датированы ${when}: они показывают, что исполнение к тому моменту произошло, но не то, что оно продолжается сейчас.`,
  executionUndated:
    "У подтверждающих доказательств нет собственной даты: они показывают, что исполнение произошло, но не то, что оно продолжается сейчас.",
  executionDocumentary: " Это основано на источнике, который сообщает об исполнении, а не на транзакции в блокчейне, которую наблюдал ATLAS.",
  // Chain observations.
  supplyObserved: (ticker: string | null, amount: string) =>
    ticker ? `Зафиксировано общее предложение ${ticker}: ${amount}` : `Зафиксировано общее предложение токена: ${amount}`,
  onchainStateObserved: "Зафиксировано состояние в блокчейне",
  onchainRecord: "Запись в блокчейне",
  onchainDomain: "блокчейн",
  // The answer.
  contradicted: (list: string) => `Относительно того, ${list}, доказательства указывают на обратное.`,
  confirmed: (list: string) => `Источники подтверждают, ${list}.`,
  partial: (list: string, gap: string) => `Есть доказательства того, ${list}, но это подтверждено не полностью.${gap}`,
  open: (list: string) => `Имеющиеся доказательства не показывают, ${list}.`,
  openTechnical: " Исследование остановилось раньше, чем удалось проверить все релевантные источники.",
  openConfiguration: (project: string) =>
    ` У ATLAS пока нет поддерживаемого источника, который мог бы независимо проверить это для ${project}.`,
  noFinding: (project: string) => `Это исследование завершилось без вывода, который можно было бы утверждать о ${project}.`,
};

/* ------------------------------------------------------------------ *
 * mechanism-typed-value.ts
 * ------------------------------------------------------------------ */

export const RU_TYPED_VALUE_ABSENT_LIMIT: Readonly<Record<string, string>> = {
  RECIPIENT: "Источники по этому пункту прочитаны, но запись не называет конкретного получателя.",
  DESTINATION: "Источники по этому пункту прочитаны, но запись не устанавливает конкретного назначения.",
};

/* ------------------------------------------------------------------ *
 * audit-model.ts
 * ------------------------------------------------------------------ */

export const RU_AUDIT = {
  outcomeLabels: {
    CONFIRMED: "Подтверждено",
    PARTIALLY_CONFIRMED: "Частично подтверждено",
    CONTRADICTED: "Опровергнуто",
    COULD_NOT_VERIFY: "Не подтверждено",
    RESEARCH_BLOCKED: "Не подтверждено — исследование остановилось раньше",
  } as Record<string, string>,
  coverageLabels: {
    COMPLETED: "Проверено полностью",
    PARTIAL: "Проверено частично",
    BLOCKED: "Не удалось получить доступ",
    NOT_ATTEMPTED: "Не проверялось",
  } as Record<string, string>,
  // The raw stored status stays an engine code: this is the technical record.
  untypedReason: (limit: string, status: string) => `${limit} Сохранённый статус компонента: ${status}.`,
  conflictDetail:
    "Исследование зафиксировало доказательства по обе стороны этого пункта. Показанное состояние сверки — собственный результат движка, а не выбор между источниками.",
  conflictNeeded:
    "Источник более высокого уровня, чем оба, или прямое наблюдение в блокчейне, чтобы решить, какая версия этого пункта верна.",
  technicalDetail:
    "Нужный для этого пункта источник не удалось получить во время исследования. Это ограничение данного запуска, а не доказательство того, что механизма нет.",
  technicalNeeded: "Повторный запуск с доступом к источнику, который нужен для этого пункта.",
  evidenceDetail: "Проверка этого пункта завершилась, но доказательства, нужные для ответа, не были установлены.",
  neededExcluded: "Источник, класс которого достаточно авторитетен для такого утверждения.",
  neededAuthority: "Источник достаточного уровня для этого утверждения или прямое наблюдение в блокчейне.",
  neededAny: "Любое допустимое доказательство по этому пункту; в этом запуске таких не нашлось.",
};

/* ------------------------------------------------------------------ */

function ruPlural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
function ruCount(n: number, one: string, few: string, many: string): string {
  return `${n} ${ruPlural(n, one, few, many)}`;
}
