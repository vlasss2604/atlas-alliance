import { expect, test } from "@playwright/test";

// THE EVIDENCE INTERACTIONS, CLICKED. The design fixture at
// /dev/result-states renders the same ResearchResult the product page
// uses, from constants, with no research and no database read, so these
// clicks are deterministic. Snapshot is deliberately absent there (no
// route can serve a fixture's job) and is covered on a real result by
// tests/ui-source-snapshot.test.ts.

test("Evidence · N opens the proof beneath that finding, View excerpt reveals the source's words, Open original targets a new tab", async ({ page }) => {
  await page.goto("/dev/result-states?state=8");
  await expect(page.getByTestId("research-table")).toBeVisible();

  const toggle = page.getByTestId("row-evidence-toggle").first();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("row-evidence")).toHaveCount(0);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(toggle).toHaveText(/Hide evidence/);
  const block = page.getByTestId("row-evidence").first();
  await expect(block).toBeVisible();
  await expect(block).toContainText("Evidence behind this answer");
  await expect(block.getByTestId("evidence-card").first()).toBeVisible();

  // The excerpt inside the opened block is open on arrival; the control hides it.
  const excerpt = block.getByTestId("evidence-details-toggle").first();
  await expect(block.getByTestId("evidence-excerpt").first()).toBeVisible();
  await excerpt.click();
  await expect(block.getByTestId("evidence-excerpt")).toHaveCount(0);
  await excerpt.click();
  await expect(block.getByTestId("evidence-excerpt").first()).toBeVisible();

  // Sources section: closed excerpt opens on tap.
  const sourceToggle = page.getByTestId("sources").getByTestId("evidence-details-toggle").first();
  await sourceToggle.click();
  await expect(page.getByTestId("sources").getByTestId("evidence-excerpt").first()).toBeVisible();

  // Open original: an http(s) href in a new tab; never a dead control.
  const original = page.getByTestId("evidence-open-original").first();
  await expect(original).toHaveAttribute("href", /^https?:\/\//);
  await expect(original).toHaveAttribute("target", "_blank");

  // A fixture offers no Snapshot.
  await expect(page.getByTestId("evidence-snapshot")).toHaveCount(0);

  // Collapse.
  await toggle.click();
  await expect(page.getByTestId("row-evidence")).toHaveCount(0);
});
