/**
 * Pure coordinate projection math for the 3D Yousician/Rocksmith-style Fretboard & Highway.
 * Kept strictly decoupled from Three.js rendering logic per AGENTS.md guardrails.
 */

import type { ChartNote } from '../types/chart';

export interface HighwayConfig {
  /** Total number of frets on the pinned fretboard (0 through 24) */
  maxFret: number;
  /** Horizontal spacing between adjacent fret wires in world X units */
  fretSpacingX: number;
  /** Vertical spacing between adjacent horizontal strings (6 down to 1) at Z=0 */
  stringSpacingY: number;
  /** Highway elevation angle in degrees (default ~30°) */
  highwayElevationDeg: number;
  /** World distance units per millisecond along the highway ramp */
  speedMultiplier: number;
  /** Z-coordinate of the pinned fretboard target bar */
  hitBarZ: number;
  /** Maximum highway distance visible into the scene */
  highwayLengthDist: number;
  /** Minimum highway distance past the fretboard before notes despawn */
  despawnDist: number;
  /** Hit window tolerance in milliseconds around Z=0 */
  hitWindowMs: number;
}

export const DEFAULT_HIGHWAY_CONFIG: HighwayConfig = {
  maxFret: 24,
  fretSpacingX: 0.62,
  stringSpacingY: 0.36,
  highwayElevationDeg: 30,
  speedMultiplier: 0.015,
  hitBarZ: 0,
  highwayLengthDist: 46,
  despawnDist: -2.5,
  hitWindowMs: 80,
};

export interface StringRailSpec {
  /** Guitar string number: 6 (Low E) down to 1 (High E) */
  stringNumber: number;
  /** 0-indexed lane in chart JSON: stringNumber - 1 (A-string = lane 4) */
  chartLane: number;
  /** Top-to-bottom row index on the pinned fretboard: 0 (String 6/Low E) to 5 (String 1/High E) */
  rowIndex: number;
  /** Display label for the string */
  label: string;
  /** Short note name of the string */
  noteName: string;
  /** Hex color for the string and note capsules (Yousician/Rocksmith palette) */
  colorHex: number;
  /** CSS hex string for UI badges and Canvas2D fret labels */
  colorCss: string;
  /** Relative gauge thickness of the string */
  radius: number;
}

/**
 * Six horizontal guitar strings ordered from top (String 6 / Low E) down to bottom (String 1 / High E).
 */
