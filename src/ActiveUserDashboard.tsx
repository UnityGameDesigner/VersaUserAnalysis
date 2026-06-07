import React, { useState, useEffect, useMemo, useCallback } from "react";
import "./App.css";
import { supabase } from "./lib/supabase";
import { getCountryFromTimezone } from "./lib/timezone";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  type PieLabelRenderProps,
} from "recharts";
import { ResponsiveGridLayout as RGL, type Layout } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import {
  ComposableMap,
  Geographies,
  Geography,
  ZoomableGroup,
} from "react-simple-maps";

const GEO_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json";

// Our country name → topojson country name
const COUNTRY_TO_GEO_NAME: Record<string, string> = {
  "United States": "United States of America",
  "Czech Republic": "Czechia",
  "Dominican Republic": "Dominican Rep.",
  "Bosnia and Herzegovina": "Bosnia and Herz.",
  "North Macedonia": "Macedonia",
  "Ivory Coast": "Côte d'Ivoire",
  "DR Congo": "Dem. Rep. Congo",
  // These match directly and don't need mapping:
  // Canada, Mexico, Brazil, Argentina, etc.
};

interface ActiveUser {
  id: number;
  user_id: string;
  preferred_name: string | null;
  age: number | null;
  gender: string | null;
  native_language: string | null;
  tutor: string | null;
  daily_streak: number;
  last_logged_in: string | null;
  time_zone: string | null;
  attribution: string | null;
  payment_status: string;
  demand_tier: string | null;
}

// Format an ISO timestamp into a short, locale-aware date for table display.
// Returns "N/A" for missing or unparseable values.
function formatDate(iso: string | null | undefined): string {
  if (!iso) return "N/A";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "N/A" : d.toLocaleDateString();
}

const SUPABASE_TABLE_NAME = "user_info";

const COLORS = [
  "#6366f1", "#06b6d4", "#f59e0b", "#ef4444", "#8b5cf6",
  "#10b981", "#f97316", "#ec4899", "#14b8a6", "#84cc16",
];

const PieChartInner: React.FC<{
  data: { name: string; value: number }[];
  total: number;
  renderPieLabel: (props: PieLabelRenderProps) => React.ReactNode;
}> = ({ data, total, renderPieLabel }) => (
  <ResponsiveContainer width="100%" height="100%">
    <PieChart>
      <Pie
        data={data}
        cx="50%"
        cy="45%"
        labelLine={false}
        label={renderPieLabel}
        outerRadius={70}
        innerRadius={35}
        paddingAngle={2}
        dataKey="value"
        isAnimationActive={false}
      >
        {data.map((_, index) => (
          <Cell
            key={`cell-${index}`}
            fill={COLORS[index % COLORS.length]}
            stroke="#ffffff"
            strokeWidth={1}
          />
        ))}
      </Pie>
      <Tooltip
        formatter={(value: number | undefined) => {
          const v = value ?? 0;
          return [`${v} (${total > 0 ? ((v / total) * 100).toFixed(1) : 0}%)`];
        }}
      />
      <Legend />
    </PieChart>
  </ResponsiveContainer>
);

