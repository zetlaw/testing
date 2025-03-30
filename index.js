// index.js
const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
// Use the external crypto.js module that uses AES-192
const { CRYPTO, cryptoOp } = require('./crypto');

// ** Log NODE_ENV on startup **
console.log(`Current NODE_ENV: ${process.env.NODE_ENV}`);

// Import Vercel Blob for serverless storage
let blob;
if (process.env.NODE_ENV === 'production') {
    try {
        const vercelBlob = require('@vercel/blob');
        // Ensure all needed functions are imported
        blob = {
            put: vercelBlob.put,
            list: vercelBlob.list,
            head: vercelBlob.head,
            del: vercelBlob.del // Include del if you might need cache invalidation
        };
        console.log("Successfully required @vercel/blob package.");
    } catch (e) {
        console.error('Failed to load @vercel/blob, cache will not persist:', e.message);
        blob = null; // Ensure blob is null if require fails
    }
} else {
    console.log("Not in production, Vercel Blob will not be used.");
    blob = null;
}

// Constants
const BASE_URL = "https://www.mako.co.il";
const CACHE_FILE = path.join(__dirname, "mako_shows_cache.json"); // Used for local dev
const CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days in MILLISECONDS
const DELAY_BETWEEN_REQUESTS = 500; // 0.5 second delay between Mako requests
const MAX_RETRIES = 3; // Not explicitly used with axios default adapter here, but good constant
const REQUEST_TIMEOUT = 10000; // 10 seconds for axios requests
const BLOB_CACHE_KEY = 'mako-shows-cache-v1.json'; // Single, consistent cache key

// Headers for requests
const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36', // Example updated UA
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,he;q=0.8',
    'Referer': 'https://www.mako.co.il/mako-vod-index',
    'Connection': 'keep-alive'
};

// In-memory cache (simple version)
let memoryCache = null;
let memoryCacheTimestamp = 0;

// --- Cache Management (Modified for Blob) ---
const loadCache = async () => {
    const now = Date.now();
    // Return recent memory cache immediately to avoid multiple fetches within a short time
    if (memoryCache && (now - memoryCacheTimestamp < 60 * 1000)) { // Cache memory for 1 min
        return memoryCache;
    }

    if (blob) { // Only attempt blob if it was initialized successfully
        try {
            console.log(`Attempting to load cache blob: ${BLOB_CACHE_KEY}`);
            
            // Initialize empty cache structure
            const emptyCache = { 
                timestamp: now, 
                shows: {}, 
                seasons: {} 
            };

            try {
                // List blobs to find the most recent one
                const { blobs } = await blob.list({ prefix: BLOB_CACHE_KEY });
                if (blobs && blobs.length > 0) {
                    // Sort by lastModified and get the most recent
                    const mostRecent = blobs.sort((a, b) => b.lastModified - a.lastModified)[0];
                    console.log(`Found most recent cache blob: ${mostRecent.pathname}, Size: ${mostRecent.size}, URL: ${mostRecent.url}`);
                    
                    // Fetch the actual cache data
                    const response = await axios.get(mostRecent.url, { timeout: 5000 });
                    // Validate fetched data
                    if (typeof response.data === 'object' && response.data !== null) {
                        memoryCache = response.data;
                        // Ensure cache has required structure
                        if (!memoryCache.shows) memoryCache.shows = {};
                        if (!memoryCache.seasons) memoryCache.seasons = {};
                        console.log(`Loaded cache from Blob with ${Object.keys(memoryCache.shows).length} shows and ${Object.keys(memoryCache.seasons).length} seasons`);
                        memoryCacheTimestamp = now;
                        return memoryCache;
                    }
                }
            } catch (headError) {
                if (!headError.message.includes('404')) {
                    console.error("Blob list request failed:", headError);
                }
            }

            // If we get here, either no blobs exist or they're invalid
            console.log("Initializing new cache");
            memoryCache = emptyCache;
            memoryCacheTimestamp = now;

            // Try to save the initial cache
            try {
                await blob.put(BLOB_CACHE_KEY, JSON.stringify(emptyCache), {
                    access: 'public',
                    contentType: 'application/json'
                });
                console.log("Initialized and saved new cache to Blob storage");
            } catch (saveError) {
                console.error("Failed to save initial cache:", saveError);
                // Continue even if save fails - we still have the memory cache
            }

            return memoryCache;

        } catch (e) {
            console.error("Error in loadCache:", e.message);
            // Fallback to empty cache on any error
            memoryCache = { timestamp: now, shows: {}, seasons: {} };
            memoryCacheTimestamp = now;
            return memoryCache;
        }
    } else { // Local development or Blob failed to init
        try {
            if (fs.existsSync(CACHE_FILE)) {
                const fileData = fs.readFileSync(CACHE_FILE, 'utf8');
                const data = JSON.parse(fileData);
                if (typeof data === 'object' && data !== null) {
                    memoryCache = data;
                    // Ensure cache has required structure
                    if (!memoryCache.shows) memoryCache.shows = {};
                    if (!memoryCache.seasons) memoryCache.seasons = {};
                    memoryCacheTimestamp = now;
                    return memoryCache;
                }
            }
        } catch (e) {
            console.error("Error loading cache from file:", e.message);
        }
        // Default to empty if file doesn't exist or fails parsing
        memoryCache = { timestamp: now, shows: {}, seasons: {} };
        memoryCacheTimestamp = now;
        return memoryCache;
    }
};

