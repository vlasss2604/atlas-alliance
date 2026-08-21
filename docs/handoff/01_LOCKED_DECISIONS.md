# ATLAS PROOF — LOCKED DECISIONS

Все решения ниже **приняты и закрыты**. Не пересматривать самостоятельно, даже если в старых документах в `canonical/` встретится другая формулировка. Если новый материал будет противоречить этому файлу — это открытый вопрос для владельца, а не повод менять реализацию.

---

## 1. Продуктовая модель

| | |
|---|---|
| Продукт | ATLAS PROOF — Research Intelligence for Digital Assets |
| Интеллект внутри | ARI (Atlas Research Intelligence) |
| Уровни доступа | `DEMO` → `ARI_CORE` |
| Активная тема | Token Value Capture (единственная) |
| Платформа | Telegram Mini App, mobile-first |

**Отменённая терминология — не использовать в user-facing UI:** FREE, START, PLUS, PRO, Pattern v1/v2, training batch, Research Contract, internal telemetry.

---

## 2. DEMO

```
lifetimeProofLimit:      3   (lifetime, НЕ per day, НЕ monthly reset)
allowedProjectIds:       pump_fun, hyperliquid, uniswap  (конфигурируемо)
allowedTopicIds:         token_value_capture
maxResearchCapability:   TARGETED_REFRESH
maxRecoverySteps:        1
deepCheck:               нет (фича удалена из продукта)
links:                   нет (фича удалена из продукта)
```

**DEMO — настоящий ATLAS в миниатюре, не витрина готовых ответов.** Ограничения по охвату и бюджету, а не по качеству. Тот же Research Engine, что и в CORE — **никакого отдельного DEMO executor**.

Поведение:
- Memory свежая → `MEMORY` → Proof
- Ключевой факт устарел → `TARGETED_REFRESH` только устаревшего факта → Proof
- Требуется полноценное исследование с нуля → Guard блокирует, возвращается capability boundary
- Evidence не хватило в рамках бюджета → честный `INSUFFICIENT_EVIDENCE`, стандарт доказательности не снижается

Proof-квота **не списывается** при: невалидном claim, неподдерживаемом проекте/теме, технической ошибке, отменённом выполнении. Использовать reservation model: `AVAILABLE → RESERVED → CONSUMED`, при сбое `RESERVED → RELEASED`. Требуется идемпотентность.

**После исчерпания 3 Proof:** read-only доступ сохраняется. Пользователь видит свою историю, готовые Proof, Proof Map, проекты, профиль. Блокируется только запуск нового исследования.

---

## 3. ARI • CORE

```
maxResearchCapability:   FRESH_RESEARCH
recoveryPolicy:          FULL_WITHIN_BUDGET
projectScope:            ACTIVE_CORE_PROJECTS (динамический)
```

**CORE — не каталог из N проектов.** Это доступ к развивающемуся Research Intelligence, способному исследовать новые проекты внутри обученной темы.

Когда проект получает статус `ACTIVE_CORE` — все действующие подписчики получают доступ автоматически. Список проектов **не копируется** внутрь пользовательской подписки. Кэш доступных проектов должен инвалидироваться при изменении статуса проекта.

**Legacy roster (требует migration gap report, не тихой замены):**
Pump.fun, Hyperliquid, Aave, Ethena, Pendle, Uniswap, Jupiter, Morpho, Aerodrome, Sky — больше не source of truth.

---

## 4. Монетизация

- **Только Telegram Stars.** Один платёжный слой.
- Цена ARI • CORE: **2 999 Stars / месяц** — брать из product config, не хардкодить по UI.
- **TON Connect / GRAM / USDT / карты / RUB — НЕ реализовывать.** Причина: правила Telegram требуют, чтобы цифровые услуги внутри Mini App продавались только за Stars. Это не «отложено», это ограничение платформы.
- **Links (внутренняя валюта) — удалены полностью.** Никакого ledger, holds, capture/release, покупки пачками.
- **Deep Check — удалён полностью.** Никакой отдельной оплаты за «более глубокий Proof».
- Глубину исследования выбирает ARI, не пользователь. Никакого Research Mode selector.

### Жизненный цикл подписки

- **Entitlement фиксируется в момент успешного старта job** (`entitlement_at_start`). Если CORE был активен при запуске — исследование доводится до конца, даже если подписка истекла через минуту.
- **Неуспешное продление:** grace period в v1 нет. Подписка неактивна → новые CORE research заблокированы → read-only история + правила DEMO.
- **Refund:** после подтверждённого refund CORE entitlement прекращается для новых исследований. Уже созданные Proof не удаляются. Уже запущенный job не обрывается.
- **После окончания CORE:** вся история остаётся доступной для чтения. Entitlement возвращается к DEMO. Новые 3 DEMO Proof **не выдаются** — счётчик lifetime живёт на уровне User и не сбрасывается при смене плана. Если до CORE было использовано 1 из 3 — останется 2.

