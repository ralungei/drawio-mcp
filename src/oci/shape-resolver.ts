/**
 * Resolves OCI shape slugs to full mxGraphModel XML.
 * Handles: decode compressed shape XML, remap IDs, position, relabel,
 * generate edges, compose into single diagram.
 *
 * Follows OCI Architecture Diagram Toolkit style guide:
 * - Icon scale: 0.5× default (half size for architecture diagrams)
 * - Font: Oracle Sans, 8pt for edge labels, 9pt Bold for group labels
 * - Colors: Bark (#312D2A), Sienna (#AE562C), Neutral 1 (#F5F4F2)
 * - Connectors: 1pt, open arrowhead, orthogonal routing
 */

import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import { fileURLToPath } from "url";
import { getShapeBySlug, searchShapes, type CatalogEntry } from "./shape-catalog.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, "..", "..", "data");

/** Uniform scale for icon shapes — applied identically to ALL icons so they
 *  have consistent visual weight. Falls back to fit-to-box only if the
 *  content would exceed the standard box (rare with correctly sized box). */
const DEFAULT_ICON_SCALE = 0.35;

/**
 * Standard icon bounding box — all icons get this fixed size for consistent alignment.
 * Sized to fit the largest OCI icon at DEFAULT_ICON_SCALE with room for the label below.
 * Edges connect to this uniform box so nodes at the same y produce horizontal connectors.
 */
const STANDARD_ICON_W = 44;
const STANDARD_ICON_H = 56;
const COMPONENT_BOX_W = 110;
const COMPONENT_BOX_H = 40;
const MIN_GROUP_W = 100;
const MIN_GROUP_H = 60;
const ANNOTATION_CIRCLE_SIZE = 22;
const FLOW_GAP = 60;

/** Default rendered size for a node shape. Component boxes are 110×40, icons are 44×56. */
function getDefaultNodeSize(shape: string): { w: number; h: number } {
  return shape in COMPONENT_STYLES
    ? { w: COMPONENT_BOX_W, h: COMPONENT_BOX_H }
    : { w: STANDARD_ICON_W, h: STANDARD_ICON_H };
}

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
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

export interface DiagramConnection {
  from: string;
  to: string;
  label?: string;
  style?: "solid" | "dashed"; // solid = dataflow (default), dashed = user interaction
  step?: number;  // Ordered sequence marker → Sienna numbered circle near source
  note?: string;  // Unordered annotation (e.g. "A", "B") → Neutral 4 lettered circle
}

export interface DiagramGroup {
  id: string;
  shape: string; // slug for a grouping shape
  label: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  children?: string[]; // node/group IDs that belong to this group
}

/**
 * Logical component box styles (Slide 8 of PPTX guide).
 * These are NOT in the draw.io shape library — generated as styled roundRect cells.
 */
const COMPONENT_STYLES: Record<string, { fillColor: string; strokeColor: string; strokeStyle: string; fontStyle: string }> = {
  "component/oci": {
    fillColor: "#FCFBFA", strokeColor: "#759C6C", strokeStyle: "solid",
    fontStyle: "fontStyle=0;", // Regular
  },
  "component/onprem": {
    fillColor: "#FCFBFA", strokeColor: "#C74634", strokeStyle: "solid",
    fontStyle: "fontStyle=0;",
  },
  "component/3rdparty": {
    fillColor: "#FCFBFA", strokeColor: "#312D2A", strokeStyle: "solid",
    fontStyle: "fontStyle=0;",
  },
  "component/atomic": {
    fillColor: "#759C6C", strokeColor: "none", strokeStyle: "solid",
    fontStyle: "fontColor=#FCFBFA;fontStyle=0;", // White text
  },
  "component/composite": {
    fillColor: "#FCFBFA", strokeColor: "#759C6C", strokeStyle: "solid",
    fontStyle: "fontStyle=0;",
  },
  "component/expanded": {
    fillColor: "#FCFBFA", strokeColor: "#759C6C", strokeStyle: "dashed",
    fontStyle: "fontStyle=1;", // Bold title
  },
  "group/metro_realm": {
    fillColor: "#DFDCD8", strokeColor: "#9E9892", strokeStyle: "solid",
    fontStyle: "fontStyle=1;fontColor=#312D2A;", // Extra-Bold (Bold in draw.io), Bark
  },
  "group/optional": {
    fillColor: "#FCFBFA", strokeColor: "#A36472", strokeStyle: "dashed",
    fontStyle: "fontStyle=0;fontColor=#A36472;", // Regular, Rose text
  },
  "group/on_premises": {
    fillColor: "#F5F4F2", strokeColor: "#9E9892", strokeStyle: "solid",
    fontStyle: "fontStyle=1;fontColor=#312D2A;",
  },
  "group/oracle_services_network": {
    fillColor: "#F5F4F2", strokeColor: "#9E9892", strokeStyle: "dashed",
    fontStyle: "fontStyle=1;fontColor=#312D2A;",
  },
};

/**
 * Per-slug style overrides for library grouping shapes.
 * Values come from the OCI Architecture Diagram Toolkit PPTX (slides 7, 18-19).
 * Applied after fixGroupStyle so they win over whatever the library baked in.
 */
const GROUP_STYLE_OVERRIDES: Record<string, Record<string, string>> = {
  // Physical Location (Slide 18): 9pt Bold, subtle rounding
  "physical/grouping_oci_region":          { fontSize: "9", fontStyle: "1", arcSize: "3" },
  "physical/grouping_availability_domain": { fontSize: "9", fontStyle: "1", arcSize: "3" },
  "physical/grouping_fault_domain":        { fontSize: "9", arcSize: "3" },
  "physical/grouping_user_group":          { fontSize: "9", arcSize: "3" },
  // Physical Network (Slide 18): 9pt Bold, rect (square corners handled by fixGroupStyle)
  "physical/grouping_vcn":                 { fontSize: "9", fontStyle: "1", fontColor: "#AE562C", strokeWidth: "1.25" },
  "physical/grouping_subnet":              { fontSize: "9", fontStyle: "1" },
  "physical/grouping_compartment":         { fontSize: "9", fontStyle: "1", fontColor: "#AE562C" },
  "physical/grouping_tenancy":             { fontSize: "9" },
  "physical/grouping_tier":                { fontSize: "9" },
  // Logical (Slide 7): 9pt Bold, subtle or no rounding
  "logical/grouping_oracle_cloud":         { fontSize: "9", fontStyle: "1", arcSize: "3" },
  "logical/grouping_on_premises":          { fontSize: "9", fontStyle: "1", arcSize: "3" },
  "logical/grouping_internet":             { fontSize: "9", fontStyle: "1", arcSize: "3" },
  "logical/grouping_3rd_party_cloud":      { fontSize: "9", fontStyle: "1", arcSize: "3" },
  // Location-style box (VB, ODA, service containers inside OSN): Neutral 2 fill, Neutral 3 stroke,
  // 9pt Bold Bark label top-center. Square corners. Solid stroke (override library's dashed default).
  "logical/grouping_other_group":          {
    fontSize: "9", fontStyle: "1", rounded: "0", dashed: "0",
    fillColor: "#E4E1DD", strokeColor: "#9E9892", strokeWidth: "1",
    fontColor: "#312D2A", align: "center", verticalAlign: "top",
  },
};

/**
 * Apply PPTX-spec style overrides to a group cell's style string.
 * Patches individual style keys; when rounded=0 is specified, also strips arcSize/absoluteArcSize.
 */
function applyGroupStyleOverrides(style: string, shapeSlug: string): string {
  const overrides = GROUP_STYLE_OVERRIDES[shapeSlug];
  if (!overrides) return style;
  let result = style;
  for (const [key, value] of Object.entries(overrides)) {
    const regex = new RegExp(`${key}=[^;]*;?`);
    if (regex.test(result)) {
      result = result.replace(regex, `${key}=${value};`);
    } else {
      result = result.endsWith(";") ? `${result}${key}=${value};` : `${result};${key}=${value};`;
    }
  }
  if (overrides.rounded === "0") {
    result = result.replace(/arcSize=[^;]*;?/g, "").replace(/absoluteArcSize=[^;]*;?/g, "");
  }
  return result;
}

/**
 * Check if a shape ref is a component box type and build it directly.
 */
function buildComponentNode(
  node: DiagramNode,
  idCounter: { value: number },
  parentCellId?: string,
): { cellXmls: string[]; anchorId: string } | null {
  const compStyle = COMPONENT_STYLES[node.shape];
  if (!compStyle) return null;

  const cellId = `n_${node.id}_${idCounter.value++}`;
  const actualParent = parentCellId || "1";
  const w = node.w || 110;
  const h = node.h || 40;
  const dash = compStyle.strokeStyle === "dashed" ? "dashed=1;" : "";
  const stroke = compStyle.strokeColor === "none" ? "strokeColor=none;" : `strokeColor=${compStyle.strokeColor};strokeWidth=1;`;

  const style = `rounded=1;arcSize=20;whiteSpace=wrap;html=1;fillColor=${compStyle.fillColor};${stroke}${dash}fontFamily=Oracle Sans;fontSize=9;fontColor=#312D2A;${compStyle.fontStyle}verticalAlign=middle;container=1;collapsible=0;`;

  const cellXml = `<mxCell id="${cellId}" value="${escapeHtml(node.label)}" style="${style}" vertex="1" parent="${actualParent}"><mxGeometry x="${node.x}" y="${node.y}" width="${w}" height="${h}" as="geometry"/></mxCell>`;

  return { cellXmls: [cellXml], anchorId: cellId };
}

/**
 * Check if a shape ref is a component box used as a group container (expanded composite).
 */
function buildComponentGroup(
  group: DiagramGroup,
  idCounter: { value: number },
  parentCellId: string = "1",
): { cellXml: string; cellId: string } | null {
  const compStyle = COMPONENT_STYLES[group.shape];
  if (!compStyle) return null;

  const cellId = `g_${group.id}_${idCounter.value++}`;
  const dash = compStyle.strokeStyle === "dashed" ? "dashed=1;" : "";
  const stroke = compStyle.strokeColor === "none" ? "strokeColor=none;" : `strokeColor=${compStyle.strokeColor};strokeWidth=1;`;

  // Optional indicator uses square corners (rect); all others use roundRect
  const SQUARE_COMPONENT_GROUPS = new Set(["group/optional", "group/oracle_services_network"]);
  const rounded = SQUARE_COMPONENT_GROUPS.has(group.shape) ? "rounded=0;" : "rounded=1;arcSize=10;";

  const style = `${rounded}whiteSpace=wrap;html=1;fillColor=${compStyle.fillColor};${stroke}${dash}fontFamily=Oracle Sans;fontSize=9;fontColor=#312D2A;${compStyle.fontStyle}verticalAlign=top;container=1;collapsible=0;`;

  const cellXml = `<mxCell id="${cellId}" value="${escapeHtml(group.label)}" style="${style}" vertex="1" parent="${parentCellId}"><mxGeometry x="${group.x}" y="${group.y}" width="${group.w}" height="${group.h}" as="geometry"/></mxCell>`;

  return { cellXml, cellId };
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
 * Parse mxCell elements from decoded XML using regex.
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

  // Match mxCell with children (geometry) — [^\/]> ensures we don't match self-closing />
  const cellWithChildrenRegex = /<mxCell\s+([^>]*?[^\/])>([\s\S]*?)<\/mxCell>/g;
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
 * Scale all numeric values (x, y, width, height) in an mxGeometry XML string.
 */
function scaleGeometry(geoXml: string, scale: number): string {
  if (scale === 1) return geoXml;
  return geoXml.replace(/(x|y|width|height)="([^"]*)"/g, (_match, attr, val) => {
    const num = parseFloat(val);
    if (isNaN(num)) return _match;
    return `${attr}="${Math.round(num * scale * 100) / 100}"`;
  });
}

/**
 * Add offset to x/y values in an mxGeometry XML string.
 */
function offsetGeometry(geoXml: string, dx: number, dy: number): string {
  if (dx === 0 && dy === 0) return geoXml;
  let result = geoXml;
  const xMatch = result.match(/x="([^"]*)"/);
  if (xMatch) {
    const x = parseFloat(xMatch[1]) + dx;
    result = result.replace(/x="[^"]*"/, `x="${Math.round(x * 100) / 100}"`);
  } else if (dx !== 0) {
    result = result.replace("<mxGeometry", `<mxGeometry x="${dx}"`);
  }
  const yMatch = result.match(/y="([^"]*)"/);
  if (yMatch) {
    const y = parseFloat(yMatch[1]) + dy;
    result = result.replace(/y="[^"]*"/, `y="${Math.round(y * 100) / 100}"`);
  } else if (dy !== 0) {
    result = result.replace("<mxGeometry", `<mxGeometry y="${dy}"`);
  }
  return result;
}

/**
 * Build the cells for a single shape node.
 * All icons are wrapped in a standard-sized group (STANDARD_ICON_W × STANDARD_ICON_H)
 * with the content scaled to fit and centered within. This ensures:
 * - Nodes at the same y produce perfectly horizontal connectors
 * - Consistent spacing regardless of native icon dimensions
 */
