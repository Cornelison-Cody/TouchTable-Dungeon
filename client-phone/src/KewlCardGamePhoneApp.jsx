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
const tabs = ["actions", "inventory", "stats"];
const labels = {
  herb: "Herb",
  fang: "Fang",
  essence: "Essence",
  potion: "Potion",
  coal: "Coal",
  copper: "Copper",
  iron: "Iron",
  crystal: "Crystal",
  relic: "Relic"
};
const resourceOrder = ["coal", "copper", "iron", "crystal", "relic", "herb", "fang", "essence", "potion"];
const STORAGE_PREFIX = "tt_kewl_card_game";
const storageKey = (suffix) => `${STORAGE_PREFIX}_${suffix}`;

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
  return localStorage.getItem(storageKey("server_ws")) || `${scheme}://${host}:3000`;
}

function pct(hp, maxHp) {
  const m = Math.max(1, Number(maxHp) || 1);
  return `${Math.max(0, Math.min(100, ((Number(hp) || 0) / m) * 100))}%`;
}

function dropsText(obj = {}) {
  const parts = Object.entries(obj || {}).filter(([, v]) => Number(v) > 0).map(([k, v]) => `${v} ${labels[k] || k}`);
  return parts.length ? parts.join(" | ") : "None";
}

function lootKind(loot) {
  if (!loot) return "Loot";
  if (loot.mineAction === "credit") return "Mining Cache";
  if (loot.mineAction === "dig") return "Mine Find";
  return "Loot Pickup";
}

function lootChipText(loot) {
  if (!loot) return [];
  const chips = [];
  const xp = Math.max(0, Number(loot.xp) || 0);
  const gold = Math.max(0, Number(loot.gold) || 0);
  const mineCredits = Math.max(0, Number(loot.mineCredits) || 0);
  if (xp > 0) chips.push(`+${xp} XP`);
  if (gold > 0) chips.push(`+${gold}g`);
  if (mineCredits > 0) chips.push(`+${mineCredits} dig${mineCredits === 1 ? "" : "s"}`);
  for (const [itemId, qtyRaw] of Object.entries(loot.drops || {})) {
    const qty = Math.max(0, Number(qtyRaw) || 0);
    if (qty > 0) chips.push(`+${qty} ${labels[itemId] || itemId}`);
  }
  if (!chips.length) chips.push("No resources");
  return chips;
}

function lootEventFrom(loot) {
  if (!loot || !loot.at) return null;
  return {
    id: `${loot.at}-${loot.mineAction || "loot"}`,
    at: Number(loot.at) || Date.now(),
    kind: lootKind(loot),
    chips: lootChipText(loot),
    depth: Number.isFinite(Number(loot.mineDepth)) ? Math.max(0, Number(loot.mineDepth)) : null
  };
}

function clockLabel(ts) {
  if (!ts) return "--:--";
  const d = new Date(ts);
  const hh = `${d.getHours()}`.padStart(2, "0");
  const mm = `${d.getMinutes()}`.padStart(2, "0");
  return `${hh}:${mm}`;
}

function tierPalette(tier) {
  if (tier === "late") return { glow: "#f5a649", tint: "linear-gradient(145deg, #7a3f16, #4a2a16)" };
  if (tier === "mid") return { glow: "#72b8ff", tint: "linear-gradient(145deg, #214f79, #1a344f)" };
  return { glow: "#7fce8c", tint: "linear-gradient(145deg, #27573a, #1d3b2a)" };
}

