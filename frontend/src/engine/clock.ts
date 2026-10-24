import type { ChartData } from '../types/chart';

export type PlaybackState = 'PLAYING' | 'PAUSED' | 'ENDED' | 'SYNTH_FALLBACK';

export interface ClockOptions {
  /** Initial global offset in milliseconds (nudged by ±10ms with [ and ]) */
  initialOffsetMs?: number;
  /** Optional predicate to suppress hotkeys when a modal/input is focused */
  shouldIgnoreHotkeys?: () => boolean;
  /** Callback fired when playback state changes */
  onPlayStateChange?: (isPlaying: boolean, state: PlaybackState) => void;
  /** Callback fired when globalOffsetMs changes */
  onOffsetChange?: (globalOffsetMs: number) => void;
}

export const SYNTH_LEAD_IN_MS = 4000;
export const COUNT_IN_BEATS = 8;

function encodeMonoWavBlob(samples: Float32Array, sampleRate: number): Blob {
  const numSamples = samples.length;
  const dataBytes = numSamples * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(
      offset,
      clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff,
      true,
    );
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

/**
 * Synthesizes an 8-beat metronome count-in WAV track at the given BPM.
 */
function buildEightBeatCountInWav(
  bpm: number,
  beats: number = COUNT_IN_BEATS,
): { blob: Blob; durationMs: number } {
  const safeBpm = bpm > 0 ? bpm : 120;
  const beatDurationMs = 60000 / safeBpm;
  const durationMs = beats * beatDurationMs;
  const sampleRate = 22050;
  const numSamples = Math.max(1, Math.ceil((durationMs / 1000) * sampleRate));
  const samples = new Float32Array(numSamples);

  for (let b = 0; b < beats; b++) {
    const clickTimeSec = (b * beatDurationMs) / 1000;
    const startIdx = Math.floor(clickTimeSec * sampleRate);
    const isDownbeat = b % 4 === 0;
    const freq = isDownbeat ? 1180 : 800;
    const clickLen = Math.floor(0.04 * sampleRate);
    const amp = isDownbeat ? 0.36 : 0.24;
    for (let i = 0; i < clickLen && startIdx + i < numSamples; i++) {
      const t = i / sampleRate;
      const env = Math.exp(-t * 90);
      samples[startIdx + i] += Math.sin(2 * Math.PI * freq * t) * env * amp;
    }
  }

  return {
    blob: encodeMonoWavBlob(samples, sampleRate),
    durationMs,
  };
}

/**
 * Analyzes the first 15 seconds of an audio file using Web Audio API `decodeAudioData`
 * to detect the exact millisecond of the first prominent note attack/onset.
 */
export async function detectFirstAudioOnsetMs(
  audioUrl: string,
): Promise<number | null> {
  try {
    const response = await fetch(audioUrl);
    if (!response.ok) return null;
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('text/html')) return null;

    const arrayBuffer = await response.arrayBuffer();
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    const ctx = new AudioCtx();
    try {
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
      const sr = audioBuffer.sampleRate;
      const channelData = audioBuffer.getChannelData(0);
      const maxScanSamples = Math.min(channelData.length, Math.floor(sr * 15));
      const windowSamples = Math.max(1, Math.floor(sr * 0.005)); // 5ms windows
      const numWindows = Math.floor(maxScanSamples / windowSamples);
      if (numWindows <= 0) return null;

      const rmsValues = new Float32Array(numWindows);
      let peakRms = 0;

      for (let w = 0; w < numWindows; w++) {
        let sumSq = 0;
        const base = w * windowSamples;
        for (let i = 0; i < windowSamples; i++) {
          const s = channelData[base + i];
          sumSq += s * s;
        }
        const rms = Math.sqrt(sumSq / windowSamples);
        rmsValues[w] = rms;
        if (rms > peakRms) peakRms = rms;
      }

      if (peakRms < 0.01) return null;
      const threshold = Math.max(0.025, peakRms * 0.35);

      let hitWindow = 0;
      for (let w = 0; w < numWindows; w++) {
        if (rmsValues[w] >= threshold) {
          hitWindow = w;
          while (
            hitWindow > 0 &&
            rmsValues[hitWindow - 1] >= threshold * 0.25
          ) {
            hitWindow--;
          }
          break;
        }
      }

      return Math.round(((hitWindow * windowSamples) / sr) * 1000);
    } finally {
      void ctx.close();
    }
  } catch {
    return null;
  }
}