function buildNodeCells(
  node: DiagramNode,
  shapeData: ShapeData,
  idCounter: { value: number },
  parentCellId?: string,
  _scale: number = DEFAULT_ICON_SCALE,
): { cellXmls: string[]; anchorId: string } {
  const xml = decodeShapeXml(shapeData.xml);
  const cells = extractCells(xml);

  const contentCells = cells.filter((c) => c.id !== "0" && c.id !== "1");

  const actualParent = parentCellId || "1";
  const output: string[] = [];

  // Standard bounding box (user can override with node.w / node.h)
  const boxW = node.w || STANDARD_ICON_W;
  const boxH = node.h || STANDARD_ICON_H;

  // Uniform scale for all icons (consistent visual weight).
  // Falls back to fit-to-box only if content would exceed the standard box.
  let fitScale = _scale;
  if (shapeData.w * fitScale > boxW || shapeData.h * fitScale > boxH) {
    fitScale = Math.min(boxW / shapeData.w, boxH / shapeData.h);
  }
  const contentW = Math.round(shapeData.w * fitScale);
  const contentH = Math.round(shapeData.h * fitScale);
  const offsetX = Math.round((boxW - contentW) / 2);
  const offsetY = Math.round((boxH - contentH) / 2);

  // Always wrap in a group at standard size for uniform edge connections
  const groupId = `n_${node.id}_${idCounter.value++}`;
  output.push(
    `<mxCell id="${groupId}" value="" style="group;pointerEvents=0;" vertex="1" connectable="1" parent="${actualParent}">` +
    `<mxGeometry x="${node.x}" y="${node.y}" width="${boxW}" height="${boxH}" as="geometry"/>` +
    `</mxCell>`,
  );

  // Remap IDs for all content cells
  const idMap = new Map<string, string>();
  for (const cell of contentCells) {
    idMap.set(cell.id, `n_${node.id}_${idCounter.value++}`);
  }

  // All cells go inside the group; root cells get parent=groupId
  // Strip ALL value attributes — label is added as a separate cell below
  for (const cell of contentCells) {
    let attrs = cell.attrs;
    const newId = idMap.get(cell.id)!;
    attrs = setAttr(attrs, "id", newId);

    // Parent: root cells → group; child cells → remapped parent
    const newParent = cell.parentId === "1" ? groupId : (idMap.get(cell.parentId) || groupId);
    attrs = setAttr(attrs, "parent", newParent);

    // Clear value on all internal cells — prevents label rendering on stencil layers
    attrs = attrs.replace(/value="[^"]*"/, `value=""`);

    // Scale and center internal geometry
    let geo = cell.geometryXml;
    if (geo) {
      geo = scaleGeometry(geo, fitScale);
      // Offset root-level cells to center content within the standard box
      if (cell.parentId === "1") {
        geo = offsetGeometry(geo, offsetX, offsetY);
      }
      output.push(`<mxCell ${attrs}>${geo}</mxCell>`);
    } else {
      output.push(`<mxCell ${attrs}/>`);
    }
  }

  // Find where the original label cell sits (native y) to position our label correctly.
  // OCI shapes have a label cell with HTML value at y≈86-89, right below the ~84px graphic.
  let nativeLabelY = shapeData.h * 0.8; // fallback
  for (const cell of contentCells) {
    const value = getAttr(cell.attrs, "value") || "";
    if (value.includes("&lt;") || value.includes("&amp;lt;")) {
      const yMatch = cell.geometryXml?.match(/y="([^"]*)"/);
      if (yMatch) nativeLabelY = parseFloat(yMatch[1]);
      break;
    }
  }
  const labelY = Math.round(nativeLabelY * fitScale) + offsetY;

  // Add dedicated label cell at the computed position
  if (node.label) {
    const labelId = `n_${node.id}_label_${idCounter.value++}`;
    const labelStyle = `text;html=1;align=center;verticalAlign=top;whiteSpace=wrap;fontFamily=Oracle Sans;fontSize=9;fontColor=#312D2A;resizable=0;movable=0;`;
    output.push(
      `<mxCell id="${labelId}" value="${escapeHtml(node.label)}" style="${labelStyle}" vertex="1" parent="${groupId}">` +
      `<mxGeometry x="${-10}" y="${labelY}" width="${boxW + 20}" height="${16}" as="geometry"/>` +
      `</mxCell>`,
    );
  }

  return { cellXmls: output, anchorId: groupId };
}

