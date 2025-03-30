// index.js
const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const { CRYPTO, cryptoOp } = require('./crypto'); // Use external crypto

// ** Log NODE_ENV on startup **
console.log(`Current NODE_ENV: ${process.env.NODE_ENV}`);

// Import Vercel Blob for serverless storage
let blob;
if (process.env.NODE_ENV === 'production') {
    try {
        const vercelBlob = require('@vercel/blob');
        blob = { put: vercelBlob.put, list: vercelBlob.list, head: vercelBlob.head, del: vercelBlob.del }; // Include head/del
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
const DELAY_BETWEEN_REQUESTS = 500; // Slightly reduce delay?
const MAX_RETRIES = 3;
const REQUEST_TIMEOUT = 10000;
const BLOB_CACHE_KEY = 'mako-shows-cache-v1.json'; // Version cache key slightly

// Headers for requests (remains same)
const HEADERS = { /* ... */ };
HEADERS['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'; // Example updated UA

// In-memory cache
let memoryCache = null;
let memoryCacheTimestamp = 0;

// --- Cache Management (Modified for Blob) ---
const loadCache = async () => {
    const now = Date.now();
    // Return recent memory cache immediately
    if (memoryCache && (now - memoryCacheTimestamp < 60 * 1000)) { // Cache memory for 1 min
        // console.log("Using recent memory cache.");
        return memoryCache;
    }

    if (blob) { // Only attempt blob if initialized
        try {
            console.log(`Attempting to load cache blob: ${BLOB_CACHE_KEY}`);
            // Use head to check existence and metadata first (more efficient)
            const headResult = await blob.head(BLOB_CACHE_KEY).catch(err => {
                if (err.status === 404) return null; // Handle not found gracefully
                throw err; // Rethrow other errors
            });

            if (headResult) {
                console.log(`Found cache blob: ${headResult.pathname}, Size: ${headResult.size}, URL: ${headResult.url}`);
                // Optional: Check headResult.uploadedAt if needed for TTL validation before fetching
                const response = await axios.get(headResult.url, { timeout: 5000 }); // Short timeout for cache fetch
                if (typeof response.data !== 'object' || response.data === null) {
                     throw new Error("Fetched cache data is not a valid object");
                }
                memoryCache = response.data;
                memoryCacheTimestamp = now; // Update timestamp
                console.log(`Loaded cache from Blob with ${Object.keys(memoryCache.shows || {}).length} items.`);
                return memoryCache;
            } else {
                console.log("Cache blob not found. Initializing empty cache.");
                memoryCache = { timestamp: now, shows: {} };
                memoryCacheTimestamp = now;
                return memoryCache;
            }
        } catch (e) {
            console.error("Error loading cache from Blob storage:", e.message);
            // Fallback to empty cache on error
            memoryCache = { timestamp: Date.now(), shows: {} };
            memoryCacheTimestamp = now;
            return memoryCache;
        }
    } else { // Local development or Blob failed to init
        // console.log("Using local file system cache (or empty if none).");
        try {
            if (fs.existsSync(CACHE_FILE)) {
                const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
                memoryCache = data;
                memoryCacheTimestamp = now;
                return memoryCache;
            }
        } catch (e) {
            console.error("Error loading cache from file:", e.message);
        }
        // Default to empty if file doesn't exist or fails parsing
        memoryCache = { timestamp: now, shows: {} };
        memoryCacheTimestamp = now;
        return memoryCache;
    }
};

const saveCache = async (cache) => {
    cache.timestamp = Date.now(); // Ensure timestamp is updated
    memoryCache = cache; // Update memory cache immediately
    memoryCacheTimestamp = Date.now();

    if (blob) { // Only attempt blob if initialized
        try {
            console.log(`Attempting to save cache (${Object.keys(cache.shows || {}).length} items) to Blob: ${BLOB_CACHE_KEY}`);
            await blob.put(BLOB_CACHE_KEY, JSON.stringify(cache), {
                access: 'public', // Must be public to allow fetching via URL
                contentType: 'application/json',
                // Optional: Add caching headers for CDN
                // cacheControl: 'public, max-age=600' // Cache for 10 minutes
            });
            console.log("Cache saved successfully to Vercel Blob");
        } catch (e) {
            console.error("Error saving cache to Blob storage:", e.message);
        }
    } else { // Local development or Blob failed to init
        try {
            // console.log("Saving cache to local file.");
            const cacheDir = path.dirname(CACHE_FILE);
            if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
            fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
            // console.log("Cache saved successfully to file");
        } catch (e) {
            console.error("Error saving cache to file:", e.message);
        }
    }
};

// --- Helper Functions ---
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const processImageUrl = (url) => { /* ... no changes ... */ };

// --- Data Extraction Functions ---

// extractShowName: Modified slightly for clarity
const extractShowName = async (url) => {
    try {
        // console.log(`Extracting show name from ${url}`);
        const response = await axios.get(url, { headers: HEADERS, timeout: REQUEST_TIMEOUT, maxRedirects: 5 });
        const $ = cheerio.load(response.data);
        const jsonldTag = $('script[type="application/ld+json"]').html();

        if (!jsonldTag) {
            // Fallback: Try og:title or h1
            const ogTitle = $('meta[property="og:title"]').attr('content');
            const h1Title = $('h1').first().text().trim();
            const fallbackName = ogTitle || h1Title || null;
             if(fallbackName) console.log(`No JSON-LD, using fallback name: ${fallbackName} for ${url}`);
             else console.log(`No JSON-LD or fallback name found for ${url}`);
             // Still try to get images even if name is fallback
             // ... (image extraction logic copied from below) ...
             let poster = $('meta[property="og:image"]').attr('content') || /* ... other selectors ... */ null;
             let background = $('meta[property="og:image:width"][content="1920"]').parent().attr('content') || poster;
             poster = processImageUrl(poster);
             background = processImageUrl(background);
             // ... default image logic ...
             return { name: fallbackName, poster, background };

        }

        const data = JSON.parse(jsonldTag);
        // console.log(`Found JSON-LD data type: ${data['@type']} for ${url}`);

        let name;
        if (data['@type'] === 'TVSeason' && data.partOfTVSeries?.name) {
            name = data.partOfTVSeries.name;
        } else {
            name = data.name;
        }

        if (data.containsSeason && Array.isArray(data.containsSeason) && data.containsSeason.length > 1) {
             name = `${name} (${data.containsSeason.length} עונות)`;
        }

        // Get poster and background images (keep your existing logic)
        let poster = $('meta[property="og:image"]').attr('content') || /* ... */ null;
        let background = $('meta[property="og:image:width"][content="1920"]').parent().attr('content') || poster;
        poster = processImageUrl(poster);
        background = processImageUrl(background);
        if (!poster || poster.includes('_next/static')) poster = 'https://www.mako.co.il/assets/images/svg/mako_logo.svg';
        if (!background || background.includes('_next/static')) background = poster;

        // console.log(`Extracted show details for ${url}: Name: ${name}`);
        return { name, poster, background };
    } catch (e) {
        console.error(`Error extracting show name from ${url}:`, e.message);
        return null; // Return null on error
    }
};

// processShowNames: No changes needed from previous version assuming it's called correctly
const processShowNames = async (shows, cache, cacheIsFresh, maxShows = null) => { /* ... keep as is ... */ };


// extractContent: Modified Show Name Extraction Part
const extractContent = async (url, contentType) => {
    try {
        await sleep(DELAY_BETWEEN_REQUESTS);
        // console.log(`Workspaceing ${contentType} from ${url}`);
        const response = await axios.get(url, { headers: HEADERS, timeout: REQUEST_TIMEOUT });
        const $ = cheerio.load(response.data);

        // configs remain same...
        const configs = {
             shows: {
                selectors: [
                    // More specific selectors first
                    '.vod_item_wrap article a[href^="/mako-vod-"]',
                    '.vod_item article a[href^="/mako-vod-"]',
                    'li.grid-item a[href^="/mako-vod-"]', // Common grid item pattern
                     // General selectors last
                    'a[href^="/mako-vod-"]:not([href*="purchase"]):not([href*="index"])',
                 ],
                fields: {
                    url: { attribute: 'href' },
                    // Try more specific name selectors within the link's container
                    name: [ // Array of selectors to try for name
                        { selector: '.title strong' }, // Common pattern
                        { selector: 'h3.title' },
                        { selector: 'div.caption' },
                        { selector: 'img', attribute: 'alt' }, // Image alt as fallback
                        { text: true } // Link text itself as last resort
                    ],
                    poster: { selector: 'img', attribute: 'src' }
                },
                base: BASE_URL
            },
            seasons: { /* ... */ },
            episodes: { /* ... */ }
        };


        const config = configs[contentType];
        const items = [];
        const seen = new Set();

        let elements = [];
        for (const selector of config.selectors) {
            elements = $(selector).toArray();
            if (elements.length) {
                // console.log(`Found ${elements.length} elements with selector: ${selector}`);
                break;
            }
        }

        if (contentType === 'shows') {
            console.log(`Processing ${elements.length} potential show elements`);
        }

        for (const elem of elements) {
            const item = {};
            let foundName = null; // Track found name

            for (const [field, fieldConfig] of Object.entries(config.fields)) {

                // Special handling for name array
                if (field === 'name' && Array.isArray(fieldConfig)) {
                    for (const nameConf of fieldConfig) {
                        const target = nameConf.selector ? $(elem).find(nameConf.selector) : $(elem);
                         if (target.length) {
                             let value = nameConf.attribute ? target.attr(nameConf.attribute) : (nameConf.text ? $(elem).text().trim() : target.text().trim());
                             if (value) {
                                 foundName = value.replace(/\s+/g, ' ').trim(); // Clean whitespace
                                 item[field] = foundName;
                                 break; // Stop after finding the first valid name
                             }
                         }
                    }
                    continue; // Move to next field
                }

                // Regular field processing
                const selector = fieldConfig.selector;
                const attr = fieldConfig.attribute;
                const regex = fieldConfig.regex;

                const target = selector ? $(elem).find(selector) : $(elem);
                if (!target.length) continue;

                let value = attr ? target.attr(attr) : target.text().trim();

                if (value && regex && field === 'guid') {
                    const match = value.match(regex);
                    if (match) value = match[1];
                }

                if (value && field === 'url') {
                    // Ensure URL is absolute and clean query params/fragments if needed
                    try {
                       value = new URL(value, config.base).href.split('?')[0].split('#')[0];
                    } catch(urlError){ continue; } // Skip if invalid URL
                }

                if (value !== undefined && value !== null) item[field] = value;
            }

            // Add item if valid URL and name (for shows) or essential fields exist
             if ((contentType === 'shows' && item.url && item.name) ||
                (contentType === 'seasons' && item.url && item.name) ||
                (contentType === 'episodes' && item.url))
             {
                const key = item.guid || item.url;
                if (key && !seen.has(key)) {
                    if (contentType === 'shows') {
                        item.name = item.name || 'Unknown Show'; // Fallback name
                        item.poster = processImageUrl(item.poster);
                         if (item.poster && item.poster.includes('_next/static')) {
                            item.poster = 'https://www.mako.co.il/assets/images/svg/mako_logo.svg';
                         }
                        item.background = item.poster; // Default background to poster
                        // console.log(`Found show item: ${item.name} at ${item.url}`);
                    }
                    items.push(item);
                    seen.add(key);
                }
            }
        }

         if (contentType === 'shows') {
            console.log(`Found ${items.length} initial show items after processing elements.`);
             // Filter out clearly invalid shows early
             items = items.filter(show => show.name && show.name !== 'Unknown Show' && !show.name.includes('יחצ') && !show.url.includes('/index'));
             console.log(`Found ${items.length} potentially valid shows after initial filter.`);

            // Load cache and apply cached details
            const cache = await loadCache();
            const cacheIsFresh = Date.now() - (cache.timestamp || 0) < CACHE_TTL;
            let cachedCount = 0;

             for (const show of items) {
                 if (cache.shows && cache.shows[show.url]) {
                     const cachedData = cache.shows[show.url];
                     show.name = cachedData.name || show.name;
                     show.poster = cachedData.poster || show.poster;
                     show.background = cachedData.background || show.poster;
                     if(cacheIsFresh) cachedCount++; // Only count if cache is fresh
                 } else {
                     // Ensure defaults if not in cache
                     show.poster = show.poster || 'https://www.mako.co.il/assets/images/svg/mako_logo.svg';
                     show.background = show.poster;
                 }
             }

            if (cachedCount && cacheIsFresh) console.log(`Applied ${cachedCount} show details from fresh cache.`);
            else if (!cacheIsFresh) console.log("Cache is stale, full details will be fetched on demand by meta handler.");


            // IMPORTANT: In serverless, DO NOT trigger background processing here.
            // Let the meta handler fetch details when needed.
            // console.log("Skipping background name processing in extractContent.");
        }
         else if (contentType === 'episodes') {
             // Episode GUID extraction remains same
            for (const ep of items) {
                if (!ep.guid && ep.url) {
                    const match = ep.url.match(/[?&](guid|videoGuid)=([\w-]+)/i);
                    if (match) ep.guid = match[2];
                }
            }
            return items.filter(ep => ep.guid); // Only return episodes with GUID
        }


        return items; // Return shows or seasons
    } catch (e) {
        console.error(`Error extracting ${contentType} from ${url}:`, e.message);
        return []; // Return empty array on error
    }
};


// getVideoUrl: No changes needed from previous working version
const getVideoUrl = async (episodeUrl) => { /* ... keep the last working version ... */ };
const getVideoUrl = async (episodeUrl) => {
    console.log(`getVideoUrl: Starting process for episode URL: ${episodeUrl}`);
    try {
        // 1. Fetch Episode Page HTML
        console.log(`getVideoUrl: Fetching episode page HTML...`);
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
            console.log("getVideoUrl: Successfully extracted video details:", details);
        } catch (e) { console.error("getVideoUrl: Error parsing __NEXT_DATA__ JSON:", e); return null; }

        // 3. Construct Playlist URL
        const ajaxUrl = `${BASE_URL}/AjaxPage?jspName=playlist12.jsp&vcmid=${details.vcmid}&videoChannelId=${details.videoChannelId}&galleryChannelId=${details.galleryChannelId}&consumer=responsive`;
        console.log(`getVideoUrl: Fetching encrypted playlist from: ${ajaxUrl}`);

        // 4. Fetch as ArrayBuffer and Sanitize Base64 Input
        const playlistResponse = await axios.get(ajaxUrl, {
            headers: { ...HEADERS, 'Accept': 'text/plain' }, // Simpler accept header
            timeout: REQUEST_TIMEOUT,
            responseType: 'arraybuffer'
        });
        if (!playlistResponse.data || playlistResponse.data.byteLength === 0) { /* ... error handling ... */ return null; }

        const rawText = Buffer.from(playlistResponse.data).toString('latin1');
        const base64CharsRegex = /[^A-Za-z0-9+/=]/g;
        const encryptedDataClean = rawText.replace(base64CharsRegex, '');
        if (!encryptedDataClean) { /* ... error handling ... */ return null; }
        // console.log(`getVideoUrl: Cleaned Base64 playlist data length: ${encryptedDataClean.length}`);

        // 5. Decrypt Playlist Data
        // console.log("getVideoUrl: Attempting playlist decryption...");
        const decrypted = cryptoOp(encryptedDataClean, "decrypt", "playlist");
        if (!decrypted) { console.error("getVideoUrl: cryptoOp returned null during playlist decryption."); return null; }

        // 6. Parse Decrypted JSON
        let playlistData;
        try {
            playlistData = JSON.parse(decrypted);
            console.log("getVideoUrl: Successfully parsed playlist data");
        } catch (e) { /* ... error handling ... */ return null; }

        // 7. Extract HLS URL
        const media = playlistData.media || [];
        const hlsUrl = media[0]?.url;
        if (!hlsUrl) { /* ... error handling ... */ return null; }
        console.log("getVideoUrl: Found HLS URL:", hlsUrl);

        // 8. Prepare Entitlement Payload
        let payload;
         try {
             payload = JSON.stringify({ lp: new URL(hlsUrl).pathname, rv: "AKAMAI" });
         } catch(urlError) {
             console.error("getVideoUrl: Error creating entitlement payload - Invalid HLS URL?", hlsUrl, urlError);
             return hlsUrl; // Fallback to non-tokenized URL if parsing fails
         }
        // console.log("getVideoUrl: Prepared entitlement payload:", payload);

        // 9. Encrypt Entitlement Payload
        const encryptedPayload = cryptoOp(payload, "encrypt", "entitlement");
        if (!encryptedPayload) { console.error("getVideoUrl: Failed to encrypt entitlement payload"); return hlsUrl; }

        // 10. Fetch Entitlement Ticket
        const entitlementResponse = await axios.post(CRYPTO.entitlement.url, encryptedPayload, {
            headers: { ...HEADERS, 'Content-Type': 'text/plain;charset=UTF-8', 'Accept': 'text/plain' },
            timeout: REQUEST_TIMEOUT,
            responseType: 'text'
        });
        if (!entitlementResponse.data || !entitlementResponse.data.trim()) { /* ... error handling ... */ return hlsUrl; }

        // 11. Clean and Decrypt Entitlement Response
        const entitlementEncryptedClean = entitlementResponse.data.replace(base64CharsRegex, '');
        if (!entitlementEncryptedClean) { /* ... error handling ... */ return hlsUrl; }
        const entitlementDecrypted = cryptoOp(entitlementEncryptedClean, "decrypt", "entitlement");
        if (!entitlementDecrypted) { console.error("getVideoUrl: Failed to decrypt entitlement response"); return hlsUrl; }

        // 12. Parse Entitlement Data
        let entitlementData;
        try {
            entitlementData = JSON.parse(entitlementDecrypted);
        } catch (e) { /* ... error handling ... */ return hlsUrl; }

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

    } catch (error) { /* ... error handling ... */ return null; }
};


// --- Stremio Addon Builder & Express App ---

const builder = new addonBuilder({ /* ... same config ... */ });
const addonInterface = builder.getInterface(); // Use manifest from here

// Create Express app for serverless
const express = require('express');
const cors = require('cors');
const { url } = require('inspector'); // Is this needed? Seems unused.

const app = express();
app.use(cors()); // Enable CORS for all routes

// Optional: Add basic logging middleware
app.use((req, res, next) => {
    console.log(`Request: ${req.method} ${req.url}`);
    // Log key headers for debugging Vercel requests
     if (process.env.NODE_ENV === 'production') {
        console.log(`Headers: x-forwarded-for=${req.headers['x-forwarded-for']}, x-vercel-id=${req.headers['x-vercel-id']}`);
    }
    next();
});


// Define manifest endpoint using the builder's manifest
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


// Define catalog endpoint
app.get('/catalog/:type/:id/:extra?.json', async (req, res) => {
    // ** Add Top Level Try/Catch **
    try {
        const { type, id } = req.params;
        let extra = {};
        if (req.params.extra) {
             try {
                 // Stremio encodes the 'extra' part. Example: search=foo -> {"search":"foo"} -> %7B%22search%22%3A%22foo%22%7D
                 const decodedExtra = decodeURIComponent(req.params.extra);
                 // Check if it's the key=value format Stremio often uses
                 if (decodedExtra.includes('=')) {
                     const parts = decodedExtra.split('=');
                     extra[parts[0]] = parts[1] || ''; // Handle empty value
                 } else {
                      // Fallback attempt for JSON parsing if needed
                      extra = JSON.parse(decodedExtra);
                 }
             } catch (e) { console.error('Error parsing extra params:', req.params.extra, e); }
        }
        console.log('Processing catalog request:', { type, id, extra });

        // Check if valid catalog request
        if (type !== 'series' || id !== 'mako-vod-shows') {
             console.log('Invalid catalog request, returning empty.');
            return res.status(200).json({ metas: [] });
        }

        // --- Catalog Logic ---
        const shows = await extractContent(`${BASE_URL}/mako-vod-index`, 'shows');
        const search = extra?.search?.toLowerCase() || '';

        let filteredShows = shows;
        if (search) {
            console.log(`Catalog: Searching for '${search}'`);
            filteredShows = shows.filter(show => show.name && show.name.toLowerCase().includes(search));
            console.log(`Catalog: Found ${filteredShows.length} matching search results`);
        } else {
             console.log(`Catalog: Returning full list (initially found ${shows.length} shows)`);
        }

        // Limit results in production for performance, especially without search
        const limit = process.env.NODE_ENV === 'production' && !search ? 50 : 200; // Limit non-search results more strictly
        if (filteredShows.length > limit) {
            console.log(`Catalog: Limiting results from ${filteredShows.length} to ${limit}`);
            filteredShows = filteredShows.slice(0, limit);
        }

        const metas = filteredShows.map(show => ({
            id: `mako:${encodeURIComponent(show.url)}`, // Encode the URL part
            type: 'series',
            name: show.name || 'Loading...',
            poster: show.poster || 'https://www.mako.co.il/assets/images/svg/mako_logo.svg',
            posterShape: 'poster',
            background: show.background || show.poster || 'https://www.mako.co.il/assets/images/svg/mako_logo.svg',
            logo: 'https://www.mako.co.il/assets/images/svg/mako_logo.svg',
            description: 'מאקו VOD',
        }));
        // --- End Catalog Logic ---

        console.log(`Catalog: Responding with ${metas.length} metas.`);
        res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600'); // Cache catalog for 1 hour on CDN
        res.setHeader('Content-Type', 'application/json');
        res.status(200).json({ metas });

    } catch (err) { // ** Catch unexpected errors **
        console.error('Catalog handler top-level error:', err);
        res.status(500).json({ metas: [], error: 'Failed to process catalog request', message: err.message });
    }
});

// Define meta endpoint
app.get('/meta/:type/:id.json', async (req, res) => {
     // ** Add Top Level Try/Catch **
     try {
        const { type, id } = req.params;
        console.log('Processing meta request:', { type, id });

        if (type !== 'series' || !id.startsWith('mako:')) {
            console.log('Invalid meta request, returning null.');
            return res.status(404).json({ meta: null, err: 'Invalid meta ID format' });
        }

        const showUrl = decodeURIComponent(id.replace('mako:', ''));
        if (!showUrl.startsWith(BASE_URL)) {
             console.error('Invalid show URL derived from meta ID:', showUrl);
             return res.status(400).json({ meta: null, err: 'Invalid show URL' });
        }

        // --- Meta Logic ---
        const cache = await loadCache(); // Use cache for name/poster first
        const cachedShowData = cache.shows ? cache.shows[showUrl] : null;
        let showName = cachedShowData?.name;
        let showPoster = cachedShowData?.poster;
        let showBackground = cachedShowData?.background;

        // If essential details missing from cache, fetch them
        if (!showName || !showPoster || !showBackground) {
             console.log(`Meta: Cache miss or incomplete for ${showUrl}, fetching details...`);
             const showDetails = await extractShowName(showUrl);
             if (showDetails) {
                 showName = showDetails.name || 'Unknown Show'; // Ensure name is set
                 showPoster = showDetails.poster || 'https://www.mako.co.il/assets/images/svg/mako_logo.svg';
                 showBackground = showDetails.background || showPoster;

                 // Update cache if details were fetched
                 if (!cache.shows) cache.shows = {};
                 if (!cache.shows[showUrl]) cache.shows[showUrl] = {};
                 cache.shows[showUrl].name = showName;
                 cache.shows[showUrl].poster = showPoster;
                 cache.shows[showUrl].background = showBackground;
                 cache.shows[showUrl].lastUpdated = Date.now();
                 await saveCache(cache); // Save updated cache asynchronously
             } else {
                  console.error(`Meta: Failed to fetch details for ${showUrl}`);
                  // Use placeholders if fetch fails
                  showName = showName || 'Error Loading Name';
                  showPoster = showPoster || 'https://www.mako.co.il/assets/images/svg/mako_logo.svg';
                  showBackground = showBackground || showPoster;
             }
        } else {
            // console.log(`Meta: Using cached details for ${showUrl}`);
        }


        // Fetch seasons and episodes
        const seasons = await extractContent(showUrl, 'seasons');
        const videos = [];
        let episodesToProcess = [];

        if (!seasons || seasons.length === 0) {
            console.log(`Meta: No seasons found for ${showUrl}, checking for episodes directly.`);
            episodesToProcess = await extractContent(showUrl, 'episodes');
            if (episodesToProcess.length > 0) {
                 episodesToProcess.forEach((ep, index) => {
                     ep.seasonNum = 1; ep.episodeNum = index + 1;
                 });
            }
        } else {
            console.log(`Meta: Found ${seasons.length} seasons for ${showUrl}`);
            // Limit season processing in serverless to avoid timeouts?
            const seasonsToProcess = process.env.NODE_ENV === 'production' ? seasons.slice(0, 5) : seasons; // Limit seasons in prod?
             if(seasonsToProcess.length < seasons.length) console.warn(`Meta: Limiting season processing to ${seasonsToProcess.length} seasons`);

             for (const season of seasonsToProcess) {
                 console.log(`Meta: Fetching episodes for season ${season.name || season.url}`);
                 const episodes = await extractContent(season.url, 'episodes');
                 const seasonNum = parseInt(season.name?.match(/\d+/)?.[0] || '1');
                 episodes.forEach((episode, index) => {
                     if (episode.guid) {
                         episode.seasonNum = seasonNum; episode.episodeNum = index + 1;
                         episodesToProcess.push(episode);
                     }
                 });
                 // Add small delay between season fetches?
                 await sleep(100);
             }
        }

        // Sort and map episodes
        episodesToProcess.sort((a, b) => (a.seasonNum - b.seasonNum) || (a.episodeNum - b.episodeNum));
        episodesToProcess.forEach(ep => {
             videos.push({
                 id: `${id}:ep:${ep.guid}`, // Use original addon ID prefix
                 title: ep.name || `Episode ${ep.episodeNum}`,
                 season: ep.seasonNum, episode: ep.episodeNum, released: null
             });
        });
        // --- End Meta Logic ---

        const metaResponse = {
            meta: {
                id, type: 'series', name: showName,
                poster: showPoster, posterShape: 'poster', background: showBackground,
                logo: 'https://www.mako.co.il/assets/images/svg/mako_logo.svg',
                description: 'מאקו VOD', videos
            }
        };

        console.log(`Meta: Responding with ${videos.length} videos for ${showName}`);
        res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600'); // Cache meta for 1 hour
        res.setHeader('Content-Type', 'application/json');
        res.status(200).json(metaResponse);

     } catch (err) { // ** Catch unexpected errors **
         console.error(`Meta handler top-level error for ID ${req.params.id}:`, err);
         res.status(500).json({ meta: null, error: 'Failed to process meta request', message: err.message });
     }
});


// Define stream endpoint
app.get('/stream/:type/:id.json', async (req, res) => {
     // ** Add Top Level Try/Catch **
     try {
        const { type, id } = req.params;
        console.log('Processing stream request:', { type, id });

        if (type !== 'series' || !id.startsWith('mako:')) {
            console.log('Invalid stream request, returning empty.');
            return res.status(404).json({ streams: [], err: 'Invalid stream ID format' });
        }

        const [showIdRaw, episodeGuid] = id.split(':ep:');
        if (!showIdRaw || !episodeGuid) {
            console.error(`Stream handler: Invalid ID format ${id}`);
            return res.status(400).json({ streams: [], err: 'Invalid stream ID format' });
        }

        const showUrl = decodeURIComponent(showIdRaw.replace('mako:', ''));
        console.log(`Stream handler: Looking for GUID ${episodeGuid} within show ${showUrl}`);

        // --- Stream Logic ---
        let episodeUrl = null;
        try {
            // Find episode URL logic (reuse meta logic carefully or simplify)
            // Simplified find: Fetch all episodes for the show directly if possible
            // This might be slow, caching episode GUID->URL mapping would be better
            console.log(`Stream: Fetching seasons/episodes for ${showUrl} to find URL for GUID ${episodeGuid}`);
            const seasons = await extractContent(showUrl, 'seasons');
            let episodesFound = [];
            if (!seasons || seasons.length === 0) {
                episodesFound = await extractContent(showUrl, 'episodes');
            } else {
                 // Fetch only necessary seasons if possible? Hard without knowing structure. Fetch all for now.
                for (const season of seasons) {
                    // Add a short delay between season episode fetches in stream handler
                    await sleep(100);
                    const episodes = await extractContent(season.url, 'episodes');
                    episodesFound.push(...episodes);
                     // Early exit if found
                    if (episodes.some(ep => ep.guid === episodeGuid)) break;
                }
            }
            const episode = episodesFound.find(ep => ep.guid === episodeGuid);
            if (episode && episode.url) {
                episodeUrl = episode.url;
                console.log(`Stream handler: Found episode URL: ${episodeUrl}`);
            } else {
                console.error(`Stream handler: Could not find episode URL for GUID ${episodeGuid} in show ${showUrl}`);
                return res.status(404).json({ streams: [], err: 'Episode URL not found' });
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
        // --- End Stream Logic ---

        const streams = [{ url: videoUrl, title: 'Play' }]; // Simple stream object

        console.log(`Stream: Responding with stream for ${episodeGuid}`);
        res.setHeader('Cache-Control', 'no-store, max-age=0'); // Do not cache stream URLs
        res.setHeader('Content-Type', 'application/json');
        res.status(200).json({ streams });

     } catch (err) { // ** Catch unexpected errors **
         console.error(`Stream handler top-level error for ID ${req.params.id}:`, err);
         res.status(500).json({ streams: [], error: 'Failed to process stream request', message: err.message });
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