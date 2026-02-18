# Protocol (Draft)

This is a high-level message protocol intended for WebSocket communication.
Keep messages small and versioned.

## Envelope
All messages share:
- `v`: protocol version (integer)
- `t`: message type (string)
- `id`: message id (client-generated for requests)
- `ts`: timestamp (server-generated on responses/events)
- `payload`: message-specific content

Example:
```json
{ "v": 2, "t": "PING", "id": "c1-0001", "payload": {} }
```

## Client -> Server (requests)

### HELLO
Identify client role and desired session.
```json
{
  "v": 2,
  "t": "HELLO",
  "id": "c1-0001",
  "payload": {
    "role": "table" | "phone",
    "gameId": "touchtable-dungeon", // table only
    "sessionId": "abcd1234",        // phone only
    "resumeToken": "optional"
  }
}
```

### CAMPAIGN_SELECT (table)
Start a new campaign or load an existing one.
```json
{
  "v": 2,
  "t": "CAMPAIGN_SELECT",
  "id": "c1-0001",
  "payload": {
    "gameId": "touchtable-dungeon",
    "campaignId": "campaign-1234", // optional if creating new
    "title": "My Campaign"         // required when creating new
  }
}
```

### JOIN (phone)
Request a seat.
```json
{
  "v": 2,
  "t": "JOIN",
  "id": "c1-0002",
  "payload": { "playerName": "Cody", "seat": 1, "pin": "optional" }
}
```

### ACTION
Request a game action.
```json
{
  "v": 2,
  "t": "ACTION",
  "id": "c1-0003",
  "payload": {
    "action": "MOVE" | "ATTACK" | "END_TURN",
    "params": { }
  }
}
```

## Server -> Client (responses)
Responses echo the request `id` when applicable.

### OK
```json
{ "v": 2, "t": "OK", "id": "c1-0002", "payload": { } }
```

### ERROR
```json
{
  "v": 2,
  "t": "ERROR",
  "id": "c1-0003",
  "payload": { "code": "INVALID_ACTION", "message": "Not your turn." }
}
```

## Server -> Client (events)

### STATE_PUBLIC (to table)
```json
{ "v": 2, "t": "STATE_PUBLIC", "payload": { "state": { } } }
```

### STATE_PRIVATE (to a phone)
```json
{ "v": 2, "t": "STATE_PRIVATE", "payload": { "state": { } } }
```

### CAMPAIGN_LIST (to table)
```json
{
  "v": 2,
  "t": "CAMPAIGN_LIST",
  "payload": {
    "gameId": "touchtable-dungeon",
    "campaigns": [
      { "id": "campaign-1234", "title": "My Campaign", "createdAt": 1700000000000, "updatedAt": 1700000000000 }
    ]
  }
}
```

### SESSION_INFO (to table for QR display)
```json
{
  "v": 2,
  "t": "SESSION_INFO",
  "payload": {
    "sessionId": "abcd1234",
    "joinUrl": "http://...",
    "gameId": "touchtable-dungeon",
    "campaign": { "id": "campaign-1234", "title": "My Campaign" }
  }
}
```

## Notes
- Prefer **snapshots** early; diffs can come later.
- Keep canonical schema in `shared/` once implemented.
