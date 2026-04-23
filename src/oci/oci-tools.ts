/**
 * Two MCP tools for OCI shape discovery and diagram creation.
 * Handled directly by the wrapper (not forwarded to @drawio/mcp subprocess).
 */

import { randomUUID } from "crypto";
import { getCategories, listShapes } from "./shape-catalog.js";
import { buildDiagram, type DiagramNode, type DiagramConnection, type DiagramGroup } from "./shape-resolver.js";
import { getLibraryBaseUrl, getDiagramParBaseUrl } from "../url-rewriter.js";

// Tool names handled by the wrapper
export const OCI_TOOL_NAMES = [
  "list_oci_icons",
  "create_oci_diagram",
] as const;

export type OciToolName = (typeof OCI_TOOL_NAMES)[number];

export function isOciTool(name: string): name is OciToolName {
  return OCI_TOOL_NAMES.includes(name as OciToolName);
}

/** Server-level instructions injected into the MCP initialize response.
 *  Covers cross-tool workflow, domain conventions, and reference data
 *  shared by every diagram-building interaction. Tool descriptions stay
 *  narrow (what/when/how for that specific tool). */
export function getServerInstructions(): string {
  return `# OCI draw.io diagram server

Build Oracle Cloud Infrastructure architecture diagrams in draw.io format.

## Workflow (always, before building any diagram)

1. Call \`list_oci_icons\` ONCE with all relevant categories as a single array argument. Never multiple calls.
2. Call \`create_oci_diagram\` with nodes, connections, groups.

Categories: Compute, Networking, Database, Storage, Analytics and AI, Developer Services, Identity and Security, Observability and Management, Applications, Governance and Administration, Migration.

## Shape slug convention

\`category/name\` lowercase with underscores. E.g. \`compute/virtual_machine_vm\`, \`database/autonomous_db\`, \`analytics_and_ai/digital_assistant\`. Never invent — use only slugs returned by \`list_oci_icons\`.

## Icon-first rule (applies to all node choices)

Always prefer an OCI icon over a \`component/*\` box, even if the match is approximate:
- Exact service → its icon (Autonomous DB → \`database/autonomous_db\`).
- Sub-component → parent service's icon (Skill/Channel inside ODA → \`analytics_and_ai/digital_assistant\`).
- Generic category → thematic icon (REST API → \`developer_services/api_service\`; LLM → \`analytics_and_ai/artificial_intelligence\`; Auth → \`identity_and_security/iam_identity_and_access_management\`; any DB → \`database/autonomous_db\`; compute → \`compute/virtual_machine_vm\`).
- External system → \`networking/customer_premises_equipment_cpe\` or \`customer_data_center\`.

\`component/*\` = last resort for truly abstract concepts (legal wrappers, pricing tiers). Reused approximate icon > plain box.

## Human actors

Users, customers, admins, developers, operators = Identity and Security icons, never component boxes:
\`identity_and_security/user\` (generic), \`user_1\` (developer), \`user_2\` (admin), \`user_group[_1/_2]\` (multiple). Place inside \`logical/grouping_internet\` for external access.

## Connector annotations — opt-in only

\`step\` and \`note\` fields on a connection are OPT-IN. Default: omit.

Typical diagram: 3-5 user-numbered steps total. Internal service-to-service dataflow gets NO step. Adding step to >5 connections = wrong. If ≥90% of connections have a step, the MCP drops all as placeholder abuse.

## Colors (auto-applied, reference only)

Bark #312D2A, Air #FCFBFA, Sienna #AE562C, Ivy #759C6C, O-Red #C74634, Neutral 1-4.`;
}