const saveCache = async (cache) => {
    if (!cache || typeof cache !== 'object') {
        console.error("Attempted to save invalid cache object.");
        return;
    }
    
    // Ensure cache has required structure
    if (!cache.shows) cache.shows = {};
    if (!cache.seasons) cache.seasons = {};
    cache.timestamp = Date.now(); // Ensure timestamp is updated before saving
    
    // Update memory cache immediately
    memoryCache = cache;
    memoryCacheTimestamp = Date.now();

    if (blob) { // Only attempt blob if it was initialized successfully
        try {
            console.log(`Attempting to save cache (${Object.keys(cache.shows).length} shows, ${Object.keys(cache.seasons).length} seasons) to Blob: ${BLOB_CACHE_KEY}`);
            
            // Save new cache file
            await blob.put(BLOB_CACHE_KEY, JSON.stringify(cache), {
                access: 'public',
                contentType: 'application/json'
            });
            console.log("Cache saved successfully to Vercel Blob");

            // Clean up old cache files
            try {
                const { blobs } = await blob.list({ prefix: BLOB_CACHE_KEY });
                if (blobs && blobs.length > 1) {
                    // Sort by lastModified, keep the most recent 2 files
                    const sortedBlobs = blobs.sort((a, b) => b.lastModified - a.lastModified);
                    const blobsToDelete = sortedBlobs.slice(2);
                    
                    // Delete old cache files
                    for (const oldBlob of blobsToDelete) {
                        try {
                            await blob.del(oldBlob.pathname);
                            console.log(`Deleted old cache file: ${oldBlob.pathname}`);
                        } catch (delError) {
                            console.error(`Failed to delete old cache file ${oldBlob.pathname}:`, delError);
                        }
                    }
                }
            } catch (cleanupError) {
                console.error("Failed to clean up old cache files:", cleanupError);
            }
        } catch (e) {
            console.error("Error saving cache to Blob storage:", e.message);
        }
    } else { // Local development or Blob failed to init
        try {
            const cacheDir = path.dirname(CACHE_FILE);
            if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
            fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
        } catch (e) {
            console.error("Error saving cache to file:", e.message);
        }
    }
};

// --- Helper Functions ---
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const processImageUrl = (url) => {
    if (!url) return null;
    // Ensure URL doesn't start with //_next/static... which indicates a missing image sometimes
    if (url.startsWith('//_next/')) return null;
    if (url.startsWith('http')) return url;
    if (url.startsWith('//')) return `https:${url}`;
    // Basic check for relative paths
    if (url.startsWith('/')) return `${BASE_URL}${url}`;
    // If it's not clearly absolute or relative, assume it might be missing or invalid
    return null;
};


// --- Data Extraction Functions ---

const extractShowName = async (url) => {
    try {
        // console.log(`Extracting show name from ${url}`);
        const response = await axios.get(url, { headers: HEADERS, timeout: REQUEST_TIMEOUT, maxRedirects: 5 });
        const $ = cheerio.load(response.data);
        const jsonldTag = $('script[type="application/ld+json"]').html();

        let name = null;
        let poster = null;
        let background = null;

        if (jsonldTag) {
            try {
                const data = JSON.parse(jsonldTag);
                if (data['@type'] === 'TVSeason' && data.partOfTVSeries?.name) {
                    name = data.partOfTVSeries.name;
                } else {
                    name = data.name;
                }
                if (data.containsSeason && Array.isArray(data.containsSeason) && data.containsSeason.length > 1) {
                     name = `${name} (${data.containsSeason.length} עונות)`;
                }
            } catch (jsonErr) {
                console.warn(`Error parsing JSON-LD for ${url}: ${jsonErr.message}`);
            }
        }

        // Always try fallback methods for name and images
        const ogTitle = $('meta[property="og:title"]').attr('content');
        const h1Title = $('h1').first().text().trim();
        if (!name) {
            name = ogTitle || h1Title || null;
             if (name) console.log(`Using fallback name: ${name} for ${url}`);
             else console.log(`No name found for ${url}`);
        }

        // Image extraction (simplified)
        poster = processImageUrl(
            $('meta[property="og:image"]').attr('content') ||
            $('meta[name="twitter:image"]').attr('content') ||
            $('link[rel="image_src"]').attr('href') ||
            $('.vod_item img').attr('src') || // Check common containers
            $('.vod_item_wrap img').attr('src')
        );
        background = processImageUrl($('meta[property="og:image:width"][content="1920"]').parent().attr('content')) || poster;

        // Defaults
        if (!poster || poster.includes('_next/static')) poster = 'https://www.mako.co.il/assets/images/svg/mako_logo.svg';
        if (!background || background.includes('_next/static')) background = poster;

        // console.log(`Extracted show details for ${url}: Name: ${name}`);
        return { name: name || 'Unknown Show', poster, background }; // Ensure name is never null

    } catch (e) {
        console.error(`Error extracting show name from ${url}:`, e.message);
        // Return default structure on error to avoid breaking caller
        return {
            name: 'Error Loading',
            poster: 'https://www.mako.co.il/assets/images/svg/mako_logo.svg',
            background: 'https://www.mako.co.il/assets/images/svg/mako_logo.svg'
        };
    }
};

// processShowNames is potentially too slow for serverless meta requests.
// We will fetch details directly in the meta handler if not cached.
// This function can be kept for potential background updates if needed later,
// but it's not called by the current handlers.
// const processShowNames = async (shows, cache, cacheIsFresh, maxShows = null) => { /* ... */ };