---

## 5. Question Interpreter (Input Intelligence Layer)

Лёгкий AI-слой **перед** Research Engine. Не второй research-агент: не ищет источники, не собирает Evidence, не строит Proof, не отвечает на вопрос пользователя.

```
USER LANGUAGE
→ понять запрос
→ отфильтровать невалидный/неподдерживаемый ввод
→ нормализовать в research task
→ передать структурированную задачу в ARI
```

Реализуется как **один лёгкий AI-вызов** (не три агента, не отдельный Research API). Переиспользовать существующую AI-инфраструктуру.

**Статусы:** `READY / NEEDS_CLARIFICATION / OUT_OF_SCOPE / INVALID`

**Правила:**
- Сохранять смысл пользователя, не менять intent
- Не требовать профессиональной терминологии
- Не додумывать отсутствующий intent (нет названия токена → спросить, не выдумывать)
- Уточнять только когда разные интерпретации ведут к разному исследованию
- Допущения пользователя фиксировать как допущения, не как проверенные факты
- **Максимум 2 попытки уточнения.** После второй неудачной — «Не удалось достаточно точно определить исследовательскую задачу. Попробуйте сформулировать новый вопрос.» и закрыть текущий flow.

**Жёсткое правило:** Research Engine не стартует, если `interpreter.status !== READY`. Если сам Interpreter API падает — не отправлять сырой ввод в Research Engine.

Логировать цепочку: `Original Question → Normalized Task → Research Plan → Proof`. Это позволяет отличить UNDERSTANDING FAILURE от RESEARCH FAILURE.

---

## 6. Research Engine — единый для DEMO и CORE

```
USER QUESTION
→ INTENT UNDERSTANDING
→ SANITY / RELEVANCE / SCOPE ROUTER
→ RETRIEVE VERIFIED RESEARCH MEMORY
→ BUILD MINIMAL RESEARCH PLAN
→ RUN ONLY REQUIRED CHECKS
→ FRESH EVIDENCE FOR MISSING / STALE FACTS
→ COUNTEREVIDENCE
→ RESEARCH STOP
→ SIMPLE ANSWER
→ OPTIONAL DEEP PROOF
→ VERIFIED LEARNING → RESEARCH MEMORY
```

Разница между уровнями — только в том, какую ветку разрешает entitlement/budget. Не создавать `DemoResearchEngine` / `CoreResearchEngine`.

Подробности методологии — в `skills/atlas-core/SKILL.md`.

---

## 7. Proof — layered output

Полная иерархия (каноническая, не сокращать):

```
1. Verdict + Confidence
2. Простыми словами
3. Почему ATLAS пришёл к этому выводу
4. Что важно учитывать / главный нюанс
5. Подробнее
6. Что может изменить вывод
7. Evidence / Sources / Gaps
```

Первый viewport остаётся чистым — глубина раскрывается скроллом/expand (progressive disclosure). Блок «Что может изменить вывод» **обязателен** — это часть философии продукта: вывод основан на текущих доказательствах, а не объявляется вечной истиной.

Не наполнять «Подробнее» дублирующим текстом ради самого блока.

**Verdicts:** `SUPPORTED / PARTIALLY_SUPPORTED / NOT_SUPPORTED / INSUFFICIENT_EVIDENCE / NOT_APPLICABLE`

---

## 8. Proof Map

**3 top-level узла — и в DEMO, и в CORE:**

```
        Evidence
           |
Sources — CLAIM — Gaps
```

В центре: Claim + Verdict + Confidence.

**Не добавлять как отдельные top-level узлы:** Risks, Contradictions, Analytics, Community, Media, On-chain, Experts, Mechanisms, Memory, Patterns.

CORE может иметь более глубокий drill-down **внутри** узла, но не больше главных кругов. Это требование визуальной преемственности между уровнями.

---

## 9. UI / Навигация

**Bottom navigation (единственная навигация, гамбургер не нужен):**

| Элемент | Назначение |
|---|---|
| Главная | основной экран / вход в продукт |
| Исследования | история пользовательских Proof, private by default |
| **центральная ARI-кнопка** | глобальное действие «начать новое исследование», доступно из любого места, мягкий переход в question-first flow |
| Проекты | проекты, доступные/исследованные ARI, с Project Memory и связанными Proof |
| Профиль | аккаунт, подписка, язык, настройки, приватность, помощь, удаление аккаунта |

