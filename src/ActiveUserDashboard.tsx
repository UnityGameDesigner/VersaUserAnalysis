import React, { useState, useEffect, useMemo, useCallback } from "react";
import "./App.css";
import { supabase } from "./lib/supabase";
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

// ── Timezone → Country mapping ──────────────────
const TZ_TO_COUNTRY: Record<string, string> = {
  // Americas
  "America/New_York": "United States",
  "America/Chicago": "United States",
  "America/Denver": "United States",
  "America/Los_Angeles": "United States",
  "America/Phoenix": "United States",
  "America/Anchorage": "United States",
  "America/Honolulu": "United States",
  "America/Detroit": "United States",
  "America/Indiana/Indianapolis": "United States",
  "America/Boise": "United States",
  "America/Juneau": "United States",
  "America/Adak": "United States",
  "America/Nome": "United States",
  "America/Sitka": "United States",
  "America/Yakutat": "United States",
  "America/Menominee": "United States",
  "America/Kentucky/Louisville": "United States",
  "America/Kentucky/Monticello": "United States",
  "America/Indiana/Knox": "United States",
  "America/Indiana/Marengo": "United States",
  "America/Indiana/Petersburg": "United States",
  "America/Indiana/Tell_City": "United States",
  "America/Indiana/Vevay": "United States",
  "America/Indiana/Vincennes": "United States",
  "America/Indiana/Winamac": "United States",
  "America/North_Dakota/Beulah": "United States",
  "America/North_Dakota/Center": "United States",
  "America/North_Dakota/New_Salem": "United States",
  "US/Eastern": "United States",
  "US/Central": "United States",
  "US/Mountain": "United States",
  "US/Pacific": "United States",
  "US/Alaska": "United States",
  "US/Hawaii": "United States",
  "America/Toronto": "Canada",
  "America/Vancouver": "Canada",
  "America/Edmonton": "Canada",
  "America/Winnipeg": "Canada",
  "America/Halifax": "Canada",
  "America/St_Johns": "Canada",
  "America/Regina": "Canada",
  "Canada/Eastern": "Canada",
  "Canada/Central": "Canada",
  "Canada/Mountain": "Canada",
  "Canada/Pacific": "Canada",
  "Canada/Atlantic": "Canada",
  "America/Mexico_City": "Mexico",
  "America/Cancun": "Mexico",
  "America/Tijuana": "Mexico",
  "America/Monterrey": "Mexico",
  "America/Merida": "Mexico",
  "America/Chihuahua": "Mexico",
  "America/Hermosillo": "Mexico",
  "America/Mazatlan": "Mexico",
  "America/Sao_Paulo": "Brazil",
  "America/Fortaleza": "Brazil",
  "America/Recife": "Brazil",
  "America/Bahia": "Brazil",
  "America/Manaus": "Brazil",
  "America/Belem": "Brazil",
  "America/Cuiaba": "Brazil",
  "America/Campo_Grande": "Brazil",
  "America/Porto_Velho": "Brazil",
  "America/Rio_Branco": "Brazil",
  "America/Buenos_Aires": "Argentina",
  "America/Argentina/Buenos_Aires": "Argentina",
  "America/Argentina/Cordoba": "Argentina",
  "America/Bogota": "Colombia",
  "America/Lima": "Peru",
  "America/Santiago": "Chile",
  "America/Caracas": "Venezuela",
  "America/Guayaquil": "Ecuador",
  "America/La_Paz": "Bolivia",
  "America/Asuncion": "Paraguay",
  "America/Montevideo": "Uruguay",
  "America/Panama": "Panama",
  "America/Guatemala": "Guatemala",
  "America/Costa_Rica": "Costa Rica",
  "America/Havana": "Cuba",
  "America/Santo_Domingo": "Dominican Republic",
  "America/Port-au-Prince": "Haiti",
  "America/Jamaica": "Jamaica",
  "America/Port_of_Spain": "Trinidad and Tobago",
  "America/Tegucigalpa": "Honduras",
  "America/El_Salvador": "El Salvador",
  "America/Managua": "Nicaragua",
  // Europe
  "Europe/London": "United Kingdom",
  "Europe/Paris": "France",
  "Europe/Berlin": "Germany",
  "Europe/Madrid": "Spain",
  "Europe/Rome": "Italy",
  "Europe/Amsterdam": "Netherlands",
  "Europe/Brussels": "Belgium",
  "Europe/Zurich": "Switzerland",
  "Europe/Vienna": "Austria",
  "Europe/Stockholm": "Sweden",
  "Europe/Oslo": "Norway",
  "Europe/Copenhagen": "Denmark",
  "Europe/Helsinki": "Finland",
  "Europe/Warsaw": "Poland",
  "Europe/Prague": "Czech Republic",
  "Europe/Budapest": "Hungary",
  "Europe/Bucharest": "Romania",
  "Europe/Sofia": "Bulgaria",
  "Europe/Athens": "Greece",
  "Europe/Istanbul": "Turkey",
  "Europe/Moscow": "Russia",
  "Europe/Kiev": "Ukraine",
  "Europe/Kyiv": "Ukraine",
  "Europe/Lisbon": "Portugal",
  "Europe/Dublin": "Ireland",
  "Europe/Belgrade": "Serbia",
  "Europe/Zagreb": "Croatia",
  "Europe/Bratislava": "Slovakia",
  "Europe/Ljubljana": "Slovenia",
  "Europe/Tallinn": "Estonia",
  "Europe/Riga": "Latvia",
  "Europe/Vilnius": "Lithuania",
  "Europe/Minsk": "Belarus",
  "Europe/Chisinau": "Moldova",
  "Europe/Tirane": "Albania",
  "Europe/Skopje": "North Macedonia",
  "Europe/Sarajevo": "Bosnia and Herzegovina",
  "Europe/Podgorica": "Montenegro",
  "Europe/Luxembourg": "Luxembourg",
  "Europe/Malta": "Malta",
  // Asia
  "Asia/Tokyo": "Japan",
  "Asia/Seoul": "South Korea",
  "Asia/Shanghai": "China",
  "Asia/Chongqing": "China",
  "Asia/Hong_Kong": "Hong Kong",
  "Asia/Taipei": "Taiwan",
  "Asia/Singapore": "Singapore",
  "Asia/Kuala_Lumpur": "Malaysia",
  "Asia/Bangkok": "Thailand",
  "Asia/Jakarta": "Indonesia",
  "Asia/Makassar": "Indonesia",
  "Asia/Jayapura": "Indonesia",
  "Asia/Pontianak": "Indonesia",
  "Asia/Manila": "Philippines",
  "Asia/Ho_Chi_Minh": "Vietnam",
  "Asia/Saigon": "Vietnam",
  "Asia/Kolkata": "India",
  "Asia/Calcutta": "India",
  "Asia/Colombo": "Sri Lanka",
  "Asia/Dhaka": "Bangladesh",
  "Asia/Karachi": "Pakistan",
  "Asia/Kathmandu": "Nepal",
  "Asia/Yangon": "Myanmar",
  "Asia/Phnom_Penh": "Cambodia",
  "Asia/Vientiane": "Laos",
  "Asia/Dubai": "United Arab Emirates",
  "Asia/Riyadh": "Saudi Arabia",
  "Asia/Qatar": "Qatar",
  "Asia/Bahrain": "Bahrain",
  "Asia/Kuwait": "Kuwait",
  "Asia/Muscat": "Oman",
  "Asia/Tehran": "Iran",
  "Asia/Baghdad": "Iraq",
  "Asia/Beirut": "Lebanon",
  "Asia/Jerusalem": "Israel",
  "Asia/Tel_Aviv": "Israel",
  "Asia/Amman": "Jordan",
  "Asia/Damascus": "Syria",
  "Asia/Almaty": "Kazakhstan",
  "Asia/Tashkent": "Uzbekistan",
  "Asia/Tbilisi": "Georgia",
  "Asia/Yerevan": "Armenia",
  "Asia/Baku": "Azerbaijan",
  "Asia/Ulaanbaatar": "Mongolia",
  // Africa
  "Africa/Cairo": "Egypt",
  "Africa/Lagos": "Nigeria",
  "Africa/Nairobi": "Kenya",
  "Africa/Johannesburg": "South Africa",
  "Africa/Casablanca": "Morocco",
  "Africa/Algiers": "Algeria",
  "Africa/Tunis": "Tunisia",
  "Africa/Accra": "Ghana",
  "Africa/Addis_Ababa": "Ethiopia",
  "Africa/Dar_es_Salaam": "Tanzania",
  "Africa/Kampala": "Uganda",
  "Africa/Khartoum": "Sudan",
  "Africa/Abidjan": "Ivory Coast",
  "Africa/Dakar": "Senegal",
  "Africa/Kinshasa": "DR Congo",
  "Africa/Luanda": "Angola",
  "Africa/Maputo": "Mozambique",
  "Africa/Harare": "Zimbabwe",
  // Oceania
  "Australia/Sydney": "Australia",
  "Australia/Melbourne": "Australia",
  "Australia/Brisbane": "Australia",
  "Australia/Perth": "Australia",
  "Australia/Adelaide": "Australia",
  "Australia/Hobart": "Australia",
  "Australia/Darwin": "Australia",
  "Australia/Canberra": "Australia",
  "Pacific/Auckland": "New Zealand",
  "Pacific/Chatham": "New Zealand",
  "Pacific/Fiji": "Fiji",
  "Pacific/Guam": "Guam",
  "Pacific/Honolulu": "United States",
  // Common aliases
  "GMT": "United Kingdom",
  "UTC": "Unknown",
  "EST": "United States",
  "CST": "United States",
  "MST": "United States",
  "PST": "United States",
};

