import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { createInterface } from "readline";

export type PendingRequest = {
  resolve: (value: string) => void;
  reject: (reason: Error) => void;
};

let mcpProcess: ChildProcessWithoutNullStreams | null = null;
const pendingRequests = new Map<unknown, PendingRequest>();

export function resolveMcpBin(projectRoot: string): string {
  const local = path.join(projectRoot, "node_modules", ".bin", "drawio-mcp");
  if (fs.existsSync(local)) return local;

  const localPkg = path.join(projectRoot, "node_modules", "@drawio", "mcp", "dist", "index.js");
  if (fs.existsSync(localPkg)) return localPkg;

  return "@drawio/mcp";
}

export function startMcpProcess(projectRoot: string): ChildProcessWithoutNullStreams {
  const bin = resolveMcpBin(projectRoot);
  console.log(`Spawning @drawio/mcp: ${bin}`);

  const isJsFile = bin.endsWith(".js");
  const child = isJsFile
    ? spawn("node", [bin], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, OPEN_BROWSER: "false" } })
    : spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, OPEN_BROWSER: "false" } });

  const rl = createInterface({ input: child.stdout });

  rl.on("line", (line) => {
    try {
      const msg = JSON.parse(line);
      const id = msg.id;
      if (id !== undefined && pendingRequests.has(id)) {
        const pending = pendingRequests.get(id)!;
        pendingRequests.delete(id);
        pending.resolve(line);
      }
    } catch {
      // Non-JSON output from child, ignore
    }
  });

  child.stderr.on("data", (data: Buffer) => {
    console.error(`[@drawio/mcp stderr] ${data.toString().trim()}`);
  });

  child.on("exit", (code) => {
    console.error(`@drawio/mcp exited with code ${code}`);
    mcpProcess = null;
    for (const [id, pending] of pendingRequests) {
      pending.reject(new Error("MCP process exited"));
      pendingRequests.delete(id);
    }
  });

  return child;
}

export function ensureMcpProcess(projectRoot: string): ChildProcessWithoutNullStreams {
  if (!mcpProcess || mcpProcess.killed) {
    mcpProcess = startMcpProcess(projectRoot);
  }
  return mcpProcess;
}

export function sendToMcp(jsonRpcMessage: string, projectRoot: string): Promise<string> {
  const child = ensureMcpProcess(projectRoot);
  const parsed = JSON.parse(jsonRpcMessage);
  const id = parsed.id;

  // Notifications (no id) — fire and forget
  if (id === undefined || id === null) {
    child.stdin.write(jsonRpcMessage + "\n");
    return Promise.resolve("");
  }

  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error("MCP request timed out (30s)"));
    }, 30_000);

    pendingRequests.set(id, {
      resolve: (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      reject: (err) => {
        clearTimeout(timeout);
        reject(err);
      },
    });

    child.stdin.write(jsonRpcMessage + "\n");
  });
}

export function killMcpProcess(): void {
  mcpProcess?.kill();
}