/** Tool definitions to append to tools/list response */
export function getOciToolDefinitions(): object[] {
  return [
    {
      name: "list_oci_icons",
      description:
        "List available OCI icon shapes (service icons for the nodes array). Returns icons with slug, title, and dimensions. Grouping shapes for the groups array are already documented in create_oci_diagram.\n\nALWAYS pass ALL needed categories as a single array — NEVER call this tool multiple times with one category each.\n\nCategories: Compute, Networking, Database, Storage, Analytics and AI, Developer Services, Identity and Security, Observability and Management, Applications, Governance and Administration, Migration.",
      inputSchema: {
        type: "object" as const,
        properties: {
          category: {
            type: ["string", "array"],
            description:
              "REQUIRED. Array of category names to fetch in a single call. Example: ['Compute', 'Networking', 'Database', 'Storage']. NEVER call this tool multiple times — pass all categories at once.",
            items: { type: "string" },
          },
        },
      },
    },
    {
      name: "create_oci_diagram",
      description: `Build mxGraphModel XML from nodes, connections, groups. Returns draw.io URL with OCI library loaded.

Prereq: call \`list_oci_icons\` first (see server instructions).

# How to use: declarative layout (strongly recommended)

Declare STRUCTURE — MCP computes all pixel coords:
- Every group: \`layout\` = \`"row"\` (children side by side), \`"column"\` (stacked), or \`"grid"\` (wraps).
- Every node and group: OMIT \`x\`, \`y\`, \`w\`, \`h\`. MCP sizes and positions everything.

Example — OCI Generative AI + Digital Assistant + Visual Builder:
\`\`\`json
{
  "nodes": [
    { "id": "users",    "shape": "identity_and_security/user_group", "label": "Users" },
    { "id": "dev",      "shape": "identity_and_security/user_1",     "label": "Developer" },
    { "id": "iam",      "shape": "identity_and_security/iam_identity_and_access_management", "label": "IAM" },
    { "id": "vb_app",   "shape": "developer_services/visual_builder",  "label": "VB Application" },
    { "id": "vb_db",    "shape": "database/autonomous_db",             "label": "Built-in DB" },
    { "id": "channel",  "shape": "analytics_and_ai/digital_assistant", "label": "Channel" },
    { "id": "skill",    "shape": "analytics_and_ai/digital_assistant", "label": "Skill" },
    { "id": "rest",     "shape": "developer_services/api_service",     "label": "REST API" },
    { "id": "genai",    "shape": "analytics_and_ai/artificial_intelligence", "label": "OCI GenAI" }
  ],
  "groups": [
    { "id": "internet", "shape": "logical/grouping_internet",   "label": "Internet",    "layout": "column", "children": ["users", "dev"] },
    { "id": "region",   "shape": "physical/grouping_oci_region","label": "OCI Region",  "layout": "row",    "children": ["iam", "osn"] },
    { "id": "osn",      "shape": "group/oracle_services_network","label": "OSN",        "layout": "row",    "children": ["vb_grp", "oda_grp", "genai"] },
    { "id": "vb_grp",   "shape": "component/expanded",          "label": "Visual Builder","layout": "column", "children": ["vb_app", "vb_db"] },
    { "id": "oda_grp",  "shape": "component/expanded",          "label": "Digital Assistant","layout": "column", "children": ["channel", "skill", "rest"] }
  ]
}
\`\`\`
The LLM's entire job: pick shapes, pick \`layout\` per group, declare children. Zero pixel math.

# Rules specific to this tool

1. \`component/expanded\` = GROUP only, with children. Never a node.
2. \`component/{oci|onprem|3rdparty|atomic|composite}\` = NODE only, no children.
3. One entity per container. Never node AND group for same thing.
4. Overlapping groups MUST nest. B visually inside A → B in A.children.
5. Parent groups BEFORE children in groups array.
6. Physical subnets include CIDR: \`"Public Subnet\\n10.0.1.0/24"\`.
7. No self-loops. from != to. "Access console" = from user/developer TO target.
8. Every node connects OR belongs to a group. Orphans warn.
9. OCI managed services INSIDE \`group/oracle_services_network\`: GenAI, Visual Builder, Digital Assistant, Object Storage, Autonomous DB, Functions, Integration, Analytics. IAM stays outside OSN (identity, not data).
10. Callout nodes at ROOT level, never inside OSN. "Home page", "service console", "admin access" callouts = root-level nodes (no parent group) with dashed arrow to target.

# Nesting patterns

- Logical (most common): Internet + Region as siblings; Region contains IAM + OSN + [callouts]; OSN contains sub-groups per service (VB, ODA) each with its own children.
- Physical (infra): Region → Compartment → VCN → Subnet (optional AD/FD between Compartment and VCN for HA).
- Pipeline (dataflow): flat root-level sibling groups, each a \`logical/grouping_other_group\` column of icons; edges flow L→R across columns.

Target 10-20 components. >25 → split diagrams.

# Shape references

**Grouping shapes** (groups[].shape):
- Physical: \`physical/grouping_{oci_region|compartment|vcn|subnet|availability_domain|tenancy|fault_domain|user_group|tier}\`, \`group/{metro_realm|on_premises|oracle_services_network}\`
- Logical: \`logical/grouping_{oracle_cloud|on_premises|internet|3rd_party_cloud|other_group}\`, \`component/expanded\`
- Any: \`group/optional\`

**Component boxes** (nodes[].shape): \`component/{oci|onprem|3rdparty|atomic|composite}\`. Last-resort only (prefer icons — see server instructions).

**Special connectors** (physical hybrid):
- FastConnect: \`physical/special_connectors_fastconnect_{vertical|horizontal}\`
- S2S VPN: \`physical/special_connectors_site_to_site_vpn_vertical\`
- Remote Peering: \`physical/special_connectors_remote_peering_{vertical|horizontal}\`

# Connector style

\`style\`: \`solid\` (dataflow, default) or \`dashed\` (user interaction). Physical diagrams = solid only. \`label\`: 8pt, short 1-2 words, omit when obvious.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          nodes: {
            type: "array",
            description: "Nodes (icon shapes) to place. Coordinates are relative to parent group. At default scale (0.5), each icon occupies ~42×65px.",
            items: {
              type: "object" as const,
              properties: {
                id: { type: "string", description: "Unique node identifier (used in connections)" },
                shape: {
                  type: "string",
                  description:
                    "Icon slug (e.g. 'compute/virtual_machine_vm') or component box ('component/oci', 'component/onprem', 'component/3rdparty', 'component/atomic', 'component/composite'). NOT component/expanded — that goes in groups array.",
                },
                label: { type: "string", description: "Display label for the shape" },
                x: { type: "number", description: "X position in pixels relative to parent group. Use 25 for the first child; for row layout next child x = prev.x + prev.w + GAP." },
                y: { type: "number", description: "Y position in pixels relative to parent group. Use 30 for the first row; for column layout next child y = prev.y + prev.h + GAP." },
              },
              required: ["id", "shape", "label"],
            },
          },
          connections: {
            type: "array",
            description: "Connections (edges) between nodes. Rendered as orthogonal lines with open arrowheads, 1pt stroke, 8pt labels in Bark color. Labels get Air background fill.",
            items: {
              type: "object" as const,
              properties: {
                from: { type: "string", description: "Source node ID" },
                to: { type: "string", description: "Target node ID" },
                label: {
                  type: "string",
                  description: "Descriptive text only (8pt, Bark, Air background). Do NOT embed step numbers here — use the `step` field instead.",
                },
                style: {
                  type: "string",
                  enum: ["solid", "dashed"],
                  description: "Connector style: 'solid' (default) = Dataflow, 'dashed' = User Interaction",
                },
                step: {
                  type: "integer",
                  minimum: 1,
                  description: "OPT-IN ONLY. Use ONLY when the user explicitly numbers this specific connection (e.g. user's description says '1 Authentication'). Do NOT add step to connections the user didn't number. Default = omit. When set, renders a Sienna (#AE562C) numbered circle.",
                },
                note: {
                  type: "string",
                  description: "OPT-IN ONLY. Use ONLY when the user explicitly asks for lettered footnotes (e.g. 'mark with A, B, C'). Default = omit. When set, renders a Neutral 4 (#6B6560) lettered circle.",
                },
              },
              required: ["from", "to"],
            },
          },
          groups: {
            type: "array",
            description: "Container groups (with children). Parents BEFORE children in array. component/expanded goes HERE (not in nodes). Overlapping groups must be nested via children.",
            items: {
              type: "object" as const,
              properties: {
                id: { type: "string", description: "Unique group identifier" },
                shape: {
                  type: "string",
                  description: "Shape slug for grouping shape (e.g. 'physical/grouping_vcn'), or generated group type ('component/expanded', 'group/metro_realm', 'group/optional')",
                },
                label: { type: "string", description: "Display label" },
                layout: {
                  type: "string",
                  enum: ["row", "column", "grid"],
                  description: "RECOMMENDED. Layout intent for children: 'row' (side by side, e.g. VB + ODA inside OSN), 'column' (stacked, e.g. icons in an Internet group), 'grid' (approx square, wraps). When set, MCP computes all child positions and this group's w/h — omit x/y/w/h on this group and its descendants. Much easier than computing pixels manually.",
                },
                x: { type: "number", description: "X position (optional — omit when using `layout`)." },
                y: { type: "number", description: "Y position (optional — omit when using `layout`)." },
                w: { type: "number", description: "Width (optional — omit when using `layout`; MCP computes from children)." },
                h: { type: "number", description: "Height (optional — omit when using `layout`; MCP computes from children)." },
                children: {
                  type: "array",
                  items: { type: "string" },
                  description: "IDs of nodes or sub-groups contained in this group. REQUIRED for any non-leaf group.",
                },
              },
              required: ["id", "shape", "label"],
            },
          },
          scale: {
            type: "number",
            description: "Icon scale factor (default 0.5 = half size). At 0.5, icons are ~42×65px. At 1.0, icons are ~84×130px.",
          },
        },
        required: ["nodes"],
      },
    },
  ];
}

/** Handle an OCI tool call. Returns the JSON-RPC result content. */
export async function handleOciTool(
  toolName: OciToolName,
  args: Record<string, unknown>,
  port: string | number,
): Promise<{ content: { type: string; text: string }[] }> {
  switch (toolName) {
    case "list_oci_icons":
      return handleListShapes(args);
    case "create_oci_diagram":
      return handleCreateDiagram(args, port);
  }
}

function handleListShapes(args: Record<string, unknown>): {
  content: { type: string; text: string }[];
} {
  const raw = args.category;
  const categories: string[] = Array.isArray(raw)
    ? (raw as string[]).map(String).filter((c) => c.trim())
    : typeof raw === "string" && raw.trim()
      ? [raw]
      : [];

  // Filter out non-icon shapes: grouping containers, templates, examples, special connectors.
  // These are either already documented in create_oci_diagram or are reference layouts not usable as nodes.
  const EXCLUDED_PREFIXES = ["grouping_", "templates_", "example_", "special_connectors_", "components_", "component_", "connectors_", "connector_", "connector", "location_canvas_"];
  const EXCLUDED_CATEGORIES = new Set(["Physical", "Logical"]);
  const isIcon = (slug: string, category: string): boolean => {
    if (EXCLUDED_CATEGORIES.has(category)) return false;
    const name = slug.split("/")[1] || "";
    return name !== "" && !EXCLUDED_PREFIXES.some((p) => name.startsWith(p));
  };

  if (categories.length === 0) {
    // Return categories with icon counts only
    const allShapes = listShapes();
    const iconCounts = new Map<string, number>();
    for (const s of allShapes) {
      if (isIcon(s.slug, s.category)) {
        iconCounts.set(s.category, (iconCounts.get(s.category) || 0) + 1);
      }
    }
    const text = [...iconCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .filter(([, count]) => count > 0)
      .map(([name, count]) => `${name} (${count} icons)`)
      .join("\n");
    return {
      content: [
        {
          type: "text",
          text: `OCI Icon Categories:\n\n${text}\n\nPass all needed categories as an array to see icons.`,
        },
      ],
    };
  }

  const sections: string[] = [];
  for (const category of categories) {
    const shapes = listShapes(category).filter((s) => isIcon(s.slug, s.category));
    if (shapes.length === 0) {
      sections.push(`## "${category}" — no icon shapes found`);
    } else {
      const lines = shapes.map((s) => `- ${s.slug} — ${s.name} (${s.w}×${s.h})`);
      sections.push(`## ${category} (${shapes.length} shapes)\n${lines.join("\n")}`);
    }
  }

  return {
    content: [
      {
        type: "text",
        text: sections.join("\n\n"),
      },
    ],
  };
}

