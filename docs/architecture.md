# Architecture

## Components

### 1) Server (authoritative, runs on mini PC)
**Responsibilities**
- Own the canonical game state (campaign + current encounter)
- Validate and apply all actions (no client-side authority)
- Compute per-client visibility (public vs private views)
- Persist state (save/resume)
- Provide networking endpoints (HTTP + WebSocket)

**Non-responsibilities**
- Rendering UI (clients do that)
- Trusting client calculations or RNG outcomes

### 2) Table client (runs on mini PC, touch UI)
**Responsibilities**
- Render public/shared game state
- Capture touch interactions (tap, drag, pan/zoom)
- Send action requests to the server
- Display only public information

**Notes**
- Treat as a “public display,” not a privileged admin console
- Optionally include a “GM/admin” mode later

### 3) Phone client (runs on player devices, web/PWA)
**Responsibilities**
- Render private player info (hand, inventory, abilities, private rolls)
- Send action requests (choose ability, confirm, select target)
- Handle reconnect/refresh gracefully

### 4) Shared module (`shared/`)
**Responsibilities**
- Schemas/types for state, entities, and protocol messages
- Constants (action types, phases, error codes)
- Validation helpers

## Data flow
- Clients connect to server over **WebSocket** for real-time updates.
- Server emits:
  - **public view** to the table client
  - **private view** to each phone client
- Clients send **action requests**; server replies with either:
  - action accepted + updated state
  - action rejected + error reason

## Canonical state vs views
- **Canonical State**: everything the game knows (including secrets)
- **Public View**: what the table is allowed to see
- **Private View**: what a specific player is allowed to see

Rule: *Visibility is computed server-side*.

## Persistence
Minimum viable persistence:
- Single campaign save file (JSON) containing:
  - campaign meta
  - players + characters
  - unlocked content flags
  - last encounter state
Later: migrate to SQLite for robustness and querying.

## Networking model (local-first)
- Server binds to LAN interface
- Players join via:
  - `http://<device-ip>:<port>`
  - or `http://touchtable.local:<port>` (mDNS optional)
- Join uses QR + session code + optional PIN per seat

## Failure handling
- Phone refresh/reconnect: server re-sends latest private view
- Table reconnect: server re-sends public view
- Server crash: auto-save periodically; safe resume from last checkpoint
