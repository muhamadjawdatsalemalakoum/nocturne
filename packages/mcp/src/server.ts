import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DaemonClient } from "./daemon.js";
import { registerTools } from "./tools.js";

export const MCP_VERSION = "0.1.0";

const INSTRUCTIONS =
  "Nocturne runs durable, multi-step Claude Code workflows that survive the session closing and " +
  "wait out usage-limit resets. Use list_workflows + run_workflow to launch (runs keep going after " +
  "this session ends — poll them with get_run), approve_step for human gates, and suggest_workflows " +
  "(Retrace) to draft workflows from the user's recent Claude Code sessions. Requires the local " +
  "Nocturne daemon running (`nocturne serve`).";

/** Build a Nocturne MCP server with all tools registered against `client`. */
export function createMcpServer(client: DaemonClient = new DaemonClient()): McpServer {
  const server = new McpServer(
    { name: "nocturne", version: MCP_VERSION },
    { instructions: INSTRUCTIONS },
  );
  registerTools(server, client);
  return server;
}

/**
 * Start the server over stdio (the transport every MCP client supports).
 * IMPORTANT: stdout carries the JSON-RPC protocol — all logging goes to stderr.
 */
export async function startStdio(client: DaemonClient = new DaemonClient()): Promise<McpServer> {
  const server = createMcpServer(client);
  // Best-effort reachability note; never blocks and tools degrade gracefully if the daemon is down.
  void client.health().then(
    (h) => console.error(`[nocturne-mcp] connected to daemon v${h.version} at ${client.baseUrl}`),
    () =>
      console.error(
        `[nocturne-mcp] daemon not reachable at ${client.baseUrl} yet — start it with \`nocturne serve\`. ` +
          `Tools will work once it's up.`,
      ),
  );
  await server.connect(new StdioServerTransport());
  console.error("[nocturne-mcp] ready (stdio)");
  return server;
}
