"use client";

import { useState } from "react";

import { PROOF_STATE, type EntityRef } from "./types";

// 8. ENTITIES — AN ADDRESS IS A FIRST-CLASS OBJECT, NOT A WORD IN A SENTENCE.
//
// An address buried mid-paragraph cannot be checked, cannot be copied
// without selecting around punctuation, and reads as decoration. Here it is
// the largest thing in its row, set in mono, on its own line, in a frame a
// reader can aim at.
//
// THE ROLE IS A CLAIM, AND CARRIES ITS OWN STATE. "This is the treasury" is
// exactly the sort of economic label the engine refuses to infer from a
// transfer, so the role a wallet plays is graded like anything else — an
// address can be certain while what it DOES is not.
export function EntityListBlock({ entities }: { entities: EntityRef[] }) {
  return (
    <section className="panel px-4 py-4 sm:px-5" data-testid="block-entities">
      <p className="eyebrow" style={{ color: "var(--atlas-text-dim)" }}>
        Addresses and roles
      </p>
      <p className="mt-1 text-[0.75rem] leading-snug text-[var(--atlas-text-dim)]">
        The address is what the chain shows. The role beside it is a separate claim.
      </p>

      <div className="mt-3 grid grid-cols-1 gap-2 lg:grid-cols-2">
        {entities.map((e) => (
          <EntityRow key={e.address} entity={e} />
        ))}
      </div>
    </section>
  );
}

function EntityRow({ entity }: { entity: EntityRef }) {
  const [copied, setCopied] = useState(false);
  const s = PROOF_STATE[entity.state];

  // Clipboard access can be refused or absent; a failure must leave the
  // address on screen and readable rather than throwing into the page.
  const copy = () => {
    void navigator.clipboard
      ?.writeText(entity.address)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      })
      .catch(() => {});
  };

  return (
    <div
      className="rounded-lg border border-[var(--hairline)] px-3 py-2.5"
      style={{ background: "var(--surface-1)" }}
      data-testid="entity-row"
      data-state={entity.state}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <p className="text-[0.78rem] font-semibold leading-tight">{entity.role}</p>
        <span
          className="text-[0.58rem] font-semibold uppercase tracking-[0.05em]"
          style={{ color: s.color }}
        >
          {s.label}
        </span>
        <span className="ml-auto text-[0.62rem] uppercase tracking-[0.05em] text-[var(--atlas-text-dim)]">
          {entity.chain}
        </span>
      </div>

      {/* THE ADDRESS, GIVEN ITS OWN LINE AND ITS OWN FRAME.
          `break-all` rather than a truncation: a clipped address is a
          different address, and on a phone truncation is where a reader
          loses the ability to verify anything. */}
      <div className="mt-2 flex items-center gap-2">
        <code
          className="min-w-0 flex-1 break-all rounded border border-[var(--hairline)] bg-[rgba(4,7,13,0.55)] px-2 py-1.5 font-mono text-[0.76rem] leading-snug text-[var(--atlas-text)]"
          data-testid="entity-address"
        >
          {entity.address}
        </code>
        <button
          type="button"
          onClick={copy}
          className="shrink-0 rounded border border-[var(--hairline)] px-2 py-1.5 text-[0.62rem] uppercase tracking-[0.05em] text-[var(--atlas-text-dim)] transition-colors hover:text-[var(--atlas-text)]"
          data-testid="entity-copy"
          aria-label={`Copy ${entity.role} address`}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      {entity.evidenceRef && (
        <p className="mt-1.5 text-[0.66rem] text-[var(--atlas-text-dim)]">{entity.evidenceRef}</p>
      )}
    </div>
  );
}
