import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { optionalOwner, requireOwner } from "./lib/owner";
import { platformValidator } from "./validators";
import { addDays } from "../shared/format";
import { currentWindow, goalPace, goalTitle, previousWindow, type GoalState } from "../shared/goals";
import { metricValue } from "../shared/metrics";

const STREAK_LOOKBACK = 12;
const DAY_MS = 86_400_000;

const goalMetricValidator = v.union(
  v.literal("views"),
  v.literal("likes"),
  v.literal("comments"),
  v.literal("shares"),
  v.literal("followers"),
  v.literal("engagement"),
  v.literal("posts"),
);

const goalFields = {
  metric: goalMetricValidator,
  platform: v.union(v.literal("all"), platformValidator),
  target: v.number(),
  period: v.union(v.literal("week"), v.literal("month"), v.literal("range")),
  repeat: v.boolean(),
  startDay: v.string(),
  endDay: v.string(),
};

/** Per-day totals for one goal's metric and platform, over [from, to]. */
async function dailyValues(ctx: QueryCtx, goal: Doc<"goals">, from: string, to: string): Promise<Map<string, number>> {
  const values = new Map<string, number>();
  if (goal.metric === "posts") {
    const start = Date.parse(`${from}T00:00:00.000Z`);
    const end = Date.parse(`${to}T00:00:00.000Z`) + DAY_MS;
    const platform = goal.platform;
    const posts =
      platform === "all"
        ? await ctx.db
            .query("posts")
            .withIndex("by_owner_and_publishedAt", (q) => q.eq("owner", goal.owner).gte("publishedAt", start).lt("publishedAt", end))
            .take(2000)
        : await ctx.db
            .query("posts")
            .withIndex("by_owner_and_platform_and_publishedAt", (q) =>
              q.eq("owner", goal.owner).eq("platform", platform).gte("publishedAt", start).lt("publishedAt", end),
            )
            .take(2000);
    for (const post of posts) {
      const day = new Date(post.publishedAt).toISOString().slice(0, 10);
      values.set(day, (values.get(day) ?? 0) + 1);
    }
    return values;
  }
  const rows = await ctx.db
    .query("dailyStats")
    .withIndex("by_owner_and_day", (q) => q.eq("owner", goal.owner).gte("day", from).lte("day", to))
    .take(2000);
  for (const row of rows) {
    if (goal.platform !== "all" && row.platform !== goal.platform) continue;
    values.set(row.day, (values.get(row.day) ?? 0) + metricValue(row, goal.metric));
  }
  return values;
}

function sumRange(values: Map<string, number>, start: string, end: string): number {
  let total = 0;
  for (let day = start; day <= end; day = addDays(day, 1)) total += values.get(day) ?? 0;
  return total;
}

export type GoalView = {
  _id: Doc<"goals">["_id"];
  title: string;
  metric: Doc<"goals">["metric"];
  platform: Doc<"goals">["platform"];
  target: number;
  period: Doc<"goals">["period"];
  repeat: boolean;
  startDay: string;
  endDay: string;
  window: { start: string; end: string };
  value: number;
  expected: number;
  progress: number;
  elapsedShare: number;
  daysLeft: number;
  state: GoalState;
  /** Consecutive earlier periods hit, for repeating goals. */
  streak: number;
  /** Earlier periods hit within the lookback. */
  hits: number;
  celebrate: boolean;
};

