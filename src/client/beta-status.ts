import type { MeResponse } from "./api";

// WHY A PRIVATE-BETA USER CANNOT START A NEW RESEARCH RIGHT NOW (D-171).
//
// Read from the server's own state on /api/me — never recomputed here. When
// this is non-null the screens stop offering a new Research and point to
// the Research Library instead, which every one of these states leaves open:
//
//   PAUSED     the beta is operationally paused (emergency stop)
//   CAPACITY   the creator beta is full for everyone
//   EXHAUSTED  this user's own allowance is used up
//
// The server stays the authority: a start attempted anyway is refused there
// with the same reason.
export type BetaBlock = "PAUSED" | "CAPACITY" | "EXHAUSTED";

export function betaBlockOf(me: Pick<MeResponse, "privateBeta" | "betaPaused"> | null): BetaBlock | null {
  if (!me) return null;
  if (me.betaPaused) return "PAUSED";
  if (!me.privateBeta) return null;
  if (me.privateBeta.capacityReached) return "CAPACITY";
  if (me.privateBeta.remaining <= 0) return "EXHAUSTED";
  return null;
}
