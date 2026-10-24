import { STRING_RAILS } from '../engine/highway';
import type { SongEntry } from './song_library';

export interface MainMenuCallbacks {
  /** Called when the player picks a song and hits Play */
  onPlay: (song: SongEntry) => Promise<void>;
  /** Called when the player submits a tab / song link to import */
  onImportLink: (url: string) => Promise<void>;
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
  private readonly importForm: HTMLFormElement;
  private readonly importInput: HTMLInputElement;
  private readonly importStatusEl: HTMLElement;

  private songs: SongEntry[] = [];
  private selectedSongId: string | null = null;
  private busy = false;

  constructor(private readonly callbacks: MainMenuCallbacks) {
    this.rootEl = document.getElementById('main-menu')!;
    this.songListEl = document.getElementById('menu-song-list')!;
    this.playBtn = document.getElementById('menu-play-btn') as HTMLButtonElement;
    this.statusEl = document.getElementById('menu-status')!;
    this.songCountEl = document.getElementById('menu-song-count')!;
    this.importForm = document.getElementById('menu-import-form') as HTMLFormElement;
    this.importInput = document.getElementById('menu-import-input') as HTMLInputElement;
    this.importStatusEl = document.getElementById('menu-import-status')!;

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

    this.importForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const url = this.importInput.value.trim();
      if (!url) return;
      this.importStatusEl.textContent = 'Fetching tabs…';
      try {
        await this.callbacks.onImportLink(url);
      } catch (err) {
        this.importStatusEl.textContent = String(err instanceof Error ? err.message : err);
      }
    });
  }

  public setSongs(songs: SongEntry[]): void {
    this.songs = songs;
    if (!this.selectedSongId && songs.length > 0) {
      this.selectedSongId = songs[0].id;
    }
    this.render();
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
              <span class="difficulty" title="Difficulty ${song.difficulty}/5">${bars}</span>
            </span>
          </button>
        `;
      })
      .join('');
  }
}
