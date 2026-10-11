"use client";

import projectAssets from "../project-assets.json";

// A PROJECT'S AVATAR. Where an approved logo asset exists for the
// project (a static file under /public/projects, taken from the approved
// design export — never fetched, never generated), the tile shows it.
// Otherwise: the ticker (or the name's initials) on a navy tile, with one
// hue derived deterministically from the project's stable key so the same
// project always looks the same and two projects rarely look alike.
// Nothing is invented: an unknown project gets initials, not a guess.
export function projectInitials(name: string | null, ticker: string | null): string {
  if (ticker && ticker.trim()) return ticker.trim().slice(0, 3).toUpperCase();
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

export function projectHue(key: string | null): number {
  let h = 0;
  for (const ch of key ?? "") h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 360;
}

// The closed list of projects with an approved asset, by catalog slug, is
// DATA (`project-assets.json`): a manifest of files under /public/projects,
// not a code path that knows a project. `glyph` is a mark on a transparent
// ground, drawn inside the tile; `tile` is a complete tile that replaces
// the tile's own ground.
type ProjectAsset = { src: string; kind: "glyph" | "tile" };
const PROJECT_ASSETS = projectAssets as Record<string, ProjectAsset>;

export function projectAsset(slug: string | null): ProjectAsset | null {
  return slug ? (PROJECT_ASSETS[slug] ?? null) : null;
}

export function ProjectAvatar({ name, ticker, slug, size = 40 }: { name: string | null; ticker: string | null; slug: string | null; size?: number }) {
  const initials = projectInitials(name, ticker);
  const asset = projectAsset(slug);
  return (
    <span
      className={`avatar ${asset ? `avatar-${asset.kind}` : ""}`}
      style={{ width: size, height: size, "--hue": projectHue(slug ?? name), fontSize: initials.length > 2 ? size * 0.28 : size * 0.34 } as React.CSSProperties}
      aria-hidden
      data-testid="project-avatar"
      data-asset={asset ? slug : undefined}
    >
      {asset ? (
        // A static, approved file; the plain element is deliberate (no
        // optimisation round-trip, no remote loader).
        // eslint-disable-next-line @next/next/no-img-element
        <img src={asset.src} alt="" width={size} height={size} draggable={false} />
      ) : (
        initials
      )}
    </span>
  );
}