function setGeoPosition(geoXml: string, x: number, y: number): string {
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
 * Shapes that should have SQUARE corners (rect) per the OCI PPTX guide.
 * All other groups (Region, AD, FD, UserGroup, logical groups) keep roundRect.
 */
const SQUARE_CORNER_SLUGS = new Set([
  "physical/grouping_vcn",
  "physical/grouping_subnet",
  "physical/grouping_compartment",
  "physical/grouping_tenancy",
  "physical/grouping_tier",
]);

/**
 * Strip rounded corners from group containers that should be square (VCN, Subnet, etc.).
 * Preserves rounded corners on Region, AD, FD, UserGroup, and all logical groups.
 */
function fixGroupStyle(attrs: string, shapeSlug?: string): string {
  // Only strip rounded corners for shapes that should be square
  if (shapeSlug && !SQUARE_CORNER_SLUGS.has(shapeSlug)) {
    return attrs;
  }
  const style = getAttr(attrs, "style") || "";
  if (style.includes("rounded=1")) {
    const newStyle = style
      .replace(/rounded=1;?/, "")
      .replace(/arcSize=\d+;?/, "")
      .replace(/absoluteArcSize=\d+;?/, "");
    return setAttr(attrs, "style", newStyle);
  }
  return attrs;
}

/**
 * Build a group container cell.
 * Handles both single-cell groups (Region, Compartment, etc.) and
 * multi-cell groups (VCN, Subnet — which have a group wrapper + visible border + icon).
 */
function buildGroupCell(
  group: DiagramGroup,
  shapeData: ShapeData,
  idCounter: { value: number },
  parentCellId: string = "1",
): { cellXml: string; cellId: string } {
  const xml = decodeShapeXml(shapeData.xml);
  const cells = extractCells(xml);

  const contentCells = cells.filter((c) => c.id !== "0" && c.id !== "1");
  if (contentCells.length === 0) {
    // Fallback: create a simple container
    const cellId = `g_${group.id}_${idCounter.value++}`;
    const cellXml = `<mxCell id="${cellId}" value="${escapeHtml(group.label)}" style="rounded=1;whiteSpace=wrap;html=1;verticalAlign=top;fillColor=#F5F4F2;strokeColor=#9E9892;fontFamily=Oracle Sans;fontSize=12;container=1;collapsible=0;" vertex="1" parent="${parentCellId}"><mxGeometry x="${group.x}" y="${group.y}" width="${group.w}" height="${group.h}" as="geometry"/></mxCell>`;
    return { cellXml, cellId };
  }

  const rootCells = contentCells.filter((c) => c.parentId === "1");

  // Multi-cell grouping shape (VCN, Subnet): root cell has style="group" and children
  // provide the visible border + icon. We need to use the visible border cell as the
  // container and add icons as decorations.
  if (contentCells.length > 1 && rootCells.length === 1) {
    const rootCell = rootCells[0];
    const rootStyle = getAttr(rootCell.attrs, "style") || "";

    if (rootStyle === "group" || rootStyle.startsWith("group;")) {
      const childCells = contentCells.filter((c) => c.parentId === rootCell.id);

      // Find the container cell (has whiteSpace/strokeWidth — the dashed border box)
      const containerCell = childCells.find((c) => {
        const style = getAttr(c.attrs, "style") || "";
        return style.includes("whiteSpace") || style.includes("strokeWidth");
      });

      // Icon cells are the remaining children (SVG images in top-right corner)
      const iconCells = childCells.filter((c) => c !== containerCell);

      if (containerCell) {
        const cellId = `g_${group.id}_${idCounter.value++}`;
        let attrs = containerCell.attrs;
        attrs = setAttr(attrs, "id", cellId);
        attrs = setAttr(attrs, "parent", parentCellId);

        // Add container properties
        if (!attrs.includes("container=")) {
          attrs = attrs.replace(/style="/, `style="container=1;collapsible=0;`);
        }

        // Fix rounded corners — only strip for square-corner shapes
        attrs = fixGroupStyle(attrs, group.shape);
        // Apply PPTX spec overrides (fontSize, fontStyle, arcSize, etc.)
        const mcStyle = getAttr(attrs, "style") || "";
        attrs = setAttr(attrs, "style", applyGroupStyleOverrides(mcStyle, group.shape));

        // Add spacing so label doesn't overlap children
        const existingStyle = getAttr(attrs, "style") || "";
        if (!existingStyle.includes("spacingTop=")) {
          attrs = setAttr(attrs, "style", existingStyle + "spacingTop=5;spacingLeft=5;");
        }

        // Replace label (clean text, no HTML wrapping)
        if (group.label) {
          attrs = setAttr(attrs, "value", escapeHtml(group.label));
        }

        // Set geometry to user's position and size
        const geo = `<mxGeometry x="${group.x}" y="${group.y}" width="${group.w}" height="${group.h}" as="geometry"/>`;
        let cellXml = `<mxCell ${attrs}>${geo}</mxCell>`;

        // Add icon cells positioned at top-right corner inside the container
        for (const iconCell of iconCells) {
          const iconId = `g_${group.id}_icon_${idCounter.value++}`;
          let iconAttrs = iconCell.attrs;
          iconAttrs = setAttr(iconAttrs, "id", iconId);
          iconAttrs = setAttr(iconAttrs, "parent", cellId);

          // Extract original icon dimensions
          const wMatch = iconCell.geometryXml.match(/width="([^"]*)"/);
          const hMatch = iconCell.geometryXml.match(/height="([^"]*)"/);
          const iconW = wMatch ? parseFloat(wMatch[1]) : 30;
          const iconH = hMatch ? parseFloat(hMatch[1]) : 30;

          // Half-size icon in top-right corner (per OCI style guide)
          const scaledIconW = Math.round(iconW * 0.5);
          const scaledIconH = Math.round(iconH * 0.5);
          const iconX = (group.w ?? 100) - scaledIconW - 5;
          const iconY = 3; // Inside container, not negative

          // Make icon non-interactive (decoration only)
          const iconStyle = getAttr(iconAttrs, "style") || "";
          if (!iconStyle.includes("movable=")) {
            iconAttrs = setAttr(iconAttrs, "style", iconStyle + "movable=0;resizable=0;selectable=0;");
          }

          const iconGeo = `<mxGeometry x="${iconX}" y="${iconY}" width="${scaledIconW}" height="${scaledIconH}" as="geometry"/>`;
          cellXml += `<mxCell ${iconAttrs}>${iconGeo}</mxCell>`;
        }

        return { cellXml, cellId };
      }
    }
  }

  // Single-cell grouping shape (Region, Compartment, Tenancy, etc.)
  const contentCell = contentCells[0];
  const cellId = `g_${group.id}_${idCounter.value++}`;
  let attrs = contentCell.attrs;
  attrs = setAttr(attrs, "id", cellId);
  attrs = setAttr(attrs, "parent", parentCellId);

  // Add container properties
  if (!attrs.includes("container=")) {
    attrs = attrs.replace(/style="/, `style="container=1;collapsible=0;`);
  }

  // Fix rounded corners — only strip for square-corner shapes
  attrs = fixGroupStyle(attrs, group.shape);
  // Apply PPTX spec overrides (fontSize, fontStyle, arcSize, etc.)
  const scStyle = getAttr(attrs, "style") || "";
  attrs = setAttr(attrs, "style", applyGroupStyleOverrides(scStyle, group.shape));

  // Add spacing so label doesn't overlap children
  const singleStyle = getAttr(attrs, "style") || "";
  if (!singleStyle.includes("spacingTop=")) {
    attrs = setAttr(attrs, "style", singleStyle + "spacingTop=5;spacingLeft=5;");
  }

  // Replace label (clean text, no HTML wrapping)
  if (group.label) {
    attrs = setAttr(attrs, "value", escapeHtml(group.label));
  }

  // Set geometry to user's position and size
  const geo = `<mxGeometry x="${group.x}" y="${group.y}" width="${group.w}" height="${group.h}" as="geometry"/>`;

  return { cellXml: `<mxCell ${attrs}>${geo}</mxCell>`, cellId };
}

/**
 * Get the chain of ancestor group IDs for a node (from immediate parent to root).
 */
function getAncestorChain(nodeId: string, nodeGroupMap: Map<string, string>): string[] {
  const chain: string[] = [];
  let current = nodeGroupMap.get(nodeId);
  while (current) {
    chain.push(current);
    current = nodeGroupMap.get(current);
  }
  return chain;
}

/**
 * Find the lowest common ancestor group of two nodes.
 * Returns the group ID, or null if they share no common group (root level).
 */
function findLCA(
  nodeA: string,
  nodeB: string,
  nodeGroupMap: Map<string, string>,
): string | null {
  const chainA = getAncestorChain(nodeA, nodeGroupMap);
  const setA = new Set(chainA);
  const chainB = getAncestorChain(nodeB, nodeGroupMap);
  for (const groupId of chainB) {
    if (setA.has(groupId)) return groupId;
  }
  return null;
}

/**
 * Compute the absolute center of a node/group by walking up the parent chain.
 */
function getAbsoluteCenter(
  id: string,
  posMap: Map<string, { x: number; y: number; w: number; h: number }>,
  nodeGroupMap: Map<string, string>,
): { cx: number; cy: number } {
  const pos = posMap.get(id);
  if (!pos) return { cx: 0, cy: 0 };
  let cx = pos.x + pos.w / 2;
  let cy = pos.y + pos.h / 2;
  let parentId = nodeGroupMap.get(id);
  while (parentId) {
    const parentPos = posMap.get(parentId);
    if (parentPos) {
      cx += parentPos.x;
      cy += parentPos.y;
    }
    parentId = nodeGroupMap.get(parentId);
  }
  return { cx, cy };
}

/**
 * Compute exit/entry points based on the dominant direction between source and target.
 * Returns style fragment like "exitX=1;exitY=0.5;...entryY=0.5;"
 */
function computeExitEntry(
  fromId: string,
  toId: string,
  posMap: Map<string, { x: number; y: number; w: number; h: number }>,
  nodeGroupMap: Map<string, string>,
): string {
  const src = getAbsoluteCenter(fromId, posMap, nodeGroupMap);
  const tgt = getAbsoluteCenter(toId, posMap, nodeGroupMap);
  const dx = tgt.cx - src.cx;
  const dy = tgt.cy - src.cy;

  let exitX: number, exitY: number, entryX: number, entryY: number;
  if (Math.abs(dx) >= Math.abs(dy)) {
    // Horizontal dominant — exit right/left
    if (dx >= 0) {
      exitX = 1; exitY = 0.5; entryX = 0; entryY = 0.5;
    } else {
      exitX = 0; exitY = 0.5; entryX = 1; entryY = 0.5;
    }
  } else {
    // Vertical dominant — exit bottom/top
    if (dy >= 0) {
      exitX = 0.5; exitY = 1; entryX = 0.5; entryY = 0;
    } else {
      exitX = 0.5; exitY = 0; entryX = 0.5; entryY = 1;
    }
  }

  return `exitX=${exitX};exitY=${exitY};exitDx=0;exitDy=0;entryX=${entryX};entryY=${entryY};entryDx=0;entryDy=0;`;
}

/**
 * Compute a node's center position relative to a specific ancestor group.
 * Walks up the parent chain from nodeId, summing positions, stopping at ancestorId.
 */
function getCenterInAncestor(
  nodeId: string,
  ancestorId: string,
  posMap: Map<string, { x: number; y: number; w: number; h: number }>,
  nodeGroupMap: Map<string, string>,
): { cx: number; cy: number } {
  const pos = posMap.get(nodeId);
  if (!pos) return { cx: 0, cy: 0 };
  let cx = pos.x + pos.w / 2;
  let cy = pos.y + pos.h / 2;
  let parentId = nodeGroupMap.get(nodeId);
  while (parentId && parentId !== ancestorId) {
    const parentPos = posMap.get(parentId);
    if (parentPos) {
      cx += parentPos.x;
      cy += parentPos.y;
    }
    parentId = nodeGroupMap.get(parentId);
  }
  return { cx, cy };
}

/**
 * Find the "bridge group" — the direct child of ancestorId that contains nodeId.
 * Walks up from nodeId until finding a group whose parent is ancestorId.
 */
function findBridgeGroup(
  nodeId: string,
  ancestorId: string,
  nodeGroupMap: Map<string, string>,
): string | null {
  let current: string | undefined = nodeId;
  while (current) {
    const parent = nodeGroupMap.get(current);
    if (parent === ancestorId) return current;
    current = parent;
  }
  return null;
}

interface WaypointResult {
  waypoints: { x: number; y: number }[];
  /** Override exit/entry style when obstacle avoidance changes the routing direction */
  exitEntryOverride?: string;
}

/**
 * Compute waypoints for obstacle avoidance. Handles two cases:
 *
 * 1. Cross-group edges: route through the gap between sibling groups.
 * 2. Same-group edges: if intermediate nodes sit between source and target,
 *    route above/beside them to avoid crossing.
 *
 * Returns waypoints + optional exit/entry overrides so that the edge leaves/enters
 * from the correct side (e.g., top when detouring above).
 */
function computeWaypoints(
  fromId: string,
  toId: string,
  lcaId: string | null,
  nodeGroupMap: Map<string, string>,
  posMap: Map<string, { x: number; y: number; w: number; h: number }>,
  allNodeIds: string[],
): WaypointResult {
  // --- Case 2: Same immediate group — check for intermediate obstacles ---
  const fromParent = nodeGroupMap.get(fromId);
  const toParent = nodeGroupMap.get(toId);
  if (fromParent && fromParent === toParent) {
    const srcPos = posMap.get(fromId);
    const tgtPos = posMap.get(toId);
    if (srcPos && tgtPos) {
      // Are they in roughly the same row? (y within 20px)
      if (Math.abs(srcPos.y - tgtPos.y) < 20) {
        const minX = Math.min(srcPos.x + srcPos.w, tgtPos.x + tgtPos.w);
        const maxX = Math.max(srcPos.x, tgtPos.x);
        // Find siblings between source and target in x
        const obstacles = allNodeIds.filter(id => {
          if (id === fromId || id === toId) return false;
          if (nodeGroupMap.get(id) !== fromParent) return false;
          const pos = posMap.get(id);
          if (!pos) return false;
          const nodeCx = pos.x + pos.w / 2;
          return nodeCx > minX && nodeCx < maxX;
        });
        if (obstacles.length > 0) {
          // Route above all nodes in this group
          let minY = srcPos.y;
          for (const id of [...obstacles, fromId, toId]) {
            const pos = posMap.get(id);
            if (pos && pos.y < minY) minY = pos.y;
          }
          const detourY = minY - 15; // 15px above topmost node
          const srcCx = Math.round(srcPos.x + srcPos.w / 2);
          const tgtCx = Math.round(tgtPos.x + tgtPos.w / 2);
          return {
            waypoints: [
              { x: srcCx, y: detourY },
              { x: tgtCx, y: detourY },
            ],
            // Exit/enter from top since we're routing above
            exitEntryOverride: "exitX=0.5;exitY=0;exitDx=0;exitDy=0;entryX=0.5;entryY=0;entryDx=0;entryDy=0;",
          };
        }
      }
      // Same column? (x within 20px)
      if (Math.abs(srcPos.x - tgtPos.x) < 20) {
        const minY = Math.min(srcPos.y + srcPos.h, tgtPos.y + tgtPos.h);
        const maxY = Math.max(srcPos.y, tgtPos.y);
        const obstacles = allNodeIds.filter(id => {
          if (id === fromId || id === toId) return false;
          if (nodeGroupMap.get(id) !== fromParent) return false;
          const pos = posMap.get(id);
          if (!pos) return false;
          const nodeCy = pos.y + pos.h / 2;
          return nodeCy > minY && nodeCy < maxY;
        });
        if (obstacles.length > 0) {
          let minX = srcPos.x;
          for (const id of [...obstacles, fromId, toId]) {
            const pos = posMap.get(id);
            if (pos && pos.x < minX) minX = pos.x;
          }
          const detourX = minX - 15;
          const srcCy = Math.round(srcPos.y + srcPos.h / 2);
          const tgtCy = Math.round(tgtPos.y + tgtPos.h / 2);
          return {
            waypoints: [
              { x: detourX, y: srcCy },
              { x: detourX, y: tgtCy },
            ],
            // Exit/enter from left since we're routing beside
            exitEntryOverride: "exitX=0;exitY=0.5;exitDx=0;exitDy=0;entryX=0;entryY=0.5;entryDx=0;entryDy=0;",
          };
        }
      }
    }
  }

  // --- Case 1: Cross-group — route through gap between sibling groups ---
  // When lcaId is null, nodes are in separate root-level groups (no common ancestor).
  // Use their immediate parent groups as bridge groups.
  let fromBridge: string | null;
  let toBridge: string | null;
  if (!lcaId) {
    fromBridge = fromParent || null;
    toBridge = toParent || null;
  } else {
    fromBridge = findBridgeGroup(fromId, lcaId, nodeGroupMap);
    toBridge = findBridgeGroup(toId, lcaId, nodeGroupMap);
  }
  if (!fromBridge || !toBridge || fromBridge === toBridge) return { waypoints: [] };

  const fromGroup = posMap.get(fromBridge);
  const toGroup = posMap.get(toBridge);
  if (!fromGroup || !toGroup) return { waypoints: [] };

  const src = lcaId
    ? getCenterInAncestor(fromId, lcaId, posMap, nodeGroupMap)
    : getAbsoluteCenter(fromId, posMap, nodeGroupMap);
  const tgt = lcaId
    ? getCenterInAncestor(toId, lcaId, posMap, nodeGroupMap)
    : getAbsoluteCenter(toId, posMap, nodeGroupMap);

  // Vertical gap — exit bottom, enter top
  const fromBottom = fromGroup.y + fromGroup.h;
  const toTop = toGroup.y;
  const toBottom = toGroup.y + toGroup.h;
  const fromTop = fromGroup.y;
  const verticalExit = "exitX=0.5;exitY=1;exitDx=0;exitDy=0;entryX=0.5;entryY=0;entryDx=0;entryDy=0;";
  const verticalEntryReverse = "exitX=0.5;exitY=0;exitDx=0;exitDy=0;entryX=0.5;entryY=1;entryDx=0;entryDy=0;";

  if (fromBottom <= toTop) {
    const gapY = Math.round((fromBottom + toTop) / 2);
    return {
      waypoints: [{ x: Math.round(src.cx), y: gapY }, { x: Math.round(tgt.cx), y: gapY }],
      exitEntryOverride: verticalExit,
    };
  }
  if (toBottom <= fromTop) {
    const gapY = Math.round((toBottom + fromTop) / 2);
    return {
      waypoints: [{ x: Math.round(src.cx), y: gapY }, { x: Math.round(tgt.cx), y: gapY }],
      exitEntryOverride: verticalEntryReverse,
    };
  }

  // Horizontal gap — exit right/left, enter left/right
  const fromRight = fromGroup.x + fromGroup.w;
  const toLeft = toGroup.x;
  const toRight = toGroup.x + toGroup.w;
  const fromLeft = fromGroup.x;
  const horizontalExitRight = "exitX=1;exitY=0.5;exitDx=0;exitDy=0;entryX=0;entryY=0.5;entryDx=0;entryDy=0;";
  const horizontalExitLeft = "exitX=0;exitY=0.5;exitDx=0;exitDy=0;entryX=1;entryY=0.5;entryDx=0;entryDy=0;";

  if (fromRight <= toLeft) {
    const gapX = Math.round((fromRight + toLeft) / 2);
    return {
      waypoints: [{ x: gapX, y: Math.round(src.cy) }, { x: gapX, y: Math.round(tgt.cy) }],
      exitEntryOverride: horizontalExitRight,
    };
  }
  if (toRight <= fromLeft) {
    const gapX = Math.round((toRight + fromLeft) / 2);
    return {
      waypoints: [{ x: gapX, y: Math.round(src.cy) }, { x: gapX, y: Math.round(tgt.cy) }],
      exitEntryOverride: horizontalExitLeft,
    };
  }

  return { waypoints: [] };
}

/**
 * Get a node's absolute bounding box (root coordinate space).
 * Walks up the parent chain summing all position offsets.
 */
function getAbsoluteBox(
  id: string,
  posMap: Map<string, { x: number; y: number; w: number; h: number }>,
  nodeGroupMap: Map<string, string>,
): { x: number; y: number; w: number; h: number } | null {
  const pos = posMap.get(id);
  if (!pos) return null;
  let absX = pos.x;
  let absY = pos.y;
  let parentId = nodeGroupMap.get(id);
  while (parentId) {
    const parentPos = posMap.get(parentId);
    if (parentPos) {
      absX += parentPos.x;
      absY += parentPos.y;
    }
    parentId = nodeGroupMap.get(parentId);
  }
  return { x: absX, y: absY, w: pos.w, h: pos.h };
}

/**
 * Check if an orthogonal (horizontal or vertical) line segment intersects a
 * padded axis-aligned rectangle.
 */
function segmentHitsBox(
  x1: number, y1: number, x2: number, y2: number,
  box: { x: number; y: number; w: number; h: number },
  padding: number = 8,
): boolean {
  const bx1 = box.x - padding;
  const by1 = box.y - padding;
  const bx2 = box.x + box.w + padding;
  const by2 = box.y + box.h + padding;

  // Horizontal segment
  if (Math.abs(y1 - y2) < 2) {
    const y = (y1 + y2) / 2;
    return y >= by1 && y <= by2 && Math.max(x1, x2) >= bx1 && Math.min(x1, x2) <= bx2;
  }
  // Vertical segment
  if (Math.abs(x1 - x2) < 2) {
    const x = (x1 + x2) / 2;
    return x >= bx1 && x <= bx2 && Math.max(y1, y2) >= by1 && Math.min(y1, y2) <= by2;
  }
  return false;
}

/** Check if ALL segments in a candidate path are clear of obstacles. */
function pathSegmentsClear(
  segments: [number, number, number, number][],
  obstacles: { x: number; y: number; w: number; h: number }[],
  pad: number,
): boolean {
  for (const [ax, ay, bx, by] of segments) {
    for (const obs of obstacles) {
      if (segmentHitsBox(ax, ay, bx, by, obs, pad)) return false;
    }
  }
  return true;
}

/**
 * Find a clear corridor position on `axis` that avoids all boxes.
 * Collects blocked intervals from boxes whose cross-axis range overlaps the corridor,
 * then picks the best gap — preferring values between `prefMin` and `prefMax`.
 */
function findClearCorridor(
  boxes: { x: number; y: number; w: number; h: number }[],
  axis: "x" | "y",
  crossMin: number, crossMax: number,
  prefMin: number, prefMax: number,
  pad: number,
): number | null {
  const blocked: [number, number][] = [];
  for (const b of boxes) {
    const cStart = axis === "x" ? b.y : b.x;
    const cEnd   = axis === "x" ? b.y + b.h : b.x + b.w;
    if (cEnd + pad >= crossMin && cStart - pad <= crossMax) {
      const mStart = axis === "x" ? b.x : b.y;
      const mEnd   = axis === "x" ? b.x + b.w : b.y + b.h;
      blocked.push([mStart - pad, mEnd + pad]);
    }
  }
  if (blocked.length === 0) return Math.round((prefMin + prefMax) / 2);

  blocked.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [s, e] of blocked) {
    if (merged.length > 0 && s <= merged[merged.length - 1][1]) {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
    } else {
      merged.push([s, e]);
    }
  }

  let best: number | null = null;
  let bestDist = Infinity;
  const consider = (v: number) => {
    const d = v >= prefMin && v <= prefMax ? 0
      : Math.min(Math.abs(v - prefMin), Math.abs(v - prefMax));
    if (d < bestDist) { bestDist = d; best = Math.round(v); }
  };

  // Gaps between merged intervals
  for (let i = 0; i < merged.length - 1; i++) {
    const gapS = merged[i][1], gapE = merged[i + 1][0];
    if (gapE > gapS) consider((gapS + gapE) / 2);
  }
  // Outside edges
  consider(merged[0][0] - 20);
  consider(merged[merged.length - 1][1] + 20);

  return best;
}

/**
 * Detect if an edge's approximate orthogonal path crosses through any node and
 * compute detour waypoints that avoid ALL obstacles — not just the initial hit.
 *
 * Tries three strategies in order:
 *   A) Vertical corridor — route through a clear X column (Z-shape)
 *   B) Horizontal band  — route through a clear Y row   (U-shape)
 *   C) Combined 3-waypoint path (L-shape + corridor)
 * Falls back to a simple offset detour if none of the above validate.
 */
function detectPathCollisions(
  fromId: string,
  toId: string,
  lcaId: string | null,
  nodeGroupMap: Map<string, string>,
  posMap: Map<string, { x: number; y: number; w: number; h: number }>,
  allNodeIds: string[],
): WaypointResult {
  const srcBox = getAbsoluteBox(fromId, posMap, nodeGroupMap);
  const tgtBox = getAbsoluteBox(toId, posMap, nodeGroupMap);
  if (!srcBox || !tgtBox) return { waypoints: [] };

  const srcCx = srcBox.x + srcBox.w / 2;
  const srcCy = srcBox.y + srcBox.h / 2;
  const tgtCx = tgtBox.x + tgtBox.w / 2;
  const tgtCy = tgtBox.y + tgtBox.h / 2;

  // Only consider nodes that are visual siblings — nodes inside unrelated
  // nested groups are contained within their group boundary and don't
  // obstruct edges routing between groups.
  const srcParent = nodeGroupMap.get(fromId);
  const tgtParent = nodeGroupMap.get(toId);
  const relevantParents = new Set<string | undefined>();
  relevantParents.add(srcParent);
  relevantParents.add(tgtParent);
  if (lcaId) relevantParents.add(lcaId);
  if (!srcParent && !tgtParent) relevantParents.add(undefined);

  const obstacles: { x: number; y: number; w: number; h: number }[] = [];
  for (const id of allNodeIds) {
    if (id === fromId || id === toId) continue;
    if (!relevantParents.has(nodeGroupMap.get(id))) continue;
    const box = getAbsoluteBox(id, posMap, nodeGroupMap);
    if (box) obstacles.push(box);
  }
  if (obstacles.length === 0) return { waypoints: [] };

  // Check default L-shape for collisions
  const dx = tgtCx - srcCx, dy = tgtCy - srcCy;
  const horizontal = Math.abs(dx) >= Math.abs(dy);
  const mid = horizontal ? (srcCx + tgtCx) / 2 : (srcCy + tgtCy) / 2;
  const origSegs: [number, number, number, number][] = horizontal
    ? [[srcCx, srcCy, mid, srcCy], [mid, srcCy, mid, tgtCy], [mid, tgtCy, tgtCx, tgtCy]]
    : [[srcCx, srcCy, srcCx, mid], [srcCx, mid, tgtCx, mid], [tgtCx, mid, tgtCx, tgtCy]];

  if (pathSegmentsClear(origSegs, obstacles, 8)) return { waypoints: [] };

  // LCA offset for absolute → edge-parent coordinate conversion
  let lcaOffX = 0, lcaOffY = 0;
  if (lcaId) {
    let cur: string | undefined = lcaId;
    while (cur) {
      const p = posMap.get(cur);
      if (p) { lcaOffX += p.x; lcaOffY += p.y; }
      cur = nodeGroupMap.get(cur);
    }
  }
  const toRel = (ax: number, ay: number) => ({
    x: Math.round(ax - lcaOffX), y: Math.round(ay - lcaOffY),
  });

  const PAD = 12;
  // Include src/tgt in the blocked boxes for corridor search (corridor must not overlap endpoints)
  const allBoxes = [...obstacles, srcBox, tgtBox];

  // ── Strategy A: Vertical corridor (Z-shape) ──
  // Path: src → (clearX, srcCy) → (clearX, tgtCy) → tgt
  const clearX = findClearCorridor(allBoxes, "x",
    Math.min(srcCy, tgtCy), Math.max(srcCy, tgtCy),
    Math.min(srcCx, tgtCx), Math.max(srcCx, tgtCx), PAD);
  if (clearX !== null) {
    const segs: [number, number, number, number][] = [
      [srcCx, srcCy, clearX, srcCy],
      [clearX, srcCy, clearX, tgtCy],
      [clearX, tgtCy, tgtCx, tgtCy],
    ];
    if (pathSegmentsClear(segs, obstacles, PAD)) {
      return {
        waypoints: [toRel(clearX, srcCy), toRel(clearX, tgtCy)],
        exitEntryOverride: `exitX=${clearX > srcCx ? 1 : 0};exitY=0.5;exitDx=0;exitDy=0;entryX=${clearX > tgtCx ? 1 : 0};entryY=0.5;entryDx=0;entryDy=0;`,
      };
    }
  }

  // ── Strategy B: Horizontal band (U-shape) ──
  // Path: src → (srcCx, clearY) → (tgtCx, clearY) → tgt
  const clearY = findClearCorridor(allBoxes, "y",
    Math.min(srcCx, tgtCx), Math.max(srcCx, tgtCx),
    Math.min(srcCy, tgtCy), Math.max(srcCy, tgtCy), PAD);
  if (clearY !== null) {
    const segs: [number, number, number, number][] = [
      [srcCx, srcCy, srcCx, clearY],
      [srcCx, clearY, tgtCx, clearY],
      [tgtCx, clearY, tgtCx, tgtCy],
    ];
    if (pathSegmentsClear(segs, obstacles, PAD)) {
      return {
        waypoints: [toRel(srcCx, clearY), toRel(tgtCx, clearY)],
        exitEntryOverride: `exitX=0.5;exitY=${clearY < srcCy ? 0 : 1};exitDx=0;exitDy=0;entryX=0.5;entryY=${clearY < tgtCy ? 0 : 1};entryDx=0;entryDy=0;`,
      };
    }
  }

  // ── Strategy C: Combined 3-waypoint (corridor + band) ──
  // Path: src → (clearX, srcCy) → (clearX, clearY) → (tgtCx, clearY) → tgt
  if (clearX !== null && clearY !== null) {
    const segs: [number, number, number, number][] = [
      [srcCx, srcCy, clearX, srcCy],
      [clearX, srcCy, clearX, clearY],
      [clearX, clearY, tgtCx, clearY],
      [tgtCx, clearY, tgtCx, tgtCy],
    ];
    if (pathSegmentsClear(segs, obstacles, PAD)) {
      return {
        waypoints: [toRel(clearX, srcCy), toRel(clearX, clearY), toRel(tgtCx, clearY)],
        exitEntryOverride: `exitX=${clearX > srcCx ? 1 : 0};exitY=0.5;exitDx=0;exitDy=0;entryX=0.5;entryY=${clearY < tgtCy ? 0 : 1};entryDx=0;entryDy=0;`,
      };
    }
  }

  // ── Fallback: simple offset detour ──
  // Go above/below (horizontal) or left/right (vertical) of all hit obstacles
  let hitObsMin = Infinity, hitObsMax = -Infinity;
  for (const obs of obstacles) {
    for (const [ax, ay, bx, by] of origSegs) {
      if (segmentHitsBox(ax, ay, bx, by, obs)) {
        const lo = horizontal ? obs.y : obs.x;
        const hi = horizontal ? obs.y + obs.h : obs.x + obs.w;
        hitObsMin = Math.min(hitObsMin, lo);
        hitObsMax = Math.max(hitObsMax, hi);
        break;
      }
    }
  }
  const midPath = horizontal ? (srcCy + tgtCy) / 2 : (srcCx + tgtCx) / 2;
  const detour = Math.abs(midPath - (hitObsMin - 20)) <= Math.abs(midPath - (hitObsMax + 20))
    ? hitObsMin - 20 : hitObsMax + 20;

  if (horizontal) {
    return {
      waypoints: [toRel(srcCx, detour), toRel(tgtCx, detour)],
      exitEntryOverride: `exitX=0.5;exitY=${detour < srcCy ? 0 : 1};exitDx=0;exitDy=0;entryX=0.5;entryY=${detour < tgtCy ? 0 : 1};entryDx=0;entryDy=0;`,
    };
  }
  return {
    waypoints: [toRel(detour, srcCy), toRel(detour, tgtCy)],
    exitEntryOverride: `exitX=${detour < srcCx ? 0 : 1};exitY=0.5;exitDx=0;exitDy=0;entryX=${detour < tgtCx ? 0 : 1};entryY=0.5;entryDx=0;entryDy=0;`,
  };
}

/**
 * Build an edge between two nodes.
 * Style per OCI guide: 1pt line, Bark color, open arrowhead, 8pt label font.
 * - solid (default) = Dataflow connector
 * - dashed = User Interaction connector
 * Uses orthogonal routing with:
 * - Exit/entry points computed from dominant direction
 * - Waypoints routed through gaps between sibling groups (obstacle avoidance)
 * - Edge parent set to LCA of source and target
 */
/**
 * Icons in the OCI library render the glyph in the top portion of the box
 * (~0 to ~0.7 Y) and the label text in the bottom portion (~0.7 to 1.0 Y).
 * So an edge that exits/enters at Y=1 visually crosses the label — ugly.
 * This sanitizer remaps any Y=1 exit/entry on an icon node to a side (X=0 or X=1, Y=0.5),
 * choosing the side that points toward the other endpoint. Also clears waypoints when
 * we make that change since they were computed for the original exit geometry.
 */
function sanitizeIconExits(
  exitEntry: string,
  fromId: string,
  toId: string,
  iconIds: Set<string>,
  posMap: Map<string, { x: number; y: number; w: number; h: number }>,
  nodeGroupMap: Map<string, string>,
): { exitEntry: string; clearedWaypoints: boolean } {
  const srcIsIcon = iconIds.has(fromId);
  const tgtIsIcon = iconIds.has(toId);
  if (!srcIsIcon && !tgtIsIcon) return { exitEntry, clearedWaypoints: false };

  const exY = parseFloat(exitEntry.match(/exitY=([^;]+)/)?.[1] || "0.5");
  const enY = parseFloat(exitEntry.match(/entryY=([^;]+)/)?.[1] || "0.5");
  const srcBottom = srcIsIcon && exY >= 0.99;
  const tgtBottom = tgtIsIcon && enY >= 0.99;
  if (!srcBottom && !tgtBottom) return { exitEntry, clearedWaypoints: false };

  const src = getAbsoluteCenter(fromId, posMap, nodeGroupMap);
  const tgt = getAbsoluteCenter(toId, posMap, nodeGroupMap);
  let result = exitEntry;

  if (srcBottom) {
    const side = tgt.cx >= src.cx ? 1 : 0;
    result = result
      .replace(/exitX=[^;]+;/, `exitX=${side};`)
      .replace(/exitY=[^;]+;/, "exitY=0.5;");
  }
  if (tgtBottom) {
    const side = src.cx >= tgt.cx ? 1 : 0;
    result = result
      .replace(/entryX=[^;]+;/, `entryX=${side};`)
      .replace(/entryY=[^;]+;/, "entryY=0.5;");
  }
  return { exitEntry: result, clearedWaypoints: true };
}

function buildEdge(
  conn: DiagramConnection,
  nodeAnchorMap: Map<string, string>,
  idCounter: { value: number },
  nodeGroupMap: Map<string, string>,
  groupCellMap: Map<string, string>,
  posMap: Map<string, { x: number; y: number; w: number; h: number }>,
  allNodeIds: string[],
  edgeOpacity: number,
  iconIds: Set<string>,
): string | null {
  const sourceId = nodeAnchorMap.get(conn.from);
  const targetId = nodeAnchorMap.get(conn.to);
  if (!sourceId || !targetId) return null;

  const edgeId = `e_${idCounter.value++}`;

  // Annotation circle as edge child: Sienna for `step`, Neutral 4 for `note`. Uses
  // explicit ellipse shape (not edgeLabel) so colors apply. Positioned near source.
  const labelText = conn.label || "";
  let annotationXml = "";
  const half = ANNOTATION_CIRCLE_SIZE / 2;
  const buildAnnotation = (value: string, fill: string): string =>
    `<mxCell id="lbl_${edgeId}" value="${escapeHtml(value)}" style="ellipse;whiteSpace=wrap;html=1;fillColor=${fill};strokeColor=none;fontColor=#FCFBFA;fontSize=10;fontStyle=1;fontFamily=Oracle Sans;align=center;verticalAlign=middle;resizable=0;editable=0;" vertex="1" connectable="0" parent="${edgeId}"><mxGeometry x="-0.5" y="0" width="${ANNOTATION_CIRCLE_SIZE}" height="${ANNOTATION_CIRCLE_SIZE}" relative="1" as="geometry"><mxPoint as="offset" x="-${half}" y="-${half}"/></mxGeometry></mxCell>`;

  if (typeof conn.step === "number" && conn.step > 0) {
    annotationXml = buildAnnotation(String(conn.step), "#AE562C");
  } else if (conn.note && conn.note.trim()) {
    annotationXml = buildAnnotation(conn.note.trim(), "#6B6560");
  }

  const label = labelText ? ` value="${escapeHtml(labelText)}"` : "";
  const isDashed = conn.style === "dashed";
  const dashStyle = isDashed ? "dashed=1;dashPattern=8 8;" : "";
  const labelBg = labelText ? "labelBackgroundColor=#FCFBFA;" : "";

  // Find the lowest common ancestor group for proper edge routing
  const lcaGroupId = findLCA(conn.from, conn.to, nodeGroupMap);
  const edgeParent = lcaGroupId ? (groupCellMap.get(lcaGroupId) || "1") : "1";

  // Compute waypoints for obstacle avoidance (may override exit/entry direction)
  let wpResult = computeWaypoints(conn.from, conn.to, lcaGroupId, nodeGroupMap, posMap, allNodeIds);

  // Fallback: general collision detection when no routing was determined.
  // Skip if computeWaypoints already set an exitEntryOverride (means it handled
  // the routing and determined a straight path needs no waypoints).
  if (wpResult.waypoints.length === 0 && !wpResult.exitEntryOverride) {
    wpResult = detectPathCollisions(conn.from, conn.to, lcaGroupId, nodeGroupMap, posMap, allNodeIds);
  }

  // Use obstacle-avoidance exit/entry if provided, otherwise compute from dominant direction
  let exitEntry = wpResult.exitEntryOverride || computeExitEntry(conn.from, conn.to, posMap, nodeGroupMap);

  // Post-sanitize: icon nodes must never exit/enter from the bottom (that's where
  // the text label sits). Remap Y=1 → side exit.
  const sanitized = sanitizeIconExits(exitEntry, conn.from, conn.to, iconIds, posMap, nodeGroupMap);
  exitEntry = sanitized.exitEntry;
  if (sanitized.clearedWaypoints) {
    wpResult = { waypoints: [], exitEntryOverride: undefined };
  }

  let geoInner = "";
  if (wpResult.waypoints.length > 0) {
    const pts = wpResult.waypoints.map(w => `<mxPoint x="${w.x}" y="${w.y}"/>`).join("");
    geoInner = `<Array as="points">${pts}</Array>`;
  }

  const edgeXml = `<mxCell id="${edgeId}"${label} style="edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;endArrow=open;endFill=0;endSize=6;startArrow=none;startFill=0;strokeColor=#312D2A;strokeWidth=1.5;opacity=${edgeOpacity};fontFamily=Oracle Sans;fontSize=8;fontColor=#312D2A;${exitEntry}${dashStyle}${labelBg}" edge="1" source="${sourceId}" target="${targetId}" parent="${edgeParent}"><mxGeometry relative="1" as="geometry">${geoInner}</mxGeometry></mxCell>`;
  return edgeXml + annotationXml;
}

/**
 * Post-process edges so that multiple connections sharing the same side of a node
 * get evenly-spaced connection points instead of all hitting the center.
 * Sorts by the opposite endpoint's position for visual consistency
 * (e.g., top source connects higher on the target side).
 */
function spreadEdgePorts(
  edgeXmls: string[],
  anchorPositions: Map<string, { cx: number; cy: number }>,
): string[] {
  interface PortEdge { idx: number; srcId: string; tgtId: string; exitSide: string; entrySide: string }

  const parsed: PortEdge[] = [];
  for (let i = 0; i < edgeXmls.length; i++) {
    const xml = edgeXmls[i];
    const src = xml.match(/source="([^"]+)"/)?.[1];
    const tgt = xml.match(/target="([^"]+)"/)?.[1];
    if (!src || !tgt) continue;
    const exX = parseFloat(xml.match(/exitX=([^;]+)/)?.[1] || "0.5");
    const exY = parseFloat(xml.match(/exitY=([^;]+)/)?.[1] || "0.5");
    const enX = parseFloat(xml.match(/entryX=([^;]+)/)?.[1] || "0.5");
    const enY = parseFloat(xml.match(/entryY=([^;]+)/)?.[1] || "0.5");
    const exitSide = exX <= 0.01 ? "L" : exX >= 0.99 ? "R" : exY <= 0.01 ? "T" : "B";
    const entrySide = enX <= 0.01 ? "L" : enX >= 0.99 ? "R" : enY <= 0.01 ? "T" : "B";
    parsed.push({ idx: i, srcId: src, tgtId: tgt, exitSide, entrySide });
  }

  // Unified groups: combine all edges touching the same (node, side),
  // whether as exit or entry. This ensures bidirectional edges (A→B and B→A)
  // sharing the same side of a node get spread apart.
  interface PortSlot { edgeIdx: number; isExit: boolean; oppositeId: string }
  const unifiedGroups = new Map<string, PortSlot[]>();
  for (const e of parsed) {
    const ek = `${e.srcId}|${e.exitSide}`;
    if (!unifiedGroups.has(ek)) unifiedGroups.set(ek, []);
    unifiedGroups.get(ek)!.push({ edgeIdx: e.idx, isExit: true, oppositeId: e.tgtId });

    const nk = `${e.tgtId}|${e.entrySide}`;
    if (!unifiedGroups.has(nk)) unifiedGroups.set(nk, []);
    unifiedGroups.get(nk)!.push({ edgeIdx: e.idx, isExit: false, oppositeId: e.srcId });
  }

  const result = [...edgeXmls];

  for (const [key, slots] of unifiedGroups) {
    if (slots.length <= 1) continue;
    const side = key.split("|")[1];
    const isVerticalSide = side === "L" || side === "R";

    // Sort by opposite endpoint position for visual consistency
    slots.sort((a, b) => {
      const aPos = anchorPositions.get(a.oppositeId);
      const bPos = anchorPositions.get(b.oppositeId);
      if (!aPos || !bPos) return 0;
      return isVerticalSide ? aPos.cy - bPos.cy : aPos.cx - bPos.cx;
    });

    for (let i = 0; i < slots.length; i++) {
      const pos = Math.round(((i + 1) / (slots.length + 1)) * 100) / 100;
      const { edgeIdx, isExit } = slots[i];
      const attr = isExit
        ? (isVerticalSide ? "exitY" : "exitX")
        : (isVerticalSide ? "entryY" : "entryX");
      result[edgeIdx] = result[edgeIdx].replace(new RegExp(`${attr}=[^;]+;`), `${attr}=${pos};`);
    }
  }

  return result;
}

/**
 * Separate edges that share the same physical corridor segment.
 * A corridor exists only when an edge has 2+ consecutive waypoints at the
 * same X (vertical segment) or same Y (horizontal segment). Single waypoints
 * are turning points, not corridors, and are never separated.
 *
 * Two corridors collide only when they share the same coordinate AND their
 * perpendicular ranges overlap (i.e., the parallel line segments actually
 * overlap visually).
 */
function separateSharedCorridors(edgeXmls: string[]): string[] {
  const edgeWps: { x: number; y: number }[][] = edgeXmls.map(xml => {
    const m = xml.match(/<Array as="points">(.*?)<\/Array>/s);
    if (!m) return [];
    return [...m[1].matchAll(/mxPoint x="([^"]+)" y="([^"]+)"/g)]
      .map(p => ({ x: parseFloat(p[1]), y: parseFloat(p[2]) }));
  });

  // Extract actual corridor segments from edges with 2+ waypoints
  interface Segment { edgeIdx: number; coord: number; rangeMin: number; rangeMax: number; wpIndices: number[] }
  const vertSegs: Segment[] = [];  // vertical corridors (same X)
  const horizSegs: Segment[] = []; // horizontal corridors (same Y)

  for (let i = 0; i < edgeWps.length; i++) {
    const wps = edgeWps[i];
    if (wps.length < 2) continue;
    for (let j = 0; j < wps.length - 1; j++) {
      if (Math.abs(wps[j].x - wps[j + 1].x) <= 3) {
        const rangeLen = Math.abs(wps[j].y - wps[j + 1].y);
        if (rangeLen >= 15) { // Skip point corridors (< 15px = turning point, not a real corridor)
          vertSegs.push({
            edgeIdx: i,
            coord: Math.round((wps[j].x + wps[j + 1].x) / 2),
            rangeMin: Math.min(wps[j].y, wps[j + 1].y),
            rangeMax: Math.max(wps[j].y, wps[j + 1].y),
            wpIndices: [j, j + 1],
          });
        }
      }
      if (Math.abs(wps[j].y - wps[j + 1].y) <= 3) {
        const rangeLen = Math.abs(wps[j].x - wps[j + 1].x);
        if (rangeLen >= 15) { // Skip point corridors
          horizSegs.push({
            edgeIdx: i,
            coord: Math.round((wps[j].y + wps[j + 1].y) / 2),
            rangeMin: Math.min(wps[j].x, wps[j + 1].x),
            rangeMax: Math.max(wps[j].x, wps[j + 1].x),
            wpIndices: [j, j + 1],
          });
        }
      }
    }
  }

  // Group overlapping vertical segments (same X ±5, overlapping Y-range)
  const processGroups = (segs: Segment[], axis: "x" | "y") => {
    const groups: Segment[][] = [];
    for (const seg of segs) {
      let added = false;
      for (const group of groups) {
        if (Math.abs(group[0].coord - seg.coord) <= 5 &&
            seg.rangeMin <= group[0].rangeMax + 5 &&
            seg.rangeMax >= group[0].rangeMin - 5) {
          group.push(seg);
          added = true;
          break;
        }
      }
      if (!added) groups.push([seg]);
    }

    for (const group of groups) {
      if (group.length <= 1) continue;
      const baseCoord = group[0].coord;
      // Adaptive spacing: use 12px per edge but cap at 8px total spread
      // to keep corridors within narrow gaps between groups
      const idealSpacing = 12;
      const maxTotalSpread = 8 * group.length;
      const totalSpan = (group.length - 1) * idealSpacing;
      const spacing = totalSpan > maxTotalSpread
        ? maxTotalSpread / (group.length - 1)
        : idealSpacing;
      const offset = -((group.length - 1) * spacing) / 2;
      for (let k = 0; k < group.length; k++) {
        const newCoord = Math.round(baseCoord + offset + k * spacing);
        const { edgeIdx, wpIndices } = group[k];
        for (const wi of wpIndices) {
          if (axis === "x") edgeWps[edgeIdx][wi].x = newCoord;
          else edgeWps[edgeIdx][wi].y = newCoord;
        }
      }
    }
  };

  processGroups(vertSegs, "x");
  processGroups(horizSegs, "y");

  // Rebuild XMLs with updated waypoints
  return edgeXmls.map((xml, i) => {
    if (edgeWps[i].length === 0) return xml;
    const pts = edgeWps[i].map(w => `<mxPoint x="${w.x}" y="${w.y}"/>`).join("");
    return xml.replace(/<Array as="points">.*?<\/Array>/s, `<Array as="points">${pts}</Array>`);
  });
}

/**
 * After port-spreading changes entry/exit fractions, the last/first waypoint
 * may no longer align with the new port position, causing the arrowhead to
 * point in the wrong direction (e.g., down instead of right).
 *
 * This function snaps the last waypoint Y to the entry Y (for left/right entry)
 * and the first waypoint Y to the exit Y (for left/right exit), ensuring the
 * final/initial approach is horizontal/vertical as expected.
 */
function alignEndpointWaypoints(
  edgeXmls: string[],
  reverseAnchorMap: Map<string, string>,
  posMap: Map<string, { x: number; y: number; w: number; h: number }>,
  nodeGroupMap: Map<string, string>,
  reverseGroupCellMap: Map<string, string>,
): string[] {
  return edgeXmls.map(xml => {
    if (!xml.includes('<Array as="points">')) return xml;

    const wps = [...xml.matchAll(/mxPoint x="([^"]+)" y="([^"]+)"/g)]
      .map(m => ({ x: parseFloat(m[1]), y: parseFloat(m[2]) }));
    if (wps.length < 2) return xml; // single-waypoint edges: skip to avoid conflicts

    const targetAnchor = xml.match(/target="([^"]+)"/)?.[1];
    const sourceAnchor = xml.match(/source="([^"]+)"/)?.[1];
    const edgeParentCell = xml.match(/parent="([^"]+)"/)?.[1] || "1";
    if (!targetAnchor || !sourceAnchor) return xml;

    const targetNodeId = reverseAnchorMap.get(targetAnchor);
    const sourceNodeId = reverseAnchorMap.get(sourceAnchor);

    // Compute LCA absolute offset
    let lcaOffX = 0, lcaOffY = 0;
    const lcaGroupId = reverseGroupCellMap.get(edgeParentCell);
    if (lcaGroupId) {
      let cur: string | undefined = lcaGroupId;
      while (cur) {
        const p = posMap.get(cur);
        if (p) { lcaOffX += p.x; lcaOffY += p.y; }
        cur = nodeGroupMap.get(cur);
      }
    }

    let changed = false;

    // Align last waypoint to entry port
    if (targetNodeId) {
      const enX = parseFloat(xml.match(/entryX=([^;]+)/)?.[1] || "0.5");
      const enY = parseFloat(xml.match(/entryY=([^;]+)/)?.[1] || "0.5");
      const tgtBox = getAbsoluteBox(targetNodeId, posMap, nodeGroupMap);
      if (tgtBox) {
        if (enX <= 0.01 || enX >= 0.99) {
          // Left/right entry: align last wp Y exactly
          const absY = tgtBox.y + tgtBox.h * enY - lcaOffY;
          if (Math.abs(wps[wps.length - 1].y - absY) > 0.5) {
            wps[wps.length - 1].y = Math.round(absY);
            changed = true;
          }
        } else {
          // Top/bottom entry: align last wp X exactly
          const absX = tgtBox.x + tgtBox.w * enX - lcaOffX;
          if (Math.abs(wps[wps.length - 1].x - absX) > 0.5) {
            wps[wps.length - 1].x = Math.round(absX);
            changed = true;
          }
        }
      }
    }

    // Align first waypoint to exit port
    if (sourceNodeId) {
      const exX = parseFloat(xml.match(/exitX=([^;]+)/)?.[1] || "0.5");
      const exY = parseFloat(xml.match(/exitY=([^;]+)/)?.[1] || "0.5");
      const srcBox = getAbsoluteBox(sourceNodeId, posMap, nodeGroupMap);
      if (srcBox) {
        if (exX <= 0.01 || exX >= 0.99) {
          const absY = srcBox.y + srcBox.h * exY - lcaOffY;
          if (Math.abs(wps[0].y - absY) > 0.5) {
            wps[0].y = Math.round(absY);
            changed = true;
          }
        } else {
          const absX = srcBox.x + srcBox.w * exX - lcaOffX;
          if (Math.abs(wps[0].x - absX) > 0.5) {
            wps[0].x = Math.round(absX);
            changed = true;
          }
        }
      }
    }

    if (!changed) return xml;
    const pts = wps.map(w => `<mxPoint x="${w.x}" y="${w.y}"/>`).join("");
    return xml.replace(/<Array as="points">.*?<\/Array>/s, `<Array as="points">${pts}</Array>`);
  });
}

