"use client";

import { useState, useCallback, useMemo } from "react";
import { createClient } from "@supabase/supabase-js";
import ReactECharts from "echarts-for-react";

// ---------------------------------------------------------------------------
// Supabase client (module-level singleton)
// ---------------------------------------------------------------------------
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface PlayerRating {
  fide_id: number;
  name: string;
  fed: string;
  sex: string;
  rating: number;
  world_rank: number | null;
  national_rank: number | null;
  world_women_rank: number | null;
  national_women_rank: number | null;
  date: string; // YYYY-MM-DD
}

interface PlayerSummary {
  name: string;
  fide_id: number;
  currentRating: number;
  peakWorldRank: number | null;
}

interface ResolvedPlayer {
  name: string;
  fide_id: number;
  rows: PlayerRating[];
}

// ---------------------------------------------------------------------------
// Colour palette — cinematic amber / ember / ice
// ---------------------------------------------------------------------------
const PALETTE = [
  "#F5C542",
  "#E07B54",
  "#7EC8E3",
  "#A3E4D7",
  "#D7A2F5",
  "#F5A3C7",
  "#8BE38B",
  "#F5855A",
];

// ---------------------------------------------------------------------------
// Classify each search term as numeric (FIDE ID lookup) or textual (ilike)
// ---------------------------------------------------------------------------
function isNumericTerm(term: string): boolean {
  return /^\d+$/.test(term.trim());
}

