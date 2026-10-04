// THE MINI APP LAUNCH CONTEXT — ONE OPAQUE ID, NOTHING ELSE.
//
// A forwarded claim reaches the app as `?intake=<uuid>` on /ask (the bot's
// button URL) or as the signed Telegram start parameter (a deep link). In
// both forms the value is only an id: no text, no project, no claim ever
// travels in a URL. The id is useless without the owner's session — the
// server decides existence, ownership and expiry — so parsing here is
// shape-checking, never trust.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function intakeIdOf(value: string | null | undefined): string | null {
  return value && UUID.test(value) ? value.toLowerCase() : null;
}

// From the page's query string (`?intake=…`).
export function intakeIdFromSearch(search: string): string | null {
  try {
    return intakeIdOf(new URLSearchParams(search).get("intake"));
  } catch {
    return null;
  }
}

// From the Telegram start parameter: the bare intake id.
export function intakeIdFromStartParam(startParam: string | null | undefined): string | null {
  return intakeIdOf(startParam);
}

export function askPathForIntake(intakeId: string): string {
  return `/ask?intake=${intakeId}`;
}

// A launch that arrived before onboarding finished is kept in memory (never
// storage) for the moment onboarding completes, then taken exactly once.
let pending: string | null = null;
export function rememberLaunchIntake(id: string): void {
  pending = id;
}
export function takeLaunchIntake(): string | null {
  const id = pending;
  pending = null;
  return id;
}