/**
 * Calibrates a chart's note/measure timestamps and first-note offset against an audio file.
 * - If the chart already contains a multi-point tempo map (`tempoMap.length > 1`), preserves its
 *   calibrated measure timings and returns the first-hit offset.
 * - If the chart has only a single static BPM (`tempoMap.length <= 1`), decodes the audio track,
 *   detects the first note onset, and correlates the chart's note/beat pattern against the audio's
 *   onset envelope to detect if the recording plays at a slightly different BPM than the tab.
 */
export async function calibrateChartToAudio(
  audioUrl: string,
  chart: ChartData,
  explicitOffsetMs = 0,
): Promise<{ firstHitMs: number; calibratedBpm: number }> {
  const initialBpm = chart.metadata.initialBpm || 120;
  const hasMultiTempoMap = (chart.tempoMap?.length ?? 0) > 1;

  if (hasMultiTempoMap && explicitOffsetMs > 0) {
    return { firstHitMs: explicitOffsetMs, calibratedBpm: initialBpm };
  }

  try {
    const response = await fetch(audioUrl);
    if (!response.ok) {
      return { firstHitMs: explicitOffsetMs, calibratedBpm: initialBpm };
    }
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('text/html')) {
      return { firstHitMs: explicitOffsetMs, calibratedBpm: initialBpm };
    }

    const arrayBuffer = await response.arrayBuffer();
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    const ctx = new AudioCtx();
    try {
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
      const sr = audioBuffer.sampleRate;
      const channelData = audioBuffer.getChannelData(0);

      // 1. Compute 10ms RMS and positive onset envelope over the first 90 seconds
      const hopSamples = Math.max(1, Math.floor(sr * 0.01)); // 10ms
      const maxAnalyzeSamples = Math.min(
        channelData.length,
        Math.floor(sr * 90),
      );
      const numFrames = Math.floor(maxAnalyzeSamples / hopSamples);
      if (numFrames <= 10) {
        return { firstHitMs: explicitOffsetMs, calibratedBpm: initialBpm };
      }

      const rms = new Float32Array(numFrames);
      const onset = new Float32Array(numFrames);
      let peakFirst15s = 0;
      const frames15s = Math.min(numFrames, 1500);

      for (let f = 0; f < numFrames; f++) {
        let sumSq = 0;
        const base = f * hopSamples;
        for (let i = 0; i < hopSamples; i++) {
          const s = channelData[base + i];
          sumSq += s * s;
        }
        const val = Math.sqrt(sumSq / hopSamples);
        rms[f] = val;
        if (f < frames15s && val > peakFirst15s) {
          peakFirst15s = val;
        }
        onset[f] = f > 0 ? Math.max(0, val - rms[f - 1]) : 0;
      }

      // 2. Determine first audio hit timestamp
      let firstHitMs = explicitOffsetMs;
      if (firstHitMs <= 0 && peakFirst15s >= 0.01) {
        const threshold = Math.max(0.025, peakFirst15s * 0.35);
        for (let f = 0; f < frames15s; f++) {
          if (rms[f] >= threshold) {
            let hitF = f;
            while (hitF > 0 && rms[hitF - 1] >= threshold * 0.25) {
              hitF--;
            }
            firstHitMs = Math.round(((hitF * hopSamples) / sr) * 1000);
            break;
          }
        }
      }

      if (hasMultiTempoMap || chart.notes.length < 8) {
        return { firstHitMs, calibratedBpm: initialBpm };
      }

      // 3. Correlate chart note attacks (in the first 75s) with the audio onset envelope
      // to find the recording's true BPM around initialBpm (±12%)
      const firstNoteMs = chart.notes[0]?.timeMs ?? 0;
      const sampleNotes: number[] = [];
      let lastSampledMs = -1000;
      for (const n of chart.notes) {
        const relMs = n.timeMs - firstNoteMs;
        if (relMs > 75000) break;
        if (relMs - lastSampledMs >= 180) {
          sampleNotes.push(relMs);
          lastSampledMs = relMs;
        }
      }

      if (sampleNotes.length < 8) {
        return { firstHitMs, calibratedBpm: initialBpm };
      }

      const scoreBpm = (candidateBpm: number): number => {
        const scale = initialBpm / candidateBpm;
        let score = 0;
        for (let i = 0; i < sampleNotes.length; i++) {
          const targetAudioMs = firstHitMs + sampleNotes[i] * scale;
          const f = Math.round(targetAudioMs / 10);
          if (f >= 2 && f < numFrames - 2) {
            const localPeak = Math.max(
              onset[f - 2] * 0.6,
              onset[f - 1] * 0.85,
              onset[f],
              onset[f + 1] * 0.85,
              onset[f + 2] * 0.6,
            );
            score += localPeak;
          }
        }
        return score;
      };

      const baselineScore = scoreBpm(initialBpm);
      let bestBpm = initialBpm;
      let bestScore = baselineScore;

      const minBpm = Math.max(40, Math.round(initialBpm * 0.88 * 4) / 4);
      const maxBpm = Math.min(260, Math.round(initialBpm * 1.12 * 4) / 4);

      for (let bpm = minBpm; bpm <= maxBpm; bpm += 0.25) {
        const s = scoreBpm(bpm);
        if (s > bestScore) {
          bestScore = s;
          bestBpm = bpm;
        }
      }

      // Apply tempo scaling if the detected BPM improves onset correlation meaningfully
      if (
        Math.abs(bestBpm - initialBpm) >= 0.5 &&
        bestScore > baselineScore * 1.06
      ) {
        const scale = initialBpm / bestBpm;
        for (const m of chart.measures) {
          m.startMs = Number((m.startMs * scale).toFixed(2));
          m.start_ms = m.startMs;
          m.endMs = Number((m.endMs * scale).toFixed(2));
          m.end_ms = m.endMs;
          m.durationMs = Number((m.durationMs * scale).toFixed(2));
          m.duration_ms = m.durationMs;
          m.bpm = Number(bestBpm.toFixed(2));
        }
        for (const n of chart.notes) {
          const rel = n.timeMs - firstNoteMs;
          const scaledTime = Number((firstNoteMs + rel * scale).toFixed(2));
          const scaledDur = Number((n.durationMs * scale).toFixed(2));
          n.timeMs = scaledTime;
          n.time_ms = scaledTime;
          n.durationMs = scaledDur;
          n.duration_ms = scaledDur;
        }
        chart.metadata.initialBpm = Number(bestBpm.toFixed(2));
        chart.metadata.initial_bpm = chart.metadata.initialBpm;
        chart.metadata.totalDurationMs = Number(
          (chart.metadata.totalDurationMs * scale).toFixed(2),
        );
        chart.metadata.total_duration_ms = chart.metadata.totalDurationMs;
        return { firstHitMs, calibratedBpm: chart.metadata.initialBpm };
      }

      return { firstHitMs, calibratedBpm: initialBpm };
    } finally {
      void ctx.close();
    }
  } catch {
    return { firstHitMs: explicitOffsetMs, calibratedBpm: initialBpm };
  }
}

