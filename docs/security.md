# Security (Local-first)

This project is local-first and typically runs on a trusted LAN. Still, assume phones can be compromised and clients can be modified.

## Threat model (v1)
- A player could run a modified client to attempt cheating
- A player could attempt to impersonate another seat
- A player could spam actions to cause lag

## Security principles
1. **Authoritative server**: all actions validated server-side.
2. **Least privilege views**: clients only receive data they are allowed to see.
3. **Session join control**: join code + optional PIN per seat.
4. **Rate limiting**: throttle action requests per client.
5. **No secrets on the table**: the table client gets public view only.

## Join flow recommendations
- Table displays QR code containing server URL + session id
- Player enters a name and selects a seat (or server assigns)
- Server returns a short-lived auth token for that seat
- Token stored in phone local storage for reconnect

## Data separation
- Server maintains canonical state
- Computes:
  - `publicState` for table
  - `privateState[playerId]` for phones

## Logging
- Server logs actions and rejections for debugging and anti-cheat diagnostics.
