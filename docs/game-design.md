# Game Design

This doc describes the rules and content model at a high level. Keep the MVP small and build complexity later.

## Core loop
1. Setup encounter (map/room, enemies, objectives)
2. Players take turns (or phases) to act
3. Enemies act (AI)
4. Apply effects and check win/loss
5. Resolve rewards and campaign progress
6. Save and exit

## Actions (generic)
- Move
- Attack
- Use ability
- Interact (door, chest, lever)
- End turn

## Entities
- **Character**: player-controlled hero with stats, abilities, inventory
- **Enemy**: AI-controlled unit with behavior profile
- **Object**: doors, chests, traps, hazards
- **Tile/Cell**: map location, fog state, terrain

## Visibility & Fog-of-war
- Table shows:
  - explored tiles
  - visible enemies/objects
  - public status effects
- Phones may show:
  - private hand/abilities
  - private objectives/notes
  - private roll outcomes (optional)

## Campaign model
- Campaign has:
  - player roster
  - character progression (XP, items)
  - world state flags (unlocks, story choices)
  - a log of completed scenarios
- Sessions are discrete “expeditions.”

## RNG
- All RNG occurs on the server.
- Optionally allow deterministic RNG using a seed for debugging/replay.

## AI (later)
AI is **assistive**, not required:
- procedural dungeon generation
- flavor text generation
- lightweight enemy behavior selection
Game must remain playable with AI disabled.
