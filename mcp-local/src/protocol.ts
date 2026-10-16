// Minimal JSON-RPC 2.0 over stdio for MCP: initialize, tools/list, tools/call. No dependencies.
// MCP speaks newline-delimited JSON-RPC on stdin/stdout; anything written to stdout that is not a
// response corrupts the stream, so every log line goes to stderr.
export interface Rpc { jsonrpc: "2.0"; id?: number | string | null; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } }

export type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;
export interface Tool { name: string; description: string; inputSchema: Record<string, unknown>; handler: ToolHandler }

export function log(msg: string): void {
  process.stderr.write(`[artifacts-mcp-local] ${msg}\n`);
}

/** Wraps a tool result in MCP's content envelope; errors become isError results, not transport failures. */
export async function callTool(tools: Tool[], name: string, args: Record<string, unknown>): Promise<unknown> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
  try {
    const out = await tool.handler(args);
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log(`tool ${name} failed: ${message}`);
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

export function handle(tools: Tool[], serverName: string): (line: string) => Promise<Rpc | null> {
  return async (line: string): Promise<Rpc | null> => {
    let req: Rpc;
    try { req = JSON.parse(line) as Rpc; } catch { return null; }
    if (req.id === undefined || req.id === null) return null;   // notification: no reply
    const reply = (result: unknown): Rpc => ({ jsonrpc: "2.0", id: req.id!, result });
    switch (req.method) {
      case "initialize":
        return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: serverName, version: "0.1.0" } });
      case "tools/list":
        return reply({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      case "tools/call": {
        const p = (req.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
        return reply(await callTool(tools, p.name ?? "", p.arguments ?? {}));
      }
      case "ping":
        return reply({});
      default:
        return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `method not found: ${req.method}` } };
    }
  };
}
