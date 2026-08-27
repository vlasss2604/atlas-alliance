// CAN THIS MACHINE START THE LOCKED-DOWN BROWSER? — owner tooling.
//
// Offline, unauthenticated, and safe to run at any time. It navigates
// nowhere: the child receives no url, no confirmed host and no path
// prefix, and the only page it opens is `about:blank`. No document is
// produced, no Evidence is written, nothing touches the database.
//
// WHY IT EXISTS. An owner-authorized live window was spent discovering
// that the browser would not start. The static fetch reached pump.fun, was
// refused with 403, correctly opened the render fallback — and then died
// at a browser that never launched. That window bought one bit of
// information. This script gives the same bit away in a few seconds,
// before a window is opened rather than after it is gone.
//
// PRODUCTION-EQUIVALENT BY CONSTRUCTION: the same egress proxy, the same
// scrubbed environment, the same argv-only spawn, the same child script,
// and the same launch call with the same lockdown and proxy arguments. If
// this passes, the renderer is not the reason the next render fails.
//
// Run: npx tsx scripts/renderer-selftest.ts
import { runIsolatedRendererSelfTest } from "../src/server/engine/providers/rendered-docs-isolated";

async function main(): Promise<void> {
  console.log("--- isolated renderer self-test ---");
  console.log("navigates nowhere; opens about:blank in the locked-down browser\n");

  const result = await runIsolatedRendererSelfTest();

  console.log("ok:               " + result.ok);
  console.log("durationMs:       " + result.durationMs);
  console.log("browserVersion:   " + (result.browserVersion ?? "(none)"));
  console.log("reason:           " + (result.reason ?? "(none)"));
  console.log("diagnostic:       " + (result.diagnostic ?? "(none)"));
  // Counts only, from the proxy's own log. A denial during a self-test —
  // which navigates nowhere but about:blank — would point at the boundary
  // itself rather than at any site.
  const p = result.proxyDenials;
  console.log(
    "proxyDenials:     " +
      (p === null ? "(none recorded)" : `${p.deniedCount} denied, ${p.allowedCount} allowed`),
  );
  if (p !== null && p.deniedCount > 0) {
    for (const [reason, count] of Object.entries(p.denials)) {
      if (count > 0) console.log("  " + reason.padEnd(20) + count);
    }
  }

  if (result.ok) {
    console.log("\nThe renderer can start on this machine.");
    console.log("A render failing after this is about the route or the page, not the browser.");
    process.exit(0);
  }

  console.log("\nThe renderer CANNOT start on this machine.");
  // Only the code-owned classification is shown. The underlying launch
  // error carries an absolute filesystem path and often Chromium's entire
  // command line, and is deliberately never printed.
  switch (result.diagnostic) {
    case "EXECUTABLE_NOT_FOUND":
      console.log("The browser binary is absent or is not the revision this Playwright expects.");
      console.log("Reinstalling the browsers for the installed Playwright is the fix.");
      break;
    case "PROCESS_START_FAILED":
      console.log("The OS refused to start the browser process at all.");
      console.log("A corrupt binary or a security product blocking it both look like this.");
      break;
    case "PROCESS_EXITED_DURING_LAUNCH":
      console.log("The browser started and died before it could be spoken to.");
      break;
    case "UNKNOWN_BROWSER_LAUNCH_FAILURE":
      console.log("The launch failed in a way this build does not classify.");
      break;
    default:
      console.log("The failure was before the browser: see `reason` above.");
  }
  console.log("\nDo not spend a live window until this passes.");
  process.exit(1);
}

main().catch((e: unknown) => {
  console.error("[selftest] unexpected failure: " + (e instanceof Error ? e.name : "unknown"));
  process.exit(1);
});