export const STRING_RAILS: readonly StringRailSpec[] = [
  {
    stringNumber: 6,
    chartLane: 5,
    rowIndex: 0,
    label: '6 · Low E',
    noteName: 'E2',
    colorHex: 0xff3b5c,
    colorCss: '#ff3b5c',
    radius: 0.036,
  },
  {
    stringNumber: 5,
    chartLane: 4,
    rowIndex: 1,
    label: '5 · A',
    noteName: 'A2',
    colorHex: 0x00d2ff,
    colorCss: '#00d2ff',
    radius: 0.032,
  },
  {
    stringNumber: 4,
    chartLane: 3,
    rowIndex: 2,
    label: '4 · D',
    noteName: 'D3',
    colorHex: 0xffbe0b,
    colorCss: '#ffbe0b',
    radius: 0.028,
  },
  {
    stringNumber: 3,
    chartLane: 2,
    rowIndex: 3,
    label: '3 · G',
    noteName: 'G3',
    colorHex: 0x22c55e,
    colorCss: '#22c55e',
    radius: 0.024,
  },
  {
    stringNumber: 2,
    chartLane: 1,
    rowIndex: 4,
    label: '2 · B',
    noteName: 'B3',
    colorHex: 0xa855f7,
    colorCss: '#a855f7',
    radius: 0.02,
  },
  {
    stringNumber: 1,
    chartLane: 0,
    rowIndex: 5,
    label: '1 · High E',
    noteName: 'E4',
    colorHex: 0xf97316,
    colorCss: '#f97316',
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
 * Projects a timestamp (in ms) onto highway distance:
 * Z = (noteTimeMs - currentTimeMs) * speedMultiplier
 */
export function projectTimeToZ(
  noteTimeMs: number,
  currentTimeMs: number,
  speedMultiplier: number = DEFAULT_HIGHWAY_CONFIG.speedMultiplier,
): number {
  return (noteTimeMs - currentTimeMs) * speedMultiplier;
}

/**
 * Converts a highway distance `dist` into 3D world `(yOffset, z)` coordinates
 * along the ~30° elevated perspective highway ramp.
 */
export function highwayDistToWorldYZ(
  dist: number,
  elevationDeg: number = DEFAULT_HIGHWAY_CONFIG.highwayElevationDeg,
): { yOffset: number; z: number } {
  const rad = (elevationDeg * Math.PI) / 180;
  return {
    yOffset: dist * Math.sin(rad),
    z: -dist * Math.cos(rad),
  };
}

/**
 * Converts a duration in milliseconds to world length along the highway ramp.
 */
export function durationToWorldZ(
  durationMs: number,
  speedMultiplier: number = DEFAULT_HIGHWAY_CONFIG.speedMultiplier,
): number {
  return Math.max(0, durationMs * speedMultiplier);
}

/**
 * Maps a fret number (0..24) to its horizontal world X coordinate on the fretboard.
 * Fret 0 is at the nut on the left; frets 1..24 are centered between fret wires `f-1` and `f`.
 */
export function fretToWorldX(
  fretNumber: number,
  config: HighwayConfig = DEFAULT_HIGHWAY_CONFIG,
): number {
  const clamped = Math.max(0, Math.min(config.maxFret, fretNumber));
  const totalWidth = config.maxFret * config.fretSpacingX;
  const nutX = -totalWidth / 2;
  if (clamped === 0) {
    return nutX - config.fretSpacingX * 0.45;
  }
  return nutX + (clamped - 0.5) * config.fretSpacingX;
}

/**
 * Maps a fret wire index (0 = nut, 1..24 = fret wires) to its exact world X position.
 */
export function fretWireToWorldX(
  wireIndex: number,
  config: HighwayConfig = DEFAULT_HIGHWAY_CONFIG,
): number {
  const totalWidth = config.maxFret * config.fretSpacingX;
  const nutX = -totalWidth / 2;
  return nutX + wireIndex * config.fretSpacingX;
}

/**
 * Maps a guitar string number (6 = Low E at top .. 1 = High E at bottom)
 * to its vertical world Y coordinate on the pinned fretboard target bar at Z=0.
 */
export function stringToWorldY(
  stringNumber: number,
  stringSpacingY: number = DEFAULT_HIGHWAY_CONFIG.stringSpacingY,
): number {
  const clamped = Math.max(1, Math.min(6, Math.round(stringNumber)));
  // rowIndex 0 (String 6) -> +2.5 * spacing; rowIndex 5 (String 1) -> -2.5 * spacing
  const rowIndex = 6 - clamped;
  return (2.5 - rowIndex) * stringSpacingY;
}

/**
 * Backward-compatible alias mapping string number to primary lane offset.
 */
export function stringToWorldX(
  stringNumber: number,
  laneSpacing: number = DEFAULT_HIGHWAY_CONFIG.stringSpacingY,
): number {
  return stringToWorldY(stringNumber, laneSpacing);
}

/**
 * Returns the full StringRailSpec for a given guitar string (1–6).
 */
export function getStringRailSpec(stringNumber: number): StringRailSpec {
  const clamped = Math.max(1, Math.min(6, Math.round(stringNumber)));
  return STRING_RAILS[6 - clamped];
}

/**
 * Checks whether a highway distance is within the visible frustum window.
 */
export function isZVisible(
  dist: number,
  config: HighwayConfig = DEFAULT_HIGHWAY_CONFIG,
): boolean {
  return dist >= config.despawnDist && dist <= config.highwayLengthDist;
}

/**
 * Checks whether a note at `noteTimeMs` (with `durationMs`) is currently crossing the fretboard hit bar.
 */
export function isNoteActiveAtHitBar(
  noteTimeMs: number,
  durationMs: number,
  currentTimeMs: number,
  hitWindowMs: number = DEFAULT_HIGHWAY_CONFIG.hitWindowMs,
): boolean {
  const startWindow = noteTimeMs - hitWindowMs;
  const endWindow = Math.max(
    noteTimeMs + hitWindowMs,
    noteTimeMs + durationMs * 0.75,
  );
  return currentTimeMs >= startWindow && currentTimeMs <= endWindow;
}

/**
 * Computes the active 4-fret hand position window (`startFret` .. `startFret + 3`)
 * based on upcoming fretted notes (`fret > 0`) near `currentTimeMs`.
 */
export function computeActiveHandPosition(
  notes: readonly ChartNote[],
  currentTimeMs: number,
  maxFret: number = DEFAULT_HIGHWAY_CONFIG.maxFret,
): { startFret: number; endFret: number } {
  // Look at notes currently active or arriving within the next 3.5 seconds
  const upcomingFretted = notes.filter(
    (n) =>
      n.fret > 0 &&
      n.timeMs + n.durationMs >= currentTimeMs - 100 &&
      n.timeMs <= currentTimeMs + 3500,
  );

  let anchorFret = 1;
  if (upcomingFretted.length > 0) {
    // Use the earliest upcoming fretted note's fret as the primary hand anchor,
    // adjusting if the immediate next notes span up to +3 frets above it
    const firstFret = upcomingFretted[0].fret;
    const windowSlice = upcomingFretted.slice(0, 5).map((n) => n.fret);
    const minSlice = Math.min(...windowSlice);
    const maxSlice = Math.max(...windowSlice);

    if (maxSlice - minSlice <= 3) {
      anchorFret = minSlice;
    } else {
      anchorFret = firstFret;
    }
  } else {
    // Fallback: find the next fretted note anywhere ahead in the song
    const nextAny = notes.find((n) => n.fret > 0 && n.timeMs > currentTimeMs);
    if (nextAny) {
      anchorFret = nextAny.fret;
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
 * Infers a readable chord symbol (e.g. E5, G5, C5, B5, A5, Dm, C, Am) from a simultaneous group of notes.
 */
export function inferChordName(notes: readonly ChartNote[]): string {
  if (notes.length === 0) return '';
  // Sort from lowest string (highest string number, lowest pitch) to highest
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