function getCountryFromTimezone(tz: string | null): string {
  if (!tz) return "Unknown";
  if (TZ_TO_COUNTRY[tz]) return TZ_TO_COUNTRY[tz];

  // Fallback: try to infer from the region prefix
  const parts = tz.split("/");
  if (parts.length >= 2) {
    const region = parts[0];
    // Check all known TZs with same prefix for a majority country
    const matches = Object.entries(TZ_TO_COUNTRY).filter(
      ([key]) => key.startsWith(region + "/"),
    );
    if (matches.length > 0) {
      // Return the timezone as-is if we can't map it
      return tz;
    }
  }
  return tz || "Unknown";
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
  const mapTooltipRef = React.useRef<HTMLDivElement>(null);

  // Fetch only ACTIVE and TRIAL users
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
            console.log(`ACTIVE page: fetched ${data.length} rows (total so far: ${allData.length})`);
            hasMore = data.length === PAGE_SIZE;
          } else {
            hasMore = false;
          }
        }

        lastId = 0;
        hasMore = true;

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
            .eq("payment_status", "TRIAL")
            .gt("id", lastId)
            .order("id", { ascending: true })
            .limit(PAGE_SIZE);

          if (error) {
            throw new Error(error.message || "Unknown Supabase error.");
          }

          if (data && data.length > 0) {
            allData = [...allData, ...data];
            lastId = data[data.length - 1].id;
            console.log(`TRIAL page: fetched ${data.length} rows (total so far: ${allData.length})`);
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

        // Fetch completed lessons (only user_id + created_at) for engagement charts
        let allLessons: { id: number; user_id: string; created_at: string }[] = [];
        lastId = 0;
        hasMore = true;

        while (hasMore) {
          const { data, error } = await supabase
            .from("completed_lessons")
            .select("id, user_id, created_at")
            .in("payment_status", ["ACTIVE", "TRIAL"])
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

  // ── Country list + filtered users ─────────────────
  const availableCountries = useMemo(() => {
    const countries = new Set<string>();
    users.forEach((u) => countries.add(getCountryFromTimezone(u.time_zone)));
    return ["All", ...Array.from(countries).sort()];
  }, [users]);

  const filteredUsers = useMemo(() => {
    if (selectedCountry === "All") return users;
    return users.filter(
      (u) => getCountryFromTimezone(u.time_zone) === selectedCountry,
    );
  }, [users, selectedCountry]);

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
    () => buildDistribution(users, (u) => getCountryFromTimezone(u.time_zone)),
    [users],
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
      "18-24": 0,
      "25-34": 0,
      "35-44": 0,
      "45-54": 0,
      "55+": 0,
      "Unknown": 0,
    };
    filteredUsers.forEach((u) => {
      const age = u.age;
      if (age === null || age === -1) buckets["Unknown"]++;
      else if (age < 18) buckets["Under 18"]++;
      else if (age <= 24) buckets["18-24"]++;
      else if (age <= 34) buckets["25-34"]++;
      else if (age <= 44) buckets["35-44"]++;
      else if (age <= 54) buckets["45-54"]++;
      else buckets["55+"]++;
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
  const LAYOUT_STORAGE_KEY = "versa-dashboard-chart-layouts";

  const defaultLayouts: { lg: Layout[] } = {
    lg: [
      { i: "country", x: 0, y: 0, w: 4, h: 4, minW: 3, minH: 3 },
      { i: "gender", x: 4, y: 0, w: 4, h: 4, minW: 3, minH: 3 },
      { i: "age", x: 8, y: 0, w: 4, h: 4, minW: 3, minH: 3 },
      { i: "language", x: 0, y: 4, w: 4, h: 4, minW: 3, minH: 3 },
      { i: "attribution", x: 4, y: 4, w: 4, h: 4, minW: 3, minH: 3 },
      { i: "tutor", x: 8, y: 4, w: 4, h: 4, minW: 3, minH: 3 },
      { i: "demand", x: 0, y: 8, w: 4, h: 4, minW: 3, minH: 3 },
      { i: "lessonCount", x: 4, y: 8, w: 4, h: 4, minW: 3, minH: 3 },
      { i: "lessonDays", x: 8, y: 8, w: 4, h: 4, minW: 3, minH: 3 },
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
    <div className="dashboard-container">
      <div className="dashboard-inner">
        <header className="dashboard-header">
          <div className="header-left">
            <img src="AppIcon.png" alt="Versa Logo" className="versa-logo" />
            <h1 style={{ color: "#1a1a2e", marginLeft: "0.75rem", fontSize: "1.25rem", fontWeight: 600 }}>
              Versa User Analysis
            </h1>
          </div>
          <div className="filter-dropdown-group">
            <label htmlFor="country-filter" className="filter-label">
              Filter by Country:
            </label>
            <select
              id="country-filter"
              value={selectedCountry}
              onChange={(e) => setSelectedCountry(e.target.value)}
              className="filter-select"
            >
              {availableCountries.map((c) => (
                <option key={c} value={c}>
                  {c === "All" ? `All Countries (${users.length})` : c}
                </option>
              ))}
            </select>
          </div>
        </header>

        {/* World Map Heatmap */}
        <section className="world-map-container">
          <h3 className="world-map-title">Paid Users by Country</h3>
          <div ref={mapTooltipRef} className="world-map-tooltip" />
          <ComposableMap
            projectionConfig={{ scale: 147, center: [0, 20] }}
            width={800}
            height={400}
            style={{ width: "100%", height: "auto", maxHeight: "500px" }}
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
          <div className="world-map-legend">
            <span className="world-map-legend-label">0</span>
            <div className="world-map-legend-bar" />
            <span className="world-map-legend-label">{maxCountryUsers}</span>
            <span className="world-map-legend-suffix">users</span>
          </div>
        </section>

        {/* KPI Cards */}
        <section className="metrics-grid">
          <div className="metric-card">
            <div className="metric-value">{filteredUsers.length}</div>
            <div className="metric-label">Total Active/Trial</div>
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
          <div className="controls-bar">
            <h2 className="results-heading">
              Users ({filteredUsers.length} total)
            </h2>
          </div>

          <div className="user-list-container">
            {filteredUsers.length === 0 ? (
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
                      <th>Source</th>
                    </tr>
                  </thead>
                  <tbody className="table-body">
                    {filteredUsers.map((user) => (
                      <tr
                        key={user.user_id}
                        className={onUserClick ? "table-row--clickable" : ""}
                        onClick={() => onUserClick?.(user.user_id)}
                      >
                        <td>{user.preferred_name || "N/A"}</td>
                        <td>
                          <span
                            className={`plan-pill plan-pill--${user.payment_status === "ACTIVE" ? "paying" : "trial"}`}
                          >
                            {user.payment_status === "ACTIVE"
                              ? "Active"
                              : "Trial"}
                          </span>
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
                          <span className="attribution-pill">
                            {user.attribution || "N/A"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
};

export default ActiveUserDashboard;
