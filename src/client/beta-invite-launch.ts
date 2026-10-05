// THE CREATOR BETA INVITE IN THE MINI APP LAUNCH (D-170).
//
// A creator's link opens the Mini App with the signed Telegram start
// parameter `beta_<token>`. It is only an opaque invite: no user, no claim,
// no campaign data. The D-168 intake launch is a bare uuid, which can never
// start with "beta_", so the two launch kinds never overlap and neither
// parser accepts the other's value. The server decides validity; this is
// shape-checking only.
const BETA_INVITE = /^beta_[A-Za-z0-9_-]{32,48}$/;

export function betaInviteFromStartParam(startParam: string | null | undefined): string | null {
  return startParam && BETA_INVITE.test(startParam) ? startParam : null;
}
