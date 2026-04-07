#!/usr/bin/env node

import { createServer, IncomingMessage, ServerResponse } from "http";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

import { ensureMcpProcess, sendToMcp, killMcpProcess } from "./mcp-bridge.js";
import { serveLibrary, isOciTool, handleOciTool, getOciToolDefinitions, type OciToolName } from "./oci/index.js";
import { rewriteDrawioUrls, getLibraryBaseUrl } from "./url-rewriter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

loadEnv(path.join(projectRoot, ".env"));

const config = {
  port: process.env.PORT || 8090,
  apiKey: process.env.API_KEY || "",
};

function loadEnv(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  fs.readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line && !line.startsWith("#"))
    .forEach((line) => {
      const [key, ...values] = line.split("=");
      if (key && values.length) process.env[key.trim()] = values.join("=").trim();
    });
}

// --- HTTP Server ---

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => resolve(body));
  });
}

/**
 * Intercept tools/list responses: append OCI tool definitions.
 */
function interceptToolsList(responseJson: string): string {
  try {
    const msg = JSON.parse(responseJson);
    if (msg.result && Array.isArray(msg.result.tools)) {
      msg.result.tools.push(...getOciToolDefinitions());
      return JSON.stringify(msg);
    }
  } catch {
    // Not valid JSON or unexpected shape — return as-is
  }
  return responseJson;
}

/**
 * Handle an OCI tool call locally. Returns JSON-RPC response string.
 */
function handleOciToolCall(id: unknown, toolName: OciToolName, args: Record<string, unknown>): string {
  const result = handleOciTool(toolName, args, config.port);
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    result,
  });
}

/**
 * Determine if a JSON-RPC request is a tools/list or tools/call.
 */
function parseJsonRpc(body: string): {
  method?: string;
  id?: unknown;
  params?: Record<string, unknown>;
} {
  try {
    const msg = JSON.parse(body);
    return { method: msg.method, id: msg.id, params: msg.params };
  } catch {
    return {};
  }
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, x-api-key");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  const url = new URL(req.url || "", `http://localhost:${config.port}`);

  // Public routes (no auth)
  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "drawio-mcp", backend: "@drawio/mcp", oci: true }));
    return;
  }

  if (url.pathname === "/library/oci" && req.method === "GET") {
    serveLibrary(res);
    return;
  }

  // Auth check
  if (config.apiKey) {
    const key = req.headers["x-api-key"];
    if (key !== config.apiKey) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
  }

  if (url.pathname === "/mcp" && req.method === "POST") {
    const body = await readBody(req);
    const { method, id, params } = parseJsonRpc(body);

    try {
      // Intercept tools/call for OCI tools
      if (method === "tools/call" && params) {
        const toolName = params.name as string;
        if (isOciTool(toolName)) {
          const args = (params.arguments || {}) as Record<string, unknown>;
          const response = handleOciToolCall(id, toolName, args);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(response);
          return;
        }
      }

      // Forward to @drawio/mcp subprocess
      let response = await sendToMcp(body, projectRoot);

      if (!response) {
        res.writeHead(204);
        res.end();
        return;
      }

      // Intercept tools/list: append OCI tools
      if (method === "tools/list") {
        response = interceptToolsList(response);
      }

      // Rewrite draw.io URLs to include clibs
      const libraryUrl = getLibraryBaseUrl(config.port);
      response = rewriteDrawioUrls(response, libraryUrl);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message }, id: null }));
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(config.port, () => {
  console.log(`Draw.io MCP Wrapper v3.0 (OCI) - http://localhost:${config.port}`);
  console.log(`  MCP endpoint: POST http://localhost:${config.port}/mcp`);
  console.log(`  OCI Library:  GET  http://localhost:${config.port}/library/oci`);
  console.log(`  Health:       GET  http://localhost:${config.port}/health`);
  console.log(`  Backend: @drawio/mcp (stdio bridge)`);

  // Pre-start the MCP process
  ensureMcpProcess(projectRoot);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  killMcpProcess();
  server.close();
});

process.on("SIGINT", () => {
  killMcpProcess();
  server.close();
});
