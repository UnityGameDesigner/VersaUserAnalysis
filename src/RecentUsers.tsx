import React, { useState, useEffect, useMemo, useCallback } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  LabelList,
  ResponsiveContainer,
} from "recharts";
import { supabase } from "./lib/supabase";
import { getCountryFromTimezone } from "./lib/timezone";

// "Recent users" = the distinct users who completed at least one lesson in the
// trailing window, resolved from completed_lessons.created_at, then joined to
// user_info for the demographic breakdown. This cohort intentionally includes
// users of every payment status (it's an activity view, not the active-only
// analytics) — the payment-status breakdown below shows the active/free split.

interface RecentUser {
  user_id: string;
  preferred_name: string | null;
  // user_info.age is a TEXT column — values arrive as strings ("20", "0", "-1").
  // "0" and "-1" are unset/unknown sentinels, not real ages.
  age: number | string | null;
  gender: string | null;
  time_zone: string | null;
  native_language: string | null;
  learning_language: string | null;
  level: string | null;
  reason: string | null;
  attribution: string | null;
  platform: string | null;
  payment_status: string | null;
}

const PAGE_SIZE = 1000;
// 50 UUIDs per user_id=in.(…) chunk keeps each URL ~2 KB (see CompletedLessons).
const USER_ID_CHUNK = 50;
// Resolve chunks this many at a time. Wide windows produce ~100+ chunks; fetching
// them sequentially was the load-time bottleneck, so fetch in bounded-concurrency
// waves (8 keeps us well under PostgREST connection limits).
const CHUNK_CONCURRENCY = 8;

const WINDOW_OPTIONS = [
  { label: "Past 6 hours", hours: 6 },
  { label: "Past 12 hours", hours: 12 },
  { label: "Past 24 hours", hours: 24 },
  { label: "Past 48 hours", hours: 48 },
  { label: "Past 96 hours", hours: 96 },
];

interface Bucket {
  name: string;
  value: number;
}

// Tally a string accessor across users into {name,value}[] sorted by count desc.
function buildDistribution(
  items: RecentUser[],
  accessor: (u: RecentUser) => string,
): Bucket[] {
  const map = new Map<string, number>();
  items.forEach((u) => {
    const key = accessor(u);
    map.set(key, (map.get(key) || 0) + 1);
  });
  return Array.from(map.entries())
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);
}

// Fixed display order for age buckets (don't sort these by count).
const AGE_ORDER = [
  "Under 18", "18–22", "23–27", "28–32", "33–37",
  "38–42", "43–47", "48–52", "53–57", "58+", "Unknown",
];

