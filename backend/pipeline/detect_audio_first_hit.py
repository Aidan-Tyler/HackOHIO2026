import librosa
import numpy as np

def detect_audio_first_hit(audio_wav_path: str, search_window_sec: float = 10.0) -> float:
    """
    Scans the first N seconds of a YouTube audio file to detect the first prominent note onset.
    Returns the timestamp in seconds.
    """
    # Load just the first 10 seconds to keep it instantaneous
    y, sr = librosa.load(audio_wav_path, sr=22050, duration=search_window_sec)
    
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