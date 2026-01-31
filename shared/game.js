// Minimal canonical game model for Milestone 2.
// Keep this tiny and explicit; evolve later.

export const ActionType = Object.freeze({
  MOVE: "MOVE",
  ATTACK: "ATTACK",
  END_TURN: "END_TURN"
});

export function makeInitialGameState(ownerPlayerId) {
  return {
    v: 1,
    grid: { w: 10, h: 7 },
    turn: {
      activePlayerId: ownerPlayerId,
      phase: "PLAYER" // later: ENEMY / ROUND_END etc.
    },
    entities: {
      hero: {
        id: "hero",
        ownerPlayerId,
        x: 1,
        y: 1,
        hp: 10,
        maxHp: 10
      },
      enemy: {
        id: "enemy-1",
        x: 7,
        y: 4,
        hp: 6,
        maxHp: 6
      }
    },
    rules: {
      moveRange: 1,
      attackRange: 1,
      heroDamage: 2,
      enemyDamage: 1
    },
    log: []
  };
}

export function manhattan(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}
