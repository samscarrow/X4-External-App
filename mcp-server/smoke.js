/**
 * Smoke test: spawns the MCP server over stdio, lists tools, and calls a few.
 * Works without the game or app server running — those calls should return
 * graceful "cannot reach" messages rather than crashing.
 *
 * Run: npm run smoke
 */

import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverPath = fileURLToPath(new URL("./index.js", import.meta.url));

const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
});

const client = new Client({ name: "x4-cocaptain-smoke", version: "0.1.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log("tools:", tools.map((tool) => tool.name).join(", "));

for (const call of [
    { name: "get_live_state", arguments: {} },
    { name: "get_db_schema", arguments: {} },
    { name: "await_events", arguments: { timeout_seconds: 2 } },
]) {
    const result = await client.callTool(call);
    const text = result.content?.[0]?.text ?? "(no content)";
    console.log(`\n== ${call.name} ${result.isError ? "(error)" : ""}\n${text.slice(0, 500)}`);
}

await client.close();
console.log("\nsmoke test finished");