/**
 * Synthesizes an in-memory 16-bit PCM WAV Blob containing a Web Audio-style
 * metronome click track and plucked guitar synthesizer notes from the chart,
 * with a `SYNTH_LEAD_IN_MS` (2000ms) count-in lead-in.
 */
function buildSynthesizedBackingWav(
  chart: ChartData | null,
  durationMs = 228500,
): Blob {
  const sampleRate = 22050;
  const totalSec = Math.max(
    5,
    Math.min(600, Math.ceil((durationMs + SYNTH_LEAD_IN_MS) / 1000) + 2),
  );
  const numSamples = totalSec * sampleRate;
  const samples = new Float32Array(numSamples);

  // 1. Render metronome clicks across measures & beats shifted by SYNTH_LEAD_IN_MS
  const measures = chart?.measures ?? [];
  if (measures.length > 0) {
    for (const m of measures) {
      const [numStr] = (m.timeSignature || '4/4').split('/');
      const beats = Math.max(1, parseInt(numStr, 10) || 4);
      const beatDurMs = m.durationMs / beats;
      for (let b = 0; b < beats; b++) {
        const clickTimeSec =
          (SYNTH_LEAD_IN_MS + m.startMs + b * beatDurMs) / 1000;
        const startIdx = Math.floor(clickTimeSec * sampleRate);
        if (startIdx < 0 || startIdx >= numSamples) continue;

        const freq = b === 0 ? 1100 : 750;
        const clickLen = Math.floor(0.035 * sampleRate);
        const amp = b === 0 ? 0.22 : 0.14;
        for (let i = 0; i < clickLen && startIdx + i < numSamples; i++) {
          const t = i / sampleRate;
          const env = Math.exp(-t * 95);
          samples[startIdx + i] += Math.sin(2 * Math.PI * freq * t) * env * amp;
        }
      }
    }
  }

  // 2. Render synthesized guitar plucks for chart notes shifted by SYNTH_LEAD_IN_MS
  const notes = chart?.notes ?? [];
  for (const note of notes) {
    const startSec = (SYNTH_LEAD_IN_MS + note.timeMs) / 1000;
    const startIdx = Math.floor(startSec * sampleRate);
    if (startIdx < 0 || startIdx >= numSamples) continue;

    const durSec = Math.max(0.12, Math.min(1.5, note.durationMs / 1000));
    const noteSamples = Math.floor(durSec * sampleRate);
    const freq = 440 * Math.pow(2, (note.midi_pitch - 69) / 12);

    for (let i = 0; i < noteSamples && startIdx + i < numSamples; i++) {
      const t = i / sampleRate;
      const attack = Math.min(1, t / 0.004);
      const decay = Math.exp(-t * 5.5);
      const harmonic1 = Math.sin(2 * Math.PI * freq * t);
      const harmonic2 = 0.45 * Math.sin(4 * Math.PI * freq * t);
      const harmonic3 = 0.2 * Math.sin(6 * Math.PI * freq * t);
      samples[startIdx + i] +=
        (harmonic1 + harmonic2 + harmonic3) * attack * decay * 0.18;
    }
  }

  return encodeMonoWavBlob(samples, sampleRate);
}

