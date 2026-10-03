import React, { useEffect, useMemo, useRef, useState } from "react";
import { ComposableMap, Geographies, Geography } from "react-simple-maps";
import { supabase } from "./lib/supabase";
import { getCountryFromTimezone } from "./lib/timezone";

// Flat world-map heatmap of users active in the trailing window (default 24h),
// sitting at the top of the All Transcripts page. Click a country to filter the
// transcript list to that country; click the same country again (or "Clear") to
// drop the filter. Country is derived from user_info.time_zone (same logic as the
// rest of the app), so the server stays country-agnostic — active_countries_window
// returns per-timezone user counts and we fold them into countries here.

// Served locally from public/ so the dashboard works offline (no CDN round-trip).
const GEO_URL = `${import.meta.env.BASE_URL}countries-110m.json`;

// Our country name (getCountryFromTimezone output) → the name the world-atlas
// topojson uses. Only the ones that differ need an entry; everything else matches
// verbatim (Brazil, Turkey, Canada, Mexico, India, Indonesia, Philippines, …).
// Countries we produce that have no 110m polygon (Singapore, Hong Kong, Malta and
// other small territories) simply aren't drawable on the map — they remain
// available through the Country dropdown filter.
const COUNTRY_TO_GEO: Record<string, string> = {
  "United States": "United States of America",
  "Czech Republic": "Czechia",
  "DR Congo": "Dem. Rep. Congo",
  "Dominican Republic": "Dominican Rep.",
  "Bosnia and Herzegovina": "Bosnia and Herz.",
  "Central African Republic": "Central African Rep.",
  "Equatorial Guinea": "Eq. Guinea",
  "East Timor": "Timor-Leste",
  "Falkland Islands": "Falkland Is.",
  "Ivory Coast": "Côte d'Ivoire",
  "North Macedonia": "Macedonia",
  "Solomon Islands": "Solomon Is.",
  "South Sudan": "S. Sudan",
  "Western Sahara": "W. Sahara",
  "Eswatini": "eSwatini",
};
// Inverse: topojson name → our country name, for turning a clicked geography back
// into the value the Country filter expects.
const GEO_TO_COUNTRY: Record<string, string> = Object.fromEntries(
  Object.entries(COUNTRY_TO_GEO).map(([k, v]) => [v, k]),
);

interface WindowRow {
  time_zone: string;
  users: number;
  lessons: number;
}
interface CountryStat {
  country: string; // our canonical name (the filter value)
  users: number;
  lessons: number;
}

const WINDOW_HOURS = 24;