**Input — question-first, не claim-first:**
- Заголовок: «Что вы хотите понять?»
- Placeholder: «Задайте вопрос о проекте, токене или рыночном механизме…»
- Рядом компактный `?` с кликабельными примерами вопросов
- Термин «claim» может существовать внутри системы, но не обязателен в UI

**Research progress — 5 стадий:**
```
1. Понимаю задачу
2. Проверяю накопленный опыт
3. Ищу недостающие доказательства
4. Сопоставляю доказательства
5. Формирую Proof
```
Показывать только реально происходящие стадии. Не держать пользователя на фиктивном этапе ради красивой последовательности.

**Удалено из макетов (не реализовывать):** колокольчик/notification center, гамбургер-меню, кнопка «Уточнить / Deep Check».

**Завершение research:** persistent ResearchJob выставляет completion/unread state. В приложении это проявляется индикатором на ARI-кнопке и новым Proof во вкладке «Исследования». Отдельного notification center нет. Telegram Bot уведомление о завершении — возможно позже для публичной версии, архитектуру не блокировать.

**Share:** только экспорт снапшота / изображения / системный Telegram share. **Не** публичная страница ATLAS с URL.

**Язык:** ручной выбор RU / EN в Профиле, без авто-детекта по Telegram locale. По умолчанию английский. Хранится на backend, привязан к ATLAS User ID, не к localStorage.

**Локализация Evidence:** интерфейс, verdict, объяснения ARI, краткое описание Evidence — локализуются. Название источника, короткий фрагмент источника, ссылка — остаются в оригинале. Опциональная кнопка «Перевести» для конкретного фрагмента — возможна позже.

---

## 10. Onboarding

3 экрана перед первым входом. Хранить `onboardingCompleted`, `onboardingCompletedAt`, `onboardingVersion` на User (не в localStorage). Endpoint идемпотентен.

```
Screen 1 — Что такое ATLAS PROOF / что такое ARI / кому полезен
Screen 2 — Как пользоваться: вопрос → ARI исследует → Proof
Screen 3 — Как развивается ARI: Проекты → Темы → Связи → Сценарии
```

Разрешён один вторичный action — «Пропустить». Не главный визуально.

**Семантические запреты в copy:**
- ✗ «ATLAS самостоятельно обучает себя» → ✓ «ATLAS развивается через проверенный исследовательский опыт»
- ✗ «ATLAS знает всю крипту» → ✓ «ATLAS постепенно расширяет обученные области исследования»
- ✗ «каждый Proof автоматически делает ATLAS умнее» → ✓ «полезные проверенные Proof помогают развивать Research Intelligence»

Не упоминать в onboarding: human approval, training batches, Pattern версии, manual curation.

Не добавлять: 4-й экран, видео, аудио, wallet connection, pricing, запрос разрешений, выбор языка, tutorial-задания, награды, XP, геймификацию.

---

## 11. Отложено до после-BETA

**ARI Self-Learning Loop** — механизм, где ARI сам анализирует опыт и предлагает изменения методологии (`ArISelfReview`, `PatternCandidate`, `LearningNeed`, `NextCaseRecommendation`, shadow validation, публичное версионирование `IntelligenceRelease`).

**Что строим сейчас:** `ResearchExperienceRecord` — полная фиксация опыта по каждому Proof (queries, dead ends, evidence paths, freshness, стоимость, время). Это чистая observability, нужна в любом случае.

**Что откладываем:** сам механизм самоанализа. Переход Pattern v1→v2 в BETA остаётся **полностью ручным** — человек формулирует изменения на основе `ResearchExperienceRecord`.

Причина: механизм самоанализа нужно тренировать и тестировать на реальном разнообразном опыте, которого до BETA ещё нет. Спроектированный вслепую, он с высокой вероятностью потребует переделки.

---

## 12. Принятые риски (не защищаемся в v1)

- **Несколько Telegram-аккаунтов ради обхода lifetime DEMO-лимита.** Никакого device fingerprinting или anti-abuse эвристик. Lifetime DEMO привязан к Telegram account identity. Если станет заметной экономической проблемой — решим на данных.

---

## 13. НЕ реализовывать

```
autonomous topic discovery / activation
automatic Topic Pattern generation
self-fine-tuning / self-modifying code
autonomous prompt rewriting
fully autonomous admin correction
graph database
complex multi-agent orchestration
large intelligence dashboards
unrestricted internet exploration
user-selected AI models
Research Mode selector
trading signals / portfolio recommendations / price predictions
public AI training dashboard
social feed / leaderboards / gamification / XP
internal currency / Links / Deep Check
public Proof URLs
```

Оставлять точки расширения там, где полезно. Не активировать их.
