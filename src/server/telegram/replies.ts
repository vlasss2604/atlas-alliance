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
  notInBeta: (name: string) => `${name} is not currently available in the private beta.`,
  verify: "Verify with ATLAS",
  open: "Open in ATLAS",
};

const RU: typeof EN = {
  signInFirst: "Откройте ATLAS PROOF и войдите один раз, затем перешлите сообщение снова.",
  needText: "Мне нужен текст. Перешлите текстовый пост или отправьте утверждение текстом.",
  hint: "Перешлите сообщение с утверждением или отправьте его текстом — я подготовлю его к исследованию.",
  received: "Утверждение получено",
  project: "Проект",
  saved: "Сообщение сохранено. Откройте ATLAS, чтобы проверить и подготовить вопрос для исследования.",
  notInBeta: (name: string) => `${name} пока недоступен в закрытой бете.`,
  verify: "Проверить в ATLAS",
  open: "Открыть в ATLAS",
};

export function repliesFor(language: ReplyLanguage): typeof EN {
  return language === "RU" ? RU : EN;
}
