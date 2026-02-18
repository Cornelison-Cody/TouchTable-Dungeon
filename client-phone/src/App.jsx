import React from "react";
import DungeonPhoneApp from "./DungeonPhoneApp.jsx";
import KewlCardGamePhoneApp from "./KewlCardGamePhoneApp.jsx";

function getGameId() {
  const u = new URL(window.location.href);
  return (u.searchParams.get("game") || "").trim();
}

export default function App() {
  const gameId = getGameId();
  if (gameId === "kewl-card-game") {
    return <KewlCardGamePhoneApp />;
  }
  return <DungeonPhoneApp />;
}
