"""YouTube audio ingestion and Demucs AI guitar-stem removal pipeline."""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Sequence

import numpy as np
from scipy.io import wavfile
import yt_dlp

DEFAULT_AUDIO_DIR = Path("backend/data/audio")
DEMUCS_MODEL = "htdemucs"
BACKING_STEMS = ("drums", "bass", "vocals")


def _is_url(target: str) -> bool:
    return target.startswith(("http://", "https://", "www.", "youtu.be/"))


def _find_ffmpeg() -> str | None:
    """Locates ffmpeg on PATH, standard macOS/Homebrew directories, or the static
    binary bundled with the `imageio-ffmpeg` pip package."""
    for candidate in ("ffmpeg", "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"):
        resolved = shutil.which(candidate)
        if resolved:
            return resolved
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except (ImportError, RuntimeError):
        return None


def download_youtube_audio(
    query_or_url: str,
    track_id: str,
    audio_dir: str | Path = DEFAULT_AUDIO_DIR,
    preferred_codec: str = "wav",
) -> Path:
    """Downloads audio from a YouTube URL or search query into `backend/data/audio/`.

    Uses `yt-dlp`. If `ffmpeg` is available on the system, extracts audio to the
    requested codec (`wav` or `mp3`); otherwise downloads the best available audio stream.
    """
    dest_dir = Path(audio_dir)
    dest_dir.mkdir(parents=True, exist_ok=True)

    target = query_or_url if _is_url(query_or_url) else f"ytsearch1:{query_or_url}"
    output_stem = dest_dir / track_id
    ffmpeg_bin = _find_ffmpeg()

    ydl_opts: dict[str, object] = {
        "format": "bestaudio/best",
        "outtmpl": f"{output_stem}.%(ext)s",
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(target, download=True)
        if "entries" in info and info["entries"]:
            info = info["entries"][0]
        downloaded_path = Path(ydl.prepare_filename(info))

    if not downloaded_path.exists():
        matches = sorted(
            p for p in dest_dir.glob(f"{track_id}.*") if not p.name.endswith(".part")
        )
        if matches:
            downloaded_path = matches[0]

    expected_path = output_stem.with_suffix(f".{preferred_codec}")
    if downloaded_path.exists() and ffmpeg_bin and downloaded_path.resolve() != expected_path.resolve():
        cmd: list[str] = [ffmpeg_bin, "-y", "-i", str(downloaded_path)]
        if preferred_codec.lower() == "mp3":
            cmd.extend(["-vn", "-codec:a", "libmp3lame", "-qscale:a", "2", str(expected_path)])
        else:
            cmd.extend(["-vn", str(expected_path)])
        subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        downloaded_path.unlink(missing_ok=True)
        return expected_path

    if expected_path.exists():
        return expected_path
    if downloaded_path.exists():
        return downloaded_path

    # Search for any matching file produced with `track_id` prefix
    matches = sorted(dest_dir.glob(f"{track_id}.*"))
    if matches:
        return matches[0]

    raise FileNotFoundError(
        f"Failed to locate downloaded YouTube audio for '{query_or_url}' in {dest_dir}"
    )


def run_demucs_separation(
    input_audio_path: str | Path,
    output_root: str | Path,
    model_name: str = DEMUCS_MODEL,
) -> Path:
    """Runs Demucs 4-stem separation (`drums`, `bass`, `vocals`, `other`).

    Returns the directory containing `{drums,bass,vocals,other}.wav`.
    """
    in_path = Path(input_audio_path)
    out_dir = Path(output_root)
    out_dir.mkdir(parents=True, exist_ok=True)

    demucs_bin = shutil.which("demucs")
    if demucs_bin:
        cmd = [
            demucs_bin,
            "-n",
            model_name,
            "-o",
            str(out_dir),
            str(in_path),
        ]
    else:
        cmd = [
            sys.executable,
            "-m",
            "demucs",
            "-n",
            model_name,
            "-o",
            str(out_dir),
            str(in_path),
        ]

    subprocess.run(cmd, check=True)

    stem_dir = out_dir / model_name / in_path.stem
    if not stem_dir.exists():
        raise FileNotFoundError(
            f"Expected Demucs stem directory not found at {stem_dir}"
        )
    return stem_dir


def combine_backing_stems(
    stem_dir: str | Path,
    output_backing_path: str | Path,
    stems: Sequence[str] = BACKING_STEMS,
) -> Path:
    """Combines `drums.wav`, `bass.wav`, and `vocals.wav` (omitting `other` / guitar)
    into a single backing track at `output_backing_path` (`<track_id>_backing.mp3`).
    """
    stem_folder = Path(stem_dir)
    out_path = Path(output_backing_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    stem_files = [stem_folder / f"{name}.wav" for name in stems]
    missing = [str(p) for p in stem_files if not p.exists()]
    if missing:
        raise FileNotFoundError(
            f"Missing required Demucs stem WAV files: {', '.join(missing)}"
        )

    ffmpeg_bin = _find_ffmpeg()
    if ffmpeg_bin and out_path.suffix.lower() == ".mp3":
        # Mix stems directly to MP3 via ffmpeg amix filter (normalize=0 preserves stem levels)
        cmd: list[str] = [ffmpeg_bin, "-y"]
        for sf in stem_files:
            cmd.extend(["-i", str(sf)])
        cmd.extend(
            [
                "-filter_complex",
                f"amix=inputs={len(stem_files)}:duration=longest:normalize=0",
                "-codec:a",
                "libmp3lame",
                "-qscale:a",
                "2",
                str(out_path),
            ]
        )
        subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        return out_path

    # Pure-Python numpy/scipy WAV mixing fallback
    sample_rate: int | None = None
    mixed_float: np.ndarray | None = None

    for sf in stem_files:
        sr, data = wavfile.read(str(sf))
        if sample_rate is None:
            sample_rate = sr
        elif sr != sample_rate:
            raise ValueError(
                f"Sample rate mismatch across stems: {sr} != {sample_rate}"
            )

        if np.issubdtype(data.dtype, np.integer):
            max_val = float(np.iinfo(data.dtype).max)
            audio_f = data.astype(np.float64) / max_val
        else:
            audio_f = data.astype(np.float64)

        if mixed_float is None:
            mixed_float = audio_f
        else:
            min_len = min(len(mixed_float), len(audio_f))
            mixed_float = mixed_float[:min_len] + audio_f[:min_len]

    assert mixed_float is not None and sample_rate is not None

    # Prevent clipping while keeping stem balance intact
    peak = float(np.max(np.abs(mixed_float)))
    if peak > 1.0:
        mixed_float = mixed_float / peak

    pcm16 = np.clip(mixed_float * 32767.0, -32768, 32767).astype(np.int16)

    # Write mixed audio to target path (if ffmpeg is available and .mp3 requested, transcode; else write directly)
    if ffmpeg_bin and out_path.suffix.lower() == ".mp3":
        temp_wav = out_path.with_suffix(".tmp.wav")
        wavfile.write(str(temp_wav), sample_rate, pcm16)
        try:
            subprocess.run(
                [
                    ffmpeg_bin,
                    "-y",
                    "-i",
                    str(temp_wav),
                    "-codec:a",
                    "libmp3lame",
                    "-qscale:a",
                    "2",
                    str(out_path),
                ],
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )
        finally:
            temp_wav.unlink(missing_ok=True)
    else:
        wavfile.write(str(out_path), sample_rate, pcm16)

    return out_path


def prepare_backing_track(
    youtube_url: str,
    output_name: str,
    *,
    skip_demucs: bool = False,
    audio_dir: str | Path = DEFAULT_AUDIO_DIR,
) -> Path:
    """Downloads a YouTube track (or uses cached raw audio) and generates a guitar-less
    backing track at `backend/data/audio/<output_name>_backing.mp3`.

    Args:
        youtube_url: YouTube video URL, local audio path, or search query string.
        output_name: Track identifier stem (e.g., 'white-stripes-seven_nation_army').
        skip_demucs: If True, skips Demucs stem separation and copies the raw YouTube
            audio directly to `<output_name>_backing.mp3` for quick testing.
        audio_dir: Target audio directory (defaults to `backend/data/audio`).

    Returns:
        Path to `backend/data/audio/<output_name>_backing.mp3`.
    """
    dest_dir = Path(audio_dir)
    dest_dir.mkdir(parents=True, exist_ok=True)

    # Strip any trailing `_backing` or file extension if passed in output_name
    clean_id = Path(output_name).stem
    if clean_id.endswith("_backing"):
        clean_id = clean_id[: -len("_backing")]

    backing_path = dest_dir / f"{clean_id}_backing.mp3"

    # 1. Obtain raw audio (local path if provided & exists, else download via yt-dlp)
    candidate_local = Path(youtube_url)
    if candidate_local.exists() and candidate_local.is_file():
        raw_audio_path = candidate_local
    else:
        preferred_codec = "mp3" if skip_demucs else "wav"
        raw_audio_path = download_youtube_audio(
            youtube_url,
            track_id=clean_id,
            audio_dir=dest_dir,
            preferred_codec=preferred_codec,
        )

    # 2. Fast fallback path when --skip-demucs is set
    if skip_demucs:
        if raw_audio_path.resolve() != backing_path.resolve():
            shutil.copy2(raw_audio_path, backing_path)
        return backing_path

    # 3. Run Demucs 4-stem separation (htdemucs: drums, bass, vocals, other)
    stems_work_dir = dest_dir / "stems"
    stem_dir = run_demucs_separation(
        raw_audio_path,
        output_root=stems_work_dir,
        model_name=DEMUCS_MODEL,
    )

    # 4. Combine drums.wav + bass.wav + vocals.wav (omitting 'other' guitar stem)
    return combine_backing_stems(stem_dir, backing_path, stems=BACKING_STEMS)


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m backend.pipeline.audio_extractor",
        description=(
            "Download YouTube audio via yt-dlp and generate a guitar-removed "
            "backing track using Demucs (htdemucs 4-stem model: drums + bass + vocals)."
        ),
    )
    parser.add_argument(
        "youtube_url",
        help="YouTube URL, search query (e.g. 'The White Stripes Seven Nation Army'), or local audio file.",
    )
    parser.add_argument(
        "-o",
        "--output-name",
        default="white-stripes-seven_nation_army",
        help="Track identifier for output file (<output_name>_backing.mp3 in backend/data/audio/).",
    )
    parser.add_argument(
        "--skip-demucs",
        action="store_true",
        help="Skip Demucs stem separation and fall back to raw YouTube audio for quick testing.",
    )
    parser.add_argument(
        "--audio-dir",
        type=Path,
        default=DEFAULT_AUDIO_DIR,
        help="Directory to store downloaded and processed audio (default: backend/data/audio).",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)

    output_path = prepare_backing_track(
        youtube_url=args.youtube_url,
        output_name=args.output_name,
        skip_demucs=args.skip_demucs,
        audio_dir=args.audio_dir,
    )
    print(f"Backing track ready at: {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
