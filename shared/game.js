export const ActionType = Object.freeze({
  MOVE: "MOVE",
  ATTACK: "ATTACK",
  END_TURN: "END_TURN",
  SPAWN_ENEMY: "SPAWN_ENEMY",
  KICK_PLAYER: "KICK_PLAYER"
});

// Hex grid helpers (even-q vertical layout):
// - Coordinates are stored as (x,y) where x is column, y is row.
// - Neighbor offsets depend on x parity (even-q).

function offsetToCube(x, y) {
  const q = x;
  const r = y - Math.floor((x + 0) / 2);
  const cx = q;
  const cz = r;
  const cy = -cx - cz;
  return { x: cx, y: cy, z: cz };
}

export function hexDistance(a, b) {
  const ac = offsetToCube(a.x, a.y);
  const bc = offsetToCube(b.x, b.y);
  return Math.max(Math.abs(ac.x - bc.x), Math.abs(ac.y - bc.y), Math.abs(ac.z - bc.z));
}

// Back-compat name used elsewhere in the codebase.
export function manhattan(a, b) {
  return hexDistance(a, b);
}

export function hexNeighbors(x, y) {
  const even = (x % 2) === 0;
  const dirsEven = [
    { dx: +1, dy: 0 },
    { dx: +1, dy: -1 },
    { dx: 0, dy: -1 },
    { dx: -1, dy: -1 },
    { dx: -1, dy: 0 },
    { dx: 0, dy: +1 }
  ];
  const dirsOdd = [
    { dx: +1, dy: +1 },
    { dx: +1, dy: 0 },
    { dx: 0, dy: -1 },
    { dx: -1, dy: 0 },
    { dx: -1, dy: +1 },
    { dx: 0, dy: +1 }
  ];
  const dirs = even ? dirsEven : dirsOdd;
  return dirs.map((d) => ({ x: x + d.dx, y: y + d.dy }));
}

export function hexWithinRange(start, range, inBounds, isBlocked) {
  const key = (p) => `${p.x},${p.y}`;
  const q = [{ x: start.x, y: start.y, dist: 0 }];
  const seen = new Set([key(start)]);
  const out = new Set();
  while (q.length) {
    const cur = q.shift();
    if (cur.dist >= range) continue;
    for (const n of hexNeighbors(cur.x, cur.y)) {
      const k = key(n);
      if (seen.has(k)) continue;
      seen.add(k);
      if (!inBounds(n.x, n.y)) continue;
      const blocked = isBlocked ? isBlocked(n.x, n.y) : false;
      if (!blocked) out.add(k);
      if (!blocked) q.push({ x: n.x, y: n.y, dist: cur.dist + 1 });
    }
  }
  return out;
}

export function makeInitialGameState(firstPlayerId) {
  return {
    v: 1,
    grid: { w: 10, h: 7 },
    turn: {
      order: [firstPlayerId],
      activeIndex: 0,
      activePlayerId: firstPlayerId,
      apMax: 2,
      apRemaining: 2
    },
    heroes: {
      [firstPlayerId]: {
        id: `hero-${firstPlayerId}`,
        ownerPlayerId: firstPlayerId,
        x: 1,
        y: 1,
        hp: 10,
        maxHp: 10
      }
    },
    enemy: {
      id: "enemy-1",
      x: 7,
      y: 4,
      hp: 8,
      maxHp: 8
    },
    rules: {
      moveRange: 1,
      attackRange: 1,
      heroDamage: 2,
      enemyDamage: 1,
      actionPointsPerTurn: 2
    },
    log: []
  };
}

export function isHeroAlive(h) {
  return h && h.hp > 0;
}

export function ensurePlayerInTurnOrder(game, playerId) {
  if (!game.turn.order.includes(playerId)) game.turn.order.push(playerId);
}

export function spawnHeroForPlayer(game, playerId, seatIndex = 0) {
  if (game.heroes[playerId]) return;
  const x = 1;
  const y = 1 + (seatIndex % Math.max(1, game.grid.h - 2));
  game.heroes[playerId] = {
    id: `hero-${playerId}`,
    ownerPlayerId: playerId,
    x,
    y,
    hp: 10,
    maxHp: 10
  };
  ensurePlayerInTurnOrder(game, playerId);
}

export function nextActivePlayer(game) {
  if (!game.turn.order.length) return null;
  const n = game.turn.order.length;
  for (let step = 1; step <= n; step++) {
    const idx = (game.turn.activeIndex + step) % n;
    const pid = game.turn.order[idx];
    if (isHeroAlive(game.heroes[pid])) {
      game.turn.activeIndex = idx;
      game.turn.activePlayerId = pid;
      resetTurnAP(game);
      return pid;
    }
  }
  game.turn.activePlayerId = null;
  return null;
}


export function resetTurnAP(game) {
  const ap = game?.rules?.actionPointsPerTurn ?? game?.turn?.apMax ?? 2;
  game.turn.apMax = ap;
  game.turn.apRemaining = ap;
}