const ActiveUserDashboard: React.FC<{ onUserClick?: (userId: string) => void }> = ({ onUserClick }) => {
  const [users, setUsers] = useState<ActiveUser[]>([]);
  const [rawLessons, setRawLessons] = useState<{ user_id: string; created_at: string }[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  // Measure container width for grid layout
  const gridContainerRef = React.useRef<HTMLDivElement>(null);
  const [gridWidth, setGridWidth] = useState(1200);

  useEffect(() => {
    const el = gridContainerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setGridWidth(entry.contentRect.width);
      }
    });
    observer.observe(el);
    setGridWidth(el.clientWidth);
    return () => observer.disconnect();
  }, [loading]);
  const [error, setError] = useState<string | null>(null);
  const [selectedCountry, setSelectedCountry] = useState<string>("All");
  const [selectedAttribution, setSelectedAttribution] = useState<string>("All");
  const [selectedTutor, setSelectedTutor] = useState<string>("All");
  const [selectedAgeBucket, setSelectedAgeBucket] = useState<string>("All");
  const [selectedDemandTier, setSelectedDemandTier] = useState<string>("All");
  const [selectedStatus, setSelectedStatus] = useState<string>("All");
  const [selectedLanguage, setSelectedLanguage] = useState<string>("All");
  const [selectedGender, setSelectedGender] = useState<string>("All");
  const [sortBy, setSortBy] = useState<string>("lastLoggedIn");
  const mapTooltipRef = React.useRef<HTMLDivElement>(null);

  // Fetch only ACTIVE users. The user_info table holds ~163k rows, but ~99.7%
  // have a null payment_status and only ~421 are ACTIVE — loading the whole
  // table just to show active users stalls the page, so we filter server-side.
  useEffect(() => {
    const fetchUsers = async () => {
      setLoading(true);
      setError(null);

      try {
        const { count: totalCount, error: countError } = await supabase
          .from(SUPABASE_TABLE_NAME)
          .select("id", { count: "exact", head: true })
          .eq("payment_status", "ACTIVE");

        if (countError) {
          console.error("Count query error:", countError);
        } else {
          console.log("Server reports total ACTIVE rows:", totalCount);
        }

        const PAGE_SIZE = 1000;
        let allData: ActiveUser[] = [];
        let lastId = 0;
        let hasMore = true;

        while (hasMore) {
          const { data, error } = await supabase
            .from(SUPABASE_TABLE_NAME)
            .select(`
              id,
              user_id,
              preferred_name,
              age,
              gender,
              native_language,
              tutor,
              daily_streak,
              last_logged_in,
              time_zone,
              attribution,
              payment_status,
              demand_tier
            `)
            .eq("payment_status", "ACTIVE")
            .gt("id", lastId)
            .order("id", { ascending: true })
            .limit(PAGE_SIZE);

          if (error) {
            throw new Error(error.message || "Unknown Supabase error.");
          }

          if (data && data.length > 0) {
            allData = [...allData, ...data];
            lastId = data[data.length - 1].id;
            console.log(`Fetched ${data.length} rows (total so far: ${allData.length})`);
            hasMore = data.length === PAGE_SIZE;
          } else {
            hasMore = false;
          }
        }

        const seen = new Map<string, ActiveUser>();
        allData.forEach((u) => {
          if (!seen.has(u.user_id)) {
            seen.set(u.user_id, u);
          }
        });
        const deduped = Array.from(seen.values());
        deduped.sort((a, b) => {
          const aTime = a.last_logged_in ? new Date(a.last_logged_in).getTime() : 0;
          const bTime = b.last_logged_in ? new Date(b.last_logged_in).getTime() : 0;
          return bTime - aTime;
        });
        console.log(`Fetched ${allData.length} total rows, ${deduped.length} unique users`);
        setUsers(deduped);

        // Fetch completed lessons (only user_id + created_at) for engagement
        // charts, scoped to ACTIVE so we don't page the entire lessons table.
        let allLessons: { id: number; user_id: string; created_at: string }[] = [];
        lastId = 0;
        hasMore = true;

        while (hasMore) {
          const { data, error } = await supabase
            .from("completed_lessons")
            .select("id, user_id, created_at")
            .eq("payment_status", "ACTIVE")
            .gt("id", lastId)
            .order("id", { ascending: true })
            .limit(PAGE_SIZE);

          if (error) throw new Error(error.message);

          if (data && data.length > 0) {
            allLessons = [...allLessons, ...data];
            lastId = data[data.length - 1].id;
            hasMore = data.length === PAGE_SIZE;
          } else {
            hasMore = false;
          }
        }

        setRawLessons(allLessons.map((l) => ({ user_id: l.user_id, created_at: l.created_at })));
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Unknown error";
        console.error("Fetch Error:", e);
        setError(`Failed to fetch data: ${msg}`);
      } finally {
        setLoading(false);
      }
    };

    fetchUsers();
  }, []);

  // ── Helpers ──────────────────────────────────────
  const buildDistribution = (
    items: ActiveUser[],
    accessor: (u: ActiveUser) => string,
  ) => {
    const map = new Map<string, number>();
    items.forEach((u) => {
      const key = accessor(u);
      map.set(key, (map.get(key) || 0) + 1);
    });
    return Array.from(map.entries())
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
  };

  // ── Helper: age bucket for a user ─────────────────
  const getAgeBucket = (age: number | null): string => {
    if (age === null || age === -1) return "Unknown";
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
  };

  // ── Filter option lists ─────────────────
  const availableCountries = useMemo(() => {
    const countries = new Set<string>();
    users.forEach((u) => countries.add(getCountryFromTimezone(u.time_zone)));
    return ["All", ...Array.from(countries).sort()];
  }, [users]);

  const availableAttributions = useMemo(() => {
    const set = new Set<string>();
    users.forEach((u) => set.add(u.attribution || "Unknown"));
    return ["All", ...Array.from(set).sort()];
  }, [users]);

  const availableTutors = useMemo(() => {
    const set = new Set<string>();
    users.forEach((u) => set.add(u.tutor || "Unknown"));
    return ["All", ...Array.from(set).sort()];
  }, [users]);

  const availableAgeBuckets = useMemo(() => {
    const set = new Set<string>();
    users.forEach((u) => set.add(getAgeBucket(u.age)));
    const order = ["Under 18", "18-24", "25-34", "35-44", "45-54", "55+", "Unknown"];
    return ["All", ...order.filter((b) => set.has(b))];
  }, [users]);

  const availableLanguages = useMemo(() => {
    const set = new Set<string>();
    users.forEach((u) => set.add(u.native_language || "Unknown"));
    return ["All", ...Array.from(set).sort()];
  }, [users]);

  const availableDemandTiers = useMemo(() => {
    const set = new Set<string>();
    users.forEach((u) => { if (u.demand_tier) set.add(u.demand_tier); });
    return ["All", ...Array.from(set).sort()];
  }, [users]);

  const availableStatuses = useMemo(() => {
    const set = new Set<string>();
    users.forEach((u) => { if (u.payment_status) set.add(u.payment_status); });
    return ["All", ...Array.from(set).sort()];
  }, [users]);

  const availableGenders = useMemo(() => {
    const set = new Set<string>();
    users.forEach((u) => set.add(u.gender || "Unknown"));
    return ["All", ...Array.from(set).sort()];
  }, [users]);

  const filteredUsers = useMemo(() => {
    return users.filter((u) => {
      if (selectedCountry !== "All" && getCountryFromTimezone(u.time_zone) !== selectedCountry) return false;
      if (selectedAttribution !== "All" && (u.attribution || "Unknown") !== selectedAttribution) return false;
      if (selectedTutor !== "All" && (u.tutor || "Unknown") !== selectedTutor) return false;
      if (selectedAgeBucket !== "All" && getAgeBucket(u.age) !== selectedAgeBucket) return false;
      if (selectedDemandTier !== "All" && u.demand_tier !== selectedDemandTier) return false;
      if (selectedStatus !== "All" && u.payment_status !== selectedStatus) return false;
      if (selectedLanguage !== "All" && (u.native_language || "Unknown") !== selectedLanguage) return false;
      if (selectedGender !== "All" && (u.gender || "Unknown") !== selectedGender) return false;
      return true;
    });
  }, [users, selectedCountry, selectedAttribution, selectedTutor, selectedAgeBucket, selectedDemandTier, selectedStatus, selectedLanguage, selectedGender]);

  // ── First lesson completed map (user_id → earliest created_at) ──
  const firstLessonMap = useMemo(() => {
    const map = new Map<string, string>();
    rawLessons.forEach((l) => {
      const existing = map.get(l.user_id);
      if (!existing || l.created_at < existing) {
        map.set(l.user_id, l.created_at);
      }
    });
    return map;
  }, [rawLessons]);

  // ── Sorted users ──
  const sortedUsers = useMemo(() => {
    const sorted = [...filteredUsers];
    switch (sortBy) {
      case "firstLesson":
        sorted.sort((a, b) => {
          const aTime = firstLessonMap.get(a.user_id);
          const bTime = firstLessonMap.get(b.user_id);
          if (!aTime && !bTime) return 0;
          if (!aTime) return 1;
          if (!bTime) return -1;
          return new Date(aTime).getTime() - new Date(bTime).getTime();
        });
        break;
      case "firstLessonDesc":
        sorted.sort((a, b) => {
          const aTime = firstLessonMap.get(a.user_id);
          const bTime = firstLessonMap.get(b.user_id);
          if (!aTime && !bTime) return 0;
          if (!aTime) return 1;
          if (!bTime) return -1;
          return new Date(bTime).getTime() - new Date(aTime).getTime();
        });
        break;
      case "lastLoggedIn":
        sorted.sort((a, b) => {
          const aTime = a.last_logged_in ? new Date(a.last_logged_in).getTime() : 0;
          const bTime = b.last_logged_in ? new Date(b.last_logged_in).getTime() : 0;
          return bTime - aTime;
        });
        break;
      case "name":
        sorted.sort((a, b) =>
          (a.preferred_name || "").localeCompare(b.preferred_name || ""),
        );
        break;
      case "streak":
        sorted.sort((a, b) => b.daily_streak - a.daily_streak);
        break;
      case "age":
        sorted.sort((a, b) => {
          const aAge = a.age === null || a.age === -1 ? Infinity : a.age;
          const bAge = b.age === null || b.age === -1 ? Infinity : b.age;
          return aAge - bAge;
        });
        break;
      default:
        break;
    }
    return sorted;
  }, [filteredUsers, sortBy, firstLessonMap]);

  // ── Computed Data (all based on filteredUsers) ────
  const activeCount = useMemo(
    () => filteredUsers.filter((u) => u.payment_status === "ACTIVE").length,
    [filteredUsers],
  );
  const trialCount = useMemo(
    () => filteredUsers.filter((u) => u.payment_status === "TRIAL").length,
    [filteredUsers],
  );

  const genderDistribution = useMemo(
    () => buildDistribution(filteredUsers, (u) => u.gender || "Unknown"),
    [filteredUsers],
  );

  const languageDistribution = useMemo(
    () => buildDistribution(filteredUsers, (u) => u.native_language || "Unknown"),
    [filteredUsers],
  );

  const attributionDistribution = useMemo(
    () => buildDistribution(filteredUsers, (u) => u.attribution || "Unknown"),
    [filteredUsers],
  );

  const tutorDistribution = useMemo(
    () => buildDistribution(filteredUsers, (u) => u.tutor || "Unknown"),
    [filteredUsers],
  );

  const demandTierDistribution = useMemo(
    () => buildDistribution(
      filteredUsers.filter((u) => u.demand_tier != null),
      (u) => u.demand_tier!,
    ),
    [filteredUsers],
  );

  const countryDistribution = useMemo(
    () => buildDistribution(filteredUsers, (u) => getCountryFromTimezone(u.time_zone)),
    [filteredUsers],
  );

  // geo name → user count for the world map heatmap
  const countryGeoMap = useMemo(() => {
    const map = new Map<string, number>();
    countryDistribution.forEach(({ name, value }) => {
      const geoName = COUNTRY_TO_GEO_NAME[name] || name;
      map.set(geoName, value);
    });
    return map;
  }, [countryDistribution]);

  const maxCountryUsers = useMemo(
    () => Math.max(...countryDistribution.map((d) => d.value), 1),
    [countryDistribution],
  );

  const ageDistribution = useMemo(() => {
    const buckets: Record<string, number> = {
      "Under 18": 0,
      "18–22": 0,
      "23–27": 0,
      "28–32": 0,
      "33–37": 0,
      "38–42": 0,
      "43–47": 0,
      "48–52": 0,
      "53–57": 0,
      "58+": 0,
      "Unknown": 0,
    };
    filteredUsers.forEach((u) => {
      buckets[getAgeBucket(u.age)]++;
    });
    return Object.entries(buckets)
      .map(([name, value]) => ({ name, value }))
      .filter((d) => d.value > 0);
  }, [filteredUsers]);

  // ── Lesson engagement distributions (filtered by country) ──
  const filteredUserIds = useMemo(
    () => new Set(filteredUsers.map((u) => u.user_id)),
    [filteredUsers],
  );

  const lessonCountDist = useMemo(() => {
    const userCount = new Map<string, number>();
    rawLessons.forEach((l) => {
      if (!filteredUserIds.has(l.user_id)) return;
      userCount.set(l.user_id, (userCount.get(l.user_id) || 0) + 1);
    });
    const buckets = new Map<number, number>();
    userCount.forEach((count) => buckets.set(count, (buckets.get(count) || 0) + 1));
    return Array.from(buckets.entries())
      .map(([lessons, users]) => ({ name: String(lessons), value: users }))
      .sort((a, b) => parseInt(a.name) - parseInt(b.name));
  }, [rawLessons, filteredUserIds]);

  const lessonDaysDist = useMemo(() => {
    const userDays = new Map<string, Set<string>>();
    rawLessons.forEach((l) => {
      if (!filteredUserIds.has(l.user_id)) return;
      if (!userDays.has(l.user_id)) userDays.set(l.user_id, new Set());
      userDays.get(l.user_id)!.add(l.created_at.slice(0, 10));
    });
    const buckets = new Map<number, number>();
    userDays.forEach((days) => buckets.set(days.size, (buckets.get(days.size) || 0) + 1));
    return Array.from(buckets.entries())
      .map(([days, users]) => ({ name: String(days), value: users }))
      .sort((a, b) => parseInt(a.name) - parseInt(b.name));
  }, [rawLessons, filteredUserIds]);

  // ── Pie label renderer ─────────────────────────
  const renderPieLabel = ({
    cx,
    cy,
    midAngle = 0,
    innerRadius = 0,
    outerRadius = 0,
    percent = 0,
    name = "",
  }: PieLabelRenderProps) => {
    const RADIAN = Math.PI / 180;
    const radius = 20 + innerRadius + (outerRadius - innerRadius);
    const x = cx + radius * Math.cos(-midAngle * RADIAN);
    const y = cy + radius * Math.sin(-midAngle * RADIAN);

    if (percent < 0.04) return null;

    return (
      <text
        x={x}
        y={y}
        fill="#6b7280"
        textAnchor={x > cx ? "start" : "end"}
        dominantBaseline="central"
        style={{ fontSize: "11px", fontWeight: 500 }}
      >
        {`${name} (${(percent * 100).toFixed(0)}%)`}
      </text>
    );
  };

  // ── Reusable chart components ──────────────────
  const total = filteredUsers.length;

  // ── Grid layout (drag + resize) ─────────────────
  const LAYOUT_STORAGE_KEY = "versa-dashboard-chart-layouts-v2";

  const defaultLayouts: { lg: Layout[] } = {
    lg: [
      { i: "worldMap", x: 0, y: 0, w: 4, h: 4, minW: 3, minH: 3 },
      { i: "country", x: 4, y: 0, w: 4, h: 4, minW: 3, minH: 3 },
      { i: "gender", x: 8, y: 0, w: 4, h: 4, minW: 3, minH: 3 },
      { i: "age", x: 0, y: 4, w: 4, h: 4, minW: 3, minH: 3 },
      { i: "language", x: 4, y: 4, w: 4, h: 4, minW: 3, minH: 3 },
      { i: "attribution", x: 8, y: 4, w: 4, h: 4, minW: 3, minH: 3 },
      { i: "tutor", x: 0, y: 8, w: 4, h: 4, minW: 3, minH: 3 },
      { i: "demand", x: 4, y: 8, w: 4, h: 4, minW: 3, minH: 3 },
      { i: "lessonCount", x: 8, y: 8, w: 4, h: 4, minW: 3, minH: 3 },
      { i: "lessonDays", x: 0, y: 12, w: 4, h: 4, minW: 3, minH: 3 },
    ],
  };

  const loadLayouts = () => {
    try {
      const saved = localStorage.getItem(LAYOUT_STORAGE_KEY);
      if (saved) return JSON.parse(saved);
    } catch { /* ignore */ }
    return defaultLayouts;
  };

  const [gridLayouts, setGridLayouts] = useState(loadLayouts);

  const handleLayoutChange = useCallback((_current: Layout[], allLayouts: { [key: string]: Layout[] }) => {
    setGridLayouts(allLayouts);
    try {
      localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(allLayouts));
    } catch { /* ignore */ }
  }, []);

  // ── Loading state ──────────────────────────────
  if (loading) {
    return (
      <div className="dashboard-container">
        <div className="dashboard-inner">
          <header className="dashboard-header">
            <div className="header-left">
              <img src="AppIcon.png" alt="Versa Logo" className="versa-logo" />
              <h1 style={{ color: "#1a1a2e", marginLeft: "0.75rem", fontSize: "1.25rem", fontWeight: 600 }}>
                Versa User Analysis
              </h1>
            </div>
          </header>
          <div className="loading-container">
            <div style={{ textAlign: "center" }}>
              <div className="loading-spinner"></div>
              <p className="loading-text">Loading active user data...</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="dashboard-container">
        <div className="dashboard-inner">
          <header className="dashboard-header">
            <div className="header-left">
              <img src="AppIcon.png" alt="Versa Logo" className="versa-logo" />
            </div>
          </header>
          <div className="error-box">
            <h2 className="error-title">Error Connecting to Supabase</h2>
            <p>{error}</p>
            <p className="error-tip">
              Please ensure your Supabase RLS allows read access to the '
              {SUPABASE_TABLE_NAME}' table AND that your environment variables
              are correctly configured.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // ── Main dashboard ─────────────────────────────
  return (
    <div className="dashboard-content-area">
      {/* Filters bar above charts */}
      <section className="filters-bar">
        <div className="filters-bar-inner">
          <div className="filter-dropdown-group">
            <label htmlFor="country-filter" className="filter-label">Country</label>
            <select id="country-filter" value={selectedCountry} onChange={(e) => setSelectedCountry(e.target.value)} className="filter-select">
              {availableCountries.map((c) => (
                <option key={c} value={c}>{c === "All" ? `All Countries (${users.length})` : c}</option>
              ))}
            </select>
          </div>

          <div className="filter-dropdown-group">
            <label htmlFor="attribution-filter" className="filter-label">Attribution</label>
            <select id="attribution-filter" value={selectedAttribution} onChange={(e) => setSelectedAttribution(e.target.value)} className="filter-select">
              {availableAttributions.map((a) => (
                <option key={a} value={a}>{a === "All" ? "All Sources" : a}</option>
              ))}
            </select>
          </div>

          <div className="filter-dropdown-group">
            <label htmlFor="tutor-filter" className="filter-label">Tutor</label>
            <select id="tutor-filter" value={selectedTutor} onChange={(e) => setSelectedTutor(e.target.value)} className="filter-select">
              {availableTutors.map((t) => (
                <option key={t} value={t}>{t === "All" ? "All Tutors" : t}</option>
              ))}
            </select>
          </div>

          <div className="filter-dropdown-group">
            <label htmlFor="age-filter" className="filter-label">Age Group</label>
            <select id="age-filter" value={selectedAgeBucket} onChange={(e) => setSelectedAgeBucket(e.target.value)} className="filter-select">
              {availableAgeBuckets.map((a) => (
                <option key={a} value={a}>{a === "All" ? "All Ages" : a}</option>
              ))}
            </select>
          </div>

          <div className="filter-dropdown-group">
            <label htmlFor="language-filter" className="filter-label">Language</label>
            <select id="language-filter" value={selectedLanguage} onChange={(e) => setSelectedLanguage(e.target.value)} className="filter-select">
              {availableLanguages.map((l) => (
                <option key={l} value={l}>{l === "All" ? "All Languages" : l}</option>
              ))}
            </select>
          </div>

          <div className="filter-dropdown-group">
            <label htmlFor="demand-filter" className="filter-label">Demand Tier</label>
            <select id="demand-filter" value={selectedDemandTier} onChange={(e) => setSelectedDemandTier(e.target.value)} className="filter-select">
              {availableDemandTiers.map((d) => (
                <option key={d} value={d}>{d === "All" ? "All Tiers" : d}</option>
              ))}
            </select>
          </div>

          <div className="filter-dropdown-group">
            <label htmlFor="status-filter" className="filter-label">Status</label>
            <select id="status-filter" value={selectedStatus} onChange={(e) => setSelectedStatus(e.target.value)} className="filter-select">
              {availableStatuses.map((s) => (
                <option key={s} value={s}>{s === "All" ? "All Statuses" : s}</option>
              ))}
            </select>
          </div>

          <div className="filter-dropdown-group">
            <label htmlFor="gender-filter" className="filter-label">Gender</label>
            <select id="gender-filter" value={selectedGender} onChange={(e) => setSelectedGender(e.target.value)} className="filter-select">
              {availableGenders.map((g) => (
                <option key={g} value={g}>{g === "All" ? "All Genders" : g}</option>
              ))}
            </select>
          </div>

          {(selectedCountry !== "All" || selectedAttribution !== "All" || selectedTutor !== "All" || selectedAgeBucket !== "All" || selectedDemandTier !== "All" || selectedStatus !== "All" || selectedLanguage !== "All" || selectedGender !== "All") && (
            <button
              className="filters-clear-btn"
              onClick={() => {
                setSelectedCountry("All");
                setSelectedAttribution("All");
                setSelectedTutor("All");
                setSelectedAgeBucket("All");
                setSelectedDemandTier("All");
                setSelectedStatus("All");
                setSelectedLanguage("All");
                setSelectedGender("All");
              }}
            >
              Clear All
            </button>
          )}

          <span className="filters-count">{filteredUsers.length} users</span>
        </div>
      </section>

      {/* KPI Cards */}
      <section className="metrics-grid">
          <div className="metric-card">
            <div className="metric-value">{filteredUsers.length}</div>
            <div className="metric-label">Active Users</div>
            <div className="metric-description">
              {selectedCountry === "All" ? "All countries" : selectedCountry}
            </div>
          </div>
          <div className="metric-card">
            <div className="metric-value">{activeCount}</div>
            <div className="metric-label">Active</div>
            <div className="metric-description">Paying subscribers</div>
          </div>
          <div className="metric-card">
            <div className="metric-value">{trialCount}</div>
            <div className="metric-label">Trial</div>
            <div className="metric-description">Currently on trial</div>
          </div>
          <div className="metric-card">
            <div className="metric-value">
              {filteredUsers.length > 0
                ? ((activeCount / filteredUsers.length) * 100).toFixed(1)
                : 0}
              %
            </div>
            <div className="metric-label">Active Rate</div>
            <div className="metric-description">Active / total</div>
          </div>
          <div className="metric-card">
            <div className="metric-value">
              {filteredUsers.length > 0
                ? (
                    filteredUsers.reduce((s, u) => s + (u.daily_streak || 0), 0) /
                    filteredUsers.length
                  ).toFixed(1)
                : 0}
            </div>
            <div className="metric-label">Avg Streak</div>
            <div className="metric-description">Average daily streak</div>
          </div>
        </section>

        {/* Charts — draggable & resizable */}
        <div ref={gridContainerRef}>
        <RGL
          className="charts-grid-layout"
          width={gridWidth}
          breakpoints={{ lg: 1024, md: 768, sm: 480 }}
          cols={{ lg: 12, md: 8, sm: 4 }}
          rowHeight={80}
          layouts={gridLayouts}
          onLayoutChange={handleLayoutChange}
          draggableHandle=".chart-drag-handle"
          isResizable
          isDraggable
          margin={[20, 20] as [number, number]}
          containerPadding={[0, 0] as [number, number]}
          compactType="vertical"
          preventCollision={false}
        >
          <div key="worldMap" className="chart-container">
            <h3 className="chart-drag-handle">World Map</h3>
            <div ref={mapTooltipRef} className="world-map-tooltip" />
            <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
              <ComposableMap
                projectionConfig={{ scale: 147, center: [0, 20] }}
                width={800}
                height={400}
                style={{ width: "100%", height: "100%" }}
              >
                <ZoomableGroup>
                  <Geographies geography={GEO_URL}>
                    {({ geographies }) =>
                      geographies.map((geo) => {
                        const geoName = geo.properties.name;
                        const count = countryGeoMap.get(geoName) || 0;
                        const intensity = count > 0 ? Math.max(0.15, count / maxCountryUsers) : 0;
                        return (
                          <Geography
                            key={geo.rsmKey}
                            geography={geo}
                            fill={count > 0 ? `rgba(99, 102, 241, ${intensity})` : "#f0f0f0"}
                            stroke="#d1d5db"
                            strokeWidth={0.5}
                            onMouseEnter={(e: React.MouseEvent) => {
                              const tip = mapTooltipRef.current;
                              if (!tip) return;
                              tip.innerHTML = `<strong>${geoName}</strong>: ${count} user${count !== 1 ? "s" : ""}`;
                              tip.style.display = "block";
                              tip.style.left = e.clientX + "px";
                              tip.style.top = e.clientY + "px";
                            }}
                            onMouseMove={(e: React.MouseEvent) => {
                              const tip = mapTooltipRef.current;
                              if (!tip) return;
                              tip.style.left = e.clientX + "px";
                              tip.style.top = e.clientY + "px";
                            }}
                            onMouseLeave={() => {
                              const tip = mapTooltipRef.current;
                              if (tip) tip.style.display = "none";
                            }}
                            style={{
                              default: { outline: "none" },
                              hover: { outline: "none", fill: count > 0 ? "#6366f1" : "#e5e7eb" },
                              pressed: { outline: "none" },
                            }}
                          />
                        );
                      })
                    }
                  </Geographies>
                </ZoomableGroup>
              </ComposableMap>
            </div>
          </div>

          <div key="country" className="chart-container">
            <h3 className="chart-drag-handle">Users by Country</h3>
            <div style={{ flex: 1, minHeight: 0 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={countryDistribution.slice(0, 8)} layout="vertical" margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 11 }} />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 12 }} width={110} interval={0} />
                  <Tooltip formatter={(value: number | undefined) => { const v = value ?? 0; return [`${v} (${total > 0 ? ((v / total) * 100).toFixed(1) : 0}%)`]; }} />
                  <Bar dataKey="value" name="Users" fill="#6366f1" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div key="gender" className="chart-container">
            <h3 className="chart-drag-handle">Gender Distribution</h3>
            <div style={{ flex: 1, minHeight: 0 }}>
              <PieChartInner data={genderDistribution} total={total} renderPieLabel={renderPieLabel} />
            </div>
          </div>

          <div key="age" className="chart-container">
            <h3 className="chart-drag-handle">Age Distribution</h3>
            <div style={{ flex: 1, minHeight: 0 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={ageDistribution} layout="vertical" margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 11 }} />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 12 }} width={110} interval={0} />
                  <Tooltip formatter={(value: number | undefined) => { const v = value ?? 0; return [`${v} (${total > 0 ? ((v / total) * 100).toFixed(1) : 0}%)`]; }} />
                  <Bar dataKey="value" name="Users" fill="#8b5cf6" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div key="language" className="chart-container">
            <h3 className="chart-drag-handle">Native Language</h3>
            <div style={{ flex: 1, minHeight: 0 }}>
              <PieChartInner data={languageDistribution.slice(0, 8)} total={total} renderPieLabel={renderPieLabel} />
            </div>
          </div>

          <div key="attribution" className="chart-container">
            <h3 className="chart-drag-handle">Attribution Source</h3>
            <div style={{ flex: 1, minHeight: 0 }}>
              <PieChartInner data={attributionDistribution} total={total} renderPieLabel={renderPieLabel} />
            </div>
          </div>

          <div key="tutor" className="chart-container">
            <h3 className="chart-drag-handle">Tutor Selection</h3>
            <div style={{ flex: 1, minHeight: 0 }}>
              <PieChartInner data={tutorDistribution.slice(0, 8)} total={total} renderPieLabel={renderPieLabel} />
            </div>
          </div>

          {demandTierDistribution.length > 0 && (
            <div key="demand" className="chart-container">
              <h3 className="chart-drag-handle">Demand Tier</h3>
              <div style={{ flex: 1, minHeight: 0 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={demandTierDistribution} layout="vertical" margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" horizontal={false} />
                    <XAxis type="number" tick={{ fontSize: 11 }} />
                    <YAxis type="category" dataKey="name" tick={{ fontSize: 12 }} width={110} interval={0} />
                    <Tooltip formatter={(value: number | undefined) => { const v = value ?? 0; return [`${v} (${total > 0 ? ((v / total) * 100).toFixed(1) : 0}%)`]; }} />
                    <Bar dataKey="value" name="Users" fill="#06b6d4" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {lessonCountDist.length > 0 && (
            <div key="lessonCount" className="chart-container">
              <h3 className="chart-drag-handle">Users by Lessons Completed</h3>
              <div style={{ flex: 1, minHeight: 0 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={lessonCountDist} margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                    <XAxis dataKey="name" tick={{ fontSize: 11 }} label={{ value: "Lessons completed", position: "insideBottom", offset: -2, fontSize: 12 }} />
                    <YAxis tick={{ fontSize: 11 }} label={{ value: "Users", angle: -90, position: "insideLeft", fontSize: 12 }} />
                    <Tooltip />
                    <Bar dataKey="value" name="Users" fill="#6366f1" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {lessonDaysDist.length > 0 && (
            <div key="lessonDays" className="chart-container">
              <h3 className="chart-drag-handle">Users by Unique Days Active</h3>
              <div style={{ flex: 1, minHeight: 0 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={lessonDaysDist} margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                    <XAxis dataKey="name" tick={{ fontSize: 11 }} label={{ value: "Unique days", position: "insideBottom", offset: -2, fontSize: 12 }} />
                    <YAxis tick={{ fontSize: 11 }} label={{ value: "Users", angle: -90, position: "insideLeft", fontSize: 12 }} />
                    <Tooltip />
                    <Bar dataKey="value" name="Users" fill="#10b981" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
        </RGL>
        </div>

        {/* User Table */}
        <main className="dashboard-main">
          <div className="controls-bar" style={{ display: "flex", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
            <h2 className="results-heading" style={{ margin: 0 }}>
              Users ({filteredUsers.length} total)
            </h2>
            <label className="filter-label" style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
              Sort by:
              <select
                className="filter-select"
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
              >
                <option value="lastLoggedIn">Last Logged In</option>
                <option value="firstLesson">First Lesson (oldest first)</option>
                <option value="firstLessonDesc">First Lesson (newest first)</option>
                <option value="name">Name (A-Z)</option>
                <option value="streak">Streak (highest first)</option>
                <option value="age">Age (youngest first)</option>
              </select>
            </label>
          </div>

          <div className="user-list-container">
            {sortedUsers.length === 0 ? (
              <div className="empty-state">
                No active or trial users found.
              </div>
            ) : (
              <div className="table-container">
                <table className="data-table">
                  <thead className="table-head">
                    <tr>
                      <th>Name</th>
                      <th>Status</th>
                      <th>Country</th>
                      <th>Language</th>
                      <th>Age</th>
                      <th>Gender</th>
                      <th>Streak</th>
                      <th>Tutor</th>
                      <th>Tier</th>
                      <th>Source</th>
                      <th>Last Login</th>
                      <th>First Lesson</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody className="table-body">
                    {sortedUsers.map((user) => {
                      const profileUrl = `${window.location.pathname}${window.location.search}#user-lookup:${user.user_id}`;
                      return (
                      <tr
                        key={user.user_id}
                        className={onUserClick ? "table-row--clickable" : ""}
                        onClick={(e) => {
                          if (e.metaKey || e.ctrlKey) {
                            window.open(profileUrl, "_blank");
                            return;
                          }
                          onUserClick?.(user.user_id);
                        }}
                        onAuxClick={(e) => {
                          if (e.button === 1) {
                            e.preventDefault();
                            window.open(profileUrl, "_blank");
                          }
                        }}
                      >
                        <td>{user.preferred_name || "N/A"}</td>
                        <td>
                          {(() => {
                            const status = user.payment_status || "";
                            const variant =
                              status === "ACTIVE"
                                ? "paying"
                                : status === "TRIAL"
                                ? "trial"
                                : "free";
                            const label = status
                              ? status.charAt(0) + status.slice(1).toLowerCase()
                              : "N/A";
                            return (
                              <span className={`plan-pill plan-pill--${variant}`}>
                                {label}
                              </span>
                            );
                          })()}
                        </td>
                        <td>{getCountryFromTimezone(user.time_zone)}</td>
                        <td>{user.native_language || "N/A"}</td>
                        <td>
                          {user.age === null || user.age === -1
                            ? "N/A"
                            : user.age}
                        </td>
                        <td>{user.gender || "N/A"}</td>
                        <td>{user.daily_streak}</td>
                        <td>{user.tutor || "N/A"}</td>
                        <td>
                          {user.demand_tier ? (
                            <span
                              className={`tier-pill tier-pill--${user.demand_tier.toLowerCase()}`}
                            >
                              {user.demand_tier}
                            </span>
                          ) : (
                            "N/A"
                          )}
                        </td>
                        <td>
                          <span className="attribution-pill">
                            {user.attribution || "N/A"}
                          </span>
                        </td>
                        <td>{formatDate(user.last_logged_in)}</td>
                        <td>{formatDate(firstLessonMap.get(user.user_id))}</td>
                        <td>
                          <a
                            href={profileUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            title="Open profile in new tab"
                            style={{
                              textDecoration: "none",
                              color: "#6b7280",
                              fontSize: "1rem",
                              padding: "0 0.25rem",
                            }}
                          >
                            ↗
                          </a>
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </main>
    </div>
  );
};

export default ActiveUserDashboard;
