import json
import os
import subprocess
from pathlib import Path
import pretty_midi
import yt_dlp

OUTPUT_DIR = Path("./pipeline_output")
OUTPUT_DIR.mkdir(exist_ok=True)


def download_youtube_audio(url: str, output_stem: Path) -> Path:
    """Downloads YouTube audio and saves it as a 44.1kHz 16-bit mono/stereo WAV."""
    raw_wav_path = output_stem.with_suffix(".wav")
    
    ydl_opts = {
        "format": "bestaudio/best",
        "outtmpl": str(output_stem),
        "postprocessors": [
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": "wav",
                "preferredquality": "192",
            }
        ],
        "quiet": True,
        "no_warnings": True,
    }
    
    print(f"[1/3] Downloading audio from {url}...")
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        ydl.download([url])
        
    return raw_wav_path

def separate_guitar_stem(input_wav: Path, dest_dir: Path) -> Path:
    """Runs Demucs 6-stem separation to isolate the electric/acoustic guitar track."""
    print("[2/3] Running Demucs 6-stem separation (isolating guitar)...")
    
    # Model: htdemucs_6s isolates drums, bass, vocals, other, piano, and guitar
    cmd = [
        "demucs",
        "-n", "htdemucs_6s",
        "--two-stems=guitar",  # Separates into 'guitar.wav' and 'no_guitar.wav' for speed
        "-o", str(dest_dir),
        str(input_wav),
    ]
    
    subprocess.run(cmd, check=True)
    
    # Demucs outputs to: dest_dir / model_name / track_folder_name / guitar.wav
    stem_path = dest_dir / "htdemucs_6s" / input_wav.stem / "guitar.wav"
    if not stem_path.exists():
        raise FileNotFoundError(f"Expected guitar stem not found at {stem_path}")
        
    return stem_path

