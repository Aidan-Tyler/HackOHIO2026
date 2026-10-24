import { STRING_RAILS } from '../engine/highway';
import type { SongEntry } from './song_library';
import {
  fetchBackingTrackStatus,
  importTab,
  rebuildBackingTrack,
  searchTabs,
  type BackingTrackStatus,
  type TabSearchResult,
} from './tab_api';

const AUDIO_POLL_MS = 3000;

export interface MainMenuCallbacks {
  /** Called when the player picks a song and hits Play */
  onPlay: (song: SongEntry) => Promise<void>;
}

function audioTag(song: SongEntry): string {
  if (song.audioStatus === 'pending') return `<span class="audio-tag pending">audio…</span>`;
  if (song.audioStatus === 'failed' || song.audioStatus === 'none') {
    return `<span class="audio-tag">no audio</span>`;
  }
  return '';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  return `${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, '0')}`;
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Full-screen start menu overlaid on the highway. Owns only its own DOM;
 * song loading and playback are delegated back to main.ts via callbacks.
 */
export class MainMenu {
  private readonly rootEl: HTMLElement;
  private readonly songListEl: HTMLElement;
  private readonly playBtn: HTMLButtonElement;
  private readonly statusEl: HTMLElement;
  private readonly songCountEl: HTMLElement;
  private readonly audioStatusEl: HTMLElement;
  private readonly searchForm: HTMLFormElement;
  private readonly searchInput: HTMLInputElement;
  private readonly searchStatusEl: HTMLElement;
  private readonly searchResultsEl: HTMLElement;

  private songs: SongEntry[] = [];
  private selectedSongId: string | null = null;
  private busy = false;

  private searchResults: TabSearchResult[] = [];
  private importingId: string | null = null;
  /** Increments per search so a slow earlier response can't overwrite a newer one */
  private searchSeq = 0;
  private audioPollTimer: number | null = null;

  constructor(private readonly callbacks: MainMenuCallbacks) {
    this.rootEl = document.getElementById('main-menu')!;
    this.songListEl = document.getElementById('menu-song-list')!;
    this.playBtn = document.getElementById('menu-play-btn') as HTMLButtonElement;
    this.statusEl = document.getElementById('menu-status')!;
    this.songCountEl = document.getElementById('menu-song-count')!;
    this.audioStatusEl = document.getElementById('menu-audio-status')!;
    this.searchForm = document.getElementById('menu-search-form') as HTMLFormElement;
    this.searchInput = document.getElementById('menu-search-input') as HTMLInputElement;
    this.searchStatusEl = document.getElementById('menu-search-status')!;
    this.searchResultsEl = document.getElementById('menu-search-results')!;

    // Decorative strings: high E (thin) down to low E (thick)
    const stringsEl = document.getElementById('menu-strings')!;
    stringsEl.innerHTML = [...STRING_RAILS]
      .sort((a, b) => a.stringNumber - b.stringNumber)
      .map((rail, i) => `<span style="--c:${rail.colorCss};--w:${1 + i * 0.6}px"></span>`)
      .join('');

    this.songListEl.addEventListener('click', (e) => {
      const card = (e.target as HTMLElement).closest<HTMLElement>('[data-song-id]');
      if (card) this.select(card.dataset.songId!);
    });

    this.songListEl.addEventListener('dblclick', (e) => {
      const card = (e.target as HTMLElement).closest<HTMLElement>('[data-song-id]');
      if (card) {
        this.select(card.dataset.songId!);
        void this.playSelected();
      }
    });

    this.playBtn.addEventListener('click', () => void this.playSelected());

    this.audioStatusEl.addEventListener('click', (e) => {
      const action = (e.target as HTMLElement).closest<HTMLElement>('[data-audio-action]');
      if (!action || !this.selectedSongId) return;
      if (action.dataset.audioAction === 'retry') {
        void this.requestBackingTrack(this.selectedSongId);
      } else if (action.dataset.audioAction === 'pick') {
        const youtube = window.prompt('Paste a YouTube link (or a search) for this song’s audio:');
        if (youtube?.trim()) void this.requestBackingTrack(this.selectedSongId, youtube.trim());
      }
    });

    this.searchForm.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.runSearch(this.searchInput.value.trim());
    });

    this.searchResultsEl.addEventListener('click', (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('[data-result-id]');
      const result = this.searchResults.find((r) => r.id === row?.dataset.resultId);
      if (result) void this.importResult(result);
    });
  }

  private async runSearch(query: string): Promise<void> {
    if (query.length < 2) {
      this.searchStatusEl.textContent = 'Type at least 2 characters.';
      return;
    }

    const seq = ++this.searchSeq;
    this.searchStatusEl.textContent = `Searching GProTab for “${query}”…`;
    try {
      const results = await searchTabs(query);
      if (seq !== this.searchSeq) return;
      this.searchResults = results;
      this.searchStatusEl.textContent = results.length
        ? `${results.length} tab${results.length === 1 ? '' : 's'} found. Pick one to add it to the setlist.`
        : 'No tabs found. Try “Artist - Song” or just the song title.';
    } catch (err) {
      if (seq !== this.searchSeq) return;
      this.searchResults = [];
      this.searchStatusEl.textContent = errorMessage(err);
    }
    this.renderSearchResults();
  }

  private async importResult(result: TabSearchResult): Promise<void> {
    if (this.songs.some((s) => s.id === result.id)) {
      this.select(result.id);
      return;
    }
    if (this.importingId) return;

    this.importingId = result.id;
    this.searchStatusEl.textContent = `Downloading and parsing ${result.artist} - ${result.title}…`;
    this.renderSearchResults();
    try {
      const song = await importTab(result);
      this.songs = [...this.songs.filter((s) => s.id !== song.id), song];
      this.selectedSongId = song.id;
      this.render();
      this.searchStatusEl.textContent = `Added “${song.title}” to the setlist.`;
    } catch (err) {
      this.searchStatusEl.textContent = `Couldn't import ${result.title}: ${errorMessage(err)}`;
    } finally {
      this.importingId = null;
      this.renderSearchResults();
    }
  }

  private renderSearchResults(): void {
    this.searchResultsEl.innerHTML = this.searchResults
      .map((result) => {
        const inSetlist = this.songs.some((s) => s.id === result.id);
        const importing = result.id === this.importingId;
        const action = importing ? 'Adding…' : inSetlist ? 'In setlist' : 'Add';
        return `
          <button type="button" class="search-row${inSetlist ? ' added' : ''}"
                  data-result-id="${escapeHtml(result.id)}" ${this.importingId ? 'disabled' : ''}>
            <span class="search-row-name">
              <span class="search-row-title">${escapeHtml(result.title)}</span>
              <span class="search-row-artist">${escapeHtml(result.artist)}</span>
            </span>
            <span class="search-row-action">${action}</span>
          </button>
        `;
      })
      .join('');
  }

  public setSongs(songs: SongEntry[]): void {
    this.songs = songs;
    if (!this.selectedSongId && songs.length > 0) {
      this.selectedSongId = songs[0].id;
    }
    this.render();
  }

  private applyBackingTrackStatus(songId: string, status: BackingTrackStatus): void {
    this.songs = this.songs.map((s) => (s.id === songId ? { ...s, ...status } : s));
    this.render();
  }

  private async requestBackingTrack(songId: string, youtube?: string): Promise<void> {
    try {
      this.applyBackingTrackStatus(songId, await rebuildBackingTrack(songId, youtube));
    } catch (err) {
      this.audioStatusEl.textContent = `Couldn't start backing track: ${errorMessage(err)}`;
    }
  }

  /** Polls the backend while any imported song's backing track is still being built */
  private scheduleAudioPoll(): void {
    const pending = this.songs.filter((s) => s.audioStatus === 'pending');
    if (pending.length === 0 || this.audioPollTimer !== null) return;

    this.audioPollTimer = window.setTimeout(async () => {
      this.audioPollTimer = null;
      for (const song of pending) {
        try {
          this.applyBackingTrackStatus(song.id, await fetchBackingTrackStatus(song.id));
        } catch {
          // Backend hiccup: keep the pending state and try again next tick
        }
      }
      this.scheduleAudioPoll();
    }, AUDIO_POLL_MS);
  }

  private renderAudioStatus(): void {
    const song = this.songs.find((s) => s.id === this.selectedSongId);
    // Bundled songs ship their own audio and have no job status
    if (!song?.audioStatus) {
      this.audioStatusEl.innerHTML = '';
      return;
    }

    const pick = `<button type="button" class="menu-link-btn" data-audio-action="pick">Use a different video</button>`;
    switch (song.audioStatus) {
      case 'pending':
        this.audioStatusEl.innerHTML =
          `<span class="audio-pending">Fetching backing track from YouTube…</span> You can play now without it.`;
        break;
      case 'ready':
        this.audioStatusEl.innerHTML =
          `Backing track ready (${song.guitarRemoved ? 'guitar removed' : 'full mix, guitar included'}). ${pick}`;
        break;
      case 'failed':
        this.audioStatusEl.innerHTML =
          `No backing track: ${escapeHtml(song.audioError ?? 'unknown error')} ` +
          `<button type="button" class="menu-link-btn" data-audio-action="retry">Retry</button> ${pick}`;
        break;
      default:
        this.audioStatusEl.innerHTML =
          `No backing track. <button type="button" class="menu-link-btn" data-audio-action="retry">Fetch from YouTube</button>`;
    }
  }

  public setStatus(message: string): void {
    this.statusEl.textContent = message;
  }

  public show(): void {
    this.rootEl.hidden = false;
    document.body.classList.add('menu-open');
    this.playBtn.focus();
  }

  public hide(): void {
    this.rootEl.hidden = true;
    document.body.classList.remove('menu-open');
  }

  public isOpen(): boolean {
    return !this.rootEl.hidden;
  }

  private select(songId: string): void {
    this.selectedSongId = songId;
    this.render();
  }

  private async playSelected(): Promise<void> {
    const song = this.songs.find((s) => s.id === this.selectedSongId);
    if (!song || this.busy) return;

    this.busy = true;
    this.playBtn.disabled = true;
    this.setStatus(`Loading ${song.title}…`);
    try {
      await this.callbacks.onPlay(song);
      this.setStatus('');
      this.hide();
    } catch (err) {
      console.error('Failed to load song:', err);
      this.setStatus(`Couldn't load ${song.title}: ${String(err)}`);
    } finally {
      this.busy = false;
      this.playBtn.disabled = false;
    }
  }

  private render(): void {
    this.songCountEl.textContent =
      this.songs.length === 1 ? '1 song' : `${this.songs.length} songs`;
    this.renderAudioStatus();
    this.scheduleAudioPoll();

    if (this.songs.length === 0) {
      this.songListEl.innerHTML = `<p class="muted">No songs in the library yet.</p>`;
      this.playBtn.disabled = true;
      return;
    }

    this.playBtn.disabled = this.busy;
    this.songListEl.innerHTML = this.songs
      .map((song, idx) => {
        const selected = song.id === this.selectedSongId;
        const bars = Array.from({ length: 5 }, (_, i) =>
          `<span class="bar${i < song.difficulty ? ' on' : ''}" style="height:${5 + i * 2}px"></span>`,
        ).join('');
        return `
          <button type="button" class="song-row${selected ? ' selected' : ''}"
                  data-song-id="${escapeHtml(song.id)}" aria-pressed="${selected}">
            <span class="song-row-num">${String(idx + 1).padStart(2, '0')}</span>
            <span>
              <div class="song-row-title">${escapeHtml(song.title)}</div>
              <div class="song-row-artist">${escapeHtml(song.artist)}</div>
            </span>
            <span class="song-row-meta">
              <span>${formatDuration(song.durationMs)}</span>
              <span>${Math.round(song.bpm)} bpm</span>
              <span>${escapeHtml(song.tuning)}</span>
              ${audioTag(song)}
              <span class="difficulty" title="Difficulty ${song.difficulty}/5">${bars}</span>
            </span>
          </button>
        `;
      })
      .join('');
  }
}
