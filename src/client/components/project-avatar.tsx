"use client";

// A PROJECT'S AVATAR WITHOUT AN ASSET. No icon service, no fetch: the
// ticker (or the name's initials) on a navy disc, with one hue derived
// deterministically from the project's stable key so the same project
// always looks the same and two projects rarely look alike. When a real
// icon asset exists in the data, it replaces this; until then nothing is
// invented.
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

export function ProjectAvatar({ name, ticker, slug, size = 40 }: { name: string | null; ticker: string | null; slug: string | null; size?: number }) {
  const initials = projectInitials(name, ticker);
  return (
    <span
      className="avatar"
      style={{ width: size, height: size, "--hue": projectHue(slug ?? name), fontSize: initials.length > 2 ? size * 0.28 : size * 0.34 } as React.CSSProperties}
      aria-hidden
      data-testid="project-avatar"
    >
      {initials}
    </span>
  );
}
