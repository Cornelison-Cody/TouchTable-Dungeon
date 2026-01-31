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
{ "v": 1, "t": "PING", "id": "c1-0001", "payload": {} }
```

## Client -> Server (requests)

### HELLO
Identify client role and desired session.
```json
{
  "v": 1,
  "t": "HELLO",
  "id": "c1-0001",
  "payload": {
    "role": "table" | "phone",
    "sessionId": "abcd1234",
    "resumeToken": "optional"
  }
}
```

### JOIN (phone)
Request a seat.
```json
{
  "v": 1,
  "t": "JOIN",
  "id": "c1-0002",
  "payload": { "playerName": "Cody", "seat": 1, "pin": "optional" }
}
```

### ACTION
Request a game action.
```json
{
  "v": 1,
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
{ "v": 1, "t": "OK", "id": "c1-0002", "payload": { } }
```

### ERROR
```json
{
  "v": 1,
  "t": "ERROR",
  "id": "c1-0003",
  "payload": { "code": "INVALID_ACTION", "message": "Not your turn." }
}
```

## Server -> Client (events)

### STATE_PUBLIC (to table)
```json
{ "v": 1, "t": "STATE_PUBLIC", "payload": { "state": { } } }
```

### STATE_PRIVATE (to a phone)
```json
{ "v": 1, "t": "STATE_PRIVATE", "payload": { "state": { } } }
```

### SESSION_INFO (to table for QR display)
```json
{
  "v": 1,
  "t": "SESSION_INFO",
  "payload": { "sessionId": "abcd1234", "joinUrl": "http://..." }
}
```

## Notes
- Prefer **snapshots** early; diffs can come later.
- Keep canonical schema in `shared/` once implemented.
