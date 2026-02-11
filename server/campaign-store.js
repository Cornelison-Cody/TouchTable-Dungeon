import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { v4 as uuid } from "uuid";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CAMPAIGN_FILE = path.join(__dirname, ".campaign-state.json");

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
  return {
    ...base,
    ...state,
    players: Array.isArray(state.players) ? state.players : [],
    progression: {
      ...base.progression,
      ...(state.progression && typeof state.progression === "object" ? state.progression : {})
    }
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
      }
    };
    players.push(candidate);
  } else {
    candidate.lastJoinedAt = Date.now();
    if (name && (matchedByName || !candidate.name)) candidate.name = name;
  }

  campaignState.players = players;
  campaignState.updatedAt = Date.now();
  return candidate;
}
