/**
 * Declarative layout engine.
 *
 * The LLM declares intent ("row", "column", "grid") on each group. The MCP
 * computes every x/y/w/h bottom-up from children's intrinsic sizes. Overrides
 * any coords the LLM may have passed — declarative wins over imperative.
 *
 * Leaf nodes get their size from COMPONENT_STYLES vs icon defaults. Groups
 * get their size from the bounding box of their positioned children plus
 * padding. Root-level items laid out as a horizontal row with a fixed gap.
 */

import type { DiagramNode, DiagramGroup, GroupLayout } from "./shape-resolver.js";

// Layout spacing constants — tuned for visual consistency with the imperative
// constants in shape-resolver.ts. Kept local here so this module is self-contained.
const PAD_X = 25;
const PAD_TOP = 30;
const PAD_BOT = 20;
const ROW_GAP_ICON = 50;
const ROW_GAP_COMPONENT = 30;
const ROW_GAP_GROUP = 30;
const COL_GAP_ICON = 70;
const COL_GAP_COMPONENT = 50;
const COL_GAP_GROUP = 30;
const GRID_GAP = 40;
const ROOT_GAP = 60;
const ROOT_X = 20;
const ROOT_Y = 20;

interface Sized {
  id: string;
  w: number;
  h: number;
}

/**
 * Walk the group tree bottom-up and assign x/y/w/h to every node and group
 * whose parent has a `layout` directive. Mutates inputs in place.
 *
 * Returns true if ANY group declared a layout, signalling the caller to skip
 * legacy imperative positioning.
 */
export function applyDeclarativeLayout(
  nodes: DiagramNode[],
  groups: DiagramGroup[],
  getIntrinsicSize: (id: string) => { w: number; h: number },
  getGapMode: (id: string) => "icon" | "component" | "group",
): boolean {
  const hasAnyLayout = groups.some((g) => g.layout);
  if (!hasAnyLayout) return false;

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const groupMap = new Map(groups.map((g) => [g.id, g]));

  // Parent lookup: childId → parent groupId
  const parentOf = new Map<string, string>();
  for (const g of groups) {
    for (const cid of g.children ?? []) parentOf.set(cid, g.id);
  }

  // Depth (root groups = 0, deepest = highest). Process deepest first so
  // sub-groups have dimensions before their parents reference them.
  const depthCache = new Map<string, number>();
  const depthOf = (id: string): number => {
    const cached = depthCache.get(id);
    if (cached !== undefined) return cached;
    const p = parentOf.get(id);
    const d = p ? depthOf(p) + 1 : 0;
    depthCache.set(id, d);
    return d;
  };

  const sizedOf = (id: string): Sized => {
    const g = groupMap.get(id);
    if (g) return { id, w: g.w ?? 100, h: g.h ?? 60 };
    const sz = getIntrinsicSize(id);
    return { id, w: sz.w, h: sz.h };
  };

  const byDepthDesc = [...groups].sort(
    (a, b) => depthOf(b.id) - depthOf(a.id),
  );

  // Process each group bottom-up. Position its children (using their already-
  // computed sizes) and size the group itself to match.
  for (const g of byDepthDesc) {
    if (!g.layout) continue; // skip imperative groups — caller handles them
    const childIds = g.children ?? [];
    if (childIds.length === 0) {
      g.w = g.w ?? 100;
      g.h = g.h ?? 60;
      continue;
    }

    const children = childIds
      .map((cid) => {
        const sz = sizedOf(cid);
        const refExists = nodeMap.has(cid) || groupMap.has(cid);
        return refExists ? sz : null;
      })
      .filter((c): c is Sized => c !== null);

    // All children share the same GAP category within a given group: if the
    // children are heterogeneous (mixed icon + component), prefer the larger
    // gap so they breathe.
    const mode = children.every((c) => getGapMode(c.id) === "icon")
      ? "icon"
      : children.every((c) => getGapMode(c.id) === "component")
        ? "component"
        : "group";

    const place = (cid: string, x: number, y: number) => {
      const n = nodeMap.get(cid);
      if (n) {
        n.x = x;
        n.y = y;
        return;
      }
      const gg = groupMap.get(cid);
      if (gg) {
        gg.x = x;
        gg.y = y;
      }
    };

    const { w, h } = layOutChildren(g.layout, children, mode, place);
    g.w = w;
    g.h = h;
  }

  // Root-level layout: two rows.
  //   Row 1 (top) = root GROUPS (Internet, Region, etc.).
  //   Row 2 (below) = root NODES — which are conventionally callouts pointing
  //   up into services. Positioned under Row 1 with ROOT_GAP between rows.
  const rootGroups = groups.filter((g) => !parentOf.has(g.id));
  const rootNodes = nodes.filter((n) => !parentOf.has(n.id));

  let rowX = ROOT_X;
  let rowMaxH = 0;
  for (const g of rootGroups) {
    const sz = sizedOf(g.id);
    g.x = rowX;
    g.y = ROOT_Y;
    rowX += sz.w + ROOT_GAP;
    rowMaxH = Math.max(rowMaxH, sz.h);
  }

  if (rootNodes.length > 0) {
    const calloutY = ROOT_Y + rowMaxH + ROOT_GAP;
    let calloutX = ROOT_X;
    for (const n of rootNodes) {
      const sz = sizedOf(n.id);
      n.x = calloutX;
      n.y = calloutY;
      calloutX += sz.w + ROOT_GAP;
    }
  }

  return true;
}

/** Place `children` according to `layout` and return the required parent size. */
function layOutChildren(
  layout: GroupLayout,
  children: Sized[],
  mode: "icon" | "component" | "group",
  place: (id: string, x: number, y: number) => void,
): { w: number; h: number } {
  if (layout === "row") {
    const gap =
      mode === "icon" ? ROW_GAP_ICON : mode === "component" ? ROW_GAP_COMPONENT : ROW_GAP_GROUP;
    let cursor = PAD_X;
    let maxH = 0;
    for (const c of children) {
      place(c.id, cursor, PAD_TOP);
      cursor += c.w + gap;
      maxH = Math.max(maxH, c.h);
    }
    const w = cursor - gap + PAD_X;
    const h = PAD_TOP + maxH + PAD_BOT;
    return { w, h };
  }

  if (layout === "column") {
    const gap =
      mode === "icon" ? COL_GAP_ICON : mode === "component" ? COL_GAP_COMPONENT : COL_GAP_GROUP;
    let cursor = PAD_TOP;
    let maxW = 0;
    for (const c of children) {
      place(c.id, PAD_X, cursor);
      cursor += c.h + gap;
      maxW = Math.max(maxW, c.w);
    }
    const w = PAD_X + maxW + PAD_X;
    const h = cursor - gap + PAD_BOT;
    return { w, h };
  }

  // grid: approx-square, fill left-to-right then wrap
  const cols = Math.ceil(Math.sqrt(children.length));
  const cellW = Math.max(...children.map((c) => c.w));
  const cellH = Math.max(...children.map((c) => c.h));
  for (let i = 0; i < children.length; i++) {
    const row = Math.floor(i / cols);
    const col = i % cols;
    place(
      children[i].id,
      PAD_X + col * (cellW + GRID_GAP),
      PAD_TOP + row * (cellH + GRID_GAP),
    );
  }
  const rows = Math.ceil(children.length / cols);
  const w = PAD_X + cols * cellW + (cols - 1) * GRID_GAP + PAD_X;
  const h = PAD_TOP + rows * cellH + (rows - 1) * GRID_GAP + PAD_BOT;
  return { w, h };
}
