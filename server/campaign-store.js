import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { v4 as uuid } from "uuid";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CAMPAIGN_STORE_FILE = path.join(__dirname, ".campaigns.json");
const LEGACY_CAMPAIGN_FILE = path.join(__dirname, ".campaign-state.json");

export function makeDefaultRpgProfile() {
  return {
    level: 1,
    xp: 0,
    xpToNext: 20,
    gold: 0,
    weaponId: "rusty_blade",
    spellId: "arc_bolt",
    inventory: {
      herb: 0,
      fang: 0,
      essence: 0,
      potion: 0
    }
  };
}

export function makeDefaultCampaignState({ title } = {}) {
  const now = Date.now();
  return {
    id: `campaign-${uuid().slice(0, 8)}`,
    title: typeof title === "string" && title.trim() ? title.trim() : "New Campaign",
    createdAt: now,
    updatedAt: now,
    players: [],
    progression: {
      currentScenarioId: "scenario-1",
      completedScenarioIds: [],
      victories: 0
    },
    activeGame: null
  };
}

function makeDefaultStore() {
  return {
    version: 1,
    games: {}
  };
}

function sanitizeCampaign(raw) {
  const base = makeDefaultCampaignState();
  const state = raw && typeof raw === "object" ? raw : {};
  const rawPlayers = Array.isArray(state.players) ? state.players : [];
  const createdAt = Number(state.createdAt) || base.createdAt;
  const updatedAt = Number(state.updatedAt) || createdAt;
  return {
    ...base,
    ...state,
    createdAt,
    updatedAt,
    players: rawPlayers.map((p) => sanitizeCampaignPlayer(p)),
    progression: {
      ...base.progression,
      ...(state.progression && typeof state.progression === "object" ? state.progression : {})
    }
  };
}

function sanitizeStore(raw) {
  const base = makeDefaultStore();
  const store = raw && typeof raw === "object" ? raw : {};
  const rawGames = store.games && typeof store.games === "object" ? store.games : {};
  const games = {};
  for (const [gameId, entry] of Object.entries(rawGames)) {
    const campaigns = Array.isArray(entry?.campaigns) ? entry.campaigns : [];
    games[gameId] = {
      campaigns: campaigns.map((c) => sanitizeCampaign(c))
    };
  }
  return {
    ...base,
    ...store,
    games
  };
}

function sanitizeInventory(rawInventory) {
  const base = makeDefaultRpgProfile().inventory;
  const src = rawInventory && typeof rawInventory === "object" ? rawInventory : {};
  const safe = { ...base };
  for (const key of Object.keys(base)) {
    safe[key] = Math.max(0, Number(src[key]) || 0);
  }
  return safe;
}

function sanitizeRpgProfile(rawRpg) {
  const base = makeDefaultRpgProfile();
  const src = rawRpg && typeof rawRpg === "object" ? rawRpg : {};
  const level = Math.max(1, Number(src.level) || base.level);
  const xpToNext = Math.max(10, Number(src.xpToNext) || base.xpToNext);
  return {
    ...base,
    ...src,
    level,
    xp: Math.max(0, Number(src.xp) || 0),
    xpToNext,
    gold: Math.max(0, Number(src.gold) || 0),
    inventory: sanitizeInventory(src.inventory)
  };
}

function sanitizeCampaignPlayer(rawPlayer) {
  const src = rawPlayer && typeof rawPlayer === "object" ? rawPlayer : {};
  return {
    ...src,
    id: typeof src.id === "string" && src.id ? src.id : `cp-${uuid().slice(0, 8)}`,
    name: typeof src.name === "string" && src.name.trim() ? src.name.trim() : "Adventurer",
    createdAt: Number(src.createdAt) || Date.now(),
    lastJoinedAt: Number(src.lastJoinedAt) || Date.now(),
    retired: Boolean(src.retired),
    stats: {
      victories: Math.max(0, Number(src?.stats?.victories) || 0),
      scenariosCompleted: Math.max(0, Number(src?.stats?.scenariosCompleted) || 0)
    },
    rpg: sanitizeRpgProfile(src.rpg)
  };
}

function ensureGameEntry(store, gameId) {
  if (!store.games[gameId]) {
    store.games[gameId] = { campaigns: [] };
  } else if (!Array.isArray(store.games[gameId].campaigns)) {
    store.games[gameId].campaigns = [];
  }
  return store.games[gameId];
}

export function loadCampaignStore() {
  try {
    if (!fs.existsSync(CAMPAIGN_STORE_FILE)) {
      const fallback = makeDefaultStore();
      if (fs.existsSync(LEGACY_CAMPAIGN_FILE)) {
        const text = fs.readFileSync(LEGACY_CAMPAIGN_FILE, "utf8");
        const legacy = sanitizeCampaign(JSON.parse(text));
        fallback.games["touchtable-dungeon"] = { campaigns: [legacy] };
      }
      return fallback;
    }
    const text = fs.readFileSync(CAMPAIGN_STORE_FILE, "utf8");
    const parsed = JSON.parse(text);
    return sanitizeStore(parsed);
  } catch {
    return makeDefaultStore();
  }
}

export function saveCampaignStore(store) {
  const safe = sanitizeStore(store);
  fs.writeFileSync(CAMPAIGN_STORE_FILE, JSON.stringify(safe, null, 2), "utf8");
}

export function listCampaigns(store, gameId) {
  const entry = ensureGameEntry(store, gameId);
  return entry.campaigns
    .map((c) => sanitizeCampaign(c))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export function getCampaign(store, gameId, campaignId) {
  const entry = ensureGameEntry(store, gameId);
  if (!campaignId) return null;
  return entry.campaigns.find((c) => c.id === campaignId) || null;
}

export function createCampaign(store, gameId, title) {
  const entry = ensureGameEntry(store, gameId);
  const campaign = makeDefaultCampaignState({ title });
  entry.campaigns.push(campaign);
  return campaign;
}

export function touchCampaign(campaign) {
  if (campaign && typeof campaign === "object") {
    campaign.updatedAt = Date.now();
  }
}

export function pickOrCreateCampaignPlayer(campaignState, playerName, occupiedPlayerIds = new Set()) {
  const name = (playerName || "").trim();
  const lcName = name.toLowerCase();
  const players = campaignState.players || [];

  let matchedByName = false;
  let candidate = players.find((p) => !occupiedPlayerIds.has(p.id) && p.name && p.name.toLowerCase() === lcName) || null;
  if (candidate) matchedByName = true;
  if (!candidate) candidate = players.find((p) => !occupiedPlayerIds.has(p.id)) || null;

  if (!candidate) {
    candidate = {
      id: `cp-${uuid().slice(0, 8)}`,
      name: name || `Adventurer ${players.length + 1}`,
      createdAt: Date.now(),
      lastJoinedAt: Date.now(),
      retired: false,
      stats: {
        victories: 0,
        scenariosCompleted: 0
      },
      rpg: makeDefaultRpgProfile()
    };
    players.push(candidate);
  } else {
    candidate.lastJoinedAt = Date.now();
    if (name && (matchedByName || !candidate.name)) candidate.name = name;
    candidate.rpg = sanitizeRpgProfile(candidate.rpg);
  }

  campaignState.players = players;
  campaignState.updatedAt = Date.now();
  return candidate;
}
