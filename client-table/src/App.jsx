import React, { useEffect, useRef, useState } from "react";
import { QRCodeCanvas } from "qrcode.react";
import { MsgType, Role, makeMsg } from "../../shared/protocol.js";
import { ActionType, hexWithinRange } from "../../shared/game.js";

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

function Cell({ size, isDark, isActive, isMoveOption, children, onClick }) {
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
        border: isActive ? "2px solid rgba(0,0,0,0.5)" : "1px solid rgba(0,0,0,0.06)",
        boxShadow: isMoveOption ? "inset 0 0 0 3px rgba(0, 128, 0, 0.30)" : undefined,
        background: isDark ? "rgba(0,0,0,0.04)" : "rgba(255,255,255,1)",
        fontSize: Math.floor(size * 0.40),
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
      try { ws.close(); } catch {}
    };
  }, [wsUrl]);

  function reconnect() {
    localStorage.setItem("tt_server_ws", wsUrl);
    setWsUrl(wsUrl.trim());
  }

  const joinUrl = sessionInfo?.joinUrl || "";
  const game = publicState?.game || null;
  const grid = game?.grid || { w: 10, h: 7 };
  const heroes = game?.heroes || [];
  const enemy = game?.enemy || null;
  const log = game?.log || [];
  const activePlayerId = game?.turn?.activePlayerId || null;
  const apRemaining = game?.turn?.apRemaining ?? 0;
  const apMax = game?.turn?.apMax ?? (game?.rules?.actionPointsPerTurn ?? 2);
  const activeHero = heroes.find((h) => h.ownerPlayerId === activePlayerId) || null;

  const enemyHpText = enemy ? `${enemy.hp}/${enemy.maxHp}` : "—";

  const moveRange = game?.rules?.moveRange ?? 1;

  const occupied = new Set();
  for (const h of heroes) {
    if (h.hp > 0) occupied.add(`${h.x},${h.y}`);
  }
  if (enemy && enemy.hp > 0) occupied.add(`${enemy.x},${enemy.y}`);

  const moveOptions = new Set();
  if (game && activeHero && activeHero.hp > 0 && apRemaining > 0) {
    const inBounds = (x, y) => x >= 0 && y >= 0 && x < grid.w && y < grid.h;
    const isBlocked = (x, y) => occupied.has(`${x},${y}`);
    const opts = hexWithinRange({ x: activeHero.x, y: activeHero.y }, moveRange, inBounds, isBlocked);
    for (const k of opts) moveOptions.add(k);
  }


  const HEX_SIZE = 34;
  const HEX_W = HEX_SIZE * 2;
  const HEX_H = Math.sqrt(3) * HEX_SIZE;


  function tryMove(toX, toY) {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(makeMsg(MsgType.ACTION, { action: ActionType.MOVE, params: { toX, toY } }, "move")));
  }

  function heroGlyph(h) {
    const name = h.ownerPlayerName || "";
    const initials = name
      ? name
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 2)
          .map((s) => s[0].toUpperCase())
          .join("")
      : (h.ownerPlayerId || "").slice(0, 2).toUpperCase();
    return `🧙 ${initials}`;
  }

  return (
    <div style={{ padding: 20, maxWidth: 1300, margin: "0 auto", background: "#f6f7f9", minHeight: "100vh" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
        <h1 style={{ margin: 0 }}>TouchTable Dungeon — Table</h1>
        <div style={{ ...mono, opacity: 0.8 }}>
          status: {status} {clientId ? `• clientId=${clientId}` : ""}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "440px 1fr", gap: 12, alignItems: "start", marginTop: 12 }}>
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
                    {s.playerId && activePlayerId === s.playerId ? (
                      <span style={{ marginLeft: 8, ...mono }}>← active</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p>Waiting for public state…</p>
            )}
          </div>

          <div style={cardStyle}>
            <h2 style={{ marginTop: 0 }}>Encounter</h2>
            {game ? (
              <>
                <div style={mono}>
                  Active: {activePlayerId ? activePlayerId.slice(0, 4) : "—"}{" "}
                </div>
                <div style={{ marginTop: 8, opacity: 0.9 }}>
                  Heroes: <span style={mono}>{heroes.length}</span> • Enemy HP: <span style={mono}>{enemyHpText}</span>
                </div>
                <p style={{ marginBottom: 0, opacity: 0.75 }}>
                  Movement is controlled from the active player’s phone. Table is view-only.
                </p>
              </>
            ) : (
              <p style={{ opacity: 0.8 }}>No encounter yet. Join from at least one phone to start.</p>
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
          <div style={{ ...mono, opacity: 0.75, marginBottom: 10 }}>
            Hex grid • view-only
          </div>
          <div
            style={{
              position: "relative",
              width: (grid.w - 1) * (HEX_SIZE * 1.5) + HEX_SIZE * 2,
              height: grid.h * HEX_H + HEX_H / 2,
              touchAction: "manipulation"
            }}
          >
            {Array.from({ length: grid.h }).map((_, y) =>
              Array.from({ length: grid.w }).map((__, x) => {
                const heroHere = heroes.find((h) => h.hp > 0 && h.x === x && h.y === y) || null;
                const isEnemy = enemy && enemy.hp > 0 && enemy.x === x && enemy.y === y;
                const isActiveCell = heroHere && heroHere.ownerPlayerId === activePlayerId;

                const left = x * (HEX_SIZE * 1.5);
                const top = y * HEX_H + (x % 2 === 0 ? 0 : HEX_H / 2);

                const label = heroHere ? heroGlyph(heroHere) : isEnemy ? "👾" : "";
                const isMoveOption = moveOptions.has(`${x},${y}`);

                const bg = isEnemy
                  ? "rgba(255,0,0,0.06)"
                  : isActiveCell
                    ? "rgba(0,128,0,0.08)"
                    : "rgba(255,255,255,1)";

                const stroke = isActiveCell ? "rgba(0,0,0,0.55)" : "rgba(0,0,0,0.18)";
                const strokeWidth = isActiveCell ? 2 : 1;

                return (
                  <div
                    key={`${x},${y}`}
                    style={{
                      position: "absolute",
                      left,
                      top,
                      width: HEX_W,
                      height: HEX_H,
                      pointerEvents: "none",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      userSelect: "none",
                      fontSize: 14,
                      padding: 6
                    }}
                  >
                    <svg
                      width={HEX_W}
                      height={HEX_H}
                      viewBox={`0 0 ${HEX_W} ${HEX_H}`}
                      aria-hidden="true"
                      style={{ position: "absolute", inset: 0 }}
                    >
                      <polygon
                        points={`${HEX_W * 0.25},0 ${HEX_W * 0.75},0 ${HEX_W},${HEX_H * 0.5} ${HEX_W * 0.75},${HEX_H} ${HEX_W * 0.25},${HEX_H} 0,${HEX_H * 0.5}`}
                        fill={bg}
                        stroke={stroke}
                        strokeWidth={strokeWidth}
                      />
                      {isMoveOption ? (
                        <polygon
                          points={`${HEX_W * 0.25},0 ${HEX_W * 0.75},0 ${HEX_W},${HEX_H * 0.5} ${HEX_W * 0.75},${HEX_H} ${HEX_W * 0.25},${HEX_H} 0,${HEX_H * 0.5}`}
                          fill="none"
                          stroke="rgba(0, 128, 0, 0.35)"
                          strokeWidth="3"
                        />
                      ) : null}
                    </svg>
                    <div style={{ position: "relative", textAlign: "center", lineHeight: 1.1 }}>{label}</div>
                  </div>
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
