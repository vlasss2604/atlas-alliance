---
name: atlas-core
description: Research methodology of ARI — the five research checks, counterevidence discipline, research stop conditions, reusable economic lessons, and blind validation cases. Use whenever working on the Research Engine, research planning, evidence analysis, verdict derivation, or any code that decides HOW ATLAS researches a digital asset question.
---

# ATLAS CORE — Research Methodology

Эта методология построена вручную на 10 реальных research traces и уже проверена. Не «улучшать» её добавлением новых верхнеуровневых слоёв без реального regression-теста, доказывающего, что текущий фундамент не справляется с материальной ошибкой.

## Происхождение методологии

10 BETA traces (реально пройдены вручную, в этом порядке):

```
HYPE → UNI → CRV → AAVE → LINK → FIL → ETH → HNT → BTC → RENDER
```

Первые проекты меняли и ломали первоначальную методологию. Последние пять (FIL → ETH → HNT → BTC → RENDER) прошли подряд **без появления нового фундаментального research rule** — поэтому discovery/stabilization phase остановлена на 10.

**Это training/regression evidence для методологии, а не таблица готовых ответов по токенам.** Не использовать как lookup table.

---

## ПЯТЬ ОСНОВНЫХ RESEARCH CHECKS

Это внутренние механики. **Не показывать их названия обычному пользователю.**

### CHECK 1 — Actor × Action

Никогда не использовать обобщённого «пользователя», если действующих лиц несколько.

Возможные акторы: end user, payer, integrator, node operator, miner, validator, staker, passive holder, treasury, protocol, network, service provider, token creator/burner, governance participant.

**Вопрос:** кто выполняет действие и что именно этот актор получает / платит / делает?

Предотвращает ложный вывод:
```
node получает reward
→ следовательно passive holder получает revenue
```

### CHECK 2 — Mechanism State Gate

```ts
type MechanismState =
  | "PROPOSED" | "APPROVED" | "IMPLEMENTING"
  | "LIVE" | "DEPRECATED" | "REMOVED" | "UNKNOWN";
```

Не выдавать старое предложение за текущее поведение. Не использовать историческую механику, если система изменилась. Механизм может меняться со временем.

### CHECK 3 — Source of Value

Для каждого потока оплаты/награды/ценности определить источник.

```ts
type ValueSource =
  | "USER_PAYMENT" | "PROTOCOL_ISSUANCE" | "TREASURY"
  | "EXTERNAL_INCENTIVE" | "FEES" | "COLLATERAL_RETURN"
  | "BURN_LINKED_ISSUANCE" | "MARKET_PURCHASE" | "UNKNOWN";
```

```
reward ≠ автоматически revenue
emissions ≠ customer payment
returned principal ≠ reward
```

### CHECK 4 — Token State Qualification

Использовать **только когда это материально**.

```
CRV → veCRV
HNT → veHNT
liquid token → staked/locked/derived rights state
```

Не форсировать этот check на каждый проект. BTC и RENDER показали, что декомпозиция состояния токена может быть **нематериальной**. Хорошее исследование активирует только нужные для claim проверки.

### CHECK 5 — Full Economic Linkage Path

Не выводить заключение из двух конечных точек. Построить реальный путь.

```
user → fee → protocol mechanism → allocation → recipient → final outcome
```
или
```
protocol issuance → reward pool → node operator
```

Предотвращает ложное сокращение:
```
customer платит + node получает токен = customer заплатил node напрямую
```

---

## ВНУТРЕННИЕ RESEARCH HABITS

### Counterevidence Check
Перед финализацией вывода активно проверить противоположную возможность. «Может ли passive holder всё-таки получать fees другим путём?» Если доказательств нет — так и сказать.

### Existence ≠ Strength
Сначала доказать, что механизм существует. Только потом оценивать, насколько он силён/материален. Не превращать «механизм существует» в «механизм имеет большое экономическое влияние» без количественных доказательств.

### Research Stop
Остановиться, когда вопрос отвечен достаточными доказательствами. Не продолжать поиск просто потому, что информации существует больше.

BTC был ключевым валидационным кейсом: простая архитектура → простой достаточный ответ → STOP.

---

## REUSABLE VERIFIED LESSONS

Это **research patterns**, не захардкоженные вердикты по конкретным токенам.

| Правило | Смысл |
|---|---|
| `Abstraction ≠ Removal` | Пользователь может не касаться токена напрямую, при этом токен существует в backend-экономике |
| `Reward ≠ Revenue` | Награда токеном может идти из protocol issuance, а не из выручки от клиентов |
| `Burn ≠ Holder Income` | Уничтоженные токены не распределяются автоматически держателям |
| `Gross Burn ≠ Net Supply Effect` | При наличии issuance/re-emission валовой burn не доказывает чистого сокращения supply |
| `Same Asset ≠ Same Economic Flow` | Один токен может фигурировать в оплате услуг, залоге, эмиссии, наградах, gas и возврате принципала — не сливать потоки из-за одинакового тикера |
| `Return of Principal ≠ Reward` | Возвращённый залог/принципал не является вновь созданным экономическим доходом |
| `System Utility ≠ Passive Holder Capture` | Токен может быть важен для работы сети, не платя при этом passive holders |
| `Usage-Linked Reward ≠ Direct Customer-Payment Transfer` | Награда может быть причинно связана с использованием, но финансироваться через отдельную систему эмиссии |
| `Payment Preparation ≠ Service Consumption` | Один актор может предоплачивать/создавать кредиты, другой — потреблять услугу позже |
| `Absence of Mechanism Is a Valid Finding` | Не форсировать объяснение holder-capture/yield/staking/burn, если такого механизма нет |

