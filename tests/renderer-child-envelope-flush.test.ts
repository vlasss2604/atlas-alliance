import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

// RENDERER CHILD ENVELOPE FLUSH — a real child, a real pipe, no browser.
//
// The renderer child used to end with
//   process.stdout.write(JSON.stringify(response)); process.exit(0);
// On the current Node runtime that is not flush-safe when stdout is a
// pipe: past roughly 64 KB the envelope is cut off at exit. A small
// failure envelope always fit, so the parent saw faithful failures and
// CHILD_OUTPUT_MALFORMED for every large page the browser rendered
// correctly. This suite spawns the production emission code through a
// fixture harness and judges it the way the parent does: by the bytes
// that arrive and the exit code.

const HARNESS = path.join("tests", "fixtures", "renderer-child-emit-harness.ts");
const TSX_CLI = path.join("node_modules", "tsx", "dist", "cli.mjs");

// Far above the pipe buffer. Sized so the OLD pattern fails every time,
// not just usually: at 300 KB a fast parent occasionally drained the pipe
// before the child's exit dropped the rest, so the regression was
// timing-dependent; at 2 MB it never did (1 MB was measured arriving as
// 146,176 bytes). Still well under the parent's own 8 MB stdout bound.
const LARGE = 2_000_000;
const SMALL = 1_000;

async function runHarness(mode: "ok" | "fail", textLength: number): Promise<{ stdout: string; code: number | null }> {
  const child = spawn(process.execPath, [TSX_CLI, HARNESS, mode, String(textLength)], {
    cwd: process.cwd(),
    // Same pipe shape the isolated supervisor uses; stderr ignored likewise.
    stdio: ["pipe", "pipe", "ignore"],
    shell: false,
  });
  let stdout = "";
  child.stdout.on("data", (c: Buffer) => {
    stdout += c.toString("utf-8");
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (c) => resolve(c));
  });
  return { stdout, code };
}

function expectedText(n: number): string {
  return Array.from({ length: n }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
}

describe("renderer child envelope flush", () => {
  it("a small success envelope arrives complete with exit 0", async () => {
    const { stdout, code } = await runHarness("ok", SMALL);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as { ok: boolean; document: { normalizedText: string } };
    expect(parsed.ok).toBe(true);
    expect(parsed.document.normalizedText).toBe(expectedText(SMALL));
  });

  it("a >200 KB success envelope arrives complete — no truncation, exit 0", async () => {
    const { stdout, code } = await runHarness("ok", LARGE);
    expect(code).toBe(0);
    // Judged first by bytes: the failure mode was a cut-off payload.
    expect(stdout.length).toBeGreaterThan(LARGE);
    const parsed = JSON.parse(stdout) as {
      ok: boolean;
      document: { renderMode: string; finalUrl: string; normalizedText: string; contentHash: string; byteLength: number };
    };
    expect(parsed.ok).toBe(true);
    // Every field the parent's parseChildDocument shape-checks is present
    // and the body is byte-for-byte what the child produced.
    expect(parsed.document.renderMode).toBe("RENDERED");
    expect(typeof parsed.document.finalUrl).toBe("string");
    expect(typeof parsed.document.contentHash).toBe("string");
    expect(parsed.document.byteLength).toBe(LARGE);
    expect(parsed.document.normalizedText.length).toBe(LARGE);
    expect(parsed.document.normalizedText).toBe(expectedText(LARGE));
  });

  it("a large failure envelope also flushes completely, with the same exit code", async () => {
    const { stdout, code } = await runHarness("fail", LARGE);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as { ok: boolean; reason: string; inspection: { pad: string } };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe("FINAL_URL_OUTSIDE_ROUTE");
    expect(parsed.inspection.pad.length).toBe(LARGE);
  });

  it("a small failure envelope still works", async () => {
    const { stdout, code } = await runHarness("fail", SMALL);
    expect(code).toBe(0);
    expect((JSON.parse(stdout) as { ok: boolean }).ok).toBe(false);
  });

  it("the child never exits with an unflushed write: every exit follows the write callback", async () => {
    const raw = await fs.readFile(
      new URL("../src/server/engine/providers/rendered-docs-child.ts", import.meta.url),
      "utf-8",
    );
    // The ONLY stdout write is the one inside emitEnvelopeAndExit, and it
    // hands the exit to its completion callback.
    // Comment lines are excluded: the file documents the old, broken
    // pattern in prose, and prose is not a write.
    const code = raw
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    const writes = code.match(/process\.stdout\.write\(/g) ?? [];
    expect(writes).toHaveLength(1);
    expect(code).toContain("process.stdout.write(JSON.stringify(response), () => process.exit(exitCode))");
    // No bare "write then exit" sequence survives anywhere in the file.
    expect(code).not.toMatch(/process\.stdout\.write\([^\n]*\);\s*\n\s*(return;\s*\n\s*)?process\.exit/);
    // The entrypoint no longer schedules exit 0 itself — success exits
    // only through the flushed write; a rejection (no envelope) exits 1.
    expect(code).toContain("void runChild().catch(() => process.exit(1));");
    expect(code).not.toContain("() => process.exit(0),");
  });
});