/**
 * Post-process: remove micro-jogs and unnecessary waypoints.
 * Runs after spreading, corridor separation, and alignment to clean up artifacts:
 * 1. Merge consecutive waypoints < 8px apart
 * 2. Remove collinear waypoints (same X or Y within tolerance)
 * 3. Straighten 2-waypoint L-shapes with tiny jog (< 10px)
 */
function cleanupWaypoints(edgeXmls: string[]): string[] {
  return edgeXmls.map(xml => {
    const arrayMatch = xml.match(/<Array as="points">(.*?)<\/Array>/s);
    if (!arrayMatch) return xml;

    let wps = [...arrayMatch[1].matchAll(/mxPoint x="([^"]+)" y="([^"]+)"/g)]
      .map(m => ({ x: parseFloat(m[1]), y: parseFloat(m[2]) }));
    if (wps.length === 0) return xml;

    const origCount = wps.length;
    const origPositions = wps.map(w => ({ ...w }));

    // 1. Merge consecutive waypoints that are very close (< 8px on both axes)
    for (let i = wps.length - 2; i >= 0; i--) {
      if (Math.abs(wps[i].x - wps[i + 1].x) < 8 && Math.abs(wps[i].y - wps[i + 1].y) < 8) {
        wps[i] = {
          x: Math.round((wps[i].x + wps[i + 1].x) / 2),
          y: Math.round((wps[i].y + wps[i + 1].y) / 2),
        };
        wps.splice(i + 1, 1);
      }
    }

    // 2. Remove collinear points (same X or same Y within 3px tolerance)
    for (let i = wps.length - 2; i >= 1; i--) {
      const sameX = Math.abs(wps[i - 1].x - wps[i].x) < 3 && Math.abs(wps[i].x - wps[i + 1].x) < 3;
      const sameY = Math.abs(wps[i - 1].y - wps[i].y) < 3 && Math.abs(wps[i].y - wps[i + 1].y) < 3;
      if (sameX || sameY) wps.splice(i, 1);
    }

    // 3. For 2-waypoint L-shapes with tiny jog (< 10px), straighten
    if (wps.length === 2) {
      const dx = Math.abs(wps[0].x - wps[1].x);
      const dy = Math.abs(wps[0].y - wps[1].y);
      if (dx < 10 && dy > 0) {
        const avgX = Math.round((wps[0].x + wps[1].x) / 2);
        wps[0].x = avgX;
        wps[1].x = avgX;
      }
      if (dy < 10 && dx > 0) {
        const avgY = Math.round((wps[0].y + wps[1].y) / 2);
        wps[0].y = avgY;
        wps[1].y = avgY;
      }
    }

    // 4. Deduplicate: if consecutive waypoints are now identical, keep one
    for (let i = wps.length - 2; i >= 0; i--) {
      if (Math.abs(wps[i].x - wps[i + 1].x) < 2 && Math.abs(wps[i].y - wps[i + 1].y) < 2) {
        wps.splice(i + 1, 1);
      }
    }

    // Check if anything changed
    if (wps.length === origCount && wps.every((w, i) =>
      Math.abs(w.x - origPositions[i].x) < 0.5 && Math.abs(w.y - origPositions[i].y) < 0.5)) {
      return xml;
    }

    if (wps.length === 0) {
      return xml.replace(/<Array as="points">.*?<\/Array>/s, "");
    }
    const pts = wps.map(w => `<mxPoint x="${w.x}" y="${w.y}"/>`).join("");
    return xml.replace(/<Array as="points">.*?<\/Array>/s, `<Array as="points">${pts}</Array>`);
  });
}

