/**
 * Coordinate projection math for the 3D Yousician-style Fretboard & Highway.
 * Decoupled from Three.js rendering per AGENTS.md guardrails.
 */

import type { ChartNote } from '../types/chart';

export interface HighwayConfig {
  /** Total number of frets on the pinned target fretboard (0 through 15) */
  maxFret: number;
  /** World X position of Fret 0 (the nut) */
  nutX: number;
  /** Horizontal spacing between adjacent fret wires in world X units */
  fretSpacingX: number;
  /** Vertical spacing between adjacent horizontal strings (1 down to 6) at Z=0 */
  stringSpacingY: number;
  /** World Y position of the lowest rail (String 6 / Low E) */
  baseStringY: number;
  /** Highway scroll speed in world units per second */
  speed: number;
  /** Backward-compatible speed multiplier (speed / 1000) */
  speedMultiplier: number;
  /** Z-coordinate of the pinned fretboard target bar */
  hitBarZ: number;
  /** Far clipping distance along -Z for the note highway */
  highwayLengthDist: number;
  /** Distance past Z=0 (+Z) before notes despawn */
  despawnDist: number;
  /** Hit window tolerance in milliseconds around Z=0 */
  hitWindowMs: number;
}

export const DEFAULT_HIGHWAY_CONFIG: HighwayConfig = {
  maxFret: 15,
  nutX: 0.25,
  fretSpacingX: 0.65,
  stringSpacingY: 0.21,
  baseStringY: 0.42,
  speed: 12.0,
  speedMultiplier: 0.012,
  hitBarZ: 0,
  highwayLengthDist: 48,
  despawnDist: 2.2,
  hitWindowMs: 85,
};

export interface StringRailSpec {
  /** Guitar string number: 6 (Low E) down to 1 (High E) */
  stringNumber: number;
  /** 0-indexed lane in chart JSON: stringNumber - 1 */
  chartLane: number;
  /** Top-to-bottom row index on the pinned fretboard: 0 (String 6 / Low E) to 5 (String 1 / High E) */
  rowIndex: number;
  /** Display label for the string */
  label: string;
  /** Short note name of the string */
  noteName: string;
  /** Hex color for the string and note capsules (Yousician palette) */
  colorHex: number;
  /** CSS hex string for UI badges and Canvas2D fret labels */
  colorCss: string;
  /** Relative gauge thickness of the string */
  radius: number;
}

/**
 * Six horizontal guitar strings ordered from top (String 6 / Low E, Red)
 * down to bottom (String 1 / High E, Purple).
 */
export const STRING_RAILS: readonly StringRailSpec[] = [
  {
    stringNumber: 6,
    chartLane: 5,
    rowIndex: 0,
    label: '6 · Low E',
    noteName: 'E2',
    colorHex: 0xf44336,
    colorCss: '#f44336',
    radius: 0.036,
  },
  {
    stringNumber: 5,
    chartLane: 4,
    rowIndex: 1,
    label: '5 · A',
    noteName: 'A2',
    colorHex: 0x4caf50,
    colorCss: '#4caf50',
    radius: 0.032,
  },
  {
    stringNumber: 4,
    chartLane: 3,
    rowIndex: 2,
    label: '4 · D',
    noteName: 'D3',
    colorHex: 0xff9800,
    colorCss: '#ff9800',
    radius: 0.028,
  },
  {
    stringNumber: 3,
    chartLane: 2,
    rowIndex: 3,
    label: '3 · G',
    noteName: 'G3',
    colorHex: 0xffeb3b,
    colorCss: '#ffeb3b',
    radius: 0.024,
  },
  {
    stringNumber: 2,
    chartLane: 1,
    rowIndex: 4,
    label: '2 · B',
    noteName: 'B3',
    colorHex: 0x2196f3,
    colorCss: '#2196f3',
    radius: 0.02,
  },
  {
    stringNumber: 1,
    chartLane: 0,
    rowIndex: 5,
    label: '1 · High E',
    noteName: 'E4',
    colorHex: 0x9c27b0,
    colorCss: '#9c27b0',
    radius: 0.017,
  },
] as const;

