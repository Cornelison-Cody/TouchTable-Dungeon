# MVP

## MVP goal
Prove the core architecture: authoritative server + table UI + phone UI with asymmetric information and real-time sync.

## Minimal playable scenario
“One room, one hero, one enemy.”

### Required features
- Host session on mini PC
- Phone joins via QR or short code
- Table shows:
  - grid/room
  - hero + enemy tokens
  - turn indicator
- Phone shows:
  - player identity + simple action controls (Move / Attack / End Turn)
- Server enforces:
  - turn order
  - move range
  - attack resolution (simple)
- Sync:
  - state snapshot on join
  - updates on every action

## Acceptance criteria
- Complete multiple turns without desync
- Invalid actions are rejected server-side with a clear error
- Phone refreshes and can rejoin the same seat
- Session can run 15+ minutes reliably

## Post-MVP next steps
1. Add hidden info (inventory/hand)
2. Add fog-of-war
3. Add persistence (save/resume)
4. Add second hero, multiple enemies, simple AI
