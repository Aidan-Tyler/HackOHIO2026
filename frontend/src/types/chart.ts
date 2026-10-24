export type TechniqueType =
  | 'normal'
  | 'hammer_on'
  | 'pull_off'
  | 'slide'
  | 'bend'
  | 'palm_mute'
  | 'harmonic';

export interface TechniqueFlags {
  hammer_on: boolean;
  pull_off: boolean;
  slide: boolean;
  bend: boolean;
}

export interface SongMetadata {
  title: string;
  artist: string;
  initialBpm: number;
  initial_bpm: number;
  track_index: number;
  track_name: string;
  string_count: number;
  tuning_midi: number[];
  total_measures: number;
  totalDurationMs: number;
  total_duration_ms: number;
}

export interface TempoChange {
  measure: number;
  beat: number;
  timeMs: number;
  time_ms: number;
  bpm: number;
}

export interface ChartMeasure {
  number: number;
  startMs: number;
  start_ms: number;
  endMs: number;
  end_ms: number;
  durationMs: number;
  duration_ms: number;
  bpm: number;
  timeSignature: string;
  time_signature: string;
}

export interface ChartNote {
  timeMs: number;
  time_ms: number;
  durationMs: number;
  duration_ms: number;
  /** Guitar string number: 1 (High E) to 6 (Low E) */
  string: number;
  /** Fret number: 0 (open) to 24 */
  fret: number;
  /** 0-indexed string lane: string 1 -> 0 ... string 5 (A) -> 4 ... string 6 -> 5 */
  lane: number;
  midi_pitch: number;
  measure: number;
  beat: number;
  velocity: number;
  hammer_on: boolean;
  pull_off: boolean;
  slide: boolean;
  bend: boolean;
  techniques: TechniqueFlags;
  technique: TechniqueType;
}

export interface ChartData {
  metadata: SongMetadata;
  song_metadata: SongMetadata;
  tempoMap: TempoChange[];
  tempo_changes: TempoChange[];
  measures: ChartMeasure[];
  notes: ChartNote[];
}

/**
 * Normalizes a parsed JSON chart object so both camelCase (`timeMs`, `metadata`, `tempoMap`)
 * and snake_case (`time_ms`, `song_metadata`, `tempo_changes`) fields are always populated.
 */
export function normalizeChart(raw: Record<string, any>): ChartData {
  const rawMeta = raw.metadata ?? raw.song_metadata ?? {};
  const initialBpm = Number(rawMeta.initialBpm ?? rawMeta.initial_bpm ?? 120);
  const totalDurationMs = Number(
    rawMeta.totalDurationMs ?? rawMeta.total_duration_ms ?? 0,
  );

  const metadata: SongMetadata = {
    title: String(rawMeta.title ?? 'Untitled'),
    artist: String(rawMeta.artist ?? 'Unknown Artist'),
    initialBpm,
    initial_bpm: initialBpm,
    track_index: Number(rawMeta.track_index ?? 0),
    track_name: String(rawMeta.track_name ?? 'Guitar'),
    string_count: Number(rawMeta.string_count ?? 6),
    tuning_midi: Array.isArray(rawMeta.tuning_midi)
      ? rawMeta.tuning_midi.map(Number)
      : [64, 59, 55, 50, 45, 40],
    total_measures: Number(
      rawMeta.total_measures ??
        (Array.isArray(raw.measures) ? raw.measures.length : 0),
    ),
    totalDurationMs,
    total_duration_ms: totalDurationMs,
  };

  const rawTempo = Array.isArray(raw.tempoMap)
    ? raw.tempoMap
    : Array.isArray(raw.tempo_changes)
      ? raw.tempo_changes
      : [];

  const tempoMap: TempoChange[] = rawTempo.map((t: Record<string, any>) => {
    const timeMs = Number(t.timeMs ?? t.time_ms ?? 0);
    return {
      measure: Number(t.measure ?? 1),
      beat: Number(t.beat ?? 1),
      timeMs,
      time_ms: timeMs,
      bpm: Number(t.bpm ?? initialBpm),
    };
  });

  const rawMeasures = Array.isArray(raw.measures) ? raw.measures : [];
  const measures: ChartMeasure[] = rawMeasures.map(
    (m: Record<string, any>, idx: number) => {
      const startMs = Number(m.startMs ?? m.start_ms ?? 0);
      const endMs = Number(m.endMs ?? m.end_ms ?? startMs);
      const durationMs = Number(m.durationMs ?? m.duration_ms ?? endMs - startMs);
      const timeSignature = String(
        m.timeSignature ?? m.time_signature ?? '4/4',
      );
      return {
        number: Number(m.number ?? idx + 1),
        startMs,
        start_ms: startMs,
        endMs,
        end_ms: endMs,
        durationMs,
        duration_ms: durationMs,
        bpm: Number(m.bpm ?? initialBpm),
        timeSignature,
        time_signature: timeSignature,
      };
    },
  );

  const rawNotes = Array.isArray(raw.notes) ? raw.notes : [];
  const notes: ChartNote[] = rawNotes.map((n: Record<string, any>) => {
    const timeMs = Number(n.timeMs ?? n.time_ms ?? 0);
    const durationMs = Number(n.durationMs ?? n.duration_ms ?? 250);
    const stringNum = Number(n.string ?? 6);
    const fret = Number(n.fret ?? 0);
    const hammerOn = Boolean(n.hammer_on ?? n.techniques?.hammer_on ?? false);
    const pullOff = Boolean(n.pull_off ?? n.techniques?.pull_off ?? false);
    const slide = Boolean(n.slide ?? n.techniques?.slide ?? false);
    const bend = Boolean(n.bend ?? n.techniques?.bend ?? false);

    return {
      timeMs,
      time_ms: timeMs,
      durationMs,
      duration_ms: durationMs,
      string: stringNum,
      fret,
      lane: Number(n.lane ?? stringNum - 1),
      midi_pitch: Number(n.midi_pitch ?? 40 + fret),
      measure: Number(n.measure ?? 1),
      beat: Number(n.beat ?? 1),
      velocity: Number(n.velocity ?? 0.75),
      hammer_on: hammerOn,
      pull_off: pullOff,
      slide,
      bend,
      techniques: {
        hammer_on: hammerOn,
        pull_off: pullOff,
        slide,
        bend,
      },
      technique: (n.technique as TechniqueType) ?? 'normal',
    };
  });

  return {
    metadata,
    song_metadata: metadata,
    tempoMap,
    tempo_changes: tempoMap,
    measures,
    notes,
  };
}
