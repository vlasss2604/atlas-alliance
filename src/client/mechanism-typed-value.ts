// PRESENTATION MUST NOT CREATE NEW TRUTH. PAGE <= PERSISTED VERIFIED RECORD.
//
// RECIPIENT and DESTINATION ask for a SPECIFIC answer: who receives the
// value, where it goes. A stored component status of SUPPORTED says only that
// admissible evidence was filed under the component; the specific answer is a
// separate, persisted fact — the typed recipientKind / destinationKind the
// mechanism assembly wrote on a flow that carries the component. Wave 1A
// showed "Who ultimately receives it? — Confirmed" over fee-allocation
// sentences while every stored flow read recipientKind UNKNOWN.
//
// So a reader-facing surface may present either component as established
// only when a stored flow carries a typed value for it. This module READS
// that value and nothing else: it never classifies text, never reinterprets
// a passage, and never recovers a kind the record does not hold. An absent
// record, a component on no flow, UNKNOWN and NONE are all "no typed value".

// The flow attribute that answers each component.
const TYPED_VALUE_ATTRIBUTE: Readonly<Record<string, "recipientKind" | "destinationKind">> = {
  RECIPIENT: "recipientKind",
  DESTINATION: "destinationKind",
};

// Values that name nothing specific.
const NO_SPECIFIC_VALUE: ReadonlySet<string> = new Set(["UNKNOWN", "NONE"]);

export const TYPED_VALUE_ABSENT_LIMIT: Readonly<Record<string, string>> = {
  RECIPIENT: "Sources were read on this point, but the record does not identify a specific recipient.",
  DESTINATION: "Sources were read on this point, but the record does not establish a specific destination.",
};

export function requiresTypedValue(component: string): boolean {
  return component in TYPED_VALUE_ATTRIBUTE;
}

export interface TypedMechanismValue {
  // The persisted kind, verbatim.
  kind: string;
  // The evidence rows the flow carrying it rests on for this component.
  evidenceIds: string[];
}

// The typed value of the FIRST stored flow (stored order) that carries the
// component on its lineage with a specific kind, or null.
export function typedMechanismValueOf(
  flows: readonly unknown[] | null | undefined,
  component: string,
): TypedMechanismValue | null {
  const attribute = TYPED_VALUE_ATTRIBUTE[component];
  if (attribute === undefined) return null;
  for (const f of flows ?? []) {
    const flow = f as { lineage?: unknown; attributes?: unknown } | null;
    const lineage = Array.isArray(flow?.lineage) ? (flow.lineage as { component?: unknown; evidenceIds?: unknown }[]) : [];
    const step = lineage.find((s) => s?.component === component);
    if (!step) continue;
    const kind = (flow?.attributes as Record<string, unknown> | null | undefined)?.[attribute];
    if (typeof kind !== "string" || NO_SPECIFIC_VALUE.has(kind)) continue;
    const evidenceIds = Array.isArray(step.evidenceIds) ? step.evidenceIds.filter((id): id is string => typeof id === "string") : [];
    return { kind, evidenceIds };
  }
  return null;
}

// True when a component that needs a typed value is stored as (partly)
// established and no stored flow carries one.
export function typedValueAbsent(
  component: string,
  persistedStatus: string,
  flows: readonly unknown[] | null | undefined,
): boolean {
  if (!requiresTypedValue(component)) return false;
  if (persistedStatus !== "SUPPORTED" && persistedStatus !== "PARTIALLY_SUPPORTED") return false;
  return typedMechanismValueOf(flows, component) === null;
}