const extractContent = async (url, contentType) => {
    try {
        await sleep(DELAY_BETWEEN_REQUESTS);
        // console.log(`Workspaceing ${contentType} from ${url}`);
        const response = await axios.get(url, { headers: HEADERS, timeout: REQUEST_TIMEOUT });
        const $ = cheerio.load(response.data);

        const configs = {
             shows: {
                selectors: [
                    // Try specific common structures first
                    '.vod_item_wrap article a[href^="/mako-vod-"]',
                    '.vod_item article a[href^="/mako-vod-"]',
                    'li.grid-item a[href^="/mako-vod-"]',
                    'section[class*="vod"] a[href^="/mako-vod-"]', // Broader section
                     // General link selector - potentially noisy
                    'a[href^="/mako-vod-"]:not([href*="purchase"]):not([href*="index"])',
                 ],
                fields: {
                    url: { attribute: 'href' },
                    // Try multiple selectors for name, prioritize specific ones
                    name: [
                        { selector: '.title strong' }, { selector: 'h3.title' }, { selector: 'h2.title' },
                        { selector: '.vod-title' }, { selector: '.caption' },
                        { selector: 'img', attribute: 'alt' }, // Alt text fallback
                        { text: true } // Link text last resort
                    ],
                    poster: { selector: 'img', attribute: 'src' }
                },
                base: BASE_URL,
                // Filter function specific to shows
                filter: (item) => item.url && item.name && item.name !== 'Unknown Show' &&
                                  !item.url.includes('/purchase') &&
                                  !item.url.includes('/index') &&
                                  !item.name.toLowerCase().includes('live') && // Exclude "LIVE" links
                                  !item.name.toLowerCase().includes('יחצ') && // Exclude "PR" links
                                  !item.name.toLowerCase().includes('מאקו') // Exclude generic Mako links
            },
            seasons: {
                selectors: ['div#seasonDropdown ul ul li a'],
                fields: { name: { selector: 'span' }, url: { attribute: 'href' } },
                base: url,
                filter: (item) => item.url && item.name
            },
            episodes: {
                 selectors: ['li.card a', 'a[href*="videoGuid="]', '.vod_item a', '.vod_item_wrap a'],
                 fields: {
                     name: { selector: 'strong.title' }, // Try to get a specific title element
                     url: { attribute: 'href' },
                     guid: { attribute: 'href', regex: /\/VOD-([\w-]+)\.htm/ }
                 },
                 base: url,
                 filter: (item) => item.url // Require at least a URL initially
            }
        };

        const config = configs[contentType];
        const items = [];
        const seen = new Set();

        let elements = [];
        for (const selector of config.selectors) {
            try {
                elements = $(selector).toArray();
                 if (elements.length > 0) {
                    // console.log(`Found ${elements.length} elements for ${contentType} with selector: ${selector}`);
                    break; // Use the first selector that finds elements
                 }
            } catch(selectorError) {
                 console.warn(`Selector "${selector}" failed: ${selectorError.message}`);
            }
        }
        if (elements.length === 0) console.warn(`No elements found for ${contentType} at ${url}`);


        for (const elem of elements) {
            const item = {};
            for (const [field, fieldConfig] of Object.entries(config.fields)) {
                // Special handling for array of name selectors
                if (field === 'name' && Array.isArray(fieldConfig)) {
                    for (const nameConf of fieldConfig) {
                         try {
                            const target = nameConf.selector ? $(elem).find(nameConf.selector) : $(elem);
                            if (target.length) {
                                let value = nameConf.attribute ? target.first().attr(nameConf.attribute) : (nameConf.text ? $(elem).text() : target.first().text());
                                if (value) {
                                    item[field] = value.replace(/\s+/g, ' ').trim(); // Clean whitespace
                                    break; // Found name
                                }
                            }
                         } catch(nameSelectorError){ continue; } // Ignore errors for specific name selectors
                    }
                    continue; // Move to next field after handling name array
                }

                // Regular field processing
                 try {
                    const selector = fieldConfig.selector;
                    const attr = fieldConfig.attribute;
                    const regex = fieldConfig.regex;
                    const target = selector ? $(elem).find(selector) : $(elem);

                    if (target.length) {
                        let value = attr ? target.first().attr(attr) : target.first().text().trim();
                        if (value && regex && field === 'guid') {
                            const match = value.match(regex);
                            if (match) value = match[1];
                            else value = null; // Clear value if regex must match but doesn't
                        }
                         if (value && field === 'url') {
                             value = new URL(value, config.base).href.split('?')[0].split('#')[0]; // Clean URL
                         }
                        if (value !== undefined && value !== null && value !== '') item[field] = value;
                    }
                 } catch(fieldError) { continue; } // Ignore errors for specific fields
            }

            // Check filter and uniqueness
            if (config.filter(item)) {
                const key = item.guid || item.url;
                if (key && !seen.has(key)) {
                    // Apply defaults and processing specific to type
                    if (contentType === 'shows') {
                        item.name = item.name || 'Unknown Show';
                        item.poster = processImageUrl(item.poster) || 'https://www.mako.co.il/assets/images/svg/mako_logo.svg';
                        item.background = item.poster;
                    } else if (contentType === 'episodes' && !item.name) {
                         // Try getting name from link text if strong.title fails
                         item.name = $(elem).text().replace(/\s+/g, ' ').trim() || null;
                    }

                    items.push(item);
                    seen.add(key);
                }
            }
        }

        if (contentType === 'shows') {
            console.log(`Extracted ${items.length} valid initial show items for ${url}`);
            // Load cache and apply details, but don't start background processing here
            const cache = await loadCache();
            const cacheIsFresh = Date.now() - (cache.timestamp || 0) < CACHE_TTL;
             for (const show of items) {
                 if (cache.shows && cache.shows[show.url]) {
                     const cachedData = cache.shows[show.url];
                     show.name = cachedData.name || show.name;
                     show.poster = cachedData.poster || show.poster;
                     show.background = cachedData.background || show.poster;
                 }
                 // Ensure required fields have defaults even if not in cache
                 show.name = show.name || 'Loading...';
                 show.poster = show.poster || 'https://www.mako.co.il/assets/images/svg/mako_logo.svg';
                 show.background = show.background || show.poster;
             }
             if(cacheIsFresh) console.log("Applied cached details where available.");
             else console.log("Cache is stale or empty, applying defaults.");

        } else if (contentType === 'episodes') {
             // Final GUID extraction pass
            for (const ep of items) {
                if (!ep.guid && ep.url) {
                    const match = ep.url.match(/[?&](guid|videoGuid)=([\w-]+)/i);
                    if (match) ep.guid = match[2];
                }
            }
            const validEpisodes = items.filter(ep => ep.guid);
            console.log(`Extracted ${validEpisodes.length} episodes with GUIDs for ${url}`);
            return validEpisodes;
        }

        return items; // Return shows or seasons
    } catch (e) {
        console.error(`Error in extractContent (${contentType}, ${url}):`, e.message);
        return []; // Return empty array on error
    }
};


