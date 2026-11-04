import { format } from "date-fns";

// Plan / money formatting shared by the Revenue tab (src/Revenue.tsx) and its
// Lapsed users view (src/LapsedUsers.tsx).

// Fixed order = fixed color: a bucket keeps its hue whatever the filter shows.
export const BUCKETS = ["Monthly", "Yearly", "3-month", "Weekly", "One-off"] as const;
export const BUCKET_COLORS: Record<string, string> = {
  Monthly: "#2a78d6",
  Yearly: "#eb6834",
  "3-month": "#1baf7a",
  Weekly: "#eda100",
  "One-off": "#e87ba4",
};

export const num = (v: unknown) => (v == null ? 0 : Number(v));

export function usd(v: number, digits = 0): string {
  return v.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

// Store product ids are opaque ("versa_1y_premium:one-month-eight"); the part
// after the base-plan prefix is the readable bit.
export function planName(id: string | null): string {
  if (!id) return "—";
  const parts = id.split(":");
  return parts.length > 1 && parts[0] === "versa_1y_premium" ? parts.slice(1).join(":") : id;
}

export function statusVariant(s: string | null): string {
  if (s === "ACTIVE") return "paying";
  if (s === "TRIAL") return "trial";
  if (s === "PAST_DUE") return "pastdue";
  return "free";
}

export const fmtDate = (iso: string | null) => (iso ? format(new Date(iso), "MMM d, yyyy") : "—");
