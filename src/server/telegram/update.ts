import { z } from "zod";

// THE TELEGRAM UPDATE, REDUCED TO WHAT V1 READS.
//
// This is the only place the shape of a Bot API update is spelled out, and
// it spells out as little as possible: a private-chat message with text or
// a caption, the sender's id, and the forward origin where Telegram offers
// one. Everything else passes through unread and is never stored.
//
// Field names follow the Bot API as this repository understands it
// (`message.text`, `message.caption`, `message.forward_origin` with
// `type` in channel / user / hidden_user / chat). There is no Telegram
// typing in the dependency tree, so this understanding is pinned by the
// tests and must be checked against the published Bot API before the
// webhook is registered — see the runbook.
const chatSchema = z
  .object({
    id: z.number(),
    type: z.string(),
    title: z.string().optional(),
    username: z.string().optional(),
  })
  .passthrough();

const forwardOriginSchema = z
  .object({
    type: z.string(),
    chat: chatSchema.optional(),
    sender_chat: chatSchema.optional(),
    sender_user_name: z.string().optional(),
    message_id: z.number().optional(),
  })
  .passthrough();

const messageSchema = z
  .object({
    message_id: z.number(),
    chat: chatSchema,
    from: z.object({ id: z.number(), is_bot: z.boolean().optional() }).passthrough().optional(),
    text: z.string().optional(),
    caption: z.string().optional(),
    forward_origin: forwardOriginSchema.optional(),
  })
  .passthrough();

const updateSchema = z
  .object({
    update_id: z.number(),
    message: messageSchema.optional(),
  })
  .passthrough();

export interface ForwardSource {
  // A short, bounded label for presentation: a channel title or @username,
  // or just the kind of origin. Never a person's name.
  label: string;
  // A public link, only when the origin is a channel with a public username
  // — the one case where a t.me link is both derivable and safe to show.
  url: string | null;
}

export type ParsedUpdate =
  | {
      kind: "MESSAGE";
      updateId: number;
      chatId: number;
      senderId: string;
      // text or caption, untrimmed; the service bounds it.
      text: string;
      isCommand: boolean;
      source: ForwardSource | null;
    }
  | { kind: "NO_TEXT"; updateId: number; chatId: number; senderId: string }
  | { kind: "IGNORED"; reason: "NOT_A_MESSAGE" | "NOT_PRIVATE_CHAT" | "NO_SENDER" | "FROM_BOT" }
  | { kind: "MALFORMED" };

const PUBLIC_USERNAME = /^[A-Za-z0-9_]{5,32}$/;

function sourceOf(origin: z.infer<typeof forwardOriginSchema> | undefined): ForwardSource | null {
  if (!origin) return null;
  switch (origin.type) {
    case "channel": {
      const chat = origin.chat;
      const username = chat?.username && PUBLIC_USERNAME.test(chat.username) ? chat.username : null;
      const label = chat?.title?.trim() || (username ? `@${username}` : "Telegram channel");
      const url =
        username && typeof origin.message_id === "number" && origin.message_id > 0
          ? `https://t.me/${username}/${origin.message_id}`
          : null;
      return { label, url };
    }
    case "chat": {
      // A group or supergroup: its title is a public-enough label; a link
      // is not derived (membership-gated), and no id is kept.
      const label = origin.sender_chat?.title?.trim() || "Telegram group";
      return { label, url: null };
    }
    case "user":
    case "hidden_user":
      // A person. Their name is not ours to store or show.
      return { label: "Telegram user", url: null };
    default:
      return { label: "Telegram", url: null };
  }
}

export function parseTelegramUpdate(raw: unknown): ParsedUpdate {
  const parsed = updateSchema.safeParse(raw);
  if (!parsed.success) return { kind: "MALFORMED" };
  const update = parsed.data;
  const message = update.message;
  if (!message) return { kind: "IGNORED", reason: "NOT_A_MESSAGE" };
  if (message.chat.type !== "private") return { kind: "IGNORED", reason: "NOT_PRIVATE_CHAT" };
  if (!message.from) return { kind: "IGNORED", reason: "NO_SENDER" };
  if (message.from.is_bot) return { kind: "IGNORED", reason: "FROM_BOT" };
  const senderId = String(message.from.id);
  const text = message.text ?? message.caption ?? "";
  if (!text.trim()) return { kind: "NO_TEXT", updateId: update.update_id, chatId: message.chat.id, senderId };
  return {
    kind: "MESSAGE",
    updateId: update.update_id,
    chatId: message.chat.id,
    senderId,
    text,
    isCommand: text.trimStart().startsWith("/"),
    source: sourceOf(message.forward_origin),
  };
}
