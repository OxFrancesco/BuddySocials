import { useMutation, useQuery } from "convex/react";
import { useCallback } from "react";
import { api } from "../../convex/_generated/api";
import { DEFAULT_LAYOUT, WIDGETS, newWidget, type WidgetInstance, type WidgetType } from "@shared/widgets";

/** The home layout, saved to Convex with optimistic updates so edits feel local. */
export function useLayout() {
  const widgets = useQuery(api.layouts.get, {});
  const save = useMutation(api.layouts.save).withOptimisticUpdate((store, args) => {
    store.setQuery(api.layouts.get, {}, args.widgets);
  });

  const current = widgets ?? null;
  const commit = useCallback((next: WidgetInstance[]) => void save({ widgets: next }), [save]);

  const update = (id: string, change: (widget: WidgetInstance) => WidgetInstance) => {
    if (!current) return;
    commit(current.map((widget) => (widget.id === id ? change(widget) : widget)));
  };

  return {
    widgets: current,
    replace: commit,
    update,
    remove(id: string) {
      if (!current) return;
      commit(current.filter((widget) => widget.id !== id));
    },
    add(type: WidgetType) {
      const base = current ?? DEFAULT_LAYOUT;
      const id = `${type}-${Date.now().toString(36)}`;
      commit([...base, newWidget(type, id)]);
      return id;
    },
    cycleSize(id: string) {
      update(id, (widget) => {
        const sizes = WIDGETS[widget.type].sizes;
        const next = sizes[(sizes.indexOf(widget.size) + 1) % sizes.length] ?? sizes[0]!;
        return { ...widget, size: next };
      });
    },
  };
}
