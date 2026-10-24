import type { ChartNote } from '../types/chart';

export type HitRating = 'PERFECT' | 'GREAT' | 'GOOD' | 'MISS';
export type NoteJudgmentState = 'PENDING' | 'HIT' | 'MISSED';

export interface TimingWindowsConfig {
  /** |delta| <= 35ms -> PERFECT (300 pts) */
  perfectMs: number;
  /** |delta| <= 75ms -> GREAT (150 pts) */
  greatMs: number;
  /** |delta| <= 120ms -> GOOD (50 pts) */
  goodMs: number;
}

export const DEFAULT_TIMING_WINDOWS: TimingWindowsConfig = {
  perfectMs: 35,
  greatMs: 75,
  goodMs: 120,
};

export const RATING_POINTS: Record<HitRating, number> = {
  PERFECT: 300,
  GREAT: 150,
  GOOD: 50,
  MISS: 0,
};

export interface ScoreState {
  score: number;
  streak: number;
  maxStreak: number;
  multiplier: 1 | 2 | 3 | 4;
  totalHits: number;
  totalMisses: number;
  totalJudged: number;
  perfectCount: number;
  greatCount: number;
  goodCount: number;
  /** Accuracy percentage: (totalHits / totalElapsedNotes) * 100 */
  accuracy: number;
  lastRating: HitRating | null;
  lastDeltaMs: number | null;
}

export interface HitEvaluationResult {
  hit: boolean;
  rating: HitRating | null;
  note: ChartNote | null;
  noteIndex: number;
  deltaMs: number | null;
  pointsAwarded: number;
  state: ScoreState;
}

export interface MissedNoteEvent {
  note: ChartNote;
  noteIndex: number;
  state: ScoreState;
}

/**
 * Computes the combo multiplier from the current streak:
 * - 1x: 0..9 streak
 * - 2x: 10..19 streak
 * - 3x: 20..29 streak
 * - 4x: 30+ streak
 */
export function computeComboMultiplier(streak: number): 1 | 2 | 3 | 4 {
  if (streak >= 30) return 4;
  if (streak >= 20) return 3;
  if (streak >= 10) return 2;
  return 1;
}

/**
 * Evaluates a timing delta `|note.timeMs - currentAudioTimeMs|` against the arcade hit windows.
 */
export function evaluateTimingDelta(
  absDeltaMs: number,
  windows: TimingWindowsConfig = DEFAULT_TIMING_WINDOWS,
): HitRating | null {
  if (absDeltaMs <= windows.perfectMs) return 'PERFECT';
  if (absDeltaMs <= windows.greatMs) return 'GREAT';
  if (absDeltaMs <= windows.goodMs) return 'GOOD';
  return null;
}

export class ScoringEngine {
  private readonly windows: TimingWindowsConfig;
  private notes: ChartNote[] = [];
  private noteStates: NoteJudgmentState[] = [];
  private noteRatings: (HitRating | null)[] = [];

  private score = 0;
  private streak = 0;
  private maxStreak = 0;
  private multiplier: 1 | 2 | 3 | 4 = 1;
  private totalHits = 0;
  private totalMisses = 0;
  private perfectCount = 0;
  private greatCount = 0;
  private goodCount = 0;
  private lastRating: HitRating | null = null;
  private lastDeltaMs: number | null = null;

  private lastTriggeredNoteIndex = -1;
  private lastPitchTriggerTimeMs = -1000;
  private lastPitchMidi = -1;

  constructor(windows: Partial<TimingWindowsConfig> = {}) {
    this.windows = { ...DEFAULT_TIMING_WINDOWS, ...windows };
  }

  /**
   * Loads a chart's notes into the scoring engine and resets all state counters.
   */
  public loadNotes(notes: readonly ChartNote[]): void {
    this.notes = [...notes];
    this.reset();
  }