// getVideoUrl: No changes needed from previous working version
const getVideoUrl = async (episodeUrl) => {
    console.log(`getVideoUrl: Starting process for episode URL: ${episodeUrl}`);
    try {
        // 1. Fetch Episode Page HTML
        const episodePageResponse = await axios.get(episodeUrl, {
            headers: HEADERS, timeout: REQUEST_TIMEOUT, responseType: 'text'
        });
        const $ = cheerio.load(episodePageResponse.data);
        const script = $('#__NEXT_DATA__').html();
        if (!script) { console.error("getVideoUrl: Error - Could not find __NEXT_DATA__ script tag."); return null; }

        // 2. Parse __NEXT_DATA__
        let details;
        try {
            const data = JSON.parse(script);
            const vod = data?.props?.pageProps?.data?.vod || {};
            details = { vcmid: vod.itemVcmId, galleryChannelId: vod.galleryChannelId, videoChannelId: vod.channelId };
            if (!details.vcmid || !details.galleryChannelId || !details.videoChannelId) { console.error("getVideoUrl: Error - Missing required video details:", details); return null; }
        } catch (e) { console.error("getVideoUrl: Error parsing __NEXT_DATA__ JSON:", e); return null; }

        // 3. Construct Playlist URL
        const ajaxUrl = `${BASE_URL}/AjaxPage?jspName=playlist12.jsp&vcmid=${details.vcmid}&videoChannelId=${details.videoChannelId}&galleryChannelId=${details.galleryChannelId}&consumer=responsive`;

        // 4. Fetch as ArrayBuffer and Sanitize Base64 Input
        const playlistResponse = await axios.get(ajaxUrl, {
            headers: { ...HEADERS, 'Accept': 'text/plain' },
            timeout: REQUEST_TIMEOUT,
            responseType: 'arraybuffer'
        });
        if (!playlistResponse.data || playlistResponse.data.byteLength === 0) { console.error("getVideoUrl: Error - Received empty playlist response buffer"); return null; }

        const rawText = Buffer.from(playlistResponse.data).toString('latin1');
        const base64CharsRegex = /[^A-Za-z0-9+/=]/g;
        const encryptedDataClean = rawText.replace(base64CharsRegex, '');
        if (!encryptedDataClean) { console.error("getVideoUrl: Error - Playlist data was empty after cleaning."); return null; }

        // 5. Decrypt Playlist Data
        const decrypted = cryptoOp(encryptedDataClean, "decrypt", "playlist");
        if (!decrypted) { console.error("getVideoUrl: cryptoOp returned null during playlist decryption."); return null; }

        // 6. Parse Decrypted JSON
        let playlistData;
        try {
            playlistData = JSON.parse(decrypted);
        } catch (e) { console.error("getVideoUrl: Error parsing decrypted JSON:", e.message); return null; }

        // 7. Extract HLS URL
        const media = playlistData.media || [];
        const hlsUrl = media[0]?.url;
        if (!hlsUrl) { console.error("getVideoUrl: No media URL found in playlist data"); return null; }

        // 8. Prepare Entitlement Payload
        let payload;
        try {
            payload = JSON.stringify({ lp: new URL(hlsUrl).pathname, rv: "AKAMAI" });
        } catch(urlError) { return hlsUrl; }

        // 9. Encrypt Entitlement Payload
        const encryptedPayload = cryptoOp(payload, "encrypt", "entitlement");
        if (!encryptedPayload) { console.error("getVideoUrl: Failed to encrypt entitlement payload"); return hlsUrl; }

        // 10. Fetch Entitlement Ticket
        const entitlementResponse = await axios.post(CRYPTO.entitlement.url, encryptedPayload, {
            headers: { ...HEADERS, 'Content-Type': 'text/plain;charset=UTF-8', 'Accept': 'text/plain' },
            timeout: REQUEST_TIMEOUT,
            responseType: 'text'
        });
        if (!entitlementResponse.data || !entitlementResponse.data.trim()) { return hlsUrl; }

        // 11. Clean and Decrypt Entitlement Response
        const entitlementEncryptedClean = entitlementResponse.data.replace(base64CharsRegex, '');
        if (!entitlementEncryptedClean) { return hlsUrl; }
        const entitlementDecrypted = cryptoOp(entitlementEncryptedClean, "decrypt", "entitlement");
        if (!entitlementDecrypted) { console.error("getVideoUrl: Failed to decrypt entitlement response"); return hlsUrl; }

        // 12. Parse Entitlement Data
        let entitlementData;
        try {
            entitlementData = JSON.parse(entitlementDecrypted);
        } catch (e) { return hlsUrl; }

        // 13. Extract and Append Ticket
        const tickets = entitlementData.tickets || [];
        if (tickets[0]?.ticket) {
            const separator = hlsUrl.includes('?') ? '&' : '?';
            const finalUrl = `${hlsUrl}${separator}${tickets[0].ticket}`;
            console.log("getVideoUrl: Successfully generated final URL with ticket.");
            return finalUrl;
        }

        console.log("getVideoUrl: No entitlement ticket found, using HLS URL without ticket");
        return hlsUrl;

    } catch (error) {
        if (error.response) { console.error(`getVideoUrl: Axios Error - Status: ${error.response.status}`);}
        else if (error.request) { console.error('getVideoUrl: Axios Error - No response received:', error.message); }
        else { console.error('getVideoUrl: Unexpected Error:', error.message); }
        return null;
    }
};


// --- Stremio Addon Builder & Express App ---

// Use manifest details from builder
const builder = new addonBuilder({
    id: 'org.stremio.mako-vod',
    version: '1.0.3',
    name: 'Mako VOD',
    description: 'Watch VOD content from Mako (Israeli TV)',
    logo: 'https://www.mako.co.il/assets/images/svg/mako_logo.svg',
    resources: ['catalog', 'meta', 'stream'],
    types: ['series'],
    catalogs: [{
        type: 'series',
        id: 'mako-vod-shows',
        name: 'Mako VOD Shows',
        extra: [{ name: 'search', isRequired: false }]
    }],
    behaviorHints: { adult: false, configurationRequired: false }
});

// Define handlers using the SDK
builder.defineCatalogHandler(async ({ type, id, extra }) => {
    try {
        console.log('Processing catalog request:', { type, id, extra });
        
        if (type !== 'series' || id !== 'mako-vod-shows') {
            console.log('Invalid catalog request, returning empty.');
            return { metas: [] };
        }

        const shows = await extractContent(`${BASE_URL}/mako-vod-index`, 'shows');
        const search = extra?.search?.toLowerCase() || '';
        let filteredShows = shows;
        
        if (search) {
            console.log(`Catalog: Searching for '${search}'`);
            filteredShows = shows.filter(show => show.name && show.name.toLowerCase().includes(search));
            console.log(`Catalog: Found ${filteredShows.length} matching search results`);
        } else {
            console.log(`Catalog: Returning full list (found ${shows.length} valid shows initially)`);
        }

        // Limit results significantly in production unless searching
        const limit = process.env.NODE_ENV === 'production' && !search ? 50 : 200;
        if (filteredShows.length > limit) {
            console.log(`Catalog: Limiting results from ${filteredShows.length} to ${limit}`);
            filteredShows = filteredShows.slice(0, limit);
        }

        const metas = filteredShows.map(show => ({
            id: `mako:${encodeURIComponent(show.url)}`,
            type: 'series',
            name: show.name || 'Loading...',
            poster: show.poster,
            posterShape: 'poster',
            background: show.background,
            logo: 'https://www.mako.co.il/assets/images/svg/mako_logo.svg',
            description: 'מאקו VOD',
        }));

        console.log(`Catalog: Responding with ${metas.length} metas.`);
        return { metas };
    } catch (err) {
        console.error('Catalog handler error:', err);
        return { metas: [] };
    }
});

