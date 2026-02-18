import React, { useEffect, useMemo, useRef, useState } from "react";
import { MsgType, Role, makeMsg } from "../../shared/protocol.js";
import { ActionType, hexNeighbors, manhattan, terrainAt } from "../../shared/game.js";

const theme = {
  bg: "#0f1722",
  card: "#142031",
  panel: "#1a293a",
  border: "#2a3e56",
  text: "#e6edf6",
  sub: "#98adc5",
  good: "#53d496",
  bad: "#ff7676",
  warn: "#f0c473",
  brand: "#1fbdb5"
};

const shell = {
  minHeight: "100vh",
  padding: 12,
  color: theme.text,
  background: "radial-gradient(circle at 10% -5%, #18283a, transparent 45%), #0d131b",
  fontFamily: "Avenir Next, Segoe UI, Helvetica Neue, sans-serif"
};

const card = {
  border: `1px solid ${theme.border}`,
  borderRadius: 14,
  padding: 10,
  marginBottom: 10,
  background: theme.card
};

const mono = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" };
const tabs = ["actions", "inventory", "crafting", "stats"];
const labels = { herb: "Herb", fang: "Fang", essence: "Essence", potion: "Potion" };

function getQuerySessionId() {
  const u = new URL(window.location.href);
  return u.searchParams.get("session");
}

function getQueryWsUrl() {
  const u = new URL(window.location.href);
  return u.searchParams.get("ws") || u.searchParams.get("wsUrl") || u.searchParams.get("server");
}

function defaultWsUrl() {
  const host = window.location.hostname || "localhost";
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return localStorage.getItem("tt_server_ws") || `${scheme}://${host}:3000`;
}

function pct(hp, maxHp) {
  const m = Math.max(1, Number(maxHp) || 1);
  return `${Math.max(0, Math.min(100, ((Number(hp) || 0) / m) * 100))}%`;
}

function recipeText(obj = {}) {
  return Object.entries(obj).map(([k, v]) => `${v} ${labels[k] || k}`).join(" + ");
}

function dropsText(obj = {}) {
  const parts = Object.entries(obj || {}).filter(([, v]) => Number(v) > 0).map(([k, v]) => `${v} ${labels[k] || k}`);
  return parts.length ? parts.join(" | ") : "None";
}

