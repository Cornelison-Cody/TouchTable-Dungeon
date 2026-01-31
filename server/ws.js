import { WebSocketServer } from "ws";
import { v4 as uuid } from "uuid";
import { PROTOCOL_VERSION } from "../shared/protocol.js";

export function setupWebSocket(server) {
  const wss = new WebSocketServer({ server });

  const clients = new Map();

  wss.on("connection", (ws) => {
    const clientId = uuid();
    clients.set(ws, { clientId, role: null });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        handleMessage(ws, msg);
      } catch (e) {
        ws.send(JSON.stringify({ t: "ERROR", payload: { message: "Bad JSON" } }));
      }
    });

    ws.on("close", () => clients.delete(ws));
  });

  function handleMessage(ws, msg) {
    if (msg.v !== PROTOCOL_VERSION) return;

    if (msg.t === "HELLO") {
      clients.get(ws).role = msg.payload.role;
      ws.send(JSON.stringify({
        v: PROTOCOL_VERSION,
        t: "OK",
        payload: { clientId: clients.get(ws).clientId }
      }));
    }
  }
}
