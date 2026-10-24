# AGENTS.md - Real Guitar Rhythm Game Workspace Rules

## 1. Environment & Architecture
- **Monorepo:** `backend/` (Python 3.13, virtualenv) and `frontend/` (TypeScript, Vite, Three.js).
- **Backend venv:** Always activate `backend/.venv` before running any Python command (`source backend/.venv/bin/activate`).
- **Data Boundaries:** Raw `.gp5` files live in `backend/data/raw_gp5/`, output JSON charts live in `backend/data/charts/`.

## 2. Verification Commands
- **Backend tests:** `pytest backend/tests/ -v`
- **Tab parser dry run:** `python -m backend.pipeline.tab_parser backend/data/raw_gp5/sample.gp5`
- **Frontend build/typecheck:** `cd frontend && npm run build`
- **Dev servers:**
  - Backend: `uvicorn backend.main:app --reload --port 8000`
  - Frontend: `npm run dev` (inside `frontend/`)

## 3. Implementation Guardrails
- **Tab Ingestion:**
  - Binary parsing must use `pyguitarpro`. Do not attempt custom binary unpackers.
  - Exported JSON must use millisecond timestamps (`time_ms`), string (1–6), fret (0–24), and technique flags (`hammer_on`, `pull_off`, `slide`, `bend`).
- **Audio Sync:**
  - Transient analysis must use `librosa.onset.onset_detect`.
  - Always support an adjustable `offset_ms` parameter in the sync pipeline.
- **Frontend Engine:**
  - Use Three.js for highway projection. Keep coordinate math decoupled from rendering logic.
  - Web Audio API input handling must run via an `AudioWorklet` or deterministic pitch-detection loop (e.g., McLeod Pitch Method / YIN / autocorrelation).