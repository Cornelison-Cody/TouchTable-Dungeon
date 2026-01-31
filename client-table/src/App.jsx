import React, { useEffect, useMemo, useRef, useState } from "react";
import { QRCodeCanvas } from "qrcode.react";
import { MsgType, Role, makeMsg } from "../../shared/protocol.js";
import { ActionType } from "../../shared/game.js";

const cardStyle = {
  border: "1px solid #ddd",
  borderRadius: 12,
  padding: 16,
  marginBottom: 12,
  background: "#fff"
};

const mono = {
  fontFamily:
    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace"
};

function makeWsUrl() {
  return localStorage.getItem("tt_server_ws") || "ws://localhost:3000";
}

function Cell({ size, isDark, children, onClick }) {
  return (
    <div
      onClick={onClick}
      style={{
        width: size,
        height: size,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        userSelect: "none",
        border: "1px solid rgba(0,0,0,0.06)",
        background: isDark ? "rgba(0,0,0,0.04)" : "rgba(255,255,255,1)",
        fontSize: Math.floor(size * 0.55),
        cursor: onClick ? "pointer" : "default"
      }}
    >
      {children}
    </div>
  );
}

export default function App() {
  const [wsUrl, setWsUrl] = useState(makeWsUrl());
  const [status, setStatus] = useState("disconnected");
  const [clientId, setClientId] = useState(null);
  const [sessionInfo, setSessionInfo] = useState(null);
  const [publicState, setPublicState] = useState(null);
  const [error, setError] = useState(null);

  const wsRef = useRef(null);

  useEffect(() => {
    setError(null);
    setStatus("connecting");

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus("connected");
      ws.send(JSON.stringify(makeMsg(MsgType.HELLO, { role: Role.TABLE }, "hello-table")));
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.t === MsgType.OK && msg.id === "hello-table") {
          setClientId(msg.payload?.clientId ?? null);
        } else if (msg.t === MsgType.SESSION_INFO) {
          setSessionInfo(msg.payload);
        } else if (msg.t === MsgType.STATE_PUBLIC) {
          setPublicState(msg.payload?.state ?? null);
        } else if (msg.t === MsgType.ERROR) {
          setError(msg.payload?.message ?? "Unknown error");
        }
      } catch {
        // ignore
      }
    };

    ws.onclose = () => setStatus("disconnected");
    ws.onerror = () => setStatus("error");

    return () => {
      try {
        ws.close();
      } catch {
        // ignore
      }
    };
  }, [wsUrl]);

  function reconnect() {
    localStorage.setItem("tt_server_ws", wsUrl);
    setWsUrl(wsUrl.trim());
  }

  const joinUrl = sessionInfo?.joinUrl || "";
  const game = publicState?.game || null;
  const grid = game?.grid || { w: 10, h: 7 };
  const hero = game?.entities?.hero || null;
  const enemy = game?.entities?.enemy || null;
  const log = game?.log || [];
  const hasGame = Boolean(game);

  const cellSize = 64; // good for 50" table; tune later

  function tryMove(toX, toY) {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(makeMsg(MsgType.ACTION, { action: ActionType.MOVE, params: { toX, toY } }, "move")));
  }

  return (
    <div style={{ padding: 20, maxWidth: 1200, margin: "0 auto", background: "#f6f7f9", minHeight: "100vh" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
        <h1 style={{ margin: 0 }}>TouchTable Dungeon — Table</h1>
        <div style={{ ...mono, opacity: 0.8 }}>
          status: {status} {clientId ? `• clientId=${clientId}` : ""}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "420px 1fr", gap: 12, alignItems: "start", marginTop: 12 }}>
        <div>
          <div style={cardStyle}>
            <h2 style={{ marginTop: 0 }}>Session</h2>
            {sessionInfo ? (
              <>
                <div style={mono}>sessionId: {sessionInfo.sessionId}</div>
                <div style={{ ...mono, wordBreak: "break-all", marginTop: 8 }}>joinUrl: {sessionInfo.joinUrl}</div>
                <div style={{ marginTop: 12 }}>
                  <QRCodeCanvas value={joinUrl} size={240} includeMargin />
                </div>
              </>
            ) : (
              <p>Waiting for session info…</p>
            )}
            {error ? <p style={{ color: "crimson" }}>Error: {error}</p> : null}
          </div>

          <div style={cardStyle}>
            <h2 style={{ marginTop: 0 }}>Players</h2>
            {publicState?.seats ? (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {publicState.seats.map((s) => (
                  <li key={s.seat} style={{ marginBottom: 6 }}>
                    <span style={mono}>seat {s.seat}:</span>{" "}
                    {s.occupied ? s.playerName : <span style={{ opacity: 0.6 }}>empty</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <p>Waiting for public state…</p>
            )}
          </div>

          <div style={cardStyle}>
            <h2 style={{ marginTop: 0 }}>Encounter</h2>
            {!hasGame ? (
              <p style={{ opacity: 0.8 }}>
                No encounter yet. Join a seat from a phone to start Milestone 2.
              </p>
            ) : (
              <>
                <div style={mono}>
                  hero HP: {hero.hp}/{hero.maxHp} • enemy HP: {enemy.hp}/{enemy.maxHp}
                </div>
                <p style={{ marginBottom: 0, opacity: 0.75 }}>
                  Tap a tile to MOVE (range 1). Use the phone to ATTACK / END TURN.
                </p>
              </>
            )}
          </div>

          <div style={cardStyle}>
            <h2 style={{ marginTop: 0 }}>Log</h2>
            {log.length ? (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {log.slice().reverse().map((e, idx) => (
                  <li key={idx} style={{ marginBottom: 6, opacity: 0.9 }}>{e.msg}</li>
                ))}
              </ul>
            ) : (
              <p style={{ opacity: 0.7 }}>No events yet.</p>
            )}
          </div>
        </div>

        <div style={cardStyle}>
          <h2 style={{ marginTop: 0 }}>Board</h2>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: `repeat(${grid.w}, ${cellSize}px)`,
              gap: 0,
              width: grid.w * cellSize,
              touchAction: "manipulation"
            }}
          >
            {Array.from({ length: grid.h }).map((_, y) =>
              Array.from({ length: grid.w }).map((__, x) => {
                const isDark = (x + y) % 2 === 1;
                const isHero = hero && hero.x === x && hero.y === y;
                const isEnemy = enemy && enemy.hp > 0 && enemy.x === x && enemy.y === y;
                const glyph = isHero ? "🧙" : isEnemy ? "👾" : "";
                return (
                  <Cell
                    key={`${x},${y}`}
                    size={cellSize}
                    isDark={isDark}
                    onClick={hasGame ? () => tryMove(x, y) : undefined}
                  >
                    {glyph}
                  </Cell>
                );
              })
            )}
          </div>
        </div>
      </div>

      <div style={{ ...cardStyle, marginTop: 12 }}>
        <h2 style={{ marginTop: 0 }}>Server</h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <label style={{ width: 120 }}>WS URL</label>
          <input
            value={wsUrl}
            onChange={(e) => setWsUrl(e.target.value)}
            style={{ flex: 1, padding: 10, borderRadius: 10, border: "1px solid #ccc" }}
          />
          <button
            onClick={reconnect}
            style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ccc", background: "#fff" }}
          >
            Reconnect
          </button>
        </div>
        <p style={{ marginBottom: 0, opacity: 0.75 }}>
          LAN phones: set to <span style={mono}>ws://&lt;mini-pc-ip&gt;:3000</span>.
        </p>
      </div>
    </div>
  );
}
