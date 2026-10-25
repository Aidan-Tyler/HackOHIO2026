import type { AudioStatus, SongEntry } from './song_library';

/** Backing-track fields from GET/POST /api/songs/{id}/audio */
export interface BackingTrackStatus {
  audioUrl: string;
  offsetMs: number;
  audioStatus: AudioStatus;
  audioError: string | null;
  guitarRemoved: boolean;
}

/** One GProTab search hit, as returned by GET /api/search (backend/pipeline/gprotab_client.py) */
export interface TabSearchResult {
  id: string;
  artist: string;
  title: string;
  artist_slug: string;
  song_slug: string;
  url: string;
  score: number;
}

async function readError(response: Response): Promise<string> {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('text/html')) {
    return 'Backend server is not running on port 8000. Start it with `npm run backend` (or uvicorn).';
  }
  try {
    const body = (await response.json()) as { detail?: unknown };
    if (typeof body.detail === 'string') return body.detail;
  } catch {
    // Non-JSON error
  }
  return response.status >= 500
    ? 'Backend not reachable. Start it with `npm run backend` (or uvicorn on port 8000) and check its terminal for errors.'
    : `Request failed (HTTP ${response.status})`;
}

export async function searchTabs(query: string): Promise<TabSearchResult[]> {
  const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
  const contentType = response.headers.get('content-type') || '';
  if (!response.ok || contentType.includes('text/html')) {
    throw new Error(await readError(response));
  }
  const body = (await response.json()) as { results: TabSearchResult[] };
  return body.results;
}

/** Downloads the tab on the backend, parses it to a chart, and returns its library entry */
export async function importTab(result: TabSearchResult): Promise<SongEntry> {
  const response = await fetch('/api/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      artistSlug: result.artist_slug,
      songSlug: result.song_slug,
      title: result.title,
      artist: result.artist,
    }),
  });
  const contentType = response.headers.get('content-type') || '';
  if (!response.ok || contentType.includes('text/html')) {
    throw new Error(await readError(response));
  }
  return (await response.json()) as SongEntry;
}

export async function fetchBackingTrackStatus(songId: string): Promise<BackingTrackStatus> {
  const response = await fetch(`/api/songs/${encodeURIComponent(songId)}/audio`);
  const contentType = response.headers.get('content-type') || '';
  if (!response.ok || contentType.includes('text/html')) {
    throw new Error(await readError(response));
  }
  return (await response.json()) as BackingTrackStatus;
}

/** (Re)builds the backing track in the background, optionally from a specific YouTube URL/query */
export async function rebuildBackingTrack(
  songId: string,
  youtube?: string,
): Promise<BackingTrackStatus> {
  const response = await fetch(`/api/songs/${encodeURIComponent(songId)}/audio`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ youtube: youtube || null }),
  });
  const contentType = response.headers.get('content-type') || '';
  if (!response.ok || contentType.includes('text/html')) {
    throw new Error(await readError(response));
  }
  return (await response.json()) as BackingTrackStatus;
}

/** Deletes an imported song (chart, tab file and backing track) from the backend */
export async function deleteImportedSong(songId: string): Promise<void> {
  const response = await fetch(`/api/songs/${encodeURIComponent(songId)}`, { method: 'DELETE' });
  if (!response.ok) throw new Error(await readError(response));
}
