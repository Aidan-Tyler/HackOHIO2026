/**
 * Live USB Guitar Audio Input & Low-Latency Speaker Passthrough (Web Audio API).
 *
 * Signal Graph:
 *   MediaStreamAudioSourceNode -> GainNode (volume) -> AudioContext.destination
 *                              \-> AnalyserNode (for pitch detection & level metering)
 */

export interface GuitarAudioDevice {
  deviceId: string;
  label: string;
}

export interface PitchDetectionResult {
  frequencyHz: number | null;
  midiNote: number | null;
  noteName: string | null;
  rmsLevel: number;
}

const NOTE_NAMES = [
  'C',
  'C#',
  'D',
  'D#',
  'E',
  'F',
  'F#',
  'G',
  'G#',
  'A',
  'A#',
  'B',
] as const;

export function midiToNoteName(midi: number): string {
  const rounded = Math.round(midi);
  const name = NOTE_NAMES[((rounded % 12) + 12) % 12];
  const octave = Math.floor(rounded / 12) - 1;
  return `${name}${octave}`;
}

export function frequencyToMidi(freqHz: number): number {
  return 69 + 12 * Math.log2(freqHz / 440);
}

/**
 * Normalized Square Difference Function (NSDF / McLeod Pitch Method autocorrelation)
 * for deterministic monophonic guitar pitch detection.
 */
export function detectPitchAutocorrelation(
  buffer: Float32Array,
  sampleRate: number,
  minFreqHz = 70,
  maxFreqHz = 1000,
): { frequencyHz: number | null; rms: number } {
  const n = buffer.length;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    sumSq += buffer[i] * buffer[i];
  }
  const rms = Math.sqrt(sumSq / n);
  if (rms < 0.012) {
    return { frequencyHz: null, rms };
  }

  const minLag = Math.max(2, Math.floor(sampleRate / maxFreqHz));
  const maxLag = Math.min(Math.floor(n / 2), Math.ceil(sampleRate / minFreqHz));

  let bestCorrelation = -1;
  let bestLag = -1;

  for (let lag = minLag; lag <= maxLag; lag++) {
    let acf = 0;
    let norm = 0;
    const limit = n - lag;
    for (let i = 0; i < limit; i++) {
      const a = buffer[i];
      const b = buffer[i + lag];
      acf += a * b;
      norm += a * a + b * b;
    }
    const nsdf = norm > 0 ? (2 * acf) / norm : 0;
    if (nsdf > bestCorrelation) {
      bestCorrelation = nsdf;
      bestLag = lag;
    }
  }

  if (bestCorrelation < 0.78 || bestLag <= 0) {
    return { frequencyHz: null, rms };
  }

  return {
    frequencyHz: sampleRate / bestLag,
    rms,
  };
}

export class GuitarAudioInput {
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private gainNode: GainNode | null = null;
  private analyserNode: AnalyserNode | null = null;
  private timeDomainBuffer: Float32Array<ArrayBuffer> | null = null;

  private currentVolume = 0.85;
  private directMonitoringEnabled = true;
  private isConnectedState = false;
  private activeDeviceId: string | null = null;

  /**
   * Lists available audio input devices (`audioinput`).
   */
  public async listInputDevices(): Promise<GuitarAudioDevice[]> {
    if (!navigator.mediaDevices?.enumerateDevices) {
      return [];
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === 'audioinput')
      .map((d, idx) => ({
        deviceId: d.deviceId,
        label: d.label || `Audio Input #${idx + 1} (USB / Guitar Interface)`,
      }));
  }

  /**
   * Requests low-latency raw guitar input via `getUserMedia` and connects:
   * MediaStreamAudioSourceNode -> GainNode -> AudioContext.destination
   * plus an AnalyserNode tap for real-time pitch & level analysis.
   */
  public async startPassthrough(deviceId?: string): Promise<GuitarAudioDevice[]> {
    this.stopPassthrough();

    const audioConstraints: MediaTrackConstraints & { latency?: number } = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      latency: 0,
    };

