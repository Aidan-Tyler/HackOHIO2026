import { GuitarAudioInput } from './audio/guitar_input';
import {
  AudioClock,
  SYNTH_LEAD_IN_MS,
  calibrateChartToAudio,
} from './engine/clock';
import { HighwayEngine, STRING_RAILS } from './engine/highway';
import defaultSevenNationArmyRaw from '../public/charts/white-stripes-seven_nation_army.json';
import {
  normalizeChart,
  type ChartData,
  type ChartMeasure,
  type ChartNote,
} from './types/chart';
import { MainMenu } from './menu/main_menu';
import {
  fetchImportedSongs,
  fetchSongLibrary,
  type SongEntry,
} from './menu/song_library';

const DEFAULT_SEVEN_NATION_ARMY: SongEntry = {
  id: 'white-stripes-seven_nation_army',
  title: 'Seven Nation Army',
  artist: 'The White Stripes',
  chartUrl: '/charts/white-stripes-seven_nation_army.json',
  audioUrl: '/audio/seven_nation_army_backing.mp3',
  durationMs: 228212,
  bpm: 125,
  tuning: 'Open A',
  difficulty: 1,
  offsetMs: 3108,
  sections: [
    { label: 'Riff', timeMs: 0 },
    { label: 'Chorus 1', timeMs: 50184 },
    { label: 'Guitar Solo', timeMs: 120939 },
  ],
};

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
  const legendContainer = document.getElementById('string-legend')!;

  // Retro Arcade Scoring & Hit/Miss Feedback HUD Elements
  const missVignetteEl = document.getElementById('miss-vignette')!;
  const arcadeScoreEl = document.getElementById('arcade-score')!;
  const arcadeMultiplierEl = document.getElementById('arcade-multiplier')!;
  const arcadeRatingEl = document.getElementById('arcade-rating')!;
  const arcadeStreakEl = document.getElementById('arcade-streak')!;
  const arcadeAccuracyEl = document.getElementById('arcade-accuracy')!;

  // Modals: Pre-Song Guitar Setup Screen & Pause Menu
  const guitarSetupScreen = document.getElementById('guitar-setup-screen')!;
  const setupSongSubtitle = document.getElementById('setup-song-subtitle')!;
  const setupBackBtn = document.getElementById(
    'setup-back-btn',
  ) as HTMLButtonElement;
  const startSongBtn = document.getElementById(
    'start-song-btn',
  ) as HTMLButtonElement;
  const tunerStringsRow = document.getElementById('tuner-strings-row')!;

  const openPauseBtn = document.getElementById(
    'open-pause-btn',
  ) as HTMLButtonElement;
  const pauseMenuEl = document.getElementById('pause-menu')!;
  const pauseSongSubtitle = document.getElementById('pause-song-subtitle')!;
  const resumeBtn = document.getElementById('resume-btn') as HTMLButtonElement;
  const pauseGuitarSetupBtn = document.getElementById(
    'pause-guitar-setup-btn',
  ) as HTMLButtonElement;

  // Pause Menu Controls
  const playPauseBtn = document.getElementById(
    'play-pause-btn',
  ) as HTMLButtonElement;
  const restartBtn = document.getElementById(
    'restart-btn',
  ) as HTMLButtonElement;
  const menuBtn = document.getElementById('menu-btn') as HTMLButtonElement;
  const syncEarlierBtn = document.getElementById(
    'sync-earlier-btn',
  ) as HTMLButtonElement;
  const syncLaterBtn = document.getElementById(
    'sync-later-btn',
  ) as HTMLButtonElement;
  const syncValueEl = document.getElementById('sync-value')!;
  const sectionJumpGroup = document.getElementById('section-jump-group')!;
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
  const songRateSlider = document.getElementById(
    'song-rate-slider',
  ) as HTMLInputElement;
  const songRateValueEl = document.getElementById('song-rate-value')!;

  // USB Guitar Input Passthrough Controls (inside Pre-Song Guitar Setup Screen)
  const inputDeviceSelect = document.getElementById(
    'audio-input-select',
  ) as HTMLSelectElement;
  const guitarConnectBtn = document.getElementById(
    'guitar-connect-btn',
  ) as HTMLButtonElement;
  const directMonitorBtn = document.getElementById(
    'direct-monitor-btn',
  ) as HTMLButtonElement | null;
  const guitarVolumeSlider = document.getElementById(
    'guitar-volume-slider',
  ) as HTMLInputElement;
  const guitarPitchBadge = document.getElementById('guitar-pitch-badge')!;
  const guitarLevelFill = document.getElementById('guitar-level-fill')!;

  // Render string rail legend badges (String 6 Low E Red at top down to String 1 High E Purple)
  legendContainer.innerHTML = STRING_RAILS.map(
    (rail) => `
      <div class="legend-chip" style="--rail-color: ${rail.colorCss}">
        <span class="dot"></span>
        <span>${rail.label} (${rail.noteName})</span>
      </div>
    `,
  ).join('');

  // Render 6-string reference pills on the Guitar Input Check screen
  tunerStringsRow.innerHTML = STRING_RAILS.map(
    (rail) => `
      <div class="tuner-string-pill" data-string-note="${rail.noteName}" style="--rail-color: ${rail.colorCss}">
        <div>S${rail.stringNumber}</div>
        <div style="color:${rail.colorCss}">${rail.noteName}</div>
      </div>
    `,
  ).join('');

  let ratingFadeTimer: number | null = null;
  let vignetteFadeTimer: number | null = null;

  function showRatingBanner(
    rating: 'PERFECT' | 'GREAT' | 'GOOD' | 'MISS',
  ): void {
    arcadeRatingEl.textContent = rating;
    arcadeRatingEl.setAttribute('data-rating', rating);
    arcadeRatingEl.classList.remove('pop');
    // Force reflow for re-triggering pop animation
    void arcadeRatingEl.offsetWidth;
    arcadeRatingEl.classList.add('pop');

    if (ratingFadeTimer !== null) {
      window.clearTimeout(ratingFadeTimer);
    }
    ratingFadeTimer = window.setTimeout(() => {
      arcadeRatingEl.classList.remove('pop');
    }, 650);
  }

  function flashMissVignette(): void {
    missVignetteEl.classList.add('flash');
    if (vignetteFadeTimer !== null) {
      window.clearTimeout(vignetteFadeTimer);
    }
    vignetteFadeTimer = window.setTimeout(() => {
      missVignetteEl.classList.remove('flash');
    }, 180);
  }

  function renderArcadeScoreHud(): void {
    const state = engine.getScoreState();
    arcadeScoreEl.textContent = String(state.score).padStart(6, '0');
    arcadeMultiplierEl.textContent = `${state.multiplier}X`;
    arcadeMultiplierEl.setAttribute('data-mult', String(state.multiplier));
    arcadeStreakEl.textContent =
      state.maxStreak > 0
        ? `STREAK: ${state.streak} · BEST: ${state.maxStreak}`
        : `STREAK: ${state.streak}`;
    arcadeAccuracyEl.textContent = `${state.accuracy.toFixed(1)}%`;
    arcadeAccuracyEl.style.color =
      state.accuracy >= 90
        ? '#4ade80'
        : state.accuracy >= 75
          ? '#38bdf8'
          : state.accuracy >= 50
            ? '#facc15'
            : '#f87171';
  }

  const engine = new HighwayEngine(
    viewportEl,
    {},
    {
      onNoteHit: (result) => {
        if (result.rating) {
          showRatingBanner(result.rating);
        }
        renderArcadeScoreHud();
      },
      onNoteMiss: () => {
        showRatingBanner('MISS');
        flashMissVignette();
        renderArcadeScoreHud();
      },
    },
  );
  const guitarInput = new GuitarAudioInput();
  guitarInput.setDirectMonitoring(true);

  let chart: ChartData | null = null;
  let currentSong: SongEntry | null = null;
  let totalDurationMs = 228500;
  let menuRef: MainMenu | null = null;
  let baseAutoOffsetMs = -3108;

  function isSetupOpen(): boolean {
    return !guitarSetupScreen.hidden;
  }

  function isPauseMenuOpen(): boolean {
    return !pauseMenuEl.hidden;
  }

  function syncNudgeStorageKey(): string | null {
    return currentSong ? `audio-nudge-ms:${currentSong.id}` : null;
  }

  function loadSavedNudgeMs(): number {
    const key = syncNudgeStorageKey();
    try {
      return key ? Number(localStorage.getItem(key)) || 0 : 0;
    } catch {
      return 0;
    }
  }

  // Hardware-synced Master Clock (HTMLAudioElement)
  const clock = new AudioClock({
    initialOffsetMs: baseAutoOffsetMs,
    shouldIgnoreHotkeys: () => Boolean(menuRef?.isOpen()) || isSetupOpen(),
    onPlayStateChange: (playing) => {
      playPauseBtn.textContent = playing ? '⏸ Pause' : '▶ Play';
      playPauseBtn.classList.toggle('active', playing);
    },
    onOffsetChange: (globalOffsetMs) => {
      const userNudgeMs = Math.round(globalOffsetMs - baseAutoOffsetMs);
      syncValueEl.textContent = `${userNudgeMs > 0 ? '+' : ''}${userNudgeMs} ms (${globalOffsetMs} ms)`;
      const key = syncNudgeStorageKey();
      try {
        if (key) localStorage.setItem(key, String(userNudgeMs));
      } catch {
        // Ignore storage errors
      }
      const currentAudioTimeMs = clock.getCurrentAudioTimeMs();
      engine.update(currentAudioTimeMs);
      updateHud(currentAudioTimeMs);
    },
  });

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

  function updateHud(currentAudioTimeMs: number): void {
    const clampedMs = Math.max(0, currentAudioTimeMs);
    timeCurrentEl.textContent = formatTimeMs(clampedMs);
    scrubSlider.value = String(Math.round(clampedMs));

    const handRange = engine.getActiveHandPosition();
    handPosEl.textContent = `Frets ${handRange.startFret}–${handRange.endFret} / ${engine.getMaxFret()}`;

    if (!chart) return;

    const currentMeasure = findCurrentMeasure(chart.measures, clampedMs);
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
      .filter((n) => n.timeMs >= currentAudioTimeMs - 80)
      .slice(0, 7);
    if (upcoming.length > 0) {
      upcomingRiffEl.textContent = upcoming.map((n) => `${n.fret}`).join(' - ');
    } else {
      upcomingRiffEl.textContent = 'End of chart';
    }
  }

  function resetSongToStart(): void {
    clock.resetToTrackStart();
    engine.resetScoring();
    arcadeRatingEl.classList.remove('pop');
    renderArcadeScoreHud();
    const currentAudioTimeMs = clock.getCurrentAudioTimeMs();
    engine.update(currentAudioTimeMs);
    updateHud(currentAudioTimeMs);
  }

  function seekTo(targetMs: number): void {
    const clampedTarget = Math.max(0, Math.min(totalDurationMs, targetMs));
    clock.seekToMs(clampedTarget);
    const currentAudioTimeMs = clock.getCurrentAudioTimeMs();
    engine.syncScoringToSeek(currentAudioTimeMs);
    renderArcadeScoreHud();
    engine.update(currentAudioTimeMs);
    updateHud(currentAudioTimeMs);
  }

  function renderSectionButtons(song: SongEntry): void {
    sectionJumpGroup.innerHTML = '';
    for (const section of song.sections) {
      if (section.timeMs <= 0) continue;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = `⚡ ${formatTimeMs(section.timeMs).slice(0, -2)} (${section.label})`;
      btn.addEventListener('click', () => {
        seekTo(section.timeMs);
      });
      sectionJumpGroup.appendChild(btn);
    }
  }

  // Modal Navigation Helpers
  function showGuitarSetupScreen(): void {
    clock.pause();
    pauseMenuEl.hidden = true;
    guitarSetupScreen.hidden = false;
    document.body.classList.add('setup-open');
    if (currentSong) {
      setupSongSubtitle.textContent = `Ready to play “${currentSong.title}” by ${currentSong.artist}. Test your guitar signal below or click Start Song.`;
    }
    startSongBtn.focus();
  }

  function hideGuitarSetupScreen(): void {
    guitarSetupScreen.hidden = true;
    document.body.classList.remove('setup-open');
  }

  function openPauseMenu(): void {
    clock.pause();
    pauseMenuEl.hidden = false;
    if (currentSong) {
      pauseSongSubtitle.textContent = `${currentSong.title} · ${currentSong.artist}`;
    }
    updateHud(clock.getCurrentAudioTimeMs());
    resumeBtn.focus();
  }

  function closePauseMenu(autoResume = false): void {
    pauseMenuEl.hidden = true;
    if (autoResume) {
      void clock.play();
    }
  }

  // Fetch a song's chart JSON + backing track and load it onto the highway
  async function loadSong(
    song: SongEntry,
    showSetupBeforeStart = true,
  ): Promise<void> {
    clock.pause();

    let rawJson: Record<string, unknown> | null = null;
    try {
      const response = await fetch(song.chartUrl);
      const contentType = response.headers.get('content-type') || '';
      if (response.ok && !contentType.includes('text/html')) {
        const text = await response.text();
        if (text.trim().startsWith('{')) {
          rawJson = JSON.parse(text) as Record<string, unknown>;
        }
      }
    } catch {
      // Fetch failed or network blocked; try bundled fallback
    }

    if (!rawJson) {
      if (
        song.id === 'white-stripes-seven_nation_army' ||
        song.chartUrl.includes('seven_nation_army')
      ) {
        rawJson = defaultSevenNationArmyRaw as unknown as Record<
          string,
          unknown
        >;
      } else {
        throw new Error(
          `Chart could not be loaded from "${song.chartUrl}". If this is an imported tab, make sure the Python backend is running (\`npm run backend\`).`,
        );
      }
    }

    chart = normalizeChart(rawJson);
    currentSong = song;
    totalDurationMs = chart.metadata.totalDurationMs || song.durationMs;

    const loadedAudioUrl = await clock.loadTrack(
      song.audioUrl,
      chart,
      totalDurationMs,
    );

    const firstTabNoteMs = chart.notes[0]?.timeMs ?? 0;
    if (clock.isUsingSynthFallback()) {
      baseAutoOffsetMs = -SYNTH_LEAD_IN_MS;
    } else if (loadedAudioUrl) {
      const { firstHitMs } = await calibrateChartToAudio(
        loadedAudioUrl,
        chart,
        song.offsetMs,
      );
      totalDurationMs = chart.metadata.totalDurationMs || song.durationMs;
      baseAutoOffsetMs =
        firstHitMs > 0 ? Math.round(firstTabNoteMs - firstHitMs) : 0;
    } else if (song.offsetMs && song.offsetMs !== 0) {
      baseAutoOffsetMs = -song.offsetMs;
    } else {
      baseAutoOffsetMs = 0;
    }

    clock.setGlobalOffsetMs(baseAutoOffsetMs + loadSavedNudgeMs());

    scrubSlider.max = String(Math.ceil(totalDurationMs));
    timeTotalEl.textContent = formatTimeMs(totalDurationMs);
    titleEl.textContent = chart.metadata.title;
    engine.loadChart(chart);
    const synthLabel = clock.isUsingSynthFallback()
      ? ' · Web Audio Synth/Metronome'
      : '';
    artistEl.textContent = `${chart.metadata.artist} · ${chart.notes.length} Notes · ${engine.getMaxFret()} Frets${synthLabel}`;
    renderSectionButtons(song);
    speedValueEl.textContent = `${engine.getSpeed().toFixed(1)} u/s`;
    resetSongToStart();

    if (showSetupBeforeStart) {
      showGuitarSetupScreen();
    }
  }

  const menu = new MainMenu({
    onPlay: async (song) => {
      await loadSong(song, true);
    },
  });
  menuRef = menu;

  function openMainMenu(): void {
    clock.pause();
    hideGuitarSetupScreen();
    pauseMenuEl.hidden = true;
    menu.show();
  }

  // Preload Seven Nation Army chart & audio onto the 3D highway in background
  void loadSong(DEFAULT_SEVEN_NATION_ARMY, false).catch((err) => {
    console.error('Failed to preload default chart:', err);
  });

  menu.show();
  try {
    const [bundled, imported] = await Promise.all([
      fetchSongLibrary(),
      fetchImportedSongs(),
    ]);
    menu.setSongs([...bundled, ...imported]);
  } catch (err) {
    console.error('Failed to load song library:', err);
    menu.setSongs([DEFAULT_SEVEN_NATION_ARMY]);
    menu.setStatus(`Loaded offline setlist`);
  }

  // Pre-Song Guitar Setup Screen Actions
  startSongBtn.addEventListener('click', () => {
    hideGuitarSetupScreen();
    void clock.play();
  });

  setupBackBtn.addEventListener('click', () => {
    openMainMenu();
  });

  // Pause Menu Actions
  openPauseBtn.addEventListener('click', () => {
    if (isPauseMenuOpen()) {
      closePauseMenu(false);
    } else {
      openPauseMenu();
    }
  });

  resumeBtn.addEventListener('click', () => {
    closePauseMenu(true);
  });

  pauseGuitarSetupBtn.addEventListener('click', () => {
    showGuitarSetupScreen();
  });

  playPauseBtn.addEventListener('click', () => {
    if (!chart) return;
    if (clock.getCurrentAudioTimeMs() >= totalDurationMs) {
      resetSongToStart();
    }
    void clock.togglePlayPause();
  });

  restartBtn.addEventListener('click', () => {
    resetSongToStart();
    closePauseMenu(true);
  });

  menuBtn.addEventListener('click', openMainMenu);

  // Hotkeys [ and ] and UI buttons nudge globalOffsetMs by ±10ms live
  const SYNC_STEP_MS = 10;
  syncEarlierBtn.addEventListener('click', () =>
    clock.nudgeGlobalOffsetMs(-SYNC_STEP_MS),
  );
  syncLaterBtn.addEventListener('click', () =>
    clock.nudgeGlobalOffsetMs(SYNC_STEP_MS),
  );

  backingMuteBtn.addEventListener('click', () => {
    clock.setMuted(!clock.isMuted());
    backingMuteBtn.textContent = clock.isMuted()
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
    speedValueEl.textContent = `${Math.round(engine.getSpeed())} u/s`;
    updateHud(clock.getCurrentAudioTimeMs());
  });

  songRateSlider.addEventListener('input', () => {
    const rate = Number(songRateSlider.value);
    clock.setPlaybackRate(rate);
    songRateValueEl.textContent = `${Math.round(rate * 100)}%`;
  });

  // Live USB Guitar Input & Low-Latency Speaker Passthrough Controls
  guitarConnectBtn.addEventListener('click', async () => {
    if (guitarInput.isActive()) {
      guitarInput.stopPassthrough();
      guitarConnectBtn.textContent = '🎸 Enable Guitar Passthrough';
      guitarConnectBtn.classList.remove('active-guitar');
      guitarPitchBadge.textContent = 'Off';
      guitarLevelFill.style.width = '0%';
      return;
    }

    try {
      const selectedDevice = inputDeviceSelect.value || undefined;
      await guitarInput.startPassthrough(selectedDevice);
      await refreshAudioDeviceOptions();
      guitarConnectBtn.textContent = '🟢 Guitar Live (Passthrough ON)';
      guitarConnectBtn.classList.add('active-guitar');
    } catch (err) {
      console.error('Guitar input error:', err);
      guitarPitchBadge.textContent = 'Mic/USB Permission Denied';
    }
  });

  if (directMonitorBtn) {
    directMonitorBtn.addEventListener('click', () => {
      const enabled = guitarInput.toggleDirectMonitoring();
      directMonitorBtn.textContent = enabled
        ? '🔊 Direct Monitor: ON'
        : '🔇 Direct Monitor: OFF';
      directMonitorBtn.classList.toggle('active-guitar', enabled);
    });
  }

  inputDeviceSelect.addEventListener('change', async () => {
    if (guitarInput.isActive()) {
      await guitarInput.startPassthrough(inputDeviceSelect.value);
    }
  });

  guitarVolumeSlider.addEventListener('input', () => {
    guitarInput.setVolume(Number(guitarVolumeSlider.value));
  });

  window.addEventListener('keydown', (e) => {
    if (menu.isOpen()) return;

    if (isSetupOpen()) {
      if (e.code === 'Escape') {
        openMainMenu();
      } else if (e.code === 'Enter') {
        e.preventDefault();
        hideGuitarSetupScreen();
        void clock.play();
      }
      return;
    }

    if (e.code === 'Escape') {
      e.preventDefault();
      if (isPauseMenuOpen()) {
        closePauseMenu(false);
      } else {
        openPauseMenu();
      }
    } else if (e.code === 'ArrowRight') {
      seekTo(clock.getCurrentAudioTimeMs() + 2000);
    } else if (e.code === 'ArrowLeft') {
      seekTo(clock.getCurrentAudioTimeMs() - 2000);
    } else if (
      !isPauseMenuOpen() &&
      (e.code.startsWith('Digit') || e.code.startsWith('Numpad'))
    ) {
      const digit = Number(e.code.replace('Digit', '').replace('Numpad', ''));
      if (digit >= 1 && digit <= 6) {
        e.preventDefault();
        const nowMs = clock.getCurrentAudioTimeMs();
        engine.triggerHit(digit, undefined, nowMs);
        updateHud(nowMs);
      }
    }
  });

  // Main render loop strictly locked to HTMLAudioElement.currentTime via AudioClock
  // NEVER uses requestAnimationFrame delta accumulation or performance.now()
  function animate(): void {
    const currentAudioTimeMs = clock.getCurrentAudioTimeMs();
    clock.updateDebugHud();
    engine.update(currentAudioTimeMs);

    if (clock.isPlaying()) {
      updateHud(currentAudioTimeMs);
      if (currentAudioTimeMs >= totalDurationMs) {
        clock.pause();
      }
    }

    // Sample live guitar AnalyserNode tap for level & pitch telemetry + live note hit evaluation
    if (guitarInput.isActive()) {
      const telemetry = guitarInput.samplePitchAndLevel();
      const levelPct = Math.min(100, Math.round(telemetry.rmsLevel * 450));
      guitarLevelFill.style.width = `${levelPct}%`;
      if (telemetry.noteName && telemetry.frequencyHz) {
        guitarPitchBadge.textContent = `${telemetry.noteName} (${telemetry.frequencyHz} Hz)`;
        if (
          telemetry.midiNote !== null &&
          clock.isPlaying() &&
          !isPauseMenuOpen() &&
          !isSetupOpen()
        ) {
          engine.triggerPitchHit(telemetry.midiNote, currentAudioTimeMs);
        }
      } else {
        guitarPitchBadge.textContent = 'Listening…';
      }
    }

    requestAnimationFrame(animate);
  }

  requestAnimationFrame(animate);
}

void bootstrap();
