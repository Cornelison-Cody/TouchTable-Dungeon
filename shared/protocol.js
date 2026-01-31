export const PROTOCOL_VERSION = 1;

export const MsgType = Object.freeze({
  HELLO: "HELLO",
  JOIN: "JOIN",
  ACTION: "ACTION",
  PING: "PING",
  OK: "OK",
  ERROR: "ERROR",
  SESSION_INFO: "SESSION_INFO",
  STATE_PUBLIC: "STATE_PUBLIC",
  STATE_PRIVATE: "STATE_PRIVATE"
});

export const Role = Object.freeze({
  TABLE: "table",
  PHONE: "phone"
});

export function makeMsg(t, payload = {}, id = undefined) {
  const msg = { v: PROTOCOL_VERSION, t, payload };
  if (id) msg.id = id;
  return msg;
}
