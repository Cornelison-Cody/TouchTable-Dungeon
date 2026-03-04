import React from "react";
import DungeonPhoneApp from "./DungeonPhoneApp.jsx";

function getGameId() {
  const u = new URL(window.location.href);
  return (u.searchParams.get("game") || "").trim();
}

export default function App() {
  const gameId = getGameId();
  if (gameId === "kewl-card-game") {
    return (
      <div
        style={{
          minHeight: "100vh",
          margin: 0,
          padding: "24px 18px",
          display: "grid",
          alignContent: "center",
          justifyItems: "center",
          gap: 12,
          background: "#0f1722",
          color: "#e6edf6",
          fontFamily: "Avenir Next, Segoe UI, Helvetica Neue, sans-serif",
          textAlign: "center"
        }}
      >
        <h1 style={{ margin: 0, fontSize: "1.4rem" }}>Kewl Card Game</h1>
        <p style={{ margin: 0, maxWidth: 420, color: "#9db0c3", lineHeight: 1.45 }}>
          This mode is table-only. Phones are not used for Kewl Card Game.
        </p>
      </div>
    );
  }
  return <DungeonPhoneApp />;
}
