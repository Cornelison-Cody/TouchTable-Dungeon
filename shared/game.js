export const ActionType = Object.freeze({
  MOVE: "MOVE",
  ATTACK: "ATTACK",
  END_TURN: "END_TURN",
  SPAWN_ENEMY: "SPAWN_ENEMY",
  KICK_PLAYER: "KICK_PLAYER",
  UNDO: "UNDO",
  NEW_CAMPAIGN: "NEW_CAMPAIGN"
});

export const TerrainClass = Object.freeze({
  GROUND: "ground",
  DIFFICULT: "difficult",
  HAZARD: "hazard",
  WATER: "water",
  OBSTACLE: "obstacle"
});

export const TERRAIN_META = Object.freeze({
  grassland: Object.freeze({
    id: "grassland",
    label: "Grassland",
    className: TerrainClass.GROUND,
    passable: true,
    moveCost: 1,
    fill: "rgba(56, 96, 66, 0.92)",
    stroke: "rgba(149, 188, 153, 0.22)",
    accent: "rgba(112, 174, 118, 0.35)"
  }),
  high_grass: Object.freeze({
    id: "high_grass",
    label: "High Grass",
    className: TerrainClass.GROUND,
    passable: true,
    moveCost: 1,
    fill: "rgba(69, 113, 74, 0.94)",
    stroke: "rgba(168, 199, 141, 0.26)",
    accent: "rgba(195, 219, 160, 0.34)"
  }),
  mudflat: Object.freeze({
    id: "mudflat",
    label: "Mudflat",
    className: TerrainClass.DIFFICULT,
    passable: true,
    moveCost: 1,
    fill: "rgba(86, 77, 63, 0.92)",
    stroke: "rgba(169, 145, 106, 0.28)",
    accent: "rgba(128, 111, 84, 0.34)"
  }),
  frozen_scree: Object.freeze({
    id: "frozen_scree",
    label: "Frozen Scree",
    className: TerrainClass.DIFFICULT,
    passable: true,
    moveCost: 1,
    fill: "rgba(78, 88, 100, 0.9)",
    stroke: "rgba(182, 196, 214, 0.28)",
    accent: "rgba(136, 148, 162, 0.35)"
  }),
  thornbrush: Object.freeze({
    id: "thornbrush",
    label: "Thornbrush",
    className: TerrainClass.HAZARD,
    passable: true,
    moveCost: 1,
    fill: "rgba(84, 70, 58, 0.92)",
    stroke: "rgba(190, 143, 112, 0.3)",
    accent: "rgba(158, 112, 82, 0.36)"
  }),
  shallow_water: Object.freeze({
    id: "shallow_water",
    label: "Shallow Water",
    className: TerrainClass.WATER,
    passable: true,
    moveCost: 1,
    fill: "rgba(49, 87, 114, 0.9)",
    stroke: "rgba(129, 178, 212, 0.3)",
    accent: "rgba(96, 156, 196, 0.4)"
  }),
  deep_water: Object.freeze({
    id: "deep_water",
    label: "Deep Water",
    className: TerrainClass.OBSTACLE,
    passable: false,
    moveCost: null,
    fill: "rgba(25, 53, 79, 0.96)",
    stroke: "rgba(92, 148, 190, 0.32)",
    accent: "rgba(67, 124, 169, 0.45)"
  }),
  boulder: Object.freeze({
    id: "boulder",
    label: "Boulder",
    className: TerrainClass.OBSTACLE,
    passable: false,
    moveCost: null,
    fill: "rgba(86, 94, 104, 0.95)",
    stroke: "rgba(174, 186, 200, 0.28)",
    accent: "rgba(130, 142, 157, 0.36)"
  })
});

export function terrainMetaById(id) {
  return TERRAIN_META[id] || TERRAIN_META.grassland;
}

function hashNoise(x, y, seed, salt = 0) {
  let h =
    (Math.imul(x | 0, 374761393) ^
      Math.imul(y | 0, 668265263) ^
      Math.imul(seed | 0, 1442695041) ^
      (salt | 0)) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 1274126177) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

function valueNoise(x, y, seed, salt) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  const tx = smoothstep(x - x0);
  const ty = smoothstep(y - y0);

  const n00 = hashNoise(x0, y0, seed, salt) / 0xffffffff;
  const n10 = hashNoise(x1, y0, seed, salt) / 0xffffffff;
  const n01 = hashNoise(x0, y1, seed, salt) / 0xffffffff;
  const n11 = hashNoise(x1, y1, seed, salt) / 0xffffffff;

  const nx0 = lerp(n00, n10, tx);
  const nx1 = lerp(n01, n11, tx);
  return lerp(nx0, nx1, ty);
}

function sampleTerrainNoise(x, y, seed, scale, salt) {
  const worldX = x * 0.92;
  const worldY = y + ((x & 1) !== 0 ? 0.5 : 0);
  return valueNoise(worldX / scale, worldY / scale, seed, salt);
}

