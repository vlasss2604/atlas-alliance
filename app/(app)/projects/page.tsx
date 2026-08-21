"use client";

import { useEffect, useState } from "react";

import { api } from "@/src/client/api";
import { useApp } from "@/src/client/app-context";

type Project = Awaited<ReturnType<typeof api.getProjects>>["projects"][number];

export default function ProjectsPage() {
  const { dict } = useApp();
  const [projects, setProjects] = useState<Project[] | null>(null);

  useEffect(() => {
    void api.getProjects().then((r) => setProjects(r.projects)).catch(() => setProjects([]));
  }, []);

  return (
    <main className="enter flex flex-col gap-4">
      <h1 className="pt-4 text-xl font-semibold">{dict.projects.title}</h1>
      {projects === null ? (
        <p className="text-sm text-[var(--atlas-text-dim)]">{dict.common.loading}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {projects.map((p) => (
            <li key={p.slug} className="glass flex items-center gap-3 px-4 py-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-white/5 text-sm font-semibold text-[var(--atlas-cyan)]">
                {(p.ticker ?? p.name).slice(0, 2).toUpperCase()}
              </span>
              <span className="flex-1">
                <span className="block text-sm">{p.name}</span>
                {p.ticker && (
                  <span className="text-xs text-[var(--atlas-text-dim)]">{p.ticker}</span>
                )}
              </span>
              {!p.researchable && (
                <span
                  className="rounded-full border border-[var(--atlas-border)] px-2 py-1 text-[10px] text-[var(--atlas-text-dim)]"
                  title={dict.projects.locked}
                >
                  🔒 CORE
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
