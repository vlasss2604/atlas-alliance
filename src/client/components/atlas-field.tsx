// THE EVIDENCE-NETWORK FIELD — the logo's atmosphere behind every screen.
//
// V7 (docs/design/v7, HANDOFF §4.0): the page gradient, two large static
// glows (cyan top-left, violet bottom-right) and the faint evidence
// network of the approved mockups (`.ap-net`), drawn once from fixed
// coordinates. Fixed, non-interactive, no filter, no animation — a single
// paint. Content readability is never in competition with it.

const LINES =
  "233.5,25.7,306.1,61.8 233.5,25.7,268.6,168.4 306.1,61.8,268.6,168.4 268.6,168.4,350.9,247.5 350.9,247.5,227.8,306.8 40.9,386.6,72.8,446.6 40.9,386.6,156.8,465.0 227.8,306.8,210.5,435.0 72.8,446.6,156.8,465.0 156.8,465.0,210.5,435.0 210.5,435.0,355.0,470.3 355.0,470.3,358.7,593.3 55.3,609.1,168.6,632.7 55.3,609.1,19.7,742.1 168.6,632.7,249.4,616.1 168.6,632.7,119.8,748.9 249.4,616.1,358.7,593.3 19.7,742.1,119.8,748.9 361.4,757.0,277.5,883.9 361.4,757.0,307.9,905.7 34.6,905.1,152.3,882.2 34.6,905.1,86.2,1053.6 152.3,882.2,277.5,883.9 277.5,883.9,307.9,905.7 277.5,883.9,316.0,986.0 307.9,905.7,316.0,986.0 86.2,1053.6,137.6,1038.9 86.2,1053.6,118.1,1134.9 137.6,1038.9,118.1,1134.9 316.0,986.0,272.0,1118.8 272.0,1118.8,345.0,1195.9 345.0,1195.9,321.0,1294.0"
    .split(" ")
    .map((l) => l.split(",").map(Number));

// Plain nodes, and the few "lit" nodes that carry a soft halo.
const NODES =
  "22.2,82.7 233.5,25.7 306.1,61.8 350.9,247.5 40.9,386.6 227.8,306.8 72.8,446.6 156.8,465.0 210.5,435.0 355.0,470.3 55.3,609.1 168.6,632.7 249.4,616.1 358.7,593.3 119.8,748.9 361.4,757.0 34.6,905.1 152.3,882.2 307.9,905.7 86.2,1053.6 137.6,1038.9 316.0,986.0 272.0,1118.8 345.0,1195.9"
    .split(" ")
    .map((n) => n.split(",").map(Number));
const LIT = "268.6,168.4 19.7,742.1 277.5,883.9 118.1,1134.9"
  .split(" ")
  .map((n) => n.split(",").map(Number));

export function AtlasField() {
  return (
    <div className="atlas-field" aria-hidden>
      <span className="atlas-glow atlas-glow-cyan" />
      <span className="atlas-glow atlas-glow-violet" />
      <svg className="atlas-network" viewBox="0 0 390 1300" preserveAspectRatio="xMidYMin slice" aria-hidden>
        {LINES.map(([x1, y1, x2, y2], i) => (
          <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} />
        ))}
        {NODES.map(([cx, cy], i) => (
          <circle key={i} cx={cx} cy={cy} r={1.5} />
        ))}
        {LIT.map(([cx, cy], i) => (
          <g key={i}>
            <circle cx={cx} cy={cy} r={7} fill="rgba(30, 197, 245, 0.13)" />
            <circle cx={cx} cy={cy} r={2.4} fill="rgba(170, 240, 255, 0.9)" />
          </g>
        ))}
      </svg>
    </div>
  );
}
