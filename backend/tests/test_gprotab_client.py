"""Unit tests for backend.pipeline.gprotab_client and the /api endpoints (no network)."""

from __future__ import annotations

import shutil
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlencode

import pytest
from fastapi.testclient import TestClient

from backend import main
from backend.pipeline import gprotab_client
from backend.pipeline.gprotab_client import (
    QueryGuess,
    download_tab,
    parse_artist_page_html,
    parse_artist_search_html,
    parse_query,
    parse_song_search_html,
    parse_tab_url,
    search_tabs,
)

RAW_GP3_PATH = Path("backend/data/raw_gp5/white-stripes-seven_nation_army.gp3")


def _song_results_html(rows: list[tuple[str, str, str, str]]) -> str:
    """rows: (artist, artist_slug, title, song_slug), mirroring GProTab's search markup."""
    blocks = "".join(
        f"""<div class="tab search-tab"><img src="/x.webp" alt="{a_slug}" />
        <div class="tab-data">
          <a href="/en/tabs/{a_slug}" class="tab-band">{artist}</a>
          <a href="/en/tabs/{a_slug}/{s_slug}" class="tab-name">{title}</a>
        </div></div>"""
        for artist, a_slug, title, s_slug in rows
    )
    return f'<a href="/en/artists/a">a</a><h1 class="category-name">Results</h1>{blocks}'


SNA_ROWS = [
    ("Audioslave", "audioslave", "Seven nation army", "seven-nation-army"),
    ("White stripes", "white-stripes", "Seven nation army", "seven-nation-army"),
    ("White stripes", "white-stripes", "Seven nation army 2", "seven-nation-army-2"),
]


class FakeSession:
    """Answers GProTab GETs from a {(path, query-string): html} table; unknown pages are empty."""

    def __init__(self, pages: dict[tuple[str, str], str]) -> None:
        self.pages = pages
        self.headers: dict[str, str] = {}
        self.requested: list[tuple[str, str]] = []

    def get(self, url: str, params=None, timeout=None, headers=None):
        path = url.removeprefix(gprotab_client.BASE_URL)
        key = (path, urlencode(params or {}))
        self.requested.append(key)
        return SimpleNamespace(text=self.pages.get(key, ""), raise_for_status=lambda: None)


def _song_q(q: str) -> tuple[str, str]:
    return ("/en/search", urlencode({"type": "song", "q": q}))


def _artist_q(q: str) -> tuple[str, str]:
    return ("/en/search", urlencode({"type": "artist", "q": q}))


def test_parse_query_dash_and_by_forms():
    assert parse_query("White Stripes - Seven Nation Army")[0] == QueryGuess(
        title="Seven Nation Army", artist="White Stripes"
    )
    assert parse_query("enter sandman by Metallica") == [
        QueryGuess(title="enter sandman", artist="Metallica")
    ]


def test_parse_query_free_text_tries_whole_query_then_splits():
    guesses = parse_query("seven nation army white stripes")
    assert guesses[0] == QueryGuess(title="seven nation army white stripes")
    assert QueryGuess(title="seven nation army", artist="white stripes") in guesses
    assert parse_query("   ") == []


def test_parse_tab_url():
    assert parse_tab_url("https://gprotab.net/en/tabs/white-stripes/seven-nation-army?download") == (
        "white-stripes",
        "seven-nation-army",
    )
    assert parse_tab_url("https://example.com/en/tabs/a/b") is None
    assert parse_tab_url("seven nation army") is None


def test_parse_song_search_html_pairs_band_with_title():
    results = parse_song_search_html(_song_results_html(SNA_ROWS))
    assert [(r.artist, r.artist_slug, r.title, r.song_slug) for r in results] == SNA_ROWS
    assert results[1].url == "https://gprotab.net/en/tabs/white-stripes/seven-nation-army"
    assert results[1].id == "gprotab-white-stripes--seven-nation-army"


def test_parse_artist_search_and_page_html():
    search_html = """<a href="/en/artists/w">w</a><ol class="artists"><li>
        <img src="/x.webp" /><a href="/en/tabs/white-stripes">White stripes</a></li></ol>"""
    assert parse_artist_search_html(search_html) == [("White stripes", "white-stripes")]

    page_html = """<li><a href="/en/tabs/white-stripes/astro">Astro</a></li>
        <li><a href="/en/tabs/white-stripes/astro">Astro</a></li>
        <li><a href="/en/tabs/other-band/song">Song</a></li>"""
    results = parse_artist_page_html(page_html, "White stripes", "white-stripes")
    assert [(r.title, r.song_slug) for r in results] == [("Astro", "astro")]


def test_search_tabs_splits_mixed_title_and_artist_query():
    session = FakeSession({_song_q("seven nation army"): _song_results_html(SNA_ROWS)})
    results = search_tabs("seven nation army white stripes", session=session)

    assert results[0].artist == "White stripes"
    assert results[0].song_slug == "seven-nation-army"
    assert results[1].song_slug == "seven-nation-army-2"
    assert results[-1].artist == "Audioslave"
    assert len([k for k in session.requested if "type=song" in k[1]]) <= gprotab_client.MAX_SONG_SEARCHES


