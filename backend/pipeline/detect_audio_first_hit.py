import subprocess
import tempfile
from pathlib import Path
import librosa
import numpy as np
from backend.pipeline.audio_extractor import _find_ffmpeg


def _load_audio_window(audio_path: str, sr: int = 22050, duration: float = 10.0) -> tuple[np.ndarray, int]:
    try:
        y, loaded_sr = librosa.load(audio_path, sr=sr, duration=duration)
        return y, int(loaded_sr)
    except Exception:
        ffmpeg_bin = _find_ffmpeg()
        if not ffmpeg_bin:
            raise
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp_wav = Path(tmp.name)
        try:
            subprocess.run(
                [
                    ffmpeg_bin,
                    "-y",
                    "-i",
                    str(audio_path),
                    "-t",
                    str(duration),
                    "-ac",
                    "1",
                    "-ar",
                    str(sr),
                    str(tmp_wav),
                ],
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )
            y, loaded_sr = librosa.load(str(tmp_wav), sr=sr, duration=duration)
            return y, int(loaded_sr)
        finally:
            tmp_wav.unlink(missing_ok=True)


def detect_audio_first_hit(audio_wav_path: str, search_window_sec: float = 10.0) -> float:
    """
    Scans the first N seconds of a YouTube audio file to detect the first prominent note onset.
    Returns the timestamp in seconds.
    """
    # Load just the first 10 seconds to keep it instantaneous
    y, sr = _load_audio_window(audio_wav_path, sr=22050, duration=search_window_sec)
    
    # Compute spectral onset envelope
    onset_env = librosa.onset.onset_strength(y=y, sr=sr)
    
    # Detect onset frame indices
    onset_frames = librosa.onset.onset_detect(
        onset_envelope=onset_env, 
        sr=sr, 
        backtrack=True,      # Backtracks to the true start of the attack
        pre_max=3, 
        post_max=3, 
        pre_avg=3, 
        post_avg=5, 
        delta=0.2, 
        wait=10
    )
    
    if len(onset_frames) == 0:
        return 0.0
        
    onset_times = librosa.frames_to_time(onset_frames, sr=sr)
    first_hit_sec = float(onset_times[0])
    return first_hit_sec