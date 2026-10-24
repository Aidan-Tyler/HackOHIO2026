"""Unit tests for backend.pipeline.tab_parser."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from backend.pipeline.tab_parser import (
    calculate_beat_duration_ms,
    extract_technique_flags,
    parse_gp_file,
)

RAW_GP3_PATH = Path("backend/data/raw_gp5/white-stripes-seven_nation_army.gp3")
OUTPUT_CHART_PATH = Path("backend/data/charts/white-stripes-seven_nation_army.json")


def _make_duration(
    value: int = 4,
    is_dotted: bool = False,
    is_double_dotted: bool = False,
    enters: int = 1,
    times: int = 1,
) -> SimpleNamespace:
    return SimpleNamespace(
        value=value,
        isDotted=is_dotted,
        isDoubleDotted=is_double_dotted,
        tuplet=SimpleNamespace(enters=enters, times=times),
    )


def test_calculate_beat_duration_ms_standard_and_modifiers() -> None:
    # At 120 BPM: quarter note = 500ms
    quarter = _make_duration(value=4)
    assert calculate_beat_duration_ms(quarter, 120.0) == pytest.approx(500.0)

    # Dotted quarter at 120 BPM = 750ms
    dotted_quarter = _make_duration(value=4, is_dotted=True)
    assert calculate_beat_duration_ms(dotted_quarter, 120.0) == pytest.approx(750.0)

    # Double-dotted quarter at 120 BPM = 875ms
    double_dotted = _make_duration(value=4, is_double_dotted=True)
    assert calculate_beat_duration_ms(double_dotted, 120.0) == pytest.approx(875.0)

    # Eighth note triplet (3 in the time of 2): 250ms * 2/3 = 166.6667ms
    triplet_eighth = _make_duration(value=8, enters=3, times=2)
    assert calculate_beat_duration_ms(triplet_eighth, 120.0) == pytest.approx(
        500.0 / 3.0
    )

    with pytest.raises(ValueError):
        calculate_beat_duration_ms(quarter, 0.0)


def test_extract_technique_flags_hammer_pull_slide_bend() -> None:
    # Hammer-on: fret 5 -> fret 7 on string 3
    note_start = SimpleNamespace(
        string=3,
        value=5,
        effect=SimpleNamespace(hammer=True, slides=[], bend=None),
    )
    note_higher = SimpleNamespace(
        string=3,
        value=7,
        effect=SimpleNamespace(hammer=False, slides=[], bend=None),
    )
    note_lower = SimpleNamespace(
        string=3,
        value=3,
        effect=SimpleNamespace(hammer=False, slides=[], bend=None),
    )
    beats_ho = [SimpleNamespace(notes=[note_start]), SimpleNamespace(notes=[note_higher])]
    flags_ho = extract_technique_flags(note_start, beats=beats_ho, beat_idx=0)
    assert flags_ho == {
        "hammer_on": True,
        "pull_off": False,
        "slide": False,
        "bend": False,
    }

    # Pull-off: fret 5 -> fret 3 on string 3
    beats_po = [SimpleNamespace(notes=[note_start]), SimpleNamespace(notes=[note_lower])]
    flags_po = extract_technique_flags(note_start, beats=beats_po, beat_idx=0)
    assert flags_po == {
        "hammer_on": False,
        "pull_off": True,
        "slide": False,
        "bend": False,
    }

    # Slide and Bend
    note_slide_bend = SimpleNamespace(
        string=2,
        value=12,
        effect=SimpleNamespace(
            hammer=False,
            slides=["shiftSlideTo"],
            bend=SimpleNamespace(points=[1, 2]),
        ),
    )
    flags_sb = extract_technique_flags(note_slide_bend)
    assert flags_sb == {
        "hammer_on": False,
        "pull_off": False,
        "slide": True,
        "bend": True,
    }


def test_parse_seven_nation_army_gp3(tmp_path: Path) -> None:
    assert RAW_GP3_PATH.exists(), f"Missing input GP3 file at {RAW_GP3_PATH}"

    temp_out = tmp_path / "seven_nation_army.json"
    chart = parse_gp_file(RAW_GP3_PATH, output_json_path=temp_out)

    # Verify file was written and matches returned payload
    assert temp_out.exists()
    saved_chart = json.loads(temp_out.read_text(encoding="utf-8"))
    assert saved_chart == chart

    # 1. Verify song_metadata
    meta = chart["song_metadata"]
    assert meta["title"] == "Seven Nation Army"
    assert meta["artist"] == "The White Stripes"
    assert meta["initial_bpm"] == 120.0
    assert meta["string_count"] == 6
    assert meta["total_measures"] == 115
    assert meta["total_duration_ms"] > 0

    # 2. Verify tempo_changes
    tempo_changes = chart["tempo_changes"]
    assert len(tempo_changes) >= 1
    assert tempo_changes[0]["bpm"] == 120.0
    assert tempo_changes[0]["time_ms"] == 0.0
    assert tempo_changes[0]["measure"] == 1

    # 3. Verify measures
    measures = chart["measures"]
    assert len(measures) == 115
    assert measures[0]["number"] == 1
    assert measures[0]["start_ms"] == 0.0
    assert measures[0]["duration_ms"] == 2000.0
    assert measures[0]["time_signature"] == "4/4"

    # Monotonic measure boundaries
    for idx in range(1, len(measures)):
        assert measures[idx]["start_ms"] == pytest.approx(measures[idx - 1]["end_ms"])

    # 4. Verify notes schema and guardrails
    notes = chart["notes"]
    assert len(notes) > 0

    prev_time_ms = 0.0
    has_slide = False
    for note in notes:
        assert "time_ms" in note
        assert isinstance(note["time_ms"], (int, float))
        assert note["time_ms"] >= prev_time_ms
        prev_time_ms = note["time_ms"]

        assert 1 <= note["string"] <= 6
        assert 0 <= note["fret"] <= 24
        assert 0 <= note["lane"] <= 5
        assert note["duration_ms"] > 0

        # Guardrail technique flags
        for flag in ("hammer_on", "pull_off", "slide", "bend"):
            assert flag in note
            assert isinstance(note[flag], bool)
            assert flag in note["techniques"]
            assert isinstance(note["techniques"][flag], bool)

        if note["slide"]:
            has_slide = True

    assert has_slide, "Expected at least one slide note in Seven Nation Army guitar track"


def test_parse_solo_track_includes_bends() -> None:
    # Track 1 is Solo Guitar (Jack White) which contains bends and slides
    chart_solo = parse_gp_file(RAW_GP3_PATH, track_idx=1)
    notes = chart_solo["notes"]
    assert len(notes) > 0
    assert any(n["bend"] for n in notes), "Expected bend notes in solo track"
    assert any(n["slide"] for n in notes), "Expected slide notes in solo track"


def test_saved_chart_artifact_exists_and_is_valid() -> None:
    assert OUTPUT_CHART_PATH.exists(), f"Expected chart at {OUTPUT_CHART_PATH}"
    data = json.loads(OUTPUT_CHART_PATH.read_text(encoding="utf-8"))
    assert data["song_metadata"]["title"] == "Seven Nation Army"
    assert len(data["measures"]) == 115
    assert len(data["notes"]) == 896
    # First 7 notes are the iconic A-string riff: 7 - 7 - 10 - 7 - 5 - 3 - 2
    first_seven = data["notes"][:7]
    assert [n["fret"] for n in first_seven] == [7, 7, 10, 7, 5, 3, 2]
    assert all(n["string"] == 5 and n["lane"] == 4 for n in first_seven)