  /**
   * Resets all score, combo, accuracy, and per-note judgment states.
   */
  public reset(): void {
    this.noteStates = new Array<NoteJudgmentState>(this.notes.length).fill(
      'PENDING',
    );
    this.noteRatings = new Array<HitRating | null>(this.notes.length).fill(
      null,
    );
    this.score = 0;
    this.streak = 0;
    this.maxStreak = 0;
    this.multiplier = 1;
    this.totalHits = 0;
    this.totalMisses = 0;
    this.perfectCount = 0;
    this.greatCount = 0;
    this.goodCount = 0;
    this.lastRating = null;
    this.lastDeltaMs = null;
    this.lastTriggeredNoteIndex = -1;
    this.lastPitchTriggerTimeMs = -1000;
    this.lastPitchMidi = -1;
  }

  /**
   * Re-initializes judgments when the player scrubs/seeks backward or forward on the timeline.
   * Notes strictly before `seekTimeMs - goodMs` are marked without penalizing the player's accuracy.
   */
  public syncToSeekTime(seekTimeMs: number): void {
    this.reset();
    for (let i = 0; i < this.notes.length; i++) {
      if (this.notes[i].timeMs < seekTimeMs - this.windows.goodMs) {
        // Pre-seek notes are marked HIT so they don't trigger false MISSes after seeking forward
        this.noteStates[i] = 'HIT';
      }
    }
  }

  public getNoteState(noteIndex: number): NoteJudgmentState {
    return this.noteStates[noteIndex] ?? 'PENDING';
  }

  public getNoteRating(noteIndex: number): HitRating | null {
    return this.noteRatings[noteIndex] ?? null;
  }

  public getTimingWindows(): TimingWindowsConfig {
    return this.windows;
  }

  public getState(): ScoreState {
    const totalJudged = this.totalHits + this.totalMisses;
    const accuracy =
      totalJudged > 0 ? (this.totalHits / totalJudged) * 100 : 100.0;

    return {
      score: this.score,
      streak: this.streak,
      maxStreak: this.maxStreak,
      multiplier: this.multiplier,
      totalHits: this.totalHits,
      totalMisses: this.totalMisses,
      totalJudged,
      perfectCount: this.perfectCount,
      greatCount: this.greatCount,
      goodCount: this.goodCount,
      accuracy,
      lastRating: this.lastRating,
      lastDeltaMs: this.lastDeltaMs,
    };
  }

  /**
   * Evaluates a player input trigger on `stringIndex` (1–6, or 0–5 mapped to 1–6)
   * and optional `fret` (pass `undefined` or `null` for string-only test triggers)
   * at `currentAudioTimeMs`.
   *
   * Matches the earliest unjudged (`PENDING`) note on that string within the valid
   * timing window (`|note.timeMs - currentAudioTimeMs| <= 120ms`).
   */
  public checkHit(
    stringIndex: number,
    fret?: number | null,
    currentAudioTimeMs = 0,
  ): HitEvaluationResult {
    const targetString =
      stringIndex >= 1 && stringIndex <= 6
        ? Math.round(stringIndex)
        : Math.max(1, Math.min(6, Math.round(stringIndex) + 1));

    const maxWindowMs = this.windows.goodMs;
    let matchedIndex = -1;

    for (let i = 0; i < this.notes.length; i++) {
      if (this.noteStates[i] !== 'PENDING') continue;
      const note = this.notes[i];

      // Since notes are sorted chronologically, stop once notes are too far in the future
      if (note.timeMs - currentAudioTimeMs > maxWindowMs) {
        break;
      }

      if (note.string !== targetString) continue;
      if (fret !== undefined && fret !== null && fret >= 0 && note.fret !== fret) {
        continue;
      }

      const absDelta = Math.abs(note.timeMs - currentAudioTimeMs);
      if (absDelta <= maxWindowMs) {
        matchedIndex = i;
        break;
      }
    }

    if (matchedIndex === -1) {
      return {
        hit: false,
        rating: null,
        note: null,
        noteIndex: -1,
        deltaMs: null,
        pointsAwarded: 0,
        state: this.getState(),
      };
    }

    return this.applyHitJudgment(matchedIndex, currentAudioTimeMs);
  }