/**
 * Hardware-synced Audio-Locked Clock (`frontend/src/engine/clock.ts`).
 *
 * Invariants (per AGENTS.md):
 * - NEVER uses `requestAnimationFrame` delta accumulation or `performance.now()` as primary clock.
 * - Always ties playhead time to `(audio.currentTime * 1000) + globalOffsetMs`.
 * - Hotkeys:
 *   * `Space`: Play / Pause
 *   * `[`: `globalOffsetMs -= 10`
 *   * `]`: `globalOffsetMs += 10`
 * - Exposes an on-screen debug HUD displaying `currentAudioTimeMs`, `globalOffsetMs`, and playback state.
 */
export class AudioClock {
  public readonly audio: HTMLAudioElement;
  public readonly countInAudio: HTMLAudioElement;
  public globalOffsetMs: number;

  private readonly options: ClockOptions;
  private isSynthFallback = false;
  private synthBlobUrl: string | null = null;
  private countInBlobUrl: string | null = null;
  private countInDurationMs = 4000;
  private firstNoteChartMs = 0;
  private inCountIn = true;
  private debugHudEl: HTMLElement | null = null;
  private readonly keydownHandler: (e: KeyboardEvent) => void;

  constructor(options: ClockOptions = {}) {
    this.options = options;
    this.globalOffsetMs = options.initialOffsetMs ?? 0;

    this.audio = new Audio();
    this.audio.preload = 'auto';

    this.countInAudio = new Audio();
    this.countInAudio.preload = 'auto';
    this.configureCountIn(120, 0);

    this.audio.addEventListener('play', () => {
      this.notifyStateChange();
      this.updateDebugHud();
    });
    this.audio.addEventListener('pause', () => {
      this.notifyStateChange();
      this.updateDebugHud();
    });
    this.audio.addEventListener('ended', () => {
      this.notifyStateChange();
      this.updateDebugHud();
    });

    this.countInAudio.addEventListener('play', () => {
      this.notifyStateChange();
      this.updateDebugHud();
    });
    this.countInAudio.addEventListener('pause', () => {
      this.notifyStateChange();
      this.updateDebugHud();
    });
    this.countInAudio.addEventListener('ended', () => {
      this.inCountIn = false;
      if (this.audio.paused && !this.audio.ended) {
        const targetSec = Math.max(
          0,
          (this.firstNoteChartMs - this.globalOffsetMs) / 1000,
        );
        try {
          this.audio.currentTime = targetSec;
        } catch {
          // Ignore seek errors
        }
        void this.audio.play().catch(() => {});
      }
      this.notifyStateChange();
      this.updateDebugHud();
    });

    this.ensureDebugHud();

    this.keydownHandler = (e: KeyboardEvent) => this.handleKeyDown(e);
    window.addEventListener('keydown', this.keydownHandler);
  }