// ---------------------------------------------------------------------------
// Resolve one canonical player per search term.
//
// Fix 1 — group by fide_id, NOT by name:
//   A player whose name changed over time (e.g. "Vaishali R" →
//   "Vaishali Rameshbabu") will have multiple distinct name strings in the
//   DB but a single fide_id. Grouping by fide_id merges those rows into one
//   continuous timeline. The most recent name for that fide_id is used as
//   the display label.
//
// Fix 2 — Pragg / Spraggett disambiguation:
//   For name-based terms, collect all matching fide_ids, then keep only the
//   one whose peak historical rating is greatest.
// ---------------------------------------------------------------------------
function resolveCanonicalPlayers(
  rows: PlayerRating[],
  searchTerms: string[]
): ResolvedPlayer[] {
  // ── Step 1: group ALL returned rows by fide_id ──────────────────────────
  const byId = new Map<number, PlayerRating[]>();
  for (const row of rows) {
    const bucket = byId.get(row.fide_id) ?? [];
    bucket.push(row);
    byId.set(row.fide_id, bucket);
  }

  // Helper: derive display name = name from the most recent row for that id
  function displayName(playerRows: PlayerRating[]): string {
    return [...playerRows].sort((a, b) => b.date.localeCompare(a.date))[0]
      .name;
  }

  const resolved: ResolvedPlayer[] = [];
  const usedIds = new Set<number>();

  for (const term of searchTerms) {
    const numeric = isNumericTerm(term);

    // ── Step 2: collect candidate fide_ids that match this term ───────────
    const candidates: { fide_id: number; peakRating: number }[] = [];

    for (const [fide_id, playerRows] of byId.entries()) {
      const matches = numeric
        ? fide_id === Number(term)                          // exact FIDE ID
        : playerRows.some((r) =>                            // name ilike
            r.name.toLowerCase().includes(term.toLowerCase())
          );

      if (matches) {
        const peak = Math.max(...playerRows.map((r) => r.rating));
        candidates.push({ fide_id, peakRating: peak });
      }
    }

    if (!candidates.length) continue;

    // ── Step 3: keep only the highest-rated candidate (Pragg fix) ─────────
    candidates.sort((a, b) => b.peakRating - a.peakRating);
    const { fide_id: winnerId } = candidates[0];

    // Deduplicate across search terms
    if (usedIds.has(winnerId)) continue;
    usedIds.add(winnerId);

    const sortedRows = (byId.get(winnerId) ?? []).sort((a, b) =>
      a.date.localeCompare(b.date)
    );

    resolved.push({
      name: displayName(sortedRows),
      fide_id: winnerId,
      rows: sortedRows,
    });
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// ECharts option builder
// ---------------------------------------------------------------------------
function buildChartOption(players: ResolvedPlayer[]) {
  const series = players.map((player, i) => ({
    name: player.name,
    type: "line",
    smooth: true,
    symbol: "none",
    sampling: "lttb",
    lineStyle: {
      color: PALETTE[i % PALETTE.length],
      width: 2.5,
    },
    itemStyle: { color: PALETTE[i % PALETTE.length] },
    emphasis: { lineStyle: { width: 3.5 } },
    // Super GM markLine only on first series to avoid duplication
    ...(i === 0 && {
      markLine: {
        silent: true,
        symbol: "none",
        animation: false,
        lineStyle: {
          color: "#F5C542",
          type: "dashed",
          width: 1,
          opacity: 0.4,
        },
        label: {
          show: true,
          position: "insideEndTop",
          formatter: "Super GM · 2700",
          color: "#F5C542",
          opacity: 0.6,
          fontSize: 10,
          fontFamily: "monospace",
          padding: [3, 7],
          backgroundColor: "rgba(245,197,66,0.07)",
          borderRadius: 3,
        },
        data: [{ yAxis: 2700 }],
      },
    }),
    // ECharts time axis expects [dateString, value]
    data: player.rows.map((r) => [r.date, r.rating]),
  }));

  return {
    backgroundColor: "transparent",
    animation: true,
    animationDuration: 800,
    animationEasing: "cubicOut" as const,

    // -----------------------------------------------------------------------
    // Tooltip
    // -----------------------------------------------------------------------
    tooltip: {
      trigger: "axis",
      backgroundColor: "#0d0d0d",
      borderColor: "#252525",
      borderWidth: 1,
      padding: [12, 16],
      textStyle: { color: "#bbb", fontSize: 12, fontFamily: "monospace" },
      axisPointer: {
        type: "line",
        lineStyle: { color: "#252525", width: 1 },
      },
      formatter: (
        params: {
          axisValue: string;
          seriesName: string;
          value: [string, number];
          color: string;
        }[]
      ) => {
        if (!Array.isArray(params) || !params.length) return "";
        // axisValue is a timestamp string when axis type is "time"
        const raw = params[0].axisValue;
        const label =
          typeof raw === "string" && raw.length >= 7
            ? raw.slice(0, 7)
            : new Date(Number(raw)).toISOString().slice(0, 7);
        const rows = params
          .map(
            (p) =>
              `<div style="display:flex;align-items:center;gap:8px;margin-top:5px;">
                <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${p.color};flex-shrink:0"></span>
                <span style="color:#888;max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${p.seriesName}</span>
                <span style="margin-left:auto;padding-left:16px;font-weight:700;color:${p.color};">${p.value[1]}</span>
              </div>`
          )
          .join("");
        return `<div style="font-family:monospace;min-width:200px;">
          <div style="color:#444;font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;margin-bottom:2px;">${label}</div>
          ${rows}
        </div>`;
      },
    },

    // -----------------------------------------------------------------------
    // Legend
    // -----------------------------------------------------------------------
    legend: {
      top: 0,
      right: 0,
      icon: "circle",
      itemWidth: 7,
      itemHeight: 7,
      itemGap: 18,
      textStyle: { color: "#4a4a4a", fontSize: 11, fontFamily: "monospace" },
    },

    // -----------------------------------------------------------------------
    // Grid
    // -----------------------------------------------------------------------
    grid: {
      top: 44,
      left: 8,
      right: 16,
      bottom: 72,
      containLabel: true,
    },

    // -----------------------------------------------------------------------
    // Axes
    // -----------------------------------------------------------------------
    xAxis: {
      type: "time",
      boundaryGap: false,
      axisLine: { lineStyle: { color: "#1c1c1c" } },
      axisTick: { show: false },
      axisLabel: {
        color: "#3e3e3e",
        fontSize: 11,
        fontFamily: "monospace",
        hideOverlap: true,
        margin: 14,
        formatter: (val: number) => {
          const d = new Date(val);
          return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        },
      },
      splitLine: { show: false },
    },

    yAxis: {
      type: "value",
      scale: true,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: "#3e3e3e",
        fontSize: 11,
        fontFamily: "monospace",
        margin: 14,
      },
      splitLine: {
        lineStyle: { color: "#131313", type: "solid", width: 1 },
      },
    },

    // -----------------------------------------------------------------------
    // dataZoom — inside (wheel/trackpad) + slider
    // -----------------------------------------------------------------------
    dataZoom: [
      {
        type: "inside",
        xAxisIndex: 0,
        filterMode: "none",
        zoomOnMouseWheel: true,
        moveOnMouseMove: true,
        preventDefaultMouseMove: false,
        minSpan: 5,
      },
      {
        type: "slider",
        xAxisIndex: 0,
        filterMode: "none",
        height: 22,
        bottom: 10,
        borderColor: "transparent",
        backgroundColor: "#0a0a0a",
        fillerColor: "rgba(245,197,66,0.07)",
        handleStyle: {
          color: "#1a1a1a",
          borderColor: "#F5C542",
          borderWidth: 1,
          shadowBlur: 4,
          shadowColor: "rgba(245,197,66,0.25)",
        },
        moveHandleStyle: { color: "#F5C542", opacity: 0.4 },
        selectedDataBackground: {
          lineStyle: { color: "#F5C542", opacity: 0.25, width: 1 },
          areaStyle: { color: "#F5C542", opacity: 0.03 },
        },
        dataBackground: {
          lineStyle: { color: "#1e1e1e", width: 1 },
          areaStyle: { color: "#0d0d0d", opacity: 1 },
        },
        textStyle: { color: "#383838", fontSize: 10, fontFamily: "monospace" },
        labelFormatter: (_: unknown, val: number) => {
          const d = new Date(val);
          return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        },
        emphasis: {
          handleStyle: { borderColor: "#F5C542", shadowBlur: 8 },
          moveHandleStyle: { color: "#F5C542", opacity: 0.7 },
        },
      },
    ],

    series,
  };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export default function HomePage() {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [players, setPlayers] = useState<ResolvedPlayer[]>([]);
  const [hasSearched, setHasSearched] = useState(false);

  // -------------------------------------------------------------------------
  // Search handler
  // -------------------------------------------------------------------------
  const handleSearch = useCallback(async () => {
    const terms = query
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean);
    if (!terms.length) return;

    setLoading(true);
    setError(null);
    setHasSearched(true);

    try {
      // Route each term: purely numeric → fide_id exact match, else → name ilike
      const filterParts = terms.map((t) =>
        isNumericTerm(t) ? `fide_id.eq.${t}` : `name.ilike.%${t}%`
      );
      const orFilter = filterParts.join(",");

      const { data, error: sbError } = await supabase
        .from("player_ratings")
        .select(
          "fide_id,name,fed,sex,rating,world_rank,national_rank,world_women_rank,national_women_rank,date"
        )
        .or(orFilter)
        .order("date", { ascending: true });

      if (sbError) throw new Error(sbError.message);

      const resolved = resolveCanonicalPlayers(
        (data ?? []) as PlayerRating[],
        terms
      );
      setPlayers(resolved);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setPlayers([]);
    } finally {
      setLoading(false);
    }
  }, [query]);

  // -------------------------------------------------------------------------
  // Derived: summary table
  // -------------------------------------------------------------------------
  const summaries: PlayerSummary[] = useMemo(
    () =>
      players.map((p) => {
        const validRanks = p.rows
          .map((r) => r.world_rank)
          .filter((r): r is number => r !== null && r > 0);
        return {
          name: p.name,
          fide_id: p.fide_id,
          currentRating: p.rows[p.rows.length - 1]?.rating ?? 0,
          peakWorldRank: validRanks.length ? Math.min(...validRanks) : null,
        };
      }),
    [players]
  );

  const chartOption = useMemo(() => buildChartOption(players), [players]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <main className="min-h-screen bg-[#080808] text-white flex flex-col">

      {/* Grain overlay */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 z-0 opacity-[0.03]"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")",
          backgroundRepeat: "repeat",
          backgroundSize: "128px 128px",
        }}
      />
      {/* Ambient glow */}
      <div
        aria-hidden
        className="pointer-events-none fixed top-0 left-0 w-[600px] h-[600px] rounded-full bg-[#F5C542] opacity-[0.04] blur-[120px] z-0"
      />

      <div className="relative z-10 flex flex-col flex-1 max-w-6xl mx-auto w-full px-6 py-12">

        {/* ---------------------------------------------------------------- */}
        {/* Header                                                            */}
        {/* ---------------------------------------------------------------- */}
        <header className="mb-14">
          <div className="flex items-center gap-3 mb-4">
            <span className="text-[#F5C542] text-xs font-mono tracking-[0.3em] uppercase">
              FIDE · ELO TRACKER
            </span>
            <span className="h-px flex-1 bg-gradient-to-r from-[#F5C542]/30 to-transparent" />
          </div>

          <h1
            className="text-5xl md:text-7xl font-black tracking-tight leading-none mb-5"
            style={{ fontFamily: "'Georgia', 'Times New Roman', serif" }}
          >
            Rating&nbsp;
            <span
              className="text-transparent bg-clip-text"
              style={{
                backgroundImage:
                  "linear-gradient(135deg, #F5C542 0%, #E07B54 100%)",
              }}
            >
              Chronicle
            </span>
          </h1>

          {/* Subtitle */}
          <p className="text-[#666] text-xs font-mono tracking-[0.22em] uppercase">
            Tracking historical classical records from January 2018.
          </p>
        </header>

        {/* ---------------------------------------------------------------- */}
        {/* Search bar                                                        */}
        {/* ---------------------------------------------------------------- */}
        <section className="mb-12">
          <label className="block text-xs font-mono text-[#777] tracking-[0.2em] uppercase mb-3">
            Players — comma-separated
          </label>
          <div className="flex gap-3 items-stretch">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              placeholder="Gukesh D, Praggnanandhaa R, 5202213"
              className="flex-1 bg-[#111] border border-[#222] rounded-xl px-5 py-4 text-white text-sm placeholder-[#2e2e2e] focus:outline-none focus:border-[#F5C542]/50 focus:ring-1 focus:ring-[#F5C542]/20 transition-all font-mono"
            />
            <button
              onClick={handleSearch}
              disabled={loading || !query.trim()}
              className="px-8 py-4 rounded-xl text-sm font-bold tracking-wider uppercase transition-all disabled:opacity-30 disabled:cursor-not-allowed"
              style={{
                background: loading
                  ? "#181818"
                  : "linear-gradient(135deg, #F5C542 0%, #E07B54 100%)",
                color: loading ? "#444" : "#0d0d0d",
              }}
            >
              {loading ? (
                <span className="flex items-center gap-2">
                  <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                  </svg>
                  Loading
                </span>
              ) : (
                "Search"
              )}
            </button>
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Error banner                                                      */}
        {/* ---------------------------------------------------------------- */}
        {error && (
          <div className="mb-8 px-5 py-4 rounded-xl border border-red-900/50 bg-red-950/30 text-red-400 text-sm font-mono">
            ⚠ {error}
          </div>
        )}

        {/* ---------------------------------------------------------------- */}
        {/* Empty state                                                       */}
        {/* ---------------------------------------------------------------- */}
        {hasSearched && !loading && !error && players.length === 0 && (
          <div className="text-center py-24 text-[#444] font-mono text-xs tracking-[0.3em] uppercase">
            No players found — try a shorter name fragment.
          </div>
        )}

        {/* ---------------------------------------------------------------- */}
        {/* ECharts chart                                                     */}
        {/* ---------------------------------------------------------------- */}
        {players.length > 0 && (
          <section className="mb-12">
            <div className="flex items-center gap-3 mb-6">
              <span className="text-xs font-mono text-[#666] tracking-[0.2em] uppercase">
                Elo over time
              </span>
              <span className="h-px flex-1 bg-[#1e1e1e]" />
            </div>

            <div className="bg-[#0d0d0d] border border-[#181818] rounded-2xl px-6 py-8">
              <ReactECharts
                option={chartOption}
                style={{ height: 440, width: "100%" }}
                notMerge
                lazyUpdate={false}
              />
            </div>
          </section>
        )}

        {/* ---------------------------------------------------------------- */}
        {/* Summary table                                                     */}
        {/* ---------------------------------------------------------------- */}
        {summaries.length > 0 && (
          <section className="mb-16">
            <div className="flex items-center gap-3 mb-6">
              <span className="text-xs font-mono text-[#666] tracking-[0.2em] uppercase">
                Player summary
              </span>
              <span className="h-px flex-1 bg-[#1e1e1e]" />
            </div>

            <div className="overflow-x-auto rounded-2xl border border-[#181818]">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#181818] bg-[#0d0d0d]">
                    {[
                      "Name",
                      "FIDE ID",
                      "Current Rating",
                      "Peak World Rank",
                    ].map((col, i) => (
                      <th
                        key={col}
                        className={`px-6 py-4 text-xs font-mono text-[#666] tracking-[0.14em] uppercase ${
                          i === 0 ? "text-left" : "text-right"
                        }`}
                      >
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {summaries.map((s, i) => (
                    <tr
                      key={s.fide_id}
                      className="border-b border-[#131313] last:border-0 hover:bg-[#0f0f0f] transition-colors"
                    >
                      {/* Name + palette swatch */}
                      <td className="px-6 py-5">
                        <div className="flex items-center gap-3">
                          <span
                            className="w-2 h-2 rounded-full flex-shrink-0"
                            style={{ backgroundColor: PALETTE[i % PALETTE.length] }}
                          />
                          <span className="font-semibold text-white/85">
                            {s.name}
                          </span>
                        </div>
                      </td>

                      {/* FIDE ID */}
                      <td className="px-6 py-5 text-right font-mono text-[#555] text-xs">
                        {s.fide_id}
                      </td>

                      {/* Current rating — colour-coded by tier */}
                      <td className="px-6 py-5 text-right">
                        <span
                          className="font-mono font-bold text-base"
                          style={{
                            color:
                              s.currentRating >= 2700
                                ? "#F5C542"
                                : s.currentRating >= 2600
                                ? "#E07B54"
                                : "#aaa",
                          }}
                        >
                          {s.currentRating}
                        </span>
                      </td>

                      {/* Peak world rank */}
                      <td className="px-6 py-5 text-right font-mono text-[#666]">
                        {s.peakWorldRank !== null ? (
                          <>
                            <span className="text-white/25">#</span>
                            {s.peakWorldRank}
                          </>
                        ) : (
                          <span className="text-[#252525]">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* spacer */}
        <div className="flex-1" />

        {/* ---------------------------------------------------------------- */}
        {/* Footer                                                            */}
        {/* ---------------------------------------------------------------- */}
        <footer className="border-t border-[#131313] pt-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <span className="text-xs font-mono text-[#555] tracking-[0.3em] uppercase">
            FIDE Rating Chronicle
          </span>
          <span className="text-xs font-mono text-[#555] italic">
            &apos;Candidates&apos; coming soon. Hopefully before GTA 6.
          </span>
        </footer>

      </div>
    </main>
  );
}
