"""Unit tests for backend.pipeline.backing_jobs (no network, no Demucs)."""

from __future__ import annotations

from pathlib import Path

import pytest

from backend.pipeline import backing_jobs


@pytest.fixture
def fake_pipeline(monkeypatch):
    calls: dict[str, object] = {}

    def fake_prepare(source, chart_id, *, skip_demucs, audio_dir):
        calls["prepare"] = (source, chart_id, skip_demucs)
        audio_dir = Path(audio_dir)
        (audio_dir / f"{chart_id}.mp3").write_bytes(b"raw")
        out = audio_dir / f"{chart_id}_backing.mp3"
        out.write_bytes(b"backing")
        return out

    monkeypatch.setattr(backing_jobs, "prepare_backing_track", fake_prepare)
    monkeypatch.setattr(backing_jobs, "detect_audio_first_hit", lambda path, window: 1.25)
    monkeypatch.setattr(backing_jobs, "demucs_available", lambda: False)
    return calls


def test_run_job_writes_ready_status_with_offset(tmp_path, fake_pipeline):
    backing_jobs.run_job(tmp_path, "gprotab-a--b", "A B official audio", first_note_ms=500.0)

    status = backing_jobs.read_status(tmp_path, "gprotab-a--b")
    assert status["status"] == "ready"
    assert status["audioFile"] == "gprotab-a--b_backing.mp3"
    assert status["offsetMs"] == 750  # first hit 1250ms - first note 500ms
    assert status["guitarRemoved"] is False
    assert fake_pipeline["prepare"] == ("A B official audio", "gprotab-a--b", True)
    assert not (tmp_path / "gprotab-a--b.mp3").exists()  # raw download cleaned up


def test_run_job_records_failure(tmp_path, monkeypatch):
    def boom(*args, **kwargs):
        raise RuntimeError("Video unavailable")

    monkeypatch.setattr(backing_jobs, "prepare_backing_track", boom)
    backing_jobs.run_job(tmp_path, "gprotab-a--b", "q", first_note_ms=0.0)
    status = backing_jobs.read_status(tmp_path, "gprotab-a--b")
    assert status == {"status": "failed", "source": "q", "error": "Video unavailable"}


def test_read_status_reports_interrupted_pending_job(tmp_path):
    assert backing_jobs.read_status(tmp_path, "gprotab-a--b") == {"status": "none"}
    backing_jobs._write_status(tmp_path, "gprotab-a--b", {"status": "pending", "source": "q"})
    status = backing_jobs.read_status(tmp_path, "gprotab-a--b")
    assert status["status"] == "failed"
    assert "Interrupted" in status["error"]


def test_validate_youtube_source():
    assert backing_jobs.validate_youtube_source("  seven nation army ") == "seven nation army"
    assert backing_jobs.validate_youtube_source("https://www.youtube.com/watch?v=x")
    with pytest.raises(ValueError):
        backing_jobs.validate_youtube_source("https://example.com/video")
    with pytest.raises(ValueError):
        backing_jobs.validate_youtube_source("")