  /**
   * Configures the 8-beat count-in click track for the loaded song's initial BPM and first note timestamp.
   */
  public configureCountIn(initialBpm: number, firstNoteChartMs = 0): void {
    this.cleanupCountInBlob();
    this.firstNoteChartMs = firstNoteChartMs;
    const { blob, durationMs } = buildEightBeatCountInWav(
      initialBpm,
      COUNT_IN_BEATS,
    );
    this.countInDurationMs = durationMs;
    this.countInBlobUrl = URL.createObjectURL(blob);
    this.countInAudio.src = this.countInBlobUrl;
    this.countInAudio.preservesPitch = true;
    this.countInAudio.defaultPlaybackRate = this.audio.playbackRate || 1;
    this.countInAudio.playbackRate = this.audio.playbackRate || 1;
    this.countInAudio.muted = this.audio.muted;
    this.countInAudio.load();
  }

  public getCountInStartChartMs(): number {
    return this.firstNoteChartMs - this.countInDurationMs;
  }

  public getCountInDurationMs(): number {
    return this.countInDurationMs;
  }

  public getCountInBeatInfo(
    currentAudioTimeMs = this.getCurrentAudioTimeMs(),
  ): {
    active: boolean;
    beatNumber: number;
    countdownNumber: number;
    totalBeats: number;
  } {
    const startMs = this.getCountInStartChartMs();
    const active =
      this.inCountIn &&
      currentAudioTimeMs >= startMs - 50 &&
      currentAudioTimeMs < this.firstNoteChartMs - 20;
    const elapsedMs = Math.max(0, currentAudioTimeMs - startMs);
    const beatDurMs = this.countInDurationMs / COUNT_IN_BEATS;
    const beatIndex = Math.min(
      COUNT_IN_BEATS - 1,
      Math.max(0, Math.floor(elapsedMs / beatDurMs)),
    );
    return {
      active,
      beatNumber: beatIndex + 1,
      countdownNumber: COUNT_IN_BEATS - beatIndex,
      totalBeats: COUNT_IN_BEATS,
    };
  }

