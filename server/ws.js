import { WebSocketServer } from "ws";
import { v4 as uuid } from "uuid";
import os from "os";
import { MsgType, Role, PROTOCOL_VERSION, makeMsg } from "../shared/protocol.js";
import { loadCampaignState, pickOrCreateCampaignPlayer, saveCampaignState } from "./campaign-store.js";
import {
  ActionType,
  firstLivingEnemy,
  findNearestPassableHex,
  hexNeighbors,
  isTerrainPassable,
  livingEnemies,
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
  const campaign = loadCampaignState();
  let tableWs = null;
  let game = campaign.activeGame || null;
  const gameHistory = [];

  const clients = new Map(); // ws -> { clientId, role, playerId?, seat? }

  function ensureGameShape() {
    if (!game) return;
    if (!Array.isArray(game.enemies)) {
      game.enemies = game.enemy ? [game.enemy] : [];
      delete game.enemy;
    }
    if (!game.scenario) {
      game.scenario = {
        id: "scenario-1",
        title: "Scenario 1: Rift Breach",
        objective: { type: "defeat", targetCount: 2 },
        defeatedCount: 0,
        status: "active"
      };
    }
  }

  function saveCampaignSnapshot() {
    ensureGameShape();
    campaign.activeGame = game ? cloneGameState(game) : null;
    saveCampaignState(campaign);
  }

  ensureGameShape();

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
      gameHistory.length = 0;
      resetTurnAP(game);
      game.log.push({ at: Date.now(), msg: "Encounter started." });
      game.log.push({ at: Date.now(), msg: `Turn: ${shortName(playerId)}.` });
    } else {
      ensurePlayerInTurnOrder(game, playerId);
    }
    spawnHeroForPlayer(game, playerId, seatIndex0);
  }

  function computePublicState() {
    ensureGameShape();
    const nameById = new Map(session.seats.filter((s) => s.playerId).map((s) => [s.playerId, s.playerName]));
    const campaignNameById = new Map((campaign.players || []).map((p) => [p.id, p.name]));
    const primaryEnemy = game ? firstLivingEnemy(game) : null;
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
            terrain: game.terrain ? { seed: game.terrain.seed, theme: game.terrain.theme } : null,
            scenario: game.scenario
              ? {
                  id: game.scenario.id,
                  title: game.scenario.title,
                  objective: game.scenario.objective,
                  defeatedCount: game.scenario.defeatedCount,
                  status: game.scenario.status
                }
              : null,
            campaign: {
              id: campaign.id,
              title: campaign.title,
              currentScenarioId: campaign.progression?.currentScenarioId || null,
              victories: campaign.progression?.victories || 0
            },
            turn: { activePlayerId: game.turn.activePlayerId, activePlayerName: nameById.get(game.turn.activePlayerId) || campaignNameById.get(game.turn.activePlayerId) || null, order: game.turn.order, apRemaining: game.turn.apRemaining, apMax: game.turn.apMax },
            heroes: Object.values(game.heroes).map((h) => ({
              ownerPlayerId: h.ownerPlayerId,
              ownerPlayerName: nameById.get(h.ownerPlayerId) || campaignNameById.get(h.ownerPlayerId) || null,
              x: h.x,
              y: h.y,
              hp: h.hp,
              maxHp: h.maxHp
            })),
            enemies: (game.enemies || []).map((enemyUnit) => ({
              id: enemyUnit.id,
              name: enemyUnit.name || null,
              art: enemyUnit.art || null,
              flavor: enemyUnit.flavor || null,
              attackPower: enemyUnit.attackPower ?? game.rules.enemyDamage,
              x: enemyUnit.x,
              y: enemyUnit.y,
              hp: enemyUnit.hp,
              maxHp: enemyUnit.maxHp
            })),
            enemy: primaryEnemy
              ? {
                  id: primaryEnemy.id,
                  name: primaryEnemy.name || null,
                  art: primaryEnemy.art || null,
                  flavor: primaryEnemy.flavor || null,
                  attackPower: primaryEnemy.attackPower ?? game.rules.enemyDamage,
                  x: primaryEnemy.x,
                  y: primaryEnemy.y,
                  hp: primaryEnemy.hp,
                  maxHp: primaryEnemy.maxHp
                }
              : null,
            rules: { moveRange: game.rules.moveRange, attackRange: game.rules.attackRange, actionPointsPerTurn: game.rules.actionPointsPerTurn },
            log: game.log.slice(-10)
          }
        : null
    };
  }

  function computePrivateState(playerId) {
    ensureGameShape();
    const seat = session.seats.find((s) => s.playerId === playerId);
    const isActive = game?.turn.activePlayerId === playerId;
    const hero = game?.heroes?.[playerId] ?? null;
    const campaignNameById = new Map((campaign.players || []).map((p) => [p.id, p.name]));
    const primaryEnemy = game ? firstLivingEnemy(game) : null;
    const scenarioWon = game?.scenario?.status === "victory";

    return {
      sessionId: session.sessionId,
      player: seat ? { playerId, seat: seat.seat, playerName: seat.playerName } : null,
      game: game
        ? {
            youAreActive: isActive,
            grid: game.grid,
            terrain: game.terrain ? { seed: game.terrain.seed, theme: game.terrain.theme } : null,
            scenario: game.scenario
              ? {
                  id: game.scenario.id,
                  title: game.scenario.title,
                  objective: game.scenario.objective,
                  defeatedCount: game.scenario.defeatedCount,
                  status: game.scenario.status
                }
              : null,
            campaign: {
              id: campaign.id,
              title: campaign.title,
              currentScenarioId: campaign.progression?.currentScenarioId || null,
              victories: campaign.progression?.victories || 0
            },
            rules: {
              moveRange: game.rules.moveRange,
              attackRange: game.rules.attackRange,
              actionPointsPerTurn: game.rules.actionPointsPerTurn
            },
            heroesPublic: Object.values(game.heroes).map((h) => ({
              ownerPlayerId: h.ownerPlayerId,
              ownerPlayerName:
                session.seats.find((s) => s.playerId === h.ownerPlayerId)?.playerName ||
                campaignNameById.get(h.ownerPlayerId) ||
                null,
              x: h.x,
              y: h.y,
              hp: h.hp,
              maxHp: h.maxHp
            })),
            hero: hero ? { x: hero.x, y: hero.y, hp: hero.hp, maxHp: hero.maxHp } : null,
            enemies: (game.enemies || []).map((enemyUnit) => ({
              id: enemyUnit.id,
              name: enemyUnit.name || null,
              art: enemyUnit.art || null,
              flavor: enemyUnit.flavor || null,
              attackPower: enemyUnit.attackPower ?? game.rules.enemyDamage,
              x: enemyUnit.x,
              y: enemyUnit.y,
              hp: enemyUnit.hp,
              maxHp: enemyUnit.maxHp
            })),
            enemy: primaryEnemy
              ? {
                  id: primaryEnemy.id,
                  name: primaryEnemy.name || null,
                  art: primaryEnemy.art || null,
                  flavor: primaryEnemy.flavor || null,
                  attackPower: primaryEnemy.attackPower ?? game.rules.enemyDamage,
                  x: primaryEnemy.x,
                  y: primaryEnemy.y,
                  hp: primaryEnemy.hp,
                  maxHp: primaryEnemy.maxHp
                }
              : null,
            apRemaining: game.turn.apRemaining,
            apMax: game.turn.apMax,
            lastHeroDamage:
              game.lastHeroDamage && game.lastHeroDamage.actorPlayerId === playerId
                ? {
                    amount: game.lastHeroDamage.amount,
                    enemyHp: game.lastHeroDamage.enemyHp,
                    enemyMaxHp: game.lastHeroDamage.enemyMaxHp,
                    at: game.lastHeroDamage.at
                  }
                : null,
            allowedActions:
              scenarioWon
                ? []
                : isActive && hero && hero.hp > 0 && (game.turn.apRemaining ?? 0) > 0
                ? [ActionType.MOVE, ActionType.ATTACK, ActionType.END_TURN]
                : isActive && hero && hero.hp > 0
                  ? [ActionType.END_TURN]
                  : []
          }
        : null
    };
  }

  function emitViews() {
    saveCampaignSnapshot();
    if (tableWs) send(tableWs, makeMsg(MsgType.STATE_PUBLIC, { state: computePublicState() }));
    for (const [ws, info] of clients.entries()) {
      if (info.role === Role.PHONE && info.playerId) {
        send(ws, makeMsg(MsgType.STATE_PRIVATE, { state: computePrivateState(info.playerId) }));
      }
    }
  }

  function cloneGameState(state) {
    return JSON.parse(JSON.stringify(state));
  }

  function pushGameHistory() {
    if (!game) return;
    gameHistory.push(cloneGameState(game));
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

  function enemyAt(x, y) {
    if (!game) return null;
    return (game.enemies || []).find((enemyUnit) => enemyUnit.hp > 0 && enemyUnit.x === x && enemyUnit.y === y) || null;
  }

  function cellOccupiedByLiveEnemy(x, y) {
    return Boolean(enemyAt(x, y));
  }

  function markEnemyDefeated(enemyUnit) {
    if (!game || !enemyUnit) return;
    const objectiveTarget = game?.scenario?.objective?.targetCount ?? 2;
    game.scenario.defeatedCount = (game.scenario.defeatedCount ?? 0) + 1;
    game.log.push({ at: Date.now(), msg: `${enemyUnit.name || "Monster"} defeated (${game.scenario.defeatedCount}/${objectiveTarget}).` });

    if (game.scenario.status !== "victory" && game.scenario.defeatedCount >= objectiveTarget) {
      game.scenario.status = "victory";
      game.log.push({ at: Date.now(), msg: "Scenario complete: Victory!" });
      campaign.progression = campaign.progression || {};
      campaign.progression.victories = (campaign.progression.victories || 0) + 1;
      const completed = Array.isArray(campaign.progression.completedScenarioIds) ? campaign.progression.completedScenarioIds : [];
      if (!completed.includes(game.scenario.id)) completed.push(game.scenario.id);
      campaign.progression.completedScenarioIds = completed;
      for (const pid of game.turn.order || []) {
        const player = (campaign.players || []).find((p) => p.id === pid);
        if (!player) continue;
        player.stats = player.stats || { victories: 0, scenariosCompleted: 0 };
        player.stats.victories = (player.stats.victories || 0) + 1;
        player.stats.scenariosCompleted = (player.stats.scenariosCompleted || 0) + 1;
      }
    }
  }

  function enemyTakeTurn() {
    if (!game) return;
    if (game.scenario?.status === "victory") return;
    const terrainSeed = game?.terrain?.seed ?? 0;

    const aliveHeroes = Object.values(game.heroes).filter((h) => isHeroAlive(h));
    if (!aliveHeroes.length) return;

    for (const enemyUnit of livingEnemies(game)) {
      const inRange = aliveHeroes.filter((h) => manhattan(h, enemyUnit) <= game.rules.attackRange);
      if (inRange.length) {
        const target = [...inRange].sort((a, b) => a.hp - b.hp || manhattan(a, enemyUnit) - manhattan(b, enemyUnit))[0];
        target.hp = clamp(target.hp - game.rules.enemyDamage, 0, target.maxHp);
        game.log.push({ at: Date.now(), msg: `${enemyUnit.name || "Enemy"} hits ${shortName(target.ownerPlayerId)} for ${game.rules.enemyDamage}.` });
        if (target.hp <= 0) game.log.push({ at: Date.now(), msg: `Hero ${shortName(target.ownerPlayerId)} is down!` });
        continue;
      }

      const occupiedByLiveHero = (x, y) => aliveHeroes.some((h) => h.x === x && h.y === y);
      const occupiedByOtherEnemy = (x, y) =>
        (game.enemies || []).some((e) => e.id !== enemyUnit.id && e.hp > 0 && e.x === x && e.y === y);
      const nearestHeroDistance = (pos) => {
        let best = Number.POSITIVE_INFINITY;
        for (const h of aliveHeroes) best = Math.min(best, manhattan(pos, h));
        return best;
      };

      const currentDist = nearestHeroDistance(enemyUnit);
      const candidates = hexNeighbors(enemyUnit.x, enemyUnit.y)
        .filter((p) => isTerrainPassable(p.x, p.y, terrainSeed))
        .filter((p) => !occupiedByLiveHero(p.x, p.y))
        .filter((p) => !occupiedByOtherEnemy(p.x, p.y));

      let bestStep = null;
      let bestDist = Number.POSITIVE_INFINITY;
      for (const p of candidates) {
        const d = nearestHeroDistance(p);
        if (d < bestDist || (d === bestDist && (bestStep === null || p.y < bestStep.y || (p.y === bestStep.y && p.x < bestStep.x)))) {
          bestDist = d;
          bestStep = p;
        }
      }

      if (bestStep && bestDist < currentDist) {
        enemyUnit.x = bestStep.x;
        enemyUnit.y = bestStep.y;
        game.log.push({ at: Date.now(), msg: `${enemyUnit.name || "Enemy"} moves to (${bestStep.x},${bestStep.y}).` });
      } else {
        game.log.push({ at: Date.now(), msg: `${enemyUnit.name || "Enemy"} waits.` });
      }
    }
  }

  function handleMove(ws, id, actorPlayerId, params) {
    if (!requireActive(ws, id, actorPlayerId)) return;
    if (game.scenario?.status === "victory") return reject(ws, id, "SCENARIO_COMPLETE", "Scenario already won.");
    // Action points
    if ((game.turn.apRemaining ?? 0) <= 0) return reject(ws, id, "NO_AP", "No actions remaining. End your turn.");
    const hero = game.heroes[actorPlayerId];
    if (!hero || hero.hp <= 0) return reject(ws, id, "HERO_DOWN", "Hero is down.");

    const toX = Number(params.toX);
    const toY = Number(params.toY);
    if (!Number.isFinite(toX) || !Number.isFinite(toY)) return reject(ws, id, "BAD_PARAMS", "MOVE requires toX/toY.");

    const nx = Math.floor(toX);
    const ny = Math.floor(toY);
    const terrainSeed = game?.terrain?.seed ?? 0;

    const dist = manhattan({ x: nx, y: ny }, hero);
    if (dist > game.rules.moveRange) return reject(ws, id, "OUT_OF_RANGE", `Move too far (range ${game.rules.moveRange}).`);
    if (!isTerrainPassable(nx, ny, terrainSeed)) return reject(ws, id, "BLOCKED", "Cell is blocked terrain.");

    if (cellOccupiedByLiveEnemy(nx, ny)) return reject(ws, id, "BLOCKED", "Cell occupied by enemy.");
    if (cellOccupiedByOtherHero(nx, ny, actorPlayerId)) return reject(ws, id, "BLOCKED", "Cell occupied by another hero.");

    pushGameHistory();
    hero.x = nx; hero.y = ny;
    game.log.push({ at: Date.now(), msg: `Hero ${shortName(actorPlayerId)} moves to (${nx},${ny}).` });
    game.turn.apRemaining = Math.max(0, (game.turn.apRemaining ?? 0) - 1);
    send(ws, makeMsg(MsgType.OK, { accepted: true }, id));
    emitViews();
  }

  function handleAttack(ws, id, actorPlayerId) {
    if (!requireActive(ws, id, actorPlayerId)) return;
    if (game.scenario?.status === "victory") return reject(ws, id, "SCENARIO_COMPLETE", "Scenario already won.");
    // Action points
    if ((game.turn.apRemaining ?? 0) <= 0) return reject(ws, id, "NO_AP", "No actions remaining. End your turn.");
    const hero = game.heroes[actorPlayerId];
    if (!hero || hero.hp <= 0) return reject(ws, id, "HERO_DOWN", "Hero is down.");
    const targets = livingEnemies(game)
      .map((enemyUnit) => ({ enemyUnit, dist: manhattan(hero, enemyUnit) }))
      .filter((x) => x.dist <= game.rules.attackRange)
      .sort((a, b) => a.enemyUnit.hp - b.enemyUnit.hp || a.dist - b.dist || a.enemyUnit.id.localeCompare(b.enemyUnit.id));
    if (!targets.length) return reject(ws, id, "OUT_OF_RANGE", `No enemy in range (range ${game.rules.attackRange}).`);
    const target = targets[0].enemyUnit;

    pushGameHistory();
    const enemyHpBefore = target.hp;
    target.hp = clamp(target.hp - game.rules.heroDamage, 0, target.maxHp);
    const dealt = enemyHpBefore - target.hp;
    game.lastHeroDamage = {
      actorPlayerId,
      amount: dealt,
      enemyId: target.id,
      enemyHp: target.hp,
      enemyMaxHp: target.maxHp,
      at: Date.now()
    };
    game.log.push({ at: Date.now(), msg: `Hero ${shortName(actorPlayerId)} attacks ${target.name || "enemy"} for ${game.rules.heroDamage}.` });
    game.turn.apRemaining = Math.max(0, (game.turn.apRemaining ?? 0) - 1);
    if (target.hp <= 0) markEnemyDefeated(target);

    send(ws, makeMsg(MsgType.OK, { accepted: true }, id));
    emitViews();
  }

  function handleEndTurn(ws, id, actorPlayerId) {
    if (!requireActive(ws, id, actorPlayerId)) return;
    if (game.scenario?.status === "victory") return reject(ws, id, "SCENARIO_COMPLETE", "Scenario already won.");

    pushGameHistory();
    game.log.push({ at: Date.now(), msg: `Hero ${shortName(actorPlayerId)} ends turn.` });
    enemyTakeTurn();

    const next = nextActivePlayer(game);
    game.log.push({ at: Date.now(), msg: next ? `Turn: ${shortName(next)}.` : "No heroes left standing." });

    send(ws, makeMsg(MsgType.OK, { accepted: true }, id));
    emitViews();
  }

  function setNextActiveFrom(startIdx0) {
    if (!game) return null;
    const order = game.turn.order || [];
    if (!order.length) {
      game.turn.activePlayerId = null;
      game.turn.activeIndex = 0;
      return null;
    }

    const n = order.length;
    for (let step = 0; step < n; step += 1) {
      const idx = (startIdx0 + step + n) % n;
      const pid = order[idx];
      if (isHeroAlive(game.heroes[pid])) {
        game.turn.activeIndex = idx;
        game.turn.activePlayerId = pid;
        resetTurnAP(game);
        return pid;
      }
    }

    game.turn.activePlayerId = null;
    game.turn.activeIndex = 0;
    return null;
  }

  function occupiedCampaignPlayerIds() {
    const ids = new Set();
    for (const s of session.seats) {
      if (s.occupied && s.playerId) ids.add(s.playerId);
    }
    return ids;
  }

  function assignSeatToCampaignPlayer(seatObj, campaignPlayer, info) {
    const token = uuid();
    seatObj.occupied = true;
    seatObj.playerName = campaignPlayer.name;
    seatObj.playerId = campaignPlayer.id;
    seatObj.resumeToken = token;
    info.playerId = campaignPlayer.id;
    info.seat = seatObj.seat;
    ensureGameFor(campaignPlayer.id, seatObj.seat - 1);
    game.log.push({ at: Date.now(), msg: `Player joined campaign: ${campaignPlayer.name} (${campaignPlayer.id.slice(0, 4)})` });
    saveCampaignState(campaign);
    return token;
  }

  function handleSpawnEnemy(ws, id) {
    if (!game) return reject(ws, id, "NO_GAME", "No game started yet. Join a seat first.");
    if (game.scenario?.status === "victory") return reject(ws, id, "SCENARIO_COMPLETE", "Scenario already won.");

    const terrainSeed = game?.terrain?.seed ?? 0;
    const occupied = new Set(
      Object.values(game.heroes)
        .filter((h) => isHeroAlive(h))
        .map((h) => `${h.x},${h.y}`)
    );
    for (const enemyUnit of livingEnemies(game)) occupied.add(`${enemyUnit.x},${enemyUnit.y}`);
    const anchor =
      game.heroes[game.turn.activePlayerId] ||
      Object.values(game.heroes).find((h) => isHeroAlive(h)) ||
      { x: 0, y: 0 };
    const target = {
      x: anchor.x + Math.floor(Math.random() * 13) - 6,
      y: anchor.y + Math.floor(Math.random() * 13) - 6
    };
    const spawn = findNearestPassableHex(target.x, target.y, terrainSeed, (x, y) => occupied.has(`${x},${y}`), 48);
    if (occupied.has(`${spawn.x},${spawn.y}`) || !isTerrainPassable(spawn.x, spawn.y, terrainSeed)) {
      return reject(ws, id, "NO_SPACE", "No free passable hexes to spawn enemy.");
    }

    pushGameHistory();
    const enemyNumber = (game.enemies?.length || 0) + 1;
    game.enemies = game.enemies || [];
    game.enemies.push({
      id: `enemy-${enemyNumber}`,
      name: "Rift Stalker",
      art: "RST",
      flavor: "A warped predator that lunges from weak points in the veil.",
      attackPower: game.rules.enemyDamage,
      x: spawn.x,
      y: spawn.y,
      hp: 6,
      maxHp: 6
    });
    game.lastHeroDamage = null;
    game.log.push({ at: Date.now(), msg: `Monster spawned at (${spawn.x},${spawn.y}) by table.` });

    send(ws, makeMsg(MsgType.OK, { accepted: true, spawn }, id));
    emitViews();
  }

  function handleUndo(ws, id) {
    if (!game) return reject(ws, id, "NO_GAME", "No game started yet. Join a seat first.");
    if (!gameHistory.length) return reject(ws, id, "NO_UNDO", "No previous actions to undo.");

    game = gameHistory.pop();
    ensureGameShape();
    send(ws, makeMsg(MsgType.OK, { accepted: true, undone: true, historyDepth: gameHistory.length }, id));
    emitViews();
  }

  function handleKickPlayer(ws, id, payload) {
    const targetPlayerId = (payload?.playerId ?? "").toString().trim();
    const targetSeat = Number(payload?.seat);

    let seatObj = null;
    if (targetPlayerId) {
      seatObj = session.seats.find((s) => s.playerId === targetPlayerId) || null;
    } else if (Number.isFinite(targetSeat) && targetSeat >= 1 && targetSeat <= session.seats.length) {
      seatObj = session.seats[targetSeat - 1] || null;
    }

    if (!seatObj || !seatObj.occupied || !seatObj.playerId) {
      return reject(ws, id, "NOT_FOUND", "Player/seat not found.");
    }

    const playerId = seatObj.playerId;
    const playerName = seatObj.playerName || shortName(playerId);
    const seatNo = seatObj.seat;

    // Clear seat reservation first so reconnect tokens cannot reclaim it.
    seatObj.occupied = false;
    seatObj.playerName = null;
    seatObj.playerId = null;
    seatObj.resumeToken = null;

    // Disconnect gameplay ownership for any connected phone clients.
    for (const [clientWs, info] of clients.entries()) {
      if (info.role === Role.PHONE && info.playerId === playerId) {
        info.playerId = null;
        info.seat = null;
        send(clientWs, makeMsg(MsgType.ERROR, { code: "KICKED", message: "You were removed from the session by the table." }, "kicked"));
        send(clientWs, makeMsg(MsgType.STATE_PRIVATE, { state: { sessionId: session.sessionId, player: null, game: null } }));
      }
    }

    if (game) {
      const removedOrderIdx = game.turn.order.indexOf(playerId);
      const wasActive = game.turn.activePlayerId === playerId;

      delete game.heroes[playerId];
      game.turn.order = game.turn.order.filter((pid) => pid !== playerId && !!game.heroes[pid]);

      if (!game.turn.order.length) {
        game.turn.activePlayerId = null;
        game.turn.activeIndex = 0;
      } else if (wasActive) {
        const start = Math.max(0, Math.min(removedOrderIdx, game.turn.order.length - 1));
        const next = setNextActiveFrom(start);
        game.log.push({ at: Date.now(), msg: `Player removed: ${playerName} (seat ${seatNo}).` });
        game.log.push({ at: Date.now(), msg: next ? `Turn: ${shortName(next)}.` : "No heroes left standing." });
      } else {
        const activeIdx = game.turn.order.indexOf(game.turn.activePlayerId);
        if (activeIdx >= 0) {
          game.turn.activeIndex = activeIdx;
          game.log.push({ at: Date.now(), msg: `Player removed: ${playerName} (seat ${seatNo}).` });
        } else {
          const start = Math.max(0, Math.min(removedOrderIdx, game.turn.order.length - 1));
          const next = setNextActiveFrom(start);
          game.log.push({ at: Date.now(), msg: `Player removed: ${playerName} (seat ${seatNo}).` });
          game.log.push({ at: Date.now(), msg: next ? `Turn: ${shortName(next)}.` : "No heroes left standing." });
        }
      }
    }

    send(ws, makeMsg(MsgType.OK, { accepted: true, removed: { playerId, seat: seatNo } }, id));
    emitViews();
  }

  function handleAction(ws, id, actorPlayerId, payload) {
    if (!game) return reject(ws, id, "NO_GAME", "No game started yet. Join a seat first.");
    ensureGameShape();

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
      if (info?.role === Role.PHONE && info.seat) {
        const seatObj = session.seats[info.seat - 1];
        if (seatObj && seatObj.playerId === info.playerId) {
          seatObj.occupied = false;
          seatObj.playerName = null;
          seatObj.playerId = null;
          seatObj.resumeToken = null;
        }
      }
      clients.delete(ws);
      emitViews();
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

      const nameKey = playerName.toLowerCase();
      const canReclaim = (s) => !!s && s.occupied && (s.playerName || "").toLowerCase() === nameKey && !isPlayerConnected(s.playerId);
      let reclaimSeat = null;
      if (Number.isFinite(requestedSeat) && requestedSeat >= 1 && requestedSeat <= session.seats.length) {
        const cand = session.seats[requestedSeat - 1];
        if (canReclaim(cand)) reclaimSeat = cand;
      }
      if (!reclaimSeat) reclaimSeat = session.seats.find((s) => canReclaim(s)) || null;
      if (reclaimSeat) {
        const token = uuid();
        reclaimSeat.resumeToken = token;
        info.playerId = reclaimSeat.playerId;
        info.seat = reclaimSeat.seat;
        ensureGameFor(reclaimSeat.playerId, reclaimSeat.seat - 1);
        send(ws, makeMsg(MsgType.OK, { playerId: reclaimSeat.playerId, seat: reclaimSeat.seat, resumeToken: token, reclaimed: true }, msg.id));
        emitViews();
        return;
      }

      let seatObj = null;
      if (Number.isFinite(requestedSeat) && requestedSeat >= 1 && requestedSeat <= session.seats.length) {
        const candidate = session.seats[requestedSeat - 1];
        if (!candidate.occupied) seatObj = candidate;
      }
      if (!seatObj) seatObj = session.seats.find((s) => !s.occupied) ?? null;
      if (!seatObj) return reject(ws, msg.id, "NO_SEATS", "No seats available");

      const campaignPlayer = pickOrCreateCampaignPlayer(campaign, playerName, occupiedCampaignPlayerIds());
      const token = assignSeatToCampaignPlayer(seatObj, campaignPlayer, info);

      send(ws, makeMsg(MsgType.OK, { playerId: campaignPlayer.id, seat: seatObj.seat, resumeToken: token, campaignPlayerId: campaignPlayer.id }, msg.id));
      emitViews();
      return;
    }

    if (msg.t === MsgType.ACTION) {
      if (info.role === Role.TABLE) {
        const action = msg.payload?.action;
        if (action === ActionType.SPAWN_ENEMY) {
          handleSpawnEnemy(ws, msg.id);
          return;
        }
        if (action === ActionType.UNDO) {
          handleUndo(ws, msg.id);
          return;
        }
        if (action === ActionType.KICK_PLAYER) {
          handleKickPlayer(ws, msg.id, msg.payload?.params ?? {});
          return;
        }
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
