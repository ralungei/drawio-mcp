/**
 * Three MCP tools for OCI shape discovery and diagram creation.
 * Handled directly by the wrapper (not forwarded to @drawio/mcp subprocess).
 */

import { getCategories, listShapes, searchShapes } from "./shape-catalog.js";
import { buildDiagram, type DiagramNode, type DiagramConnection, type DiagramGroup } from "./shape-resolver.js";
import { getLibraryBaseUrl } from "../url-rewriter.js";

// Tool names handled by the wrapper
export const OCI_TOOL_NAMES = [
  "list_oci_shapes",
  "search_oci_shapes",
  "create_oci_diagram",
] as const;

export type OciToolName = (typeof OCI_TOOL_NAMES)[number];

export function isOciTool(name: string): name is OciToolName {
  return OCI_TOOL_NAMES.includes(name as OciToolName);
}

/** Tool definitions to append to tools/list response */
export function getOciToolDefinitions(): object[] {
  return [
    {
      name: "list_oci_shapes",
      description:
        "List available OCI (Oracle Cloud Infrastructure) shapes for architecture diagrams. Without a category, returns all categories with counts. With a category, returns all shapes in that category with slug, title, and dimensions.",
      inputSchema: {
        type: "object" as const,
        properties: {
          category: {
            type: "string",
            description:
              "Optional category name to filter shapes (e.g. 'Compute', 'Networking', 'Database', 'Storage', 'Identity and Security', 'Logical', 'Physical'). Omit to see all categories.",
          },
        },
      },
    },
    {
      name: "search_oci_shapes",
      description:
        "Search OCI shapes by keyword. Returns matching shapes with their slugs for use in create_oci_diagram. Example queries: 'load balancer', 'virtual machine', 'database', 'VCN', 'compartment'.",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: {
            type: "string",
            description: "Search query (matches against shape title and slug)",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "create_oci_diagram",
      description:
        "Create an OCI architecture diagram with official Oracle Cloud shapes. Returns a draw.io URL that opens the diagram with the OCI shape library loaded in the sidebar. Use slugs from list_oci_shapes or search_oci_shapes for the shape field. For grouping/container shapes, use the groups array. Coordinates are in pixels; typical spacing is 200px between nodes.",
      inputSchema: {
        type: "object" as const,
        properties: {
          nodes: {
            type: "array",
            description: "Nodes (shapes) to place on the diagram",
            items: {
              type: "object" as const,
              properties: {
                id: { type: "string", description: "Unique node identifier (used in connections)" },
                shape: {
                  type: "string",
                  description:
                    "Shape slug (e.g. 'compute/virtual_machine_vm') or search term (e.g. 'load balancer')",
                },
                label: { type: "string", description: "Display label for the shape" },
                x: { type: "number", description: "X position in pixels" },
                y: { type: "number", description: "Y position in pixels" },
              },
              required: ["id", "shape", "label", "x", "y"],
            },
          },
          connections: {
            type: "array",
            description: "Connections (edges) between nodes",
            items: {
              type: "object" as const,
              properties: {
                from: { type: "string", description: "Source node ID" },
                to: { type: "string", description: "Target node ID" },
                label: { type: "string", description: "Optional edge label" },
              },
              required: ["from", "to"],
            },
          },
          groups: {
            type: "array",
            description: "Container/grouping shapes (e.g. VCN, Compartment, Region). Child nodes use relative coordinates.",
            items: {
              type: "object" as const,
              properties: {
                id: { type: "string", description: "Unique group identifier" },
                shape: {
                  type: "string",
                  description: "Shape slug for grouping shape (e.g. 'physical/grouping_vcn')",
                },
                label: { type: "string", description: "Display label" },
                x: { type: "number", description: "X position in pixels" },
                y: { type: "number", description: "Y position in pixels" },
                w: { type: "number", description: "Width in pixels" },
                h: { type: "number", description: "Height in pixels" },
                children: {
                  type: "array",
                  items: { type: "string" },
                  description: "IDs of nodes contained in this group",
                },
              },
              required: ["id", "shape", "label", "x", "y", "w", "h"],
            },
          },
        },
        required: ["nodes"],
      },
    },
  ];
}

/** Handle an OCI tool call. Returns the JSON-RPC result content. */
export function handleOciTool(
  toolName: OciToolName,
  args: Record<string, unknown>,
  port: string | number,
): { content: { type: string; text: string }[] } {
  switch (toolName) {
    case "list_oci_shapes":
      return handleListShapes(args);
    case "search_oci_shapes":
      return handleSearchShapes(args);
    case "create_oci_diagram":
      return handleCreateDiagram(args, port);
  }
}

function handleListShapes(args: Record<string, unknown>): {
  content: { type: string; text: string }[];
} {
  const category = args.category as string | undefined;

  if (!category) {
    // Return categories with counts
    const cats = getCategories();
    const text = cats.map((c) => `${c.name} (${c.count} shapes)`).join("\n");
    return {
      content: [
        {
          type: "text",
          text: `OCI Shape Categories:\n\n${text}\n\nUse list_oci_shapes with a category name to see individual shapes.`,
        },
      ],
    };
  }

  const shapes = listShapes(category);
  if (shapes.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: `No shapes found in category "${category}". Use list_oci_shapes without a category to see available categories.`,
        },
      ],
    };
  }

  const lines = shapes.map((s) => `- ${s.slug} — ${s.name} (${s.w}×${s.h})`);
  return {
    content: [
      {
        type: "text",
        text: `${category} shapes (${shapes.length}):\n\n${lines.join("\n")}`,
      },
    ],
  };
}

function handleSearchShapes(args: Record<string, unknown>): {
  content: { type: string; text: string }[];
} {
  const query = (args.query as string) || "";
  if (!query.trim()) {
    return {
      content: [{ type: "text", text: "Please provide a search query." }],
    };
  }

  const results = searchShapes(query);
  if (results.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: `No shapes found for "${query}". Try broader terms or use list_oci_shapes to browse categories.`,
        },
      ],
    };
  }

  const lines = results.map((s) => `- ${s.slug} — ${s.title} (${s.w}×${s.h})`);
  return {
    content: [
      {
        type: "text",
        text: `Found ${results.length} shape(s) for "${query}":\n\n${lines.join("\n")}\n\nUse the slug in create_oci_diagram's shape field.`,
      },
    ],
  };
}

function handleCreateDiagram(
  args: Record<string, unknown>,
  port: string | number,
): { content: { type: string; text: string }[] } {
  const nodes = (args.nodes || []) as DiagramNode[];
  const connections = (args.connections || []) as DiagramConnection[];
  const groups = (args.groups || []) as DiagramGroup[];

  if (nodes.length === 0) {
    return {
      content: [{ type: "text", text: "At least one node is required." }],
    };
  }

  const result = buildDiagram(nodes, connections, groups);

  // Build draw.io URL with the diagram XML
  const encodedXml = encodeURIComponent(result.xml);
  const libraryUrl = getLibraryBaseUrl(port);
  const encodedLibUrl = encodeURIComponent(libraryUrl);
  const url = `https://app.diagrams.net/?clibs=U${encodedLibUrl}#R${encodedXml}`;

  let text = `OCI Architecture Diagram created.\n\nOpen in draw.io:\n${url}`;
  if (result.errors.length > 0) {
    text += `\n\nWarnings:\n${result.errors.map((e) => `- ${e}`).join("\n")}`;
  }

  return {
    content: [{ type: "text", text }],
  };
}