  /**
   * Computes the current playhead time in milliseconds strictly locked to `HTMLAudioElement.currentTime`.
   */
  public getCurrentAudioTimeMs(): number {
    const audio = this.audio;
    const globalOffsetMs = this.globalOffsetMs;

    if (this.inCountIn) {
      const elapsedCountInMs = this.countInAudio.currentTime * 1000;
      const countInChartMs = this.getCountInStartChartMs() + elapsedCountInMs;
      const desiredAudioMs = countInChartMs - globalOffsetMs;

      if (!this.countInAudio.paused && !this.countInAudio.ended) {
        if (desiredAudioMs >= 0 && audio.paused && !audio.ended) {
          try {
            audio.currentTime = Math.max(0, desiredAudioMs / 1000);
          } catch {
            // Ignore seek errors
          }
          void audio.play().catch(() => {});
        }
      }

      if (
        this.countInAudio.ended ||
        elapsedCountInMs >= this.countInDurationMs
      ) {
        this.inCountIn = false;
        return audio.currentTime * 1000 + globalOffsetMs;
      }

      if (!audio.paused) {
        return audio.currentTime * 1000 + globalOffsetMs;
      }

      return countInChartMs;
    }

    const currentAudioTimeMs = audio.currentTime * 1000 + globalOffsetMs;
    return currentAudioTimeMs;
  }

  /**
   * Loads the backing audio file into the master HTMLAudioElement, falling back to
   * a synthesized Web Audio guitar/metronome track if the audio file is missing.
   * Returns the loaded audio URL (or null if using synthesized fallback).
   */
  public async loadTrack(
    primaryAudioUrl: string | undefined,
    chart: ChartData | null,
    durationMs = 228500,
  ): Promise<string | null> {
    this.pause();
    this.cleanupSynthBlob();
    this.isSynthFallback = false;

    const candidateUrls: string[] = [];
    if (primaryAudioUrl && primaryAudioUrl.trim().length > 0) {
      candidateUrls.push(primaryAudioUrl);
    }
    if (
      primaryAudioUrl?.includes('seven_nation_army') &&
      !candidateUrls.includes('/audio/seven_nation_army_backing.mp3')
    ) {
      candidateUrls.push('/audio/seven_nation_army_backing.mp3');
    }
    if (
      primaryAudioUrl?.includes('seven_nation_army') &&
      !candidateUrls.includes('/audio/white-stripes-seven_nation_army_backing.mp3')
    ) {
      candidateUrls.push('/audio/white-stripes-seven_nation_army_backing.mp3');
    }

    for (const url of candidateUrls) {
      const loaded = await this.tryLoadAudioUrl(url);
      if (loaded) {
        this.isSynthFallback = false;
        this.updateDebugHud();
        return url;
      }
    }

    const wavBlob = buildSynthesizedBackingWav(chart, durationMs);
    this.synthBlobUrl = URL.createObjectURL(wavBlob);
    this.isSynthFallback = true;
    await this.tryLoadAudioUrl(this.synthBlobUrl);
    this.updateDebugHud();
    return null;
  }

