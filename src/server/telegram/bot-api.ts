import { getEnv } from "../auth/guards";

// THE ONE OUTBOUND CALL THE BOT MAKES: sendMessage.
//
// A fixed-host client for api.telegram.org and nothing else — never the
// research fetcher, never a general HTTP helper, so SSRF protection and the
// research transport are untouched. The bot token travels only in the URL
// path of this request and is never logged; a failure is reported as a
// code, never as the response body.
//
// Transport is injectable so tests can prove what would be sent without a
// request ever leaving the process.
export const TELEGRAM_API_BASE = "https://api.telegram.org";

export interface InlineButton {
  text: string;
  // Opens the Mini App at this URL (Telegram `web_app` button).
  webAppUrl: string;
}

export interface OutboundMessage {
  chatId: number;
  text: string;
  buttons?: InlineButton[];
}

export type TelegramTransport = (url: string, body: string) => Promise<{ ok: boolean; status: number }>;

let _transport: TelegramTransport | null = null;

export function __setTelegramTransport(t: TelegramTransport | null): void {
  _transport = t;
}

const defaultTransport: TelegramTransport = async (url, body) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  return { ok: res.ok, status: res.status };
};

export function buildSendMessagePayload(message: OutboundMessage): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    chat_id: message.chatId,
    text: message.text,
    disable_web_page_preview: true,
  };
  if (message.buttons && message.buttons.length > 0) {
    payload.reply_markup = {
      inline_keyboard: [message.buttons.map((b) => ({ text: b.text, web_app: { url: b.webAppUrl } }))],
    };
  }
  return payload;
}

export type SendResult = { sent: true } | { sent: false; reason: "TRANSPORT_FAILED" | "TELEGRAM_REFUSED" | "NOT_CONFIGURED" };

export async function sendTelegramMessage(message: OutboundMessage): Promise<SendResult> {
  let token: string;
  try {
    token = getEnv("BOT_TOKEN");
  } catch {
    return { sent: false, reason: "NOT_CONFIGURED" };
  }
  const url = `${TELEGRAM_API_BASE}/bot${token}/sendMessage`;
  const body = JSON.stringify(buildSendMessagePayload(message));
  try {
    const res = await (_transport ?? defaultTransport)(url, body);
    return res.ok ? { sent: true } : { sent: false, reason: "TELEGRAM_REFUSED" };
  } catch {
    return { sent: false, reason: "TRANSPORT_FAILED" };
  }
}
