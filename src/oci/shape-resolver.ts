/**
 * Resolves OCI shape slugs to full mxGraphModel XML.
 * Handles: decode compressed shape XML, remap IDs, position, relabel,
 * generate edges, compose into single diagram.
 */

import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import { fileURLToPath } from "url";
import { getShapeBySlug, searchShapes, type CatalogEntry } from "./shape-catalog.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, "..", "..", "data");

interface ShapeData {
  xml: string;
  w: number;
  h: number;
  title: string;
}

let shapesDb: Record<string, ShapeData> | null = null;

function loadShapes(): Record<string, ShapeData> {
  if (!shapesDb) {
    const raw = fs.readFileSync(path.join(dataDir, "oci-shapes.json"), "utf8");
    shapesDb = JSON.parse(raw);
  }
  return shapesDb!;
}

function decodeShapeXml(base64Xml: string): string {
  const buf = Buffer.from(base64Xml, "base64");
  const inflated = zlib.inflateRawSync(buf);
  return decodeURIComponent(inflated.toString());
}

export interface DiagramNode {
  id: string;
  shape: string; // slug or search term
  label: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
}

export interface DiagramConnection {
  from: string;
  to: string;
  label?: string;
}

export interface DiagramGroup {
  id: string;
  shape: string; // slug for a grouping shape
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  children?: string[]; // node IDs that belong to this group
}

interface ResolvedCell {
  id: string;
  attrs: Record<string, string>;
  geometryXml: string;
}

/**
 * Find the shape entry for a given slug or search query.
 * Tries exact slug match first, then searches.
 */
function resolveShape(shapeRef: string): { catalog: CatalogEntry; data: ShapeData } | null {
  const shapes = loadShapes();

  // Try exact slug match
  const catalogEntry = getShapeBySlug(shapeRef);
  if (catalogEntry) {
    const data = shapes[String(catalogEntry.id)];
    if (data) return { catalog: catalogEntry, data };
  }

  // Try search
  const results = searchShapes(shapeRef);
  if (results.length > 0) {
    const entry = results[0];
    const data = shapes[String(entry.id)];
    if (data) return { catalog: entry, data };
  }

  return null;
}

/**
 * Parse mxCell elements from decoded XML using regex (avoids full XML parser dependency for simple extraction).
 */
function extractCells(decodedXml: string): { id: string; parentId: string; attrs: string; geometryXml: string }[] {
  const cells: { id: string; parentId: string; attrs: string; geometryXml: string }[] = [];

  // Match self-closing mxCell tags
  const selfClosingRegex = /<mxCell\s+([^>]*?)\/>/g;
  let match;
  while ((match = selfClosingRegex.exec(decodedXml)) !== null) {
    const attrsStr = match[1];
    const id = getAttr(attrsStr, "id") || "";
    const parentId = getAttr(attrsStr, "parent") || "";
    cells.push({ id, parentId, attrs: attrsStr, geometryXml: "" });
  }

  // Match mxCell with children (geometry)
  const cellWithChildrenRegex = /<mxCell\s+([^>]*?)>([\s\S]*?)<\/mxCell>/g;
  while ((match = cellWithChildrenRegex.exec(decodedXml)) !== null) {
    const attrsStr = match[1];
    const children = match[2];
    const id = getAttr(attrsStr, "id") || "";
    const parentId = getAttr(attrsStr, "parent") || "";
    cells.push({ id, parentId, attrs: attrsStr, geometryXml: children.trim() });
  }

  return cells;
}

function getAttr(attrsStr: string, name: string): string | null {
  const regex = new RegExp(`${name}="([^"]*)"`, "i");
  const m = attrsStr.match(regex);
  return m ? m[1] : null;
}

function setAttr(attrsStr: string, name: string, value: string): string {
  const regex = new RegExp(`${name}="[^"]*"`, "i");
  if (regex.test(attrsStr)) {
    return attrsStr.replace(regex, `${name}="${value}"`);
  }
  return `${attrsStr} ${name}="${value}"`;
}

/**
 * Build the cells for a single shape node, with remapped IDs and positioning.
 * For multi-cell shapes, wraps everything in a group container at the user's position.
 * Returns the anchor cell ID (the group wrapper or single cell) for edge connections.
 */