export interface ChordCluster {
  timeMs: number;
  durationMs: number;
  notes: ChartNote[];
  chordName: string;
  minFret: number;
  maxFret: number;
  minString: number;
  maxString: number;
}

/**
 * Normalizes speed input so both `speed` (e.g. 12 units/sec) and `speedMultiplier` (e.g. 0.012 units/ms) work seamlessly.
 */
export function normalizeSpeedUnitsPerSec(speedOrMultiplier: number): number {
  const abs = Math.abs(speedOrMultiplier);
  return abs < 0.5 ? abs * 1000 : abs;
}

/**
 * Projects a note timestamp (in ms) onto world Z along the -Z highway:
 * Z = (note.timeMs - currentAudioTimeMs) * (speed / 1000) directed into -Z.
 */
export function projectTimeToZ(
  noteTimeMs: number,
  currentAudioTimeMs: number,
  speed: number = DEFAULT_HIGHWAY_CONFIG.speed,
): number {
  const effectiveSpeed = normalizeSpeedUnitsPerSec(speed);
  return -((noteTimeMs - currentAudioTimeMs) * (effectiveSpeed / 1000));
}

/**
 * Converts a duration in milliseconds to world Z length along the highway.
 */
export function durationToWorldZ(
  durationMs: number,
  speed: number = DEFAULT_HIGHWAY_CONFIG.speed,
): number {
  const effectiveSpeed = normalizeSpeedUnitsPerSec(speed);
  return Math.max(0, durationMs * (effectiveSpeed / 1000));
}

/**
 * Maps a fret wire index (0 = nut, 1..15 = metallic fret wires) to its exact world X position.
 */
export function fretWireToWorldX(
  wireIndex: number,
  config: HighwayConfig = DEFAULT_HIGHWAY_CONFIG,
): number {
  const clamped = Math.max(0, Math.min(config.maxFret, wireIndex));
  return config.nutX + clamped * config.fretSpacingX;
}

/**
 * Maps a fret number (0..15) to its horizontal world X coordinate on the fretboard.
 * - Fret 0: open string indicator at the nut.
 * - Frets 1..15: centered between fret wire (f - 1) and fret wire f.
 */
export function fretToWorldX(
  fretNumber: number,
  config: HighwayConfig = DEFAULT_HIGHWAY_CONFIG,
): number {
  const clamped = Math.max(0, Math.min(config.maxFret, fretNumber));
  if (clamped === 0) {
    return config.nutX - config.fretSpacingX * 0.32;
  }
  const leftWireX = fretWireToWorldX(clamped - 1, config);
  const rightWireX = fretWireToWorldX(clamped, config);
  return (leftWireX + rightWireX) / 2;
}

/**
 * Maps a guitar string number (6 = Low E Red at top .. 1 = High E Purple at bottom)
 * to its vertical world Y coordinate on the pinned fretboard target bar at Z=0.
 */
export function stringToWorldY(
  stringNumber: number,
  config: HighwayConfig = DEFAULT_HIGHWAY_CONFIG,
): number {
  const clamped = Math.max(1, Math.min(6, Math.round(stringNumber)));
  return config.baseStringY + (clamped - 1) * config.stringSpacingY;
}

/**
 * Returns the full StringRailSpec for a given guitar string (1–6).
 */
export function getStringRailSpec(stringNumber: number): StringRailSpec {
  const clamped = Math.max(1, Math.min(6, Math.round(stringNumber)));
  return STRING_RAILS[6 - clamped];
}

/**
 * Checks whether a world Z position is within the visible highway frustum window
 * (from -highwayLengthDist up to +despawnDist).
 */
export function isZVisible(
  worldZ: number,
  config: HighwayConfig = DEFAULT_HIGHWAY_CONFIG,
): boolean {
  return worldZ >= -config.highwayLengthDist && worldZ <= config.despawnDist;
}

/**
 * Checks whether a note at `noteTimeMs` (with `durationMs`) is currently crossing the fretboard hit bar at Z=0.
 */
export function isNoteActiveAtHitBar(
  noteTimeMs: number,
  durationMs: number,
  currentAudioTimeMs: number,
  hitWindowMs: number = DEFAULT_HIGHWAY_CONFIG.hitWindowMs,
): boolean {
  const startWindow = noteTimeMs - hitWindowMs;
  const endWindow = Math.max(
    noteTimeMs + hitWindowMs,
    noteTimeMs + durationMs * 0.75,
  );
  return currentAudioTimeMs >= startWindow && currentAudioTimeMs <= endWindow;
}

