"""Background backing-track jobs for imported songs.

For each imported chart, finds the song on YouTube, builds a backing track with
`audio_extractor.prepare_backing_track` (guitar removed via Demucs when installed,
otherwise the full mix), and auto-syncs it to the tab with
`detect_audio_first_hit`. Job state lives in `<audio_dir>/<chart_id>.status.json`
so it survives backend restarts.
"""

from __future__ import annotations

import importlib.util
import json
import shutil
import threading
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from backend.pipeline.audio_extractor import prepare_backing_track
from backend.pipeline.detect_audio_first_hit import detect_audio_first_hit

# Onset search window. Long enough to cover a quiet intro, short enough to stay fast
FIRST_HIT_WINDOW_S = 30.0
YOUTUBE_HOSTS = ("youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be")

_running: set[str] = set()
_lock = threading.Lock()


def demucs_available() -> bool:
    return shutil.which("demucs") is not None or importlib.util.find_spec("demucs") is not None


def default_youtube_query(artist: str, title: str) -> str:
    return f"{artist} {title} official audio"


def validate_youtube_source(source: str) -> str:
    """Accepts a search query or a YouTube URL; rejects URLs on other hosts."""
    source = source.strip()
    if not source or len(source) > 300:
        raise ValueError("YouTube source must be 1–300 characters")
    if source.startswith(("http://", "https://")):
        host = (urlparse(source).hostname or "").lower()
        if host not in YOUTUBE_HOSTS:
            raise ValueError("Only youtube.com / youtu.be links are supported")
    return source


def _status_path(audio_dir: Path, chart_id: str) -> Path:
    return audio_dir / f"{chart_id}.status.json"


def _write_status(audio_dir: Path, chart_id: str, status: dict[str, Any]) -> None:
    audio_dir.mkdir(parents=True, exist_ok=True)
    _status_path(audio_dir, chart_id).write_text(json.dumps(status), encoding="utf-8")


def read_status(audio_dir: Path, chart_id: str) -> dict[str, Any]:
    """Returns {"status": "none"|"pending"|"ready"|"failed", ...}."""
    path = _status_path(audio_dir, chart_id)
    try:
        status = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"status": "none"}

    # A "pending" job that isn't running in this process was cut off by a restart
    if status.get("status") == "pending" and chart_id not in _running:
        return {**status, "status": "failed", "error": "Interrupted (backend restarted). Retry to rebuild."}
    if status.get("status") == "ready" and not (audio_dir / status.get("audioFile", "")).is_file():
        return {"status": "none"}
    return status


def is_running(chart_id: str) -> bool:
    with _lock:
        return chart_id in _running


def delete_audio(audio_dir: Path, chart_id: str) -> None:
    """Removes a song's backing track and job status (callers check `is_running` first)."""
    _status_path(audio_dir, chart_id).unlink(missing_ok=True)
    for path in audio_dir.glob(f"{chart_id}_backing.*"):
        path.unlink(missing_ok=True)


def start_job(audio_dir: Path, chart_id: str, youtube_source: str, first_note_ms: float) -> bool:
    """Marks the job pending and runs it on a worker thread. Returns False if already running."""
    with _lock:
        if chart_id in _running:
            return False
        _running.add(chart_id)

    _write_status(audio_dir, chart_id, {"status": "pending", "source": youtube_source})
    threading.Thread(
        target=run_job,
        args=(audio_dir, chart_id, youtube_source, first_note_ms),
        name=f"backing-{chart_id}",
        daemon=True,
    ).start()
    return True


def run_job(audio_dir: Path, chart_id: str, youtube_source: str, first_note_ms: float) -> None:
    try:
        guitar_removed = demucs_available()
        backing_path = prepare_backing_track(
            youtube_source,
            chart_id,
            skip_demucs=not guitar_removed,
            audio_dir=audio_dir,
        )
        # prepare_backing_track leaves the raw download next to the backing copy
        for raw in audio_dir.glob(f"{chart_id}.*"):
            if raw.suffix in (".mp3", ".wav", ".webm", ".m4a", ".opus"):
                raw.unlink(missing_ok=True)

        # Chart time 0 is the start of the tab; the recording's first hit should line up
        # with the tab's first note. audio_time_ms = chart_time_ms + offset_ms
        try:
            first_hit_ms = detect_audio_first_hit(str(backing_path), FIRST_HIT_WINDOW_S) * 1000
            offset_ms = round(first_hit_ms - first_note_ms)
        except Exception:  # Onset detection is best-effort; the player can nudge sync in-game
            offset_ms = 0

        _write_status(
            audio_dir,
            chart_id,
            {
                "status": "ready",
                "source": youtube_source,
                "audioFile": backing_path.name,
                "offsetMs": offset_ms,
                "guitarRemoved": guitar_removed,
            },
        )
    except Exception as err:
        _write_status(
            audio_dir,
            chart_id,
            {"status": "failed", "source": youtube_source, "error": str(err) or type(err).__name__},
        )
    finally:
        with _lock:
            _running.discard(chart_id)
