// THE EVIDENCE-NETWORK FIELD — the logo's atmosphere behind every screen.
//
// What the AP logo has behind the mark: a near-black ground, a soft cyan
// illumination, and a faint constellation of nodes joined by thin lines.
// This draws a restrained echo of that: one radial light at the top, a
// vignette, and one static SVG of ~40 nodes and their nearest-neighbour
// links at very low opacity, masked so it fades out before the reading
// column's first result. Fixed, non-interactive, no filter, no animation
// — a single paint. Content readability is never in competition with it.
//
// The constellation is deterministic (a seeded generator), so server and
// client render the same markup and the page never re-shuffles.

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

const rand = seeded(20260907);
const NODES = Array.from({ length: 42 }, () => ({
  x: Math.round(rand() * 1000),
  y: Math.round(rand() * 600),
  r: 1 + Math.round(rand() * 1.6 * 10) / 10,
}));
const LINKS: [number, number][] = [];
for (let i = 0; i < NODES.length; i++) {
  // Each node links to its two nearest neighbours; duplicates are dropped.
  const d = NODES.map((n, j) => ({ j, d: j === i ? Infinity : Math.hypot(n.x - NODES[i].x, n.y - NODES[i].y) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 2);
  for (const { j } of d) {
    const key: [number, number] = i < j ? [i, j] : [j, i];
    if (!LINKS.some(([a, b]) => a === key[0] && b === key[1])) LINKS.push(key);
  }
}

export function AtlasField() {
  return (
    <div className="atlas-field" aria-hidden>
      <svg className="atlas-network" viewBox="0 0 1000 600" preserveAspectRatio="xMidYMin slice" aria-hidden>
        {LINKS.map(([a, b]) => (
          <line key={`${a}-${b}`} x1={NODES[a].x} y1={NODES[a].y} x2={NODES[b].x} y2={NODES[b].y} />
        ))}
        {NODES.map((n, i) => (
          <circle key={i} cx={n.x} cy={n.y} r={n.r} />
        ))}
      </svg>
    </div>
  );
}
