import { WebSocketServer } from "ws";
import { v4 as uuid } from "uuid";
import os from "os";
import { MsgType, Role, PROTOCOL_VERSION, makeMsg } from "../shared/protocol.js";
import {
  createCampaign,
  getCampaign,
  listCampaigns,
  loadCampaignStore,
  makeDefaultCampaignState,
  makeDefaultRpgProfile,
  pickOrCreateCampaignPlayer,
  saveCampaignStore,
  touchCampaign
} from "./campaign-store.js";
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
const DEFAULT_PHONE_PORT = 5174;
const DEFAULT_SERVER_PORT = 3000;


function getLanAddress() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net && net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "localhost";
}

function envString(key) {
  const raw = process.env[key];
  if (typeof raw !== "string") return "";
  return raw.trim();
}

function envPort(key, fallback) {
  const raw = Number(envString(key));
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.floor(raw);
}

function makeSession(gameId, campaignId) {
  return {
    sessionId: uuid().slice(0, 8),
    createdAt: Date.now(),
    gameId: gameId || "unknown",
    campaignId: campaignId || null,
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

const WEAPONS = Object.freeze({
  rusty_blade: Object.freeze({ id: "rusty_blade", name: "Rusty Blade", damageBonus: 0 }),
  iron_spear: Object.freeze({ id: "iron_spear", name: "Iron Spear", damageBonus: 2 })
});

const SPELLS = Object.freeze({
  arc_bolt: Object.freeze({ id: "arc_bolt", name: "Arc Bolt", range: 3, apCost: 2, damageBonus: 1 })
});

const CRAFTING_RECIPES = Object.freeze({
  potion_minor: Object.freeze({
    id: "potion_minor",
    label: "Minor Healing Potion",
    requires: Object.freeze({ herb: 2, fang: 1 }),
    yields: Object.freeze({ potion: 1 }),
    apCost: 1
  })
});

const ITEM_LABELS = Object.freeze({
  herb: "Herb",
  fang: "Fang",
  essence: "Essence",
  potion: "Potion"
});

const ENEMY_TEMPLATES = Object.freeze({
  common: Object.freeze({
    name: "Rift Scavenger",
    art: "RSC",
    flavor: "A skittering hunter that drags bones into the dark.",
    tier: "common",
    level: 1,
    hp: 5,
    attackPower: 1,
    rewardXp: 8,
    rewardGold: 3,
    dropTable: Object.freeze([
      Object.freeze({ item: "herb", min: 1, max: 2, chance: 0.7 }),
      Object.freeze({ item: "fang", min: 1, max: 1, chance: 0.45 })
    ])
  }),
  uncommon: Object.freeze({
    name: "Rift Stalker",
    art: "RST",
    flavor: "A warped predator that lunges from weak points in the veil.",
    tier: "uncommon",
    level: 2,
    hp: 8,
    attackPower: 2,
    rewardXp: 14,
    rewardGold: 5,
    dropTable: Object.freeze([
      Object.freeze({ item: "herb", min: 1, max: 2, chance: 0.5 }),
      Object.freeze({ item: "fang", min: 1, max: 2, chance: 0.8 })
    ])
  }),
  elite: Object.freeze({
    name: "Veil Brute",
    art: "VBT",
    flavor: "A hulking shard-beast that smashes through cover.",
    tier: "elite",
    level: 3,
    hp: 12,
    attackPower: 3,
    rewardXp: 22,
    rewardGold: 9,
    dropTable: Object.freeze([
      Object.freeze({ item: "fang", min: 1, max: 2, chance: 0.9 }),
      Object.freeze({ item: "essence", min: 1, max: 1, chance: 0.45 })
    ])
  }),
  rare: Object.freeze({
    name: "Abyss Warden",
    art: "AWD",
    flavor: "A sentry that channels volatile rift energy.",
    tier: "rare",
    level: 4,
    hp: 16,
    attackPower: 4,
    rewardXp: 30,
    rewardGold: 13,
    dropTable: Object.freeze([
      Object.freeze({ item: "essence", min: 1, max: 2, chance: 0.85 }),
      Object.freeze({ item: "herb", min: 1, max: 2, chance: 0.5 })
    ])
  })
});

function xpNeededForLevel(level) {
  return 20 + Math.max(0, level - 1) * 12;
}

function heroMaxHpForLevel(level) {
  return 10 + Math.max(0, level - 1) * 2;
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function ensureRpgProfile(player) {
  const base = makeDefaultRpgProfile();
  if (!player || typeof player !== "object") return clone(base);

  const raw = player.rpg && typeof player.rpg === "object" ? player.rpg : {};
  const inventory = {
    ...base.inventory,
    ...(raw.inventory && typeof raw.inventory === "object" ? raw.inventory : {})
  };
  for (const key of Object.keys(base.inventory)) {
    inventory[key] = Math.max(0, Number(inventory[key]) || 0);
  }

  const level = Math.max(1, Number(raw.level) || base.level);
  player.rpg = {
    ...base,
    ...raw,
    level,
    xp: Math.max(0, Number(raw.xp) || 0),
    xpToNext: Math.max(10, Number(raw.xpToNext) || xpNeededForLevel(level)),
    gold: Math.max(0, Number(raw.gold) || 0),
    weaponId: WEAPONS[raw.weaponId] ? raw.weaponId : base.weaponId,
    spellId: SPELLS[raw.spellId] ? raw.spellId : base.spellId,
    inventory
  };
  return player.rpg;
}

function makeEnemyFromTemplate(id, template, x, y) {
  return {
    id,
    name: template.name,
    art: template.art,
    flavor: template.flavor,
    tier: template.tier,
    level: template.level,
    attackPower: template.attackPower,
    x,
    y,
    hp: template.hp,
    maxHp: template.hp,
    rewardXp: template.rewardXp,
    rewardGold: template.rewardGold,
    dropTable: clone(template.dropTable)
  };
}

function pickScaledEnemyTemplate(avgLevel = 1, defeatedCount = 0) {
  const threat = Math.max(1, Math.floor(avgLevel + defeatedCount / 6));
  if (threat >= 6) return ENEMY_TEMPLATES.rare;
  if (threat >= 4) return Math.random() < 0.55 ? ENEMY_TEMPLATES.elite : ENEMY_TEMPLATES.rare;
  if (threat >= 3) return Math.random() < 0.5 ? ENEMY_TEMPLATES.uncommon : ENEMY_TEMPLATES.elite;
  return Math.random() < 0.75 ? ENEMY_TEMPLATES.common : ENEMY_TEMPLATES.uncommon;
}

function rollEnemyDrops(enemyUnit) {
  const entries = Array.isArray(enemyUnit?.dropTable) ? enemyUnit.dropTable : [];
  const drops = {};
  for (const entry of entries) {
    if (!entry || !entry.item) continue;
    const chance = clamp(Number(entry.chance) || 0, 0, 1);
    if (Math.random() > chance) continue;
    const min = Math.max(1, Math.floor(Number(entry.min) || 1));
    const max = Math.max(min, Math.floor(Number(entry.max) || min));
    const qty = min + Math.floor(Math.random() * (max - min + 1));
    drops[entry.item] = (drops[entry.item] || 0) + qty;
  }
  return drops;
}

export function setupWebSocket(server) {
  const wss = new WebSocketServer({ server });

  const campaignStore = loadCampaignStore();
  const sessions = new Map(); // sessionId -> { session, campaign, game, gameHistory, tableWs, gameId }
  const sessionByCampaignId = new Map();

  let session = null;
  let campaign = null;
  let game = null;
  let tableWs = null;
  let gameHistory = null;

  const clients = new Map(); // ws -> { clientId, role, playerId?, seat? }

  function bindContext(ctx) {
    session = ctx.session;
    campaign = ctx.campaign;
    game = ctx.game;
    gameHistory = ctx.gameHistory;
    tableWs = ctx.tableWs;
  }

  function syncContext(ctx) {
    ctx.session = session;
    ctx.campaign = campaign;
    ctx.game = game;
    ctx.gameHistory = gameHistory;
    ctx.tableWs = tableWs;
  }

  function listCampaignSummaries(gameId) {
    return listCampaigns(campaignStore, gameId).map((c) => ({
      id: c.id,
      title: c.title,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt
    }));
  }

  function createSessionContext(gameId, campaignState) {
    const ctx = {
      session: makeSession(gameId, campaignState?.id),
      gameId,
      campaign: campaignState,
      game: campaignState?.activeGame || null,
      gameHistory: [],
      tableWs: null
    };
    sessions.set(ctx.session.sessionId, ctx);
    if (campaignState?.id) sessionByCampaignId.set(campaignState.id, ctx.session.sessionId);
    bindContext(ctx);
    ensureGameShape();
    syncContext(ctx);
    return ctx;
  }

  function getSessionContext(sessionId) {
    if (!sessionId) return null;
    return sessions.get(sessionId) || null;
  }

  function getOrCreateSessionForCampaign(gameId, campaignState) {
    const existingId = campaignState?.id ? sessionByCampaignId.get(campaignState.id) : null;
    if (existingId) {
      const existing = sessions.get(existingId) || null;
      if (existing) return existing;
    }
    return createSessionContext(gameId, campaignState);
  }

  function ensureGameShape() {
    if (!game) return;
    if (!Array.isArray(game.enemies)) {
      game.enemies = game.enemy ? [game.enemy] : [];
      delete game.enemy;
    }
    if (!Array.isArray(game.groundLoot)) game.groundLoot = [];
    if (!game.scenario) {
      game.scenario = {
        id: "scenario-1",
        title: "Scenario 1: Rift Breach",
        objective: { type: "endless", targetCount: null },
        defeatedCount: 0,
        status: "active"
      };
    }
    if (!game.scenario.objective || game.scenario.objective.type !== "endless") {
      game.scenario.objective = { type: "endless", targetCount: null };
    }
    if (game.scenario.status !== "active") game.scenario.status = "active";
    game.rules = game.rules || {};
    if ((game.rules.actionPointsPerTurn ?? 0) < 4) game.rules.actionPointsPerTurn = 4;
    if (!Number.isFinite(game.rules.spellRange) || game.rules.spellRange < 2) game.rules.spellRange = 3;
    if (!Number.isFinite(game.rules.spellApCost) || game.rules.spellApCost < 1) game.rules.spellApCost = 2;

    for (const [playerId, hero] of Object.entries(game.heroes || {})) {
      const profile = rpgProfileById(playerId);
      const expectedMaxHp = heroMaxHpForLevel(profile.level);
      const parsedHeroMaxHp = Number(hero.maxHp);
      hero.maxHp = Math.max(1, Number.isFinite(parsedHeroMaxHp) ? parsedHeroMaxHp : expectedMaxHp);
      if (hero.maxHp < expectedMaxHp) hero.maxHp = expectedMaxHp;
      const parsedHeroHp = Number(hero.hp);
      hero.hp = clamp(Number.isFinite(parsedHeroHp) ? parsedHeroHp : hero.maxHp, 0, hero.maxHp);
      hero.level = profile.level;
    }

    for (const enemyUnit of game.enemies || []) {
      const fallback = ENEMY_TEMPLATES.common;
      enemyUnit.tier = typeof enemyUnit.tier === "string" ? enemyUnit.tier : fallback.tier;
      enemyUnit.level = Math.max(1, Number(enemyUnit.level) || fallback.level);
      const parsedEnemyMaxHp = Number(enemyUnit.maxHp);
      const parsedEnemyHp = Number(enemyUnit.hp);
      enemyUnit.maxHp = Math.max(
        1,
        Number.isFinite(parsedEnemyMaxHp)
          ? parsedEnemyMaxHp
          : Number.isFinite(parsedEnemyHp)
            ? parsedEnemyHp
            : fallback.hp
      );
      enemyUnit.hp = clamp(Number.isFinite(parsedEnemyHp) ? parsedEnemyHp : enemyUnit.maxHp, 0, enemyUnit.maxHp);
      enemyUnit.attackPower = Math.max(1, Number(enemyUnit.attackPower) || fallback.attackPower);
      enemyUnit.rewardXp = Math.max(1, Number(enemyUnit.rewardXp) || enemyUnit.level * 8);
      enemyUnit.rewardGold = Math.max(0, Number(enemyUnit.rewardGold) || enemyUnit.level * 3);
      enemyUnit.dropTable = Array.isArray(enemyUnit.dropTable) ? enemyUnit.dropTable : clone(fallback.dropTable);
    }

    game.groundLoot = (game.groundLoot || [])
      .filter((loot) => loot && Number.isFinite(Number(loot.x)) && Number.isFinite(Number(loot.y)))
      .map((loot) => ({
        id: typeof loot.id === "string" && loot.id ? loot.id : `loot-${uuid().slice(0, 8)}`,
        x: Math.floor(Number(loot.x)),
        y: Math.floor(Number(loot.y)),
        xp: Math.max(0, Number(loot.xp) || 0),
        gold: Math.max(0, Number(loot.gold) || 0),
        drops: Object.fromEntries(
          Object.entries(loot.drops && typeof loot.drops === "object" ? loot.drops : {})
            .map(([itemId, qty]) => [itemId, Math.max(0, Number(qty) || 0)])
            .filter(([, qty]) => qty > 0)
        ),
        enemyName: typeof loot.enemyName === "string" ? loot.enemyName : "Monster",
        killerPlayerId: typeof loot.killerPlayerId === "string" ? loot.killerPlayerId : null,
        at: Number(loot.at) || Date.now()
      }));
  }

  function saveCampaignSnapshot() {
    ensureGameShape();
    campaign.activeGame = game ? cloneGameState(game) : null;
    touchCampaign(campaign);
    saveCampaignStore(campaignStore);
  }

  function resetCampaignInPlace() {
    const freshCampaign = makeDefaultCampaignState({ title: campaign?.title });
    freshCampaign.id = campaign?.id || freshCampaign.id;
    freshCampaign.createdAt = campaign?.createdAt || freshCampaign.createdAt;
    for (const key of Object.keys(campaign)) delete campaign[key];
    Object.assign(campaign, freshCampaign);
  }

  function shortName(pid) {
    const s = session.seats.find((x) => x.playerId === pid);
    return s?.playerName || pid.slice(0, 4);
  }

  function isPlayerConnected(playerId) {
    for (const info of clients.values()) {
      if (info.sessionId === session.sessionId && info.role === Role.PHONE && info.playerId === playerId) return true;
    }
    return false;
  }

  function send(ws, msg) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  function reject(ws, id, code, message) {
    send(ws, makeMsg(MsgType.ERROR, { code, message }, id));
  }

  function buildPublicJoinBaseUrl() {
    const explicitBase = envString("TT_PUBLIC_JOIN_URL");
    if (explicitBase) {
      try {
        return new URL(explicitBase);
      } catch {
        // Fall back to LAN-based URL if explicit base is invalid.
      }
    }

    const host = envString("TT_PUBLIC_HOST") || getLanAddress();
    const scheme = envString("TT_PUBLIC_SCHEME") || "http";
    const port = envPort("TT_PUBLIC_PHONE_PORT", DEFAULT_PHONE_PORT);
    const url = new URL(`${scheme}://${host}`);
    if (![80, 443].includes(port)) url.port = String(port);
    url.pathname = "/";
    return url;
  }

  function buildPublicWsUrl() {
    const explicitWs = envString("TT_PUBLIC_WS_URL");
    if (explicitWs) return explicitWs;

    const host = envString("TT_PUBLIC_WS_HOST") || envString("TT_PUBLIC_HOST");
    if (!host) return "";
    const scheme =
      envString("TT_PUBLIC_WS_SCHEME") ||
      (envString("TT_PUBLIC_SCHEME") === "https" ? "wss" : "ws");
    const port = envPort("TT_PUBLIC_WS_PORT", envPort("PORT", DEFAULT_SERVER_PORT));
    const url = new URL(`${scheme}://${host}`);
    if (![80, 443].includes(port)) url.port = String(port);
    return url.toString();
  }

  function getJoinUrl() {
    const url = buildPublicJoinBaseUrl();
    url.searchParams.set("session", session.sessionId);
    const wsUrl = buildPublicWsUrl();
    if (wsUrl) url.searchParams.set("ws", wsUrl);
    return url.toString();
  }

  function campaignPlayerById(playerId) {
    return (campaign.players || []).find((p) => p.id === playerId) || null;
  }

  function rpgProfileById(playerId) {
    return ensureRpgProfile(campaignPlayerById(playerId));
  }

  function equipAutoUpgrades(profile) {
    if (!profile) return null;
    if (profile.level >= 3 && profile.weaponId !== "iron_spear") {
      profile.weaponId = "iron_spear";
      return WEAPONS.iron_spear;
    }
    return null;
  }

  function ensureGameFor(playerId, seatIndex0) {
    const playerRecord = campaignPlayerById(playerId);
    const profile = ensureRpgProfile(playerRecord);

    if (!game) {
      game = makeInitialGameState(playerId);
      gameHistory.length = 0;
      resetTurnAP(game);
      game.log.push({ at: Date.now(), msg: "Encounter started." });
      game.log.push({ at: Date.now(), msg: `Turn: ${shortName(playerId)}.` });
    } else {
      ensurePlayerInTurnOrder(game, playerId);
    }
    const maxHp = heroMaxHpForLevel(profile.level);
    const hero = spawnHeroForPlayer(game, playerId, seatIndex0, { hp: maxHp, maxHp });
    if (hero) {
      hero.maxHp = maxHp;
      if (hero.hp > hero.maxHp) hero.hp = hero.maxHp;
      hero.level = profile.level;
      collectLootAt(playerId, hero.x, hero.y);
    }
  }

  function computePublicState() {
    ensureGameShape();
    const nameById = new Map(session.seats.filter((s) => s.playerId).map((s) => [s.playerId, s.playerName]));
    const campaignNameById = new Map((campaign.players || []).map((p) => [p.id, p.name]));
    const levelById = new Map((campaign.players || []).map((p) => [p.id, ensureRpgProfile(p).level]));
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
              level: levelById.get(h.ownerPlayerId) || 1,
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
              tier: enemyUnit.tier || "common",
              level: enemyUnit.level || 1,
              attackPower: enemyUnit.attackPower ?? game.rules.enemyDamage,
              x: enemyUnit.x,
              y: enemyUnit.y,
              hp: enemyUnit.hp,
              maxHp: enemyUnit.maxHp
            })),
            groundLoot: (game.groundLoot || []).map((loot) => ({
              id: loot.id,
              x: loot.x,
              y: loot.y,
              xp: loot.xp,
              gold: loot.gold,
              drops: loot.drops
            })),
            enemy: primaryEnemy
              ? {
                  id: primaryEnemy.id,
                  name: primaryEnemy.name || null,
                  art: primaryEnemy.art || null,
                  flavor: primaryEnemy.flavor || null,
                  tier: primaryEnemy.tier || "common",
                  level: primaryEnemy.level || 1,
                  attackPower: primaryEnemy.attackPower ?? game.rules.enemyDamage,
                  x: primaryEnemy.x,
                  y: primaryEnemy.y,
                  hp: primaryEnemy.hp,
                  maxHp: primaryEnemy.maxHp
                }
              : null,
            rules: {
              moveRange: game.rules.moveRange,
              attackRange: game.rules.attackRange,
              spellRange: game.rules.spellRange,
              spellApCost: game.rules.spellApCost,
              actionPointsPerTurn: game.rules.actionPointsPerTurn
            },
            lastEnemyDamage: game.lastEnemyDamage
              ? {
                  enemyId: game.lastEnemyDamage.enemyId,
                  targetPlayerId: game.lastEnemyDamage.targetPlayerId,
                  amount: game.lastEnemyDamage.amount,
                  heroHp: game.lastEnemyDamage.heroHp,
                  heroMaxHp: game.lastEnemyDamage.heroMaxHp,
                  at: game.lastEnemyDamage.at
                }
              : null,
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
    const campaignPlayer = campaignPlayerById(playerId);
    const rpg = ensureRpgProfile(campaignPlayer);
    const weapon = WEAPONS[rpg.weaponId] || WEAPONS.rusty_blade;
    const spell = SPELLS[rpg.spellId] || SPELLS.arc_bolt;
    const primaryEnemy = game ? firstLivingEnemy(game) : null;
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
              spellRange: game.rules.spellRange,
              spellApCost: game.rules.spellApCost,
              actionPointsPerTurn: game.rules.actionPointsPerTurn
            },
            rpg: {
              level: rpg.level,
              xp: rpg.xp,
              xpToNext: rpg.xpToNext,
              gold: rpg.gold,
              weapon: {
                id: weapon.id,
                name: weapon.name,
                damageBonus: weapon.damageBonus
              },
              spell: {
                id: spell.id,
                name: spell.name,
                range: spell.range,
                apCost: spell.apCost,
                damageBonus: spell.damageBonus
              },
              inventory: { ...rpg.inventory }
            },
            craftingOptions: Object.values(CRAFTING_RECIPES).map((recipe) => {
              const canCraftByItems = Object.entries(recipe.requires).every(([itemId, qty]) => (rpg.inventory[itemId] || 0) >= qty);
              const canCraft = canCraftByItems && (game.turn.apRemaining ?? 0) >= recipe.apCost;
              return {
                id: recipe.id,
                label: recipe.label,
                requires: recipe.requires,
                yields: recipe.yields,
                apCost: recipe.apCost,
                canCraft
              };
            }),
            heroesPublic: Object.values(game.heroes).map((h) => ({
              ownerPlayerId: h.ownerPlayerId,
              ownerPlayerName:
                session.seats.find((s) => s.playerId === h.ownerPlayerId)?.playerName ||
                campaignNameById.get(h.ownerPlayerId) ||
                null,
              level: rpgProfileById(h.ownerPlayerId).level,
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
              tier: enemyUnit.tier || "common",
              level: enemyUnit.level || 1,
              attackPower: enemyUnit.attackPower ?? game.rules.enemyDamage,
              x: enemyUnit.x,
              y: enemyUnit.y,
              hp: enemyUnit.hp,
              maxHp: enemyUnit.maxHp
            })),
            groundLoot: (game.groundLoot || []).map((loot) => ({
              id: loot.id,
              x: loot.x,
              y: loot.y,
              xp: loot.xp,
              gold: loot.gold,
              drops: loot.drops
            })),
            enemy: primaryEnemy
              ? {
                  id: primaryEnemy.id,
                  name: primaryEnemy.name || null,
                  art: primaryEnemy.art || null,
                  flavor: primaryEnemy.flavor || null,
                  tier: primaryEnemy.tier || "common",
                  level: primaryEnemy.level || 1,
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
                    type: game.lastHeroDamage.type || "weapon",
                    enemyHp: game.lastHeroDamage.enemyHp,
                    enemyMaxHp: game.lastHeroDamage.enemyMaxHp,
                    at: game.lastHeroDamage.at
                  }
                : null,
            lastEnemyDamage:
              game.lastEnemyDamage && game.lastEnemyDamage.targetPlayerId === playerId
                ? {
                    amount: game.lastEnemyDamage.amount,
                    enemyId: game.lastEnemyDamage.enemyId,
                    heroHp: game.lastEnemyDamage.heroHp,
                    heroMaxHp: game.lastEnemyDamage.heroMaxHp,
                    at: game.lastEnemyDamage.at
                  }
                : null,
            lastLoot:
              game.lastLoot && game.lastLoot.playerId === playerId
                ? {
                    enemyName: game.lastLoot.enemyName,
                    xp: game.lastLoot.xp,
                    gold: game.lastLoot.gold,
                    drops: game.lastLoot.drops,
                    at: game.lastLoot.at
                  }
                : null,
            reviveTargets: downedHeroTargetsFor(playerId),
            allowedActions:
              (() => {
                if (!(isActive && hero && hero.hp > 0)) return [];
                const actions = [ActionType.END_TURN];
                const apRemaining = game.turn.apRemaining ?? 0;
                if (apRemaining > 0) {
                  actions.push(ActionType.MOVE, ActionType.ATTACK);
                  const recipe = CRAFTING_RECIPES.potion_minor;
                  const canCraftPotion =
                    Object.entries(recipe.requires).every(([itemId, qty]) => (rpg.inventory[itemId] || 0) >= qty) &&
                    apRemaining >= recipe.apCost;
                  if (canCraftPotion) actions.push(ActionType.CRAFT_ITEM);
                  if ((rpg.inventory.potion || 0) > 0 && hero.hp < hero.maxHp) actions.push(ActionType.USE_ITEM);
                  if (downedHeroTargetsFor(playerId).length) actions.push(ActionType.REVIVE);
                }
                if (apRemaining >= spell.apCost) actions.push(ActionType.CAST_SPELL);
                return actions;
              })()
          }
        : null
    };
  }

  function emitViews() {
    saveCampaignSnapshot();
    for (const [ws, info] of clients.entries()) {
      if (info.sessionId !== session.sessionId) continue;
      if (info.role === Role.TABLE) send(ws, makeMsg(MsgType.STATE_PUBLIC, { state: computePublicState() }));
      if (info.role === Role.PHONE && info.playerId) send(ws, makeMsg(MsgType.STATE_PRIVATE, { state: computePrivateState(info.playerId) }));
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

  function downedHeroTargetsFor(actorPlayerId) {
    if (!game) return [];
    const actorHero = game.heroes?.[actorPlayerId];
    if (!actorHero || actorHero.hp <= 0) return [];
    const campaignNameById = new Map((campaign.players || []).map((p) => [p.id, p.name]));
    return Object.values(game.heroes || {})
      .filter((h) => h.ownerPlayerId !== actorPlayerId)
      .filter((h) => h.hp <= 0)
      .map((h) => ({
        playerId: h.ownerPlayerId,
        playerName: session.seats.find((s) => s.playerId === h.ownerPlayerId)?.playerName || campaignNameById.get(h.ownerPlayerId) || null,
        distance: manhattan(actorHero, h)
      }))
      .filter((x) => x.distance <= 1)
      .sort((a, b) => a.distance - b.distance || (a.playerName || "").localeCompare(b.playerName || ""));
  }

  function enemyAt(x, y) {
    if (!game) return null;
    return (game.enemies || []).find((enemyUnit) => enemyUnit.hp > 0 && enemyUnit.x === x && enemyUnit.y === y) || null;
  }

  function cellOccupiedByLiveEnemy(x, y) {
    return Boolean(enemyAt(x, y));
  }

  function grantXp(profile, xpAmount) {
    let gainedLevels = 0;
    profile.xp += Math.max(0, xpAmount);
    while (profile.xp >= profile.xpToNext) {
      profile.xp -= profile.xpToNext;
      profile.level += 1;
      profile.xpToNext = xpNeededForLevel(profile.level);
      gainedLevels += 1;
    }
    return gainedLevels;
  }

  function addInventory(profile, drops) {
    profile.inventory = profile.inventory || {};
    for (const [itemId, qty] of Object.entries(drops || {})) {
      if (!qty) continue;
      profile.inventory[itemId] = Math.max(0, (profile.inventory[itemId] || 0) + qty);
    }
  }

  function formatDrops(drops) {
    const parts = Object.entries(drops || {})
      .filter(([, qty]) => qty > 0)
      .map(([itemId, qty]) => `${qty}x ${ITEM_LABELS[itemId] || itemId}`);
    return parts.length ? parts.join(", ") : "none";
  }

  function collectLootAt(playerId, x, y) {
    if (!game || !playerId) return null;
    const allLoot = game.groundLoot || [];
    const collected = allLoot.filter((loot) => loot.x === x && loot.y === y);
    if (!collected.length) return null;

    game.groundLoot = allLoot.filter((loot) => !(loot.x === x && loot.y === y));
    const totals = { xp: 0, gold: 0, drops: {} };
    for (const loot of collected) {
      totals.xp += Math.max(0, Number(loot.xp) || 0);
      totals.gold += Math.max(0, Number(loot.gold) || 0);
      for (const [itemId, qty] of Object.entries(loot.drops || {})) {
        if (!qty) continue;
        totals.drops[itemId] = (totals.drops[itemId] || 0) + qty;
      }
    }

    const campaignPlayer = campaignPlayerById(playerId);
    const profile = ensureRpgProfile(campaignPlayer);
    const levelsGained = grantXp(profile, totals.xp);
    profile.gold += totals.gold;
    addInventory(profile, totals.drops);
    const upgradedWeapon = equipAutoUpgrades(profile);

    const hero = game.heroes?.[playerId];
    if (hero) {
      const nextMaxHp = heroMaxHpForLevel(profile.level);
      if (nextMaxHp > hero.maxHp) {
        hero.maxHp = nextMaxHp;
        hero.hp = clamp(hero.hp + levelsGained * 2, 0, hero.maxHp);
      }
      hero.level = profile.level;
    }

    const now = Date.now();
    game.lastLoot = {
      playerId,
      enemyName: collected.length === 1 ? collected[0].enemyName : "Loot Cache",
      xp: totals.xp,
      gold: totals.gold,
      drops: totals.drops,
      at: now
    };
    game.log.push({
      at: now,
      msg: `${shortName(playerId)} loots ${totals.gold} gold, ${totals.xp} XP, items: ${formatDrops(totals.drops)}.`
    });
    if (levelsGained > 0) {
      game.log.push({ at: now, msg: `${shortName(playerId)} reached level ${profile.level}!` });
    }
    if (upgradedWeapon) {
      game.log.push({ at: now, msg: `${shortName(playerId)} upgraded weapon to ${upgradedWeapon.name}.` });
    }

    return game.lastLoot;
  }

  function markEnemyDefeated(enemyUnit, killerPlayerId = null) {
    if (!game || !enemyUnit) return;
    const now = Date.now();
    game.scenario.defeatedCount = (game.scenario.defeatedCount ?? 0) + 1;
    game.lastLoot = null;

    const xpReward = Math.max(1, Number(enemyUnit.rewardXp) || Number(enemyUnit.level) * 8 || 8);
    const goldReward = Math.max(0, Number(enemyUnit.rewardGold) || Number(enemyUnit.level) * 3 || 0);
    const drops = rollEnemyDrops(enemyUnit);
    game.enemies = (game.enemies || []).filter((enemy) => enemy.id !== enemyUnit.id);
    game.groundLoot = game.groundLoot || [];
    game.groundLoot.push({
      id: `loot-${uuid().slice(0, 8)}`,
      x: enemyUnit.x,
      y: enemyUnit.y,
      xp: xpReward,
      gold: goldReward,
      drops,
      enemyName: enemyUnit.name || "Monster",
      killerPlayerId: killerPlayerId || null,
      at: now
    });

    game.log.push({
      at: now,
      msg: `${enemyUnit.name || "Monster"} defeated (${game.scenario.defeatedCount} total). Loot dropped at (${enemyUnit.x},${enemyUnit.y}).`
    });
  }

  function enemyTakeTurn() {
    if (!game) return;
    const terrainSeed = game?.terrain?.seed ?? 0;
    const enemyAwarenessRange = 8;

    const aliveHeroes = Object.values(game.heroes).filter((h) => isHeroAlive(h));
    if (!aliveHeroes.length) return;

    for (const enemyUnit of livingEnemies(game)) {
      const nearestHeroDistance = (pos) => {
        let best = Number.POSITIVE_INFINITY;
        for (const h of aliveHeroes) best = Math.min(best, manhattan(pos, h));
        return best;
      };
      const currentDist = nearestHeroDistance(enemyUnit);
      if (currentDist > enemyAwarenessRange) continue;

      const inRange = aliveHeroes.filter((h) => manhattan(h, enemyUnit) <= game.rules.attackRange);
      if (inRange.length) {
        const target = [...inRange].sort((a, b) => a.hp - b.hp || manhattan(a, enemyUnit) - manhattan(b, enemyUnit))[0];
        const enemyDamage = Math.max(1, Number(enemyUnit.attackPower) || game.rules.enemyDamage);
        const damageAt = Date.now();
        target.hp = clamp(target.hp - enemyDamage, 0, target.maxHp);
        game.lastEnemyDamage = {
          enemyId: enemyUnit.id,
          targetPlayerId: target.ownerPlayerId,
          amount: enemyDamage,
          heroHp: target.hp,
          heroMaxHp: target.maxHp,
          at: damageAt
        };
        game.log.push({ at: damageAt, msg: `${enemyUnit.name || "Enemy"} hits ${shortName(target.ownerPlayerId)} for ${enemyDamage}.` });
        if (target.hp <= 0) game.log.push({ at: damageAt, msg: `Hero ${shortName(target.ownerPlayerId)} is down!` });
        continue;
      }

      const occupiedByLiveHero = (x, y) => aliveHeroes.some((h) => h.x === x && h.y === y);
      const occupiedByOtherEnemy = (x, y) =>
        (game.enemies || []).some((e) => e.id !== enemyUnit.id && e.hp > 0 && e.x === x && e.y === y);
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
    collectLootAt(actorPlayerId, nx, ny);
    game.turn.apRemaining = Math.max(0, (game.turn.apRemaining ?? 0) - 1);
    send(ws, makeMsg(MsgType.OK, { accepted: true }, id));
    emitViews();
  }

  function handleAttack(ws, id, actorPlayerId, params = {}) {
    if (!requireActive(ws, id, actorPlayerId)) return;
    // Action points
    if ((game.turn.apRemaining ?? 0) <= 0) return reject(ws, id, "NO_AP", "No actions remaining. End your turn.");
    const hero = game.heroes[actorPlayerId];
    if (!hero || hero.hp <= 0) return reject(ws, id, "HERO_DOWN", "Hero is down.");
    const profile = rpgProfileById(actorPlayerId);
    const weapon = WEAPONS[profile.weaponId] || WEAPONS.rusty_blade;
    const weaponDamage = Math.max(1, game.rules.heroDamage + weapon.damageBonus + Math.floor((profile.level - 1) / 3));
    const targets = livingEnemies(game)
      .map((enemyUnit) => ({ enemyUnit, dist: manhattan(hero, enemyUnit) }))
      .filter((x) => x.dist <= game.rules.attackRange)
      .sort((a, b) => a.enemyUnit.hp - b.enemyUnit.hp || a.dist - b.dist || a.enemyUnit.id.localeCompare(b.enemyUnit.id));
    if (!targets.length) return reject(ws, id, "OUT_OF_RANGE", `No enemy in range (range ${game.rules.attackRange}).`);
    const targetEnemyId = (params?.targetEnemyId ?? "").toString().trim();
    const target = targetEnemyId
      ? (targets.find((x) => x.enemyUnit.id === targetEnemyId)?.enemyUnit || null)
      : targets[0].enemyUnit;
    if (!target) return reject(ws, id, "OUT_OF_RANGE", "Selected enemy is not in range.");

    pushGameHistory();
    const enemyHpBefore = target.hp;
    target.hp = clamp(target.hp - weaponDamage, 0, target.maxHp);
    const dealt = enemyHpBefore - target.hp;
    game.lastHeroDamage = {
      actorPlayerId,
      amount: dealt,
      type: "weapon",
      enemyId: target.id,
      enemyHp: target.hp,
      enemyMaxHp: target.maxHp,
      at: Date.now()
    };
    game.log.push({ at: Date.now(), msg: `Hero ${shortName(actorPlayerId)} attacks ${target.name || "enemy"} with ${weapon.name} for ${weaponDamage}.` });
    game.turn.apRemaining = Math.max(0, (game.turn.apRemaining ?? 0) - 1);
    if (target.hp <= 0) markEnemyDefeated(target, actorPlayerId);

    send(ws, makeMsg(MsgType.OK, { accepted: true }, id));
    emitViews();
  }

  function handleCastSpell(ws, id, actorPlayerId, params = {}) {
    if (!requireActive(ws, id, actorPlayerId)) return;
    const hero = game.heroes[actorPlayerId];
    if (!hero || hero.hp <= 0) return reject(ws, id, "HERO_DOWN", "Hero is down.");

    const profile = rpgProfileById(actorPlayerId);
    const spell = SPELLS[profile.spellId] || SPELLS.arc_bolt;
    const spellApCost = Math.max(1, Number(spell.apCost) || game.rules.spellApCost || 2);
    const spellRange = Math.max(2, Number(spell.range) || game.rules.spellRange || 3);
    if ((game.turn.apRemaining ?? 0) < spellApCost) return reject(ws, id, "NO_AP", `Spell needs ${spellApCost} AP.`);

    const spellDamage = Math.max(1, game.rules.heroDamage + spell.damageBonus + Math.floor((profile.level - 1) / 2));
    const targets = livingEnemies(game)
      .map((enemyUnit) => ({ enemyUnit, dist: manhattan(hero, enemyUnit) }))
      .filter((x) => x.dist <= spellRange)
      .sort((a, b) => a.enemyUnit.hp - b.enemyUnit.hp || a.dist - b.dist || a.enemyUnit.id.localeCompare(b.enemyUnit.id));
    if (!targets.length) return reject(ws, id, "OUT_OF_RANGE", `No enemy in spell range (range ${spellRange}).`);
    const targetEnemyId = (params?.targetEnemyId ?? "").toString().trim();
    const target = targetEnemyId
      ? (targets.find((x) => x.enemyUnit.id === targetEnemyId)?.enemyUnit || null)
      : targets[0].enemyUnit;
    if (!target) return reject(ws, id, "OUT_OF_RANGE", "Selected enemy is not in spell range.");

    pushGameHistory();
    const enemyHpBefore = target.hp;
    target.hp = clamp(target.hp - spellDamage, 0, target.maxHp);
    const dealt = enemyHpBefore - target.hp;
    game.lastHeroDamage = {
      actorPlayerId,
      amount: dealt,
      type: "spell",
      enemyId: target.id,
      enemyHp: target.hp,
      enemyMaxHp: target.maxHp,
      at: Date.now()
    };
    game.turn.apRemaining = Math.max(0, (game.turn.apRemaining ?? 0) - spellApCost);
    game.log.push({ at: Date.now(), msg: `${shortName(actorPlayerId)} casts ${spell.name} on ${target.name || "enemy"} for ${spellDamage}.` });
    if (target.hp <= 0) markEnemyDefeated(target, actorPlayerId);

    send(ws, makeMsg(MsgType.OK, { accepted: true, cast: spell.id }, id));
    emitViews();
  }

  function handleCraftItem(ws, id, actorPlayerId, params = {}) {
    if (!requireActive(ws, id, actorPlayerId)) return;
    const hero = game.heroes[actorPlayerId];
    if (!hero || hero.hp <= 0) return reject(ws, id, "HERO_DOWN", "Hero is down.");

    const recipeId = (params.recipeId || "potion_minor").toString();
    const recipe = CRAFTING_RECIPES[recipeId];
    if (!recipe) return reject(ws, id, "BAD_RECIPE", "Unknown recipe.");
    if ((game.turn.apRemaining ?? 0) < recipe.apCost) return reject(ws, id, "NO_AP", `Crafting needs ${recipe.apCost} AP.`);

    const profile = rpgProfileById(actorPlayerId);
    for (const [itemId, qty] of Object.entries(recipe.requires)) {
      if ((profile.inventory[itemId] || 0) < qty) {
        return reject(ws, id, "MISSING_ITEMS", `Need ${qty} ${ITEM_LABELS[itemId] || itemId}.`);
      }
    }

    pushGameHistory();
    for (const [itemId, qty] of Object.entries(recipe.requires)) {
      profile.inventory[itemId] = Math.max(0, (profile.inventory[itemId] || 0) - qty);
    }
    for (const [itemId, qty] of Object.entries(recipe.yields)) {
      profile.inventory[itemId] = (profile.inventory[itemId] || 0) + qty;
    }
    game.turn.apRemaining = Math.max(0, (game.turn.apRemaining ?? 0) - recipe.apCost);
    game.log.push({ at: Date.now(), msg: `${shortName(actorPlayerId)} crafts ${recipe.label}.` });

    send(ws, makeMsg(MsgType.OK, { accepted: true, crafted: recipeId }, id));
    emitViews();
  }

  function handleUseItem(ws, id, actorPlayerId, params = {}) {
    if (!requireActive(ws, id, actorPlayerId)) return;
    const hero = game.heroes[actorPlayerId];
    if (!hero || hero.hp <= 0) return reject(ws, id, "HERO_DOWN", "Hero is down.");
    if ((game.turn.apRemaining ?? 0) <= 0) return reject(ws, id, "NO_AP", "No actions remaining.");

    const itemId = (params.itemId || "potion").toString();
    if (itemId !== "potion") return reject(ws, id, "BAD_ITEM", "Unsupported item.");

    const profile = rpgProfileById(actorPlayerId);
    if ((profile.inventory.potion || 0) <= 0) return reject(ws, id, "MISSING_ITEMS", "No potions available.");
    if (hero.hp >= hero.maxHp) return reject(ws, id, "FULL_HP", "Hero is already at full HP.");

    pushGameHistory();
    profile.inventory.potion -= 1;
    const healAmount = 6;
    const hpBefore = hero.hp;
    hero.hp = clamp(hero.hp + healAmount, 0, hero.maxHp);
    const actualHealed = hero.hp - hpBefore;
    game.turn.apRemaining = Math.max(0, (game.turn.apRemaining ?? 0) - 1);
    game.log.push({ at: Date.now(), msg: `${shortName(actorPlayerId)} drinks a potion and restores ${actualHealed} HP.` });

    send(ws, makeMsg(MsgType.OK, { accepted: true, used: itemId, healed: actualHealed }, id));
    emitViews();
  }

  function handleRevive(ws, id, actorPlayerId, params = {}) {
    if (!requireActive(ws, id, actorPlayerId)) return;
    const actorHero = game.heroes[actorPlayerId];
    if (!actorHero || actorHero.hp <= 0) return reject(ws, id, "HERO_DOWN", "Hero is down.");
    if ((game.turn.apRemaining ?? 0) <= 0) return reject(ws, id, "NO_AP", "No actions remaining.");

    const requestedTargetId = (params.targetPlayerId || "").toString().trim();
    const targets = downedHeroTargetsFor(actorPlayerId);
    if (!targets.length) return reject(ws, id, "NO_TARGET", "No downed ally in revive range.");

    const targetInfo = requestedTargetId
      ? targets.find((t) => t.playerId === requestedTargetId) || null
      : targets[0];
    if (!targetInfo) return reject(ws, id, "NO_TARGET", "Target is not in revive range.");

    const targetHero = game.heroes[targetInfo.playerId];
    if (!targetHero || targetHero.hp > 0) return reject(ws, id, "NO_TARGET", "Target is not downed.");

    pushGameHistory();
    const restoredHp = Math.max(1, Math.ceil(targetHero.maxHp * 0.4));
    targetHero.hp = clamp(restoredHp, 1, targetHero.maxHp);
    game.turn.apRemaining = Math.max(0, (game.turn.apRemaining ?? 0) - 1);
    game.log.push({
      at: Date.now(),
      msg: `${shortName(actorPlayerId)} revives ${shortName(targetInfo.playerId)} (${targetHero.hp}/${targetHero.maxHp} HP).`
    });

    send(ws, makeMsg(MsgType.OK, { accepted: true, revived: targetInfo.playerId, hp: targetHero.hp }, id));
    emitViews();
  }

  function handleEndTurn(ws, id, actorPlayerId) {
    if (!requireActive(ws, id, actorPlayerId)) return;

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
    ensureRpgProfile(campaignPlayer);
    const token = uuid();
    seatObj.occupied = true;
    seatObj.playerName = campaignPlayer.name;
    seatObj.playerId = campaignPlayer.id;
    seatObj.resumeToken = token;
    info.playerId = campaignPlayer.id;
    info.seat = seatObj.seat;
    ensureGameFor(campaignPlayer.id, seatObj.seat - 1);
    game.log.push({ at: Date.now(), msg: `Player joined campaign: ${campaignPlayer.name} (${campaignPlayer.id.slice(0, 4)})` });
    touchCampaign(campaign);
    saveCampaignStore(campaignStore);
    return token;
  }

  function handleSpawnEnemy(ws, id) {
    if (!game) return reject(ws, id, "NO_GAME", "No game started yet. Join a seat first.");

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
    const aliveProfiles = (game.turn.order || []).map((pid) => rpgProfileById(pid));
    const avgLevel = aliveProfiles.length
      ? aliveProfiles.reduce((sum, p) => sum + p.level, 0) / aliveProfiles.length
      : 1;
    const template = pickScaledEnemyTemplate(avgLevel, game.scenario?.defeatedCount || 0);
    game.enemies = game.enemies || [];
    game.enemies.push(makeEnemyFromTemplate(`enemy-${enemyNumber}`, template, spawn.x, spawn.y));
    game.lastHeroDamage = null;
    game.log.push({ at: Date.now(), msg: `${template.name} (Lv.${template.level}) spawned at (${spawn.x},${spawn.y}) by table.` });

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
      if (info.sessionId === session.sessionId && info.role === Role.PHONE && info.playerId === playerId) {
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

  function handleNewCampaign(ws, id) {
    resetCampaignInPlace();
    game = null;
    gameHistory.length = 0;

    for (const seatObj of session.seats) {
      seatObj.occupied = false;
      seatObj.playerName = null;
      seatObj.playerId = null;
      seatObj.resumeToken = null;
    }

    for (const [clientWs, info] of clients.entries()) {
      if (info.role !== Role.PHONE || info.sessionId !== session.sessionId) continue;
      info.playerId = null;
      info.seat = null;
      send(
        clientWs,
        makeMsg(
          MsgType.ERROR,
          { code: "CAMPAIGN_RESET", message: "Table started a new campaign. Join again to continue." },
          "campaign-reset"
        )
      );
      send(clientWs, makeMsg(MsgType.STATE_PRIVATE, { state: { sessionId: session.sessionId, player: null, game: null } }));
    }

    touchCampaign(campaign);
    saveCampaignStore(campaignStore);
    send(ws, makeMsg(MsgType.OK, { accepted: true, campaignId: campaign.id }, id));
    emitViews();
  }

  function handleAction(ws, id, actorPlayerId, payload) {
    if (!game) return reject(ws, id, "NO_GAME", "No game started yet. Join a seat first.");
    ensureGameShape();

    const action = payload?.action;
    const params = payload?.params ?? {};

    if (action === ActionType.MOVE) return handleMove(ws, id, actorPlayerId, params);
    if (action === ActionType.ATTACK) return handleAttack(ws, id, actorPlayerId, params);
    if (action === ActionType.CAST_SPELL) return handleCastSpell(ws, id, actorPlayerId, params);
    if (action === ActionType.REVIVE) return handleRevive(ws, id, actorPlayerId, params);
    if (action === ActionType.CRAFT_ITEM) return handleCraftItem(ws, id, actorPlayerId, params);
    if (action === ActionType.USE_ITEM) return handleUseItem(ws, id, actorPlayerId, params);
    if (action === ActionType.END_TURN) return handleEndTurn(ws, id, actorPlayerId);

    reject(ws, id, "UNKNOWN_ACTION", `Unknown action: ${action}`);
  }

  wss.on("connection", (ws) => {
    console.log(`[ws] connection open (build ${BUILD_TAG})`);
    const clientId = uuid();
    clients.set(ws, { clientId, role: null, playerId: null, seat: null, sessionId: null, gameId: null });

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
      const ctx = info?.sessionId ? getSessionContext(info.sessionId) : null;
      if (ctx) {
        bindContext(ctx);
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
        syncContext(ctx);
      }
      clients.delete(ws);
      if (ctx) {
        bindContext(ctx);
        emitViews();
        syncContext(ctx);
      }
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
      if (role === Role.TABLE) {
        const gameId = (msg.payload?.gameId ?? "").toString().trim();
        if (!gameId) return reject(ws, msg.id, "BAD_GAME", "gameId required for table clients.");
        info.gameId = gameId;
        send(ws, makeMsg(MsgType.OK, { clientId: info.clientId }, msg.id));
        send(ws, makeMsg(MsgType.CAMPAIGN_LIST, { gameId, campaigns: listCampaignSummaries(gameId) }, "campaign-list"));
        return;
      }

      if (role === Role.PHONE) {
        const sessionId = (msg.payload?.sessionId ?? "").toString().trim();
        if (!sessionId) return reject(ws, msg.id, "NO_SESSION", "sessionId required for phone clients.");
        const ctx = getSessionContext(sessionId);
        if (!ctx) return reject(ws, msg.id, "BAD_SESSION", "Unknown session.");
        info.sessionId = sessionId;
        info.gameId = ctx.gameId;
        bindContext(ctx);
        const resumeToken = msg.payload?.resumeToken;
        if (resumeToken) {
          const seat = session.seats.find((s) => s.resumeToken === resumeToken);
          if (seat) {
            info.playerId = seat.playerId;
            info.seat = seat.seat;
            ensureGameFor(seat.playerId, seat.seat - 1);
          }
        }
        send(ws, makeMsg(MsgType.OK, { clientId: info.clientId }, msg.id));
        emitViews();
        syncContext(ctx);
        return;
      }
    }

    if (msg.t === MsgType.CAMPAIGN_SELECT) {
      if (info.role !== Role.TABLE) return reject(ws, msg.id, "NOT_TABLE", "Only the table can select campaigns.");
      const requestedGameId = (msg.payload?.gameId ?? info.gameId ?? "").toString().trim();
      if (!requestedGameId) return reject(ws, msg.id, "BAD_GAME", "gameId required.");

      const prevSessionId = info.sessionId;
      if (prevSessionId) {
        const prevCtx = getSessionContext(prevSessionId);
        if (prevCtx && prevCtx.tableWs === ws) {
          bindContext(prevCtx);
          tableWs = null;
          syncContext(prevCtx);
        }
      }

      let campaignState = null;
      const requestedCampaignId = (msg.payload?.campaignId ?? "").toString().trim();
      if (requestedCampaignId) {
        campaignState = getCampaign(campaignStore, requestedGameId, requestedCampaignId);
        if (!campaignState) return reject(ws, msg.id, "BAD_CAMPAIGN", "Campaign not found.");
      } else {
        const title = (msg.payload?.title ?? "").toString().trim().slice(0, 48) || "New Campaign";
        campaignState = createCampaign(campaignStore, requestedGameId, title);
        touchCampaign(campaignState);
        saveCampaignStore(campaignStore);
      }

      const ctx = getOrCreateSessionForCampaign(requestedGameId, campaignState);
      bindContext(ctx);
      tableWs = ws;
      info.sessionId = session.sessionId;
      info.gameId = requestedGameId;
      send(ws, makeMsg(MsgType.OK, { accepted: true, campaignId: campaignState.id, sessionId: session.sessionId }, msg.id));
      send(
        ws,
        makeMsg(MsgType.SESSION_INFO, {
          sessionId: session.sessionId,
          joinUrl: getJoinUrl(),
          gameId: requestedGameId,
          campaign: { id: campaignState.id, title: campaignState.title }
        })
      );
      send(ws, makeMsg(MsgType.CAMPAIGN_LIST, { gameId: requestedGameId, campaigns: listCampaignSummaries(requestedGameId) }, "campaign-list"));
      emitViews();
      syncContext(ctx);
      return;
    }

    const ctx = info?.sessionId ? getSessionContext(info.sessionId) : null;
    if (!ctx) return reject(ws, msg.id, "NO_SESSION", "Select a campaign first.");
    bindContext(ctx);

    if (msg.t === MsgType.JOIN) {
      if (info.role !== Role.PHONE) {
        syncContext(ctx);
        return reject(ws, msg.id, "NOT_PHONE", "Only phones can JOIN");
      }
      const playerName = (msg.payload?.playerName ?? "").toString().trim().slice(0, 32);
      const requestedSeat = Number(msg.payload?.seat);
      if (!playerName) {
        syncContext(ctx);
        return reject(ws, msg.id, "BAD_NAME", "playerName required");
      }

      if (info.playerId) {
        // already joined (e.g., resumed via token)
        send(ws, makeMsg(MsgType.OK, { playerId: info.playerId, seat: info.seat, resumeToken: session.seats.find((s)=>s.playerId===info.playerId)?.resumeToken || undefined }, msg.id));
        emitViews();
        syncContext(ctx);
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
        syncContext(ctx);
        return;
      }

      let seatObj = null;
      if (Number.isFinite(requestedSeat) && requestedSeat >= 1 && requestedSeat <= session.seats.length) {
        const candidate = session.seats[requestedSeat - 1];
        if (!candidate.occupied) seatObj = candidate;
      }
      if (!seatObj) seatObj = session.seats.find((s) => !s.occupied) ?? null;
      if (!seatObj) {
        syncContext(ctx);
        return reject(ws, msg.id, "NO_SEATS", "No seats available");
      }

      const campaignPlayer = pickOrCreateCampaignPlayer(campaign, playerName, occupiedCampaignPlayerIds());
      const token = assignSeatToCampaignPlayer(seatObj, campaignPlayer, info);

      send(ws, makeMsg(MsgType.OK, { playerId: campaignPlayer.id, seat: seatObj.seat, resumeToken: token, campaignPlayerId: campaignPlayer.id }, msg.id));
      emitViews();
      syncContext(ctx);
      return;
    }

    if (msg.t === MsgType.ACTION) {
      if (info.role === Role.TABLE) {
        const action = msg.payload?.action;
        if (action === ActionType.SPAWN_ENEMY) {
          handleSpawnEnemy(ws, msg.id);
          syncContext(ctx);
          return;
        }
        if (action === ActionType.UNDO) {
          handleUndo(ws, msg.id);
          syncContext(ctx);
          return;
        }
        if (action === ActionType.KICK_PLAYER) {
          handleKickPlayer(ws, msg.id, msg.payload?.params ?? {});
          syncContext(ctx);
          return;
        }
        if (action === ActionType.NEW_CAMPAIGN) {
          handleNewCampaign(ws, msg.id);
          syncContext(ctx);
          return;
        }
        syncContext(ctx);
        reject(ws, msg.id, "TABLE_FORBIDDEN", "Table is view-only. Move from your phone.");
        return;
      }

      if (info.role === Role.PHONE) {
        if (!info.playerId) {
          syncContext(ctx);
          return reject(ws, msg.id, "NOT_JOINED", "Join a seat first.");
        }
        handleAction(ws, msg.id, info.playerId, msg.payload);
        syncContext(ctx);
        return;
      }

      syncContext(ctx);
      reject(ws, msg.id, "BAD_ROLE", "Unknown client role");
      return;
    }

    syncContext(ctx);
    reject(ws, msg.id, "UNKNOWN_TYPE", `Unknown type ${msg.t}`);
  }

  console.log(`WebSocket server ready. (build ${BUILD_TAG})`);
}
