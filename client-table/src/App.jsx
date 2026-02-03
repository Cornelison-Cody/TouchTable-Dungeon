import React, { useEffect, useRef, useState } from "react";
import { QRCodeCanvas } from "qrcode.react";
import { MsgType, Role, makeMsg } from "../../shared/protocol.js";
import { ActionType, hexWithinRange } from "../../shared/game.js";

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

export default function App() {
  const [wsUrl] = useState(makeWsUrl());
  const [status, setStatus] = useState("disconnected");
  const [sessionInfo, setSessionInfo] = useState(null);
  const [publicState, setPublicState] = useState(null);
  const [error, setError] = useState(null);
  const [tableHitFx, setTableHitFx] = useState(null);
  const [audioReady, setAudioReady] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [kickPrompt, setKickPrompt] = useState(null);

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
  const apRemaining = game?.turn?.apRemaining ?? 0;
  const activeHero = heroes.find((h) => h.ownerPlayerId === activePlayerId) || null;
  const enemyHpText = enemy ? `${enemy.hp}/${enemy.maxHp}` : "-";

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

  const HEX_SIZE = 34;
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
        .ttd-subtitle {
          margin: 3px 0 0;
          color: var(--ttd-sub);
          font-size: 0.92rem;
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
          grid-template-columns: minmax(320px, 390px) minmax(0, 1fr);
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
        }
        .ttd-board-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
        }
        .ttd-board-scroll {
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
            <p className="ttd-subtitle">Table Console</p>
          </div>
          <div className="ttd-status">
            <span className="ttd-dot" style={{ background: statusColor(status) }} />
            {status}
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
                    <label>Active Hero</label>
                    <strong style={mono}>{activePlayerId ? activePlayerId.slice(0, 4) : "-"}</strong>
                  </div>
                  <div className="ttd-stat">
                    <label>Enemy HP</label>
                    <strong style={{ ...mono, color: "#c33939" }}>{enemyHpText}</strong>
                  </div>
                  <div className="ttd-stat">
                    <label>Heroes</label>
                    <strong style={mono}>{heroes.length}</strong>
                  </div>
                  <div className="ttd-stat">
                    <label>Round AP</label>
                    <strong style={mono}>{game.turn?.apRemaining ?? 0}</strong>
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

          <section style={panelStyle} className="ttd-board-shell">
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
                          fontSize: 12,
                          padding: 6,
                          color: "#123355",
                          fontWeight: 800
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
                        <div style={{ position: "relative", textAlign: "center", lineHeight: 1.1 }}>{label}</div>
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
