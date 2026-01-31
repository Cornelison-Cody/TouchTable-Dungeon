import { WebSocketServer } from "ws";
import { v4 as uuid } from "uuid";
import os from "os";
import { MsgType, Role, PROTOCOL_VERSION, makeMsg } from "../shared/protocol.js";
import {
  ActionType,
  makeInitialGameState,
  manhattan,
  nextActivePlayer,
  spawnHeroForPlayer,
  ensurePlayerInTurnOrder,
  isHeroAlive
} from "../shared/game.js";

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
      game.log.push({ at: Date.now(), msg: "Encounter started." });
      game.log.push({ at: Date.now(), msg: `Turn: ${playerId.slice(0, 4)}.` });
    } else {
      ensurePlayerInTurnOrder(game, playerId);
    }
    spawnHeroForPlayer(game, playerId, seatIndex0);
  }

  function computePublicState() {
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
            turn: { activePlayerId: game.turn.activePlayerId, order: game.turn.order },
            heroes: Object.values(game.heroes).map((h) => ({
              ownerPlayerId: h.ownerPlayerId,
              x: h.x,
              y: h.y,
              hp: h.hp,
              maxHp: h.maxHp
            })),
            enemy: { x: game.enemy.x, y: game.enemy.y, hp: game.enemy.hp, maxHp: game.enemy.maxHp },
            rules: { moveRange: game.rules.moveRange, attackRange: game.rules.attackRange },
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
            hero: hero ? { x: hero.x, y: hero.y, hp: hero.hp, maxHp: hero.maxHp } : null,
            enemy: { x: game.enemy.x, y: game.enemy.y, hp: game.enemy.hp, maxHp: game.enemy.maxHp },
            rules: { moveRange: game.rules.moveRange, attackRange: game.rules.attackRange },
            allowedActions: isActive && hero && hero.hp > 0 ? [ActionType.ATTACK, ActionType.END_TURN] : []
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
    game.log.push({ at: Date.now(), msg: `Enemy hits ${target.ownerPlayerId.slice(0, 4)} for ${game.rules.enemyDamage}.` });
    if (target.hp <= 0) game.log.push({ at: Date.now(), msg: `Hero ${target.ownerPlayerId.slice(0, 4)} is down!` });
  }

  function handleMove(ws, id, actorPlayerId, params) {
    if (!requireActive(ws, id, actorPlayerId)) return;
    const hero = game.heroes[actorPlayerId];
    if (!hero || hero.hp <= 0) return reject(ws, id, "HERO_DOWN", "Hero is down.");

    const toX = Number(params.toX);
    const toY = Number(params.toY);
    if (!Number.isFinite(toX) || !Number.isFinite(toY)) return reject(ws, id, "BAD_PARAMS", "MOVE requires toX/toY.");

    const nx = clamp(Math.floor(toX), 0, game.grid.w - 1);
    const ny = clamp(Math.floor(toY), 0, game.grid.h - 1);

    const dist = Math.abs(nx - hero.x) + Math.abs(ny - hero.y);
    if (dist > game.rules.moveRange) return reject(ws, id, "OUT_OF_RANGE", `Move too far (range ${game.rules.moveRange}).`);

    if (nx === game.enemy.x && ny === game.enemy.y && game.enemy.hp > 0) return reject(ws, id, "BLOCKED", "Cell occupied by enemy.");
    if (cellOccupiedByOtherHero(nx, ny, actorPlayerId)) return reject(ws, id, "BLOCKED", "Cell occupied by another hero.");

    hero.x = nx; hero.y = ny;
    game.log.push({ at: Date.now(), msg: `Hero ${actorPlayerId.slice(0, 4)} moves to (${nx},${ny}).` });
    send(ws, makeMsg(MsgType.OK, { accepted: true }, id));
    emitViews();
  }

  function handleAttack(ws, id, actorPlayerId) {
    if (!requireActive(ws, id, actorPlayerId)) return;
    const hero = game.heroes[actorPlayerId];
    if (!hero || hero.hp <= 0) return reject(ws, id, "HERO_DOWN", "Hero is down.");
    if (game.enemy.hp <= 0) return reject(ws, id, "ENEMY_DEAD", "Enemy already defeated.");

    const dist = manhattan(hero, game.enemy);
    if (dist > game.rules.attackRange) return reject(ws, id, "OUT_OF_RANGE", `Enemy out of range (range ${game.rules.attackRange}).`);

    game.enemy.hp = clamp(game.enemy.hp - game.rules.heroDamage, 0, game.enemy.maxHp);
    game.log.push({ at: Date.now(), msg: `Hero ${actorPlayerId.slice(0, 4)} attacks for ${game.rules.heroDamage}.` });
    if (game.enemy.hp <= 0) game.log.push({ at: Date.now(), msg: "Enemy defeated!" });

    send(ws, makeMsg(MsgType.OK, { accepted: true }, id));
    emitViews();
  }

  function handleEndTurn(ws, id, actorPlayerId) {
    if (!requireActive(ws, id, actorPlayerId)) return;

    game.log.push({ at: Date.now(), msg: `Hero ${actorPlayerId.slice(0, 4)} ends turn.` });
    enemyAutoAttack();

    const next = nextActivePlayer(game);
    game.log.push({ at: Date.now(), msg: next ? `Turn: ${next.slice(0, 4)}.` : "No heroes left standing." });

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
    const clientId = uuid();
    clients.set(ws, { clientId, role: null, playerId: null, seat: null });

    ws.on("message", (data) => {
      try {
        handleMessage(ws, JSON.parse(data.toString()));
      } catch {
        send(ws, makeMsg(MsgType.ERROR, { code: "BAD_JSON", message: "Bad JSON" }));
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
      if (!playerName) return reject(ws, msg.id, "BAD_NAME", "playerName required");

      if (info.playerId) {
        send(ws, makeMsg(MsgType.OK, { playerId: info.playerId, seat: info.seat }, msg.id));
        emitViews();
        return;
      }

      const requestedSeat = Number(msg.payload?.seat);
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
        const action = msg.payload?.action;
        if (action !== ActionType.MOVE) return reject(ws, msg.id, "TABLE_FORBIDDEN", "Table can only MOVE.");
        const actor = game?.turn?.activePlayerId ?? null;
        if (!actor) return reject(ws, msg.id, "NO_ACTIVE_PLAYER", "No active player.");
        handleAction(ws, msg.id, actor, msg.payload);
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