function buildNodeCells(
  node: DiagramNode,
  shapeData: ShapeData,
  idCounter: { value: number },
  parentCellId?: string,
): { cellXmls: string[]; anchorId: string } {
  const xml = decodeShapeXml(shapeData.xml);
  const cells = extractCells(xml);

  const contentCells = cells.filter((c) => c.id !== "0" && c.id !== "1");
  const rootCells = contentCells.filter((c) => c.parentId === "1");

  const actualParent = parentCellId || "1";
  const output: string[] = [];

  // For single-cell shapes (grouping, connectors, simple shapes) — no wrapping needed
  if (rootCells.length === 1 && contentCells.length === 1) {
    const cell = contentCells[0];
    const cellId = `n_${node.id}_${idCounter.value++}`;
    let attrs = cell.attrs;
    attrs = setAttr(attrs, "id", cellId);
    attrs = setAttr(attrs, "parent", actualParent);

    if (node.label) {
      attrs = replaceLabel(attrs, node.label);
    }

    let geo = cell.geometryXml;
    if (geo) {
      geo = setGeoPosition(geo, node.x, node.y);
    } else {
      geo = `<mxGeometry x="${node.x}" y="${node.y}" width="${shapeData.w}" height="${shapeData.h}" as="geometry"/>`;
    }

    output.push(`<mxCell ${attrs}>${geo}</mxCell>`);
    return { cellXmls: output, anchorId: cellId };
  }

  // Multi-cell shapes: wrap in a group container at the user's position
  const groupId = `n_${node.id}_${idCounter.value++}`;
  output.push(
    `<mxCell id="${groupId}" value="" style="group;pointerEvents=0;" vertex="1" connectable="1" parent="${actualParent}">` +
    `<mxGeometry x="${node.x}" y="${node.y}" width="${shapeData.w}" height="${shapeData.h}" as="geometry"/>` +
    `</mxCell>`,
  );

  // Remap IDs for all content cells
  const idMap = new Map<string, string>();
  for (const cell of contentCells) {
    idMap.set(cell.id, `n_${node.id}_${idCounter.value++}`);
  }

  // All cells go inside the group; root cells get parent=groupId
  for (const cell of contentCells) {
    let attrs = cell.attrs;
    const newId = idMap.get(cell.id)!;
    attrs = setAttr(attrs, "id", newId);

    // Parent: root cells → group; child cells → remapped parent
    const newParent = cell.parentId === "1" ? groupId : (idMap.get(cell.parentId) || groupId);
    attrs = setAttr(attrs, "parent", newParent);

    // Replace label on cells that have a value attribute
    if (node.label) {
      attrs = replaceLabel(attrs, node.label);
    }

    const geo = cell.geometryXml;
    if (geo) {
      output.push(`<mxCell ${attrs}>${geo}</mxCell>`);
    } else {
      output.push(`<mxCell ${attrs}/>`);
    }
  }

  return { cellXmls: output, anchorId: groupId };
}

function setGeoPosition(geoXml: string, x: number, y: number): string {
  // Replace or add x/y in mxGeometry
  let result = geoXml;
  if (/x="[^"]*"/.test(result)) {
    result = result.replace(/x="[^"]*"/, `x="${x}"`);
  } else {
    result = result.replace("<mxGeometry", `<mxGeometry x="${x}"`);
  }
  if (/y="[^"]*"/.test(result)) {
    result = result.replace(/y="[^"]*"/, `y="${y}"`);
  } else {
    result = result.replace("<mxGeometry", `<mxGeometry y="${y}"`);
  }
  return result;
}

function replaceLabel(attrs: string, newLabel: string): string {
  const valueMatch = attrs.match(/value="([^"]*)"/);
  if (valueMatch) {
    const oldValue = valueMatch[1];
    // If it's HTML-encoded content (&lt;div...&gt;), replace with clean HTML label
    if (oldValue.includes("&lt;") || oldValue.includes("&amp;lt;")) {
      const newValue = `&lt;div style=&quot;font-size: 1px&quot;&gt;&lt;p style=&quot;align:center;margin:0;valign:middle;&quot;&gt;&lt;font style=&quot;font-size:12px;font-family:Oracle Sans;color:#000000;&quot;&gt;${escapeHtmlForAttr(newLabel)}&lt;/font&gt;&lt;/p&gt;&lt;/div&gt;`;
      return attrs.replace(/value="[^"]*"/, `value="${newValue}"`);
    }
    // If it contains raw HTML tags
    if (oldValue.includes("<") && oldValue.includes(">")) {
      const escapedLabel = escapeHtml(newLabel);
      const newValue = oldValue.replace(/>[^<]+</g, `>${escapedLabel}<`);
      return attrs.replace(/value="[^"]*"/, `value="${newValue}"`);
    }
    // Plain text value
    return attrs.replace(/value="[^"]*"/, `value="${escapeHtml(newLabel)}"`);
  }
  return attrs;
}

