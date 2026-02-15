import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { v4 as uuid } from "uuid";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CAMPAIGN_FILE = path.join(__dirname, ".campaign-state.json");

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

export function makeDefaultCampaignState() {
  const now = Date.now();
  return {
    id: "campaign-1",
    title: "TouchTable Campaign",
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

function sanitizeCampaign(raw) {
  const base = makeDefaultCampaignState();
  const state = raw && typeof raw === "object" ? raw : {};
  const rawPlayers = Array.isArray(state.players) ? state.players : [];
  return {
    ...base,
    ...state,
    players: rawPlayers.map((p) => sanitizeCampaignPlayer(p)),
    progression: {
      ...base.progression,
      ...(state.progression && typeof state.progression === "object" ? state.progression : {})
    }
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

export function loadCampaignState() {
  try {
    if (!fs.existsSync(CAMPAIGN_FILE)) return makeDefaultCampaignState();
    const text = fs.readFileSync(CAMPAIGN_FILE, "utf8");
    const parsed = JSON.parse(text);
    return sanitizeCampaign(parsed);
  } catch {
    return makeDefaultCampaignState();
  }
}

export function saveCampaignState(campaignState) {
  const safe = sanitizeCampaign(campaignState);
  safe.updatedAt = Date.now();
  fs.writeFileSync(CAMPAIGN_FILE, JSON.stringify(safe, null, 2), "utf8");
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
