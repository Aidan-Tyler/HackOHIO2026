import { GuitarAudioInput } from './audio/guitar_input';
import { HighwayEngine, STRING_RAILS } from './engine/highway';
import {
  normalizeChart,
  type ChartData,
  type ChartMeasure,
  type ChartNote,
} from './types/chart';

const CHART_URL = '/charts/white-stripes-seven_nation_army.json';
const BACKING_AUDIO_URL = '/audio/white-stripes-seven_nation_army_backing.mp3';

function formatTimeMs(ms: number): string {
  const clamped = Math.max(0, ms);
  const totalSec = Math.floor(clamped / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  const tenths = Math.floor((clamped % 1000) / 100);
  return `${minutes}:${String(seconds).padStart(2, '0')}.${tenths}`;
}

function findCurrentMeasure(
  measures: ChartMeasure[],
  timeMs: number,
): ChartMeasure | undefined {
  for (let i = measures.length - 1; i >= 0; i--) {
    if (timeMs >= measures[i].startMs) {
      return measures[i];
    }
  }
  return measures[0];
}

async function bootstrap(): Promise<void> {
  const viewportEl = document.getElementById('highway-viewport')!;
  const titleEl = document.getElementById('song-title')!;
  const artistEl = document.getElementById('song-artist')!;
  const bpmEl = document.getElementById('hud-bpm')!;
  const measureEl = document.getElementById('hud-measure')!;
  const handPosEl = document.getElementById('hud-hand-pos')!;
  const activeNotesEl = document.getElementById('hud-active-notes')!;
  const upcomingRiffEl = document.getElementById('hud-upcoming-riff')!;

  // Backing Track & Highway Controls
  const playPauseBtn = document.getElementById(
    'play-pause-btn',
  ) as HTMLButtonElement;
  const restartBtn = document.getElementById(
    'restart-btn',
  ) as HTMLButtonElement;
  const jumpChorusBtn = document.getElementById(
    'jump-chorus-btn',
  ) as HTMLButtonElement;
  const backingMuteBtn = document.getElementById(
    'backing-mute-btn',
  ) as HTMLButtonElement;

  const scrubSlider = document.getElementById(
    'scrub-slider',
  ) as HTMLInputElement;
  const timeCurrentEl = document.getElementById('time-current')!;
  const timeTotalEl = document.getElementById('time-total')!;
  const speedSlider = document.getElementById(
    'speed-slider',
  ) as HTMLInputElement;
  const speedValueEl = document.getElementById('speed-value')!;
  const legendContainer = document.getElementById('string-legend')!;

  // USB Guitar Input Passthrough Controls
  const inputDeviceSelect = document.getElementById(
    'audio-input-select',
  ) as HTMLSelectElement;
  const guitarConnectBtn = document.getElementById(
    'guitar-connect-btn',
  ) as HTMLButtonElement;
  const directMonitorBtn = document.getElementById(
    'direct-monitor-btn',
  ) as HTMLButtonElement;
  const guitarVolumeSlider = document.getElementById(
    'guitar-volume-slider',
  ) as HTMLInputElement;
  const guitarPitchBadge = document.getElementById('guitar-pitch-badge')!;
  const guitarLevelFill = document.getElementById('guitar-level-fill')!;

  // Render string rail legend badges (String 6 / Low E down to String 1 / High E)
  legendContainer.innerHTML = STRING_RAILS.map(
    (rail) => `
      <div class="legend-chip" style="--rail-color: ${rail.colorCss}">
        <span class="dot"></span>
        <span>${rail.label} (${rail.noteName})</span>
      </div>
    `,
  ).join('');

  const engine = new HighwayEngine(viewportEl);
  const guitarInput = new GuitarAudioInput();

  // HTMLAudioElement for Backing Track Sync
  const backingAudio = new Audio(BACKING_AUDIO_URL);
  backingAudio.preload = 'auto';
  let audioReady = false;
  backingAudio.addEventListener('canplay', () => {
    audioReady = true;
  });

  let chart: ChartData | null = null;
  let isPlaying = false;
  let currentTimeMs = 0;
  let totalDurationMs = 228500;
  let lastFrameTimestamp: number | null = null;

  async function refreshAudioDeviceOptions(): Promise<void> {
    const devices = await guitarInput.listInputDevices();
    const currentVal = inputDeviceSelect.value;
    inputDeviceSelect.innerHTML = `<option value="default">Default USB / Guitar Audio Input</option>`;
    for (const dev of devices) {
      const opt = document.createElement('option');
      opt.value = dev.deviceId;
      opt.textContent = dev.label;
      inputDeviceSelect.appendChild(opt);
    }
    if (currentVal) {
      inputDeviceSelect.value = currentVal;
    }
  }

  void refreshAudioDeviceOptions();

  function updateHud(timeMs: number): void {
    timeCurrentEl.textContent = formatTimeMs(timeMs);
    scrubSlider.value = String(Math.round(timeMs));

    const handRange = engine.getActiveHandPosition();
    handPosEl.textContent = `Frets ${handRange.startFret}–${handRange.endFret}`;

    if (!chart) return;

    const currentMeasure = findCurrentMeasure(chart.measures, timeMs);
    if (currentMeasure) {
      measureEl.textContent = `${currentMeasure.number} / ${chart.measures.length}`;
      bpmEl.textContent = `${Math.round(currentMeasure.bpm)} BPM`;
    }

    const activeNotes: ChartNote[] = engine.getActiveNotesAtHitBar();
    if (activeNotes.length > 0) {
      activeNotesEl.innerHTML = activeNotes
        .map((n) => {
          const rail = STRING_RAILS.find((r) => r.stringNumber === n.string);
          const color = rail?.colorCss ?? '#38bdf8';
          return `<span class="note-pill" style="border-color:${color};color:${color}">S${n.string} · Fret <strong>${n.fret}</strong></span>`;
        })
        .join(' ');
    } else {
      activeNotesEl.innerHTML = `<span class="muted">Waiting at Fretboard…</span>`;
    }

    const upcoming = chart.notes
      .filter((n) => n.timeMs >= timeMs - 80)
      .slice(0, 7);
    if (upcoming.length > 0) {
      upcomingRiffEl.textContent = upcoming.map((n) => `${n.fret}`).join(' - ');
    } else {
      upcomingRiffEl.textContent = 'End of chart';
    }
  }

  function seekTo(targetMs: number): void {
    currentTimeMs = Math.max(0, Math.min(totalDurationMs, targetMs));
    if (audioReady) {
      try {
        backingAudio.currentTime = currentTimeMs / 1000;
      } catch {
        // Ignore seek errors before metadata is loaded
      }
    }
    engine.update(currentTimeMs);
    updateHud(currentTimeMs);
  }

  async function setPlaying(nextPlaying: boolean): Promise<void> {
    isPlaying = nextPlaying;
    lastFrameTimestamp = null;
    playPauseBtn.textContent = isPlaying ? '⏸ Pause' : '▶ Play';
    playPauseBtn.classList.toggle('active', isPlaying);

    if (isPlaying) {
      try {
        backingAudio.currentTime = currentTimeMs / 1000;
        await backingAudio.play();
      } catch {
        // Fallback to simulated clock if audio playback is blocked or unavailable
      }
    } else {
      backingAudio.pause();
    }
  }

  // Load chart JSON on startup
  try {
    const response = await fetch(CHART_URL);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fetching ${CHART_URL}`);
    }
    const rawJson = (await response.json()) as Record<string, unknown>;
    chart = normalizeChart(rawJson);

    totalDurationMs = chart.metadata.totalDurationMs || 228500;
    scrubSlider.max = String(Math.ceil(totalDurationMs));
    timeTotalEl.textContent = formatTimeMs(totalDurationMs);
    titleEl.textContent = chart.metadata.title;
    artistEl.textContent = `${chart.metadata.artist} · ${chart.notes.length} Notes · ${chart.measures.length} Measures`;

    engine.loadChart(chart);
    seekTo(0);
  } catch (err) {
    console.error('Failed to load chart JSON:', err);
    artistEl.textContent = `Error loading chart: ${String(err)}`;
  }

  // Playback Controls Event Listeners
  playPauseBtn.addEventListener('click', () => {
    if (currentTimeMs >= totalDurationMs) {
      seekTo(0);
    }
    void setPlaying(!isPlaying);
  });

  restartBtn.addEventListener('click', () => {
    seekTo(0);
  });

  jumpChorusBtn.addEventListener('click', () => {
    // Measure 27 (52,000 ms) is where the power-chord chorus clusters hit
    seekTo(52000);
  });

  backingMuteBtn.addEventListener('click', () => {
    backingAudio.muted = !backingAudio.muted;
    backingMuteBtn.textContent = backingAudio.muted
      ? '🔇 Backing: Muted'
      : '🔊 Backing: ON';
  });

  scrubSlider.addEventListener('input', () => {
    const targetMs = Number(scrubSlider.value);
    seekTo(targetMs);
  });

  speedSlider.addEventListener('input', () => {
    const mult = Number(speedSlider.value);
    engine.setSpeedMultiplier(mult);
    speedValueEl.textContent = `${Math.round(mult * 1000)} u/s`;
    updateHud(currentTimeMs);
  });

  // Live USB Guitar Input & Direct Hardware Monitoring Controls
  function syncDirectMonitorButton(): void {
    const isDirect = guitarInput.isDirectMonitoringMode();
    directMonitorBtn.textContent = isDirect
      ? '⚡ Direct Monitor: ON'
      : '🔊 SW Passthrough: ON';
    directMonitorBtn.classList.toggle('active-guitar', isDirect);
  }
  syncDirectMonitorButton();

  directMonitorBtn.addEventListener('click', () => {
    const nextDirect = !guitarInput.isDirectMonitoringMode();
    guitarInput.setDirectMonitoringMode(nextDirect);
    syncDirectMonitorButton();
  });

  guitarConnectBtn.addEventListener('click', async () => {
    if (guitarInput.isActive()) {
      guitarInput.stopPassthrough();
      guitarConnectBtn.textContent = '🎸 Connect Guitar Input';
      guitarConnectBtn.classList.remove('active-guitar');
      guitarPitchBadge.textContent = 'Off';
      guitarLevelFill.style.width = '0%';
      return;
    }

    try {
      const selectedDevice = inputDeviceSelect.value || undefined;
      await guitarInput.startPassthrough(selectedDevice);
      await refreshAudioDeviceOptions();
      guitarConnectBtn.textContent = '🟢 Guitar Input Active';
      guitarConnectBtn.classList.add('active-guitar');
    } catch (err) {
      console.error('Guitar input error:', err);
      guitarPitchBadge.textContent = 'Mic/USB Permission Denied';
    }
  });

  inputDeviceSelect.addEventListener('change', async () => {
    if (guitarInput.isActive()) {
      await guitarInput.startPassthrough(inputDeviceSelect.value);
    }
  });

  guitarVolumeSlider.addEventListener('input', () => {
    guitarInput.setVolume(Number(guitarVolumeSlider.value));
  });

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && e.target === document.body) {
      e.preventDefault();
      void setPlaying(!isPlaying);
    } else if (e.code === 'ArrowRight') {
      seekTo(currentTimeMs + 2000);
    } else if (e.code === 'ArrowLeft') {
      seekTo(currentTimeMs - 2000);
    }
  });

  // Main requestAnimationFrame loop synced to HTMLAudioElement.currentTime
  function animate(timestamp: number): void {
    if (isPlaying) {
      if (!backingAudio.paused && audioReady) {
        currentTimeMs = backingAudio.currentTime * 1000;
      } else if (lastFrameTimestamp !== null) {
        const deltaMs = timestamp - lastFrameTimestamp;
        currentTimeMs = Math.min(totalDurationMs, currentTimeMs + deltaMs);
      }

      engine.update(currentTimeMs);
      updateHud(currentTimeMs);

      if (currentTimeMs >= totalDurationMs) {
        void setPlaying(false);
      }
      lastFrameTimestamp = timestamp;
    }

    // Sample live guitar AnalyserNode tap for level & pitch telemetry
    if (guitarInput.isActive()) {
      const telemetry = guitarInput.samplePitchAndLevel();
      const levelPct = Math.min(100, Math.round(telemetry.rmsLevel * 450));
      guitarLevelFill.style.width = `${levelPct}%`;
      if (telemetry.noteName && telemetry.frequencyHz) {
        guitarPitchBadge.textContent = `${telemetry.noteName} (${telemetry.frequencyHz} Hz)`;
      } else {
        guitarPitchBadge.textContent = 'Listening…';
      }
    }

    requestAnimationFrame(animate);
  }

  requestAnimationFrame(animate);
}

void bootstrap();
