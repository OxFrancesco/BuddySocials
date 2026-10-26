import { useEffect, useState } from "react";
import { useWindowDimensions } from "react-native";
import { dayKey } from "@shared/format";
import { WIDE } from "@/theme";

/** Today's UTC day key, refreshed when the day rolls over. */
export function useToday(): string {
  const [today, setToday] = useState(() => dayKey(Date.now()));
  useEffect(() => {
    const now = Date.now();
    const nextMidnight = Date.parse(`${dayKey(now)}T00:00:00.000Z`) + 86_400_000;
    const timer = setTimeout(() => setToday(dayKey(Date.now())), nextMidnight - now + 1000);
    return () => clearTimeout(timer);
  }, [today]);
  return today;
}

/** Wall clock rounded to the hour so time-bounded queries keep a stable cache key. */
export function useHour(): number {
  const [hour, setHour] = useState(() => Math.floor(Date.now() / 3_600_000) * 3_600_000);
  useEffect(() => {
    const timer = setTimeout(() => setHour(Math.floor(Date.now() / 3_600_000) * 3_600_000), hour + 3_600_000 - Date.now() + 1000);
    return () => clearTimeout(timer);
  }, [hour]);
  return hour;
}

/** Ticks every minute for relative timestamps. */
export function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function useWide(): boolean {
  return useWindowDimensions().width >= WIDE;
}
