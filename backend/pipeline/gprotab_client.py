"""GProTab.net search + Guitar Pro file downloader.

GProTab's own search only matches *either* song titles or artist names, never a
mix ("seven nation army white stripes" returns nothing). This module parses a
free-form query into title/artist guesses, runs a small bounded set of site
searches, and ranks the combined hits by fuzzy title + artist similarity.
"""

from __future__ import annotations

import argparse
import re
from dataclasses import asdict, dataclass
from difflib import SequenceMatcher
from html.parser import HTMLParser
from pathlib import Path

import requests

BASE_URL = "https://gprotab.net"
REQUEST_TIMEOUT_S = 15
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/130 Safari/537.36"
    )
}

# Formats pyguitarpro can read. GProTab also hosts .gpx / .gp (Guitar Pro 6+).
SUPPORTED_EXTENSIONS = (".gp3", ".gp4", ".gp5")

SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
TAB_PATH_RE = re.compile(r"^/en/tabs/([a-z0-9-]+)/([a-z0-9-]+)/?$")
ARTIST_PATH_RE = re.compile(r"^/en/tabs/([a-z0-9-]+)/?$")
TAB_URL_RE = re.compile(r"gprotab\.net(/en/tabs/[a-z0-9-]+/[a-z0-9-]+)/?(?:\?.*)?$")

# Upper bound on site requests per user search (keeps a search under a few seconds)
MAX_SONG_SEARCHES = 5
ARTIST_MATCH_THRESHOLD = 0.85


@dataclass
class TabResult:
    artist: str
    title: str
    artist_slug: str
    song_slug: str
    score: float = 0.0

    @property
    def id(self) -> str:
        return f"gprotab-{self.artist_slug}--{self.song_slug}"

    @property
    def url(self) -> str:
        return f"{BASE_URL}/en/tabs/{self.artist_slug}/{self.song_slug}"

    def to_dict(self) -> dict[str, object]:
        return {**asdict(self), "id": self.id, "url": self.url}


@dataclass
class QueryGuess:
    title: str
    artist: str | None = None


# --------------------------------------------------------------------------- #
# Query parsing
# --------------------------------------------------------------------------- #


def normalize(text: str) -> str:
    """Lowercases, drops a leading 'the', and strips punctuation for fuzzy matching."""
    text = text.lower().replace("&", " and ")
    text = re.sub(r"[^a-z0-9 ]+", " ", text)
    text = re.sub(r"^the\s+", "", text.strip())
    return re.sub(r"\s+", " ", text).strip()


