// The renderer CHILD entrypoint. Runs in its own process, with a scrubbed
// environment and no database configuration.
//
// Contract, deliberately tiny:
//   stdin  <- one JSON render request
//   stdout -> one JSON envelope: { ok: true, document } | { ok: false, reason }
//
// It imports nothing from the ATLAS data layer — no db client, no schema,
// no config. Its entire capability is "render one confirmed URL and
// describe the result". A crash, a timeout, or malformed output is handled
// by the parent as a typed failure; this process never decides anything
// about evidence.
import { createPlaywrightRenderedDocsFetcher } from "./rendered-docs-playwright";
import { RenderedDocsError, type RenderLimits } from "./rendered-docs-fetcher";

export interface ChildRenderRequest {
  url: string;
  confirmedHost: string;
  matchedPathPrefix: string;
  limits: RenderLimits;
  proxyPort: number;
  // OPT-IN passive network observation. Absent means off, so a
  // request that predates this field renders exactly as before.
  observeNetwork?: boolean;
}

export type ChildRenderResponse =
  | { ok: true; document: unknown }
  | { ok: false; reason: string };

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

export async function runChild(): Promise<void> {
  let response: ChildRenderResponse;
  try {
    const request = JSON.parse(await readStdin()) as ChildRenderRequest;
    const fetcher = createPlaywrightRenderedDocsFetcher({
      limits: request.limits,
      proxyPort: request.proxyPort,
      observeNetwork: request.observeNetwork === true,
    });
    const document = await fetcher.render(request.url, {
      confirmedHost: request.confirmedHost,
      matchedPathPrefix: request.matchedPathPrefix,
    });
    response = { ok: true, document };
  } catch (e) {
    // Only a reason code ever crosses the boundary — never page content,
    // never a URL, never a stack.
    response = {
      ok: false,
      reason: e instanceof RenderedDocsError ? e.reason : "RENDER_FAILED",
    };
  }
  process.stdout.write(JSON.stringify(response));
}

// Only runs when executed as a process, never on import.
if (process.argv[1] && process.argv[1].endsWith("rendered-docs-child.ts")) {
  void runChild().then(
    () => process.exit(0),
    () => process.exit(1),
  );
}