/**
 * Distribute edge labels along the path, preferring horizontal segments.
 * Reconstructs the full path including source→wp[0] and wp[last]→target
 * (the implicit segments drawn by draw.io) to find horizontal stretches.
 * Uses mxGeometry x attribute (fraction -1..1, 0 = center of edge).
 */
function offsetEdgeLabels(
  edgeXmls: string[],
  reverseAnchorMap: Map<string, string>,
  posMap: Map<string, { x: number; y: number; w: number; h: number }>,
  nodeGroupMap: Map<string, string>,
): string[] {
  const result = [...edgeXmls];
  // Group labeled edges by source node
  const groups = new Map<string, number[]>();
  for (let i = 0; i < result.length; i++) {
    const val = result[i].match(/value="([^"]*)"/)?.[1];
    if (!val) continue;
    const src = result[i].match(/source="([^"]+)"/)?.[1] || "";
    if (!groups.has(src)) groups.set(src, []);
    groups.get(src)!.push(i);
  }
  for (const [_, group] of groups) {
    for (let k = 0; k < group.length; k++) {
      const idx = group[k];
      const xml = result[idx];
      let pos = computeHorizontalLabelPos(xml, reverseAnchorMap, posMap, nodeGroupMap);
      // If multiple edges from same source, spread labels slightly
      if (group.length > 1) {
        const spread = 0.15 * (k - (group.length - 1) / 2);
        pos = Math.round((pos + spread) * 100) / 100;
        pos = Math.max(-0.8, Math.min(0.8, pos));
      }
      result[idx] = result[idx].replace(
        /<mxGeometry[^>]*relative="1"/,
        `<mxGeometry x="${pos}" relative="1"`,
      );
    }
  }
  return result;
}