/**
 * Computes the active 4-fret hand position window (`startFret` .. `startFret + 3`)
 * within frets 1..15 based on upcoming fretted notes (`fret > 0`) near `currentAudioTimeMs`.
 */
export function computeActiveHandPosition(
  notes: readonly ChartNote[],
  currentAudioTimeMs: number,
  maxFret: number = DEFAULT_HIGHWAY_CONFIG.maxFret,
): { startFret: number; endFret: number } {
  const upcomingFretted = notes.filter(
    (n) =>
      n.fret > 0 &&
      n.timeMs + n.durationMs >= currentAudioTimeMs - 100 &&
      n.timeMs <= currentAudioTimeMs + 3500,
  );

  let anchorFret = 1;
  if (upcomingFretted.length > 0) {
    const firstFret = Math.min(maxFret, upcomingFretted[0].fret);
    const windowSlice = upcomingFretted
      .slice(0, 5)
      .map((n) => Math.min(maxFret, n.fret));
    const minSlice = Math.min(...windowSlice);
    const maxSlice = Math.max(...windowSlice);

    if (maxSlice - minSlice <= 3) {
      anchorFret = minSlice;
    } else {
      anchorFret = firstFret;
    }
  } else {
    const nextAny = notes.find(
      (n) => n.fret > 0 && n.timeMs > currentAudioTimeMs,
    );
    if (nextAny) {
      anchorFret = Math.min(maxFret, nextAny.fret);
    }
  }

  const startFret = Math.max(1, Math.min(maxFret - 3, anchorFret));
  return {
    startFret,
    endFret: startFret + 3,
  };
}

const PITCH_CLASS_NAMES = [
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

/**
 * Infers a readable chord symbol (e.g. Dm, A5, E5, G5, C5, B5, C, Am) from a simultaneous group of notes.
 */
export function inferChordName(notes: readonly ChartNote[]): string {
  if (notes.length === 0) return '';
  const sorted = [...notes].sort((a, b) => a.midi_pitch - b.midi_pitch);
  const rootMidi = sorted[0].midi_pitch;
  const rootClass = ((rootMidi % 12) + 12) % 12;
  const rootName = PITCH_CLASS_NAMES[rootClass];

  const intervals = new Set<number>();
  for (const n of sorted) {
    const diff = (((n.midi_pitch - rootMidi) % 12) + 12) % 12;
    intervals.add(diff);
  }

  const hasMinorThird = intervals.has(3);
  const hasMajorThird = intervals.has(4);
  const hasFifth = intervals.has(7);

  if (hasMinorThird) {
    return `${rootName}m`;
  }
  if (hasMajorThird) {
    return rootName;
  }
  if (hasFifth && intervals.size <= 2) {
    return `${rootName}5`;
  }
  return `${rootName}5`;
}

/**
 * Groups simultaneous notes (2 or more notes at the same `timeMs`) into ChordClusters
 * for 3D wireframe bounding box & overhead chord label rendering.
 */
export function extractChordClusters(
  notes: readonly ChartNote[],
): ChordCluster[] {
  const byTime = new Map<number, ChartNote[]>();
  for (const note of notes) {
    const key = Math.round(note.timeMs);
    const list = byTime.get(key);
    if (list) {
      list.push(note);
    } else {
      byTime.set(key, [note]);
    }
  }

  const clusters: ChordCluster[] = [];
  for (const [, group] of byTime) {
    if (group.length < 2) continue;
    const frets = group.map((n) => n.fret);
    const strings = group.map((n) => n.string);
    const maxDur = Math.max(...group.map((n) => n.durationMs));
    clusters.push({
      timeMs: group[0].timeMs,
      durationMs: maxDur,
      notes: group,
      chordName: inferChordName(group),
      minFret: Math.min(...frets),
      maxFret: Math.max(...frets),
      minString: Math.min(...strings),
      maxString: Math.max(...strings),
    });
  }

  return clusters.sort((a, b) => a.timeMs - b.timeMs);
}
