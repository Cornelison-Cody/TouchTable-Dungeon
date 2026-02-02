import { WebSocketServer } from "ws";
import { v4 as uuid } from "uuid";
import os from "os";
import { MsgType, Role, PROTOCOL_VERSION, makeMsg } from "../shared/protocol.js";
import {

  ActionType,
  makeInitialGameState,
  manhattan,
  nextActivePlayer,
  resetTurnAP,
  spawnHeroForPlayer,
  ensurePlayerInTurnOrder,
  isHeroAlive
} from "../shared/game.js";

const BUILD_TAG = "m8h";


function getLanAddress() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net && net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "localhost";
}

function makeSession() {
  return {
    sessionId: uuid().slice(0, 8),
    createdAt: Date.now(),
    seats: Array.from({ length: 6 }, (_, i) => ({
      seat: i + 1,
      occupied: false,
      playerName: null,
      playerId: null,
      resumeToken: null
    }))
  };
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

export function setupWebSocket(server) {
  const wss = new WebSocketServer({ server });

  const session = makeSession();
  let tableWs = null;
  let game = null;

  const clients = new Map(); // ws -> { clientId, role, playerId?, seat? }

  function shortName(pid) {
    const s = session.seats.find((x) => x.playerId === pid);
    return s?.playerName || pid.slice(0, 4);
  }

  function isPlayerConnected(playerId) {
    for (const info of clients.values()) {
      if (info.role === Role.PHONE && info.playerId === playerId) return true;
    }
    return false;
  }

  function send(ws, msg) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  function reject(ws, id, code, message) {
    send(ws, makeMsg(MsgType.ERROR, { code, message }, id));
  }

  function getJoinUrl() {
    const host = getLanAddress();
    return `http://${host}:5174/?session=${session.sessionId}`;
  }

  function ensureGameFor(playerId, seatIndex0) {
    if (!game) {
      game = makeInitialGameState(playerId);
      resetTurnAP(game);
      game.log.push({ at: Date.now(), msg: "Encounter started." });
      game.log.push({ at: Date.now(), msg: `Turn: ${shortName(playerId)}.` });
    } else {
      ensurePlayerInTurnOrder(game, playerId);
    }
    spawnHeroForPlayer(game, playerId, seatIndex0);
  }

  function computePublicState() {
    const nameById = new Map(session.seats.filter((s) => s.playerId).map((s) => [s.playerId, s.playerName]));
    return {
      sessionId: session.sessionId,
      seats: session.seats.map((s) => ({
        seat: s.seat,
        occupied: s.occupied,
        playerName: s.playerName,
        playerId: s.playerId
      })),
      game: game
        ? {
            grid: game.grid,
            turn: { activePlayerId: game.turn.activePlayerId, activePlayerName: nameById.get(game.turn.activePlayerId) || null, order: game.turn.order, apRemaining: game.turn.apRemaining, apMax: game.turn.apMax },
            heroes: Object.values(game.heroes).map((h) => ({
              ownerPlayerId: h.ownerPlayerId,
              ownerPlayerName: nameById.get(h.ownerPlayerId) || null,
              x: h.x,
              y: h.y,
              hp: h.hp,
              maxHp: h.maxHp
            })),
            enemy: { x: game.enemy.x, y: game.enemy.y, hp: game.enemy.hp, maxHp: game.enemy.maxHp },
            rules: { moveRange: game.rules.moveRange, attackRange: game.rules.attackRange, actionPointsPerTurn: game.rules.actionPointsPerTurn },
            log: game.log.slice(-10)
          }
        : null
    };
  }

  function computePrivateState(playerId) {
    const seat = session.seats.find((s) => s.playerId === playerId);
    const isActive = game?.turn.activePlayerId === playerId;
    const hero = game?.heroes?.[playerId] ?? null;

    return {
      sessionId: session.sessionId,
      player: seat ? { playerId, seat: seat.seat, playerName: seat.playerName } : null,
      game: game
        ? {
            youAreActive: isActive,
            grid: game.grid,
            rules: {
              moveRange: game.rules.moveRange,
              attackRange: game.rules.attackRange,
              actionPointsPerTurn: game.rules.actionPointsPerTurn
            },
            heroesPublic: Object.values(game.heroes).map((h) => ({
              ownerPlayerId: h.ownerPlayerId,
              ownerPlayerName: session.seats.find((s) => s.playerId === h.ownerPlayerId)?.playerName || null,
              x: h.x,
              y: h.y,
              hp: h.hp,
              maxHp: h.maxHp
            })),
            hero: hero ? { x: hero.x, y: hero.y, hp: hero.hp, maxHp: hero.maxHp } : null,
            enemy: { x: game.enemy.x, y: game.enemy.y, hp: game.enemy.hp, maxHp: game.enemy.maxHp },
            apRemaining: game.turn.apRemaining,
            apMax: game.turn.apMax,
            allowedActions:
              isActive && hero && hero.hp > 0 && (game.turn.apRemaining ?? 0) > 0
                ? [ActionType.MOVE, ActionType.ATTACK, ActionType.END_TURN]
                : isActive && hero && hero.hp > 0
                  ? [ActionType.END_TURN]
                  : []
          }
        : null
    };
  }

  function emitViews() {
    if (tableWs) send(tableWs, makeMsg(MsgType.STATE_PUBLIC, { state: computePublicState() }));
    for (const [ws, info] of clients.entries()) {
      if (info.role === Role.PHONE && info.playerId) {
        send(ws, makeMsg(MsgType.STATE_PRIVATE, { state: computePrivateState(info.playerId) }));
      }
    }
  }

  function requireActive(ws, id, actorPlayerId) {
    if (!game?.turn.activePlayerId) {
      reject(ws, id, "NO_ACTIVE_PLAYER", "No active player.");
      return false;
    }
    if (game.turn.activePlayerId !== actorPlayerId) {
      reject(ws, id, "NOT_YOUR_TURN", "Not your turn.");
      return false;
    }
    return true;
  }

  function cellOccupiedByOtherHero(x, y, actorPlayerId) {
    if (!game) return false;
    for (const h of Object.values(game.heroes)) {
      if (h.ownerPlayerId !== actorPlayerId && h.hp > 0 && h.x === x && h.y === y) return true;
    }
    return false;
  }

  function enemyAutoAttack() {
    if (!game) return;
    if (game.enemy.hp <= 0) return;

    const adj = Object.values(game.heroes).filter((h) => isHeroAlive(h) && manhattan(h, game.enemy) <= game.rules.attackRange);
    if (!adj.length) {
      game.log.push({ at: Date.now(), msg: "Enemy waits." });
      return;
    }

    const activeHero = game.turn.activePlayerId ? game.heroes[game.turn.activePlayerId] : null;
    const target = activeHero && adj.find((h) => h.ownerPlayerId === activeHero.ownerPlayerId) ? activeHero : adj[0];

    target.hp = clamp(target.hp - game.rules.enemyDamage, 0, target.maxHp);
    game.log.push({ at: Date.now(), msg: `Enemy hits ${shortName(target.ownerPlayerId)} for ${game.rules.enemyDamage}.` });
    if (target.hp <= 0) game.log.push({ at: Date.now(), msg: `Hero ${shortName(target.ownerPlayerId)} is down!` });
  }

  function handleMove(ws, id, actorPlayerId, params) {
    if (!requireActive(ws, id, actorPlayerId)) return;
    // Action points
    if ((game.turn.apRemaining ?? 0) <= 0) return reject(ws, id, "NO_AP", "No actions remaining. End your turn.");
    const hero = game.heroes[actorPlayerId];
    if (!hero || hero.hp <= 0) return reject(ws, id, "HERO_DOWN", "Hero is down.");

    const toX = Number(params.toX);
    const toY = Number(params.toY);
    if (!Number.isFinite(toX) || !Number.isFinite(toY)) return reject(ws, id, "BAD_PARAMS", "MOVE requires toX/toY.");

    const nx = clamp(Math.floor(toX), 0, game.grid.w - 1);
    const ny = clamp(Math.floor(toY), 0, game.grid.h - 1);

    const dist = manhattan({ x: nx, y: ny }, hero);
    if (dist > game.rules.moveRange) return reject(ws, id, "OUT_OF_RANGE", `Move too far (range ${game.rules.moveRange}).`);

    if (nx === game.enemy.x && ny === game.enemy.y && game.enemy.hp > 0) return reject(ws, id, "BLOCKED", "Cell occupied by enemy.");
    if (cellOccupiedByOtherHero(nx, ny, actorPlayerId)) return reject(ws, id, "BLOCKED", "Cell occupied by another hero.");

    hero.x = nx; hero.y = ny;
    game.log.push({ at: Date.now(), msg: `Hero ${shortName(actorPlayerId)} moves to (${nx},${ny}).` });
    game.turn.apRemaining = Math.max(0, (game.turn.apRemaining ?? 0) - 1);
    send(ws, makeMsg(MsgType.OK, { accepted: true }, id));
    emitViews();
  }

  function handleAttack(ws, id, actorPlayerId) {
    if (!requireActive(ws, id, actorPlayerId)) return;
    // Action points
    if ((game.turn.apRemaining ?? 0) <= 0) return reject(ws, id, "NO_AP", "No actions remaining. End your turn.");
    const hero = game.heroes[actorPlayerId];
    if (!hero || hero.hp <= 0) return reject(ws, id, "HERO_DOWN", "Hero is down.");
    if (game.enemy.hp <= 0) return reject(ws, id, "ENEMY_DEAD", "Enemy already defeated.");

    const dist = manhattan(hero, game.enemy);
    if (dist > game.rules.attackRange) return reject(ws, id, "OUT_OF_RANGE", `Enemy out of range (range ${game.rules.attackRange}).`);

    game.enemy.hp = clamp(game.enemy.hp - game.rules.heroDamage, 0, game.enemy.maxHp);
    game.log.push({ at: Date.now(), msg: `Hero ${shortName(actorPlayerId)} attacks for ${game.rules.heroDamage}.` });
    game.turn.apRemaining = Math.max(0, (game.turn.apRemaining ?? 0) - 1);
    if (game.enemy.hp <= 0) game.log.push({ at: Date.now(), msg: "Enemy defeated!" });

    send(ws, makeMsg(MsgType.OK, { accepted: true }, id));
    emitViews();
  }

  function handleEndTurn(ws, id, actorPlayerId) {
    if (!requireActive(ws, id, actorPlayerId)) return;

    game.log.push({ at: Date.now(), msg: `Hero ${shortName(actorPlayerId)} ends turn.` });
    enemyAutoAttack();

    const next = nextActivePlayer(game);
    game.log.push({ at: Date.now(), msg: next ? `Turn: ${shortName(next)}.` : "No heroes left standing." });

    send(ws, makeMsg(MsgType.OK, { accepted: true }, id));
    emitViews();
  }

  function handleAction(ws, id, actorPlayerId, payload) {
    if (!game) return reject(ws, id, "NO_GAME", "No game started yet. Join a seat first.");

    const action = payload?.action;
    const params = payload?.params ?? {};

    if (action === ActionType.MOVE) return handleMove(ws, id, actorPlayerId, params);
    if (action === ActionType.ATTACK) return handleAttack(ws, id, actorPlayerId);
    if (action === ActionType.END_TURN) return handleEndTurn(ws, id, actorPlayerId);

    reject(ws, id, "UNKNOWN_ACTION", `Unknown action: ${action}`);
  }

  wss.on("connection", (ws) => {
    console.log(`[ws] connection open (build ${BUILD_TAG})`);
    const clientId = uuid();
    clients.set(ws, { clientId, role: null, playerId: null, seat: null });

    ws.on("message", (data, isBinary) => {
      // Some environments/extensions can emit non-JSON frames. We ignore obviously-non-JSON payloads
      // and log a small snippet for debugging.
      let text = "";
      try {
        text = isBinary ? Buffer.from(data).toString("utf8") : data.toString();
      } catch {
        text = "<unreadable>";
      }
      const trimmed = (text || "").trim();
      if (!trimmed) return;
      if (trimmed === "ping" || trimmed === "pong") return;

      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch (err) {
        const snippet = trimmed.length > 200 ? trimmed.slice(0, 200) + "…" : trimmed;
        console.error("[ws] BAD_JSON_PARSE", "binary=", !!isBinary, "snippet=", snippet, "build=", BUILD_TAG);
        send(ws, makeMsg(MsgType.ERROR, { code: "BAD_JSON", message: `Bad JSON (parse) (build ${BUILD_TAG})`, snippet }, "bad-json"));
        return;
      }

      try {
        handleMessage(ws, msg);
      } catch (err) {
        const snippet = trimmed.length > 200 ? trimmed.slice(0, 200) + "…" : trimmed;
        console.error("[ws] HANDLE_MESSAGE_ERROR", err?.stack || err, "snippet=", snippet, "build=", BUILD_TAG);
        send(
          ws,
          makeMsg(
            MsgType.ERROR,
            { code: "SERVER_ERROR", message: `Server error while handling message (build ${BUILD_TAG}): ${err?.message || err}`, snippet },
            "server-error"
          )
        );
      }
    });

    ws.on("close", () => {
      const info = clients.get(ws);
      if (info?.role === Role.TABLE && tableWs === ws) tableWs = null;
      clients.delete(ws);
    });
  });

  function handleMessage(ws, msg) {
    if (!msg || msg.v !== PROTOCOL_VERSION || typeof msg.t !== "string") {
      send(ws, makeMsg(MsgType.ERROR, { code: "BAD_PROTOCOL", message: "Bad protocol/version" }, msg?.id));
      return;
    }

    const info = clients.get(ws);

    if (msg.t === MsgType.PING) return send(ws, makeMsg(MsgType.OK, { pong: true }, msg.id));

    if (msg.t === MsgType.HELLO) {
      const role = msg.payload?.role;
      if (role !== Role.TABLE && role !== Role.PHONE) return reject(ws, msg.id, "BAD_ROLE", "role must be 'table' or 'phone'");
      info.role = role;

      const resumeToken = msg.payload?.resumeToken;
      if (role === Role.PHONE && resumeToken) {
        const seat = session.seats.find((s) => s.resumeToken === resumeToken);
        if (seat) {
          info.playerId = seat.playerId;
          info.seat = seat.seat;
          ensureGameFor(seat.playerId, seat.seat - 1);
        }
      }

      if (role === Role.TABLE) tableWs = ws;

      send(ws, makeMsg(MsgType.OK, { clientId: info.clientId }, msg.id));
      if (role === Role.TABLE) send(ws, makeMsg(MsgType.SESSION_INFO, { sessionId: session.sessionId, joinUrl: getJoinUrl() }));
      emitViews();
      return;
    }

    if (msg.t === MsgType.JOIN) {
      if (info.role !== Role.PHONE) return reject(ws, msg.id, "NOT_PHONE", "Only phones can JOIN");
      const playerName = (msg.payload?.playerName ?? "").toString().trim().slice(0, 32);
      const requestedSeat = Number(msg.payload?.seat);
      if (!playerName) return reject(ws, msg.id, "BAD_NAME", "playerName required");

      if (info.playerId) {
        // already joined (e.g., resumed via token)
        send(ws, makeMsg(MsgType.OK, { playerId: info.playerId, seat: info.seat, resumeToken: session.seats.find((s)=>s.playerId===info.playerId)?.resumeToken || undefined }, msg.id));
        emitViews();
        return;
      }

      // RECLAIM: if a seat is already occupied by the same name but the prior client is gone,
      // allow the player to reclaim that seat (useful if localStorage token was lost or a first-join glitch happened).
      const nameKey = playerName.toLowerCase();
      const canReclaim = (s) => !!s && s.occupied && (s.playerName || "").toLowerCase() === nameKey && !isPlayerConnected(s.playerId);
      let reclaimSeat = null;
      if (Number.isFinite(requestedSeat) && requestedSeat >= 1 && requestedSeat <= session.seats.length) {
        const cand = session.seats[requestedSeat - 1];
        if (canReclaim(cand)) reclaimSeat = cand;
      }
      if (!reclaimSeat) {
        const byName = session.seats.find((s) => canReclaim(s)) || null;
        if (byName) reclaimSeat = byName;
      }
      if (reclaimSeat) {
        const token = uuid();
        reclaimSeat.resumeToken = token;
        info.playerId = reclaimSeat.playerId;
        info.seat = reclaimSeat.seat;
        // Make sure the game has a hero for this player.
        ensureGameFor(reclaimSeat.playerId, reclaimSeat.seat - 1);
        send(ws, makeMsg(MsgType.OK, { playerId: reclaimSeat.playerId, seat: reclaimSeat.seat, resumeToken: token, reclaimed: true }, msg.id));
        emitViews();
        return;
      }

      // normal seat selection
      

      let seatObj = null;
      if (Number.isFinite(requestedSeat) && requestedSeat >= 1 && requestedSeat <= session.seats.length) {
        const candidate = session.seats[requestedSeat - 1];
        if (!candidate.occupied) seatObj = candidate;
      }
      if (!seatObj) seatObj = session.seats.find((s) => !s.occupied) ?? null;
      if (!seatObj) return reject(ws, msg.id, "NO_SEATS", "No seats available");

      const playerId = uuid().slice(0, 8);
      const token = uuid();

      seatObj.occupied = true;
      seatObj.playerName = playerName;
      seatObj.playerId = playerId;
      seatObj.resumeToken = token;

      info.playerId = playerId;
      info.seat = seatObj.seat;

      ensureGameFor(playerId, seatObj.seat - 1);
      game.log.push({ at: Date.now(), msg: `Player joined: ${playerName} (${playerId.slice(0, 4)})` });

      send(ws, makeMsg(MsgType.OK, { playerId, seat: seatObj.seat, resumeToken: token }, msg.id));
      emitViews();
      return;
    }

    if (msg.t === MsgType.ACTION) {
      if (info.role === Role.TABLE) {
        reject(ws, msg.id, "TABLE_FORBIDDEN", "Table is view-only. Move from your phone.");
        return;
      }

      if (info.role === Role.PHONE) {
        if (!info.playerId) return reject(ws, msg.id, "NOT_JOINED", "Join a seat first.");
        handleAction(ws, msg.id, info.playerId, msg.payload);
        return;
      }

      reject(ws, msg.id, "BAD_ROLE", "Unknown client role");
      return;
    }

    reject(ws, msg.id, "UNKNOWN_TYPE", `Unknown type ${msg.t}`);
  }

  console.log(`WebSocket server ready. Session=${session.sessionId} Join=${getJoinUrl()}`);
}
