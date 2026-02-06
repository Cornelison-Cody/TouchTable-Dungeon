import React, { useEffect, useMemo, useRef, useState } from "react";
import { MsgType, Role, makeMsg } from "../../shared/protocol.js";
import { ActionType, hexNeighbors } from "../../shared/game.js";

const theme = {
  bgA: "#0f1720",
  bgB: "#131c26",
  card: "#141c26",
  surface: "#18222e",
  surfaceAlt: "#1c2733",
  text: "#e6edf4",
  sub: "#9db0c3",
  border: "#2a3848",
  brand: "#20bfb7",
  brandDark: "#16938c",
  danger: "#ff6b6b",
  success: "#4cd68a",
  shadow: "0 18px 40px rgba(0, 0, 0, 0.45)"
};

const shellStyle = {
  minHeight: "100vh",
  padding: 16,
  background: `radial-gradient(circle at 10% -10%, ${theme.bgA}, transparent 45%), radial-gradient(circle at 90% 0%, ${theme.bgB}, transparent 40%), #0d131a`,
  color: theme.text,
  fontFamily: "Avenir Next, Segoe UI, Helvetica Neue, sans-serif"
};

const cardStyle = {
  border: `1px solid ${theme.border}`,
  borderRadius: 18,
  padding: 14,
  marginBottom: 12,
  background: theme.card,
  boxShadow: theme.shadow
};

const mono = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
};