builder.defineMetaHandler(async ({ type, id }) => {
    try {
        console.log('Processing meta request:', { type, id });

        if (type !== 'series' || !id.startsWith('mako:')) {
            return { meta: null };
        }

        const showUrl = decodeURIComponent(id.replace('mako:', ''));
        if (!showUrl.startsWith(BASE_URL)) {
            console.error('Invalid show URL derived from meta ID:', showUrl);
            return { meta: null };
        }

        const cache = await loadCache();
        const cachedShowData = cache.shows ? cache.shows[showUrl] : null;
        let showName = cachedShowData?.name;
        let showPoster = cachedShowData?.poster;
        let showBackground = cachedShowData?.background;
        let needsSave = false;

        const isCacheFresh = Date.now() - (cache.timestamp || 0) < CACHE_TTL;
        if (!cachedShowData || !isCacheFresh) {
            console.log(`Meta: Cache miss or stale for ${showUrl}, fetching details...`);
            const showDetails = await extractShowName(showUrl);
            showName = showDetails?.name && showDetails.name !== 'Unknown Show' && showDetails.name !== 'Error Loading' ? showDetails.name : (showName || 'Unknown Show');
            showPoster = showDetails?.poster || showPoster || 'https://www.mako.co.il/assets/images/svg/mako_logo.svg';
            showBackground = showDetails?.background || showBackground || showPoster;

            if(showDetails && showDetails.name && showDetails.name !== 'Unknown Show' && showDetails.name !== 'Error Loading') {
                if (!cache.shows) cache.shows = {};
                if (!cache.shows[showUrl]) cache.shows[showUrl] = {};
                cache.shows[showUrl] = {
                    name: showName,
                    poster: showPoster,
                    background: showBackground,
                    lastUpdated: Date.now()
                };
                needsSave = true;
            } else {
                console.warn(`Meta: Failed to fetch valid details for ${showUrl}, using placeholders/stale data.`);
                showName = showName || 'Failed to Load';
            }
        } else {
            showName = showName || 'Loading...';
            showPoster = showPoster || 'https://www.mako.co.il/assets/images/svg/mako_logo.svg';
            showBackground = showBackground || showPoster;
        }

        if(needsSave) saveCache(cache).catch(e => console.error("Async cache save failed:", e));

        // --- Fetch Episodes ---
        console.log(`Meta: Fetching episodes for ${showName} (${showUrl})`);
        const seasons = await extractContent(showUrl, 'seasons');
        let episodesToProcess = [];

        if (!seasons || seasons.length === 0) {
            episodesToProcess = await extractContent(showUrl, 'episodes');
            if (episodesToProcess.length > 0) episodesToProcess.forEach((ep, i) => { ep.seasonNum = 1; ep.episodeNum = i + 1; });
        } else {
            console.log(`Meta: Processing all ${seasons.length} seasons for ${showName}`);
            
            // Process seasons in parallel with rate limiting
            const batchSize = 5; // Increased from 3 to 5 seasons at a time
            const seasonBatches = [];
            
            for (let i = 0; i < seasons.length; i += batchSize) {
                const batch = seasons.slice(i, i + batchSize);
                const batchPromises = batch.map(async (season) => {
                    const seasonNum = parseInt(season.name?.match(/\d+/)?.[0] || '1');
                    console.log(`Meta: Processing season ${seasonNum}: ${season.name || season.url}`);
                    
                    // Check cache for season episodes
                    const cacheKey = `season:${season.url}`;
                    let episodes = null;
                    
                    if (cache.seasons && cache.seasons[cacheKey] && isCacheFresh) {
                        console.log(`Meta: Using cached episodes for season ${seasonNum}`);
                        episodes = cache.seasons[cacheKey];
                    } else {
                        // Increased timeout for episode fetching
                        const response = await axios.get(season.url, { 
                            headers: HEADERS, 
                            timeout: REQUEST_TIMEOUT * 2 // Double the timeout
                        });
                        episodes = await extractContent(season.url, 'episodes');
                        // Cache the episodes
                        if (!cache.seasons) cache.seasons = {};
                        cache.seasons[cacheKey] = episodes;
                        needsSave = true;
                    }
                    
                    episodes.forEach((ep, i) => { 
                        ep.seasonNum = seasonNum; 
                        ep.episodeNum = i + 1; 
                    });
                    
                    console.log(`Meta: Added ${episodes.length} episodes from season ${seasonNum}`);
                    return episodes;
                });
                
                const batchResults = await Promise.all(batchPromises);
                episodesToProcess.push(...batchResults.flat());
                await sleep(50); // Reduced delay between batches since we're processing more at once
            }
            
            console.log(`Meta: Completed processing all ${seasons.length} seasons, total episodes: ${episodesToProcess.length}`);
            
            // Save updated cache if needed
            if (needsSave) {
                await saveCache(cache);
            }
        }

        // Sort and map episodes
        episodesToProcess.sort((a, b) => (a.seasonNum - b.seasonNum) || (a.episodeNum - b.episodeNum));
        const videos = episodesToProcess.map(ep => ({
            id: `${id}:ep:${ep.guid}`,
            title: ep.name || `Episode ${ep.episodeNum}`,
            season: ep.seasonNum, 
            episode: ep.episodeNum, 
            released: null
        }));

        const metaResponse = {
            meta: {
                id, 
                type: 'series', 
                name: showName,
                poster: showPoster, 
                posterShape: 'poster', 
                background: showBackground,
                logo: 'https://www.mako.co.il/assets/images/svg/mako_logo.svg',
                description: 'מאקו VOD', 
                videos
            }
        };

        console.log(`Meta: Responding with ${videos.length} videos for ${showName}`);
        res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');
        res.setHeader('Content-Type', 'application/json');
        res.status(200).json(metaResponse);

    } catch (err) {
        console.error(`Meta handler top-level error for ID ${req.params.id}:`, err);
        res.status(500).json({ meta: null, error: 'Failed to process meta request' });
    }
});

