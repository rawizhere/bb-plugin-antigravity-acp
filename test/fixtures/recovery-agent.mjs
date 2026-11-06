import { appendFileSync } from "node:fs";
import readline from "node:readline";

const sessionId = "saved-session";
let restored = false;
const input = readline.createInterface({ input: process.stdin });
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
input.on("line", line => {
  const message = JSON.parse(line);
  if (!message.method) return;
  appendFileSync(process.env.RECOVERY_TEST_AUDIT, JSON.stringify({ method: message.method, params: message.params }) + "\n");
  switch (message.method) {
    case "initialize":
      send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
      break;
    case "session/new":
      send({ id: message.id, result: { sessionId } });
      break;
    case "session/load":
      restored = true;
      send({ id: message.id, result: null });
      break;
    case "session/prompt":
      if (!restored) send({ id: message.id, error: { code: -32603, message: `Session not found: ${sessionId}` } });
      else send({ id: message.id, result: { stopReason: "end_turn" } });
      break;
    default:
      if (message.id !== undefined) send({ id: message.id, result: {} });
  }
});
