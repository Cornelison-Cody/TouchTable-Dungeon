import React, { useEffect, useMemo, useRef, useState } from "react";
import { MsgType, Role, makeMsg } from "../../shared/protocol.js";
import { ActionType } from "../../shared/game.js";

const cardStyle = {
  border: "1px solid #ddd",
  borderRadius: 12,
  padding: 16,
  marginBottom: 12,
  background: "#fff"
};

const mono = {
  fontFamily:
    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace"
};

function getQuerySessionId() {
  const u = new URL(window.location.href);
  return u.searchParams.get("session");
}

function defaultWsUrl() {
  const host = window.location.hostname || "localhost";
  return localStorage.getItem("tt_server_ws") || `ws://${host}:3000`;
}

export default function App() {
  const [wsUrl, setWsUrl] = useState(defaultWsUrl());
  const [status, setStatus] = useState("disconnected");
  const [clientId, setClientId] = useState(null);
  const [error, setError] = useState(null);

  const [playerName, setPlayerName] = useState(localStorage.getItem("tt_player_name") || "");
  const [seat, setSeat] = useState(1);
  const [joined, setJoined] = useState(false);
  const [player, setPlayer] = useState(null);
  const [privateState, setPrivateState] = useState(null);

  const resumeToken = useMemo(() => localStorage.getItem("tt_resume_token") || "", []);
  const sessionId = useMemo(() => getQuerySessionId() || "", []);

  const wsRef = useRef(null);

  useEffect(() => {
    setError(null);
    setStatus("connecting");

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus("connected");
      ws.send(
        JSON.stringify(
          makeMsg(
            MsgType.HELLO,
            {
              role: Role.PHONE,
              sessionId,
              resumeToken: resumeToken || undefined
            },
            "hello-phone"
          )
        )
      );
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.t === MsgType.OK && msg.id === "hello-phone") {
          setClientId(msg.payload?.clientId ?? null);
        } else if (msg.t === MsgType.OK && msg.id === "join") {
          const token = msg.payload?.resumeToken;
          if (token) localStorage.setItem("tt_resume_token", token);
          if (msg.payload?.seat) setJoined(true);
        } else if (msg.t === MsgType.STATE_PRIVATE) {
          const st = msg.payload?.state ?? null;
          setPrivateState(st);
          if (st?.player) {
            setJoined(true);
            setPlayer(st.player);
          }
        } else if (msg.t === MsgType.OK && msg.id === "act") {
          // action accepted
        } else if (msg.t === MsgType.ERROR) {
          setError(msg.payload?.message ?? "Unknown error");
        }
      } catch {
        // ignore
      }
    };

    ws.onclose = () => setStatus("disconnected");
    ws.onerror = () => setStatus("error");

    return () => {
      try {
        ws.close();
      } catch {
        // ignore
      }
    };
  }, [wsUrl, resumeToken, sessionId]);

  function reconnect() {
    localStorage.setItem("tt_server_ws", wsUrl);
    setWsUrl(wsUrl.trim());
  }

  function doJoin() {
    setError(null);
    const ws = wsRef.current;
    const name = playerName.trim().slice(0, 32);
    if (!name) {
      setError("Enter a player name.");
      return;
    }
    localStorage.setItem("tt_player_name", name);

    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setError("Not connected to server.");
      return;
    }

    ws.send(JSON.stringify(makeMsg(MsgType.JOIN, { playerName: name, seat: Number(seat) || undefined }, "join")));
  }

  function sendAction(action) {
    setError(null);
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setError("Not connected to server.");
      return;
    }
    ws.send(JSON.stringify(makeMsg(MsgType.ACTION, { action, params: {} }, "act")));
  }

  const g = privateState?.game || null;
  const active = Boolean(g?.youAreActive);
  const hero = g?.hero || null;
  const allowed = new Set(g?.allowedActions || []);

  return (
    <div style={{ padding: 16, maxWidth: 720, margin: "0 auto", background: "#f6f7f9", minHeight: "100vh" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
        <h1 style={{ margin: 0 }}>TouchTable Dungeon — Phone</h1>
        <div style={{ ...mono, opacity: 0.8 }}>
          status: {status} {clientId ? `• clientId=${clientId}` : ""}
        </div>
      </div>

      <div style={cardStyle}>
        <h2 style={{ marginTop: 0 }}>Server</h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <label style={{ width: 120 }}>WS URL</label>
          <input
            value={wsUrl}
            onChange={(e) => setWsUrl(e.target.value)}
            style={{ flex: 1, padding: 10, borderRadius: 10, border: "1px solid #ccc" }}
          />
          <button
            onClick={reconnect}
            style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ccc", background: "#fff" }}
          >
            Reconnect
          </button>
        </div>
      </div>

      {!joined ? (
        <div style={cardStyle}>
          <h2 style={{ marginTop: 0 }}>Join</h2>
          <div style={{ marginBottom: 10, opacity: 0.8 }}>
            session: <span style={mono}>{sessionId || "(none)"}</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 120px", gap: 8 }}>
            <input
              placeholder="Your name"
              value={playerName}
              onChange={(e) => setPlayerName(e.target.value)}
              style={{ padding: 12, borderRadius: 10, border: "1px solid #ccc" }}
            />
            <input
              type="number"
              min="1"
              max="6"
              value={seat}
              onChange={(e) => setSeat(e.target.value)}
              style={{ padding: 12, borderRadius: 10, border: "1px solid #ccc" }}
            />
          </div>
          <button
            onClick={doJoin}
            style={{ marginTop: 10, width: "100%", padding: 12, borderRadius: 12, border: "1px solid #ccc", background: "#fff" }}
          >
            Join Seat
          </button>
          <p style={{ marginBottom: 0, opacity: 0.75 }}>
            Seat is optional; if taken, the server will assign the next available seat.
          </p>
        </div>
      ) : (
        <>
          <div style={cardStyle}>
            <h2 style={{ marginTop: 0 }}>You</h2>
            {player ? (
              <>
                <div style={mono}>
                  {player.playerName} • seat {player.seat} • {active ? "YOUR TURN" : "waiting…"}
                </div>
                <div style={{ marginTop: 10, opacity: 0.9 }}>
                  Hero HP: <span style={mono}>{hero ? `${hero.hp}/${hero.maxHp}` : "—"}</span>
                </div>
              </>
            ) : (
              <p>Joined, waiting for private state…</p>
            )}
          </div>

          <div style={cardStyle}>
            <h2 style={{ marginTop: 0 }}>Actions</h2>
            <button
              disabled={!active || !allowed.has(ActionType.ATTACK)}
              onClick={() => sendAction(ActionType.ATTACK)}
              style={{
                width: "100%",
                padding: 14,
                borderRadius: 12,
                border: "1px solid #ccc",
                background: "#fff",
                opacity: !active ? 0.6 : 1,
                marginBottom: 10
              }}
            >
              Attack (melee)
            </button>

            <button
              disabled={!active || !allowed.has(ActionType.END_TURN)}
              onClick={() => sendAction(ActionType.END_TURN)}
              style={{
                width: "100%",
                padding: 14,
                borderRadius: 12,
                border: "1px solid #ccc",
                background: "#fff",
                opacity: !active ? 0.6 : 1
              }}
            >
              End Turn
            </button>

            <p style={{ marginBottom: 0, opacity: 0.75 }}>
              Move is done on the table by tapping a tile (range 1).
            </p>
          </div>
        </>
      )}

      {error ? <p style={{ color: "crimson" }}>Error: {error}</p> : null}
    </div>
  );
}