---

## RESEARCH PLAN ДОЛЖЕН БЫТЬ ДИНАМИЧЕСКИМ

Не создавать один фиксированный чек-лист, который каждый запрос обязан выполнить целиком.

```ts
interface ResearchPlan {
  intent: ResearchIntent;
  topic: string;
  entities: string[];
  checks: {
    actorAction: boolean;
    mechanismState: boolean;
    sourceOfValue: boolean;
    tokenState: boolean;
    fullEconomicPath: boolean;
    counterevidence: boolean;
  };
  existingMemoryUsed: string[];
  factsToRefresh: string[];
  missingEvidence: string[];
  stopConditions: string[];
}
```

Пример — вопрос о passive holder для BTC:
```ts
{ actorAction: true, mechanismState: true, sourceOfValue: true,
  tokenState: false, fullEconomicPath: true, counterevidence: true }
```
`tokenState` не активируется просто потому, что движок это умеет.

---

## RESEARCH STOP CONDITIONS

```ts
type StopReason =
  | "QUESTION_ANSWERED"
  | "NO_MECHANISM_FOUND"
  | "SUFFICIENT_PRIMARY_EVIDENCE"
  | "CLAIM_CATEGORY_ERROR"
  | "INSUFFICIENT_CONTEXT"
  | "OUTSIDE_SCOPE"
  | "UNRESOLVED_GAP_REQUIRES_TARGETED_FOLLOWUP";
```

Не переисследовать. Если остаётся один материальный gap — предложить targeted follow-up по этому gap, **не** перезапускать весь Proof.

---

## BLIND VALIDATION REGRESSION TESTS

Эти вопросы должны работать **без подсказки движку, какие checks запускать**. После реализации становятся обязательными regression/acceptance тестами.

### TAO / Bittensor
> «Bittensor раздаёт TAO майнерам и валидаторам за работу в сети. Получают ли обычные владельцы TAO какую-то часть ценности, которую создаёт Bittensor, и зачем вообще нужен TAO?»

Движок должен самостоятельно обнаружить: различия участников; passive holder vs active/staked; текущую механику токена/subnet; issuance vs реальное usage/revenue; прямую vs косвенную экономическую связь.

### SUI / Sui
> «Я постоянно вижу тезис, что чем больше используют Sui, тем больше SUI навсегда выбывает из обращения из-за storage fees. Это правда?»

Должен обнаружить: механику storage fee; refundable vs non-refundable компоненты; lock vs permanent removal; состояние объектов; текущую документацию; сильное утверждение vs фактический механизм.

### TIA / Celestia
> «Представим, что завтра объём использования Celestia вырастет в 10 раз. Что конкретно от этого изменится для человека, который просто держит TIA?»

Должен обнаружить: usage → fees; получателя fees; passive holder vs staker; protocol issuance vs user-paid fees; причинные границы; невозможность вывести 10× holder value из 10× usage; research stop до спекуляции об оценке.

---

## ROBUSTNESS TESTS

| Вопрос | Ожидаемый route | Что объяснить |
|---|---|---|
| «Если у токена есть staking, значит проект безопасный?» | `QUICK_EXPLANATION` | staking existence ≠ project safety |
| «Почему Bitcoin не платит мне доход, если я держу BTC два года?» | `QUICK_EXPLANATION` | у passive holding нет protocol entitlement на miner fees/rewards; не выдумывать staking/yield |
| «Solana быстрее Ethereum, значит SOL должен стоить дороже ETH?» | `QUICK_EXPLANATION` | technical performance ≠ token valuation; не запускать valuation research без явного запроса |
| «Что будет с TAO, если завтра исчезнет интернет на Луне?» | `NO_RESEARCH_NEEDED` | нет установленной релевантной связи; коротко ответить и остановиться |

Ни один из этих вопросов **не должен** запускать дорогой research pipeline.

---

## ЗАПРЕТ НА ЗАХАРДКОЖЕННЫЕ ОТВЕТЫ

Плохо:
```ts
if (token === "BTC") return "holders get no yield";
```

Правильно:
```
identify actor → identify current mechanism → identify source
→ build path → determine holder outcome
```

---

## ACCEPTANCE CRITERIA

- **Retrieval-first** — при наличии релевантной verified memory она используется до fresh research
- **No full rerun** — исследуются только отсутствующие/устаревшие факты
- **Dynamic checks** — нерелевантные проверки пропускаются
- **Current-state protection** — старые предложения/deprecated механизмы не выдаются за текущие
- **Source separation** — fees, issuance, treasury, emissions, collateral returns не сливаются
- **Passive-holder protection** — system/token utility не конвертируется автоматически в доход держателя
- **Robustness** — category errors и абсурдные вопросы не запускают дорогой research
- **Clarification** — отсутствующий материальный контекст запрашивается, а не додумывается
- **Research stop** — движок останавливается, когда реальный вопрос пользователя отвечен
- **Verified learning** — только verified/approved Proof обновляют durable Research Memory
