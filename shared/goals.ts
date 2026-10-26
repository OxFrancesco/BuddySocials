import { addDays, compact, daysBetween } from "./format";
import { PLATFORM_LABEL, type Platform } from "./platforms";

export const GOAL_METRICS = ["views", "likes", "comments", "shares", "followers", "engagement", "posts"] as const;
export type GoalMetric = (typeof GOAL_METRICS)[number];

export const GOAL_METRIC_LABEL: Record<GoalMetric, string> = {
  views: "Views",
  likes: "Likes",
  comments: "Comments",
  shares: "Shares",
  followers: "New followers",
  engagement: "Interactions",
  posts: "Posts",
};

export type GoalPeriod = "week" | "month" | "range";

export type GoalShape = {
  metric: GoalMetric;
  platform: Platform | "all";
  target: number;
  period: GoalPeriod;
  repeat: boolean;
  startDay: string;
  endDay: string;
};

/** Weeks start on Monday, in UTC like every other stored day. */
export function weekOf(day: string): { start: string; end: string } {
  const weekday = (new Date(`${day}T00:00:00.000Z`).getUTCDay() + 6) % 7;
  const start = addDays(day, -weekday);
  return { start, end: addDays(start, 6) };
}

export function monthOf(day: string): { start: string; end: string } {
  const [year, month] = day.split("-").map(Number) as [number, number];
  const start = `${year}-${String(month).padStart(2, "0")}-01`;
  const next = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`;
  return { start, end: addDays(next, -1) };
}

/** The window the goal is measured over today. Repeating goals roll with the calendar. */
export function currentWindow(goal: GoalShape, today: string): { start: string; end: string } {
  if (goal.repeat && goal.period === "week") return weekOf(today);
  if (goal.repeat && goal.period === "month") return monthOf(today);
  return { start: goal.startDay, end: goal.endDay };
}

export function previousWindow(goal: GoalShape, start: string): { start: string; end: string } {
  return goal.period === "month" ? monthOf(addDays(start, -1)) : weekOf(addDays(start, -1));
}

/** "10K views on X", "5 posts", "500 new followers on LinkedIn". */
export function goalTitle(goal: Pick<GoalShape, "metric" | "platform" | "target">): string {
  const amount = goal.target >= 10_000 ? compact(goal.target) : goal.target.toLocaleString("en-US");
  const noun = GOAL_METRIC_LABEL[goal.metric].toLowerCase();
  return goal.platform === "all" ? `${amount} ${noun}` : `${amount} ${noun} on ${PLATFORM_LABEL[goal.platform]}`;
}

export type GoalState = "done" | "ahead" | "behind" | "missed" | "upcoming";

/** Where the goal stands, and how much of the target the elapsed time asks for so far. */
export function goalPace(value: number, target: number, window: { start: string; end: string }, today: string) {
  const total = daysBetween(window.start, window.end) + 1;
  const elapsed = Math.min(total, Math.max(0, daysBetween(window.start, today) + 1));
  const expected = target * (elapsed / total);
  const daysLeft = Math.max(0, total - elapsed);
  let state: GoalState;
  if (value >= target) state = "done";
  else if (today < window.start) state = "upcoming";
  else if (today > window.end) state = "missed";
  else state = value >= expected ? "ahead" : "behind";
  return { expected, daysLeft, state, progress: target > 0 ? value / target : 0, elapsedShare: elapsed / total };
}
