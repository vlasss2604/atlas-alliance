// PULSE → VERIFY HANDOFF — ONE LOCAL ID, NOTHING ELSE (D-172).
//
// A Pulse card's Verify button opens the existing Verify screen (Home) as
// `/home?pulse=<id>`. Only the fixture's id travels; never the text, never
// a handle. The screen looks the id up locally, drops the text into the
// same editable input a typed question uses, and shows where it came from.
// Nothing is created, spent or called by opening it — the same rule the
// Telegram intake launch follows (`intake-launch.ts`), without its server
// row: a Pulse item is already inside the app.
const PULSE_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;

export function pulseIdOf(value: string | null | undefined): string | null {
  return value && PULSE_ID.test(value) ? value : null;
}

// From the page's query string (`?pulse=…`).
export function pulseIdFromSearch(search: string): string | null {
  try {
    return pulseIdOf(new URLSearchParams(search).get("pulse"));
  } catch {
    return null;
  }
}

export function verifyPathForPulse(id: string): string {
  return `/home?pulse=${id}`;
}
