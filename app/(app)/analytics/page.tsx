"use client";

// ANALYTICS — the product's place for Compare and Monitoring. Neither
// exists yet, and this page says so plainly instead of hiding behind a
// greyed-out control: a reader learns where those will live and loses
// nothing by coming here.
export default function AnalyticsPage() {
  return (
    <main className="enter flex flex-col gap-6 pt-4">
      <div>
        <h1 className="display text-[1.7rem] font-semibold text-[var(--atlas-text-strong)] sm:text-[2rem]">Analytics</h1>
        <p className="mt-2 max-w-[52ch] text-[1.02rem] leading-[1.5] text-[var(--atlas-text-dim)]">
          Comparing projects and monitoring a mechanism over time will live here. For now, every
          verification starts from Home and every finished one is in Research.
        </p>
      </div>
    </main>
  );
}
