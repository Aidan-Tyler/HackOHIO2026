# AGENTS.md - Web Guitar Rhythm Game Rules

## 1. Stack & Architecture
- **Frontend:** TypeScript, Vite, Three.js (`frontend/`).
- **Backend:** Python virtualenv (`backend/.venv/bin/python`) for tab parsing and Demucs stem generation.
- **Charts:** JSON charts stored in `frontend/public/charts/`.
- **Audio:** Backing audio served from `frontend/public/audio/`.

## 2. Audio Clock & Sync Invariants
- **NEVER** use `requestAnimationFrame` delta accumulation or `performance.now()` as the primary clock.
- **Always** tie visual position to `audioElement.currentTime * 1000.0 + globalOffsetMs`.
- Hotkeys `[` and `]` must nudge `globalOffsetMs` by ±10ms live.

## 3. Yousician Perspective Invariants (Three.js)
- **Target Bar / Pinned Fretboard (Z = 0):**
  - 6 horizontal colored strings parallel across X (String 1 Purple down to String 6 Red).
  - Vertical metallic fret markers for frets 0–15 with numeric labels underneath.
  - Active green hand position bounding bracket.
- **Highway:** Slopes backward into `-Z`.
- **Note Mesh Placement:**
  - $X =$ Fret position ($0–15$)
  - $Y =$ String rail plane ($1–6$)
  - $Z = (note.timeMs - audioTimeMs) \times speedFactor$