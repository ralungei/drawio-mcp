# drawio-mcp

HTTP wrapper for [@drawio/mcp](https://www.npmjs.com/package/@drawio/mcp) with integrated Oracle Cloud Infrastructure (OCI) shape library. Enables LLM clients to create OCI architecture diagrams using 223 official Oracle Cloud icons via MCP (Model Context Protocol).

## Features

- **6 MCP tools** — 3 from `@drawio/mcp` (XML, CSV, Mermaid) + 3 OCI-specific tools
- **223 OCI shapes** across 20 categories (Compute, Networking, Database, Storage, Identity, etc.)
- **Official Oracle icons** — uses Oracle's draw.io shape library with vector stencils
- **OCI library in sidebar** — automatically injects `clibs` into draw.io URLs so the full shape library appears in the browser sidebar
- **Shape search** — LLMs can discover shapes by keyword before building diagrams
- **Grouping support** — containers like VCN, Region, Compartment, Availability Domain with child nodes

## OCI Tools

| Tool | Description |
|------|-------------|
| `list_oci_shapes` | Browse categories or list shapes within a category with slugs and dimensions |
| `search_oci_shapes` | Keyword search across shape titles and slugs |
| `create_oci_diagram` | Build a diagram from nodes, connections, and groups — returns a draw.io URL |

### Example: `create_oci_diagram`

```json
{
  "nodes": [
    { "id": "lb", "shape": "networking/load_balancer", "label": "Public LB", "x": 200, "y": 50 },
    { "id": "vm", "shape": "compute/virtual_machine_vm", "label": "App Server", "x": 200, "y": 250 }
  ],
  "connections": [
    { "from": "lb", "to": "vm", "label": "HTTPS" }
  ],
  "groups": [
    { "id": "vcn", "shape": "physical/grouping_vcn", "label": "Production VCN", "x": 50, "y": 20, "w": 500, "h": 400, "children": ["lb", "vm"] }
  ]
}
```

## Architecture

```
HTTP Client (LLM)
       │
       ▼
  ┌─────────────────────────────────┐
  │  drawio-mcp (HTTP server)       │
  │                                 │
  │  POST /mcp ──┬── OCI tools ──► handle locally
  │              │
  │              └── draw.io tools ──► @drawio/mcp (stdio)
  │                                      │
  │  GET /library/oci ──► serve XML      │
  │                                      │
  │  URL rewriter ◄──────────────────────┘
  │  (inject &clibs= into draw.io URLs)
  └─────────────────────────────────┘
```

## Setup

```bash
npm install
npm run build    # compiles TS + generates OCI catalog from library XML
npm start        # starts server on port 8090
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8090` | Server port |
| `API_KEY` | — | Required for `/mcp` endpoint |
| `LIBRARY_BASE_URL` | OCI Object Storage URL | HTTPS URL for the OCI library XML (used in `clibs` parameter) |

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | No | Health check |
| `GET` | `/library/oci` | No | Serves OCI library XML for draw.io sidebar |
| `POST` | `/mcp` | API key | JSON-RPC endpoint (MCP protocol) |

## Project Structure

```
src/
  index.ts              # HTTP server, route dispatch, tool interception
  mcp-bridge.ts         # stdio bridge to @drawio/mcp subprocess
  url-rewriter.ts       # injects &clibs= into draw.io URLs
  oci/
    shape-catalog.ts    # loads catalog, search/filter/list shapes
    shape-resolver.ts   # decodes shapes, remaps IDs, builds mxGraphModel XML
    oci-tools.ts        # 3 MCP tool definitions and handlers
    library-server.ts   # serves GET /library/oci
    index.ts            # barrel exports
  scripts/
    build-oci-catalog.ts  # parses oci-library.xml → catalog + shapes JSON
data/
  oci-library.xml       # Official Oracle OCI draw.io library (224 shapes)
  oci-catalog.json      # Generated: lightweight catalog for LLM discovery
  oci-shapes.json       # Generated: shape data indexed by ID
```

## Docker

```bash
docker buildx build --platform linux/amd64 -t drawio-mcp:latest .
docker run -p 8090:8090 -e API_KEY=your-key drawio-mcp:latest
```

## OCI Shape Categories

Compute, Networking, Database, Storage, Identity and Security, Applications, Developer Services, Analytics and AI, Observability and Management, Governance and Administration, Logical, Physical, Migration, Marketplace, Cloud, Database Management, Media Flow, Digital Media, Media Streams, Container.

## License

ISC
