import express from "express";
import { createServer } from "http";
import { setupWebSocket } from "./ws.js";

const app = express();
const httpServer = createServer(app);

app.get("/health", (_, res) => res.json({ ok: true }));

setupWebSocket(httpServer);

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
httpServer.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
