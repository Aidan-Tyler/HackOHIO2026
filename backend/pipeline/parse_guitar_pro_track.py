import json
from pathlib import Path
import guitarpro

def calculate_beat_duration_ms(duration_obj, current_bpm: float) -> float:
    """
    Computes duration in milliseconds for a beat, factoring in
    tempo, base value (quarter, 8th, etc.), dotted notes, and tuplets.
    """
    # Quarter note duration in milliseconds: (60,000 / BPM)
    ms_per_quarter = 60000.0 / current_bpm
    
    # duration_obj.value: 1=whole, 2=half, 4=quarter, 8=8th, 16=16th, etc.
    base_ms = (4.0 / duration_obj.value) * ms_per_quarter
    
    # Handle dotted notes (1.5x) and double-dotted notes (1.75x)
    if duration_obj.isDotted:
        base_ms *= 1.5
    elif duration_obj.isDoubleDotted:
        base_ms *= 1.75
        
    # Handle tuplets (triplets: 3 notes in time of 2 -> scale by 2/3)
    if duration_obj.tuplet.enters > 0 and duration_obj.tuplet.times > 0:
        base_ms = base_ms * duration_obj.tuplet.times / duration_obj.tuplet.enters
        
    return base_ms


def export_gp5_to_highway_json(gp5_file_path: str, output_json_path: str = None, track_idx: int = None):
    song = guitarpro.parse(gp5_file_path)
    
    # 1. Select Track: pick specified index or auto-select the first non-percussion track
    if track_idx is None:
        selected_track = next((t for t in song.tracks if not t.isPercussionTrack), song.tracks[0])
    else:
        selected_track = song.tracks[track_idx]
        
    # Extract string tuning (default standard 6-string: E4, B3, G3, D3, A2, E2)
    tuning = [s.value for s in selected_track.strings]

    current_time_ms = 0.0
    current_bpm = song.tempo
    highway_notes = []

    # 2. Iterate through measures and voices
    for measure_idx, measure in enumerate(selected_track.measures):
        # Update tempo if a measure-specific tempo change exists
        if measure.tempo and measure.tempo.value > 0:
            current_bpm = measure.tempo.value
            
        # Voice 0 is the primary melodic voice in Guitar Pro
        primary_voice = measure.voices[0]
        
        for beat in primary_voice.beats:
            beat_duration_ms = calculate_beat_duration_ms(beat.duration, current_bpm)
            
            # Skip rests
            if beat.status == guitarpro.BeatStatus.rest:
                current_time_ms += beat_duration_ms
                continue

            # Process individual notes played on this beat
            for note in beat.notes:
                # String indexing in pyguitarpro: 1 = highest string (high E), 6 = lowest string (low E)
                # Lane: 0 (low E) to 5 (high E) for typical highway rendering
                string_num = note.string
                lane = 6 - string_num  # Maps string 6 -> lane 0, string 1 -> lane 5
                
                # Extract technique flags
                effects = note.effect
                technique = "normal"
                if effects.hammer:
                    technique = "hammer_on_pull_off"
                elif effects.bend:
                    technique = "bend"
                elif effects.slides:
                    technique = "slide"
                elif effects.palmMute:
                    technique = "palm_mute"
                elif effects.harmonic:
                    technique = "harmonic"

                # Calculate MIDI pitch: base string pitch + fret number
                # Standard tuning string offsets: [64, 59, 55, 50, 45, 40]
                string_pitch_base = tuning[string_num - 1] if string_num <= len(tuning) else 40
                midi_pitch = string_pitch_base + note.value

                highway_notes.append({
                    "time_ms": round(current_time_ms, 2),
                    "duration_ms": round(beat_duration_ms, 2),
                    "lane": lane,               # 0 (Low E) -> 5 (High E)
                    "string": string_num,       # 1 to 6
                    "fret": note.value,         # 0 (open) to 24
                    "midi_pitch": midi_pitch,   # Explicit pitch for audio pitch-check
                    "technique": technique,
                    "measure": measure_idx + 1,
                    "velocity": round(note.velocity / 127.0, 2)
                })

            current_time_ms += beat_duration_ms

    payload = {
        "song_metadata": {
            "title": song.title or Path(gp5_file_path).stem,
            "artist": song.artist,
            "initial_bpm": song.tempo,
            "track_name": selected_track.name,
            "string_count": len(selected_track.strings),
            "tuning_midi": tuning,
            "total_duration_ms": round(current_time_ms, 2)
        },
        "notes": highway_notes
    }

    if output_json_path:
        with open(output_json_path, "w") as f:
            json.dump(payload, f, indent=2)
        print(f"Exported {len(highway_notes)} notes to {output_json_path}")

    return payload

if __name__ == "__main__":
    # Test file path
    sample_file = "sample.gp5"
    if Path(sample_file).exists():
        export_gp5_to_highway_json(sample_file, "highway_track.json")