export const SONG_LIBRARY_URL = '/songs.json';

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
}

export async function fetchSongLibrary(): Promise<SongEntry[]> {
  const response = await fetch(SONG_LIBRARY_URL);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching ${SONG_LIBRARY_URL}`);
  }
  const raw = (await response.json()) as { songs?: Record<string, any>[] };
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
  }));
}
