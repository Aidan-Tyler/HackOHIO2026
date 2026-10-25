"""FastAPI app: GProTab search, tab import (download + parse to chart JSON), chart serving."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import requests
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel

from backend.pipeline import backing_jobs
from backend.pipeline.gprotab_client import SLUG_RE, download_tab, search_tabs
from backend.pipeline.tab_parser import parse_gp_file

DATA_DIR = Path(__file__).resolve().parent / "data"
RAW_GP_DIR = DATA_DIR / "raw_gp5"
CHARTS_DIR = DATA_DIR / "charts"
AUDIO_DIR = DATA_DIR / "audio"
IMPORTED_PREFIX = "gprotab-"
CHART_ID_RE = re.compile(r"^gprotab-[a-z0-9-]+$")
AUDIO_FILE_RE = re.compile(r"^gprotab-[a-z0-9-]+_backing\.(mp3|wav)$")

STANDARD_TUNING = [64, 59, 55, 50, 45, 40]
DROP_D_TUNING = [64, 59, 55, 50, 45, 38]
NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

app = FastAPI(title="Real Guitar Highway API")


class ImportRequest(BaseModel):
    artistSlug: str
    songSlug: str
    # Display names from the search result, used when the GP file has no metadata
    title: str | None = None
    artist: str | None = None


class BackingTrackRequest(BaseModel):
    # YouTube URL or search query; defaults to "<artist> <title> official audio"
    youtube: str | None = None


def describe_tuning(tuning_midi: list[int]) -> str:
    if tuning_midi == STANDARD_TUNING:
        return "Standard"
    if tuning_midi == DROP_D_TUNING:
        return "Drop D"
    # Low string first, the way guitarists read a tuning
    return " ".join(NOTE_NAMES[m % 12] for m in reversed(tuning_midi))


def estimate_difficulty(note_count: int, duration_ms: float) -> int:
    """1–5 from average notes per second."""
    if duration_ms <= 0:
        return 1
    notes_per_sec = note_count / (duration_ms / 1000)
    for level, ceiling in enumerate((1.5, 3.0, 5.0, 7.0), start=1):
        if notes_per_sec < ceiling:
            return level
    return 5


def audio_fields(chart_id: str) -> dict[str, Any]:
    """Backing-track part of a `SongEntry`, plus job status for the menu."""
    status = backing_jobs.read_status(AUDIO_DIR, chart_id)
    ready = status["status"] == "ready"
    return {
        "audioUrl": f"/api/audio/{status['audioFile']}" if ready else "",
        "offsetMs": status.get("offsetMs", 0) if ready else 0,
        "audioStatus": status["status"],
        "audioError": status.get("error"),
        "guitarRemoved": bool(status.get("guitarRemoved", False)),
    }


def load_chart(chart_id: str) -> dict[str, Any]:
    if not CHART_ID_RE.match(chart_id):
        raise HTTPException(status_code=404, detail="Chart not found")
    path = CHARTS_DIR / f"{chart_id}.json"
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as err:
        raise HTTPException(status_code=404, detail="Chart not found") from err


def start_backing_track(chart_id: str, chart: dict[str, Any], youtube: str | None = None) -> None:
    meta = chart.get("metadata") or {}
    source = youtube or backing_jobs.default_youtube_query(
        meta.get("artist", ""), meta.get("title", "")
    )
    first_note_ms = float(chart["notes"][0]["time_ms"]) if chart.get("notes") else 0.0
    backing_jobs.start_job(AUDIO_DIR, chart_id, source, first_note_ms)


def song_entry_from_chart(chart_id: str, chart: dict[str, Any]) -> dict[str, Any]:
    """Builds the frontend `SongEntry` shape (see frontend/src/menu/song_library.ts)."""
    meta = chart.get("metadata") or chart.get("song_metadata") or {}
    duration_ms = float(meta.get("total_duration_ms", 0))
    return {
        "id": chart_id,
        "title": meta.get("title", "Untitled"),
        "artist": meta.get("artist", "Unknown Artist"),
        "chartUrl": f"/api/charts/{chart_id}.json",
        **audio_fields(chart_id),
        "durationMs": duration_ms,
        "bpm": float(meta.get("initial_bpm", 120)),
        "tuning": describe_tuning(list(meta.get("tuning_midi", STANDARD_TUNING))),
        "difficulty": estimate_difficulty(len(chart.get("notes", [])), duration_ms),
        "sections": [],
        "source": "gprotab",
    }


@app.get("/api/search")
def search(q: str = Query(..., min_length=2, max_length=200)) -> dict[str, Any]:
    try:
        results = search_tabs(q)
    except requests.RequestException as err:
        raise HTTPException(status_code=502, detail=f"GProTab search failed: {err}") from err
    return {"query": q, "results": [r.to_dict() for r in results]}


@app.post("/api/import")
def import_tab(req: ImportRequest) -> dict[str, Any]:
    if not SLUG_RE.match(req.artistSlug) or not SLUG_RE.match(req.songSlug):
        raise HTTPException(status_code=422, detail="Invalid artist or song slug")

    try:
        gp_path = download_tab(req.artistSlug, req.songSlug, RAW_GP_DIR)
    except requests.RequestException as err:
        raise HTTPException(status_code=502, detail=f"GProTab download failed: {err}") from err
    except ValueError as err:
        raise HTTPException(status_code=422, detail=str(err)) from err

    try:
        chart = parse_gp_file(gp_path)
    except Exception as err:  # pyguitarpro raises a mix of struct/value/GPException errors
        raise HTTPException(status_code=422, detail=f"Couldn't parse this tab: {err}") from err

    if not chart["notes"]:
        raise HTTPException(status_code=422, detail="This tab has no playable guitar notes")

    # parse_gp_file falls back to the file stem / "Unknown Artist" when the GP file lacks metadata
    meta = chart["metadata"]
    if req.title and (not meta.get("title") or meta["title"] == gp_path.stem):
        meta["title"] = req.title
    if req.artist and meta.get("artist") in (None, "", "Unknown Artist"):
        meta["artist"] = req.artist
    chart["song_metadata"] = meta

    chart_id = gp_path.stem
    CHARTS_DIR.mkdir(parents=True, exist_ok=True)
    (CHARTS_DIR / f"{chart_id}.json").write_text(json.dumps(chart), encoding="utf-8")

    # Re-importing keeps an existing backing track; otherwise fetch one in the background
    if backing_jobs.read_status(AUDIO_DIR, chart_id)["status"] in ("none", "failed"):
        start_backing_track(chart_id, chart)
    return song_entry_from_chart(chart_id, chart)


@app.get("/api/songs")
def list_imported_songs() -> dict[str, Any]:
    songs = []
    for path in sorted(CHARTS_DIR.glob(f"{IMPORTED_PREFIX}*.json")):
        try:
            chart = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        songs.append(song_entry_from_chart(path.stem, chart))
    return {"songs": songs}


@app.delete("/api/songs/{chart_id}")
def delete_imported_song(chart_id: str) -> dict[str, Any]:
    """Removes an imported song: its chart, downloaded tab file and backing track."""
    if not CHART_ID_RE.match(chart_id) or not (CHARTS_DIR / f"{chart_id}.json").is_file():
        raise HTTPException(status_code=404, detail="Song not found")

    (CHARTS_DIR / f"{chart_id}.json").unlink(missing_ok=True)
    for raw in RAW_GP_DIR.glob(f"{chart_id}.gp*"):
        raw.unlink(missing_ok=True)
    backing_jobs.delete_audio(AUDIO_DIR, chart_id)
    return {"deleted": chart_id}


@app.get("/api/charts/{chart_id}.json")
def get_chart(chart_id: str) -> FileResponse:
    if not CHART_ID_RE.match(chart_id):
        raise HTTPException(status_code=404, detail="Chart not found")
    path = CHARTS_DIR / f"{chart_id}.json"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Chart not found")
    return FileResponse(path, media_type="application/json")


@app.get("/api/songs/{chart_id}/audio")
def get_backing_track_status(chart_id: str) -> dict[str, Any]:
    load_chart(chart_id)
    return audio_fields(chart_id)


@app.post("/api/songs/{chart_id}/audio")
def rebuild_backing_track(chart_id: str, req: BackingTrackRequest | None = None) -> dict[str, Any]:
    """Retries the backing track, optionally from a specific YouTube video or query."""
    chart = load_chart(chart_id)
    youtube = None
    if req and req.youtube:
        try:
            youtube = backing_jobs.validate_youtube_source(req.youtube)
        except ValueError as err:
            raise HTTPException(status_code=422, detail=str(err)) from err
    start_backing_track(chart_id, chart, youtube)
    return audio_fields(chart_id)


@app.get("/api/audio/{filename}")
def get_audio(filename: str) -> FileResponse:
    path = AUDIO_DIR / filename
    if not AUDIO_FILE_RE.match(filename) or not path.is_file():
        raise HTTPException(status_code=404, detail="Audio not found")
    return FileResponse(path, media_type="audio/mpeg" if path.suffix == ".mp3" else "audio/wav")