def test_search_tabs_artist_name_lists_catalogue():
    session = FakeSession(
        {
            _artist_q("white stripes"): '<ol class="artists"><li><a href="/en/tabs/white-stripes">White stripes</a></li></ol>',
            ("/en/tabs/white-stripes", ""): '<a href="/en/tabs/white-stripes/astro">Astro</a>',
        }
    )
    results = search_tabs("white stripes", session=session)
    assert [(r.artist, r.title) for r in results] == [("White stripes", "Astro")]


def test_search_tabs_pasted_url_skips_network():
    session = FakeSession({})
    results = search_tabs("https://gprotab.net/en/tabs/white-stripes/seven-nation-army", session=session)
    assert results[0].song_slug == "seven-nation-army"
    assert session.requested == []


def _download_session(filename: str, content: bytes = b"data") -> SimpleNamespace:
    response = SimpleNamespace(
        headers={"content-disposition": f'attachment; filename="{filename}"'},
        content=content,
        raise_for_status=lambda: None,
    )
    return SimpleNamespace(headers={}, get=lambda *a, **kw: response)


def test_download_tab_saves_with_stable_name(tmp_path):
    out = download_tab("white-stripes", "seven-nation-army", tmp_path, session=_download_session("x.gp3", b"GP"))
    assert out == tmp_path / "gprotab-white-stripes--seven-nation-army.gp3"
    assert out.read_bytes() == b"GP"


def test_download_tab_rejects_unsupported_format_and_bad_slugs(tmp_path):
    with pytest.raises(ValueError, match="gpx"):
        download_tab("a", "b", tmp_path, session=_download_session("song.gpx"))
    with pytest.raises(ValueError, match="slug"):
        download_tab("../etc", "b", tmp_path, session=_download_session("song.gp5"))


@pytest.fixture
def api_client(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "RAW_GP_DIR", tmp_path / "raw")
    monkeypatch.setattr(main, "CHARTS_DIR", tmp_path / "charts")
    monkeypatch.setattr(main, "AUDIO_DIR", tmp_path / "audio")
    started: list[tuple] = []
    monkeypatch.setattr(main.backing_jobs, "start_job", lambda *args: started.append(args) or True)

    def fake_download(artist_slug: str, song_slug: str, dest_dir: Path) -> Path:
        dest = Path(dest_dir)
        dest.mkdir(parents=True, exist_ok=True)
        out = dest / f"gprotab-{artist_slug}--{song_slug}.gp3"
        shutil.copy(RAW_GP3_PATH, out)
        return out

    monkeypatch.setattr(main, "download_tab", fake_download)
    client = TestClient(main.app)
    client.started_jobs = started  # type: ignore[attr-defined]
    return client


def test_import_then_list_and_fetch_chart(api_client):
    res = api_client.post(
        "/api/import",
        json={"artistSlug": "white-stripes", "songSlug": "seven-nation-army", "title": "Seven nation army"},
    )
    assert res.status_code == 200, res.text
    entry = res.json()
    assert entry["id"] == "gprotab-white-stripes--seven-nation-army"
    assert entry["chartUrl"] == "/api/charts/gprotab-white-stripes--seven-nation-army.json"
    assert entry["tuning"] == "E A E A C# E"
    assert 1 <= entry["difficulty"] <= 5
    assert entry["audioUrl"] == "" and entry["audioStatus"] == "none"

    # Import kicks off a YouTube backing-track job for "<artist> <title> official audio"
    (_audio_dir, chart_id, source, first_note_ms), = api_client.started_jobs
    assert chart_id == entry["id"]
    assert source == "The White Stripes Seven Nation Army official audio"
    assert first_note_ms == 0.0

    assert [s["id"] for s in api_client.get("/api/songs").json()["songs"]] == [entry["id"]]

    chart = api_client.get(entry["chartUrl"]).json()
    assert chart["notes"][0]["time_ms"] >= 0
    assert {"string", "fret", "hammer_on", "pull_off", "slide", "bend"} <= set(chart["notes"][0])


def test_backing_track_rebuild_validates_youtube_source(api_client):
    api_client.post("/api/import", json={"artistSlug": "white-stripes", "songSlug": "seven-nation-army"})
    url = "/api/songs/gprotab-white-stripes--seven-nation-army/audio"
    assert api_client.post(url, json={"youtube": "https://evil.example.com/x"}).status_code == 422
    assert api_client.post(url, json={"youtube": "https://youtu.be/CBEJo18auXE"}).status_code == 200
    assert api_client.started_jobs[-1][2] == "https://youtu.be/CBEJo18auXE"
    assert api_client.get("/api/songs/gprotab-nope/audio").status_code == 404
    assert api_client.get("/api/audio/..%2Fmain.py").status_code == 404


def test_import_rejects_bad_slug_and_unknown_chart(api_client):
    assert api_client.post("/api/import", json={"artistSlug": "../x", "songSlug": "y"}).status_code == 422
    assert api_client.get("/api/charts/gprotab-missing.json").status_code == 404
    assert api_client.get("/api/charts/..%2Fsecrets.json").status_code == 404