/**
 * Compute the mxGeometry x value that places the label on the longest
 * horizontal segment of the full edge path (source exit → waypoints → target entry).
 */
function computeHorizontalLabelPos(
  xml: string,
  reverseAnchorMap: Map<string, string>,
  posMap: Map<string, { x: number; y: number; w: number; h: number }>,
  nodeGroupMap: Map<string, string>,
): number {
  const wps = [...xml.matchAll(/mxPoint x="([^"]+)" y="([^"]+)"/g)]
    .map(m => ({ x: parseFloat(m[1]), y: parseFloat(m[2]) }));

  if (wps.length === 0) return 0;

  // Get source and target exit/entry positions
  const sourceAnchor = xml.match(/source="([^"]+)"/)?.[1];
  const targetAnchor = xml.match(/target="([^"]+)"/)?.[1];
  if (!sourceAnchor || !targetAnchor) return 0;

  const srcNodeId = reverseAnchorMap.get(sourceAnchor);
  const tgtNodeId = reverseAnchorMap.get(targetAnchor);
  if (!srcNodeId || !tgtNodeId) return 0;

  const srcBox = getAbsoluteBox(srcNodeId, posMap, nodeGroupMap);
  const tgtBox = getAbsoluteBox(tgtNodeId, posMap, nodeGroupMap);
  if (!srcBox || !tgtBox) return 0;

  const exitXf = parseFloat(xml.match(/exitX=([^;]+)/)?.[1] || "0.5");
  const exitYf = parseFloat(xml.match(/exitY=([^;]+)/)?.[1] || "0.5");
  const entryXf = parseFloat(xml.match(/entryX=([^;]+)/)?.[1] || "0.5");
  const entryYf = parseFloat(xml.match(/entryY=([^;]+)/)?.[1] || "0.5");

  // Full path: source exit point → waypoints → target entry point
  const srcPt = { x: srcBox.x + srcBox.w * exitXf, y: srcBox.y + srcBox.h * exitYf };
  const tgtPt = { x: tgtBox.x + tgtBox.w * entryXf, y: tgtBox.y + tgtBox.h * entryYf };
  const pts = [srcPt, ...wps, tgtPt];

  // Compute segments with lengths
  const segments: { len: number; horizontal: boolean; midFrac: number }[] = [];
  let totalLen = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const dx = pts[i + 1].x - pts[i].x;
    const dy = pts[i + 1].y - pts[i].y;
    const len = Math.sqrt(dx * dx + dy * dy);
    const horizontal = Math.abs(dy) < 2 && Math.abs(dx) > 5;
    segments.push({ len, horizontal, midFrac: 0 });
    totalLen += len;
  }
  if (totalLen < 1) return 0;

  // Compute midpoint fraction for each segment
  let cumLen = 0;
  for (const seg of segments) {
    cumLen += seg.len / 2;
    seg.midFrac = cumLen / totalLen;
    cumLen += seg.len / 2;
  }

  // Find the longest horizontal segment
  let bestSeg: typeof segments[0] | null = null;
  for (const seg of segments) {
    if (seg.horizontal && (!bestSeg || seg.len > bestSeg.len)) {
      bestSeg = seg;
    }
  }
  if (!bestSeg) return 0;

  // Map [0..1] fraction to draw.io x attribute [-1..1]
  return Math.round((bestSeg.midFrac * 2 - 1) * 100) / 100;
}

export interface DiagramResult {
  xml: string;
  errors: string[];
}

// ─── Auto-Layout ─────────────────────────────────────────────────────────────
// Computes x/y/w/h for nodes and groups when not provided by the caller.
// Uses a connectivity-aware layout: nodes that share many connections are
// placed close together, and cross-group connected nodes are placed near
// the edge facing the connected group.

const LAYOUT_NODE_H_SPACING = 90;   // horizontal distance between node centers
const LAYOUT_NODE_V_SPACING = 90;   // vertical distance between node rows
const LAYOUT_GROUP_PAD_X = 25;      // horizontal padding inside group
const LAYOUT_GROUP_PAD_TOP = 30;    // top padding (room for group title)
const LAYOUT_GROUP_PAD_BOT = 20;    // bottom padding
const LAYOUT_GROUP_GAP = 50;        // gap between sibling groups

/**
 * Order node IDs so that highly-connected nodes sit adjacent.
 * Greedy nearest-neighbor: start with the highest-degree node,
 * then always pick the unvisited node most connected to the already-placed set.
 */
function orderByConnectivity(nodeIds: string[], adj: Map<string, Set<string>>): string[] {
  if (nodeIds.length <= 1) return [...nodeIds];
  const remaining = new Set(nodeIds);
  const ordered: string[] = [];

  // Start with highest-degree node
  let start = nodeIds[0];
  let maxDeg = 0;
  for (const id of nodeIds) {
    const deg = adj.get(id)?.size ?? 0;
    if (deg > maxDeg) { maxDeg = deg; start = id; }
  }
  ordered.push(start);
  remaining.delete(start);

  while (remaining.size > 0) {
    let best = "";
    let bestScore = -1;
    for (const id of remaining) {
      const neighbors = adj.get(id) ?? new Set<string>();
      let score = 0;
      for (const placed of ordered) {
        if (neighbors.has(placed)) score++;
      }
      // Tie-break by total degree (×1000 to dominate)
      score = score * 1000 + (adj.get(id)?.size ?? 0);
      if (score > bestScore) { bestScore = score; best = id; }
    }
    ordered.push(best);
    remaining.delete(best);
  }
  return ordered;
}

/**
 * Assign positions to all nodes and groups based on the connection graph.
 * Modifies the arrays in-place (sets x/y/w/h).
 */