const TranscriptsWorldMap: React.FC<{
  selectedCountry: string; // "All" = no selection
  onSelectCountry: (country: string) => void;
}> = ({ selectedCountry, onSelectCountry }) => {
  const [rows, setRows] = useState<WindowRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      const { data, error } = await supabase.rpc("active_countries_window", {
        hours: WINDOW_HOURS,
      });
      if (cancelled) return;
      if (error) {
        setError(error.message);
        setRows([]);
      } else {
        setRows(
          ((data ?? []) as Record<string, unknown>[]).map((r) => ({
            time_zone: String(r.time_zone ?? ""),
            users: Number(r.users ?? 0),
            lessons: Number(r.lessons ?? 0),
          })),
        );
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Fold per-timezone counts into per-country stats (our canonical names).
  const byCountry = useMemo(() => {
    const m = new Map<string, CountryStat>();
    for (const r of rows) {
      const country = getCountryFromTimezone(r.time_zone);
      if (country === "Unknown") continue;
      const cur = m.get(country) ?? { country, users: 0, lessons: 0 };
      cur.users += r.users;
      cur.lessons += r.lessons;
      m.set(country, cur);
    }
    return m;
  }, [rows]);

  // Keyed by topojson name for O(1) lookup while painting geographies.
  const byGeo = useMemo(() => {
    const m = new Map<string, CountryStat>();
    byCountry.forEach((stat) => {
      m.set(COUNTRY_TO_GEO[stat.country] ?? stat.country, stat);
    });
    return m;
  }, [byCountry]);

  const maxUsers = useMemo(
    () => Math.max(1, ...Array.from(byCountry.values()).map((s) => s.users)),
    [byCountry],
  );
  const totals = useMemo(() => {
    let users = 0;
    let countries = 0;
    byCountry.forEach((s) => {
      users += s.users;
      if (s.users > 0) countries += 1;
    });
    return { users, countries };
  }, [byCountry]);

  // Perceptual heat: sqrt scale (the distribution is heavily skewed — a handful of
  // countries dwarf the long tail), floored at 0.12 so any active country is a
  // visible tint rather than near-white.
  const intensityFor = (users: number): number =>
    users > 0 ? Math.max(0.12, Math.sqrt(users) / Math.sqrt(maxUsers)) : 0;

  const selectedGeo =
    selectedCountry !== "All" ? COUNTRY_TO_GEO[selectedCountry] ?? selectedCountry : null;

  const showTip = (e: React.MouseEvent, html: string) => {
    const tip = tooltipRef.current;
    if (!tip) return;
    tip.innerHTML = html;
    tip.style.display = "block";
    tip.style.left = e.clientX + "px";
    tip.style.top = e.clientY + "px";
  };
  const moveTip = (e: React.MouseEvent) => {
    const tip = tooltipRef.current;
    if (!tip) return;
    tip.style.left = e.clientX + "px";
    tip.style.top = e.clientY + "px";
  };
  const hideTip = () => {
    if (tooltipRef.current) tooltipRef.current.style.display = "none";
  };

  return (
    <div className="chart-container tx-worldmap">
      <div className="tx-worldmap-head">
        <div>
          <h3 className="tx-worldmap-title">Where learners are active — last 24h</h3>
          <p className="tx-worldmap-sub">
            {loading
              ? "Loading activity…"
              : error
                ? `Couldn't load activity: ${error}`
                : `${totals.users.toLocaleString()} user${totals.users === 1 ? "" : "s"} across ${totals.countries} ${
                    totals.countries === 1 ? "country" : "countries"
                  } · click a country to filter the transcripts below`}
          </p>
        </div>
        {selectedCountry !== "All" && (
          <button
            type="button"
            className="tx-worldmap-clear"
            onClick={() => onSelectCountry("All")}
            title="Clear the country filter"
          >
            Filtering: <strong>{selectedCountry}</strong> ✕
          </button>
        )}
      </div>

      <div ref={tooltipRef} className="world-map-tooltip" />

      <div className="tx-worldmap-canvas">
        <ComposableMap
          projectionConfig={{ scale: 150, center: [0, 15] }}
          width={900}
          height={400}
          style={{ width: "100%", height: "auto" }}
        >
            <Geographies geography={GEO_URL}>
              {({ geographies }) =>
                geographies.map((geo) => {
                  const geoName = geo.properties.name as string;
                  const stat = byGeo.get(geoName);
                  const users = stat?.users ?? 0;
                  const country = GEO_TO_COUNTRY[geoName] ?? geoName;
                  const intensity = intensityFor(users);
                  const isSelected = selectedGeo !== null && geoName === selectedGeo;
                  const baseFill = users > 0 ? `rgba(99, 102, 241, ${intensity})` : "#f0f0f0";
                  return (
                    <Geography
                      key={geo.rsmKey}
                      geography={geo}
                      fill={baseFill}
                      stroke={isSelected ? "#4338ca" : "#d1d5db"}
                      strokeWidth={isSelected ? 1.4 : 0.5}
                      onClick={() =>
                        onSelectCountry(selectedCountry === country ? "All" : country)
                      }
                      onMouseEnter={(e: React.MouseEvent) =>
                        showTip(
                          e,
                          users > 0
                            ? `<strong>${country}</strong>: ${users.toLocaleString()} user${
                                users === 1 ? "" : "s"
                              } · ${(stat?.lessons ?? 0).toLocaleString()} lesson${
                                (stat?.lessons ?? 0) === 1 ? "" : "s"
                              } (24h)`
                            : `<strong>${country}</strong>: no activity (24h) — click to filter anyway`,
                        )
                      }
                      onMouseMove={moveTip}
                      onMouseLeave={hideTip}
                      style={{
                        default: { outline: "none", cursor: "pointer" },
                        hover: {
                          outline: "none",
                          cursor: "pointer",
                          fill: users > 0 ? "#6366f1" : "#e5e7eb",
                        },
                        pressed: { outline: "none", fill: "#4338ca" },
                      }}
                    />
                  );
                })
              }
            </Geographies>
        </ComposableMap>
      </div>

      <div className="world-map-legend">
        <span className="world-map-legend-label">Fewer</span>
        <div className="world-map-legend-bar" />
        <span className="world-map-legend-label">More</span>
        <span className="world-map-legend-suffix">
          users active (last 24h){!loading && !error ? ` · peak ${maxUsers.toLocaleString()}` : ""}
        </span>
      </div>
    </div>
  );
};

export default TranscriptsWorldMap;