export function terrainTypeAt(x, y, terrainSeed = 0) {
  const biomeRoll = sampleTerrainNoise(x, y, terrainSeed, 8.5, 17);
  const detailRoll = sampleTerrainNoise(x, y, terrainSeed, 3.4, 53);
  const objectRoll = sampleTerrainNoise(x, y, terrainSeed, 2.2, 89);

  if (biomeRoll < 0.31) {
    if (detailRoll < 0.44) return "shallow_water";
    if (detailRoll < 0.71) return "grassland";
    if (detailRoll < 0.84) return "mudflat";
    if (detailRoll < 0.95) return "thornbrush";
    return objectRoll < 0.6 ? "deep_water" : "boulder";
  }

  if (biomeRoll > 0.69) {
    if (detailRoll < 0.36) return "grassland";
    if (detailRoll < 0.67) return "frozen_scree";
    if (detailRoll < 0.79) return "mudflat";
    if (detailRoll < 0.89) return "thornbrush";
    if (detailRoll < 0.96) return "shallow_water";
    return "boulder";
  }

  if (detailRoll < 0.58) return "grassland";
  if (detailRoll < 0.79) return "high_grass";
  if (detailRoll < 0.9) return "mudflat";
  if (detailRoll < 0.97) return "thornbrush";
  return objectRoll < 0.72 ? "boulder" : "shallow_water";
}

export function terrainAt(x, y, terrainSeed = 0) {
  return terrainMetaById(terrainTypeAt(x, y, terrainSeed));
}

export function isTerrainPassable(x, y, terrainSeed = 0) {
  return terrainAt(x, y, terrainSeed).passable;
}

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

export function findNearestPassableHex(startX, startY, terrainSeed = 0, isBlocked = null, maxRadius = 24) {
  const sx = Math.floor(startX);
  const sy = Math.floor(startY);
  const queue = [{ x: sx, y: sy, dist: 0 }];
  const seen = new Set([`${sx},${sy}`]);

  while (queue.length) {
    const cur = queue.shift();
    const blocked = isBlocked ? Boolean(isBlocked(cur.x, cur.y)) : false;
    if (!blocked && isTerrainPassable(cur.x, cur.y, terrainSeed)) return { x: cur.x, y: cur.y };
    if (cur.dist >= maxRadius) continue;

    for (const n of hexNeighbors(cur.x, cur.y)) {
      const k = `${n.x},${n.y}`;
      if (seen.has(k)) continue;
      seen.add(k);
      queue.push({ x: n.x, y: n.y, dist: cur.dist + 1 });
    }
  }

  return { x: sx, y: sy };
}

export function livingEnemies(game) {
  return (game?.enemies || []).filter((e) => e && e.hp > 0);
}

export function firstLivingEnemy(game) {
  return livingEnemies(game)[0] || null;
}

function spawnScenarioOneEnemies(terrainSeed, occupiedKeys, anchor = { x: 1, y: 1 }) {
  const desired = [
    { x: anchor.x + 8, y: anchor.y + 0 },
    { x: anchor.x - 8, y: anchor.y + 2 },
    { x: anchor.x + 3, y: anchor.y + 8 },
    { x: anchor.x - 2, y: anchor.y - 8 }
  ];

  return desired.map((p, idx) => {
    const spawn = findNearestPassableHex(p.x, p.y, terrainSeed, (x, y) => occupiedKeys.has(`${x},${y}`), 28);
    occupiedKeys.add(`${spawn.x},${spawn.y}`);
    return {
      id: `enemy-${idx + 1}`,
      name: "Rift Stalker",
      art: "RST",
      flavor: "A warped predator that lunges from weak points in the veil.",
      attackPower: 1,
      x: spawn.x,
      y: spawn.y,
      hp: 6,
      maxHp: 6
    };
  });
}

export function makeInitialGameState(firstPlayerId) {
  const terrainSeed = Math.floor(Math.random() * 0x7fffffff);
  const occupied = new Set();
  const heroSpawn = findNearestPassableHex(1, 1, terrainSeed, (x, y) => occupied.has(`${x},${y}`), 24);
  occupied.add(`${heroSpawn.x},${heroSpawn.y}`);
  const enemies = spawnScenarioOneEnemies(terrainSeed, occupied, heroSpawn);

  return {
    v: 1,
    grid: { w: 10, h: 7 },
    terrain: {
      seed: terrainSeed,
      theme: "frostwild-frontier"
    },
    scenario: {
      id: "scenario-1",
      title: "Scenario 1: Rift Breach",
      objective: {
        type: "endless",
        targetCount: null
      },
      defeatedCount: 0,
      status: "active"
    },
    turn: {
      order: [firstPlayerId],
      activeIndex: 0,
      activePlayerId: firstPlayerId,
      apMax: 4,
      apRemaining: 4
    },
    heroes: {
      [firstPlayerId]: {
        id: `hero-${firstPlayerId}`,
        ownerPlayerId: firstPlayerId,
        x: heroSpawn.x,
        y: heroSpawn.y,
        hp: 10,
        maxHp: 10
      }
    },
    enemies,
    rules: {
      moveRange: 1,
      attackRange: 1,
      heroDamage: 2,
      enemyDamage: 1,
      actionPointsPerTurn: 4
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
  const terrainSeed = game?.terrain?.seed ?? 0;
  const desiredX = 1 + Math.floor(seatIndex / 2) * 2;
  const desiredY = 1 + (seatIndex % 2) * 3;
  const occupied = new Set(
    Object.values(game.heroes)
      .filter((h) => h.hp > 0)
      .map((h) => `${h.x},${h.y}`)
  );
  for (const enemy of game.enemies || []) {
    if (enemy?.hp > 0) occupied.add(`${enemy.x},${enemy.y}`);
  }
  const spawn = findNearestPassableHex(desiredX, desiredY, terrainSeed, (x, y) => occupied.has(`${x},${y}`), 40);

  game.heroes[playerId] = {
    id: `hero-${playerId}`,
    ownerPlayerId: playerId,
    x: spawn.x,
    y: spawn.y,
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
