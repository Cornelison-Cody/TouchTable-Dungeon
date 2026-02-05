import React, { useEffect, useRef, useState } from "react";
import { QRCodeCanvas } from "qrcode.react";
import { MsgType, Role, makeMsg } from "../../shared/protocol.js";
import { ActionType, hexWithinRange } from "../../shared/game.js";
import forestTexture from "./assets/catan-textures/forest.svg";
import pastureTexture from "./assets/catan-textures/pasture.svg";
import wheatTexture from "./assets/catan-textures/wheat.svg";
import hillsTexture from "./assets/catan-textures/hills.svg";
import mountainsTexture from "./assets/catan-textures/mountains.svg";
import desertTexture from "./assets/catan-textures/desert.svg";

const mono = {
  fontFamily:
    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace"
};

const panelStyle = {
  background: "rgba(255, 255, 255, 0.84)",
  border: "1px solid rgba(18, 36, 58, 0.12)",
  borderRadius: 18,
  boxShadow: "0 18px 40px rgba(9, 28, 48, 0.14)",
  backdropFilter: "blur(10px)",
  padding: 14
};

function makeWsUrl() {
  return localStorage.getItem("tt_server_ws") || "ws://localhost:3000";
}

function Icon({ path, size = 16, stroke = "currentColor", fill = "none", strokeWidth = 2 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ display: "block" }}>
      <path d={path} stroke={stroke} fill={fill} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function statusColor(status) {
  if (status === "connected") return "#149b6c";
  if (status === "connecting") return "#e89e1b";
  if (status === "error") return "#d53d3d";
  return "#7a8a99";
}

const TABLE_GAMES = [
  {
    id: "touchtable-dungeon",
    title: "TouchTable Dungeon",
    subtitle: "Co-op tactical crawl",
    description: "A shared-board dungeon run with live phones, turn AP, and monster encounters.",
    badges: ["Live now", "4 players", "Tactical"]
  },
  {
    id: "catan",
    title: "Catan",
    subtitle: "Physical pieces mode",
    description: "Classic 19-hex board with randomized number tokens for physical cards and pieces on top of the table display.",
    badges: ["No phones", "Board randomizer", "GoDice next"]
  }
];