export default function KewlCardGamePhoneApp() {
  const initialWsUrl = useMemo(() => {
    const fromQuery = getQueryWsUrl();
    if (fromQuery) {
      localStorage.setItem(storageKey("server_ws"), fromQuery);
      return fromQuery;
    }
    return defaultWsUrl();
  }, []);

  const [wsUrl, setWsUrl] = useState(initialWsUrl);
  const [status, setStatus] = useState("disconnected");
  const [error, setError] = useState(null);
  const [clientId, setClientId] = useState(null);

  const [playerName, setPlayerName] = useState(localStorage.getItem(storageKey("player_name")) || "");
  const [seat, setSeat] = useState(1);
  const [joined, setJoined] = useState(false);
  const [player, setPlayer] = useState(null);
  const [privateState, setPrivateState] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [tab, setTab] = useState("actions");

  const [reviveTarget, setReviveTarget] = useState("");
  const [damageTargetId, setDamageTargetId] = useState("");
  const [damageValue, setDamageValue] = useState(1);

  const [hitFx, setHitFx] = useState(null);
  const [incomingFx, setIncomingFx] = useState(null);
  const [lootFx, setLootFx] = useState(null);
  const [lootFeed, setLootFeed] = useState([]);
  const [mineOpen, setMineOpen] = useState(false);
  const [digRevealFx, setDigRevealFx] = useState(null);
  const [digTapKey, setDigTapKey] = useState("");

  const resumeToken = useMemo(() => localStorage.getItem(storageKey("resume_token")) || "", []);
  const sessionId = useMemo(() => getQuerySessionId() || "", []);

  const wsRef = useRef(null);
  const seenHit = useRef(0);
  const seenIncoming = useRef(0);
  const seenLoot = useRef(0);
  const seenMineCredits = useRef(0);
  const seenMineReward = useRef(0);

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
          if (token) localStorage.setItem(storageKey("resume_token"), token);
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
            localStorage.removeItem(storageKey("resume_token"));
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
    localStorage.setItem(storageKey("server_ws"), wsUrl);
    setWsUrl(wsUrl.trim());
    setMenuOpen(false);
  }

  function doJoin() {
    setError(null);
    const ws = wsRef.current;
    const name = playerName.trim().slice(0, 32);
    if (!name) return setError("Enter a player name.");
    localStorage.setItem(storageKey("player_name"), name);
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

  function sendMineDig(x, y) {
    setDigTapKey(`${x},${y}`);
    sendAction(ActionType.MINE_DIG, { x, y });
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
  const mine = g?.mine || null;
  const mineCredits = mine?.credits ?? 0;
  const mineCursor = mine?.cursor || { x: 0, y: 0 };
  const mineTiles = useMemo(() => new Map((mine?.tiles || []).map((t) => [`${t.x},${t.y}`, t])), [mine]);
  const mineAvailable = useMemo(() => new Set((mine?.available || []).map((t) => `${t.x},${t.y}`)), [mine]);
  const mineLastReward = mine?.lastReward || null;
  const heroesPublic = g?.heroesPublic || [];
  const reviveTargets = g?.reviveTargets || [];
  const enemies = g?.enemies || (g?.enemy ? [g.enemy] : []);
  const visibleEnemies = enemies.filter((e) => e && e.hp > 0);
  const targetEnemies = hero
    ? visibleEnemies
        .map((e) => ({ ...e, dist: manhattan(hero, e) }))
        .sort((a, b) => a.dist - b.dist || a.hp - b.hp || a.id.localeCompare(b.id))
    : visibleEnemies;
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
    const event = lootEventFrom(loot);
    if (!event) return;
    setLootFx(event);
    setLootFeed((curr) => [event, ...curr.filter((e) => e.id !== event.id)].slice(0, 7));
    const t = setTimeout(() => setLootFx((v) => (v?.id === event.id ? null : v)), 7800);
    return () => clearTimeout(t);
  }, [g]);
  useEffect(() => {
    if (!digTapKey) return;
    const t = setTimeout(() => setDigTapKey(""), 260);
    return () => clearTimeout(t);
  }, [digTapKey]);
  useEffect(() => {
    const reward = mineLastReward;
    if (!reward?.at || reward.at <= seenMineReward.current) return;
    seenMineReward.current = reward.at;
    setDigRevealFx({
      at: reward.at,
      key: `${reward.x},${reward.y}`,
      tier: reward.tier || "early",
      gold: Math.max(0, Number(reward.gold) || 0),
      drops: reward.drops || {},
      depth: Math.max(0, Number(reward.depth) || 0)
    });
    const t = setTimeout(() => setDigRevealFx((v) => (v?.at === reward.at ? null : v)), 2500);
    return () => clearTimeout(t);
  }, [mineLastReward]);

  useEffect(() => {
    const credits = Number(mineCredits) || 0;
    if (credits > seenMineCredits.current) setMineOpen(true);
    seenMineCredits.current = credits;
  }, [mineCredits]);

  const terrainSeed = g?.terrain?.seed ?? 0;
  const occupied = new Set();
  for (const h of heroesPublic) if (h.hp > 0) occupied.add(`${h.x},${h.y}`);
  for (const e of visibleEnemies) occupied.add(`${e.x},${e.y}`);
  const lootByCell = new Map((g?.groundLoot || []).map((l) => [`${l.x},${l.y}`, l]));
  const canMove = allowed.has(ActionType.MOVE) && active && apRemaining > 0;
  const canDamage = active && allowed.has(ActionType.APPLY_DAMAGE);
  const damageTarget = damageTargetId ? visibleEnemies.find((e) => e.id === damageTargetId) || null : null;
  const neighbors = active && hero && hero.hp > 0
    ? hexNeighbors(hero.x, hero.y).map((c) => {
        const t = terrainAt(c.x, c.y, terrainSeed);
        const moveCost = Math.min(4, Math.max(1, Number(t.moveCost) || 1));
        const canStep = canMove && t.passable && !occupied.has(`${c.x},${c.y}`) && apRemaining >= moveCost;
        return { ...c, t, moveCost, loot: lootByCell.get(`${c.x},${c.y}`) || null, canMove: canStep };
      })
    : [];

  const W = 72;
  const H = 60;
  const P = `${W * 0.25},0 ${W * 0.75},0 ${W},${H * 0.5} ${W * 0.75},${H} ${W * 0.25},${H} 0,${H * 0.5}`;
  const topBadge = status === "connected" ? theme.good : status === "error" ? theme.bad : theme.sub;
  const damageButtons = [1, 2, 3, 4, 5, 6, 8, 10];
  const mineRadius = 2;
  const mineGridSize = mineRadius * 2 + 1;
  const latestLoot = lootFx || lootFeed[0] || null;
  const latestLootChips = latestLoot?.chips || [];
  const mineDepthNow = Math.abs(mineCursor.x) + Math.abs(mineCursor.y);
  const mineDepthPct = Math.max(5, Math.min(100, (mineDepthNow / 24) * 100));
  const digRevealChips = digRevealFx ? lootChipText({ gold: digRevealFx.gold, drops: digRevealFx.drops }) : [];
  const digRevealPalette = tierPalette(digRevealFx?.tier || "early");
  const mineCells = useMemo(() => {
    if (!mine) return [];
    const cells = [];
    for (let y = mineCursor.y - mineRadius; y <= mineCursor.y + mineRadius; y += 1) {
      for (let x = mineCursor.x - mineRadius; x <= mineCursor.x + mineRadius; x += 1) {
        const key = `${x},${y}`;
        const tile = mineTiles.get(key) || null;
        const isCursor = x === mineCursor.x && y === mineCursor.y;
        const isAvailable = mineAvailable.has(key);
        const canDig = isAvailable && mineCredits > 0;
        cells.push({ x, y, key, tile, isCursor, isAvailable, canDig });
      }
    }
    return cells;
  }, [mine, mineCursor.x, mineCursor.y, mineRadius, mineTiles, mineAvailable, mineCredits]);

  function openDamageModal(enemyId) {
    setDamageTargetId(enemyId);
    setDamageValue(1);
  }

  function closeDamageModal() {
    setDamageTargetId("");
  }

  function applyDamage(amount) {
    if (!damageTarget) return;
    if (!canDamage) {
      setError("Not your turn.");
      return;
    }
    const dmg = Math.floor(Number(amount));
    if (!Number.isFinite(dmg) || dmg <= 0) {
      setError("Enter a damage amount greater than 0.");
      return;
    }
    sendAction(ActionType.APPLY_DAMAGE, { targetEnemyId: damageTarget.id, amount: dmg });
    closeDamageModal();
  }

  return (
    <div style={shell}>
      <div style={{ maxWidth: 720, margin: "0 auto", paddingBottom: joined ? 82 : 8 }}>
        <div style={{ ...card, position: "relative", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <strong>Kewl Card Phone</strong>
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
            <button onClick={doJoin} style={{ width: "100%", marginTop: 8, background: theme.brand, color: "#07201f", border: "none", borderRadius: 8, padding: 10, fontWeight: 800 }}>Join Table</button>
          </div>
        ) : (
          <>
            <div style={{ ...card, position: "sticky", top: 8, zIndex: 6, background: "rgba(20, 32, 49, 0.97)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <div>
                  <div style={{ fontWeight: 800 }}>{player?.playerName || "Player"}</div>
                  <div style={{ marginTop: 3, fontSize: 12, color: theme.sub }}>HP {hero ? `${hero.hp}/${hero.maxHp}` : "-"} | AP {apRemaining}/{apMax} | Lv {rpg?.level || "-"}</div>
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    disabled={!active || !allowed.has(ActionType.UNDO)}
                    onClick={() => sendAction(ActionType.UNDO)}
                    style={{ border: "none", borderRadius: 8, padding: "8px 10px", fontWeight: 800, background: !active ? "#2b3847" : "#3b63a5", color: !active ? "#9fb1c5" : "#e6f0ff" }}
                  >
                    Undo
                  </button>
                  <button
                    disabled={!active || !allowed.has(ActionType.END_TURN)}
                    onClick={() => sendAction(ActionType.END_TURN)}
                    style={{ border: "none", borderRadius: 8, padding: "8px 10px", fontWeight: 800, background: !active ? "#314255" : "#d18d2f", color: !active ? "#9fb1c5" : "#2a1908" }}
                  >
                    End Turn
                  </button>
                </div>
              </div>
            </div>

            {hitFx ? <div style={{ ...card, borderColor: "#6b3a3a", color: "#ffd6d6" }}>Hit for {hitFx.amount}. Enemy {hitFx.enemyHp}/{hitFx.enemyMaxHp}</div> : null}
            {incomingFx ? <div style={{ ...card, borderColor: "#6b3a3a", color: "#ffd6d6" }}>You were hit for {incomingFx.amount}. HP {incomingFx.heroHp}/{incomingFx.heroMaxHp}</div> : null}
            {latestLoot ? (
              <div style={{ ...card, borderColor: "#6f5531", background: "linear-gradient(160deg, rgba(58,42,24,0.74), rgba(20,32,49,0.9))" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <div style={{ fontWeight: 800 }}>Loot Feed</div>
                  <span style={{ ...mono, fontSize: 11, color: "#ffd99f" }}>{clockLabel(latestLoot.at)}</span>
                </div>
                <div style={{ marginTop: 4, fontSize: 12, color: "#f4d8a6" }}>
                  {latestLoot.kind}{latestLoot.depth !== null ? ` • Depth ${latestLoot.depth}` : ""}
                </div>
                <div style={{ marginTop: 7, display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {latestLootChips.map((chip) => (
                    <span key={chip} style={{ border: "1px solid #876636", borderRadius: 999, padding: "3px 8px", fontSize: 11, color: "#ffe6bf", background: "rgba(31, 19, 10, 0.55)" }}>
                      {chip}
                    </span>
                  ))}
                </div>
                {lootFeed.length > 1 ? (
                  <div style={{ marginTop: 8, display: "grid", gap: 4 }}>
                    {lootFeed.slice(1, 5).map((entry) => (
                      <div key={entry.id} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 11, color: "#dcbf8d" }}>
                        <span style={{ minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{entry.kind}: {entry.chips.slice(0, 2).join(", ")}</span>
                        <span style={{ ...mono, color: "#bca176" }}>{clockLabel(entry.at)}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}

            {tab === "actions" ? (
              <>
                <div style={card}>
                  <div style={{ color: theme.sub, fontSize: 12, marginBottom: 6 }}>Move on green. Red hexes mark enemies.</div>
                  <div style={{ position: "relative", width: 264, height: 220, margin: "0 auto" }}>
                    <div style={{ position: "absolute", left: 96, top: 80, width: W, height: H, display: "grid", placeItems: "center", fontWeight: 800 }}>YOU</div>
                    {neighbors.map((c) => {
                      const xStep = W * 0.75;
                      const yStep = H;
                      const left = 96 + (c.x - hero.x) * xStep;
                      const top = 80 + (c.y - hero.y) * yStep + ((c.x % 2 ? yStep / 2 : 0) - (hero.x % 2 ? yStep / 2 : 0));
                      const enemy = visibleEnemies.find((e) => e.x === c.x && e.y === c.y) || null;
                      const tap = c.canMove;
                      const bg = c.t.passable ? c.t.fill : "#1d2734";
                      const stroke = enemy ? "#c57784" : c.canMove ? "#5cb882" : c.t.stroke;
                      const apLabel = !enemy && c.t.passable ? `AP${c.moveCost}` : "";
                      return (
                        <button key={`${c.x},${c.y}`} disabled={!tap} onClick={() => sendMove(c.x, c.y)} style={{ position: "absolute", left, top, width: W, height: H, border: "none", background: "transparent", padding: 0, cursor: tap ? "pointer" : "default", color: enemy ? theme.bad : c.canMove ? theme.good : theme.sub, fontWeight: 800, fontSize: 11 }}>
                          <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}><polygon points={P} fill={bg} stroke={stroke} strokeWidth="1.2" /></svg>
                          <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
                            <div>{enemy ? "EN" : c.canMove ? "GO" : ""}</div>
                            {enemy ? <div style={{ fontSize: 9 }}>{enemy.hp}/{enemy.maxHp}</div> : null}
                            {!enemy && apLabel ? <div style={{ fontSize: 9 }}>{apLabel}</div> : null}
                            {c.loot && c.canMove ? <div style={{ marginTop: 1, fontSize: 10 }}>[]</div> : null}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div style={card}>
                  <div style={{ marginBottom: 8, fontWeight: 700 }}>Targets (tap to deal damage)</div>
                  <div style={{ display: "grid", gap: 6 }}>
                    {targetEnemies.length ? targetEnemies.map((e) => (
                      <button key={e.id} onClick={() => openDamageModal(e.id)} style={{ textAlign: "left", border: `1px solid ${theme.border}`, borderRadius: 8, padding: 7, background: theme.panel, color: theme.text, cursor: "pointer" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                          <strong>{e.name} {e.level ? `(Lv ${e.level})` : ""}</strong>
                          <span style={mono}>{e.hp}/{e.maxHp}</span>
                        </div>
                        <div style={{ marginTop: 4, height: 6, borderRadius: 99, overflow: "hidden", border: `1px solid ${theme.border}`, background: "#0e141c" }}>
                          <div style={{ width: pct(e.hp, e.maxHp), height: "100%", background: "linear-gradient(90deg,#ff9a9a,#ff5757)" }} />
                        </div>
                        <div style={{ marginTop: 3, fontSize: 11, color: theme.sub }}>Distance {hero ? e.dist : "?"}</div>
                      </button>
                    )) : <div style={{ color: theme.sub }}>No monsters on the board.</div>}
                  </div>

                  <div style={{ fontSize: 12, color: theme.sub, marginTop: 8 }}>Revive</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 5 }}>
                    {reviveTargets.map((t) => <button key={t.playerId} onClick={() => setReviveTarget(t.playerId)} style={{ padding: "5px 8px", borderRadius: 8, border: `1px solid ${reviveTarget === t.playerId ? "#8ac56f" : theme.border}`, background: reviveTarget === t.playerId ? "#32582a" : theme.panel, color: reviveTarget === t.playerId ? "#e3f7d9" : theme.sub }}>{t.playerName || "Ally"} ({t.distance})</button>)}
                    {!reviveTargets.length ? <span style={{ color: theme.sub, fontSize: 12 }}>No downed ally in range.</span> : null}
                  </div>
                  <button disabled={!active || !allowed.has(ActionType.REVIVE) || !reviveTarget} onClick={() => sendAction(ActionType.REVIVE, { targetPlayerId: reviveTarget })} style={{ width: "100%", marginTop: 6, border: "none", borderRadius: 8, padding: 9, fontWeight: 800, background: "#4f7d32", color: "#efffe7" }}>
                    Revive Target
                  </button>
                </div>

                {mine ? (
                  <div style={card}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div style={{ fontWeight: 800 }}>Mining Grid</div>
                      <div style={{ fontSize: 12, color: theme.sub }}>Credits {mineCredits} • Digs {mine.totalDigs || 0}</div>
                    </div>
                    <div style={{ marginTop: 6, fontSize: 12, color: theme.sub }}>Pick a direction each dig to push deeper into the mine.</div>
                    <div style={{ marginTop: 8, borderRadius: 999, border: `1px solid ${theme.border}`, height: 9, overflow: "hidden", background: "#0d141c" }}>
                      <div style={{ width: `${mineDepthPct}%`, height: "100%", background: "linear-gradient(90deg, #2e6e9b, #50a9db)" }} />
                    </div>
                    <div style={{ marginTop: 4, fontSize: 11, color: "#95c7e6" }}>Current depth {mineDepthNow}</div>
                    {mineLastReward ? (
                      <div style={{ marginTop: 6, fontSize: 12, color: "#f4d9a8" }}>
                        Last dig: +{mineLastReward.gold || 0}g, {dropsText(mineLastReward.drops)} (depth {mineLastReward.depth || 0})
                      </div>
                    ) : null}
                    <button
                      disabled={mineCredits <= 0}
                      onClick={() => setMineOpen(true)}
                      style={{ width: "100%", marginTop: 8, border: "none", borderRadius: 8, padding: 9, fontWeight: 800, background: mineCredits > 0 ? "#4b7c97" : "#2a3442", color: mineCredits > 0 ? "#e7f7ff" : "#9fb1c5" }}
                    >
                      {mineCredits > 0 ? "Open Mine" : "No Digs Available"}
                    </button>
                  </div>
                ) : null}
              </>
            ) : null}

            {tab === "inventory" ? (
              <div style={card}>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8, fontSize: 12 }}>
                  {resourceOrder.map((key) => (
                    <span key={key}>{labels[key] || key} <strong>{inventory[key] || 0}</strong></span>
                  ))}
                </div>
                <button disabled={!active || !allowed.has(ActionType.USE_ITEM)} onClick={() => sendAction(ActionType.USE_ITEM, { itemId: "potion" })} style={{ width: "100%", border: "none", borderRadius: 8, padding: 9, fontWeight: 800, background: "#9d5a2b", color: "#fff0e6" }}>
                  Drink Potion
                </button>
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

        {damageTarget ? (
          <div style={{ position: "fixed", inset: 0, background: "rgba(6, 10, 16, 0.65)", display: "grid", placeItems: "center", zIndex: 30 }} onClick={closeDamageModal}>
            <div style={{ ...card, margin: 0, width: "min(420px, 92vw)" }} onClick={(e) => e.stopPropagation()}>
              <div style={{ fontWeight: 800, fontSize: 15, marginBottom: 6 }}>{damageTarget.name || "Enemy"} ({damageTarget.hp}/{damageTarget.maxHp})</div>
              <div style={{ color: theme.sub, fontSize: 12, marginBottom: 10 }}>Select damage to apply.</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6, marginBottom: 10 }}>
                {damageButtons.map((amt) => (
                  <button key={amt} disabled={!canDamage} onClick={() => applyDamage(amt)} style={{ border: "none", borderRadius: 8, padding: "8px 0", fontWeight: 800, background: canDamage ? "#7b3646" : "#2a3442", color: canDamage ? "#ffeef1" : "#9fb1c5" }}>
                    {amt}
                  </button>
                ))}
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input type="number" min="1" value={damageValue} onChange={(e) => setDamageValue(e.target.value)} style={{ flex: 1, padding: "8px 10px", borderRadius: 8, border: `1px solid ${theme.border}`, background: theme.panel, color: theme.text }} />
                <button disabled={!canDamage} onClick={() => applyDamage(damageValue)} style={{ border: "none", borderRadius: 8, padding: "8px 10px", fontWeight: 800, background: canDamage ? "#3b63a5" : "#2a3442", color: canDamage ? "#e6f0ff" : "#9fb1c5" }}>
                  Apply
                </button>
                <button onClick={closeDamageModal} style={{ border: "none", borderRadius: 8, padding: "8px 10px", fontWeight: 800, background: "#2a3442", color: "#c7d2e3" }}>
                  Close
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {mineOpen && mine ? (
          <div style={{ position: "fixed", inset: 0, background: "rgba(6, 10, 16, 0.7)", display: "grid", placeItems: "center", zIndex: 28 }} onClick={() => setMineOpen(false)}>
            <div style={{ ...card, margin: 0, width: "min(520px, 94vw)" }} onClick={(e) => e.stopPropagation()}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ fontWeight: 800, fontSize: 15 }}>Mining Depth {mineDepthNow}</div>
                <button onClick={() => setMineOpen(false)} style={{ border: "none", borderRadius: 8, padding: "6px 10px", background: "#2a3442", color: "#c7d2e3", fontWeight: 700 }}>Close</button>
              </div>
              <div style={{ marginTop: 4, fontSize: 12, color: theme.sub }}>Credits {mineCredits}. Tap a highlighted tile to dig.</div>
              <div style={{ marginTop: 8, borderRadius: 999, border: `1px solid ${theme.border}`, height: 9, overflow: "hidden", background: "#0d141c" }}>
                <div style={{ width: `${mineDepthPct}%`, height: "100%", background: "linear-gradient(90deg, #2e6e9b, #50a9db)" }} />
              </div>

              {digRevealFx ? (
                <div style={{ marginTop: 10, border: `1px solid ${digRevealPalette.glow}`, borderRadius: 10, padding: "8px 10px", background: digRevealPalette.tint, boxShadow: `0 0 0 1px rgba(0,0,0,0.25), 0 0 16px ${digRevealPalette.glow}55` }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <strong style={{ fontSize: 12 }}>Strike Complete</strong>
                    <span style={{ ...mono, fontSize: 11 }}>Depth {digRevealFx.depth}</span>
                  </div>
                  <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {digRevealChips.map((chip) => (
                      <span key={chip} style={{ border: "1px solid rgba(255,255,255,0.24)", borderRadius: 999, padding: "3px 8px", fontSize: 11, background: "rgba(8,12,18,0.4)" }}>
                        {chip}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}

              <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: `repeat(${mineGridSize}, 1fr)`, gap: 6 }}>
                {mineCells.map((cell) => {
                  const tier = cell.tile?.reward?.tier || null;
                  const rewardKeys = Object.keys(cell.tile?.reward?.drops || {});
                  const rewardLabel = rewardKeys.length ? (labels[rewardKeys[0]] || rewardKeys[0]) : "";
                  const rewardShort = rewardLabel ? rewardLabel.slice(0, 1).toUpperCase() : cell.tile?.reward ? "G" : "";
                  const palette = tierPalette(tier || "early");
                  const baseBg = cell.tile ? "#1c2737" : "#0f151d";
                  const bg = cell.tile ? (cell.tile.reward ? palette.tint : baseBg) : (cell.isAvailable ? "linear-gradient(145deg, #13324a, #102536)" : "#0f151d");
                  const border = cell.isCursor ? "#f2c979" : cell.isAvailable ? "#7dc4da" : theme.border;
                  const label = cell.isCursor ? "YOU" : cell.tile ? (cell.tile.reward ? rewardShort : "BASE") : cell.isAvailable ? "DIG" : "";
                  const depthLabel = Math.abs(cell.x) + Math.abs(cell.y);
                  const isPulse = digTapKey && digTapKey === cell.key;
                  const isReveal = digRevealFx && digRevealFx.key === cell.key;
                  return (
                    <button
                      key={cell.key}
                      disabled={!cell.canDig}
                      onClick={() => cell.canDig && sendMineDig(cell.x, cell.y)}
                      style={{
                        position: "relative",
                        border: `1px solid ${border}`,
                        borderRadius: 8,
                        background: bg,
                        color: cell.isAvailable ? "#d6f1ff" : theme.sub,
                        fontWeight: 800,
                        fontSize: 11,
                        padding: "10px 0 9px",
                        cursor: cell.canDig ? "pointer" : "default",
                        opacity: cell.isAvailable && !cell.canDig ? 0.6 : 1,
                        transform: isPulse ? "scale(0.94)" : "scale(1)",
                        boxShadow: isReveal ? `0 0 0 1px ${palette.glow}, 0 0 12px ${palette.glow}88` : "none"
                      }}
                    >
                      <div>{label}</div>
                      {cell.isAvailable || cell.tile ? <div style={{ marginTop: 2, fontSize: 9, opacity: 0.86 }}>D{depthLabel}</div> : null}
                    </button>
                  );
                })}
              </div>

              <div style={{ marginTop: 10, fontSize: 12, color: theme.sub }}>
                {mineLastReward ? (
                  <div>Last dig: +{mineLastReward.gold || 0}g, {dropsText(mineLastReward.drops)} (depth {mineLastReward.depth || 0})</div>
                ) : (
                  <div>No digs yet. Start at the base tile and push deeper.</div>
                )}
              </div>
            </div>
          </div>
        ) : null}

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