function autoLayout(
  nodes: DiagramNode[],
  connections: DiagramConnection[],
  groups: DiagramGroup[],
): void {
  const nodeMap = new Map(nodes.map(n => [n.id, n]));

  // Build full adjacency
  const adj = new Map<string, Set<string>>();
  for (const n of nodes) adj.set(n.id, new Set());
  for (const c of connections) {
    adj.get(c.from)?.add(c.to);
    adj.get(c.to)?.add(c.from);
  }

  // Node → group mapping
  const nodeToGroup = new Map<string, string>();
  for (const g of groups) {
    for (const child of g.children ?? []) {
      nodeToGroup.set(child, g.id);
    }
  }

  // ── Step 1: Determine group row assignment via inter-group flow ──
  // Build directed inter-group edge counts (from → to)
  const groupIds = groups.map(g => g.id);
  const interGroupDown = new Map<string, Map<string, number>>(); // gFrom → gTo → count
  for (const gid of groupIds) interGroupDown.set(gid, new Map());
  for (const c of connections) {
    const gFrom = nodeToGroup.get(c.from);
    const gTo = nodeToGroup.get(c.to);
    if (gFrom && gTo && gFrom !== gTo) {
      const m = interGroupDown.get(gFrom)!;
      m.set(gTo, (m.get(gTo) ?? 0) + 1);
    }
  }

  // Row assignment: BFS from the most-connected group (hub-first layout).
  // This puts the hub group (e.g. Application Tier) in row 0, with its
  // neighbors side-by-side in row 1, their neighbors in row 2, etc.
  const groupConnCount = new Map<string, number>();
  for (const gid of groupIds) {
    let count = 0;
    for (const [, n] of interGroupDown.get(gid) ?? new Map()) count += n;
    // Also count incoming
    for (const [src, targets] of interGroupDown) {
      if (src !== gid) count += targets.get(gid) ?? 0;
    }
    groupConnCount.set(gid, count);
  }

  // Start BFS from the group with most connections
  const sortedByConn = [...groupIds].sort((a, b) => (groupConnCount.get(b) ?? 0) - (groupConnCount.get(a) ?? 0));
  const groupRow = new Map<string, number>();
  const visited = new Set<string>();
  const queue: string[] = [];

  // Seed with the most-connected group
  if (sortedByConn.length > 0) {
    const hub = sortedByConn[0];
    groupRow.set(hub, 0);
    visited.add(hub);
    queue.push(hub);
  }

  let qi = 0;
  while (qi < queue.length) {
    const gid = queue[qi++];
    const row = groupRow.get(gid) ?? 0;
    // Find all groups connected to this one (undirected)
    const neighbors = new Set<string>();
    for (const [tgt] of interGroupDown.get(gid) ?? new Map()) neighbors.add(tgt);
    for (const [src, targets] of interGroupDown) {
      if (targets.has(gid)) neighbors.add(src);
    }
    for (const nb of neighbors) {
      if (!visited.has(nb)) {
        visited.add(nb);
        groupRow.set(nb, row + 1);
        queue.push(nb);
      }
    }
  }

  // Assign any disconnected groups to row 0
  for (const gid of groupIds) {
    if (!groupRow.has(gid)) groupRow.set(gid, 0);
  }

  // ── Step 2: Within each group, order nodes by connectivity ──
  // Also consider cross-group flow: nodes connecting to groups BELOW go to the bottom row.
  for (const group of groups) {
    const children = (group.children ?? []).filter(id => nodeMap.has(id));
    if (children.length === 0) {
      group.w = group.w ?? 100;
      group.h = group.h ?? 60;
      continue;
    }

    // Determine which children connect to groups in other rows
    const myRow = groupRow.get(group.id) ?? 0;
    const connectsBelow = new Set<string>();
    const connectsAbove = new Set<string>();
    for (const c of connections) {
      const otherNode = children.includes(c.from) ? c.to : children.includes(c.to) ? c.from : null;
      const thisNode = children.includes(c.from) ? c.from : children.includes(c.to) ? c.to : null;
      if (!otherNode || !thisNode) continue;
      const otherGroup = nodeToGroup.get(otherNode);
      if (!otherGroup || otherGroup === group.id) continue;
      const otherRow = groupRow.get(otherGroup) ?? 0;
      if (otherRow > myRow) connectsBelow.add(thisNode);
      if (otherRow < myRow) connectsAbove.add(thisNode);
    }

    // Order by connectivity
    const ordered = orderByConnectivity(children, adj);

    // Decide grid dimensions
    const n = ordered.length;
    let cols: number, rows: number;
    if (n <= 3) {
      cols = n; rows = 1;
    } else {
      cols = Math.ceil(n / 2);
      rows = 2;
    }

    // If we have 2 rows, place nodes connecting below in the bottom row
    // and nodes connecting above in the top row
    let topRow: string[] = [];
    let botRow: string[] = [];
    if (rows === 2) {
      // Split: nodes connecting below → bottom, rest → top
      const belowNodes = ordered.filter(id => connectsBelow.has(id) && !connectsAbove.has(id));
      const aboveNodes = ordered.filter(id => connectsAbove.has(id) && !connectsBelow.has(id));
      const neutralNodes = ordered.filter(id => !connectsBelow.has(id) && !connectsAbove.has(id) && !connectsAbove.has(id));
      const bothNodes = ordered.filter(id => connectsBelow.has(id) && connectsAbove.has(id));

      // Fill top row first, then bottom
      topRow = [...aboveNodes, ...neutralNodes, ...bothNodes];
      botRow = [...belowNodes];

      // Balance: move excess from top to bottom
      while (topRow.length > cols && botRow.length < cols) {
        botRow.push(topRow.pop()!);
      }
      while (botRow.length > cols && topRow.length < cols) {
        topRow.push(botRow.pop()!);
      }
      // If one row is empty, redistribute
      if (topRow.length === 0) {
        topRow = botRow.splice(0, Math.ceil(botRow.length / 2));
      }
      if (botRow.length === 0 && topRow.length > cols) {
        botRow = topRow.splice(cols);
      }
    } else {
      topRow = ordered;
    }

    // Place nodes
    const allRows = rows === 2 ? [topRow, botRow] : [topRow];
    const maxCols = Math.max(...allRows.map(r => r.length));
    for (let r = 0; r < allRows.length; r++) {
      const row = allRows[r];
      // Center this row if fewer items than maxCols
      const offsetX = Math.round((maxCols - row.length) * LAYOUT_NODE_H_SPACING / 2);
      for (let c = 0; c < row.length; c++) {
        const node = nodeMap.get(row[c]);
        if (node) {
          node.x = LAYOUT_GROUP_PAD_X + offsetX + c * LAYOUT_NODE_H_SPACING;
          node.y = LAYOUT_GROUP_PAD_TOP + r * LAYOUT_NODE_V_SPACING;
        }
      }
    }

    // Size the group
    const actualRows = allRows.length;
    group.w = LAYOUT_GROUP_PAD_X * 2 + maxCols * LAYOUT_NODE_H_SPACING - (LAYOUT_NODE_H_SPACING - STANDARD_ICON_W) - 10;
    group.h = LAYOUT_GROUP_PAD_TOP + LAYOUT_GROUP_PAD_BOT + actualRows * LAYOUT_NODE_V_SPACING - (LAYOUT_NODE_V_SPACING - STANDARD_ICON_H - 16);
  }

  // ── Step 3: Arrange groups on the canvas ──
  // Collect rows of groups
  const rowsOfGroups = new Map<number, DiagramGroup[]>();
  for (const g of groups) {
    const r = groupRow.get(g.id) ?? 0;
    if (!rowsOfGroups.has(r)) rowsOfGroups.set(r, []);
    rowsOfGroups.get(r)!.push(g);
  }

  // Within each row, sort groups so that connected ones are adjacent
  // (use the same greedy connectivity ordering, but on groups)
  const groupAdj = new Map<string, Set<string>>();
  for (const gid of groupIds) groupAdj.set(gid, new Set());
  for (const c of connections) {
    const gFrom = nodeToGroup.get(c.from);
    const gTo = nodeToGroup.get(c.to);
    if (gFrom && gTo && gFrom !== gTo) {
      groupAdj.get(gFrom)!.add(gTo);
      groupAdj.get(gTo)!.add(gFrom);
    }
  }

  let canvasY = 20;
  const sortedRows = [...rowsOfGroups.keys()].sort((a, b) => a - b);
  for (const rowIdx of sortedRows) {
    const rowGroups = rowsOfGroups.get(rowIdx)!;
    const orderedGroupIds = orderByConnectivity(rowGroups.map(g => g.id), groupAdj);

    let x = 20;
    let maxH = 0;
    for (const gid of orderedGroupIds) {
      const g = groups.find(g2 => g2.id === gid)!;
      g.x = x;
      g.y = canvasY;
      x += (g.w ?? 100) + LAYOUT_GROUP_GAP;
      maxH = Math.max(maxH, g.h ?? 60);
    }
    canvasY += maxH + LAYOUT_GROUP_GAP;
  }

  // Handle ungrouped nodes — place them after all groups
  const ungrouped = nodes.filter(n => !nodeToGroup.has(n.id));
  if (ungrouped.length > 0) {
    let ux = 20;
    for (const n of ungrouped) {
      if (n.x === undefined) n.x = ux;
      if (n.y === undefined) n.y = canvasY;
      ux += LAYOUT_NODE_H_SPACING;
    }
  }
}

/**
 * Post-layout validation + auto-fix. Runs after coords are set (by caller or autoLayout).
 * - Auto-sizes groups (bottom-up) when w/h is missing or too small for children.
 * - Detects self-loops, overflow, orphans, and missing connection endpoints.
 * - Mutates groups[] to grow sizes; returns warning strings.
 */