export const list = query({
  args: { today: v.string() },
  handler: async (ctx, args): Promise<{ goals: GoalView[]; hits: number } | null> => {
    const owner = await optionalOwner(ctx);
    if (owner === null) return null;
    const goals = await ctx.db
      .query("goals")
      .withIndex("by_owner", (q) => q.eq("owner", owner))
      .take(50);
    let hits = 0;
    const views: GoalView[] = [];
    for (const goal of goals) {
      const window = currentWindow(goal, args.today);
      const created = new Date(goal.createdAt).toISOString().slice(0, 10);
      // One read covers the current window and the streak lookback.
      let from = window.start;
      const earlier: { start: string; end: string }[] = [];
      if (goal.repeat) {
        let previous = previousWindow(goal, window.start);
        for (let i = 0; i < STREAK_LOOKBACK && previous.end >= created; i++) {
          earlier.push(previous);
          from = previous.start;
          previous = previousWindow(goal, previous.start);
        }
      }
      const values = await dailyValues(ctx, goal, from, window.end < args.today ? window.end : args.today);
      const value = sumRange(values, window.start, window.end);
      const pace = goalPace(value, goal.target, window, args.today);
      let streak = 0;
      let goalHits = pace.state === "done" ? 1 : 0;
      let unbroken = true;
      for (const period of earlier) {
        const hit = sumRange(values, period.start, period.end) >= goal.target;
        if (hit) goalHits++;
        if (unbroken && hit) streak++;
        else unbroken = false;
      }
      hits += goalHits;
      views.push({
        _id: goal._id,
        title: goalTitle(goal),
        metric: goal.metric,
        platform: goal.platform,
        target: goal.target,
        period: goal.period,
        repeat: goal.repeat,
        startDay: goal.startDay,
        endDay: goal.endDay,
        window,
        value,
        expected: pace.expected,
        progress: pace.progress,
        elapsedShare: pace.elapsedShare,
        daysLeft: pace.daysLeft,
        state: pace.state,
        streak,
        hits: goalHits,
        celebrate: pace.state === "done" && goal.celebrated !== window.start,
      });
    }
    const order: Record<GoalState, number> = { behind: 0, ahead: 1, upcoming: 2, done: 3, missed: 4 };
    views.sort((a, b) => order[a.state] - order[b.state] || b.progress - a.progress);
    return { goals: views, hits };
  },
});

function validate(fields: { target: number; startDay: string; endDay: string }) {
  if (!Number.isFinite(fields.target) || fields.target <= 0) throw new Error("Set a target above zero.");
  if (fields.target > 1e12) throw new Error("That target is too large.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fields.startDay) || !/^\d{4}-\d{2}-\d{2}$/.test(fields.endDay)) {
    throw new Error("Pick a valid period.");
  }
  if (fields.endDay < fields.startDay) throw new Error("The period ends before it starts.");
}

export const create = mutation({
  args: goalFields,
  handler: async (ctx, args) => {
    const owner = await requireOwner(ctx);
    validate(args);
    const count = (await ctx.db.query("goals").withIndex("by_owner", (q) => q.eq("owner", owner)).take(50)).length;
    if (count >= 50) throw new Error("You already have 50 goals.");
    return await ctx.db.insert("goals", { ...args, target: Math.round(args.target), owner, createdAt: Date.now() });
  },
});

export const update = mutation({
  args: { goalId: v.id("goals"), ...goalFields },
  handler: async (ctx, { goalId, ...fields }) => {
    const owner = await requireOwner(ctx);
    validate(fields);
    const goal = await ctx.db.get("goals", goalId);
    if (goal === null || goal.owner !== owner) throw new Error("Goal not found.");
    await ctx.db.patch("goals", goalId, { ...fields, target: Math.round(fields.target) });
  },
});

export const remove = mutation({
  args: { goalId: v.id("goals") },
  handler: async (ctx, args) => {
    const owner = await requireOwner(ctx);
    const goal = await ctx.db.get("goals", args.goalId);
    if (goal === null || goal.owner !== owner) return;
    await ctx.db.delete("goals", args.goalId);
  },
});

/** Marks the current period's completion as seen so the celebration plays once. */
export const markCelebrated = mutation({
  args: { goalId: v.id("goals"), windowStart: v.string() },
  handler: async (ctx, args) => {
    const owner = await requireOwner(ctx);
    const goal = await ctx.db.get("goals", args.goalId);
    if (goal === null || goal.owner !== owner) return;
    await ctx.db.patch("goals", args.goalId, { celebrated: args.windowStart });
  },
});