function DungeonTableView({ onBackToMenu }) {
  const [wsUrl] = useState(makeWsUrl());
  const [status, setStatus] = useState("disconnected");
  const [sessionInfo, setSessionInfo] = useState(null);
  const [publicState, setPublicState] = useState(null);
  const [error, setError] = useState(null);
  const [tableHitFx, setTableHitFx] = useState(null);
  const [audioReady, setAudioReady] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [kickPrompt, setKickPrompt] = useState(null);
  const [enemyInspectOpen, setEnemyInspectOpen] = useState(false);

  const wsRef = useRef(null);
  const prevEnemyHpRef = useRef(null);
  const audioCtxRef = useRef(null);

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
        if (msg.t === MsgType.SESSION_INFO) {
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

  function sendTableAction(action, params = {}, msgId = "table-action") {
    setError(null);
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setError("Not connected to server.");
      return;
    }
    ws.send(JSON.stringify(makeMsg(MsgType.ACTION, { action, params }, msgId)));
  }

  function spawnEnemyForTesting() {
    sendTableAction(ActionType.SPAWN_ENEMY, {}, "spawn-enemy");
  }

  function kickPlayer(playerId, playerName) {
    if (!playerId) return;
    setKickPrompt({ playerId, playerName: playerName || playerId.slice(0, 4) });
  }

  function confirmKickPlayer() {
    if (!kickPrompt?.playerId) return;
    sendTableAction(ActionType.KICK_PLAYER, { playerId: kickPrompt.playerId }, "kick-player");
    setKickPrompt(null);
  }

  function ensureAudioContext() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    if (!audioCtxRef.current) audioCtxRef.current = new Ctx();
    return audioCtxRef.current;
  }

  function unlockAudio() {
    const ctx = ensureAudioContext();
    if (!ctx) return;
    if (ctx.state === "running") {
      setAudioReady(true);
      return;
    }
    ctx
      .resume()
      .then(() => {
        setAudioReady(ctx.state === "running");
      })
      .catch(() => {});
  }

  function playHitSound() {
    const ctx = ensureAudioContext();
    if (!ctx) return;
    if (ctx.state !== "running") {
      unlockAudio();
      return;
    }

    setAudioReady(true);
    const t = ctx.currentTime;

    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.setValueAtTime(-28, t);
    compressor.knee.setValueAtTime(24, t);
    compressor.ratio.setValueAtTime(10, t);
    compressor.attack.setValueAtTime(0.003, t);
    compressor.release.setValueAtTime(0.14, t);

    const master = ctx.createGain();
    master.gain.setValueAtTime(1.25, t);
    master.connect(compressor).connect(ctx.destination);

    const strike = (start, f0, f1, peak, type, dur) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(f0, start);
      osc.frequency.exponentialRampToValueAtTime(f1, start + dur);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(peak, start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      osc.connect(gain).connect(master);
      osc.start(start);
      osc.stop(start + dur + 0.02);
    };

    strike(t, 360, 120, 0.65, "triangle", 0.19);
    strike(t + 0.065, 300, 100, 0.5, "sawtooth", 0.16);
    strike(t, 95, 70, 0.22, "square", 0.2);

    const noiseBuffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.09), ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = (Math.random() * 2 - 1) * 0.5;
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer;
    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = "highpass";
    noiseFilter.frequency.setValueAtTime(1000, t);
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.0001, t);
    noiseGain.gain.exponentialRampToValueAtTime(0.22, t + 0.01);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    noise.connect(noiseFilter).connect(noiseGain).connect(master);
    noise.start(t);
    noise.stop(t + 0.1);
  }

  const joinUrl = sessionInfo?.joinUrl || "";
  const game = publicState?.game || null;
  const grid = game?.grid || { w: 10, h: 7 };
  const heroes = game?.heroes || [];
  const enemy = game?.enemy || null;
  const log = game?.log || [];
  const activePlayerId = game?.turn?.activePlayerId || null;
  const apMax = game?.turn?.apMax ?? 0;
  const apRemaining = game?.turn?.apRemaining ?? 0;
  const enemyCount = enemy && enemy.hp > 0 ? 1 : 0;
  const activeHero = heroes.find((h) => h.ownerPlayerId === activePlayerId) || null;

  useEffect(() => {
    window.addEventListener("pointerdown", unlockAudio);
    window.addEventListener("keydown", unlockAudio);
    window.addEventListener("touchstart", unlockAudio);
    return () => {
      window.removeEventListener("pointerdown", unlockAudio);
      window.removeEventListener("keydown", unlockAudio);
      window.removeEventListener("touchstart", unlockAudio);
    };
  }, []);

  useEffect(() => {
    const nextEnemy = publicState?.game?.enemy;
    if (!nextEnemy) {
      prevEnemyHpRef.current = null;
      setEnemyInspectOpen(false);
      return;
    }

    const prevHp = prevEnemyHpRef.current;
    const nextHp = nextEnemy.hp;
    let timeoutId = null;

    if (typeof prevHp === "number" && nextHp < prevHp) {
      const amount = prevHp - nextHp;
      const fx = { id: Date.now(), x: nextEnemy.x, y: nextEnemy.y, amount };
      setTableHitFx(fx);
      playHitSound();
      timeoutId = setTimeout(() => {
        setTableHitFx((curr) => (curr && curr.id === fx.id ? null : curr));
      }, 900);
    }

    prevEnemyHpRef.current = nextHp;
    return () => {
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [publicState]);

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

  const HEX_SIZE = 42;
  const HEX_W = HEX_SIZE * 2;
  const HEX_H = Math.sqrt(3) * HEX_SIZE;

  function heroGlyph(hero) {
    const name = hero.ownerPlayerName || "";
    const initials = name
      ? name
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 2)
          .map((part) => part[0].toUpperCase())
          .join("")
      : (hero.ownerPlayerId || "").slice(0, 2).toUpperCase();
    return `H-${initials}`;
  }

  function enemyProfile(enemyUnit) {
    if (!enemyUnit) return null;
    return {
      name: enemyUnit.name || "Unknown Hostile",
      art: enemyUnit.art || "👹",
      flavor: enemyUnit.flavor || "A dangerous foe with unstable behavior.",
      hp: `${enemyUnit.hp}/${enemyUnit.maxHp}`,
      attackPower: enemyUnit.attackPower ?? game?.rules?.enemyDamage ?? "-"
    };
  }

  const viewedEnemy = enemyProfile(enemy);

  return (
    <div className="ttd-root">
      <style>{`
        :root {
          --ttd-ink: #102739;
          --ttd-sub: #5d7082;
          --ttd-brand: #0f8f93;
          --ttd-brand-2: #2a6bb2;
          --ttd-danger: #cb3c3c;
          --ttd-card: rgba(255, 255, 255, 0.84);
        }
        html, body, #root {
          margin: 0;
          width: 100%;
          min-height: 100%;
        }
        body {
          background: #eef5fb;
        }
        .ttd-root {
          min-height: 100dvh;
          width: 100%;
          color: var(--ttd-ink);
          background:
            radial-gradient(circle at 0% 0%, rgba(18, 178, 176, 0.22), transparent 42%),
            radial-gradient(circle at 100% 0%, rgba(46, 113, 188, 0.22), transparent 45%),
            linear-gradient(160deg, #f6fcff 0%, #eef5fb 45%, #eef6f4 100%);
          font-family: "Avenir Next", "Segoe UI", "Helvetica Neue", sans-serif;
          padding: 16px;
          box-sizing: border-box;
        }
        .ttd-shell {
          width: 100%;
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .ttd-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          background: linear-gradient(130deg, rgba(255,255,255,0.9), rgba(255,255,255,0.72));
          border: 1px solid rgba(18, 36, 58, 0.12);
          border-radius: 18px;
          box-shadow: 0 12px 36px rgba(7, 24, 44, 0.13);
          padding: 12px 14px;
        }
        .ttd-title {
          margin: 0;
          font-size: clamp(1.15rem, 2.2vw, 1.75rem);
          font-weight: 820;
          letter-spacing: 0.2px;
        }
        .ttd-header-meta {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
          justify-content: flex-end;
        }
        .ttd-status {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          border-radius: 999px;
          border: 1px solid rgba(18, 36, 58, 0.12);
          background: rgba(255,255,255,0.75);
          padding: 6px 10px;
          font-weight: 700;
          font-size: 0.84rem;
          text-transform: uppercase;
          letter-spacing: 0.6px;
        }
        .ttd-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          box-shadow: 0 0 0 4px rgba(0,0,0,0.06);
        }
        .ttd-layout {
          display: grid;
          grid-template-columns: minmax(280px, 330px) minmax(0, 1fr);
          gap: 12px;
          align-items: start;
        }
        .ttd-stack {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .ttd-section-title {
          display: flex;
          align-items: center;
          gap: 8px;
          margin: 0 0 10px;
          font-size: 1.02rem;
          font-weight: 800;
        }
        .ttd-action-row {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
        }
        .ttd-btn {
          border: 1px solid rgba(18, 36, 58, 0.16);
          background: #ffffff;
          color: var(--ttd-ink);
          border-radius: 10px;
          font-weight: 700;
          padding: 8px 12px;
          cursor: pointer;
        }
        .ttd-btn.primary {
          background: linear-gradient(135deg, var(--ttd-brand), var(--ttd-brand-2));
          color: #fff;
          border: none;
        }
        .ttd-btn.warn {
          color: #8d1f1f;
          border-color: rgba(203, 60, 60, 0.32);
          background: #fff3f3;
          padding: 3px 8px;
          border-radius: 8px;
        }
        .ttd-btn.danger {
          color: #ffffff;
          border-color: rgba(162, 25, 25, 0.2);
          background: linear-gradient(135deg, #d24545, #b32929);
        }
        .ttd-pill {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          border-radius: 999px;
          padding: 4px 9px;
          border: 1px solid rgba(18, 36, 58, 0.14);
          background: rgba(255,255,255,0.7);
          font-size: 0.78rem;
          font-weight: 700;
          color: var(--ttd-sub);
        }
        .ttd-players {
          list-style: none;
          margin: 0;
          padding: 0;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .ttd-player {
          border: 1px solid rgba(18, 36, 58, 0.1);
          border-radius: 12px;
          padding: 8px 10px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          background: rgba(255, 255, 255, 0.65);
        }
        .ttd-seat {
          color: var(--ttd-sub);
          font-size: 0.78rem;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          font-weight: 700;
          display: block;
          margin-bottom: 2px;
        }
        .ttd-name {
          font-weight: 700;
          font-size: 0.95rem;
        }
        .ttd-stat-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 8px;
        }
        .ttd-stat {
          border: 1px solid rgba(18, 36, 58, 0.11);
          border-radius: 12px;
          padding: 8px 10px;
          background: rgba(255,255,255,0.68);
        }
        .ttd-stat label {
          display: block;
          color: var(--ttd-sub);
          font-size: 0.75rem;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-bottom: 2px;
          font-weight: 700;
        }
        .ttd-stat strong {
          font-size: 1.08rem;
        }
        .ttd-log {
          margin: 0;
          padding-left: 18px;
          max-height: 240px;
          overflow: auto;
        }
        .ttd-log li {
          margin-bottom: 6px;
          color: #27445f;
        }
        .ttd-board-shell {
          display: flex;
          flex-direction: column;
          gap: 10px;
          min-height: 78vh;
        }
        .ttd-board-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
        }
        .ttd-board-scroll {
          flex: 1;
          min-height: 68vh;
          overflow: auto;
          border-radius: 12px;
          border: 1px solid rgba(18, 36, 58, 0.11);
          background: linear-gradient(180deg, rgba(255,255,255,0.8), rgba(239,246,250,0.88));
          padding: 12px;
        }
        .ttd-error {
          border: 1px solid rgba(213, 61, 61, 0.35);
          background: rgba(255, 240, 240, 0.9);
          color: #922525;
          border-radius: 12px;
          padding: 10px 12px;
          font-weight: 600;
          white-space: pre-wrap;
        }
        .ttd-modal-backdrop {
          position: fixed;
          inset: 0;
          background: rgba(8, 18, 32, 0.52);
          display: grid;
          place-items: center;
          padding: 16px;
          z-index: 20;
        }
        .ttd-modal {
          width: min(420px, 96vw);
          border-radius: 18px;
          border: 1px solid rgba(18, 36, 58, 0.18);
          background: #ffffff;
          box-shadow: 0 22px 60px rgba(6, 20, 38, 0.36);
          padding: 14px;
        }
        .ttd-modal-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          margin-bottom: 10px;
        }
        .ttd-modal h3 {
          margin: 0;
          font-size: 1.1rem;
        }
        .ttd-qr-wrap {
          border: 1px solid rgba(18, 36, 58, 0.12);
          border-radius: 14px;
          padding: 14px;
          display: grid;
          place-items: center;
          margin-bottom: 12px;
          background: #fbfdff;
        }
        .ttd-enemy-art {
          border: 1px solid rgba(18, 36, 58, 0.14);
          border-radius: 14px;
          background: linear-gradient(140deg, rgba(222, 241, 255, 0.8), rgba(255, 231, 231, 0.8));
          display: grid;
          place-items: center;
          font-size: 72px;
          height: 148px;
          margin-bottom: 10px;
        }
        @media (max-width: 1060px) {
          .ttd-layout {
            grid-template-columns: 1fr;
          }
        }
        @keyframes tvHitPulse {
          0% { transform: scale(1); opacity: 1; }
          100% { transform: scale(1.1); opacity: 0; }
        }
        @keyframes tvHitFloat {
          0% { transform: translateY(0); opacity: 1; }
          100% { transform: translateY(-22px); opacity: 0; }
        }
      `}</style>

      <div className="ttd-shell">
        <header className="ttd-header">
          <div>
            <h1 className="ttd-title">TouchTable Dungeon</h1>
          </div>
          <div className="ttd-header-meta">
            <button className="ttd-btn" onClick={onBackToMenu}>
              Game Menu
            </button>
            <span className="ttd-pill">AP: <span style={mono}>{apRemaining}/{apMax}</span></span>
            <div className="ttd-status">
              <span className="ttd-dot" style={{ background: statusColor(status) }} />
              {status}
            </div>
          </div>
        </header>

        {error ? <div className="ttd-error">{error}</div> : null}

        <div className="ttd-layout">
          <div className="ttd-stack">
            <section style={panelStyle}>
              <h2 className="ttd-section-title">
                <Icon path="M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M15 15h1 M17 15h3 M15 17h5 M15 19h2 M19 19h1" />
                Session
              </h2>
              <div className="ttd-action-row">
                <button className="ttd-btn primary" onClick={() => setQrOpen(true)} disabled={!sessionInfo}>
                  Show QR
                </button>
                <button className="ttd-btn" onClick={spawnEnemyForTesting}>
                  Spawn Random Monster
                </button>
                <button
                  className="ttd-btn"
                  onClick={() => {
                    unlockAudio();
                    playHitSound();
                  }}
                >
                  Test Hit Sound
                </button>
              </div>
              <div style={{ marginTop: 10 }}>
                <span className="ttd-pill">SFX: {audioReady ? "ready" : "tap once to enable"}</span>
              </div>
            </section>

            <section style={panelStyle}>
              <h2 className="ttd-section-title">
                <Icon path="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M8.5 7a4 4 0 1 0 0 .01 M20 8v6 M17 11h6" />
                Players
                <span className="ttd-pill">{heroes.length} heroes</span>
              </h2>
              {publicState?.seats ? (
                <ul className="ttd-players">
                  {publicState.seats.map((seat) => (
                    <li key={seat.seat} className="ttd-player">
                      <div>
                        <span className="ttd-seat">Seat {seat.seat}</span>
                        <span className="ttd-name" style={{ opacity: seat.occupied ? 1 : 0.5 }}>
                          {seat.occupied ? seat.playerName : "Empty"}
                        </span>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        {seat.playerId && activePlayerId === seat.playerId ? <span className="ttd-pill">Active</span> : null}
                        {seat.occupied && seat.playerId ? (
                          <button className="ttd-btn warn" onClick={() => kickPlayer(seat.playerId, seat.playerName)}>
                            Kick
                          </button>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p style={{ margin: 0, color: "#5d7082" }}>Waiting for players...</p>
              )}
            </section>

            <section style={panelStyle}>
              <h2 className="ttd-section-title">
                <Icon path="M4 20l8-16 8 16 M7 14h10" />
                Encounter
              </h2>
              {game ? (
                <div className="ttd-stat-grid">
                  <div className="ttd-stat">
                    <label>Enemies Alive</label>
                    <strong style={mono}>{enemyCount}</strong>
                  </div>
                  <div className="ttd-stat">
                    <label>HP Display</label>
                    <strong style={mono}>On Board</strong>
                  </div>
                </div>
              ) : (
                <p style={{ margin: 0, color: "#5d7082" }}>No encounter yet.</p>
              )}
            </section>

            <section style={panelStyle}>
              <h2 className="ttd-section-title">
                <Icon path="M9 11l3 3L22 4 M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
                Event Log
              </h2>
              {log.length ? (
                <ul className="ttd-log">
                  {log
                    .slice()
                    .reverse()
                    .map((entry, idx) => (
                      <li key={idx}>{entry.msg}</li>
                    ))}
                </ul>
              ) : (
                <p style={{ margin: 0, color: "#5d7082" }}>No events yet.</p>
              )}
            </section>
          </div>

          <section
            style={{
              ...panelStyle,
              border: "1px solid rgba(15, 143, 147, 0.24)",
              boxShadow: "0 22px 48px rgba(7, 31, 54, 0.16)"
            }}
            className="ttd-board-shell"
          >
            <div className="ttd-board-head">
              <h2 className="ttd-section-title" style={{ marginBottom: 0 }}>
                <Icon path="M3 6h18 M3 12h18 M3 18h18 M6 3v18 M12 3v18 M18 3v18" />
                Board
              </h2>
              <span className="ttd-pill">Live View</span>
            </div>
            <div className="ttd-board-scroll">
              <div
                style={{
                  position: "relative",
                  width: (grid.w - 1) * (HEX_SIZE * 1.5) + HEX_SIZE * 2,
                  height: grid.h * HEX_H + HEX_H / 2,
                  margin: "0 auto",
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

                    const label = heroHere ? heroGlyph(heroHere) : isEnemy ? "EN" : "";
                    const isMoveOption = moveOptions.has(`${x},${y}`);
                    const isHitCell = tableHitFx && tableHitFx.x === x && tableHitFx.y === y;

                    const bg = isEnemy
                      ? "rgba(245, 72, 72, 0.18)"
                      : isActiveCell
                        ? "rgba(18, 158, 117, 0.19)"
                        : "rgba(255, 255, 255, 0.9)";

                    const stroke = isActiveCell ? "rgba(7, 48, 33, 0.6)" : "rgba(18, 36, 58, 0.2)";
                    const strokeWidth = isActiveCell ? 2 : 1;

                    return (
                      <div
                        key={`${x},${y}`}
                        onClick={() => {
                          if (isEnemy) setEnemyInspectOpen(true);
                        }}
                        title={isEnemy ? "Show enemy details" : undefined}
                        style={{
                          position: "absolute",
                          left,
                          top,
                          width: HEX_W,
                          height: HEX_H,
                          pointerEvents: isEnemy ? "auto" : "none",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          userSelect: "none",
                          fontSize: 12,
                          padding: 6,
                          color: "#123355",
                          fontWeight: 800,
                          cursor: isEnemy ? "pointer" : "default"
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
                              stroke="rgba(15, 143, 147, 0.44)"
                              strokeWidth="3"
                            />
                          ) : null}
                          {isHitCell ? (
                            <polygon
                              points={`${HEX_W * 0.25},0 ${HEX_W * 0.75},0 ${HEX_W},${HEX_H * 0.5} ${HEX_W * 0.75},${HEX_H} ${HEX_W * 0.25},${HEX_H} 0,${HEX_H * 0.5}`}
                              fill="none"
                              stroke="rgba(203, 60, 60, 0.88)"
                              strokeWidth="4"
                              style={{ transformOrigin: "50% 50%", animation: "tvHitPulse 0.65s ease-out forwards" }}
                            />
                          ) : null}
                        </svg>
                        <div style={{ position: "relative", textAlign: "center", lineHeight: 1.05 }}>
                          <div>{label}</div>
                        </div>
                        {isHitCell ? (
                          <div
                            style={{
                              position: "absolute",
                              top: -8,
                              padding: "2px 8px",
                              borderRadius: 999,
                              background: "rgba(255,255,255,0.95)",
                              border: "1px solid rgba(210, 30, 30, 0.25)",
                              color: "#c21f1f",
                              fontWeight: 800,
                              animation: "tvHitFloat 0.9s ease-out forwards"
                            }}
                          >
                            -{tableHitFx.amount}
                          </div>
                        ) : null}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </section>
        </div>
      </div>

      {enemyInspectOpen ? (
        <div className="ttd-modal-backdrop" onClick={() => setEnemyInspectOpen(false)}>
          <div className="ttd-modal" onClick={(e) => e.stopPropagation()}>
            {viewedEnemy ? (
              <>
                <div className="ttd-enemy-art">{viewedEnemy.art}</div>
                <h3 style={{ marginTop: 0, marginBottom: 8 }}>{viewedEnemy.name}</h3>
                <div className="ttd-stat-grid" style={{ marginBottom: 10 }}>
                  <div className="ttd-stat">
                    <label>HP</label>
                    <strong style={mono}>{viewedEnemy.hp}</strong>
                  </div>
                  <div className="ttd-stat">
                    <label>Attack Power</label>
                    <strong style={{ ...mono, color: "#c33939" }}>{viewedEnemy.attackPower}</strong>
                  </div>
                </div>
                <p style={{ margin: 0, color: "#425a70" }}>{viewedEnemy.flavor}</p>
              </>
            ) : (
              <p style={{ margin: 0, color: "#5d7082" }}>Enemy details unavailable.</p>
            )}
          </div>
        </div>
      ) : null}

      {kickPrompt ? (
        <div className="ttd-modal-backdrop" onClick={() => setKickPrompt(null)}>
          <div className="ttd-modal" onClick={(e) => e.stopPropagation()}>
            <div className="ttd-modal-head">
              <h3>Kick Player?</h3>
            </div>
            <p style={{ marginTop: 0, marginBottom: 14, color: "#425a70" }}>
              Remove <strong>{kickPrompt.playerName}</strong> from this session?
            </p>
            <div className="ttd-action-row" style={{ justifyContent: "flex-end" }}>
              <button className="ttd-btn" onClick={() => setKickPrompt(null)}>
                Cancel
              </button>
              <button className="ttd-btn danger" onClick={confirmKickPlayer}>
                Kick Player
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {qrOpen ? (
        <div className="ttd-modal-backdrop" onClick={() => setQrOpen(false)}>
          <div className="ttd-modal" onClick={(e) => e.stopPropagation()}>
            {joinUrl ? (
              <div className="ttd-qr-wrap">
                <QRCodeCanvas value={joinUrl} size={280} includeMargin />
              </div>
            ) : (
              <div className="ttd-qr-wrap">
                <p style={{ margin: 0, color: "#5d7082" }}>Waiting for session QR...</p>
              </div>
            )}

          </div>
        </div>
      ) : null}
    </div>
  );
}

const CATAN_ROW_LENGTHS = [4, 5, 6, 6, 5, 4];
const CATAN_RESOURCES = [
  "wood", "wood", "wood", "wood", "wood", "wood",
  "brick", "brick", "brick", "brick", "brick",
  "sheep", "sheep", "sheep", "sheep", "sheep", "sheep",
  "wheat", "wheat", "wheat", "wheat", "wheat", "wheat",
  "ore", "ore", "ore", "ore", "ore",
  "desert", "desert"
];
const CATAN_NUMBERS = [2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 6, 8, 8, 8, 9, 9, 9, 10, 10, 10, 11, 11, 11, 12, 12];
const BARBARIAN_TRACK_STEPS = ["Sea", "Approach", "Near", "Sighting", "Alarm", "Coast", "Attack"];
const BARBARIAN_TRACK_NODE_LAYOUT = [
  { x: 20, y: 16 },
  { x: 47, y: 16 },
  { x: 74, y: 16 },
  { x: 47, y: 44 },
  { x: 20, y: 76 },
  { x: 47, y: 76 },
  { x: 74, y: 76 }
];
const BARBARIAN_TRACK_ARROWS = [
  { x: 33.5, y: 16, rot: 0 },
  { x: 60.5, y: 16, rot: 0 },
  { x: 60.5, y: 30, rot: 120 },
  { x: 33.5, y: 60, rot: 130 },
  { x: 33.5, y: 76, rot: 0 },
  { x: 60.5, y: 76, rot: 0 }
];

const CATAN_RESOURCE_META = {
  wood: { label: "Forest", color: "#2f6d45", texture: forestTexture },
  brick: { label: "Hills", color: "#b86a4a", texture: hillsTexture },
  sheep: { label: "Pasture", color: "#b7df70", texture: pastureTexture },
  wheat: { label: "Fields", color: "#d8b454", texture: wheatTexture },
  ore: { label: "Mountains", color: "#7d8899", texture: mountainsTexture },
  desert: { label: "Desert", color: "#d0bc96", texture: desertTexture }
};

function shuffled(list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function generateCatanBoardLayout() {
  const resources = shuffled(CATAN_RESOURCES);
  const numbers = shuffled(CATAN_NUMBERS);
  let numberIdx = 0;

  return CATAN_ROW_LENGTHS.flatMap((count, row) =>
    Array.from({ length: count }).map((_, col) => {
      const resource = resources.shift();
      const isDesert = resource === "desert";
      return {
        id: `tile-${row}-${col}`,
        row,
        col,
        resource,
        number: isDesert ? null : numbers[numberIdx++]
      };
    })
  );
}

function CatanTableView({ onBackToMenu }) {
  const [tiles, setTiles] = useState(() => generateCatanBoardLayout());
  const [selectedAction, setSelectedAction] = useState("");
  const [barbarianStep, setBarbarianStep] = useState(0);
  const lowerRowStart = Math.floor(CATAN_ROW_LENGTHS.length / 2);

  const tilesByRow = CATAN_ROW_LENGTHS.map((_, row) => tiles.filter((tile) => tile.row === row));

  function resetBoard() {
    setTiles(generateCatanBoardLayout());
  }

  function handleBoardAction(action) {
    if (action === "reset-board") {
      resetBoard();
    } else if (action === "barbarian-back") {
      setBarbarianStep((step) => Math.max(0, step - 1));
    } else if (action === "barbarian-forward") {
      setBarbarianStep((step) => Math.min(BARBARIAN_TRACK_STEPS.length - 1, step + 1));
    } else if (action === "barbarian-reset") {
      setBarbarianStep(0);
    }
    setSelectedAction("");
  }

  return (
    <div className="ttc-root">
      <style>{`
        :root {
          --ttc-ink: #12283c;
          --ttc-sub: #587288;
          --ttc-border: rgba(16, 35, 52, 0.14);
          --ttc-sea-1: #cbe7f5;
          --ttc-sea-2: #dff2ff;
        }
        html, body, #root {
          margin: 0;
          width: 100%;
          min-height: 100%;
        }
        body {
          background: linear-gradient(160deg, #edf8ff 0%, #dbeefc 56%, #e7f4f5 100%);
        }
        .ttc-root {
          min-height: 100dvh;
          box-sizing: border-box;
          padding: 16px;
          color: var(--ttc-ink);
          font-family: "Avenir Next", "Segoe UI", "Helvetica Neue", sans-serif;
          background:
            radial-gradient(circle at 10% 0%, rgba(40, 151, 184, 0.2), transparent 36%),
            radial-gradient(circle at 90% 0%, rgba(64, 180, 130, 0.17), transparent 40%),
            linear-gradient(160deg, #f7fcff 0%, #ebf4fb 54%, #edf7f4 100%);
        }
        .ttc-shell {
          width: 100%;
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .ttc-header {
          border: 1px solid var(--ttc-border);
          border-radius: 18px;
          background: linear-gradient(135deg, rgba(255,255,255,0.9), rgba(255,255,255,0.74));
          box-shadow: 0 16px 38px rgba(7, 28, 46, 0.12);
          padding: 12px 14px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          flex-wrap: wrap;
        }
        .ttc-title {
          margin: 0;
          font-size: clamp(1.2rem, 2.8vw, 1.9rem);
          letter-spacing: 0.2px;
        }
        .ttc-subtext {
          margin: 4px 0 0;
          color: var(--ttc-sub);
          font-weight: 600;
          font-size: 0.9rem;
        }
        .ttc-head-actions {
          display: flex;
          gap: 8px;
          align-items: center;
          flex-wrap: wrap;
        }
        .ttc-btn {
          border: 1px solid rgba(18, 36, 58, 0.16);
          background: #ffffff;
          color: var(--ttc-ink);
          border-radius: 10px;
          font-weight: 700;
          padding: 8px 12px;
          cursor: pointer;
        }
        .ttc-pill {
          border-radius: 999px;
          border: 1px solid rgba(18, 36, 58, 0.14);
          background: rgba(255,255,255,0.8);
          padding: 4px 10px;
          font-size: 0.8rem;
          font-weight: 700;
          color: #426178;
        }
        .ttc-select {
          border: 1px solid rgba(18, 36, 58, 0.18);
          background: #ffffff;
          color: #12314a;
          border-radius: 10px;
          font-weight: 700;
          padding: 8px 34px 8px 10px;
          cursor: pointer;
          min-width: 170px;
        }
        .ttc-board-wrap {
          border: 1px solid var(--ttc-border);
          border-radius: 20px;
          background: linear-gradient(180deg, rgba(235, 247, 253, 0.9), rgba(205, 231, 245, 0.88));
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.8), 0 20px 44px rgba(9, 32, 52, 0.16);
          user-select: none;
          padding: clamp(10px, 2.4vw, 18px);
          position: relative;
        }
        .ttc-island-shell {
          width: min(100%, 1100px);
          margin: 0 auto;
          box-sizing: border-box;
          padding-right: clamp(180px, 26vw, 330px);
        }
        .ttc-board {
          --ttc-tile-w: clamp(82px, 9.2vw, 128px);
          --ttc-tile-h: clamp(92px, 11vw, 148px);
          display: flex;
          flex-direction: column;
          align-items: center;
          max-width: 1200px;
          margin: 0 auto 0 0;
        }
        .ttc-row {
          display: flex;
          justify-content: center;
        }
        .ttc-row + .ttc-row {
          margin-top: calc(var(--ttc-tile-h) * -0.25);
        }
        .ttc-tile {
          width: var(--ttc-tile-w);
          height: var(--ttc-tile-h);
          clip-path: polygon(50% 2%, 98% 25%, 98% 75%, 50% 98%, 2% 75%, 2% 25%);
          border: 2px solid rgba(35, 41, 49, 0.25);
          box-shadow: inset 0 2px 8px rgba(255,255,255,0.35), 0 10px 14px rgba(6, 18, 31, 0.18);
          position: relative;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .ttc-number {
          width: clamp(42px, 5.3vw, 68px);
          height: clamp(42px, 5.3vw, 68px);
          border-radius: 50%;
          background: rgba(246, 239, 217, 0.74);
          border: 2px solid rgba(92, 78, 47, 0.26);
          box-shadow: 0 3px 7px rgba(53, 43, 20, 0.25);
          display: grid;
          place-items: center;
          font-weight: 900;
          font-size: clamp(1.15rem, 2vw, 1.9rem);
          letter-spacing: 0.2px;
          color: #2c3139;
          z-index: 2;
        }
        .ttc-number.hot {
          color: #b02f2f;
        }
        .ttc-desert {
          font-size: clamp(0.56rem, 1vw, 0.75rem);
          font-weight: 900;
          letter-spacing: 0.7px;
          text-transform: uppercase;
          color: rgba(46, 41, 26, 0.74);
        }
        .ttc-track {
          border: none;
          border-radius: 0;
          background: transparent;
          box-shadow: none;
          padding: 0;
          overflow: visible;
          position: absolute;
          right: clamp(8px, 1.6vw, 16px);
          bottom: clamp(8px, 1.6vw, 16px);
          width: min(40vw, 390px);
          z-index: 4;
        }
        .ttc-track-board {
          position: relative;
          margin-top: 0;
          min-height: 360px;
          border-radius: 22px;
          border: 1px solid rgba(26, 93, 126, 0.35);
          background:
            radial-gradient(circle at 18% 10%, rgba(255,255,255,0.35), rgba(255,255,255,0) 45%),
            repeating-linear-gradient(-14deg, rgba(255,255,255,0.1) 0 8px, rgba(255,255,255,0) 8px 20px),
            linear-gradient(165deg, #42a3cf 0%, #2184b2 45%, #1c6f98 100%);
          box-shadow: inset 0 2px 0 rgba(255,255,255,0.35), inset 0 -8px 16px rgba(15, 53, 75, 0.24);
        }
        .ttc-track-node {
          position: absolute;
          width: 72px;
          height: 72px;
          transform: translate(-50%, -50%);
          border-radius: 50%;
          border: 3px solid rgba(216, 238, 248, 0.88);
          background: rgba(255, 255, 255, 0.2);
          display: grid;
          place-items: center;
          backdrop-filter: blur(2px);
          box-shadow: inset 0 0 0 1px rgba(12, 69, 95, 0.2);
          color: rgba(17, 53, 75, 0.9);
          z-index: 2;
        }
        .ttc-track-node.done {
          background: rgba(255, 255, 255, 0.36);
          border-color: rgba(228, 245, 252, 0.95);
        }
        .ttc-track-node.active {
          border-color: rgba(228, 245, 252, 0.95);
          background: rgba(255, 255, 255, 0.36);
          box-shadow: inset 0 0 0 1px rgba(12, 69, 95, 0.2);
        }
        .ttc-track-node.attack {
          border-color: rgba(255, 230, 203, 0.95);
          background: radial-gradient(circle at 32% 22%, rgba(255, 185, 132, 0.62), rgba(255,255,255,0.3) 68%);
        }
        .ttc-track-icon {
          font-size: 1.65rem;
          line-height: 1;
          filter: drop-shadow(0 1px 1px rgba(0,0,0,0.25));
        }
        .ttc-track-arrow {
          position: absolute;
          transform: translate(-50%, -50%);
          color: rgba(240, 250, 255, 0.95);
          font-size: 1.55rem;
          font-weight: 800;
          text-shadow: 0 1px 2px rgba(15, 58, 82, 0.35);
          z-index: 1;
        }
        @media (max-width: 1100px) {
          .ttc-island-shell {
            padding-right: 0;
          }
          .ttc-board {
            margin: 0 auto;
          }
          .ttc-track {
            position: static;
            width: min(100%, 360px);
            margin: 10px auto 0;
          }
        }
      `}</style>

      <div className="ttc-shell">
        <header className="ttc-header">
          <div>
            <h1 className="ttc-title">Catan Table Board</h1>
            <p className="ttc-subtext">5-6 player island ring with Cities and Knights barbarian track.</p>
          </div>
          <div className="ttc-head-actions">
            <button className="ttc-btn" onClick={onBackToMenu}>Game Menu</button>
            <select
              className="ttc-select"
              aria-label="Board actions"
              value={selectedAction}
              onChange={(ev) => handleBoardAction(ev.target.value)}
            >
              <option value="">Board Actions</option>
              <option value="reset-board">Reset Board Layout</option>
              <option value="barbarian-back">Barbarian -1</option>
              <option value="barbarian-forward">Barbarian +1</option>
              <option value="barbarian-reset">Reset Barbarian</option>
            </select>
            <span className="ttc-pill">Barbarian: {barbarianStep}/{BARBARIAN_TRACK_STEPS.length - 1}</span>
            <span className="ttc-pill">GoDice integration: next</span>
          </div>
        </header>

        <main className="ttc-board-wrap">
          <div className="ttc-island-shell">
              <div className="ttc-board" aria-label="Catan board">
                {tilesByRow.map((rowTiles, rowIdx) => (
                  <div
                    className="ttc-row"
                    key={`row-${rowIdx}`}
                    style={rowIdx >= lowerRowStart ? { transform: "translateX(calc(var(--ttc-tile-w) * -0.5))" } : undefined}
                  >
                    {rowTiles.map((tile) => {
                      const meta = CATAN_RESOURCE_META[tile.resource] || CATAN_RESOURCE_META.desert;
                      const hotNumber = tile.number === 6 || tile.number === 8;

                      return (
                        <div
                          key={tile.id}
                          className="ttc-tile"
                          title={meta.label}
                          style={{
                            backgroundColor: meta.color,
                            backgroundImage: `linear-gradient(165deg, rgba(255,255,255,0.18), rgba(0,0,0,0.18)), url(${meta.texture})`,
                            backgroundSize: "cover",
                            backgroundPosition: "center"
                          }}
                        >
                          {typeof tile.number === "number" ? (
                            <div className={`ttc-number${hotNumber ? " hot" : ""}`}>{tile.number}</div>
                          ) : (
                            <div className="ttc-desert">No token</div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
          </div>

          <div className="ttc-track" aria-label="Cities and Knights barbarian track">
            <div className="ttc-track-board">
              {BARBARIAN_TRACK_ARROWS.map((arrow, idx) => (
                <div
                  key={`barb-arrow-${idx}`}
                  className="ttc-track-arrow"
                  style={{ left: `${arrow.x}%`, top: `${arrow.y}%`, transform: `translate(-50%, -50%) rotate(${arrow.rot}deg)` }}
                  aria-hidden="true"
                >
                  ➜
                </div>
              ))}
              {BARBARIAN_TRACK_STEPS.map((label, idx) => {
                const point = BARBARIAN_TRACK_NODE_LAYOUT[idx];
                const isAttack = idx === BARBARIAN_TRACK_STEPS.length - 1;
                return (
                  <div
                    key={`barb-node-${label}`}
                    className={`ttc-track-node${idx < barbarianStep ? " done" : ""}${idx === barbarianStep ? " active" : ""}${isAttack ? " attack" : ""}`}
                    title={label}
                    style={{ left: `${point.x}%`, top: `${point.y}%` }}
                  >
                    <span className="ttc-track-icon">{isAttack ? "🔥" : "⛵"}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

function GameMenu({ onOpenGame }) {
  return (
    <div className="ttg-root">
      <style>{`
        :root {
          --ttg-ink: #10263a;
          --ttg-sub: #597188;
          --ttg-border: rgba(20, 38, 60, 0.14);
          --ttg-card-bg: rgba(255, 255, 255, 0.8);
          --ttg-accent: #146f8f;
          --ttg-accent-2: #27a378;
        }
        html, body, #root {
          margin: 0;
          width: 100%;
          min-height: 100%;
        }
        body {
          background:
            radial-gradient(circle at 0% 0%, rgba(30, 130, 170, 0.18), transparent 40%),
            radial-gradient(circle at 100% 0%, rgba(42, 173, 117, 0.16), transparent 42%),
            linear-gradient(160deg, #f7fcff 0%, #eef4fa 46%, #eff7f3 100%);
        }
        .ttg-root {
          min-height: 100dvh;
          box-sizing: border-box;
          padding: clamp(16px, 3vw, 30px);
          color: var(--ttg-ink);
          font-family: "Avenir Next", "Segoe UI", "Helvetica Neue", sans-serif;
        }
        .ttg-shell {
          max-width: 1160px;
          margin: 0 auto;
          display: flex;
          flex-direction: column;
          gap: 18px;
        }
        .ttg-head {
          border: 1px solid var(--ttg-border);
          border-radius: 22px;
          background: linear-gradient(145deg, rgba(255, 255, 255, 0.92), rgba(255, 255, 255, 0.72));
          box-shadow: 0 24px 60px rgba(10, 34, 54, 0.14);
          padding: clamp(14px, 2.8vw, 24px);
        }
        .ttg-head h1 {
          margin: 0 0 6px;
          font-size: clamp(1.38rem, 3vw, 2.2rem);
          letter-spacing: 0.2px;
        }
        .ttg-head p {
          margin: 0;
          color: var(--ttg-sub);
          max-width: 680px;
          font-size: clamp(0.95rem, 1.8vw, 1.05rem);
        }
        .ttg-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
          gap: 14px;
        }
        .ttg-card {
          border: 1px solid var(--ttg-border);
          border-radius: 18px;
          background:
            linear-gradient(145deg, rgba(255, 255, 255, 0.95), var(--ttg-card-bg)),
            repeating-linear-gradient(-45deg, rgba(255,255,255,0.1) 0 10px, rgba(255,255,255,0) 10px 20px);
          box-shadow: 0 16px 34px rgba(10, 34, 54, 0.12);
          padding: 14px;
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .ttg-card h2 {
          margin: 0;
          font-size: 1.18rem;
        }
        .ttg-subtitle {
          margin: 0;
          color: var(--ttg-sub);
          font-weight: 700;
          font-size: 0.9rem;
          letter-spacing: 0.4px;
          text-transform: uppercase;
        }
        .ttg-desc {
          margin: 0;
          color: #38506a;
        }
        .ttg-tags {
          display: flex;
          flex-wrap: wrap;
          gap: 7px;
        }
        .ttg-tag {
          border-radius: 999px;
          border: 1px solid rgba(18, 36, 58, 0.14);
          background: rgba(255, 255, 255, 0.84);
          padding: 4px 10px;
          font-size: 0.78rem;
          font-weight: 700;
          color: #36516b;
        }
        .ttg-open {
          border: none;
          border-radius: 10px;
          background: linear-gradient(135deg, var(--ttg-accent), var(--ttg-accent-2));
          color: #fff;
          font-weight: 800;
          padding: 10px 12px;
          cursor: pointer;
        }
        .ttg-open:disabled {
          cursor: not-allowed;
          background: linear-gradient(135deg, #a2adbb, #7f8a99);
        }
      `}</style>

      <div className="ttg-shell">
        <header className="ttg-head">
          <h1>Table Game Library</h1>
          <p>Choose a game to launch on the table. Catan now runs as a table-only board so you can use physical pieces on top of the display.</p>
        </header>

        <section className="ttg-grid" aria-label="Table games">
          {TABLE_GAMES.map((game) => (
            <article className="ttg-card" key={game.id}>
              <div>
                <p className="ttg-subtitle">{game.subtitle}</p>
                <h2>{game.title}</h2>
              </div>
              <p className="ttg-desc">{game.description}</p>
              <div className="ttg-tags">
                {game.badges.map((badge) => (
                  <span key={badge} className="ttg-tag">{badge}</span>
                ))}
              </div>
              <button className="ttg-open" onClick={() => onOpenGame(game)} disabled={game.disabled}>
                {game.disabled ? "Coming Soon" : "Open on Table"}
              </button>
            </article>
          ))}
        </section>
      </div>
    </div>
  );
}

export default function App() {
  const [activeGameId, setActiveGameId] = useState(null);

  if (activeGameId === "touchtable-dungeon") {
    return <DungeonTableView onBackToMenu={() => setActiveGameId(null)} />;
  }
  if (activeGameId === "catan") {
    return <CatanTableView onBackToMenu={() => setActiveGameId(null)} />;
  }

  return (
    <GameMenu
      onOpenGame={(game) => {
        if (!game?.disabled) setActiveGameId(game.id);
      }}
    />
  );
}
