"""Unit tests for backend.pipeline.audio_extractor."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import numpy as np
from scipy.io import wavfile

from backend.pipeline.audio_extractor import (
    build_arg_parser,
    combine_backing_stems,
    prepare_backing_track,
)


def test_cli_arg_parser_flags() -> None:
    parser = build_arg_parser()
    args = parser.parse_args(
        [
            "https://www.youtube.com/watch?v=0J2QdDbelmY",
            "-o",
            "white-stripes-seven_nation_army",
            "--skip-demucs",
        ]
    )
    assert args.youtube_url == "https://www.youtube.com/watch?v=0J2QdDbelmY"
    assert args.output_name == "white-stripes-seven_nation_army"
    assert args.skip_demucs is True


def test_combine_backing_stems_mixes_drums_bass_vocals_and_excludes_other(
    tmp_path: Path,
) -> None:
    stem_dir = tmp_path / "htdemucs" / "track"
    stem_dir.mkdir(parents=True)

    sr = 22050
    samples = 2205
    drums = np.full((samples, 2), 2000, dtype=np.int16)
    bass = np.full((samples, 2), 3000, dtype=np.int16)
    vocals = np.full((samples, 2), 4000, dtype=np.int16)
    # 'other' (guitar) has a massive signal that MUST NOT appear in the backing mix
    other = np.full((samples, 2), 20000, dtype=np.int16)

    wavfile.write(str(stem_dir / "drums.wav"), sr, drums)
    wavfile.write(str(stem_dir / "bass.wav"), sr, bass)
    wavfile.write(str(stem_dir / "vocals.wav"), sr, vocals)
    wavfile.write(str(stem_dir / "other.wav"), sr, other)

    out_backing = tmp_path / "track_backing.mp3"
    with patch("backend.pipeline.audio_extractor._find_ffmpeg", return_value=None):
        result_path = combine_backing_stems(stem_dir, out_backing)

    assert result_path == out_backing
    assert result_path.exists()

    read_sr, mixed = wavfile.read(str(result_path))
    assert read_sr == sr
    # Expected sum: 2000 + 3000 + 4000 = 9000 (excluding 'other' = 20000)
    assert np.allclose(mixed, 9000, atol=2)


def test_prepare_backing_track_skip_demucs(tmp_path: Path) -> None:
    raw_mp3 = tmp_path / "raw_input.mp3"
    raw_mp3.write_bytes(b"FAKE_MP3_PAYLOAD")

    out_path = prepare_backing_track(
        youtube_url=str(raw_mp3),
        output_name="white-stripes-seven_nation_army",
        skip_demucs=True,
        audio_dir=tmp_path,
    )

    assert out_path == tmp_path / "white-stripes-seven_nation_army_backing.mp3"
    assert out_path.exists()
    assert out_path.read_bytes() == b"FAKE_MP3_PAYLOAD"
