# Vision

## One-sentence pitch
A local-first, self-hosted cooperative dungeon crawl where the table touchscreen shows shared state and players join from phones for private information and controls, played as a persistent campaign over many sessions.

## The experience
- Players gather around a physical table with a large touchscreen.
- The table shows the dungeon map, minis, and public status.
- Each player uses a phone as a personal “player board” with private info and actions.
- The system enforces rules, manages fog-of-war, and saves progress between sessions.

## Product pillars
1. **Authoritative server**: clients request actions; server validates and applies.
2. **Asymmetric information**: table is public; phones are private; server controls visibility.
3. **Campaign persistence**: reliable save/resume; long-running progression.
4. **Touch-first**: big interactions and low friction on the table display.
5. **Local-first & owner-controlled**: you control hosting/network/security; offline LAN play.

## Target hardware
- 50" IR touchscreen embedded into a table
- Mini PC connected to the display (runs server + table client)
- Player phones on the same LAN

## Non-goals (v1)
- Internet matchmaking / public hosting
- Account systems and payments
- Mandatory AI GM (AI must be optional)
- AAA visuals; prioritize responsiveness and clarity

## Success criteria (v1)
- Host a session on the mini PC
- Players join via phones using QR/code
- Play a minimal encounter for 15+ minutes without desync
- Save and resume later