// native_language / learning_language are stored as lowercase codes
// ("english", "spanish", "brazilian portuguese"). Titlecase for display.
function prettyLang(code: string | null): string {
  if (!code || !code.trim()) return "Unknown";
  return code
    .split(/[\s_-]+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function getAgeBucket(ageRaw: number | string | null): string {
  if (ageRaw === null || ageRaw === undefined || ageRaw === "") return "Unknown";
  const age = typeof ageRaw === "number" ? ageRaw : Number.parseInt(ageRaw, 10);
  // 0 / -1 / non-numeric are unset sentinels, not real ages.
  if (!Number.isFinite(age) || age <= 0) return "Unknown";
  if (age < 18) return "Under 18";
  if (age < 23) return "18–22";
  if (age < 28) return "23–27";
  if (age < 33) return "28–32";
  if (age < 38) return "33–37";
  if (age < 43) return "38–42";
  if (age < 48) return "43–47";
  if (age < 53) return "48–52";
  if (age < 58) return "53–57";
  return "58+";
}

const BreakdownCard: React.FC<{
  title: string;
  data: Bucket[];
  color: string;
  limit?: number;
}> = ({ title, data, color, limit }) => {
  const shown = limit ? data.slice(0, limit) : data;
  const height = Math.max(120, shown.length * 30 + 24);
  return (
    <div className="chart-container">
      <h3>{title}</h3>
      {shown.length === 0 ? (
        <p className="recent-empty-mini">No data</p>
      ) : (
        <div style={{ width: "100%", height }}>
          <ResponsiveContainer>
            <BarChart
              data={shown}
              layout="vertical"
              margin={{ left: 8, right: 44, top: 4, bottom: 4 }}
            >
              <XAxis type="number" hide />
              <YAxis
                type="category"
                dataKey="name"
                tick={{ fontSize: 12 }}
                width={120}
                interval={0}
              />
              <Tooltip
                formatter={(v: number | undefined) => [
                  `${v ?? 0} user${v === 1 ? "" : "s"}`,
                  "Users",
                ]}
              />
              <Bar dataKey="value" fill={color} radius={[0, 4, 4, 0]}>
                <LabelList
                  dataKey="value"
                  position="right"
                  style={{ fontSize: 11, fill: "#6b7280" }}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
      {limit && data.length > limit && (
        <p className="recent-more">+{data.length - limit} more categories</p>
      )}
    </div>
  );
};

const RecentUsers: React.FC = () => {
  const [users, setUsers] = useState<RecentUser[]>([]);
  // user_id → lessons completed in the window, so the lesson metrics can be
  // scoped to the selected learning language.
  const [userLessonCounts, setUserLessonCounts] = useState<Map<string, number>>(new Map());
  const [windowHours, setWindowHours] = useState(12);
  const [selectedLanguage, setSelectedLanguage] = useState("All");
  const [selectedNative, setSelectedNative] = useState("All");
  const [selectedCountry, setSelectedCountry] = useState("All");
  const [selectedAge, setSelectedAge] = useState("All");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);

  const fetchRecent = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const since = new Date(Date.now() - windowHours * 3600_000).toISOString();

      // 1. All lessons completed in the window — only id + user_id, so rows are
      //    tiny. Keyset-paginate by id; the window's rows cluster at the high
      //    end of the id range, so this is a couple of pages.
      const lessonsByUser = new Map<string, number>();
      let lastId = 0;
      let hasMore = true;
      while (hasMore) {
        const { data, error } = await supabase
          .from("completed_lessons")
          .select("id, user_id")
          .gte("created_at", since)
          .gt("id", lastId)
          .order("id", { ascending: true })
          .limit(PAGE_SIZE);
        if (error) throw new Error(error.message);
        if (data && data.length > 0) {
          (data as { id: number; user_id: string }[]).forEach((r) => {
            lessonsByUser.set(r.user_id, (lessonsByUser.get(r.user_id) || 0) + 1);
          });
          lastId = data[data.length - 1].id;
          hasMore = data.length === PAGE_SIZE;
        } else {
          hasMore = false;
        }
      }

      // 2. Resolve those users' profiles from user_info, chunked by user_id
      //    (no FK exists for an embedded join). Fetch chunks in bounded-
      //    concurrency waves so wide windows (~100+ chunks) stay fast.
      const userIds = Array.from(lessonsByUser.keys());
      const chunks: string[][] = [];
      for (let i = 0; i < userIds.length; i += USER_ID_CHUNK) {
        chunks.push(userIds.slice(i, i + USER_ID_CHUNK));
      }
      const byId = new Map<string, RecentUser>();
      for (let i = 0; i < chunks.length; i += CHUNK_CONCURRENCY) {
        const wave = chunks.slice(i, i + CHUNK_CONCURRENCY);
        const results = await Promise.all(
          wave.map((batch) =>
            supabase
              .from("user_info")
              .select(
                `user_id, preferred_name, age, gender, time_zone, native_language,
                 learning_language, level, reason, attribution, platform, payment_status`,
              )
              .in("user_id", batch),
          ),
        );
        for (const { data, error } of results) {
          if (error) throw new Error(error.message);
          (data as RecentUser[] | null)?.forEach((u) => {
            if (!byId.has(u.user_id)) byId.set(u.user_id, u);
          });
        }
      }

      setUserLessonCounts(lessonsByUser);
      setUsers(Array.from(byId.values()));
      setLoadedAt(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [windowHours]);

  useEffect(() => {
    fetchRecent();
  }, [fetchRecent]);

  // ── Segment filters ─────────────────────────────────────────
  // Option lists (prettified, by frequency) for each filter. Always derived from
  // the FULL window set, so switching one filter never hides options in another.
  const optionsBy = useCallback(
    (accessor: (u: RecentUser) => string) => {
      const map = new Map<string, number>();
      users.forEach((u) => {
        const k = accessor(u);
        map.set(k, (map.get(k) || 0) + 1);
      });
      return Array.from(map.entries())
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count);
    },
    [users],
  );
  const availableLanguages = useMemo(
    () => optionsBy((u) => prettyLang(u.learning_language)),
    [optionsBy],
  );
  const availableNatives = useMemo(
    () => optionsBy((u) => prettyLang(u.native_language)),
    [optionsBy],
  );
  const availableCountries = useMemo(
    () => optionsBy((u) => getCountryFromTimezone(u.time_zone)),
    [optionsBy],
  );
  // Age options keep their natural bucket order (not by-count like the others).
  const availableAges = useMemo(() => {
    const order = new Map(AGE_ORDER.map((b, i) => [b, i]));
    return optionsBy((u) => getAgeBucket(u.age)).sort(
      (a, b) => (order.get(a.name) ?? 99) - (order.get(b.name) ?? 99),
    );
  }, [optionsBy]);

  // Every breakdown and metric below is scoped to this set — all filters compose.
  const filteredUsers = useMemo(
    () =>
      users.filter((u) => {
        if (
          selectedLanguage !== "All" &&
          prettyLang(u.learning_language) !== selectedLanguage
        )
          return false;
        if (selectedNative !== "All" && prettyLang(u.native_language) !== selectedNative)
          return false;
        if (
          selectedCountry !== "All" &&
          getCountryFromTimezone(u.time_zone) !== selectedCountry
        )
          return false;
        if (selectedAge !== "All" && getAgeBucket(u.age) !== selectedAge)
          return false;
        return true;
      }),
    [users, selectedLanguage, selectedNative, selectedCountry, selectedAge],
  );

  const filteredLessonCount = useMemo(
    () =>
      filteredUsers.reduce(
        (sum, u) => sum + (userLessonCounts.get(u.user_id) || 0),
        0,
      ),
    [filteredUsers, userLessonCounts],
  );

  // ── Breakdowns (all scoped to filteredUsers) ────────────────
  const ageDistribution = useMemo(() => {
    const dist = buildDistribution(filteredUsers, (u) => getAgeBucket(u.age));
    const order = new Map(AGE_ORDER.map((b, i) => [b, i]));
    return dist.sort(
      (a, b) => (order.get(a.name) ?? 99) - (order.get(b.name) ?? 99),
    );
  }, [filteredUsers]);
  const countryDistribution = useMemo(
    () => buildDistribution(filteredUsers, (u) => getCountryFromTimezone(u.time_zone)),
    [filteredUsers],
  );
  const genderDistribution = useMemo(
    () => buildDistribution(filteredUsers, (u) => u.gender || "Unknown"),
    [filteredUsers],
  );
  const nativeLangDistribution = useMemo(
    () => buildDistribution(filteredUsers, (u) => prettyLang(u.native_language)),
    [filteredUsers],
  );
  const learningLangDistribution = useMemo(
    () => buildDistribution(filteredUsers, (u) => prettyLang(u.learning_language)),
    [filteredUsers],
  );
  const levelDistribution = useMemo(
    () => buildDistribution(filteredUsers, (u) => u.level || "Unknown"),
    [filteredUsers],
  );
  // reason is a MULTI-SELECT field (comma-separated tags), and most users leave
  // it unset ("Not specified"). Split each user's tags, drop the unset sentinel,
  // and tally per tag so the chart shows only the goals users actually stated.
  const reasonDistribution = useMemo(() => {
    const map = new Map<string, number>();
    filteredUsers.forEach((u) => {
      (u.reason ?? "")
        .split(",")
        .map((r) => r.trim())
        .filter((r) => r && r.toLowerCase() !== "not specified")
        .forEach((r) => map.set(r, (map.get(r) || 0) + 1));
    });
    return Array.from(map.entries())
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
  }, [filteredUsers]);
  const attributionDistribution = useMemo(
    () => buildDistribution(filteredUsers, (u) => u.attribution || "Unknown"),
    [filteredUsers],
  );
  const platformDistribution = useMemo(
    () => buildDistribution(filteredUsers, (u) => u.platform || "Unknown"),
    [filteredUsers],
  );
  const statusDistribution = useMemo(
    () => buildDistribution(filteredUsers, (u) => u.payment_status || "None / free"),
    [filteredUsers],
  );

  const activeTrial = useMemo(
    () =>
      filteredUsers.filter(
        (u) => u.payment_status === "ACTIVE" || u.payment_status === "TRIAL",
      ).length,
    [filteredUsers],
  );

  const windowLabel =
    WINDOW_OPTIONS.find((w) => w.hours === windowHours)?.label ??
    `Past ${windowHours}h`;

  return (
    <div className="lessons-detail" style={{ padding: "1.5rem" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: "0.75rem",
        }}
      >
        <h2 className="lessons-detail-title" style={{ margin: 0 }}>
          Recent Users
          <span className="lessons-detail-count">
            {windowLabel.toLowerCase()}
            {loadedAt &&
              ` · as of ${loadedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`}
          </span>
        </h2>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
          <label className="tx-chip" data-active={selectedLanguage !== "All"}>
            <span className="tx-chip-label">Learning</span>
            <select
              className="tx-chip-select"
              value={selectedLanguage}
              onChange={(e) => setSelectedLanguage(e.target.value)}
            >
              <option value="All">All languages</option>
              {availableLanguages.map((l) => (
                <option key={l.name} value={l.name}>
                  {l.name} ({l.count})
                </option>
              ))}
            </select>
            <svg className="tx-chip-caret" viewBox="0 0 12 12" aria-hidden="true">
              <path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </label>
          <label className="tx-chip" data-active={selectedNative !== "All"}>
            <span className="tx-chip-label">Native</span>
            <select
              className="tx-chip-select"
              value={selectedNative}
              onChange={(e) => setSelectedNative(e.target.value)}
            >
              <option value="All">All natives</option>
              {availableNatives.map((l) => (
                <option key={l.name} value={l.name}>
                  {l.name} ({l.count})
                </option>
              ))}
            </select>
            <svg className="tx-chip-caret" viewBox="0 0 12 12" aria-hidden="true">
              <path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </label>
          <label className="tx-chip" data-active={selectedCountry !== "All"}>
            <span className="tx-chip-label">Country</span>
            <select
              className="tx-chip-select"
              value={selectedCountry}
              onChange={(e) => setSelectedCountry(e.target.value)}
            >
              <option value="All">All countries</option>
              {availableCountries.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name} ({c.count})
                </option>
              ))}
            </select>
            <svg className="tx-chip-caret" viewBox="0 0 12 12" aria-hidden="true">
              <path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </label>
          <label className="tx-chip" data-active={selectedAge !== "All"}>
            <span className="tx-chip-label">Age</span>
            <select
              className="tx-chip-select"
              value={selectedAge}
              onChange={(e) => setSelectedAge(e.target.value)}
            >
              <option value="All">All ages</option>
              {availableAges.map((a) => (
                <option key={a.name} value={a.name}>
                  {a.name} ({a.count})
                </option>
              ))}
            </select>
            <svg className="tx-chip-caret" viewBox="0 0 12 12" aria-hidden="true">
              <path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </label>
          <label className="tx-chip" data-active={windowHours !== 12}>
            <span className="tx-chip-label">Window</span>
            <select
              className="tx-chip-select"
              value={windowHours}
              onChange={(e) => {
                setWindowHours(Number(e.target.value));
                // A value present in one window may be absent in another; reset
                // every filter so none can point at a value that isn't there.
                setSelectedLanguage("All");
                setSelectedNative("All");
                setSelectedCountry("All");
                setSelectedAge("All");
              }}
            >
              {WINDOW_OPTIONS.map((w) => (
                <option key={w.hours} value={w.hours}>
                  {w.label}
                </option>
              ))}
            </select>
            <svg className="tx-chip-caret" viewBox="0 0 12 12" aria-hidden="true">
              <path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </label>
          <button
            className="tx-clear-btn"
            onClick={fetchRecent}
            disabled={loading}
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      <p className="ret-chart-sub" style={{ marginTop: "0.4rem" }}>
        Distinct users who completed a lesson in the {windowLabel.toLowerCase()},
        broken down by profile. Includes users of every payment status.
        {(selectedLanguage !== "All" ||
          selectedNative !== "All" ||
          selectedCountry !== "All" ||
          selectedAge !== "All") && (
          <>
            {" "}
            Segmented to{" "}
            {[
              selectedLanguage !== "All" && `learning ${selectedLanguage}`,
              selectedNative !== "All" && `native ${selectedNative}`,
              selectedCountry !== "All" && `from ${selectedCountry}`,
              selectedAge !== "All" && `aged ${selectedAge}`,
            ]
              .filter(Boolean)
              .join(", ")}
            .
          </>
        )}
      </p>

      {error && (
        <div className="error-box" style={{ margin: "1rem 0" }}>
          <p>Failed to load recent users: {error}</p>
        </div>
      )}

      {loading ? (
        <div style={{ textAlign: "center", padding: "3rem" }}>
          <div className="loading-spinner"></div>
          <p className="loading-text">Loading recent users…</p>
        </div>
      ) : users.length === 0 && !error ? (
        <div className="empty-state" style={{ padding: "2rem" }}>
          No users completed a lesson in the {windowLabel.toLowerCase()}.
        </div>
      ) : (
        <>
          <section className="metrics-grid" style={{ marginTop: "1rem" }}>
            <div className="metric-card">
              <div className="metric-value">{filteredUsers.length}</div>
              <div className="metric-label">Recent Users</div>
              <div className="metric-description">
                {selectedLanguage === "All" &&
                selectedNative === "All" &&
                selectedCountry === "All" &&
                selectedAge === "All"
                  ? "Completed a lesson"
                  : "Matching filters"}
              </div>
            </div>
            <div className="metric-card">
              <div className="metric-value">{filteredLessonCount}</div>
              <div className="metric-label">Lessons Completed</div>
              <div className="metric-description">In window</div>
            </div>
            <div className="metric-card">
              <div className="metric-value">
                {filteredUsers.length > 0
                  ? (filteredLessonCount / filteredUsers.length).toFixed(1)
                  : "0"}
              </div>
              <div className="metric-label">Avg Lessons / User</div>
              <div className="metric-description">In window</div>
            </div>
            <div className="metric-card">
              <div className="metric-value">{activeTrial}</div>
              <div className="metric-label">Active / Trial</div>
              <div className="metric-description">
                {filteredUsers.length > 0
                  ? `${((activeTrial / filteredUsers.length) * 100).toFixed(0)}% of recent`
                  : "—"}
              </div>
            </div>
          </section>

          <div className="recent-breakdowns-grid">
            <BreakdownCard title="Age" data={ageDistribution} color="#8b5cf6" />
            <BreakdownCard title="Country" data={countryDistribution} color="#6366f1" limit={12} />
            <BreakdownCard title="Gender" data={genderDistribution} color="#ec4899" />
            <BreakdownCard title="Native Language" data={nativeLangDistribution} color="#0ea5e9" limit={12} />
            <BreakdownCard title="Learning Language" data={learningLangDistribution} color="#14b8a6" limit={12} />
            <BreakdownCard title="Level" data={levelDistribution} color="#f59e0b" />
            <BreakdownCard title="Reason for Learning" data={reasonDistribution} color="#f97316" limit={12} />
            <BreakdownCard title="Acquisition Channel" data={attributionDistribution} color="#10b981" limit={12} />
            <BreakdownCard title="Platform" data={platformDistribution} color="#64748b" />
            <BreakdownCard title="Payment Status" data={statusDistribution} color="#22c55e" />
          </div>
        </>
      )}
    </div>
  );
};

export default RecentUsers;