function validateAndAutoSize(
  nodes: DiagramNode[],
  connections: DiagramConnection[],
  groups: DiagramGroup[],
): string[] {
  const warnings: string[] = [];
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const groupMap = new Map(groups.map(g => [g.id, g]));

  const parentOf = new Map<string, string>();
  for (const g of groups) {
    for (const cid of g.children ?? []) parentOf.set(cid, g.id);
  }

  // Step placeholder abuse detection. Two complementary rules:
  // 1) Bulk abuse: if ≥90% of connections have a step value, the LLM defaulted the
  //    field on every edge. Drop all steps.
  // 2) Value abuse: any single step number appearing on ≥5 connections is placeholder.
  //    (Legit duplicates across parallel paths usually max out at 2-3 occurrences.)
  const withStep = connections.filter(c => typeof c.step === "number" && c.step! > 0);
  if (withStep.length > 0 && withStep.length / connections.length >= 0.9) {
    for (const c of connections) c.step = undefined;
    warnings.push(
      `${withStep.length}/${connections.length} connections had a step value — placeholder abuse. All dropped. Only pass "step" on user-numbered arrows (typically 3-5 per diagram).`,
    );
  } else {
    const stepCount = new Map<number, number>();
    for (const c of withStep) stepCount.set(c.step!, (stepCount.get(c.step!) ?? 0) + 1);
    const abused = [...stepCount.entries()].filter(([, n]) => n >= 5).map(([s]) => s);
    if (abused.length > 0) {
      for (const c of connections) {
        if (typeof c.step === "number" && abused.includes(c.step)) c.step = undefined;
      }
      warnings.push(
        `Step value(s) ${abused.join(", ")} appeared on 5+ connections — placeholder abuse. Dropped.`,
      );
    }
  }

  // Memoized depth: root groups = 0, nested groups increment. Deepest first for bottom-up sizing.
  const depthCache = new Map<string, number>();
  const depthOf = (id: string): number => {
    const cached = depthCache.get(id);
    if (cached !== undefined) return cached;
    const p = parentOf.get(id);
    const d = p ? depthOf(p) + 1 : 0;
    depthCache.set(id, d);
    return d;
  };
  const byDepthDesc = [...groups].sort((a, b) => depthOf(b.id) - depthOf(a.id));

  const childSize = (id: string): { w: number; h: number } | null => {
    const n = nodeMap.get(id);
    if (n) {
      const def = getDefaultNodeSize(n.shape);
      return { w: n.w ?? def.w, h: n.h ?? def.h };
    }
    const g = groupMap.get(id);
    if (g) return { w: g.w ?? MIN_GROUP_W, h: g.h ?? MIN_GROUP_H };
    return null;
  };

  // Auto-position + auto-size groups bottom-up. Children missing x/y get horizontal
  // flow coords; then the group tightly wraps them. Bottom-up means sub-groups
  // already have their dimensions set when their parents compute theirs.
  const fitDim = (
    current: number | undefined,
    needed: number,
    fit: number,
    gid: string,
    axis: "width" | "height",
  ): number => {
    if (current === undefined) return fit;
    if (current < needed) {
      warnings.push(`Group "${gid}" ${axis} ${current} too small (need ${needed}) — auto-grew to ${fit}.`);
      return fit;
    }
    if (current > needed * 1.15) {
      warnings.push(`Group "${gid}" ${axis} ${current} oversized (need ${needed}) — auto-shrank to ${fit}.`);
      return fit;
    }
    return current;
  };

  for (const g of byDepthDesc) {
    const children = g.children ?? [];
    if (children.length === 0) continue;

    // Fallback positioning: only when the LLM didn't provide coords. Cookbook-guided
    // coords are preferred — this produces a stretched horizontal flow.
    let flowX = LAYOUT_GROUP_PAD_X;
    let fallbackUsed = false;
    let maxX = 0, maxY = 0, sized = false;
    for (const cid of children) {
      const child = nodeMap.get(cid) ?? groupMap.get(cid);
      if (!child) continue;
      const sz = childSize(cid);
      if (!sz) continue;
      if (child.x === undefined || child.y === undefined) {
        child.x = flowX;
        child.y = LAYOUT_GROUP_PAD_TOP;
        flowX += sz.w + FLOW_GAP;
        fallbackUsed = true;
      }
      maxX = Math.max(maxX, child.x + sz.w);
      maxY = Math.max(maxY, child.y + sz.h);
      sized = true;
    }
    if (fallbackUsed) {
      warnings.push(
        `Group "${g.id}" had children without coords — applied stretched horizontal fallback. For a proper layout, use the Cookbook formula in create_oci_diagram's description.`,
      );
    }
    if (!sized) continue;

    const neededW = maxX + LAYOUT_GROUP_PAD_X;
    const neededH = maxY + LAYOUT_GROUP_PAD_BOT;
    g.w = fitDim(g.w, neededW, Math.max(neededW, MIN_GROUP_W), g.id, "width");
    g.h = fitDim(g.h, neededH, Math.max(neededH, MIN_GROUP_H), g.id, "height");
  }

  // Root-level fallback positioning (horizontal row) — same story, only used if missing.
  let rootX = 20;
  for (const item of [...groups, ...nodes] as (DiagramGroup | DiagramNode)[]) {
    if (parentOf.has(item.id)) continue;
    if (item.x === undefined || item.y === undefined) {
      const sz = childSize(item.id);
      if (!sz) continue;
      item.x = rootX;
      item.y = 20;
      rootX += sz.w + LAYOUT_GROUP_GAP;
    }
  }

  // 2b. Overflow detection (children that escape parent bounds even after auto-grow)
  for (const g of groups) {
    for (const cid of g.children ?? []) {
      const child = nodeMap.get(cid) ?? groupMap.get(cid);
      if (!child) {
        warnings.push(`Group "${g.id}" references missing child "${cid}".`);
        continue;
      }
      if (child.x === undefined || child.y === undefined) continue;
      const sz = childSize(cid);
      if (!sz) continue;
      const gw = g.w ?? 100, gh = g.h ?? 60;
      if (child.x < 0 || child.y < 0 || child.x + sz.w > gw || child.y + sz.h > gh) {
        warnings.push(
          `Child "${cid}" at (${child.x},${child.y},${sz.w}×${sz.h}) overflows parent "${g.id}" (${gw}×${gh}). ` +
          `Coords are RELATIVE to parent — first child typically starts at (${LAYOUT_GROUP_PAD_X},${LAYOUT_GROUP_PAD_TOP}).`,
        );
      }
    }
  }

  // 3. Self-loops: filter and warn (caller drops them before buildEdge)
  for (const c of connections) {
    if (c.from === c.to) {
      warnings.push(
        `Self-loop "${c.from}" → "${c.to}"${c.label ? ` (label "${c.label}")` : ""} dropped. ` +
        `If this was meant as an annotation for a step, connect it from the acting node (e.g. a user/developer) to the target instead.`,
      );
    }
  }

  // 4. Missing endpoints
  const allIds = new Set([...nodes.map(n => n.id), ...groups.map(g => g.id)]);
  for (const c of connections) {
    if (c.from !== c.to) {
      if (!allIds.has(c.from)) warnings.push(`Connection source "${c.from}" not in nodes/groups.`);
      if (!allIds.has(c.to)) warnings.push(`Connection target "${c.to}" not in nodes/groups.`);
    }
  }

  // 5. Orphan nodes (not inside any group AND not connected)
  const connected = new Set<string>();
  for (const c of connections) {
    if (c.from !== c.to) { connected.add(c.from); connected.add(c.to); }
  }
  const inSomeGroup = new Set(parentOf.keys());
  for (const n of nodes) {
    if (!inSomeGroup.has(n.id) && !connected.has(n.id)) {
      warnings.push(`Node "${n.id}" is orphan — not inside any group and not connected. Remove it or wire it up.`);
    }
  }

  // Sibling overlap: two items at the same nesting level whose bounding boxes intersect.
  // Catches the bug where the LLM places a node at coords that fall inside a sibling
  // group — they're visually overlapping even though they're not nested.
  const siblingsByParent = new Map<string | null, string[]>();
  const addSibling = (id: string) => {
    const p = parentOf.get(id) ?? null;
    if (!siblingsByParent.has(p)) siblingsByParent.set(p, []);
    siblingsByParent.get(p)!.push(id);
  };
  for (const g of groups) addSibling(g.id);
  for (const n of nodes) addSibling(n.id);

  const getBox = (id: string): { x: number; y: number; w: number; h: number } | null => {
    const item = groupMap.get(id) ?? nodeMap.get(id);
    if (!item || item.x === undefined || item.y === undefined) return null;
    const sz = childSize(id);
    return sz ? { x: item.x, y: item.y, w: sz.w, h: sz.h } : null;
  };

  for (const [parentId, siblings] of siblingsByParent) {
    for (let i = 0; i < siblings.length; i++) {
      for (let j = i + 1; j < siblings.length; j++) {
        const boxA = getBox(siblings[i]);
        const boxB = getBox(siblings[j]);
        if (!boxA || !boxB) continue;
        const overlap =
          boxA.x < boxB.x + boxB.w &&
          boxA.x + boxA.w > boxB.x &&
          boxA.y < boxB.y + boxB.h &&
          boxA.y + boxA.h > boxB.y;
        if (overlap) {
          const parentLabel = parentId === null ? "root" : `"${parentId}"`;
          warnings.push(
            `Sibling overlap inside ${parentLabel}: "${siblings[i]}" (${boxA.x},${boxA.y},${boxA.w}×${boxA.h}) and "${siblings[j]}" (${boxB.x},${boxB.y},${boxB.w}×${boxB.h}) intersect. Reposition one, or if one should contain the other, add it to the container's children[].`,
          );
        }
      }
    }
  }

  return warnings;
}

/**
 * Build a complete mxGraphModel XML from nodes, connections, and groups.
 * @param scale - Scale factor for icon shapes (default 0.5 = half size per OCI style guide)
 */
export function buildDiagram(
  nodes: DiagramNode[],
  connections: DiagramConnection[] = [],
  groups: DiagramGroup[] = [],
  scale: number = DEFAULT_ICON_SCALE,
): DiagramResult {
  // LLMs instructed to omit coords often pass placeholder zeros instead. Normalize
  // to undefined so auto-layout runs. Groups: all-zero clears everything. Nodes
  // inside a group with (0,0) also clear — root-level (0,0) could be intentional.
  const childToParent = new Map<string, string>();
  for (const g of groups) for (const cid of g.children ?? []) childToParent.set(cid, g.id);
  for (const g of groups) {
    if (g.x === 0 && g.y === 0 && !g.w && !g.h) {
      g.x = g.y = g.w = g.h = undefined;
    } else {
      if (g.w === 0) g.w = undefined;
      if (g.h === 0) g.h = undefined;
    }
  }
  for (const n of nodes) {
    if (n.x === 0 && n.y === 0 && childToParent.has(n.id)) {
      n.x = n.y = undefined;
    }
  }

  // autoLayout is flat-only; skip it for nested structures (validateAndAutoSize handles those).
  const groupIds = new Set(groups.map(g => g.id));
  const hasNestedGroups = groups.some(g => (g.children ?? []).some(cid => groupIds.has(cid)));
  const needsLayout = nodes.some(n => n.x === undefined || n.y === undefined)
    || groups.some(g => g.x === undefined || g.y === undefined);
  if (needsLayout && !hasNestedGroups) {
    autoLayout(nodes, connections, groups);
  }

  // Validate + auto-size groups; collect warnings. Drop self-loops before edge building.
  const validationWarnings = validateAndAutoSize(nodes, connections, groups);
  connections = connections.filter(c => c.from !== c.to);

  const shapes = loadShapes();
  const errors: string[] = [];
  const allCells: string[] = [];
  const idCounter = { value: 100 };

  // Map from user node ID → first mxCell ID (for edge connections)
  const nodeAnchorMap = new Map<string, string>();

  // Map from group ID → group cell ID
  const groupCellMap = new Map<string, string>();

  // Map from child ID → parent group ID (for both nodes AND sub-groups)
  const nodeGroupMap = new Map<string, string>();
  for (const group of groups) {
    if (group.children) {
      for (const childId of group.children) {
        nodeGroupMap.set(childId, group.id);
      }
    }
  }

  // Position map for absolute center calculation (used by edge exit/entry)
  const posMap = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const group of groups) {
    posMap.set(group.id, { x: group.x ?? 0, y: group.y ?? 0, w: group.w ?? 100, h: group.h ?? 60 });
  }
  for (const node of nodes) {
    const def = getDefaultNodeSize(node.shape);
    posMap.set(node.id, { x: node.x ?? 0, y: node.y ?? 0, w: node.w || def.w, h: node.h || def.h });
  }

  // 1. Build group containers first (order matters: parents before children)
  for (const group of groups) {
    const parentGroupId = nodeGroupMap.get(group.id);
    const parentCellId = parentGroupId ? groupCellMap.get(parentGroupId) : undefined;

    // Check for component box groups (e.g. component/expanded)
    const compGroup = buildComponentGroup(group, idCounter, parentCellId || "1");
    if (compGroup) {
      allCells.push(compGroup.cellXml);
      groupCellMap.set(group.id, compGroup.cellId);
      continue;
    }

    const resolved = resolveShape(group.shape);
    if (!resolved) {
      errors.push(`Group "${group.id}": shape "${group.shape}" not found`);
      const cellId = `g_${group.id}_${idCounter.value++}`;
      allCells.push(`<mxCell id="${cellId}" value="${escapeHtml(group.label)}" style="rounded=1;whiteSpace=wrap;html=1;verticalAlign=top;fillColor=#F5F4F2;strokeColor=#9E9892;fontFamily=Oracle Sans;fontSize=12;container=1;collapsible=0;dashed=1;" vertex="1" parent="${parentCellId || "1"}"><mxGeometry x="${group.x}" y="${group.y}" width="${group.w}" height="${group.h}" as="geometry"/></mxCell>`);
      groupCellMap.set(group.id, cellId);
      continue;
    }

    const { cellXml, cellId } = buildGroupCell(group, resolved.data, idCounter, parentCellId || "1");
    allCells.push(cellXml);
    groupCellMap.set(group.id, cellId);
  }

  // 2. Build nodes (with scale)
  for (const node of nodes) {
    const groupId = nodeGroupMap.get(node.id);
    const parentCellId = groupId ? groupCellMap.get(groupId) : undefined;

    // Check for component box nodes (e.g. component/oci, component/onprem)
    const compNode = buildComponentNode(node, idCounter, parentCellId);
    if (compNode) {
      allCells.push(...compNode.cellXmls);
      nodeAnchorMap.set(node.id, compNode.anchorId);
      continue;
    }

    const resolved = resolveShape(node.shape);
    if (!resolved) {
      errors.push(`Node "${node.id}": shape "${node.shape}" not found`);
      continue;
    }

    const { cellXmls, anchorId } = buildNodeCells(node, resolved.data, idCounter, parentCellId, scale);
    allCells.push(...cellXmls);
    nodeAnchorMap.set(node.id, anchorId);
  }

  // 3. Build edges (parent = LCA of source/target for clean routing)
  // Assign a unique opacity to EACH edge so every arrow is visually distinguishable.
  // Range: 100 down to 35, evenly distributed across all connections.
  const nEdges = connections.length || 1;

  const allNodeIds = nodes.map(n => n.id);
  // Icon nodes render with label in the bottom portion of the box. Track them so
  // buildEdge can avoid exit/entry at Y=1 (which would cross the label visually).
  const iconIds = new Set<string>(nodes.filter(n => !COMPONENT_STYLES[n.shape]).map(n => n.id));
  const edgeXmls: string[] = [];
  for (let ei = 0; ei < connections.length; ei++) {
    const conn = connections[ei];
    const edgeOpacity = nEdges === 1 ? 100 : Math.round(100 - (ei * 65) / (nEdges - 1));
    const edgeXml = buildEdge(conn, nodeAnchorMap, idCounter, nodeGroupMap, groupCellMap, posMap, allNodeIds, edgeOpacity, iconIds);
    if (edgeXml) {
      edgeXmls.push(edgeXml);
    } else {
      errors.push(`Connection from "${conn.from}" to "${conn.to}": endpoint not found`);
    }
  }

  // 4. Spread edge ports — multiple edges on the same side of a node get
  //    evenly-distributed connection points so each line is visually distinct.
  const anchorPositions = new Map<string, { cx: number; cy: number }>();
  for (const node of nodes) {
    const anchorId = nodeAnchorMap.get(node.id);
    if (anchorId) {
      anchorPositions.set(anchorId, getAbsoluteCenter(node.id, posMap, nodeGroupMap));
    }
  }
  const spreadEdges = spreadEdgePorts(edgeXmls, anchorPositions);
  const separatedEdges = separateSharedCorridors(spreadEdges);

  // 5. Align waypoints to spread port positions (fixes arrowhead direction)
  const reverseAnchorMap = new Map<string, string>();
  for (const [nodeId, anchorId] of nodeAnchorMap) reverseAnchorMap.set(anchorId, nodeId);
  const reverseGroupCellMap = new Map<string, string>();
  for (const [groupId, cellId] of groupCellMap) reverseGroupCellMap.set(cellId, groupId);
  const alignedEdges = alignEndpointWaypoints(separatedEdges, reverseAnchorMap, posMap, nodeGroupMap, reverseGroupCellMap);

  // 6. Clean up micro-jogs and unnecessary waypoints from all post-processing
  const cleanedEdges = cleanupWaypoints(alignedEdges);

  // 7. Spread edge labels along paths so they don't overlap
  allCells.push(...offsetEdgeLabels(cleanedEdges, reverseAnchorMap, posMap, nodeGroupMap));

  // Assemble
  const xml = `<mxGraphModel dx="1422" dy="762" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1169" pageHeight="827" math="0" shadow="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/>${allCells.join("")}</root></mxGraphModel>`;

  return { xml, errors: [...validationWarnings, ...errors] };
}