builder.defineStreamHandler(async ({ type, id }) => {
    try {
        console.log('Processing stream request:', { type, id });

        if (type !== 'series' || !id.startsWith('mako:')) {
            return { streams: [] };
        }

        const [showIdRaw, episodeGuid] = id.split(':ep:');
        if (!showIdRaw || !episodeGuid) {
            return { streams: [] };
        }

        const showUrl = decodeURIComponent(showIdRaw.replace('mako:', ''));
        console.log(`Stream handler: Looking for GUID ${episodeGuid} within show ${showUrl}`);

        let episodeUrl = null;
        try {
            console.log(`Stream: Re-fetching seasons/episodes for ${showUrl} to find URL for GUID ${episodeGuid}`);
            const seasons = await extractContent(showUrl, 'seasons');
            let episodesFound = [];
            if (!seasons || seasons.length === 0) {
                episodesFound = await extractContent(showUrl, 'episodes');
            } else {
                for (const season of seasons) {
                    const episodes = await extractContent(season.url, 'episodes');
                    episodesFound.push(...episodes);
                    if (episodes.some(ep => ep.guid === episodeGuid)) break;
                    await sleep(50);
                }
            }
            const episode = episodesFound.find(ep => ep.guid === episodeGuid);
            if (episode && episode.url) {
                episodeUrl = episode.url;
                console.log(`Stream handler: Found episode URL: ${episodeUrl}`);
            } else {
                console.error(`Stream handler: Could not find episode URL for GUID ${episodeGuid} in show ${showUrl}`);
                return { streams: [] };
            }
        } catch (error) {
            console.error(`Stream handler: Error finding episode URL: ${error.message}`);
            return { streams: [] };
        }

        const videoUrl = await getVideoUrl(episodeUrl);
        if (!videoUrl) {
            console.error(`Stream handler: getVideoUrl failed for ${episodeUrl}`);
            return { streams: [] };
        }
        console.log(`Stream handler: Got video URL: ${videoUrl}`);

        const streams = [{
            url: videoUrl,
            title: 'Play',
            type: 'hls', // Specify HLS stream type
            behaviorHints: {
                notWebReady: true, // Indicate this is not a web-ready stream
                bingeGroup: 'mako-vod', // Group episodes for binge watching
                videoSize: 1920, // Indicate HD quality
                subtitleStreams: [], // No subtitles available
                audioChannels: 'stereo'
            }
        }];

        console.log(`Stream: Responding with stream for ${episodeGuid}`);
        res.setHeader('Cache-Control', 'no-store, max-age=0'); // Do not cache stream URLs
        res.setHeader('Content-Type', 'application/json');
        res.status(200).json({ streams });
    } catch (err) {
        console.error(`Stream handler error for ID ${id}:`, err);
        return { streams: [] };
    }
});

const addonInterface = builder.getInterface();

// Create Express app
const express = require('express');
const cors = require('cors');
const app = express();

// Enable CORS for all origins
app.use(cors());

// Basic logging middleware
app.use((req, res, next) => {
    console.log(`Request: ${req.method} ${req.url}`);
    next();
});

// Manifest endpoint
app.get('/manifest.json', (req, res) => {
    try {
        res.setHeader('Content-Type', 'application/json');
        res.send(addonInterface.manifest);
    } catch (err) {
        console.error("Error generating manifest:", err);
        res.status(500).json({ error: 'Failed to generate manifest' });
    }
});
// Redirect root to manifest
app.get('/', (req, res) => res.redirect('/manifest.json'));

// Catalog endpoint
app.get('/catalog/:type/:id/:extra?.json', async (req, res) => {
    try {
        const { type, id } = req.params;
        let extra = {};
        if (req.params.extra && req.params.extra.includes('search=')) {
            try { extra.search = decodeURIComponent(req.params.extra.split('search=')[1]); }
            catch(e){ console.warn("Failed to parse search extra:", req.params.extra); }
        }
        console.log('Processing catalog request:', { type, id, extra });

        if (type !== 'series' || id !== 'mako-vod-shows') {
            console.log('Invalid catalog request, returning empty.');
            return res.status(200).json({ metas: [] });
        }

        // Load cache first
        const cache = await loadCache();
        const isCacheFresh = Date.now() - (cache.timestamp || 0) < CACHE_TTL;

        // Get initial shows list
        const shows = await extractContent(`${BASE_URL}/mako-vod-index`, 'shows');
        console.log(`Extracted ${shows.length} initial shows`);

        // Filter based on search if needed
        let filteredShows = shows;
        if (extra?.search) {
            const search = extra.search.toLowerCase();
            filteredShows = shows.filter(show => 
                show.name && show.name.toLowerCase().includes(search)
            );
            console.log(`Found ${filteredShows.length} shows matching search: ${search}`);
        }

        // Create initial meta objects with basic info
        const metas = filteredShows.map(show => ({
            id: `mako:${encodeURIComponent(show.url)}`,
            type: 'series',
            name: show.name || 'Loading...',
            poster: show.poster || 'https://www.mako.co.il/assets/images/svg/mako_logo.svg',
            posterShape: 'poster',
            background: show.background || show.poster || 'https://www.mako.co.il/assets/images/svg/mako_logo.svg',
            logo: 'https://www.mako.co.il/assets/images/svg/mako_logo.svg',
            description: 'מאקו VOD',
        }));

        // Send response immediately with basic info
        console.log(`Catalog: Responding with ${metas.length} metas (initial load)`);
        res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=600');
        res.setHeader('Content-Type', 'application/json');
        res.status(200).json({ metas });

        // Process show details in the background
        if (!isCacheFresh) {
            console.log('Starting background processing of show details...');
            const batchSize = 5;
            const processedShows = [];

            for (let i = 0; i < filteredShows.length; i += batchSize) {
                const batch = filteredShows.slice(i, i + batchSize);
                const batchPromises = batch.map(async (show) => {
                    // Skip if already in cache and fresh
                    if (cache.shows && cache.shows[show.url] && isCacheFresh) {
                        return null;
                    }

                    // Fetch fresh details
                    console.log(`Background: Fetching details for ${show.url}`);
                    const details = await extractShowName(show.url);
                    if (details && details.name && details.name !== 'Unknown Show' && details.name !== 'Error Loading') {
                        // Update cache
                        if (!cache.shows) cache.shows = {};
                        cache.shows[show.url] = {
                            name: details.name,
                            poster: details.poster,
                            background: details.background,
                            lastUpdated: Date.now()
                        };
                        return {
                            ...show,
                            name: details.name,
                            poster: details.poster,
                            background: details.background
                        };
                    }
                    return null;
                });

                const batchResults = await Promise.all(batchPromises);
                processedShows.push(...batchResults.filter(Boolean));
                await sleep(100);
            }

            // Save updated cache if we processed any shows
            if (processedShows.length > 0) {
                console.log(`Background: Processed ${processedShows.length} shows, saving cache...`);
                await saveCache(cache);
            }
        }

    } catch (err) {
        console.error('Catalog handler error:', err);
        res.status(500).json({ metas: [], error: 'Failed to process catalog request' });
    }
});