function Icon({ path, size = 16, stroke = "currentColor", fill = "none", strokeWidth = 2 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ display: "block" }}>
      <path d={path} stroke={stroke} fill={fill} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function StatTile({ icon, label, value, tone = "neutral" }) {
  const bg = tone === "danger" ? "rgba(255, 107, 107, 0.16)" : tone === "success" ? "rgba(76, 214, 138, 0.16)" : theme.surface;
  const color = tone === "danger" ? theme.danger : tone === "success" ? theme.success : theme.sub;
  return (
    <div style={{ background: bg, color, borderRadius: 12, padding: "10px 12px", border: `1px solid ${theme.border}` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4 }}>
        {icon}
        {label}
      </div>
      <div style={{ marginTop: 4, fontSize: 18, fontWeight: 700 }}>{value}</div>
    </div>
  );
}

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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [damageFx, setDamageFx] = useState(null);

  const resumeToken = useMemo(() => localStorage.getItem("tt_resume_token") || "", []);
  const sessionId = useMemo(() => getQuerySessionId() || "", []);

  const wsRef = useRef(null);
  const seenDamageAtRef = useRef(0);

  useEffect(() => {
    setError(null);
    setStatus("connecting");

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus("connected");
      ws.send(JSON.stringify(makeMsg(MsgType.HELLO, { role: Role.PHONE, sessionId, resumeToken: resumeToken || undefined }, "hello-phone")));
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
          } else {
            setJoined(false);
            setPlayer(null);
          }
        } else if (msg.t === MsgType.ERROR) {
          const m = msg.payload?.message ?? "Unknown error";
          const sn = msg.payload?.snippet;
          if (msg.payload?.code === "KICKED") {
            localStorage.removeItem("tt_resume_token");
            setJoined(false);
            setPlayer(null);
          }
          setError(sn ? `${m}\n\nSnippet:\n${sn}` : m);
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
  }, [wsUrl, resumeToken, sessionId]);

  function reconnect() {
    localStorage.setItem("tt_server_ws", wsUrl);
    setWsUrl(wsUrl.trim());
    setSettingsOpen(false);
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

  const canSpendMove = allowed.has(ActionType.MOVE) && apRemaining > 0;
  const neighborCells =
    active && hero && hero.hp > 0 && (canSpendMove || Boolean(damageFx))
      ? hexNeighbors(hero.x, hero.y).map((c) => ({
          x: c.x,
          y: c.y,
          inBounds: inBounds(c.x, c.y),
          canMove: canSpendMove && inBounds(c.x, c.y) && !occupied.has(`${c.x},${c.y}`)
        }))
      : [];

  const MINI_HEX_W = 70;
  const MINI_HEX_H = 60;
  const MINI_HEX_POINTS = `${MINI_HEX_W * 0.25},0 ${MINI_HEX_W * 0.75},0 ${MINI_HEX_W},${MINI_HEX_H * 0.5} ${MINI_HEX_W * 0.75},${MINI_HEX_H} ${MINI_HEX_W * 0.25},${MINI_HEX_H} 0,${MINI_HEX_H * 0.5}`;

  const statusTone = status === "connected"
    ? { bg: "rgba(76, 214, 138, 0.18)", color: theme.success }
    : status === "error"
      ? { bg: "rgba(255, 107, 107, 0.18)", color: theme.danger }
      : { bg: "rgba(157, 176, 195, 0.16)", color: theme.sub };

  useEffect(() => {
    const hit = privateState?.game?.lastHeroDamage;
    if (!hit?.at || hit.at <= seenDamageAtRef.current) return;
    seenDamageAtRef.current = hit.at;
    const fx = { id: hit.at, amount: hit.amount, enemyHp: hit.enemyHp, enemyMaxHp: hit.enemyMaxHp };
    setDamageFx(fx);
    const t = setTimeout(() => {
      setDamageFx((curr) => (curr && curr.id === fx.id ? null : curr));
    }, 950);
    return () => clearTimeout(t);
  }, [privateState]);

  return (
    <div style={shellStyle}>
      <div style={{ maxWidth: 760, margin: "0 auto" }}>
        <style>{`
          @keyframes phoneEnemyHitShake {
            0%, 100% { transform: translateX(0); }
            20% { transform: translateX(-2px); }
            40% { transform: translateX(2px); }
            60% { transform: translateX(-2px); }
            80% { transform: translateX(2px); }
          }
          @keyframes phoneHitFloat {
            0% { transform: translate(-50%, 0) scale(0.9); opacity: 0; }
            18% { transform: translate(-50%, -6px) scale(1); opacity: 1; }
            100% { transform: translate(-50%, -26px) scale(1); opacity: 0; }
          }
        `}</style>
        <div style={{ ...cardStyle, padding: 12, position: "relative", display: "flex", alignItems: "center", justifyContent: "space-between", background: "linear-gradient(135deg, #1b2430, #141c26)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: 0.2 }}>Dungeon Phone Console</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              onClick={() => {
                setSettingsOpen((v) => {
                  const next = !v;
                  return next;
                });
              }}
              aria-label="Open settings"
              style={{ width: 36, height: 36, borderRadius: 10, border: `1px solid ${theme.border}`, background: theme.surfaceAlt, cursor: "pointer", display: "grid", placeItems: "center" }}
            >
              <Icon path="M6 12h.01 M12 12h.01 M18 12h.01" size={18} stroke={theme.sub} strokeWidth={3} />
            </button>
          </div>

          {settingsOpen ? (
            <div style={{ position: "absolute", left: "50%", transform: "translateX(-50%)", top: 54, width: "min(400px, 80vw)", background: theme.card, border: `1px solid ${theme.border}`, borderRadius: 14, boxShadow: theme.shadow, padding: 12, zIndex: 10 }}>
              <div style={{ ...mono, fontSize: 12, padding: "6px 10px", borderRadius: 999, background: statusTone.bg, color: statusTone.color, display: "inline-block", marginBottom: 8 }}>
                {status}
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 2 }}>
                <input
                  value={wsUrl}
                  onChange={(e) => setWsUrl(e.target.value)}
                  style={{ flex: 1, padding: 10, borderRadius: 10, border: `1px solid ${theme.border}`, fontSize: 14, background: theme.surfaceAlt, color: theme.text }}
                />
                <button
                  onClick={reconnect}
                  style={{ padding: "10px 12px", borderRadius: 10, border: "none", background: theme.brand, color: "#fff", fontWeight: 700, cursor: "pointer" }}
                >
                  Reconnect
                </button>
              </div>
              <button
                onClick={() => {
                  setSettingsOpen(false);
                }}
                style={{ marginTop: 10, width: "100%", padding: "8px 10px", borderRadius: 10, border: `1px solid ${theme.border}`, background: theme.surfaceAlt, color: theme.text, fontWeight: 600, cursor: "pointer" }}
              >
                Close Menu
              </button>
            </div>
          ) : null}
        </div>
        <div style={{ height: 2 }} />

        {!joined ? (
          <div style={cardStyle}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, fontWeight: 700 }}>
              <Icon path="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M4 20a8 8 0 0 1 16 0" stroke={theme.brandDark} />
              Join Seat
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 110px", gap: 8 }}>
              <input
                placeholder="Your name"
                value={playerName}
                onChange={(e) => setPlayerName(e.target.value)}
                style={{ padding: 12, borderRadius: 12, border: `1px solid ${theme.border}`, background: theme.surfaceAlt, color: theme.text }}
              />
              <input
                type="number"
                min="1"
                max="6"
                value={seat}
                onChange={(e) => setSeat(e.target.value)}
                style={{ padding: 12, borderRadius: 12, border: `1px solid ${theme.border}`, background: theme.surfaceAlt, color: theme.text }}
              />
            </div>
            <button
              onClick={doJoin}
              style={{ marginTop: 10, width: "100%", padding: 12, borderRadius: 12, border: "none", background: theme.brand, color: "#081316", fontWeight: 800, cursor: "pointer" }}
            >
              Enter Dungeon
            </button>
          </div>
        ) : (
          <>
            <div style={cardStyle}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                <div style={{ fontWeight: 800, fontSize: 18 }}>{player?.playerName || "Player"}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ padding: "6px 10px", borderRadius: 999, fontWeight: 700, fontSize: 12, background: active ? "rgba(76, 214, 138, 0.18)" : "rgba(157, 176, 195, 0.16)", color: active ? theme.success : theme.sub }}>
                    {active ? "YOUR TURN" : "WAITING"}
                  </div>
                  <button
                    disabled={!active || !allowed.has(ActionType.END_TURN)}
                    onClick={() => sendAction(ActionType.END_TURN)}
                    style={{
                      padding: "8px 12px",
                      borderRadius: 10,
                      border: "none",
                      background: !active || !allowed.has(ActionType.END_TURN) ? "#2a3541" : "#d08a2f",
                      color: !active || !allowed.has(ActionType.END_TURN) ? "#9aa8b6" : "#221507",
                      fontWeight: 800,
                      cursor: !active || !allowed.has(ActionType.END_TURN) ? "not-allowed" : "pointer"
                    }}
                  >
                    End Turn
                  </button>
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8 }}>
                <StatTile
                  icon={<Icon path="M12 21s-7-4.5-7-10a7 7 0 0 1 14 0c0 5.5-7 10-7 10z" stroke={theme.danger} />}
                  label="HP"
                  value={hero ? `${hero.hp}/${hero.maxHp}` : "-"}
                  tone="danger"
                />
                <StatTile
                  icon={<Icon path="M13 2L5 14h6l-1 8 8-12h-6z" stroke={theme.brandDark} />}
                  label="Action"
                  value={`${apRemaining}/${apMax}`}
                />
              </div>
            </div>

            <div style={cardStyle}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, fontWeight: 700 }}>
                <Icon path="M4 20l8-16 8 16" stroke={theme.brandDark} />
                Move and Attack
              </div>

              {!active || !hero ? (
                <p style={{ marginBottom: 0, color: theme.sub }}>Wait for your turn.</p>
              ) : (!allowed.has(ActionType.MOVE) || apRemaining <= 0) && !damageFx ? (
                <p style={{ marginBottom: 0, color: theme.sub }}>No actions remaining. End turn to refresh.</p>
              ) : (
                <>
                  <div style={{ ...mono, color: theme.sub, marginBottom: 10, fontSize: 12 }}>
                    Tap green to move. Tap red enemy to attack.
                  </div>

                  <div style={{ position: "relative", width: 260, height: 220, margin: "0 auto" }}>
                    <div style={{ position: "absolute", left: 95, top: 80, width: MINI_HEX_W, height: MINI_HEX_H, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, color: "#cfe3f7" }}>
                      <svg width={MINI_HEX_W} height={MINI_HEX_H} viewBox={`0 0 ${MINI_HEX_W} ${MINI_HEX_H}`} aria-hidden="true" style={{ position: "absolute", inset: 0 }}>
                        <polygon points={MINI_HEX_POINTS} fill="#1a2430" stroke="#3a4b5e" strokeWidth="1.2" />
                      </svg>
                      <div style={{ position: "relative" }}>YOU</div>
                    </div>

                    {(() => {
                      const xStep = MINI_HEX_W * 0.75;
                      const yStep = MINI_HEX_H;
                      const centerLeft = 95;
                      const centerTop = 80;
                      const heroParityOffset = (hero.x % 2 === 0) ? 0 : (yStep / 2);

                      return neighborCells.map((c) => {
                        const cParityOffset = (c.x % 2 === 0) ? 0 : (yStep / 2);
                        const left = centerLeft + ((c.x - hero.x) * xStep);
                        const top = centerTop + ((c.y - hero.y) * yStep) + (cParityOffset - heroParityOffset);

                        const hasEnemy = enemy && enemy.hp > 0 && enemy.x === c.x && enemy.y === c.y;
                        const otherHero = heroesPublic.find((h) => h.hp > 0 && h.x === c.x && h.y === c.y);
                        const canAttack = Boolean(hasEnemy && allowed.has(ActionType.ATTACK));
                        const canTap = c.canMove || canAttack;
                        const showDamageFx = Boolean(hasEnemy && damageFx);

                        const bg = !c.inBounds
                          ? "#141a20"
                          : hasEnemy
                            ? "#3a1b1f"
                            : otherHero
                              ? "#1b222c"
                              : c.canMove
                                ? "#173023"
                                : "#1a222c";

                        const stroke = hasEnemy ? "#b85b5b" : c.canMove ? "#4da06a" : "#435465";
                        const label = !c.inBounds ? "" : hasEnemy ? "EN" : otherHero ? "AL" : c.canMove ? "GO" : "";

                        return (
                          <button
                            key={`${c.x},${c.y}`}
                            disabled={!canTap}
                            onClick={() => (canAttack ? sendAction(ActionType.ATTACK) : sendMove(c.x, c.y))}
                            style={{
                              position: "absolute",
                              left,
                              top,
                              width: MINI_HEX_W,
                              height: MINI_HEX_H,
                              border: "none",
                              background: "transparent",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              padding: 0,
                              fontWeight: 800,
                              fontSize: 12,
                              letterSpacing: 0.6,
                              color: hasEnemy ? theme.danger : c.canMove ? theme.success : theme.sub,
                              opacity: !c.inBounds ? 0.25 : (hasEnemy || otherHero || c.canMove) ? 1 : 0.45,
                              cursor: canTap ? "pointer" : "default",
                              transformOrigin: "50% 50%",
                              animation: showDamageFx ? "phoneEnemyHitShake 0.35s ease-in-out" : "none"
                            }}
                          >
                            <svg width={MINI_HEX_W} height={MINI_HEX_H} viewBox={`0 0 ${MINI_HEX_W} ${MINI_HEX_H}`} aria-hidden="true" style={{ position: "absolute", inset: 0 }}>
                              <polygon points={MINI_HEX_POINTS} fill={bg} stroke={stroke} strokeWidth="1.2" />
                            </svg>
                            <div style={{ position: "relative" }}>{label}</div>
                            {showDamageFx ? (
                              <div
                                style={{
                                  position: "absolute",
                                  left: "50%",
                                  top: -4,
                                  background: "rgba(18, 24, 32, 0.95)",
                                  color: theme.danger,
                                  border: "1px solid rgba(255, 107, 107, 0.4)",
                                  borderRadius: 999,
                                  padding: "2px 8px",
                                  fontSize: 11,
                                  fontWeight: 900,
                                  letterSpacing: 0.3,
                                  whiteSpace: "nowrap",
                                  pointerEvents: "none",
                                  animation: "phoneHitFloat 0.95s ease-out forwards"
                                }}
                              >
                                -{damageFx.amount} ({damageFx.enemyHp}/{damageFx.enemyMaxHp})
                              </div>
                            ) : null}
                          </button>
                        );
                      });
                    })()}
                  </div>

                  <div style={{ marginTop: 10, textAlign: "center", color: theme.sub }}>
                    Actions left: <span style={{ ...mono, color: theme.text }}>{apRemaining}/{apMax}</span>
                  </div>
                </>
              )}
            </div>
          </>
        )}

        {error ? (
          <div style={{ ...cardStyle, borderColor: "#5b2a2a", background: "#2a1416", color: "#f0a0a0", whiteSpace: "pre-wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, fontWeight: 700 }}>
              <Icon path="M12 9v4 M12 17h.01 M4.93 19h14.14a2 2 0 0 0 1.74-3L13.74 4a2 2 0 0 0-3.48 0L3.19 16a2 2 0 0 0 1.74 3z" stroke={theme.danger} />
              Error
            </div>
            {error}
          </div>
        ) : null}
      </div>
    </div>
  );
}
