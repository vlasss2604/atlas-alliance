// WHAT THE BOT SAYS. Short, in the user's own ATLAS language, and never a
// research result: the bot is an entry surface. The excerpt is the user's
// own text, bounded, so a reply never grows with the message.
export type ReplyLanguage = "RU" | "EN";

const EXCERPT_CHARS = 160;

export function excerptOf(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > EXCERPT_CHARS ? `${t.slice(0, EXCERPT_CHARS - 1)}…` : t;
}

const EN = {
  signInFirst: "Open ATLAS PROOF and sign in once, then forward the message again.",
  needText: "I need text to work with. Forward a text post, or send the claim as text.",
  hint: "Forward a message with a claim, or send the claim as text, and I will prepare it for Research.",
  received: "Claim received",
  project: "Project",
  saved: "I saved the message. Open ATLAS to review and prepare the Research question.",
  notInBeta: (name: string) => `${name} isn't in the private beta.`,
  verify: "Verify with ATLAS",
  open: "Open in ATLAS",
  // D-171: no dead-end Verify flow. A forward that could not lead to a
  // Research is answered honestly and stored nowhere.
  openAtlas: "Open ATLAS",
  noBetaAccess: "ATLAS PROOF is in private beta. Research needs a private beta invite.",
  betaPaused: "Private beta is temporarily paused. Your previous Research is still available in your Research Library.",
  betaAtCapacity: "Private beta is at capacity for now. Your previous Research is still available in your Research Library.",
  betaExhausted: "You've used all your private-beta Research. Your completed Research remains available in Research Library.",
  betaCovers: "The private beta covers Raydium, Pump.fun and Lido.",
};

const RU: typeof EN = {
  signInFirst: "Откройте ATLAS PROOF и войдите один раз, затем перешлите сообщение снова.",
  needText: "Мне нужен текст. Перешлите текстовый пост или отправьте утверждение текстом.",
  hint: "Перешлите сообщение с утверждением или отправьте его текстом — я подготовлю его к исследованию.",
  received: "Утверждение получено",
  project: "Проект",
  saved: "Сообщение сохранено. Откройте ATLAS, чтобы проверить и подготовить вопрос для исследования.",
  notInBeta: (name: string) => `${name} нет в закрытой бете.`,
  verify: "Проверить в ATLAS",
  open: "Открыть в ATLAS",
  openAtlas: "Открыть ATLAS",
  noBetaAccess: "ATLAS PROOF работает в закрытой бете. Для исследования нужно приглашение.",
  betaPaused: "Закрытая бета временно приостановлена. Ваши прошлые исследования по-прежнему доступны в Библиотеке исследований.",
  betaAtCapacity: "Закрытая бета сейчас заполнена. Ваши прошлые исследования по-прежнему доступны в Библиотеке исследований.",
  betaExhausted: "Вы использовали все исследования закрытой беты. Завершённые исследования остаются в Библиотеке исследований.",
  betaCovers: "Закрытая бета охватывает Raydium, Pump.fun и Lido.",
};

export function repliesFor(language: ReplyLanguage): typeof EN {
  return language === "RU" ? RU : EN;
}