// Meta endpoint
app.get('/meta/:type/:id.json', async (req, res) => {
     try {
        const { type, id } = req.params;
        console.log('Processing meta request:', { type, id });

        if (type !== 'series' || !id.startsWith('mako:')) {
            return res.status(404).json({ meta: null, err: 'Invalid meta ID format' });
        }

        const showUrl = decodeURIComponent(id.replace('mako:', ''));
        if (!showUrl.startsWith(BASE_URL)) {
             console.error('Invalid show URL derived from meta ID:', showUrl);
             return res.status(400).json({ meta: null, err: 'Invalid show URL' });
        }

        // --- Meta Logic ---
        const cache = await loadCache();
        const cachedShowData = cache.shows ? cache.shows[showUrl] : null;
        let showName = cachedShowData?.name;
        let showPoster = cachedShowData?.poster;
        let showBackground = cachedShowData?.background;
        let needsSave = false;

        const isCacheFresh = Date.now() - (cache.timestamp || 0) < CACHE_TTL;
        if (!cachedShowData || !isCacheFresh) {
             console.log(`Meta: Cache miss or stale for ${showUrl}, fetching details...`);
             const showDetails = await extractShowName(showUrl);
             showName = showDetails?.name && showDetails.name !== 'Unknown Show' && showDetails.name !== 'Error Loading' ? showDetails.name : (showName || 'Unknown Show');
             showPoster = showDetails?.poster || showPoster || 'https://www.mako.co.il/assets/images/svg/mako_logo.svg';
             showBackground = showDetails?.background || showBackground || showPoster;

             if(showDetails && showDetails.name && showDetails.name !== 'Unknown Show' && showDetails.name !== 'Error Loading') {
                 if (!cache.shows) cache.shows = {};
                 if (!cache.shows[showUrl]) cache.shows[showUrl] = {};
                 cache.shows[showUrl] = {
                     name: showName,
                     poster: showPoster,
                     background: showBackground,
                     lastUpdated: Date.now()
                 };
                 needsSave = true;
             } else {
                 console.warn(`Meta: Failed to fetch valid details for ${showUrl}, using placeholders/stale data.`);
                 showName = showName || 'Failed to Load';
             }
        } else {
             showName = showName || 'Loading...';
             showPoster = showPoster || 'https://www.mako.co.il/assets/images/svg/mako_logo.svg';
             showBackground = showBackground || showPoster;
        }

        if(needsSave) saveCache(cache).catch(e => console.error("Async cache save failed:", e));

        // --- Fetch Episodes ---
        console.log(`Meta: Fetching episodes for ${showName} (${showUrl})`);
        const seasons = await extractContent(showUrl, 'seasons');
        let episodesToProcess = [];

        if (!seasons || seasons.length === 0) {
            episodesToProcess = await extractContent(showUrl, 'episodes');
            if (episodesToProcess.length > 0) episodesToProcess.forEach((ep, i) => { ep.seasonNum = 1; ep.episodeNum = i + 1; });
        } else {
            console.log(`Meta: Processing all ${seasons.length} seasons for ${showName}`);
            
            // Process seasons in parallel with rate limiting
            const batchSize = 5; // Increased from 3 to 5 seasons at a time
            const seasonBatches = [];
            
            for (let i = 0; i < seasons.length; i += batchSize) {
                const batch = seasons.slice(i, i + batchSize);
                const batchPromises = batch.map(async (season) => {
                    const seasonNum = parseInt(season.name?.match(/\d+/)?.[0] || '1');
                    console.log(`Meta: Processing season ${seasonNum}: ${season.name || season.url}`);
                    
                    // Check cache for season episodes
                    const cacheKey = `season:${season.url}`;
                    let episodes = null;
                    
                    if (cache.seasons && cache.seasons[cacheKey] && isCacheFresh) {
                        console.log(`Meta: Using cached episodes for season ${seasonNum}`);
                        episodes = cache.seasons[cacheKey];
                    } else {
                        // Increased timeout for episode fetching
                        const response = await axios.get(season.url, { 
                            headers: HEADERS, 
                            timeout: REQUEST_TIMEOUT * 2 // Double the timeout
                        });
                        episodes = await extractContent(season.url, 'episodes');
                        // Cache the episodes
                        if (!cache.seasons) cache.seasons = {};
                        cache.seasons[cacheKey] = episodes;
                        needsSave = true;
                    }
                    
                    episodes.forEach((ep, i) => { 
                        ep.seasonNum = seasonNum; 
                        ep.episodeNum = i + 1; 
                    });
                    
                    console.log(`Meta: Added ${episodes.length} episodes from season ${seasonNum}`);
                    return episodes;
                });
                
                const batchResults = await Promise.all(batchPromises);
                episodesToProcess.push(...batchResults.flat());
                await sleep(50); // Reduced delay between batches since we're processing more at once
            }
            
            console.log(`Meta: Completed processing all ${seasons.length} seasons, total episodes: ${episodesToProcess.length}`);
            
            // Save updated cache if needed
            if (needsSave) {
                await saveCache(cache);
            }
        }

        // Sort and map episodes
        episodesToProcess.sort((a, b) => (a.seasonNum - b.seasonNum) || (a.episodeNum - b.episodeNum));
        const videos = episodesToProcess.map(ep => ({
            id: `${id}:ep:${ep.guid}`,
            title: ep.name || `Episode ${ep.episodeNum}`,
            season: ep.seasonNum, 
            episode: ep.episodeNum, 
            released: null
        }));
        // --- End Meta Logic ---

        const metaResponse = {
            meta: {
                id, 
                type: 'series', 
                name: showName,
                poster: showPoster, 
                posterShape: 'poster', 
                background: showBackground,
                logo: 'https://www.mako.co.il/assets/images/svg/mako_logo.svg',
                description: 'מאקו VOD', 
                videos
            }
        };

        console.log(`Meta: Responding with ${videos.length} videos for ${showName}`);
        res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');
        res.setHeader('Content-Type', 'application/json');
        res.status(200).json(metaResponse);

     } catch (err) {
         console.error(`Meta handler top-level error for ID ${req.params.id}:`, err);
         res.status(500).json({ meta: null, error: 'Failed to process meta request' });
     }
});


