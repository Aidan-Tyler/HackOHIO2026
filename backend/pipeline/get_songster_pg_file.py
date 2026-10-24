import requests

def get_songsterr_gp_file(query: str, output_path: str = "downloaded_tab.gp5"):
    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
    }
    
    # 1. Search for matching songs
    search_url = f"https://www.songsterr.com/a/ra/songs.json?pattern={requests.utils.quote(query)}"
    res = requests.get(search_url, headers=headers)
    res.raise_for_status()
    results = res.json()
    
    if not results:
        print("No tabs found.")
        return None
        
    top_match = results[0]
    song_id = top_match["id"]
    title = top_match["title"]
    artist = top_match["artist"]["name"]
    print(f"Found: {artist} - {title} (ID: {song_id})")
    
    # 2. Get the tab revision details
    details_url = f"https://www.songsterr.com/a/ra/player/song/{song_id}.json"
    details_res = requests.get(details_url, headers=headers)
    details_res.raise_for_status()
    data = details_res.json()
    
    # 3. Download the raw Guitar Pro file
    gp_url = data.get("attachmentUrl")
    if not gp_url:
        print("No direct Guitar Pro attachment URL found.")
        return None
        
    gp_data = requests.get(gp_url, headers=headers).content
    with open(output_path, "wb") as f:
        f.write(gp_data)
        
    print(f"Saved tab to {output_path}")
    return output_path

if __name__ == "__main__":
    get_songsterr_gp_file("Enter Sandman")