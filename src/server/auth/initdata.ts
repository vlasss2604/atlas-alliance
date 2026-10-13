import { createHmac, timingSafeEqual } from "node:crypto";

// Валидация Telegram Mini App initData (phase-2-plan §2, тест §9.1).
// Спецификация Telegram: data_check_string = отсортированные по ключу пары
// "key=value" всех полей КРОМЕ hash, соединённые "\n"; значения — после
// URL-декодирования. secret_key = HMAC_SHA256(key="WebAppData", msg=bot_token);
// hash = hex(HMAC_SHA256(key=secret_key, msg=data_check_string)).
// Поле signature (схема третьесторонней Ed25519-валидации) в HMAC-проверке
// по bot token не участвует и исключается наравне с hash.

export type InitDataValidation =
  | {
      ok: true;
      telegramUserId: string;
      user: Record<string, unknown>;
      authDate: number;
      raw: Record<string, string>;
    }
  | { ok: false; reason: "INVALID_SIGNATURE" | "STALE" | "FUTURE" | "MALFORMED" };

export interface InitDataOptions {
  botToken: string;
  maxAgeSec: number; // AUTH_MAX_AGE_SEC
  clockSkewSec: number; // AUTH_CLOCK_SKEW_SEC
  now?: () => number; // unix seconds; для тестов
}

export function buildDataCheckString(fields: Record<string, string>): string {
  return Object.keys(fields)
    .filter((k) => k !== "hash" && k !== "signature")
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("\n");
}

export function computeInitDataHash(
  fields: Record<string, string>,
  botToken: string,
): string {
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  return createHmac("sha256", secret)
    .update(buildDataCheckString(fields))
    .digest("hex");
}

export function validateInitData(
  initData: string,
  opts: InitDataOptions,
): InitDataValidation {
  if (!initData) return { ok: false, reason: "MALFORMED" };

  // URLSearchParams декодирует значения; порядок прихода не имеет значения —
  // canonical data_check_string строится сортировкой ключей.
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return { ok: false, reason: "MALFORMED" };
  }
  const fields: Record<string, string> = {};
  for (const [k, v] of params) fields[k] = v;

  const providedHash = fields["hash"];
  if (!providedHash || !/^[0-9a-f]{64}$/.test(providedHash)) {
    return { ok: false, reason: "MALFORMED" };
  }

  const expected = computeInitDataHash(fields, opts.botToken);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(providedHash, "hex");
  // Длины равны (оба — 32 байта из hex-проверки выше); сравнение constant-time.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "INVALID_SIGNATURE" };
  }

  const authDate = Number(fields["auth_date"]);
  if (!Number.isInteger(authDate) || authDate <= 0) {
    return { ok: false, reason: "MALFORMED" };
  }
  const now = (opts.now ?? (() => Math.floor(Date.now() / 1000)))();
  if (now - authDate > opts.maxAgeSec) return { ok: false, reason: "STALE" };
  if (authDate - now > opts.clockSkewSec) return { ok: false, reason: "FUTURE" };

  let user: Record<string, unknown>;
  try {
    user = JSON.parse(fields["user"] ?? "");
  } catch {
    return { ok: false, reason: "MALFORMED" };
  }
  const telegramUserId = user && typeof user === "object" ? String((user as { id?: unknown }).id ?? "") : "";
  if (!telegramUserId || telegramUserId === "undefined") {
    return { ok: false, reason: "MALFORMED" };
  }

  return { ok: true, telegramUserId, user, authDate, raw: fields };
}