// Define stream endpoint
app.get('/stream/:type/:id.json', async (req, res) => {
     try {
        const { type, id } = req.params;
        console.log('Processing stream request:', { type, id });

        if (type !== 'series' || !id.startsWith('mako:')) {
            return res.status(404).json({ streams: [], err: 'Invalid stream ID format' });
        }

        const [showIdRaw, episodeGuid] = id.split(':ep:');
        if (!showIdRaw || !episodeGuid) {
            return res.status(400).json({ streams: [], err: 'Invalid stream ID format (missing GUID)' });
        }

        const showUrl = decodeURIComponent(showIdRaw.replace('mako:', ''));
        console.log(`Stream handler: Looking for GUID ${episodeGuid} within show ${showUrl}`);

        // --- Stream Logic ---
        let episodeUrl = null;
        try {
            // Load cache first
            const cache = await loadCache();
            const isCacheFresh = Date.now() - (cache.timestamp || 0) < CACHE_TTL;

            console.log(`Stream: Fetching seasons for ${showUrl} to find URL for GUID ${episodeGuid}`);
            const seasons = await extractContent(showUrl, 'seasons');
            let episodesFound = [];

            if (!seasons || seasons.length === 0) {
                episodesFound = await extractContent(showUrl, 'episodes');
            } else {
                // Process seasons in parallel with rate limiting
                const batchSize = 5; // Process 5 seasons at a time
                
                for (let i = 0; i < seasons.length; i += batchSize) {
                    const batch = seasons.slice(i, i + batchSize);
                    const batchPromises = batch.map(async (season) => {
                        const seasonNum = parseInt(season.name?.match(/\d+/)?.[0] || '1');
                        console.log(`Stream: Processing season ${seasonNum}: ${season.name || season.url}`);
                        
                        // Check cache for season episodes
                        const cacheKey = `season:${season.url}`;
                        let episodes = null;
                        
                        if (cache.seasons && cache.seasons[cacheKey] && isCacheFresh) {
                            console.log(`Stream: Using cached episodes for season ${seasonNum}`);
                            episodes = cache.seasons[cacheKey];
                        } else {
                            // Increased timeout for episode fetching
                            const response = await axios.get(season.url, { 
                                headers: HEADERS, 
                                timeout: REQUEST_TIMEOUT * 2 // Double the timeout
                            });
                            episodes = await extractContent(season.url, 'episodes');
                            // Cache the episodes
                            if (!cache.seasons) cache.seasons = {};
                            cache.seasons[cacheKey] = episodes;
                        }
                        
                        return episodes;
                    });
                    
                    const batchResults = await Promise.all(batchPromises);
                    const flatEpisodes = batchResults.flat();
                    episodesFound.push(...flatEpisodes);
                    
                    // Check if we found the episode in this batch
                    const foundEpisode = flatEpisodes.find(ep => ep.guid === episodeGuid);
                    if (foundEpisode) {
                        episodeUrl = foundEpisode.url;
                        console.log(`Stream handler: Found episode URL in season ${i/batchSize + 1}: ${episodeUrl}`);
                        break; // Exit the loop once we find the episode
                    }
                    
                    await sleep(50); // Small delay between batches
                }
            }

            // If we haven't found the episode yet, check the episodes we found
            if (!episodeUrl) {
                const episode = episodesFound.find(ep => ep.guid === episodeGuid);
                if (episode && episode.url) {
                    episodeUrl = episode.url;
                    console.log(`Stream handler: Found episode URL: ${episodeUrl}`);
                } else {
                    console.error(`Stream handler: Could not find episode URL for GUID ${episodeGuid} in show ${showUrl}`);
                    return res.status(404).json({ streams: [], err: 'Episode URL not found' });
                }
            }

            // Save updated cache if needed
            if (cache.seasons) {
                await saveCache(cache);
            }

        } catch (error) {
            console.error(`Stream handler: Error finding episode URL: ${error.message}`);
            return res.status(500).json({ streams: [], err: 'Error finding episode URL' });
        }

        // Get the HLS Video URL
        const videoUrl = await getVideoUrl(episodeUrl);
        if (!videoUrl) {
            console.error(`Stream handler: getVideoUrl failed for ${episodeUrl}`);
            return res.status(500).json({ streams: [], err: 'Failed to retrieve video stream URL' });
        }
        console.log(`Stream handler: Got video URL: ${videoUrl}`);

        const streams = [{
            url: videoUrl,
            title: 'Play',
            type: 'hls', // Specify HLS stream type
            behaviorHints: {
                notWebReady: true, // Indicate this is not a web-ready stream
                bingeGroup: 'mako-vod', // Group episodes for binge watching
                videoSize: 1920, // Indicate HD quality
                subtitleStreams: [], // No subtitles available
                audioChannels: 'stereo'
            }
        }];

        console.log(`Stream: Responding with stream for ${episodeGuid}`);
        res.setHeader('Cache-Control', 'no-store, max-age=0'); // Do not cache stream URLs
        res.setHeader('Content-Type', 'application/json');
        res.status(200).json({ streams });

     } catch (err) {
         console.error(`Stream handler top-level error for ID ${req.params.id}:`, err);
         res.status(500).json({ streams: [], error: 'Failed to process stream request' });
     }
});


// Handle other requests (404)
app.use((req, res) => {
    console.warn('Unknown request:', req.method, req.url);
    res.status(404).json({ error: 'Not Found' });
});

// Export the app for Vercel
module.exports = app;

// --- Local Development Server (only if not in production) ---
if (process.env.NODE_ENV !== 'production') {
    const PORT = process.env.PORT || 8000;
    app.listen(PORT, () => {
         console.log(`\n--- LOCAL DEVELOPMENT SERVER ---`);
         console.log(`🚀 Mako VOD Stremio Add-on running at http://127.0.0.1:${PORT}/manifest.json`);
         console.log(`Add to Stremio: stremio://127.0.0.1:${PORT}/manifest.json`);
         console.log(`---------------------------------\n`);
    });
}