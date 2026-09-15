// CHILD PROCESS FOR THE RENDERER ENVELOPE FLUSH REGRESSION.
//
// Runs in its OWN process on purpose: the defect under test is what a
// PARENT receives on a stdout pipe when the child exits, and that is not
// observable from inside the child. An in-process test of
// emitEnvelopeAndExit would exercise a mocked stream, not the pipe.
//
// It calls the real emission function from the real child module — the
// production code that puts an envelope on the wire — with a SYNTHETIC
// response whose size and shape are chosen by the parent. No browser is
// launched, nothing is fetched, no request is read: importing the child
// module does not run it (its entrypoint guard checks argv[1]).
//
// argv: <ok|fail> <textLength>
//   ok    -> { ok: true, document: { ...shape the parent validates... } }
//   fail  -> { ok: false, reason, inspection: { pad } }   (exit code 0, as
//            the real child does for a classified render failure)
import { emitEnvelopeAndExit } from "../../src/server/engine/providers/rendered-docs-child";

const mode = process.argv[2];
const textLength = Number(process.argv[3]);
if ((mode !== "ok" && mode !== "fail") || !Number.isInteger(textLength) || textLength < 0) {
  process.exit(2);
}

// A deterministic, non-repeating body: a truncation that happened to cut
// on a chunk boundary of a repeated character would still be detectable
// by length, but a content check is stronger and costs nothing.
const text = Array.from({ length: textLength }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");

if (mode === "ok") {
  emitEnvelopeAndExit(
    {
      ok: true,
      document: {
        renderMode: "RENDERED",
        finalUrl: "https://docs.example-project.test/docs/fees",
        normalizedText: text,
        contentHash: "synthetic",
        byteLength: text.length,
        fetchedAt: new Date(0).toISOString(),
      },
    },
    0,
  );
} else {
  emitEnvelopeAndExit(
    {
      ok: false,
      reason: "FINAL_URL_OUTSIDE_ROUTE",
      inspection: { pad: text },
    },
    0,
  );
}
