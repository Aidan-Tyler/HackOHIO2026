/**
 * Live USB Guitar Audio Input, Pitch Detection & Optional Low-Latency Monitoring (Web Audio API).
 *
 * Signal Graph:
 *   MediaStreamAudioSourceNode -> AnalyserNode (fftSize=1024, always active for pitch/hit detection)
 *                                 \-> GainNode -> AudioContext.destination (only connected when software monitoring is enabled)
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

export interface AudioLatencyDiagnostics {
  baseLatencySec: number;
  outputLatencySec: number;
  sampleRate: number;
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
  private analyserNode: AnalyserNode | null = null;
  private gainNode: GainNode | null = null;
  private timeDomainBuffer: Float32Array<ArrayBuffer> | null = null;

  private currentVolume = 0.85;
  private isConnectedState = false;
  /**
   * Software passthrough is disabled by default (`isMonitoring = false` / `directMonitoringMode = true`)
   * so players using a hardware amp or audio interface direct monitoring do not hear a delayed duplicate signal.
   */
  private isMonitoring = false;
  private isGainConnectedToDestination = false;
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
   * Initializes low-latency raw guitar input via `getUserMedia`.
   * - Uses native OS/interface hardware sampleRate (no hardcoded sampleRate) and `latencyHint: 0`.
   * - Connects `MediaStreamAudioSourceNode -> AnalyserNode (fftSize = 1024)` for pitch/hit detection.
   * - Software monitoring (`AnalyserNode -> GainNode -> audioCtx.destination`) is controlled by
   *   `setDirectMonitoringMode(enabled)`.
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

    // Omit sampleRate so AudioContext natively locks to the hardware interface clock;
    // set latencyHint: 0 ("interactive" minimum hardware buffer)
    this.audioContext = new AudioContext({ latencyHint: 0 });
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }

    // Log hardware buffer latency diagnostics
    console.info('[GuitarAudioInput] AudioContext initialized:', {
      baseLatency: this.audioContext.baseLatency,
      outputLatency: this.audioContext.outputLatency,
      sampleRate: this.audioContext.sampleRate,
    });

    this.sourceNode = this.audioContext.createMediaStreamSource(
      this.mediaStream,
    );

    // Reduced fftSize (1024) to minimize analysis buffer overhead while supporting down to E2 (82.4 Hz)
    this.analyserNode = this.audioContext.createAnalyser();
    this.analyserNode.fftSize = 1024;
    this.analyserNode.smoothingTimeConstant = 0.1;
    this.timeDomainBuffer = new Float32Array(
      new ArrayBuffer(this.analyserNode.fftSize * Float32Array.BYTES_PER_ELEMENT),
    );

    this.gainNode = this.audioContext.createGain();
    this.gainNode.gain.value = this.currentVolume;

    // Always connect Source -> AnalyserNode -> GainNode
    this.sourceNode.connect(this.analyserNode);
    this.analyserNode.connect(this.gainNode);

    // Apply current Direct Monitoring / Software Passthrough routing state
    this.applyMonitoringRouting();

    this.isConnectedState = true;
    this.activeDeviceId = deviceId ?? 'default';

    return this.listInputDevices();
  }

  /**
   * Toggles Direct Hardware Monitoring mode vs. Software Passthrough:
   * - When Direct Monitoring is ON (`enabled = true`):
   *   Software passthrough is muted (`gainNode` disconnected from `audioCtx.destination`, `isMonitoring = false`),
   *   while the stream remains actively connected to `AnalyserNode` for pitch/hit detection (0ms perceived latency).
   * - When Direct Monitoring is OFF (`enabled = false`):
   *   Enables the low-latency software monitoring route (`AnalyserNode -> GainNode -> audioCtx.destination`, `isMonitoring = true`).
   */
  public setDirectMonitoringMode(enabled: boolean): void {
    this.isMonitoring = !enabled;
    this.applyMonitoringRouting();
  }

  public isDirectMonitoringMode(): boolean {
    return !this.isMonitoring;
  }

  public isSoftwareMonitoringEnabled(): boolean {
    return this.isMonitoring;
  }

  private applyMonitoringRouting(): void {
    if (!this.gainNode || !this.audioContext) {
      this.isGainConnectedToDestination = false;
      return;
    }

    if (this.isMonitoring && !this.isGainConnectedToDestination) {
      this.gainNode.connect(this.audioContext.destination);
      this.isGainConnectedToDestination = true;
    } else if (!this.isMonitoring && this.isGainConnectedToDestination) {
      try {
        this.gainNode.disconnect(this.audioContext.destination);
      } catch {
        // Fallback if selective disconnect is unsupported
        this.gainNode.disconnect();
      }
      this.isGainConnectedToDestination = false;
    }
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
    if (this.analyserNode) {
      try {
        this.analyserNode.disconnect();
      } catch {
        // Ignore disconnect errors
      }
      this.analyserNode = null;
    }
    if (this.gainNode) {
      try {
        this.gainNode.disconnect();
      } catch {
        // Ignore disconnect errors
      }
      this.gainNode = null;
    }
    this.isGainConnectedToDestination = false;

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
        this.currentVolume,
        this.audioContext.currentTime,
        0.008,
      );
    }
  }

  public getVolume(): number {
    return this.currentVolume;
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

  public getLatencyDiagnostics(): AudioLatencyDiagnostics | null {
    if (!this.audioContext) return null;
    return {
      baseLatencySec: this.audioContext.baseLatency ?? 0,
      outputLatencySec: this.audioContext.outputLatency ?? 0,
      sampleRate: this.audioContext.sampleRate,
    };
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