async function handleCreateDiagram(
  args: Record<string, unknown>,
  port: string | number,
): Promise<{ content: { type: string; text: string }[] }> {
  const nodes = (args.nodes || []) as DiagramNode[];
  const connections = (args.connections || []) as DiagramConnection[];
  const groups = (args.groups || []) as DiagramGroup[];
  const scale = (args.scale as number | undefined) ?? undefined;

  if (nodes.length === 0) {
    return {
      content: [{ type: "text", text: "At least one node is required." }],
    };
  }

  const t0 = Date.now();
  const result = buildDiagram(nodes, connections, groups, scale);
  const buildMs = Date.now() - t0;

  // Upload diagram XML to OCI Object Storage (HTTPS) and return a short URL.
  // draw.io loads the XML from the HTTPS PAR URL (no mixed content issues).
  const diagramId = randomUUID().slice(0, 8);
  const parBase = getDiagramParBaseUrl();
  const objectName = `diagrams/${diagramId}.xml`;
  const uploadUrl = `${parBase}${objectName}`;

  // Upload via HTTP PUT to PAR URL
  const t1 = Date.now();
  try {
    const uploadRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/xml" },
      body: result.xml,
    });
    if (!uploadRes.ok) {
      throw new Error(`Upload failed: ${uploadRes.status} ${uploadRes.statusText}`);
    }
  } catch (err) {
    // Fallback: return inline XML if upload fails
    const errMsg = err instanceof Error ? err.message : "Unknown error";
    console.error(`[DIAGRAM] build=${buildMs}ms upload=FAILED (${errMsg}) xml=${result.xml.length}b nodes=${nodes.length} groups=${groups.length}`);
    return {
      content: [{ type: "text", text: `Error uploading diagram: ${errMsg}\n\nRaw XML (copy to draw.io):\n${result.xml.substring(0, 500)}...` }],
    };
  }
  const uploadMs = Date.now() - t1;
  console.log(`[DIAGRAM] build=${buildMs}ms upload=${uploadMs}ms xml=${result.xml.length}b nodes=${nodes.length} groups=${groups.length} errors=${result.errors.length}`);

  const diagramUrl = uploadUrl;
  const libraryUrl = getLibraryBaseUrl(port);
  const encodedLibUrl = encodeURIComponent(libraryUrl);
  const encodedDiagramUrl = encodeURIComponent(diagramUrl);
  const url = `https://app.diagrams.net/?dark=0&clibs=U${encodedLibUrl}#U${encodedDiagramUrl}`;

  let text = `OCI Architecture Diagram created.\n\nOpen in draw.io:\n${url}`;
  if (result.errors.length > 0) {
    text += `\n\nWarnings:\n${result.errors.map((e) => `- ${e}`).join("\n")}`;
  }

  return {
    content: [{ type: "text", text }],
  };
}
