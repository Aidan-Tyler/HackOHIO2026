export const SONG_LIBRARY_URL = '/songs.json';
/** Tabs previously imported from GProTab, served by the FastAPI backend */
export const IMPORTED_SONGS_URL = '/api/songs';

export interface SongSection {
  label: string;
  timeMs: number;
}

export interface SongEntry {
  id: string;
  title: string;
  artist: string;
  chartUrl: string;
  audioUrl: string;
  durationMs: number;
  bpm: number;
  tuning: string;
  /** 1 (easy) to 5 (expert) */
  difficulty: number;
  /** Jump points shown as quick-seek buttons in the playback bar */
  sections: SongSection[];
  /** Backing-track sync: audio_time_ms = chart_time_ms + offsetMs */
  offsetMs: number;
  /** Imported songs only: state of the background YouTube backing-track job */
  audioStatus?: AudioStatus;
  audioError?: string | null;
  guitarRemoved?: boolean;
}

export type AudioStatus = 'none' | 'pending' | 'ready' | 'failed';

export async function fetchSongLibrary(): Promise<SongEntry[]> {
  const response = await fetch(SONG_LIBRARY_URL);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching ${SONG_LIBRARY_URL}`);
  }
  return normalizeSongs(await response.json());
}

/** Returns [] when the backend isn't running, so the bundled songs still work offline */
export async function fetchImportedSongs(): Promise<SongEntry[]> {
  try {
    const response = await fetch(IMPORTED_SONGS_URL);
    if (!response.ok) return [];
    return normalizeSongs(await response.json());
  } catch {
    return [];
  }
}

function normalizeSongs(raw: { songs?: Record<string, any>[] }): SongEntry[] {
  const songs = Array.isArray(raw.songs) ? raw.songs : [];

  return songs.map((s) => ({
    id: String(s.id),
    title: String(s.title ?? 'Untitled'),
    artist: String(s.artist ?? 'Unknown Artist'),
    chartUrl: String(s.chartUrl),
    audioUrl: String(s.audioUrl ?? ''),
    durationMs: Number(s.durationMs ?? 0),
    bpm: Number(s.bpm ?? 120),
    tuning: String(s.tuning ?? 'Standard'),
    difficulty: Math.max(1, Math.min(5, Number(s.difficulty ?? 1))),
    sections: Array.isArray(s.sections)
      ? s.sections.map((sec: Record<string, any>) => ({
          label: String(sec.label ?? 'Section'),
          timeMs: Number(sec.timeMs ?? 0),
        }))
      : [],
    offsetMs: Number(s.offsetMs ?? 0),
    audioStatus: s.audioStatus as AudioStatus | undefined,
    audioError: s.audioError ?? null,
    guitarRemoved: Boolean(s.guitarRemoved),
  }));
}
