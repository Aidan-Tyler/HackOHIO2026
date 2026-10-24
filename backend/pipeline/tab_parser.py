"""Guitar Pro (.gp3/.gp4/.gp5) tab parser and highway chart exporter."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import guitarpro


def calculate_beat_duration_ms(duration_obj: Any, current_bpm: float) -> float:
    """Computes duration in milliseconds for a beat.

    Factors in tempo (BPM), base note value (whole, half, quarter, 8th, etc.),
    dotted/double-dotted modifiers, and tuplets.
    """
    if current_bpm <= 0:
        raise ValueError(f"BPM must be positive, got {current_bpm}")

    # Quarter note duration in milliseconds: (60,000 / BPM)
    ms_per_quarter = 60000.0 / current_bpm

    # duration_obj.value: 1=whole, 2=half, 4=quarter, 8=8th, 16=16th, etc.
    base_ms = (4.0 / duration_obj.value) * ms_per_quarter

    # Handle dotted notes (1.5x) and double-dotted notes (1.75x) via getattr for GP3/GP4/GP5 compatibility
    if getattr(duration_obj, "isDotted", False):
        base_ms *= 1.5
    elif getattr(duration_obj, "isDoubleDotted", False):
        base_ms *= 1.75

    # Handle tuplets (e.g., triplets: 3 notes in the time of 2 -> scale by 2/3)
    tuplet = getattr(duration_obj, "tuplet", None)
    if tuplet and getattr(tuplet, "enters", 0) > 0 and getattr(tuplet, "times", 0) > 0:
        base_ms = base_ms * tuplet.times / tuplet.enters

    return base_ms


def _find_next_note_on_string(
    beats: list[Any], current_beat_idx: int, string_num: int
) -> Any | None:
    """Finds the note on the same string in the immediately following beat, if any."""
    next_idx = current_beat_idx + 1
    if next_idx >= len(beats):
        return None
    next_beat = beats[next_idx]
    for candidate in getattr(next_beat, "notes", []):
        if candidate.string == string_num:
            return candidate
    return None


def extract_technique_flags(
    note: Any, beats: list[Any] | None = None, beat_idx: int = 0
) -> dict[str, bool]:
    """Extracts technique boolean flags (hammer_on, pull_off, slide, bend) for a note.

    In Guitar Pro, `note.effect.hammer` marks the origin of a hammer-on or pull-off.
    We disambiguate hammer_on vs pull_off by comparing against the next fret on the
    same string (if available); defaults to hammer_on when no lower destination fret is found.
    """
    effect = getattr(note, "effect", None)
    has_hammer = bool(effect and getattr(effect, "hammer", False))

    hammer_on = False
    pull_off = False
    if has_hammer:
        next_note = (
            _find_next_note_on_string(beats, beat_idx, note.string)
            if beats is not None
            else None
        )
        if next_note is not None and next_note.value < note.value:
            pull_off = True
        else:
            hammer_on = True

    slides = getattr(effect, "slides", None) if effect else None
    slide = bool(slides and len(slides) > 0)

    bend_effect = getattr(effect, "bend", None) if effect else None
    bend = bool(bend_effect and getattr(bend_effect, "points", True))

    return {
        "hammer_on": hammer_on,
        "pull_off": pull_off,
        "slide": slide,
        "bend": bend,
    }


def _resolve_technique_label(flags: dict[str, bool], effect: Any = None) -> str:
    """Returns a primary technique label string for backward compatibility."""
    if flags["hammer_on"]:
        return "hammer_on"
    if flags["pull_off"]:
        return "pull_off"
    if flags["bend"]:
        return "bend"
    if flags["slide"]:
        return "slide"
    if effect and getattr(effect, "palmMute", False):
        return "palm_mute"
    if effect and getattr(effect, "harmonic", None):
        return "harmonic"
    return "normal"


def _find_companion_octave_guitar_track(
    song: Any, primary_track: Any
) -> Any | None:
    """Finds a companion 'Guitar w/ Octave' track used for empty verse measures."""
    for track in song.tracks:
        if track is primary_track or track.isPercussionTrack:
            continue
        name_lower = (track.name or "").lower()
        if "guitar" in name_lower and "octave" in name_lower:
            return track
    return None


def _map_companion_note_to_guitar(
    note: Any, companion_tuning: list[int], primary_tuning: list[int]
) -> tuple[int, int, int]:
    """Maps a companion octave-guitar note onto the 6-string guitar neck.

    Prefers the 5th string (A-string, string=5, lane=4) when the octave-shifted
    pitch falls within frets 0..24.
    """
    comp_string_idx = max(0, min(len(companion_tuning) - 1, int(note.string) - 1))
    raw_midi = companion_tuning[comp_string_idx] + int(note.value)
    # Octave-pedal guitar tracks are notated 12 semitones below standard guitar pitch
    guitar_midi = raw_midi + 12 if min(companion_tuning) < 40 else raw_midi

    # Target string 5 (A-string, index 4) first if valid
    if len(primary_tuning) >= 5:
        a_string_base = primary_tuning[4]
        a_fret = guitar_midi - a_string_base
        if 0 <= a_fret <= 24:
            return 5, a_fret, guitar_midi

    # Fallback: find any string 1..6 where fret is in 0..24
    for s_idx, base_pitch in enumerate(primary_tuning[:6]):
        fret = guitar_midi - base_pitch
        if 0 <= fret <= 24:
            return s_idx + 1, fret, guitar_midi

    return 5, max(0, min(24, int(note.value))), guitar_midi


def parse_gp_file(
    gp_file_path: str | Path,
    output_json_path: str | Path | None = None,
    track_idx: int | None = None,
) -> dict[str, Any]:
    """Parses a Guitar Pro file (.gp3, .gp4, .gp5) into the highway JSON chart schema.

    Args:
        gp_file_path: Path to the input Guitar Pro file.
        output_json_path: Optional path to write the output JSON file.
        track_idx: Optional 0-based track index. If omitted, selects the first
            non-percussion 6-string guitar track (and merges any companion octave-guitar
            track during empty measures).

    Returns:
        Dictionary containing song_metadata, tempo_changes, measures, and notes.
    """
    gp_path = Path(gp_file_path)
    song = guitarpro.parse(str(gp_path))

    # 1. Select Track
    companion_track = None
    if track_idx is not None:
        selected_track = song.tracks[track_idx]
        resolved_track_idx = track_idx
    else:
        resolved_track_idx = 0
        selected_track = song.tracks[0]
        for idx, track in enumerate(song.tracks):
            if not track.isPercussionTrack and len(track.strings) == 6:
                selected_track = track
                resolved_track_idx = idx
                break
        else:
            for idx, track in enumerate(song.tracks):
                if not track.isPercussionTrack:
                    selected_track = track
                    resolved_track_idx = idx
                    break
        companion_track = _find_companion_octave_guitar_track(song, selected_track)

    tuning = [s.value for s in selected_track.strings]
    companion_tuning = (
        [s.value for s in companion_track.strings] if companion_track else []
    )
    current_time_ms = 0.0
    current_bpm = float(song.tempo) if getattr(song, "tempo", None) else 120.0

    tempo_changes: list[dict[str, Any]] = [
        {
            "measure": 1,
            "beat": 1,
            "time_ms": 0.0,
            "timeMs": 0.0,
            "bpm": current_bpm,
        }
    ]
    measures_meta: list[dict[str, Any]] = []
    highway_notes: list[dict[str, Any]] = []

    # 2. Iterate through measures and primary voice beats
    for measure_idx, measure in enumerate(selected_track.measures):
        measure_num = measure_idx + 1
        measure_start_ms = current_time_ms

        # Check measure-level tempo change (either on measure or measure.header)
        header = getattr(measure, "header", None)
        measure_tempo_obj = getattr(measure, "tempo", None) or (
            getattr(header, "tempo", None) if header else None
        )
        if measure_tempo_obj and getattr(measure_tempo_obj, "value", 0) > 0:
            new_bpm = float(measure_tempo_obj.value)
            if new_bpm != current_bpm:
                current_bpm = new_bpm
                tempo_changes.append(
                    {
                        "measure": measure_num,
                        "beat": 1,
                        "time_ms": round(current_time_ms, 2),
                        "timeMs": round(current_time_ms, 2),
                        "bpm": current_bpm,
                    }
                )

        measure_bpm = current_bpm
        time_sig = getattr(measure, "timeSignature", None)
        numerator = getattr(time_sig, "numerator", 4) if time_sig else 4
        denominator = (
            getattr(getattr(time_sig, "denominator", None), "value", 4)
            if time_sig
            else 4
        )

        # Primary melodic voice (Voice 0)
        primary_voice = measure.voices[0] if measure.voices else None
        beats = list(primary_voice.beats) if primary_voice else []
        primary_has_notes = any(bool(b.notes) for b in beats)

        using_companion = False
        if (
            not primary_has_notes
            and companion_track is not None
            and measure_idx < len(companion_track.measures)
        ):
            comp_measure = companion_track.measures[measure_idx]
            comp_voice = comp_measure.voices[0] if comp_measure.voices else None
            comp_beats = list(comp_voice.beats) if comp_voice else []
            if any(bool(b.notes) for b in comp_beats):
                beats = comp_beats
                using_companion = True

        for beat_idx, beat in enumerate(beats):
            # Check beat-level mixTableChange tempo adjustment
            beat_effect = getattr(beat, "effect", None)
            mix_change = getattr(beat_effect, "mixTableChange", None) if beat_effect else None
            if mix_change and getattr(mix_change, "tempo", None):
                new_bpm = float(mix_change.tempo.value)
                if new_bpm > 0 and new_bpm != current_bpm:
                    current_bpm = new_bpm
                    tempo_changes.append(
                        {
                            "measure": measure_num,
                            "beat": beat_idx + 1,
                            "time_ms": round(current_time_ms, 2),
                            "timeMs": round(current_time_ms, 2),
                            "bpm": current_bpm,
                        }
                    )

            beat_duration_ms = calculate_beat_duration_ms(beat.duration, current_bpm)

            # Skip rest beats or empty beats while advancing the clock
            if beat.status == guitarpro.BeatStatus.rest or not beat.notes:
                current_time_ms += beat_duration_ms
                continue

            for note in beat.notes:
                if using_companion:
                    string_num, fret_num, midi_pitch = _map_companion_note_to_guitar(
                        note, companion_tuning, tuning
                    )
                else:
                    string_num = int(note.string)
                    fret_num = int(note.value)
                    if not (1 <= string_num <= 6):
                        continue
                    fret_num = max(0, min(24, fret_num))
                    string_pitch_base = (
                        tuning[string_num - 1] if string_num <= len(tuning) else 40
                    )
                    midi_pitch = string_pitch_base + fret_num

                # Handle tied notes: extend previous note on the same string if present
                if getattr(note, "type", None) == guitarpro.NoteType.tie:
                    for prev_note in reversed(highway_notes):
                        if prev_note["string"] == string_num:
                            new_dur = round(
                                prev_note["duration_ms"] + beat_duration_ms, 2
                            )
                            prev_note["duration_ms"] = new_dur
                            prev_note["durationMs"] = new_dur
                            break
                    continue

                # 0-based lane index: string 1 (High E) -> 0 .. string 5 (A) -> 4 .. string 6 (Low E) -> 5
                lane = string_num - 1
                flags = extract_technique_flags(note, beats=beats, beat_idx=beat_idx)
                technique_label = _resolve_technique_label(
                    flags, getattr(note, "effect", None)
                )
                velocity = getattr(note, "velocity", 95)
                rounded_time = round(current_time_ms, 2)
                rounded_dur = round(beat_duration_ms, 2)

                highway_notes.append(
                    {
                        "time_ms": rounded_time,
                        "timeMs": rounded_time,
                        "duration_ms": rounded_dur,
                        "durationMs": rounded_dur,
                        "string": string_num,
                        "fret": fret_num,
                        "lane": lane,
                        "midi_pitch": midi_pitch,
                        "measure": measure_num,
                        "beat": beat_idx + 1,
                        "velocity": round(velocity / 127.0, 2),
                        "hammer_on": flags["hammer_on"],
                        "pull_off": flags["pull_off"],
                        "slide": flags["slide"],
                        "bend": flags["bend"],
                        "techniques": flags,
                        "technique": technique_label,
                    }
                )

            current_time_ms += beat_duration_ms

        # If a measure has zero beats in voice 0, advance by time signature duration
        if not beats:
            measure_quarters = numerator * (4.0 / denominator)
            current_time_ms += measure_quarters * (60000.0 / current_bpm)

        measure_duration_ms = current_time_ms - measure_start_ms
        rounded_start = round(measure_start_ms, 2)
        rounded_end = round(current_time_ms, 2)
        rounded_mdur = round(measure_duration_ms, 2)
        measures_meta.append(
            {
                "number": measure_num,
                "start_ms": rounded_start,
                "startMs": rounded_start,
                "end_ms": rounded_end,
                "endMs": rounded_end,
                "duration_ms": rounded_mdur,
                "durationMs": rounded_mdur,
                "bpm": measure_bpm,
                "time_signature": f"{numerator}/{denominator}",
                "timeSignature": f"{numerator}/{denominator}",
            }
        )

    metadata_obj: dict[str, Any] = {
        "title": song.title or gp_path.stem,
        "artist": song.artist or "Unknown Artist",
        "initial_bpm": float(song.tempo) if getattr(song, "tempo", None) else 120.0,
        "initialBpm": float(song.tempo) if getattr(song, "tempo", None) else 120.0,
        "track_index": resolved_track_idx,
        "track_name": selected_track.name,
        "string_count": len(selected_track.strings),
        "tuning_midi": tuning,
        "total_measures": len(measures_meta),
        "total_duration_ms": round(current_time_ms, 2),
        "totalDurationMs": round(current_time_ms, 2),
    }

    payload: dict[str, Any] = {
        "song_metadata": metadata_obj,
        "metadata": metadata_obj,
        "tempo_changes": tempo_changes,
        "tempoMap": tempo_changes,
        "measures": measures_meta,
        "notes": highway_notes,
    }

    if output_json_path is not None:
        out_path = Path(output_json_path)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)
        print(f"Exported {len(highway_notes)} notes across {len(measures_meta)} measures to {out_path}")

    return payload


# Alias for compatibility with existing scripts
export_gp5_to_highway_json = parse_gp_file


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Parse a Guitar Pro (.gp3/.gp4/.gp5) file into a highway JSON chart."
    )
    parser.add_argument(
        "input_file",
        nargs="?",
        default="backend/data/raw_gp5/white-stripes-seven_nation_army.gp3",
        help="Path to the input Guitar Pro file",
    )
    parser.add_argument(
        "-o",
        "--output",
        default=None,
        help="Path to output JSON file (defaults to backend/data/charts/<stem>.json)",
    )
    parser.add_argument(
        "-t",
        "--track",
        type=int,
        default=None,
        help="Optional 0-based track index to parse",
    )
    args = parser.parse_args()

    input_path = Path(args.input_file)
    if args.output:
        output_path = Path(args.output)
    else:
        output_path = Path("backend/data/charts") / f"{input_path.stem}.json"

    parse_gp_file(input_path, output_path, track_idx=args.track)


if __name__ == "__main__":
    main()