def similarity(a: str, b: str) -> float:
    na, nb = normalize(a), normalize(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    return SequenceMatcher(None, na, nb).ratio()


def parse_query(query: str) -> list[QueryGuess]:
    """Turns a free-form query into ordered (title, artist) guesses.

    - "Artist - Title"  -> title=Title, artist=Artist (and the reverse, in case)
    - "Title by Artist" -> title=Title, artist=Artist
    - anything else     -> the whole query as a title, then word splits where one
                           side is the title and the other the artist
    """
    query = re.sub(r"\s+", " ", query).strip()
    if not query:
        return []

    dash = re.split(r"\s+[-–—:|]\s+", query, maxsplit=1)
    if len(dash) == 2:
        left, right = dash
        return [QueryGuess(title=right, artist=left), QueryGuess(title=left, artist=right)]

    by = re.split(r"\s+by\s+", query, maxsplit=1, flags=re.IGNORECASE)
    if len(by) == 2:
        return [QueryGuess(title=by[0], artist=by[1])]

    guesses = [QueryGuess(title=query)]
    words = query.split(" ")
    # Prefer longer titles first: "seven nation army white stripes" tries
    # "seven nation army white" / "seven nation army" ... before shorter titles.
    for title_len in range(len(words) - 1, 0, -1):
        guesses.append(
            QueryGuess(title=" ".join(words[:title_len]), artist=" ".join(words[title_len:]))
        )
        guesses.append(
            QueryGuess(title=" ".join(words[-title_len:]), artist=" ".join(words[:-title_len]))
        )
    return guesses


def parse_tab_url(text: str) -> tuple[str, str] | None:
    """Extracts (artist_slug, song_slug) from a pasted gprotab.net tab URL."""
    match = TAB_URL_RE.search(text.strip())
    if not match:
        return None
    path_match = TAB_PATH_RE.match(match.group(1))
    return (path_match.group(1), path_match.group(2)) if path_match else None


# --------------------------------------------------------------------------- #
# HTML scraping
# --------------------------------------------------------------------------- #


class _LinkCollector(HTMLParser):
    """Collects (href, class, text) for every <a> tag on a page."""

    def __init__(self) -> None:
        super().__init__()
        self.links: list[tuple[str, str, str]] = []
        self._current: list[str] | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "a":
            attr_map = dict(attrs)
            self._current = [attr_map.get("href") or "", attr_map.get("class") or "", ""]

    def handle_data(self, data: str) -> None:
        if self._current is not None:
            self._current[2] += data

    def handle_endtag(self, tag: str) -> None:
        if tag == "a" and self._current is not None:
            href, cls, text = self._current
            self.links.append((href, cls, text.strip()))
            self._current = None


def _collect_links(html: str) -> list[tuple[str, str, str]]:
    collector = _LinkCollector()
    collector.feed(html)
    return collector.links


def _get(session: requests.Session, path: str, **params: str) -> requests.Response:
    res = session.get(f"{BASE_URL}{path}", params=params or None, timeout=REQUEST_TIMEOUT_S)
    res.raise_for_status()
    return res


def parse_song_search_html(html: str) -> list[TabResult]:
    """Search results are `a.tab-band` followed by its `a.tab-name`."""
    results: list[TabResult] = []
    pending_artist: str | None = None
    for href, cls, text in _collect_links(html):
        if "tab-band" in cls:
            pending_artist = text
        elif "tab-name" in cls and pending_artist is not None:
            match = TAB_PATH_RE.match(href)
            if match:
                results.append(
                    TabResult(
                        artist=pending_artist,
                        title=text,
                        artist_slug=match.group(1),
                        song_slug=match.group(2),
                    )
                )
            pending_artist = None
    return results


def parse_artist_search_html(html: str) -> list[tuple[str, str]]:
    """Artist results: plain `/en/tabs/<artist>` links inside `ol.artists`. Returns (name, slug)."""
    artists: list[tuple[str, str]] = []
    for href, cls, text in _collect_links(html):
        match = ARTIST_PATH_RE.match(href)
        if match and not cls and text:
            artists.append((text, match.group(1)))
    return artists


def parse_artist_page_html(html: str, artist_name: str, artist_slug: str) -> list[TabResult]:
    seen: set[str] = set()
    results: list[TabResult] = []
    for href, _cls, text in _collect_links(html):
        match = TAB_PATH_RE.match(href)
        if match and match.group(1) == artist_slug and text and match.group(2) not in seen:
            seen.add(match.group(2))
            results.append(
                TabResult(
                    artist=artist_name,
                    title=text,
                    artist_slug=artist_slug,
                    song_slug=match.group(2),
                )
            )
    return results


# --------------------------------------------------------------------------- #
# Public API
# --------------------------------------------------------------------------- #


def _split_version(title: str) -> tuple[str, int]:
    """"Seven nation army 2" is the 2nd upload of the same song -> ("Seven nation army", 2)."""
    match = re.match(r"^(.*?)\s+(\d+)$", title)
    return (match.group(1), int(match.group(2))) if match else (title, 1)


def _score(result: TabResult, guess: QueryGuess) -> float:
    # Score alternate uploads as the base title with a tiny penalty so the original sorts first
    base_title, version = _split_version(result.title)
    version_penalty = 0.01 if version > 1 else 0.0
    title_score = similarity(base_title, guess.title)
    if guess.artist is None:
        return title_score - version_penalty
    return 0.6 * title_score + 0.4 * similarity(result.artist, guess.artist) - version_penalty


def search_tabs(query: str, limit: int = 20, session: requests.Session | None = None) -> list[TabResult]:
    """Searches GProTab for a free-form query like "seven nation army white stripes"."""
    session = session or requests.Session()
    session.headers.update(HEADERS)

    pasted = parse_tab_url(query)
    if pasted:
        artist_slug, song_slug = pasted
        return [
            TabResult(
                artist=artist_slug.replace("-", " ").capitalize(),
                title=song_slug.replace("-", " ").capitalize(),
                artist_slug=artist_slug,
                song_slug=song_slug,
                score=1.0,
            )
        ]

    best: dict[str, TabResult] = {}

    def add(results: list[TabResult], guess: QueryGuess) -> None:
        for result in results:
            result.score = round(_score(result, guess), 4)
            existing = best.get(result.id)
            if existing is None or result.score > existing.score:
                best[result.id] = result

    # 1. Song-title searches over the parsed guesses (bounded)
    searched_titles: set[str] = set()
    for guess in parse_query(query):
        if len(searched_titles) >= MAX_SONG_SEARCHES:
            break
        title_key = normalize(guess.title)
        if not title_key or title_key in searched_titles:
            continue
        searched_titles.add(title_key)
        hits = parse_song_search_html(_get(session, "/en/search", type="song", q=guess.title).text)
        add(hits, guess)
        # Stop early once a hit matches both the title and the guessed artist well
        if guess.artist and any(
            similarity(h.artist, guess.artist) >= ARTIST_MATCH_THRESHOLD
            and similarity(_split_version(h.title)[0], guess.title) >= ARTIST_MATCH_THRESHOLD
            for h in hits
        ):
            break

    # 2. If the whole query is an artist name, list that artist's tabs
    artists = parse_artist_search_html(_get(session, "/en/search", type="artist", q=query).text)
    for artist_name, artist_slug in artists[:1]:
        if similarity(artist_name, query) >= ARTIST_MATCH_THRESHOLD:
            page = _get(session, f"/en/tabs/{artist_slug}").text
            songs = parse_artist_page_html(page, artist_name, artist_slug)
            for song in songs:
                # Artist matched outright; keep their catalogue in site order just below exact hits
                song.score = 0.9
                existing = best.get(song.id)
                if existing is None or song.score > existing.score:
                    best[song.id] = song

    ranked = sorted(
        best.values(),
        key=lambda r: (-r.score, r.artist, *_split_version(r.title)),
    )
    return ranked[:limit]


def download_tab(
    artist_slug: str,
    song_slug: str,
    dest_dir: str | Path,
    session: requests.Session | None = None,
) -> Path:
    """Downloads a tab's Guitar Pro file to `dest_dir/gprotab-<artist>--<song>.<ext>`."""
    if not SLUG_RE.match(artist_slug) or not SLUG_RE.match(song_slug):
        raise ValueError("Invalid GProTab slug")

    session = session or requests.Session()
    session.headers.update(HEADERS)
    page_path = f"/en/tabs/{artist_slug}/{song_slug}"
    res = session.get(
        f"{BASE_URL}{page_path}?download",
        headers={"Referer": f"{BASE_URL}{page_path}"},
        timeout=REQUEST_TIMEOUT_S,
    )
    res.raise_for_status()

    disposition = res.headers.get("content-disposition", "")
    name_match = re.search(r'filename="?([^";]+)"?', disposition)
    if not name_match:
        raise ValueError(f"GProTab did not return a file for {page_path}")
    extension = Path(name_match.group(1)).suffix.lower()
    if extension not in SUPPORTED_EXTENSIONS:
        raise ValueError(
            f"This tab is a {extension or 'unknown'} file; only {', '.join(SUPPORTED_EXTENSIONS)} "
            "(Guitar Pro 3–5) can be parsed."
        )

    out_dir = Path(dest_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"gprotab-{artist_slug}--{song_slug}{extension}"
    out_path.write_bytes(res.content)
    return out_path


def main() -> None:
    parser = argparse.ArgumentParser(description="Search GProTab.net for Guitar Pro tabs.")
    parser.add_argument("query", help='e.g. "seven nation army white stripes"')
    parser.add_argument("--download", type=int, metavar="N", help="Download result #N (1-based)")
    parser.add_argument("-o", "--out-dir", default="backend/data/raw_gp5")
    args = parser.parse_args()

    results = search_tabs(args.query)
    for i, r in enumerate(results, start=1):
        print(f"{i:2d}. [{r.score:.2f}] {r.artist} - {r.title}  ({r.url})")

    if args.download and results:
        chosen = results[args.download - 1]
        print(f"Saved {download_tab(chosen.artist_slug, chosen.song_slug, args.out_dir)}")


if __name__ == "__main__":
    main()