  private tryLoadAudioUrl(url: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const cleanup = () => {
        this.audio.removeEventListener('canplay', onCanPlay);
        this.audio.removeEventListener('loadedmetadata', onCanPlay);
        this.audio.removeEventListener('error', onError);
      };
      const onCanPlay = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(true);
      };
      const onError = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(false);
      };

      this.audio.addEventListener('canplay', onCanPlay, { once: true });
      this.audio.addEventListener('loadedmetadata', onCanPlay, { once: true });
      this.audio.addEventListener('error', onError, { once: true });
      this.audio.src = url;
      this.audio.load();
    });
  }

  public async play(): Promise<void> {
    if (this.inCountIn) {
      const elapsedCountInMs = this.countInAudio.currentTime * 1000;
      const countInChartMs = this.getCountInStartChartMs() + elapsedCountInMs;
      const desiredAudioMs = countInChartMs - this.globalOffsetMs;

      if (desiredAudioMs >= 0) {
        try {
          this.audio.currentTime = desiredAudioMs / 1000;
        } catch {
          // Ignore seek errors
        }
        try {
          await Promise.all([this.countInAudio.play(), this.audio.play()]);
        } catch (err) {
          console.warn('Audio playback blocked or failed:', err);
        }
      } else {
        // Unlock main audio element during user gesture so it can start seamlessly when desiredAudioMs >= 0
        const prevMuted = this.audio.muted;
        this.audio.muted = true;
        try {
          await this.audio.play();
          this.audio.pause();
          this.audio.currentTime = 0;
        } catch {
          // Ignore unlock errors
        } finally {
          this.audio.muted = prevMuted;
        }

        try {
          await this.countInAudio.play();
        } catch (err) {
          console.warn('Count-in playback blocked or failed:', err);
        }
      }
      this.notifyStateChange();
      this.updateDebugHud();
      return;
    }

    try {
      await this.audio.play();
    } catch (err) {
      console.warn('Audio playback blocked or failed:', err);
    }
    this.notifyStateChange();
    this.updateDebugHud();
  }

  public pause(): void {
    this.countInAudio.pause();
    this.audio.pause();
    this.notifyStateChange();
    this.updateDebugHud();
  }

  public async togglePlayPause(): Promise<boolean> {
    if (this.isPlaying()) {
      this.pause();
      return false;
    } else {
      if (this.audio.ended) {
        this.resetToTrackStart();
      }
      await this.play();
      return true;
    }
  }

  public isPlaying(): boolean {
    const countInPlaying =
      this.inCountIn && !this.countInAudio.paused && !this.countInAudio.ended;
    const mainPlaying = !this.audio.paused && !this.audio.ended;
    return countInPlaying || mainPlaying;
  }

  public isUsingSynthFallback(): boolean {
    return this.isSynthFallback;
  }

  public getPlaybackState(): PlaybackState {
    if (this.audio.ended && !this.inCountIn) return 'ENDED';
    if (this.isPlaying()) {
      return this.isSynthFallback ? 'SYNTH_FALLBACK' : 'PLAYING';
    }
    return 'PAUSED';
  }

  /**
   * Resets to the start of the 8-beat count-in (`firstNoteChartMs - countInDurationMs`)
   * so the player always gets a full 8-beat count-in before the song begins.
   */
  public resetToTrackStart(): void {
    this.countInAudio.pause();
    this.audio.pause();
    this.inCountIn = true;
    try {
      this.countInAudio.currentTime = 0;
    } catch {
      // Ignore seek errors before metadata is ready
    }
    const startAudioSec = Math.max(
      0,
      (this.getCountInStartChartMs() - this.globalOffsetMs) / 1000,
    );
    try {
      this.audio.currentTime = startAudioSec;
    } catch {
      // Ignore seek errors before media metadata is ready
    }
    this.updateDebugHud();
  }

  /**
   * Seeks the underlying HTMLAudioElement so `getCurrentAudioTimeMs()` equals `targetChartTimeMs`.
   */
  public seekToMs(targetChartTimeMs: number): void {
    this.inCountIn = false;
    this.countInAudio.pause();
    const targetAudioSec = Math.max(
      0,
      (targetChartTimeMs - this.globalOffsetMs) / 1000,
    );
    try {
      if (Number.isFinite(this.audio.duration) && this.audio.duration > 0) {
        this.audio.currentTime = Math.min(this.audio.duration, targetAudioSec);
      } else {
        this.audio.currentTime = targetAudioSec;
      }
    } catch {
      // Ignore seek errors before media metadata is ready
    }
    this.updateDebugHud();
  }

  /**
   * Adjusts `globalOffsetMs` live (e.g. ±10ms via `[` and `]`).
   */
  public setGlobalOffsetMs(offsetMs: number): void {
    this.globalOffsetMs = Math.round(offsetMs);
    this.options.onOffsetChange?.(this.globalOffsetMs);
    this.updateDebugHud();
  }

  public nudgeGlobalOffsetMs(deltaMs: number): void {
    this.setGlobalOffsetMs(this.globalOffsetMs + deltaMs);
  }

  /**
   * Plays the song slower or faster (e.g. 0.75 = 75% speed) without changing pitch.
   * The clock stays audio-locked: chart time still comes from `audio.currentTime`, so
   * the highway, scoring and `globalOffsetMs` all follow the new speed automatically.
   * `defaultPlaybackRate` carries the speed over when `loadTrack` swaps the source.
   */
  public setPlaybackRate(rate: number): void {
    const clamped = Math.max(0.5, Math.min(1.5, rate));
    this.audio.preservesPitch = true;
    this.audio.defaultPlaybackRate = clamped;
    this.audio.playbackRate = clamped;
    this.countInAudio.preservesPitch = true;
    this.countInAudio.defaultPlaybackRate = clamped;
    this.countInAudio.playbackRate = clamped;
    this.updateDebugHud();
  }

  public getPlaybackRate(): number {
    return this.audio.playbackRate;
  }

  public setMuted(muted: boolean): void {
    this.audio.muted = muted;
    this.countInAudio.muted = muted;
  }

  public isMuted(): boolean {
    return this.audio.muted;
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (this.options.shouldIgnoreHotkeys?.()) {
      return;
    }
    const target = e.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable)
    ) {
      if (
        target.tagName !== 'INPUT' ||
        (target as HTMLInputElement).type !== 'range'
      ) {
        return;
      }
    }

    if (e.code === 'Space') {
      e.preventDefault();
      void this.togglePlayPause();
    } else if (e.code === 'BracketLeft' || e.key === '[') {
      e.preventDefault();
      this.globalOffsetMs -= 10;
      this.options.onOffsetChange?.(this.globalOffsetMs);
      this.updateDebugHud();
    } else if (e.code === 'BracketRight' || e.key === ']') {
      e.preventDefault();
      this.globalOffsetMs += 10;
      this.options.onOffsetChange?.(this.globalOffsetMs);
      this.updateDebugHud();
    }
  }

  private notifyStateChange(): void {
    this.options.onPlayStateChange?.(this.isPlaying(), this.getPlaybackState());
  }

  private ensureDebugHud(): void {
    const existing = document.getElementById('clock-debug-hud');
    if (existing) {
      this.debugHudEl = existing;
      this.updateDebugHud();
    }
  }

  public updateDebugHud(): void {
    if (!this.debugHudEl) return;
    const currentAudioTimeMs = this.getCurrentAudioTimeMs();
    const state = this.getPlaybackState();
    const offsetStr = `${this.globalOffsetMs >= 0 ? '+' : ''}${this.globalOffsetMs} ms`;
    const stateColor =
      state === 'PLAYING' || state === 'SYNTH_FALLBACK' ? '#4ade80' : '#fbbf24';

    this.debugHudEl.innerHTML = `
      <div style="font-weight:700;color:#38bdf8">AUDIO CLOCK · <span style="color:${stateColor}">${state}</span></div>
      <div>Time: <strong>${currentAudioTimeMs.toFixed(1)} ms</strong> · Sync: <strong>${offsetStr}</strong> · Speed: <strong>${Math.round(this.audio.playbackRate * 100)}%</strong></div>
    `;
  }

  private cleanupSynthBlob(): void {
    if (this.synthBlobUrl) {
      URL.revokeObjectURL(this.synthBlobUrl);
      this.synthBlobUrl = null;
    }
  }

  private cleanupCountInBlob(): void {
    if (this.countInBlobUrl) {
      URL.revokeObjectURL(this.countInBlobUrl);
      this.countInBlobUrl = null;
    }
  }

  public dispose(): void {
    window.removeEventListener('keydown', this.keydownHandler);
    this.pause();
    this.cleanupSynthBlob();
    this.cleanupCountInBlob();
  }
}
