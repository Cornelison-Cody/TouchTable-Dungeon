# TouchTable Dungeon Crawl

Local-first, self-hosted cooperative dungeon crawl designed for a 50" IR touchscreen table + a mini PC, with players connecting from phones for hidden information and controls.

## What this is
- **Table (touchscreen)** shows shared state: map, minis, public info.
- **Phones** show private state: hands/abilities, inventory, secret info, private rolls.
- **Mini PC** runs an **authoritative server**: rules, validation, persistence, networking, visibility.

## Goals
- Touch-first tabletop experience on the big screen
- Asymmetric information (public on table, private on phones)
- Persistent campaign (multi-session)
- Local network hosting with security-conscious defaults
- No vendor lock-in: you control hosting, networking, and data

## Non-goals for v1
- Cloud matchmaking / internet hosting
- App-store native phone apps (start web/PWA)
- AI as a required game master (AI must be optional and non-blocking)

## Repo layout
```
touchtable-dungeon/
├── docs/                 # Design docs and specs
├── server/               # Authoritative game server (to implement)
├── client-table/         # Table display client (touch UI)
├── client-phone/         # Phone client (PWA / web UI)
└── shared/               # Shared schemas/types/constants
```

## Getting started (dev)
This repo currently contains **specs and scaffolding**. After you pick a stack, you’ll implement:

- `server/` (WebSocket/HTTP server, game rules, persistence)
- `client-table/` (table UI)
- `client-phone/` (player UI)
- `shared/` (state schemas + protocol types)

Recommended first implementation path:
1. Implement the **protocol** in `docs/protocol.md`
2. Build **Milestone 1** from `docs/mvp.md`
3. Keep docs updated as decisions change

## Design docs
- `docs/vision.md` — pitch, goals, non-goals, pillars
- `docs/architecture.md` — components, responsibilities, data flow
- `docs/protocol.md` — message formats and events
- `docs/mvp.md` — smallest playable slice + acceptance criteria
- `docs/game-design.md` — rules, loop, campaign model
- `docs/security.md` — local-first security model and defaults

## License
MIT (see `LICENSE`).