export default function App() {
  const initialWsUrl = useMemo(() => {
    const fromQuery = getQueryWsUrl();
    if (fromQuery) {
      localStorage.setItem("tt_server_ws", fromQuery);
      return fromQuery;
    }
    return defaultWsUrl();
  }, []);

  const [wsUrl, setWsUrl] = useState(initialWsUrl);
  const [status, setStatus] = useState("disconnected");
  const [error, setError] = useState(null);
  const [clientId, setClientId] = useState(null);

  const [playerName, setPlayerName] = useState(localStorage.getItem("tt_player_name") || "");
  const [seat, setSeat] = useState(1);
  const [joined, setJoined] = useState(false);
  const [player, setPlayer] = useState(null);
  const [privateState, setPrivateState] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [tab, setTab] = useState("actions");

  const [attackTarget, setAttackTarget] = useState("");
  const [spellTarget, setSpellTarget] = useState("");
  const [reviveTarget, setReviveTarget] = useState("");

  const [hitFx, setHitFx] = useState(null);
  const [incomingFx, setIncomingFx] = useState(null);
  const [lootFx, setLootFx] = useState(null);

  const resumeToken = useMemo(() => localStorage.getItem("tt_resume_token") || "", []);
  const sessionId = useMemo(() => getQuerySessionId() || "", []);

  const wsRef = useRef(null);
  const seenHit = useRef(0);
  const seenIncoming = useRef(0);
  const seenLoot = useRef(0);

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
        if (msg.t === MsgType.OK && msg.id === "hello-phone") setClientId(msg.payload?.clientId ?? null);
        if (msg.t === MsgType.OK && msg.id === "join") {
          const token = msg.payload?.resumeToken;
          if (token) localStorage.setItem("tt_resume_token", token);
          if (msg.payload?.seat) setJoined(true);
        }
        if (msg.t === MsgType.STATE_PRIVATE) {
          const st = msg.payload?.state ?? null;
          setPrivateState(st);
          if (st?.player) {
            setJoined(true);
            setPlayer(st.player);
          } else {
            setJoined(false);
            setPlayer(null);
          }
        }
        if (msg.t === MsgType.ERROR) {
          const m = msg.payload?.message ?? "Unknown error";
          const sn = msg.payload?.snippet;
          if (msg.payload?.code === "KICKED" || msg.payload?.code === "CAMPAIGN_RESET") {
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
      try {
        ws.close();
      } catch {
        // ignore
      }
    };
  }, [wsUrl, resumeToken, sessionId]);

  function reconnect() {
    localStorage.setItem("tt_server_ws", wsUrl);
    setWsUrl(wsUrl.trim());
    setMenuOpen(false);
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

  function sendMove(x, y) {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return setError("Not connected to server.");
    ws.send(JSON.stringify(makeMsg(MsgType.ACTION, { action: ActionType.MOVE, params: { toX: x, toY: y } }, "move")));
  }

  function sendAction(action, params = {}) {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return setError("Not connected to server.");
    ws.send(JSON.stringify(makeMsg(MsgType.ACTION, { action, params }, "act")));
  }

  const g = privateState?.game || null;
  const active = Boolean(g?.youAreActive);
  const hero = g?.hero || null;
  const rules = g?.rules || {};
  const apRemaining = g?.apRemaining ?? 0;
  const apMax = g?.apMax ?? 4;
  const allowed = new Set(g?.allowedActions || []);
  const rpg = g?.rpg || null;
  const inventory = rpg?.inventory || {};
  const heroesPublic = g?.heroesPublic || [];
  const reviveTargets = g?.reviveTargets || [];
  const spellName = rpg?.spell?.name || "Arc Bolt";
  const attackRange = Math.max(1, Number(rules.attackRange) || 1);
  const spellRange = Math.max(1, Number(rpg?.spell?.range) || Number(rules.spellRange) || 3);
  const craftingOptions = Array.isArray(g?.craftingOptions) ? g.craftingOptions : [];

  const enemies = g?.enemies || (g?.enemy ? [g.enemy] : []);
  const visibleEnemies = hero ? enemies.filter((e) => e && e.hp > 0 && manhattan(hero, e) <= 8) : [];
  const attackable = hero ? visibleEnemies.filter((e) => manhattan(hero, e) <= attackRange) : [];
  const spellable = hero ? visibleEnemies.filter((e) => manhattan(hero, e) <= spellRange) : [];

  useEffect(() => {
    setAttackTarget((curr) => (attackable.some((e) => e.id === curr) ? curr : attackable[0]?.id || ""));
  }, [attackable]);
  useEffect(() => {
    setSpellTarget((curr) => (spellable.some((e) => e.id === curr) ? curr : spellable[0]?.id || ""));
  }, [spellable]);
  useEffect(() => {
    setReviveTarget((curr) => (reviveTargets.some((e) => e.playerId === curr) ? curr : reviveTargets[0]?.playerId || ""));
  }, [reviveTargets]);

  useEffect(() => {
    const hit = g?.lastHeroDamage;
    if (!hit?.at || hit.at <= seenHit.current) return;
    seenHit.current = hit.at;
    setHitFx(hit);
    const t = setTimeout(() => setHitFx((v) => (v?.at === hit.at ? null : v)), 1200);
    return () => clearTimeout(t);
  }, [g]);
  useEffect(() => {
    const dmg = g?.lastEnemyDamage;
    if (!dmg?.at || dmg.at <= seenIncoming.current) return;
    seenIncoming.current = dmg.at;
    setIncomingFx(dmg);
    const t = setTimeout(() => setIncomingFx((v) => (v?.at === dmg.at ? null : v)), 3900);
    return () => clearTimeout(t);
  }, [g]);
  useEffect(() => {
    const loot = g?.lastLoot;
    if (!loot?.at || loot.at <= seenLoot.current) return;
    seenLoot.current = loot.at;
    setLootFx(loot);
    const t = setTimeout(() => setLootFx((v) => (v?.at === loot.at ? null : v)), 7800);
    return () => clearTimeout(t);
  }, [g]);

  const terrainSeed = g?.terrain?.seed ?? 0;
  const occupied = new Set();
  for (const h of heroesPublic) if (h.hp > 0) occupied.add(`${h.x},${h.y}`);
  for (const e of visibleEnemies) occupied.add(`${e.x},${e.y}`);
  const lootByCell = new Map((g?.groundLoot || []).map((l) => [`${l.x},${l.y}`, l]));
  const canMove = allowed.has(ActionType.MOVE) && active && apRemaining > 0;
  const neighbors = active && hero && hero.hp > 0
    ? hexNeighbors(hero.x, hero.y).map((c) => {
        const t = terrainAt(c.x, c.y, terrainSeed);
        return { ...c, t, loot: lootByCell.get(`${c.x},${c.y}`) || null, canMove: canMove && t.passable && !occupied.has(`${c.x},${c.y}`) };
      })
    : [];

  const W = 72;
  const H = 60;
  const P = `${W * 0.25},0 ${W * 0.75},0 ${W},${H * 0.5} ${W * 0.75},${H} ${W * 0.25},${H} 0,${H * 0.5}`;
  const topBadge = status === "connected" ? theme.good : status === "error" ? theme.bad : theme.sub;

  return (
    <div style={shell}>
      <div style={{ maxWidth: 720, margin: "0 auto", paddingBottom: joined ? 82 : 8 }}>
        <div style={{ ...card, position: "relative", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <strong>Dungeon Phone</strong>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span style={{ ...mono, color: topBadge, fontSize: 11 }}>{status}</span>
            <button onClick={() => setMenuOpen((v) => !v)} style={{ borderRadius: 8, border: `1px solid ${theme.border}`, background: theme.panel, color: theme.text }}>...</button>
          </div>
          {menuOpen ? (
            <div style={{ position: "absolute", top: 42, right: 0, left: 0, zIndex: 10, ...card, margin: 0 }}>
              <div style={{ display: "flex", gap: 8 }}>
                <input value={wsUrl} onChange={(e) => setWsUrl(e.target.value)} style={{ flex: 1, padding: 8, borderRadius: 8, border: `1px solid ${theme.border}`, background: theme.panel, color: theme.text }} />
                <button onClick={reconnect} style={{ background: theme.brand, color: "#07201f", border: "none", borderRadius: 8, padding: "8px 10px", fontWeight: 700 }}>Reconnect</button>
              </div>
            </div>
          ) : null}
        </div>

        {!joined ? (
          <div style={card}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 100px", gap: 8 }}>
              <input value={playerName} placeholder="Your name" onChange={(e) => setPlayerName(e.target.value)} style={{ padding: 10, borderRadius: 8, border: `1px solid ${theme.border}`, background: theme.panel, color: theme.text }} />
              <input type="number" min="1" max="6" value={seat} onChange={(e) => setSeat(e.target.value)} style={{ padding: 10, borderRadius: 8, border: `1px solid ${theme.border}`, background: theme.panel, color: theme.text }} />
            </div>
            <button onClick={doJoin} style={{ width: "100%", marginTop: 8, background: theme.brand, color: "#07201f", border: "none", borderRadius: 8, padding: 10, fontWeight: 800 }}>Enter Dungeon</button>
          </div>
        ) : (
          <>
            <div style={{ ...card, position: "sticky", top: 8, zIndex: 6, background: "rgba(20, 32, 49, 0.97)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <div>
                  <div style={{ fontWeight: 800 }}>{player?.playerName || "Player"}</div>
                  <div style={{ marginTop: 3, fontSize: 12, color: theme.sub }}>HP {hero ? `${hero.hp}/${hero.maxHp}` : "-"} | AP {apRemaining}/{apMax} | Lv {rpg?.level || "-"}</div>
                </div>
                <button disabled={!active || !allowed.has(ActionType.END_TURN)} onClick={() => sendAction(ActionType.END_TURN)} style={{ border: "none", borderRadius: 8, padding: "8px 10px", fontWeight: 800, background: !active ? "#314255" : "#d18d2f", color: !active ? "#9fb1c5" : "#2a1908" }}>
                  End Turn
                </button>
              </div>
            </div>

            {hitFx ? <div style={{ ...card, borderColor: "#6b3a3a", color: "#ffd6d6" }}>Hit for {hitFx.amount}. Enemy {hitFx.enemyHp}/{hitFx.enemyMaxHp}</div> : null}
            {incomingFx ? <div style={{ ...card, borderColor: "#6b3a3a", color: "#ffd6d6" }}>You were hit for {incomingFx.amount}. HP {incomingFx.heroHp}/{incomingFx.heroMaxHp}</div> : null}

            {tab === "actions" ? (
              <>
                <div style={card}>
                  <div style={{ color: theme.sub, fontSize: 12, marginBottom: 6 }}>Move on green. Red hex attacks adjacent enemy.</div>
                  <div style={{ position: "relative", width: 264, height: 220, margin: "0 auto" }}>
                    <div style={{ position: "absolute", left: 96, top: 80, width: W, height: H, display: "grid", placeItems: "center", fontWeight: 800 }}>YOU</div>
                    {neighbors.map((c) => {
                      const xStep = W * 0.75;
                      const yStep = H;
                      const left = 96 + (c.x - hero.x) * xStep;
                      const top = 80 + (c.y - hero.y) * yStep + ((c.x % 2 ? yStep / 2 : 0) - (hero.x % 2 ? yStep / 2 : 0));
                      const enemy = visibleEnemies.find((e) => e.x === c.x && e.y === c.y) || null;
                      const canAttack = Boolean(enemy && active && allowed.has(ActionType.ATTACK));
                      const tap = c.canMove || canAttack;
                      const bg = enemy ? "#472731" : c.canMove ? "#1b3b2a" : c.t.passable ? c.t.fill : "#1d2734";
                      const stroke = enemy ? "#c57784" : c.canMove ? "#5cb882" : c.t.stroke;
                      return (
                        <button key={`${c.x},${c.y}`} disabled={!tap} onClick={() => (canAttack ? sendAction(ActionType.ATTACK, { targetEnemyId: enemy.id }) : sendMove(c.x, c.y))} style={{ position: "absolute", left, top, width: W, height: H, border: "none", background: "transparent", padding: 0, cursor: tap ? "pointer" : "default", color: enemy ? theme.bad : c.canMove ? theme.good : theme.sub, fontWeight: 800, fontSize: 11 }}>
                          <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}><polygon points={P} fill={bg} stroke={stroke} strokeWidth="1.2" /></svg>
                          <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
                            <div>{enemy ? "EN" : c.canMove ? "GO" : ""}</div>
                            {enemy ? <div style={{ fontSize: 9 }}>{enemy.hp}/{enemy.maxHp}</div> : null}
                            {c.loot && c.canMove ? <div style={{ marginTop: 1, fontSize: 10 }}>[]</div> : null}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div style={card}>
                  <div style={{ marginBottom: 8, fontWeight: 700 }}>Targets (only monsters within 8 hexes shown)</div>
                  <div style={{ display: "grid", gap: 6, marginBottom: 8 }}>
                    {visibleEnemies.length ? visibleEnemies.map((e) => (
                      <div key={e.id} style={{ border: `1px solid ${theme.border}`, borderRadius: 8, padding: 7, background: theme.panel }}>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                          <strong>{e.name} {e.level ? `(Lv ${e.level})` : ""}</strong>
                          <span style={mono}>{e.hp}/{e.maxHp}</span>
                        </div>
                        <div style={{ marginTop: 4, height: 6, borderRadius: 99, overflow: "hidden", border: `1px solid ${theme.border}`, background: "#0e141c" }}>
                          <div style={{ width: pct(e.hp, e.maxHp), height: "100%", background: "linear-gradient(90deg,#ff9a9a,#ff5757)" }} />
                        </div>
                        <div style={{ marginTop: 3, fontSize: 11, color: theme.sub }}>Distance {hero ? manhattan(hero, e) : "?"}</div>
                      </div>
                    )) : <div style={{ color: theme.sub }}>No monsters in range.</div>}
                  </div>

                  <div style={{ fontSize: 12, color: theme.sub }}>Weapon target (range {attackRange})</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 5 }}>
                    {attackable.map((e) => <button key={e.id} onClick={() => setAttackTarget(e.id)} style={{ padding: "5px 8px", borderRadius: 8, border: `1px solid ${attackTarget === e.id ? "#cc7784" : theme.border}`, background: attackTarget === e.id ? "#5a2e38" : theme.panel, color: attackTarget === e.id ? "#ffe0e6" : theme.sub }}>{e.name}</button>)}
                    {!attackable.length ? <span style={{ color: theme.sub, fontSize: 12 }}>No melee targets.</span> : null}
                  </div>
                  <button disabled={!active || !allowed.has(ActionType.ATTACK) || !attackTarget} onClick={() => sendAction(ActionType.ATTACK, { targetEnemyId: attackTarget })} style={{ width: "100%", marginTop: 6, border: "none", borderRadius: 8, padding: 9, fontWeight: 800, background: "#a03d4f", color: "#ffeef1" }}>
                    Attack
                  </button>

                  <div style={{ fontSize: 12, color: theme.sub, marginTop: 8 }}>Spell target (range {spellRange})</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 5 }}>
                    {spellable.map((e) => <button key={e.id} onClick={() => setSpellTarget(e.id)} style={{ padding: "5px 8px", borderRadius: 8, border: `1px solid ${spellTarget === e.id ? "#6fa5e5" : theme.border}`, background: spellTarget === e.id ? "#2a4d7f" : theme.panel, color: spellTarget === e.id ? "#e2efff" : theme.sub }}>{e.name}</button>)}
                    {!spellable.length ? <span style={{ color: theme.sub, fontSize: 12 }}>No spell targets.</span> : null}
                  </div>
                  <button disabled={!active || !allowed.has(ActionType.CAST_SPELL) || !spellTarget} onClick={() => sendAction(ActionType.CAST_SPELL, { targetEnemyId: spellTarget })} style={{ width: "100%", marginTop: 6, border: "none", borderRadius: 8, padding: 9, fontWeight: 800, background: "#3a6fb7", color: "#edf5ff" }}>
                    Cast {spellName}
                  </button>

                  <div style={{ fontSize: 12, color: theme.sub, marginTop: 8 }}>Revive</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 5 }}>
                    {reviveTargets.map((t) => <button key={t.playerId} onClick={() => setReviveTarget(t.playerId)} style={{ padding: "5px 8px", borderRadius: 8, border: `1px solid ${reviveTarget === t.playerId ? "#8ac56f" : theme.border}`, background: reviveTarget === t.playerId ? "#32582a" : theme.panel, color: reviveTarget === t.playerId ? "#e3f7d9" : theme.sub }}>{t.playerName || "Ally"} ({t.distance})</button>)}
                    {!reviveTargets.length ? <span style={{ color: theme.sub, fontSize: 12 }}>No downed ally in range.</span> : null}
                  </div>
                  <button disabled={!active || !allowed.has(ActionType.REVIVE) || !reviveTarget} onClick={() => sendAction(ActionType.REVIVE, { targetPlayerId: reviveTarget })} style={{ width: "100%", marginTop: 6, border: "none", borderRadius: 8, padding: 9, fontWeight: 800, background: "#4f7d32", color: "#efffe7" }}>
                    Revive Target
                  </button>
                </div>
              </>
            ) : null}

            {tab === "inventory" ? (
              <div style={card}>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8, fontSize: 12 }}>
                  <span>Herb <strong>{inventory.herb || 0}</strong></span>
                  <span>Fang <strong>{inventory.fang || 0}</strong></span>
                  <span>Essence <strong>{inventory.essence || 0}</strong></span>
                  <span>Potion <strong>{inventory.potion || 0}</strong></span>
                </div>
                <button disabled={!active || !allowed.has(ActionType.USE_ITEM)} onClick={() => sendAction(ActionType.USE_ITEM, { itemId: "potion" })} style={{ width: "100%", border: "none", borderRadius: 8, padding: 9, fontWeight: 800, background: "#9d5a2b", color: "#fff0e6" }}>
                  Drink Potion
                </button>
                {lootFx ? <div style={{ marginTop: 8, border: `1px solid #66502a`, borderRadius: 8, padding: 8, color: "#f8e4b4" }}>Loot pickup: +{lootFx.xp} XP, +{lootFx.gold}g, {dropsText(lootFx.drops)}</div> : null}
              </div>
            ) : null}

            {tab === "crafting" ? (
              <div style={card}>
                {craftingOptions.length ? craftingOptions.map((r) => (
                  <div key={r.id} style={{ border: `1px solid ${theme.border}`, borderRadius: 8, padding: 8, background: theme.panel, marginBottom: 7 }}>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <strong>{r.label}</strong><span style={{ ...mono, fontSize: 12, color: theme.sub }}>AP {r.apCost}</span>
                    </div>
                    <div style={{ marginTop: 4, fontSize: 12, color: theme.sub }}>Cost: {recipeText(r.requires)}</div>
                    <div style={{ marginTop: 2, fontSize: 12, color: theme.sub }}>Result: {recipeText(r.yields)}</div>
                    <button disabled={!active || !allowed.has(ActionType.CRAFT_ITEM) || !r.canCraft} onClick={() => sendAction(ActionType.CRAFT_ITEM, { recipeId: r.id })} style={{ width: "100%", marginTop: 6, border: "none", borderRadius: 8, padding: 8, fontWeight: 800, background: "#2f7a61", color: "#e9fff6" }}>
                      Craft
                    </button>
                  </div>
                )) : <div style={{ color: theme.sub }}>No recipes unlocked yet.</div>}
                <div style={{ marginTop: 6, fontSize: 12, color: theme.sub }}>More recipes will be added here.</div>
              </div>
            ) : null}

            {tab === "stats" ? (
              <div style={card}>
                <div style={{ fontSize: 12, color: theme.sub }}>XP {rpg?.xp || 0}/{rpg?.xpToNext || 0} | Gold {rpg?.gold || 0}</div>
                <div style={{ marginTop: 4, fontSize: 12, color: theme.sub }}>Weapon {rpg?.weapon?.name || "-"} | Spell {rpg?.spell?.name || "-"}</div>
                <div style={{ marginTop: 4, fontSize: 12, color: theme.sub }}>Client {clientId || "-"}</div>
                <div style={{ marginTop: 8, fontWeight: 700 }}>Party</div>
                <div style={{ display: "grid", gap: 6, marginTop: 5 }}>
                  {heroesPublic.map((h) => (
                    <div key={h.ownerPlayerId} style={{ border: `1px solid ${theme.border}`, borderRadius: 8, padding: 7, background: theme.panel }}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                        <strong>{h.ownerPlayerName || "Player"} {h.ownerPlayerId === player?.playerId ? "(You)" : ""}</strong>
                        <span>Lv {h.level || 1}</span>
                      </div>
                      <div style={{ marginTop: 4, height: 6, borderRadius: 99, overflow: "hidden", background: "#0e141c", border: `1px solid ${theme.border}` }}>
                        <div style={{ width: pct(h.hp, h.maxHp), height: "100%", background: "linear-gradient(90deg,#ff9595,#ff5959)" }} />
                      </div>
                      <div style={{ marginTop: 3, fontSize: 11, color: theme.sub }}>{h.hp}/{h.maxHp} | ({h.x},{h.y})</div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </>
        )}

        {error ? <div style={{ ...card, color: "#f5aaaa", borderColor: "#6b3737", whiteSpace: "pre-wrap" }}>{error}</div> : null}
      </div>

      {joined ? (
        <div style={{ position: "fixed", left: "50%", bottom: 9, transform: "translateX(-50%)", width: "min(640px, calc(100vw - 18px))", display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 6, background: "rgba(15, 24, 35, 0.98)", border: `1px solid ${theme.border}`, borderRadius: 12, padding: 5 }}>
          {tabs.map((t) => (
            <button key={t} onClick={() => setTab(t)} style={{ border: "none", borderRadius: 8, padding: "9px 6px", textTransform: "capitalize", background: tab === t ? "#234259" : "transparent", color: tab === t ? "#dff2ff" : theme.sub, fontWeight: 800 }}>
              {t}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
