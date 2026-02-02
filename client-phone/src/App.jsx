import React, { useEffect, useMemo, useRef, useState } from "react";
import { MsgType, Role, makeMsg } from "../../shared/protocol.js";
import { ActionType, hexNeighbors } from "../../shared/game.js";

const cardStyle = { border: "1px solid #ddd", borderRadius: 12, padding: 16, marginBottom: 12, background: "#fff" };

const mono = {
  fontFamily:
    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace"
};

function getQuerySessionId() {
  const u = new URL(window.location.href);
  return u.searchParams.get("session");
}

function defaultWsUrl() {
  const host = window.location.hostname || "localhost";
  return localStorage.getItem("tt_server_ws") || `ws://${host}:3000`;
}

export default function App() {
  const [wsUrl, setWsUrl] = useState(defaultWsUrl());
  const [status, setStatus] = useState("disconnected");
  const [clientId, setClientId] = useState(null);
  const [error, setError] = useState(null);

  const [playerName, setPlayerName] = useState(localStorage.getItem("tt_player_name") || "");
  const [seat, setSeat] = useState(1);
  const [joined, setJoined] = useState(false);
  const [player, setPlayer] = useState(null);
  const [privateState, setPrivateState] = useState(null);

  const resumeToken = useMemo(() => localStorage.getItem("tt_resume_token") || "", []);
  const sessionId = useMemo(() => getQuerySessionId() || "", []);

  const wsRef = useRef(null);

  useEffect(() => {
    setError(null);
    setStatus("connecting");

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus("connected");
      ws.send(
        JSON.stringify(
          makeMsg(
            MsgType.HELLO,
            { role: Role.PHONE, sessionId, resumeToken: resumeToken || undefined },
            "hello-phone"
          )
        )
      );
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.t === MsgType.OK && msg.id === "hello-phone") {
          setClientId(msg.payload?.clientId ?? null);
        } else if (msg.t === MsgType.OK && msg.id === "join") {
          const token = msg.payload?.resumeToken;
          if (token) localStorage.setItem("tt_resume_token", token);
          if (msg.payload?.seat) setJoined(true);
        } else if (msg.t === MsgType.STATE_PRIVATE) {
          const st = msg.payload?.state ?? null;
          setPrivateState(st);
          if (st?.player) {
            setJoined(true);
            setPlayer(st.player);
          }
        } else if (msg.t === MsgType.ERROR) {
          const m = msg.payload?.message ?? "Unknown error";
          const sn = msg.payload?.snippet;
          setError(sn ? `${m}\n\nSnippet:\n${sn}` : m);
        }
      } catch {
        // ignore
      }
    };

    ws.onclose = () => setStatus("disconnected");
    ws.onerror = () => setStatus("error");

    return () => { try { ws.close(); } catch {} };
  }, [wsUrl, resumeToken, sessionId]);

  function reconnect() {
    localStorage.setItem("tt_server_ws", wsUrl);
    setWsUrl(wsUrl.trim());
  }

  function doJoin() {
    setError(null);
    const ws = wsRef.current;
    const name = playerName.trim().slice(0, 32);
    if (!name) return setError("Enter a player name.");
    localStorage.setItem("tt_player_name", name);

    if (!ws || ws.readyState !== WebSocket.OPEN) return setError("Not connected to server.");
    ws.send(JSON.stringify(makeMsg(MsgType.JOIN, { playerName: name, seat: Number(seat) || undefined }, "join")));
  }

  function sendMove(toX, toY) {
    setError(null);
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return setError("Not connected to server.");
    ws.send(JSON.stringify(makeMsg(MsgType.ACTION, { action: ActionType.MOVE, params: { toX, toY } }, "move")));
  }

  function sendAction(action) {
    setError(null);
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return setError("Not connected to server.");
    ws.send(JSON.stringify(makeMsg(MsgType.ACTION, { action, params: {} }, "act")));
  }

  const g = privateState?.game || null;
  const active = Boolean(g?.youAreActive);
  const hero = g?.hero || null;
  const enemy = g?.enemy || null;
  const grid = g?.grid || { w: 10, h: 7 };
  const heroesPublic = g?.heroesPublic || [];
  const apRemaining = g?.apRemaining ?? 0;
  const apMax = g?.apMax ?? 2;
  const allowed = new Set(g?.allowedActions || []);
  const occupied = new Set();
  for (const h of heroesPublic) {
    if (h.hp > 0) occupied.add(`${h.x},${h.y}`);
  }
  if (enemy && enemy.hp > 0) occupied.add(`${enemy.x},${enemy.y}`);

  const inBounds = (x, y) => x >= 0 && y >= 0 && x < grid.w && y < grid.h;

  const neighborCells =
    active && hero && hero.hp > 0 && allowed.has(ActionType.MOVE) && apRemaining > 0
      ? hexNeighbors(hero.x, hero.y).map((c) => ({
          x: c.x,
          y: c.y,
          inBounds: inBounds(c.x, c.y),
          blocked: occupied.has(`${c.x},${c.y}`),
          canMove: inBounds(c.x, c.y) && !occupied.has(`${c.x},${c.y}`)
        }))
      : [];
  const MINI_HEX_W = 68;
  const MINI_HEX_H = 58;
  const MINI_HEX_POINTS = `${MINI_HEX_W * 0.25},0 ${MINI_HEX_W * 0.75},0 ${MINI_HEX_W},${MINI_HEX_H * 0.5} ${MINI_HEX_W * 0.75},${MINI_HEX_H} ${MINI_HEX_W * 0.25},${MINI_HEX_H} 0,${MINI_HEX_H * 0.5}`;

  return (
    <div style={{ padding: 16, maxWidth: 720, margin: "0 auto", background: "#f6f7f9", minHeight: "100vh" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
        <h1 style={{ margin: 0 }}>TouchTable Dungeon — Phone</h1>
        <div style={{ ...mono, opacity: 0.8 }}>
          status: {status} {clientId ? `• clientId=${clientId}` : ""}
        </div>
      </div>

      <div style={cardStyle}>
        <h2 style={{ marginTop: 0 }}>Server</h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <label style={{ width: 120 }}>WS URL</label>
          <input
            value={wsUrl}
            onChange={(e) => setWsUrl(e.target.value)}
            style={{ flex: 1, padding: 10, borderRadius: 10, border: "1px solid #ccc" }}
          />
          <button onClick={reconnect} style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ccc", background: "#fff" }}>
            Reconnect
          </button>
        </div>
      </div>

      {!joined ? (
        <div style={cardStyle}>
          <h2 style={{ marginTop: 0 }}>Join</h2>
          <div style={{ marginBottom: 10, opacity: 0.8 }}>
            session: <span style={mono}>{sessionId || "(none)"}</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 120px", gap: 8 }}>
            <input
              placeholder="Your name"
              value={playerName}
              onChange={(e) => setPlayerName(e.target.value)}
              style={{ padding: 12, borderRadius: 10, border: "1px solid #ccc" }}
            />
            <input
              type="number"
              min="1"
              max="6"
              value={seat}
              onChange={(e) => setSeat(e.target.value)}
              style={{ padding: 12, borderRadius: 10, border: "1px solid #ccc" }}
            />
          </div>
          <button onClick={doJoin} style={{ marginTop: 10, width: "100%", padding: 12, borderRadius: 12, border: "1px solid #ccc", background: "#fff" }}>
            Join Seat
          </button>
        </div>
      ) : (
        <>
          <div style={cardStyle}>
            <h2 style={{ marginTop: 0 }}>You</h2>
            {player ? (
              <>
                <div style={mono}>
                  {player.playerName} • seat {player.seat} • {active ? "YOUR TURN" : "waiting…"}
                </div>
                <div style={{ marginTop: 10, opacity: 0.9 }}>
                  Hero HP: <span style={mono}>{hero ? `${hero.hp}/${hero.maxHp}` : "—"}</span>
                </div>
                <div style={{ marginTop: 8, opacity: 0.9 }}>
                  Actions: <span style={mono}>{apRemaining}/{apMax}</span>
                </div>
                <div style={{ marginTop: 8, opacity: 0.9 }}>
                  Enemy HP: <span style={mono}>{enemy ? `${enemy.hp}/${enemy.maxHp}` : "—"}</span>
                </div>
              </>
            ) : (
              <p>Joined, waiting for private state…</p>
            )}
          </div>


          <div style={cardStyle}>
            <h2 style={{ marginTop: 0 }}>Move</h2>

            {!active || !hero ? (
              <p style={{ marginBottom: 0, opacity: 0.75 }}>Wait for your turn to move.</p>
            ) : !allowed.has(ActionType.MOVE) || apRemaining <= 0 ? (
              <p style={{ marginBottom: 0, opacity: 0.75 }}>No actions remaining. End your turn to refresh actions.</p>
            ) : (
              <>
                <div style={{ ...mono, opacity: 0.8, marginBottom: 10 }}>
                  Tap a highlighted hex to move (costs 1 action).
                </div>

                <div style={{ position: "relative", width: 260, height: 220, margin: "0 auto" }}>
                  <div
                    style={{
                      position: "absolute",
                      left: 96,
                      top: 82,
                      width: MINI_HEX_W,
                      height: MINI_HEX_H,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 20
                    }}
                  >
                    <svg
                      width={MINI_HEX_W}
                      height={MINI_HEX_H}
                      viewBox={`0 0 ${MINI_HEX_W} ${MINI_HEX_H}`}
                      aria-hidden="true"
                      style={{ position: "absolute", inset: 0 }}
                    >
                      <polygon points={MINI_HEX_POINTS} fill="rgba(0,0,0,0.04)" stroke="rgba(0,0,0,0.18)" strokeWidth="1" />
                    </svg>
                    <div style={{ position: "relative" }}>🧙</div>
                  </div>

                  {(() => {
                    const xStep = MINI_HEX_W * 0.75;
                    const yStep = MINI_HEX_H;
                    const centerLeft = 96;
                    const centerTop = 82;
                    const heroParityOffset = (hero.x % 2 === 0) ? 0 : (yStep / 2);

                    return neighborCells.map((c) => {
                      const cParityOffset = (c.x % 2 === 0) ? 0 : (yStep / 2);
                      const left = centerLeft + ((c.x - hero.x) * xStep);
                      const top = centerTop + ((c.y - hero.y) * yStep) + (cParityOffset - heroParityOffset);
                      const hasEnemy = enemy && enemy.hp > 0 && enemy.x === c.x && enemy.y === c.y;
                      const otherHero = heroesPublic.find((h) => h.hp > 0 && h.x === c.x && h.y === c.y);

                      const label = !c.inBounds
                        ? ""
                        : hasEnemy
                          ? "👾"
                          : otherHero
                            ? (otherHero.ownerPlayerName ? otherHero.ownerPlayerName.split(/\s+/)[0].slice(0, 2).toUpperCase() : "🧙")
                            : c.canMove
                              ? "•"
                              : "";

                      const bg = !c.inBounds
                        ? "rgba(0,0,0,0.02)"
                        : hasEnemy
                          ? "rgba(255,0,0,0.08)"
                          : otherHero
                            ? "rgba(0,0,0,0.04)"
                            : c.canMove
                              ? "rgba(0,128,0,0.10)"
                              : "#fff";

                      const opacity = !c.inBounds ? 0.25 : (hasEnemy || otherHero || c.canMove) ? 1 : 0.35;

                      return (
                        <button
                          key={`${c.x},${c.y}`}
                          disabled={!c.canMove}
                          onClick={() => sendMove(c.x, c.y)}
                          style={{
                            position: "absolute",
                            left,
                            top,
                            width: MINI_HEX_W,
                            height: MINI_HEX_H,
                            border: "none",
                            background: "transparent",
                            opacity,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: 18,
                            padding: 0,
                            cursor: c.canMove ? "pointer" : "default"
                          }}
                        >
                          <svg
                            width={MINI_HEX_W}
                            height={MINI_HEX_H}
                            viewBox={`0 0 ${MINI_HEX_W} ${MINI_HEX_H}`}
                            aria-hidden="true"
                            style={{ position: "absolute", inset: 0 }}
                          >
                            <polygon points={MINI_HEX_POINTS} fill={bg} stroke="rgba(0,0,0,0.18)" strokeWidth="1" />
                          </svg>
                          <div style={{ position: "relative" }}>{label}</div>
                        </button>
                      );
                    });
                  })()}
                </div>

                <div style={{ marginTop: 10, opacity: 0.75, textAlign: "center" }}>
                  Actions left: <span style={mono}>{apRemaining}/{apMax}</span>
                </div>
              </>
            )}
          </div>
          <div style={cardStyle}>
            <h2 style={{ marginTop: 0 }}>Actions</h2>
            <button
              disabled={!active || !allowed.has(ActionType.ATTACK)}
              onClick={() => sendAction(ActionType.ATTACK)}
              style={{ width: "100%", padding: 14, borderRadius: 12, border: "1px solid #ccc", background: "#fff", opacity: !active ? 0.6 : 1, marginBottom: 10 }}
            >
              Attack (melee)
            </button>
            <button
              disabled={!active || !allowed.has(ActionType.END_TURN)}
              onClick={() => sendAction(ActionType.END_TURN)}
              style={{ width: "100%", padding: 14, borderRadius: 12, border: "1px solid #ccc", background: "#fff", opacity: !active ? 0.6 : 1 }}
            >
              End Turn
            </button>
          </div>
        </>
      )}

      {error ? <p style={{ color: "crimson" }}>Error: {error}</p> : null}
    </div>
  );
}