    if (deviceId && deviceId !== 'default') {
      audioConstraints.deviceId = { exact: deviceId };
    }

    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints,
      video: false,
    });

    this.audioContext = new AudioContext({ latencyHint: 'interactive' });
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }

    this.sourceNode = this.audioContext.createMediaStreamSource(
      this.mediaStream,
    );
    this.gainNode = this.audioContext.createGain();
    this.gainNode.gain.value = this.directMonitoringEnabled
      ? this.currentVolume
      : 0;

    this.analyserNode = this.audioContext.createAnalyser();
    this.analyserNode.fftSize = 2048;
    this.analyserNode.smoothingTimeConstant = 0.2;
    this.timeDomainBuffer = new Float32Array(
      new ArrayBuffer(this.analyserNode.fftSize * Float32Array.BYTES_PER_ELEMENT),
    );

    // Route: Source -> Gain -> Destination (live low-latency speaker passthrough)
    this.sourceNode.connect(this.gainNode);
    this.gainNode.connect(this.audioContext.destination);

    // Tap: Source -> AnalyserNode (for pitch detection)
    this.sourceNode.connect(this.analyserNode);

    this.isConnectedState = true;
    this.activeDeviceId = deviceId ?? 'default';

    return this.listInputDevices();
  }

  public stopPassthrough(): void {
    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch {
        // Ignore disconnect errors
      }
      this.sourceNode = null;
    }
    if (this.gainNode) {
      try {
        this.gainNode.disconnect();
      } catch {
        // Ignore disconnect errors
      }
      this.gainNode = null;
    }
    if (this.analyserNode) {
      try {
        this.analyserNode.disconnect();
      } catch {
        // Ignore disconnect errors
      }
      this.analyserNode = null;
    }
    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) {
        track.stop();
      }
      this.mediaStream = null;
    }
    if (this.audioContext) {
      void this.audioContext.close();
      this.audioContext = null;
    }
    this.isConnectedState = false;
    this.activeDeviceId = null;
  }

  public setVolume(volume: number): void {
    this.currentVolume = Math.max(0, Math.min(2.0, volume));
    if (this.gainNode && this.audioContext) {
      this.gainNode.gain.setTargetAtTime(
        this.directMonitoringEnabled ? this.currentVolume : 0,
        this.audioContext.currentTime,
        0.01,
      );
    }
  }

  public getVolume(): number {
    return this.currentVolume;
  }

  /**
   * Enables or disables direct speaker/headphone monitoring while keeping
   * the USB guitar input stream and AnalyserNode pitch telemetry active.
   */
  public setDirectMonitoring(enabled: boolean): void {
    this.directMonitoringEnabled = enabled;
    if (this.gainNode && this.audioContext) {
      this.gainNode.gain.setTargetAtTime(
        this.directMonitoringEnabled ? this.currentVolume : 0,
        this.audioContext.currentTime,
        0.008,
      );
    }
  }

  public isDirectMonitoring(): boolean {
    return this.directMonitoringEnabled;
  }

  public toggleDirectMonitoring(): boolean {
    this.setDirectMonitoring(!this.directMonitoringEnabled);
    return this.directMonitoringEnabled;
  }

  public isActive(): boolean {
    return this.isConnectedState;
  }

  public getActiveDeviceId(): string | null {
    return this.activeDeviceId;
  }

  public getAnalyserNode(): AnalyserNode | null {
    return this.analyserNode;
  }

  /**
   * Samples the AnalyserNode tap and returns live RMS level and detected pitch.
   */
  public samplePitchAndLevel(): PitchDetectionResult {
    if (
      !this.isConnectedState ||
      !this.analyserNode ||
      !this.audioContext ||
      !this.timeDomainBuffer
    ) {
      return {
        frequencyHz: null,
        midiNote: null,
        noteName: null,
        rmsLevel: 0,
      };
    }

    this.analyserNode.getFloatTimeDomainData(this.timeDomainBuffer);
    const { frequencyHz, rms } = detectPitchAutocorrelation(
      this.timeDomainBuffer,
      this.audioContext.sampleRate,
    );

    if (!frequencyHz) {
      return {
        frequencyHz: null,
        midiNote: null,
        noteName: null,
        rmsLevel: rms,
      };
    }

    const midi = frequencyToMidi(frequencyHz);
    return {
      frequencyHz: Math.round(frequencyHz * 10) / 10,
      midiNote: Math.round(midi),
      noteName: midiToNoteName(midi),
      rmsLevel: rms,
    };
  }
}
