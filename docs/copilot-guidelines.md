# Copilot Guidelines

This repository implements a local-first tabletop dungeon crawl
with asymmetric information.

## Non-negotiable rules
- The server is authoritative for all game state and RNG
- Clients never compute outcomes
- Table client receives public state only
- Phone clients receive only their private state
- Visibility rules are enforced server-side
- No game logic in React components beyond rendering

## Architectural boundaries
- server/: rules, validation, persistence, visibility
- client-table/: touch-first shared UI
- client-phone/: private per-player UI
- shared/: schemas, protocol, constants only

## Networking
- WebSocket messages must follow docs/protocol.md
- All messages are versioned
- Clients send requests; server sends state snapshots/events

## Campaign
- Campaign state must be serializable
- Game must resume safely after restart
- No required cloud dependencies

## AI usage
- AI features must be optional
- Core gameplay must work without AI
