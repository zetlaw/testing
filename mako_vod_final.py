#!/usr/bin/env python3
import base64, requests, json, re, os, time, random, argparse
from bs4 import BeautifulSoup
from urllib.parse import urljoin, urlparse
from Crypto.Cipher import AES
from Crypto.Util.Padding import pad, unpad
from bidi.algorithm import get_display
import sys
import traceback

# Add this near the top of your script
def raw_text(text):
    """Return text without bidirectional handling for debugging"""
    return text

# Setup print for bidirectional text and constants
original_print, print = print, lambda *args, **kwargs: original_print(*[get_display(arg) if isinstance(arg, str) else arg for arg in args], **kwargs)
BASE_URL = "https://www.mako.co.il"
HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,he;q=0.8',
    'Referer': 'https://www.mako.co.il/mako-vod-index',
    'Connection': 'keep-alive'
}
CRYPTO = {
    'playlist': {'key': b"LTf7r/zM2VndHwP+4So6bw==", 'iv': b"theExact16Chars="},
    'entitlement': {'key': b"YhnUaXMmltB6gd8p9SWleQ==", 'iv': b"theExact16Chars=", 
                   'url': "https://mass.mako.co.il/ClicksStatistics/entitlementsServicesV2.jsp?et=egt"}
}
CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mako_shows_cache.json")
CACHE_TTL = 30 * 24 * 60 * 60  # 30 days in seconds
DELAY_BETWEEN_REQUESTS = 1
MAX_RETRIES = 3
REQUEST_TIMEOUT = 10

# Parse command line arguments
def parse_args():
    parser = argparse.ArgumentParser(description='Mako VOD downloader')
    parser.add_argument('--skip-name-fetch', action='store_true', help='Skip fetching show names and use cached names only')
    parser.add_argument('--max-shows', type=int, default=None, help='Maximum number of shows to process')
    parser.add_argument('--update-mode', action='store_true', help='Only update the cache, don\'t play videos')
    return parser.parse_args()

# Simple session management
session = requests.Session()
adapter = requests.adapters.HTTPAdapter(max_retries=MAX_RETRIES)
session.mount('http://', adapter)
session.mount('https://', adapter)

# Core request function
def request(url, method="GET", headers=None, data=None):
    # Add delay to prevent throttling
    time.sleep(DELAY_BETWEEN_REQUESTS + random.uniform(0.5, 1.5))
    
    try:
        print(f"Fetching: {url}")
        req_headers = headers or HEADERS.copy()
        
        if method.upper() == "POST":
            resp = session.post(url, headers=req_headers, data=data, timeout=REQUEST_TIMEOUT)
        else:
            resp = session.get(url, headers=req_headers, timeout=REQUEST_TIMEOUT)
        
        resp.raise_for_status()
        return resp
    except Exception as e:
        print(f"Request error: {e}")
        return None

# Encryption/decryption function
def crypto_op(data, op, type):
    try:
        c = CRYPTO[type]
        if op == "decrypt":
            cipher = AES.new(c['key'], AES.MODE_CBC, c['iv'])
            return unpad(cipher.decrypt(base64.b64decode(data)), AES.block_size, style='pkcs7').decode('utf-8')
        else:  # encrypt
            cipher = AES.new(c['key'], AES.MODE_CBC, c['iv'])
            data_bytes = data.encode('utf-8') if isinstance(data, str) else data
            return base64.b64encode(cipher.encrypt(pad(data_bytes, AES.block_size, style='pkcs7'))).decode('utf-8')
    except Exception as e:
        print(f"{op} error: {e}")
        return None

# Simple select menu
def select_item(items, prompt):
    if not items: return None
    print(f"\n{prompt}")
    for i, item in enumerate(items): print(f"{i + 1}. {item['name']}")
    try: return items[int(input(f"Choice (1-{len(items)}): ")) - 1]
    except: return None

