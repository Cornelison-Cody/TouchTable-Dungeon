export const ActionType = Object.freeze({
  MOVE: "MOVE",
  ATTACK: "ATTACK",
  END_TURN: "END_TURN"
});

export function manhattan(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
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