function escapeHtmlForAttr(text: string): string {
  // For use inside already-encoded HTML attributes (value="&lt;...&gt;")
  return text.replace(/&/g, "&amp;amp;").replace(/</g, "&amp;lt;").replace(/>/g, "&amp;gt;");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Build a group container cell.
 */
function buildGroupCell(
  group: DiagramGroup,
  shapeData: ShapeData,
  idCounter: { value: number },
): { cellXml: string; cellId: string } {
  const xml = decodeShapeXml(shapeData.xml);
  const cells = extractCells(xml);

  // Grouping shapes typically have just one content cell (id="2", parent="1")
  const contentCell = cells.find((c) => c.id !== "0" && c.id !== "1");
  if (!contentCell) {
    // Fallback: create a simple container
    const cellId = `g_${group.id}_${idCounter.value++}`;
    const cellXml = `<mxCell id="${cellId}" value="${escapeHtml(group.label)}" style="rounded=1;whiteSpace=wrap;html=1;verticalAlign=top;fillColor=#F5F4F2;strokeColor=#9E9892;fontFamily=Oracle Sans;fontSize=12;container=1;collapsible=0;" vertex="1" parent="1"><mxGeometry x="${group.x}" y="${group.y}" width="${group.w}" height="${group.h}" as="geometry"/></mxCell>`;
    return { cellXml, cellId };
  }

  const cellId = `g_${group.id}_${idCounter.value++}`;
  let attrs = contentCell.attrs;
  attrs = setAttr(attrs, "id", cellId);
  attrs = setAttr(attrs, "parent", "1");

  // Add container properties
  if (!attrs.includes("container=")) {
    attrs = attrs.replace(/style="/, `style="container=1;collapsible=0;`);
  }

  // Replace label
  if (group.label) {
    attrs = replaceLabel(attrs, group.label);
  }

  // Set geometry to user's position and size
  const geo = `<mxGeometry x="${group.x}" y="${group.y}" width="${group.w}" height="${group.h}" as="geometry"/>`;

  return { cellXml: `<mxCell ${attrs}>${geo}</mxCell>`, cellId };
}

/**
 * Build an edge between two nodes.
 */
function buildEdge(
  conn: DiagramConnection,
  nodeAnchorMap: Map<string, string>,
  idCounter: { value: number },
): string | null {
  const sourceId = nodeAnchorMap.get(conn.from);
  const targetId = nodeAnchorMap.get(conn.to);
  if (!sourceId || !targetId) return null;

  const edgeId = `e_${idCounter.value++}`;
  const label = conn.label ? ` value="${escapeHtml(conn.label)}"` : ` value=""`;

  return `<mxCell id="${edgeId}"${label} style="edgeStyle=orthogonalEdgeStyle;rounded=1;orthogonalLoop=1;jettySize=auto;html=1;strokeColor=#312D2A;fontFamily=Oracle Sans;fontSize=10;fontColor=#312D2A;endArrow=open;endFill=0;endSize=6;" edge="1" source="${sourceId}" target="${targetId}" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell>`;
}

export interface DiagramResult {
  xml: string;
  errors: string[];
}

/**
 * Build a complete mxGraphModel XML from nodes, connections, and groups.
 */
export function buildDiagram(
  nodes: DiagramNode[],
  connections: DiagramConnection[] = [],
  groups: DiagramGroup[] = [],
): DiagramResult {
  const shapes = loadShapes();
  const errors: string[] = [];
  const allCells: string[] = [];
  const idCounter = { value: 100 };

  // Map from user node ID → first mxCell ID (for edge connections)
  const nodeAnchorMap = new Map<string, string>();

  // Map from group ID → group cell ID
  const groupCellMap = new Map<string, string>();

  // Map from node ID → group ID (for parenting)
  const nodeGroupMap = new Map<string, string>();
  for (const group of groups) {
    if (group.children) {
      for (const childId of group.children) {
        nodeGroupMap.set(childId, group.id);
      }
    }
  }

  // 1. Build group containers first
  for (const group of groups) {
    const resolved = resolveShape(group.shape);
    if (!resolved) {
      errors.push(`Group "${group.id}": shape "${group.shape}" not found`);
      // Create fallback container
      const cellId = `g_${group.id}_${idCounter.value++}`;
      allCells.push(`<mxCell id="${cellId}" value="${escapeHtml(group.label)}" style="rounded=1;whiteSpace=wrap;html=1;verticalAlign=top;fillColor=#F5F4F2;strokeColor=#9E9892;fontFamily=Oracle Sans;fontSize=12;container=1;collapsible=0;dashed=1;" vertex="1" parent="1"><mxGeometry x="${group.x}" y="${group.y}" width="${group.w}" height="${group.h}" as="geometry"/></mxCell>`);
      groupCellMap.set(group.id, cellId);
      continue;
    }

    const { cellXml, cellId } = buildGroupCell(group, resolved.data, idCounter);
    allCells.push(cellXml);
    groupCellMap.set(group.id, cellId);
  }

  // 2. Build nodes
  for (const node of nodes) {
    const resolved = resolveShape(node.shape);
    if (!resolved) {
      errors.push(`Node "${node.id}": shape "${node.shape}" not found`);
      continue;
    }

    // Determine parent (group or root)
    const groupId = nodeGroupMap.get(node.id);
    const parentCellId = groupId ? groupCellMap.get(groupId) : undefined;

    const { cellXmls, anchorId } = buildNodeCells(node, resolved.data, idCounter, parentCellId);
    allCells.push(...cellXmls);
    nodeAnchorMap.set(node.id, anchorId);
  }

  // 3. Build edges
  for (const conn of connections) {
    const edgeXml = buildEdge(conn, nodeAnchorMap, idCounter);
    if (edgeXml) {
      allCells.push(edgeXml);
    } else {
      errors.push(`Connection from "${conn.from}" to "${conn.to}": endpoint not found`);
    }
  }

  // Assemble
  const xml = `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${allCells.join("")}</root></mxGraphModel>`;

  return { xml, errors };
}