# Cache management
def load_cache():
    try:
        if os.path.exists(CACHE_FILE):
            with open(CACHE_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        return {"timestamp": time.time(), "shows": {}}
    except Exception as e:
        print(f"Error loading cache: {e}")
        return {"timestamp": time.time(), "shows": {}}

def save_cache(cache):
    try:
        # Create a temporary file
        cache_dir = os.path.dirname(CACHE_FILE)
        os.makedirs(cache_dir, exist_ok=True)
        temp_file = os.path.join(cache_dir, f"temp_cache_{int(time.time())}.json")
        
        # Write to temp file with explicit encoding
        with open(temp_file, 'w', encoding='utf-8') as f:
            print(f"Saving {len(cache['shows'])} shows to cache...")
            json.dump(cache, f, ensure_ascii=False, indent=2)
        
        os.replace(temp_file, CACHE_FILE)
        print("Cache saved successfully")
    except Exception as e:
        print(f"Error saving cache: {e}")
        if os.path.exists(temp_file):
            try: os.remove(temp_file)
            except: pass

# Show name extraction
def extract_show_name(url):
    resp = request(url)
    if not resp: return None
    
    soup = BeautifulSoup(resp.text, 'html.parser')
    jsonld_tag = soup.find('script', type='application/ld+json')
    
    if not jsonld_tag:
        return None
        
    try:
        # Parse the JSON-LD data
        data = json.loads(jsonld_tag.string)
        
        # IMPORTANT FIX: Check if this is a TVSeason and get the series name instead
        if data.get('@type') == 'TVSeason' and 'partOfTVSeries' in data:
            name = data['partOfTVSeries'].get('name')
            print(f"Found TVSeason, using series name from partOfTVSeries: {name}")
        else:
            # Regular TVSeries handling
            name = data.get('name')
        
        # For debugging, print the raw name exactly as found in JSON
        print(f"Raw name found in JSON: {name}")
        
        # Optional: Add season info if available
        if "containsSeason" in data and data["containsSeason"]:
            if isinstance(data["containsSeason"], list) and len(data["containsSeason"]) > 0:
                seasons_count = len(data["containsSeason"])
                if seasons_count > 1:
                    name = f"{name} ({seasons_count} עונות)"
        
        return name
    except Exception as e:
        print(f"Error extracting show name from {url}: {e}")
        traceback.print_exc()  # Print full traceback for debugging
        return None

# Process show names (simplified version without threading)
def process_show_names(shows, cache, cache_is_fresh, max_shows=None):
    updates_count = 0
    processed_count = 0
    
    # Limit shows to process if requested
    shows_to_process = shows
    if max_shows and max_shows < len(shows):
        shows_to_process = shows[:max_shows]
        print(f"Will process only {max_shows} shows")
    
    total = len(shows_to_process)
    print(f"Processing {total} shows...")
    
    # Process each show sequentially
    for i, show in enumerate(shows_to_process):
        try:
            url = show['url']
            
            # Check if in cache
            if url in cache["shows"] and cache_is_fresh:
                show['name'] = cache["shows"][url]
                processed_count += 1
                continue
                
            # Not in cache, fetch the name
            if correct_name := extract_show_name(url):
                print(f"Found show name: {correct_name}")
                # Debugging for Hebrew text issues
                print(f"Raw bytes: {correct_name.encode('utf-8')}")
                show['name'] = correct_name
                cache["shows"][url] = correct_name
            else:
                print(f"Could not fetch name for show at {url}")
            
            # Update progress
            processed_count += 1
            print(f"Progress: {processed_count}/{total} shows processed ({processed_count/total*100:.1f}%)")
            
            # Save after every 10 updates or at the end
            if updates_count % 10 == 0 or i == len(shows_to_process) - 1:
                cache["timestamp"] = time.time()
                save_cache(cache)
                
        except KeyboardInterrupt:
            print("\nProcess interrupted. Saving progress...")
            cache["timestamp"] = time.time()
            save_cache(cache)
            return updates_count
        except Exception as e:
            print(f"Error processing show {show.get('name', 'unknown')}: {e}")
    
    return updates_count

# Content extraction
def extract_content(url, content_type):
    resp = request(url)
    if not resp: return []
    
    soup = BeautifulSoup(resp.text, 'html.parser')
    configs = {
        'shows': {
            'selectors': ['li > a[href^="/mako-vod-"]', 'li a[href^="/mako-vod-"]'],
            'fields': {'url': {'attribute': 'href'}, 'temp_name': {'selector': 'img', 'attribute': 'alt'}},
            'base': BASE_URL
        },
        'seasons': {
            'selectors': ['div#seasonDropdown ul ul li a'],
            'fields': {'name': {'selector': 'span'}, 'url': {'attribute': 'href'}},
            'base': url
        },
        'episodes': {
            'selectors': ['li.card a', 'a[href*="videoGuid="]', '.vod_item a', '.vod_item_wrap a'],
            'fields': {'name': {'selector': 'strong.title'}, 'url': {'attribute': 'href'}, 
                      'guid': {'attribute': 'href', 'regex': r'/VOD-([\w-]+)\.htm'}},
            'base': url
        }
    }
    
    config = configs[content_type]
    items, seen = [], set()
    
    # Find elements using selectors
    elements = []
    for selector in config['selectors']:
        if elements := soup.select(selector): break
    
    print(f"Found {len(elements)} {content_type}")
    
    # Process each element
    for elem in elements:
        item = {}
        for field, field_config in config['fields'].items():
            selector = field_config.get('selector')
            attr = field_config.get('attribute')
            regex = field_config.get('regex')
            
            target = elem.select_one(selector) if selector else elem
            if not target: continue
            
            value = target.get(attr, '') if attr else target.text.strip()
            
            if value and regex and field == 'guid' and (match := re.search(regex, value)):
                value = match.group(1)
            
            if value and field == 'url':
                value = urljoin(config['base'], value)
                
            if value: item[field] = value
        
        if len(item) == len(config['fields']) or (content_type == 'shows' and 'url' in item):
            key = item.get('guid', item.get('url', ''))
            if key and key not in seen:
                if content_type == 'shows':
                    item['name'] = item.pop('temp_name', 'Unknown Show')  # Temporary name
                items.append(item)
                seen.add(key)
    
    # Special handling for episodes
    if content_type == 'episodes':
        for ep in items:
            if 'guid' not in ep and 'url' in ep:
                if match := re.search(r'[?&](guid|videoGuid)=([\w-]+)', ep['url'], re.I):
                    ep['guid'] = match.group(2)
        items = [ep for ep in items if 'guid' in ep]
    
    # Special handling for shows to get correct names
    if content_type == 'shows':
        args = parse_args()
        cache = load_cache()
        cache_is_fresh = time.time() - cache.get("timestamp", 0) < CACHE_TTL
        
        if args.skip_name_fetch:
            print("\nSkipping show name fetching as requested")
            # Just load names from cache
            if cache_is_fresh:
                for show in items:
                    if show['url'] in cache["shows"]:
                        show['name'] = cache["shows"][show['url']]
        else:
            print(f"\nLoading accurate show names...")
            
            # Apply cached names first
            cached_count = 0
            if cache_is_fresh:
                for show in items:
                    if show['url'] in cache["shows"]:
                        show['name'] = cache["shows"][show['url']]
                        cached_count += 1
            
            if cached_count:
                print(f"Using {cached_count} show names from cache")
            
            # Determine which shows need to be fetched
            to_fetch = [show for show in items if not (cache_is_fresh and show['url'] in cache["shows"])]
            if not to_fetch:
                print("All show names already in cache!")
            else:
                print(f"Need to fetch {len(to_fetch)} show names")
                updates = process_show_names(to_fetch, cache, cache_is_fresh, args.max_shows)
                
                if updates > 0:
                    print(f"Added {updates} new show names to cache")
    
    return items

# Get episode details for video playback
def get_episode_details(url):
    resp = request(url)
    if not resp: return None
    
    soup = BeautifulSoup(resp.text, 'html.parser')
    script = soup.find('script', id='__NEXT_DATA__')
    if not script: return None
    
    try:
        data = json.loads(script.string)
        vod = data.get('props', {}).get('pageProps', {}).get('data', {}).get('vod', {})
        
        details = {
            'vcmid': vod.get('itemVcmId'),
            'galleryChannelId': vod.get('galleryChannelId'),
            'videoChannelId': vod.get('channelId')
        }
        
        return details if all(details.values()) else None
    except:
        return None

# Get video playback URL
def get_video_url(episode_url):
    details = get_episode_details(episode_url)
    if not details: return None
    
    ajax_url = (f"{BASE_URL}/AjaxPage?jspName=playlist12.jsp"
               f"&vcmid={details['vcmid']}"
               f"&videoChannelId={details['videoChannelId']}"
               f"&galleryChannelId={details['galleryChannelId']}"
               f"&consumer=responsive")
    
    resp = request(ajax_url)
    if not resp or not resp.text.strip(): return None
    
    try:
        decrypted = crypto_op(resp.text.strip(), "decrypt", "playlist")
        if not decrypted: return None
        
        data = json.loads(decrypted)
        media = data.get('media', [])
        hls_url = media[0].get('url') if media and isinstance(media[0], dict) else None
        if not hls_url: return None
        
        # Get entitlement ticket
        payload = json.dumps({"lp": urlparse(hls_url).path, "rv": "AKAMAI"}, separators=(',', ':'))
        encrypted = crypto_op(payload, "encrypt", "entitlement")
        
        resp = request(CRYPTO['entitlement']['url'], "POST", 
                      {**HEADERS, 'Content-Type': 'text/plain;charset=UTF-8'}, encrypted)
        
        # Return base URL if ticket fails
        if not resp: return hls_url
        
        decrypted = crypto_op(resp.text.strip(), "decrypt", "entitlement")
        if not decrypted: return hls_url
        
        data = json.loads(decrypted)
        tickets = data.get('tickets', [])
        if tickets and isinstance(tickets[0], dict) and (ticket := tickets[0].get('ticket')):
            separator = '&' if '?' in hls_url else '?'
            return f"{hls_url}{separator}{ticket}"
        return hls_url
            
    except Exception as e:
        print(f"Error processing video URL: {e}")
        return None

# Main function
def main():
    args = parse_args()
    
    try:
        # Update mode - just process show names then exit
        if args.update_mode:
            print("Running in update mode - will only update show name cache")
            shows = extract_content(f"{BASE_URL}/mako-vod-index", 'shows')
            if shows:
                print("Shows cache update complete. Exiting.")
            return
        
        # Regular mode - select and play video
        shows = extract_content(f"{BASE_URL}/mako-vod-index", 'shows')
        if not shows:
            print("No shows found. Exiting.")
            return
            
        show = select_item(shows, "Select a show:")
        if not show: return
        
        # Select season or get episodes directly
        seasons = extract_content(show['url'], 'seasons')
        if seasons:
            season = select_item(seasons, "Select a season:")
            if not season: return
            episodes = extract_content(season['url'], 'episodes')
        else:
            episodes = extract_content(show['url'], 'episodes')
        
        if not episodes:
            print("No episodes found")
            return
            
        # Select episode and get playable URL
        episode = select_item(episodes, "Select an episode:")
        if not episode: return
        
        print(f"\nFetching video for: {episode['name']}")
        if video_url := get_video_url(episode['url']):
            print("\n--- PLAYABLE URL ---")
            print(video_url)
        else:
            print("\nFailed to get video URL")
    
    except KeyboardInterrupt:
        print("\nOperation cancelled")
    except Exception as e:
        print("\nUnexpected error")
        print(e)
        traceback.print_exc()

if __name__ == "__main__":
    main()