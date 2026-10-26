import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { optionalOwner, requireOwner } from "./lib/owner";
import { widgetValidator } from "./validators";
import { DEFAULT_LAYOUT, MAX_WIDGETS, sanitizeWidget, type WidgetInstance } from "../shared/widgets";

export const get = query({
  args: {},
  handler: async (ctx): Promise<WidgetInstance[] | null> => {
    const owner = await optionalOwner(ctx);
    if (owner === null) return null;
    const layout = await ctx.db
      .query("layouts")
      .withIndex("by_owner", (q) => q.eq("owner", owner))
      .unique();
    return layout === null ? DEFAULT_LAYOUT : layout.widgets;
  },
});

export const save = mutation({
  args: { widgets: v.array(widgetValidator) },
  handler: async (ctx, args) => {
    const owner = await requireOwner(ctx);
    const seen = new Set<string>();
    const widgets = args.widgets
      .map(sanitizeWidget)
      .filter((widget): widget is WidgetInstance => {
        if (widget === null || seen.has(widget.id)) return false;
        seen.add(widget.id);
        return true;
      })
      .slice(0, MAX_WIDGETS);
    const existing = await ctx.db
      .query("layouts")
      .withIndex("by_owner", (q) => q.eq("owner", owner))
      .unique();
    if (existing === null) {
      await ctx.db.insert("layouts", { owner, widgets, updatedAt: Date.now() });
    } else {
      await ctx.db.patch("layouts", existing._id, { widgets, updatedAt: Date.now() });
    }
  },
});

/** Dev helper: drops saved layouts so everyone falls back to the default. */
export const resetAllInternal = internalMutation({
  args: {},
  handler: async (ctx) => {
    const layouts = await ctx.db.query("layouts").take(100);
    for (const layout of layouts) await ctx.db.delete("layouts", layout._id);
    return layouts.length;
  },
});