  /**
   * Evaluates a live monophonic pitch detector MIDI note against any unjudged note
   * within the valid timing window (`<= 120ms`), allowing ±1 semitone pitch tolerance.
   */
  public checkPitchHit(
    detectedMidiNote: number,
    currentAudioTimeMs: number,
  ): HitEvaluationResult {
    const maxWindowMs = this.windows.goodMs;
    let bestIndex = -1;
    let bestAbsDelta = Infinity;

    for (let i = 0; i < this.notes.length; i++) {
      if (this.noteStates[i] !== 'PENDING') continue;
      const note = this.notes[i];

      if (note.timeMs - currentAudioTimeMs > maxWindowMs) {
        break;
      }

      const absDelta = Math.abs(note.timeMs - currentAudioTimeMs);
      if (absDelta > maxWindowMs) continue;

      const pitchDiff = Math.abs(note.midi_pitch - detectedMidiNote);
      const octaveFoldedDiff = Math.abs(((note.midi_pitch - detectedMidiNote) % 12 + 12) % 12);
      if (pitchDiff <= 1 || octaveFoldedDiff === 0) {
        if (absDelta < bestAbsDelta) {
          bestAbsDelta = absDelta;
          bestIndex = i;
        }
      }
    }

    if (bestIndex === -1) {
      return {
        hit: false,
        rating: null,
        note: null,
        noteIndex: -1,
        deltaMs: null,
        pointsAwarded: 0,
        state: this.getState(),
      };
    }

    // Prevent duplicate re-triggering on the exact same frame
    if (
      bestIndex === this.lastTriggeredNoteIndex &&
      Math.abs(currentAudioTimeMs - this.lastPitchTriggerTimeMs) < 30 &&
      this.lastPitchMidi === Math.round(detectedMidiNote)
    ) {
      return {
        hit: false,
        rating: null,
        note: null,
        noteIndex: -1,
        deltaMs: null,
        pointsAwarded: 0,
        state: this.getState(),
      };
    }

    this.lastTriggeredNoteIndex = bestIndex;
    this.lastPitchTriggerTimeMs = currentAudioTimeMs;
    this.lastPitchMidi = Math.round(detectedMidiNote);

    return this.applyHitJudgment(bestIndex, currentAudioTimeMs);
  }

  /**
   * Marks a specific pending note as MISSED (0 pts, resets streak to 0 and multiplier to 1x).
   */
  public markNoteMissed(noteIndex: number): MissedNoteEvent | null {
    if (
      noteIndex < 0 ||
      noteIndex >= this.notes.length ||
      this.noteStates[noteIndex] !== 'PENDING'
    ) {
      return null;
    }

    this.noteStates[noteIndex] = 'MISSED';
    this.noteRatings[noteIndex] = 'MISS';
    this.streak = 0;
    this.multiplier = 1;
    this.totalMisses += 1;
    this.lastRating = 'MISS';
    this.lastDeltaMs = null;

    return {
      note: this.notes[noteIndex],
      noteIndex,
      state: this.getState(),
    };
  }

  private applyHitJudgment(
    noteIndex: number,
    currentAudioTimeMs: number,
  ): HitEvaluationResult {
    const note = this.notes[noteIndex];
    const deltaMs = note.timeMs - currentAudioTimeMs;
    const absDeltaMs = Math.abs(deltaMs);
    const rating = evaluateTimingDelta(absDeltaMs, this.windows) ?? 'GOOD';

    this.noteStates[noteIndex] = 'HIT';
    this.noteRatings[noteIndex] = rating;

    this.streak += 1;
    if (this.streak > this.maxStreak) {
      this.maxStreak = this.streak;
    }
    this.multiplier = computeComboMultiplier(this.streak);

    const basePoints = RATING_POINTS[rating];
    const pointsAwarded = basePoints * this.multiplier;
    this.score += pointsAwarded;
    this.totalHits += 1;

    if (rating === 'PERFECT') {
      this.perfectCount += 1;
    } else if (rating === 'GREAT') {
      this.greatCount += 1;
    } else if (rating === 'GOOD') {
      this.goodCount += 1;
    }

    this.lastRating = rating;
    this.lastDeltaMs = deltaMs;

    return {
      hit: true,
      rating,
      note,
      noteIndex,
      deltaMs,
      pointsAwarded,
      state: this.getState(),
    };
  }
}
