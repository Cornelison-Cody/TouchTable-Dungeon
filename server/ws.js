import { WebSocketServer } from "ws";
import { v4 as uuid } from "uuid";
import os from "os";
import { MsgType, Role, PROTOCOL_VERSION, makeMsg } from "../shared/protocol.js";
import { ActionType, makeInitialGameState, manhattan } from "../shared/game.js";

/**
 * Milestone 2: minimal encounter loop
 * - Table renders a grid + tokens
 * - Phone can ATTACK / END_TURN (MOVE is by table touch)
 * - Server validates all actions and broadcasts updated views
 */

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

  // Single minimal game state (created when first player joins)
  let game = null;

  const clients = new Map(); // ws -> { clientId, role, playerId?, seat? }

  function send(ws, msg) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  function getJoinUrl() {
    const host = getLanAddress();
    return `http://${host}:5174/?session=${session.sessionId}`;
  }

  function computePublicState() {
    return {
      sessionId: session.sessionId,
      seats: session.seats.map((s) => ({
        seat: s.seat,
        occupied: s.occupied,
        playerName: s.playerName
      })),
      game: game
        ? {
            grid: game.grid,
            turn: { activePlayerId: game.turn.activePlayerId },
            entities: {
              hero: { x: game.entities.hero.x, y: game.entities.hero.y, hp: game.entities.hero.hp, maxHp: game.entities.hero.maxHp },
              enemy: { x: game.entities.enemy.x, y: game.entities.enemy.y, hp: game.entities.enemy.hp, maxHp: game.entities.enemy.maxHp }
            },
            log: game.log.slice(-5)
          }
        : null
    };
  }

  function computePrivateState(playerId) {
    const seat = session.seats.find((s) => s.playerId === playerId);
    const isActive = game?.turn.activePlayerId === playerId;

    return {
      sessionId: session.sessionId,
      player: seat ? { playerId, seat: seat.seat, playerName: seat.playerName } : null,
      game: game
        ? {
            youAreActive: isActive,
            hero: { hp: game.entities.hero.hp, maxHp: game.entities.hero.maxHp },
            // Future: hand, inventory, abilities, secret flags, etc.
            allowedActions: isActive ? [ActionType.ATTACK, ActionType.END_TURN] : []
          }
        : null,
      privateNotes: "Private state stub (Milestone 2)."
    };
  }

  function emitViews() {
    if (tableWs) {
      send(tableWs, makeMsg(MsgType.STATE_PUBLIC, { state: computePublicState() }));
    }
    for (const [ws, info] of clients.entries()) {
      if (info.role === Role.PHONE && info.playerId) {
        send(ws, makeMsg(MsgType.STATE_PRIVATE, { state: computePrivateState(info.playerId) }));
      }
    }
  }

  function ensureGameFor(playerId) {
    if (!game) {
      game = makeInitialGameState(playerId);
      game.log.push({ at: Date.now(), msg: "Encounter started." });
    }
  }

  function reject(ws, id, code, message) {
    send(ws, makeMsg(MsgType.ERROR, { code, message }, id));
  }

  function requireActivePlayer(ws, id, info) {
    if (!game) return false;
    if (game.turn.activePlayerId !== info.playerId) {
      reject(ws, id, "NOT_YOUR_TURN", "Not your turn.");
      return false;
    }
    return true;
  }

  function applyEnemyAutoAttack() {
    // Very simple: if adjacent to hero, enemy hits for 1.
    if (!game) return;
    const hero = game.entities.hero;
    const enemy = game.entities.enemy;
    if (enemy.hp <= 0 || hero.hp <= 0) return;

    const dist = manhattan(hero, enemy);
    if (dist <= game.rules.attackRange) {
      hero.hp = clamp(hero.hp - game.rules.enemyDamage, 0, hero.maxHp);
      game.log.push({ at: Date.now(), msg: `Enemy hits hero for ${game.rules.enemyDamage}.` });
      if (hero.hp <= 0) game.log.push({ at: Date.now(), msg: "Hero is down!" });
    } else {
      game.log.push({ at: Date.now(), msg: "Enemy waits." });
    }
  }

  function handleAction(ws, id, info, payload) {
    if (!game) {
      reject(ws, id, "NO_GAME", "No game started yet. Join a seat first.");
      return;
    }
    if (!requireActivePlayer(ws, id, info)) return;

    const action = payload?.action;
    const params = payload?.params ?? {};
    const hero = game.entities.hero;
    const enemy = game.entities.enemy;

    if (hero.hp <= 0) {
      reject(ws, id, "HERO_DOWN", "Hero is down.");
      return;
    }

    if (enemy.hp <= 0 && action !== ActionType.END_TURN) {
      reject(ws, id, "ENEMY_DEAD", "Enemy already defeated. End turn.");
      return;
    }

    if (action === ActionType.MOVE) {
      const toX = Number(params.toX);
      const toY = Number(params.toY);
      if (!Number.isFinite(toX) || !Number.isFinite(toY)) {
        reject(ws, id, "BAD_PARAMS", "MOVE requires toX/toY.");
        return;
      }

      const nx = clamp(Math.floor(toX), 0, game.grid.w - 1);
      const ny = clamp(Math.floor(toY), 0, game.grid.h - 1);

      const dist = Math.abs(nx - hero.x) + Math.abs(ny - hero.y);
      if (dist > game.rules.moveRange) {
        reject(ws, id, "OUT_OF_RANGE", `Move too far (range ${game.rules.moveRange}).`);
        return;
      }

      // Block moving onto enemy
      if (nx === enemy.x && ny === enemy.y && enemy.hp > 0) {
        reject(ws, id, "BLOCKED", "Cell occupied by enemy.");
        return;
      }

      hero.x = nx;
      hero.y = ny;
      game.log.push({ at: Date.now(), msg: `Hero moves to (${nx},${ny}).` });
      send(ws, makeMsg(MsgType.OK, { accepted: true }, id));
      emitViews();
      return;
    }

    if (action === ActionType.ATTACK) {
      const dist = manhattan(hero, enemy);
      if (dist > game.rules.attackRange) {
        reject(ws, id, "OUT_OF_RANGE", `Enemy out of range (range ${game.rules.attackRange}).`);
        return;
      }

      enemy.hp = clamp(enemy.hp - game.rules.heroDamage, 0, enemy.maxHp);
      game.log.push({ at: Date.now(), msg: `Hero attacks for ${game.rules.heroDamage}.` });
      if (enemy.hp <= 0) game.log.push({ at: Date.now(), msg: "Enemy defeated!" });

      send(ws, makeMsg(MsgType.OK, { accepted: true }, id));
      emitViews();
      return;
    }

    if (action === ActionType.END_TURN) {
      game.log.push({ at: Date.now(), msg: "Hero ends turn." });

      // Enemy simple reaction
      applyEnemyAutoAttack();

      send(ws, makeMsg(MsgType.OK, { accepted: true }, id));
      emitViews();
      return;
    }

    reject(ws, id, "UNKNOWN_ACTION", `Unknown action: ${action}`);
  }

  wss.on("connection", (ws) => {
    const clientId = uuid();
    clients.set(ws, { clientId, role: null, playerId: null, seat: null });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        handleMessage(ws, msg);
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

    switch (msg.t) {
      case MsgType.PING: {
        send(ws, makeMsg(MsgType.OK, { pong: true }, msg.id));
        return;
      }

      case MsgType.HELLO: {
        const role = msg.payload?.role;
        if (role !== Role.TABLE && role !== Role.PHONE) {
          reject(ws, msg.id, "BAD_ROLE", "role must be 'table' or 'phone'");
          return;
        }

        info.role = role;

        const resumeToken = msg.payload?.resumeToken;
        if (role === Role.PHONE && resumeToken) {
          const seat = session.seats.find((s) => s.resumeToken === resumeToken);
          if (seat) {
            info.playerId = seat.playerId;
            info.seat = seat.seat;
            ensureGameFor(seat.playerId);
          }
        }

        if (role === Role.TABLE) tableWs = ws;

        send(ws, makeMsg(MsgType.OK, { clientId: info.clientId }, msg.id));

        if (role === Role.TABLE) {
          send(ws, makeMsg(MsgType.SESSION_INFO, { sessionId: session.sessionId, joinUrl: getJoinUrl() }));
        }

        emitViews();
        return;
      }

      case MsgType.JOIN: {
        if (info.role !== Role.PHONE) {
          reject(ws, msg.id, "NOT_PHONE", "Only phones can JOIN");
          return;
        }

        const playerName = (msg.payload?.playerName ?? "").toString().trim().slice(0, 32);
        if (!playerName) {
          reject(ws, msg.id, "BAD_NAME", "playerName required");
          return;
        }

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

        if (!seatObj) {
          reject(ws, msg.id, "NO_SEATS", "No seats available");
          return;
        }

        const playerId = uuid().slice(0, 8);
        const token = uuid();

        seatObj.occupied = true;
        seatObj.playerName = playerName;
        seatObj.playerId = playerId;
        seatObj.resumeToken = token;

        info.playerId = playerId;
        info.seat = seatObj.seat;

        ensureGameFor(playerId);

        send(ws, makeMsg(MsgType.OK, { playerId, seat: seatObj.seat, resumeToken: token }, msg.id));
        emitViews();
        return;
      }

      case MsgType.ACTION: {
        if (info.role !== Role.PHONE && info.role !== Role.TABLE) {
          reject(ws, msg.id, "BAD_ROLE", "Unknown client role");
          return;
        }
        // If table sends an action, it must specify which player's hero it controls later.
        // For Milestone 2, we allow table to MOVE the hero for the active player.
        if (info.role === Role.TABLE) {
          // Table is only allowed to MOVE (public interaction)
          const action = msg.payload?.action;
          if (action !== ActionType.MOVE) {
            reject(ws, msg.id, "TABLE_FORBIDDEN", "Table can only MOVE in Milestone 2.");
            return;
          }
          // Use active player as actor
          const actor = { ...info, playerId: game?.turn.activePlayerId ?? null };
          if (!actor.playerId) {
            reject(ws, msg.id, "NO_ACTIVE_PLAYER", "No active player.");
            return;
          }
          handleAction(ws, msg.id, actor, msg.payload);
          return;
        }

        // Phone actions come from its playerId
        if (!info.playerId) {
          reject(ws, msg.id, "NOT_JOINED", "Join a seat first.");
          return;
        }
        handleAction(ws, msg.id, info, msg.payload);
        return;
      }

      default:
        reject(ws, msg.id, "UNKNOWN_TYPE", `Unknown type ${msg.t}`);
    }
  }

  console.log(`WebSocket server ready. Session=${session.sessionId} Join=${getJoinUrl()}`);
}
