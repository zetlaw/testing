// index.js
const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
// Use the external crypto.js module
const { CRYPTO, cryptoOp } = require('./crypto');

// Import Vercel Blob for serverless storage
let blob;
if (process.env.NODE_ENV === 'production') {
    try {
        blob = require('@vercel/blob');
    } catch (e) {
        console.error('Failed to load @vercel/blob, cache will not persist:', e.message);
    }
}

// Constants
const BASE_URL = "https://www.mako.co.il";
const CACHE_FILE = path.join(__dirname, "mako_shows_cache.json");
const CACHE_TTL = 30 * 24 * 60 * 60; // 30 days in seconds
const DELAY_BETWEEN_REQUESTS = 1000; // 1 second in milliseconds
const MAX_RETRIES = 3;
const REQUEST_TIMEOUT = 10000;
const BLOB_CACHE_KEY = 'mako-shows-cache.json'; // Key for Vercel Blob Storage

// Headers for requests
const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,he;q=0.8',
    'Referer': 'https://www.mako.co.il/mako-vod-index',
    'Connection': 'keep-alive'
};

// In-memory cache to avoid multiple blob fetches in a single execution
let memoryCache = null;

// Cache management (modified for Vercel Blob Storage)
const loadCache = async () => {
    // Use the in-memory cache if it exists
    if (memoryCache) {
        return memoryCache;
    }
    
    // In production/serverless, use Vercel Blob Storage
    if (process.env.NODE_ENV === 'production') {
        if (!blob) {
            console.log("Vercel Blob not available - using empty cache");
            memoryCache = { timestamp: Date.now(), shows: {} };
            return memoryCache;
        }

        try {
            console.log("Attempting to load cache from Vercel Blob Storage");
            const blobList = await blob.list();
            
            const cacheBlob = blobList.blobs.find(b => b.pathname === BLOB_CACHE_KEY);
            if (cacheBlob) {
                const cacheUrl = cacheBlob.url;
                console.log(`Found cache blob at ${cacheUrl}`);
                
                const response = await axios.get(cacheUrl);
                memoryCache = response.data;
                console.log(`Successfully loaded cache from Blob storage with ${Object.keys(memoryCache.shows).length} items`);
                return memoryCache;
            } else {
                console.log("No cache blob found - starting with empty cache");
                memoryCache = { timestamp: Date.now(), shows: {} };
                return memoryCache;
            }
        } catch (e) {
            console.error("Error loading cache from Blob storage:", e);
            memoryCache = { timestamp: Date.now(), shows: {} };
            return memoryCache;
        }
    }
    
    // Local development - use file system
    try {
        if (fs.existsSync(CACHE_FILE)) {
            const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
            memoryCache = data;
            return memoryCache;
        }
        memoryCache = { timestamp: Date.now(), shows: {} };
        return memoryCache;
    } catch (e) {
        console.error("Error loading cache from file:", e);
        memoryCache = { timestamp: Date.now(), shows: {} };
        return memoryCache;
    }
};

const saveCache = async (cache) => {
    // Always update memory cache
    memoryCache = cache;
    
    // In production/serverless, use Vercel Blob Storage
    if (process.env.NODE_ENV === 'production') {
        if (!blob) {
            console.log("Vercel Blob not available - cache will not persist");
            return;
        }
        
        try {
            console.log(`Saving cache to Vercel Blob with ${Object.keys(cache.shows).length} items`);
            const cacheData = JSON.stringify(cache);
            
            // Upload as application/json MIME type
            await blob.put(BLOB_CACHE_KEY, cacheData, {
                contentType: 'application/json',
                access: 'public' // Make it publicly accessible so we can fetch it
            });
            
            console.log("Cache saved successfully to Vercel Blob");
        } catch (e) {
            console.error("Error saving cache to Blob storage:", e);
        }
        return;
    }
    
    // Local development - use file system
    try {
        const cacheDir = path.dirname(CACHE_FILE);
        if (!fs.existsSync(cacheDir)) {
            fs.mkdirSync(cacheDir, { recursive: true });
        }
        fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
        console.log("Cache saved successfully to file");
    } catch (e) {
        console.error("Error saving cache to file:", e);
    }
};


// Helper functions
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Image URL processing (remains the same)
// ... processImageUrl ...
const processImageUrl = (url) => {
    if (!url) return null;
    if (url.startsWith('http')) return url;
    if (url.startsWith('//')) return `https:${url}`;
    return `${BASE_URL}${url}`;
};


// Show name extraction (modified for serverless)
const extractShowName = async (url) => {
    try {
        console.log(`Extracting show name from ${url}`);
        const response = await axios.get(url, {
            headers: HEADERS,
            timeout: REQUEST_TIMEOUT,
            maxRedirects: 5
        });
        const $ = cheerio.load(response.data);
        const jsonldTag = $('script[type="application/ld+json"]').html();

        if (!jsonldTag) {
            console.log(`No JSON-LD found for ${url}`);
            return null;
        }

        const data = JSON.parse(jsonldTag);
        console.log(`Found JSON-LD data type: ${data['@type']}`);

        let name;
        if (data['@type'] === 'TVSeason' && data.partOfTVSeries) {
            name = data.partOfTVSeries.name;
            console.log(`Found TVSeason, using series name from partOfTVSeries: ${name}`);
        } else {
            name = data.name;
        }

        // For debugging, print the raw name exactly as found in JSON
        console.log(`Raw name found in JSON: ${name}`);

        // Optional: Add season info if available
        if (data.containsSeason && Array.isArray(data.containsSeason) && data.containsSeason.length > 1) {
            name = `${name} (${data.containsSeason.length} עונות)`;
        }

        // Get poster and background images
        let poster = $('meta[property="og:image"]').attr('content') ||
                    $('meta[name="twitter:image"]').attr('content') ||
                    $('link[rel="image_src"]').attr('href') ||
                    $('.vod_item img').attr('src') ||
                    $('.vod_item_wrap img').attr('src');

        let background = $('meta[property="og:image:width"][content="1920"]').parent().attr('content') || poster;

        poster = processImageUrl(poster);
        background = processImageUrl(background);

        if (!poster) {
            const imgElement = $('img[src*="vod"]').first();
            if (imgElement.length) {
                poster = processImageUrl(imgElement.attr('src'));
            }
        }

        if (!poster || poster.includes('_next/static')) {
            poster = 'https://www.mako.co.il/assets/images/svg/mako_logo.svg';
        }
        if (!background || background.includes('_next/static')) {
            background = poster;
        }

        console.log(`Extracted show details for ${url}:`, { name, poster, background });
        return { name, poster, background };
    } catch (e) {
        console.error(`Error extracting show name from ${url}:`, e.message);
        return null;
    }
};

// Process show names (modified for serverless)
const processShowNames = async (shows, cache, cacheIsFresh, maxShows = null) => {
    let updatesCount = 0;
    let processedCount = 0;

    // In serverless, limit the shows to process
    let showLimit = process.env.NODE_ENV === 'production' ? 20 : null;
    // If caller specified a limit, use the lower of the two
    if (maxShows !== null) {
        showLimit = showLimit ? Math.min(showLimit, maxShows) : maxShows;
    }
    
    const showsToProcess = showLimit && showLimit < shows.length ? shows.slice(0, showLimit) : shows;
    const total = showsToProcess.length;
    console.log(`Processing ${total} shows in background...`);

    // Use smaller batch size in serverless to avoid timeouts
    const BATCH_SIZE = process.env.NODE_ENV === 'production' ? 2 : 5;
    
    for (let i = 0; i < showsToProcess.length; i += BATCH_SIZE) {
        const batch = showsToProcess.slice(i, i + BATCH_SIZE);
        const batchPromises = batch.map(async (show) => {
            try {
                const url = show.url;

                if (url in cache.shows && cacheIsFresh) {
                    show.name = cache.shows[url].name;
                    show.poster = cache.shows[url].poster;
                    show.background = cache.shows[url].background;
                    processedCount++;
                    return;
                }

                // Add timeout handling for serverless
                let details;
                try {
                    // Use a shorter timeout in serverless
                    const timeoutMs = process.env.NODE_ENV === 'production' ? 5000 : REQUEST_TIMEOUT;
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
                    
                    details = await Promise.race([
                        extractShowName(url),
                        new Promise((_, reject) => 
                            setTimeout(() => reject(new Error(`Timeout getting show details for ${url}`)), timeoutMs)
                        )
                    ]);
                    
                    clearTimeout(timeoutId);
                } catch (timeoutErr) {
                    console.error(`Timeout extracting show name from ${url}`);
                    processedCount++;
                    return;
                }
                
                if (details) {
                    // console.log(`Found new show name: ${details.name}`);
                    show.name = details.name;
                    show.poster = details.poster;
                    show.background = details.background;

                    if (!cache.shows[url]) cache.shows[url] = {};
                    cache.shows[url].name = details.name;
                    cache.shows[url].poster = details.poster;
                    cache.shows[url].background = details.background;
                    cache.shows[url].lastUpdated = Date.now();

                    updatesCount++;
                }
                processedCount++;

            } catch (e) {
                console.error(`Error processing show ${show?.name || 'unknown'}:`, e.message);
                processedCount++;
            }
        });

        try {
            await Promise.all(batchPromises);
        } catch (batchError) {
            console.error("Error processing batch of shows:", batchError);
        }

        if (processedCount % 20 === 0 || processedCount === total) {
             console.log(`Background progress: ${processedCount}/${total} shows processed (${(processedCount/total*100).toFixed(1)}%)`);
        }

        if (updatesCount > 0) {
            cache.timestamp = Date.now();
            await saveCache(cache);
            updatesCount = 0; // Reset after save
        }
        
        // Add longer delay between batches in serverless
        await sleep(process.env.NODE_ENV === 'production' ? 300 : 100);
    }
    
    // Final save if any pending updates
    if (updatesCount > 0) {
         cache.timestamp = Date.now();
         await saveCache(cache);
    }
};

// Content extraction (modified for serverless)
const extractContent = async (url, contentType) => {
    try {
        await sleep(DELAY_BETWEEN_REQUESTS);
        console.log(`Fetching ${contentType} from ${url}`);
        const response = await axios.get(url, { headers: HEADERS, timeout: REQUEST_TIMEOUT });
        const $ = cheerio.load(response.data);

        const configs = {
            shows: {
                selectors: [
                    'a[href^="/mako-vod-"]:not([href*="purchase"]):not([href*="index"])',
                    '.vod_item a[href^="/mako-vod-"]:not([href*="purchase"]):not([href*="index"])',
                    '.vod_item_wrap a[href^="/mako-vod-"]:not([href*="purchase"]):not([href*="index"])',
                    'li > a[href^="/mako-vod-"]:not([href*="purchase"]):not([href*="index"])'
                ],
                fields: {
                    url: { attribute: 'href' },
                    tempName: { selector: 'img', attribute: 'alt' },
                    poster: { selector: 'img', attribute: 'src' }
                },
                base: BASE_URL
            },
            seasons: {
                selectors: ['div#seasonDropdown ul ul li a'],
                fields: { name: { selector: 'span' }, url: { attribute: 'href' } },
                base: url
            },
            episodes: {
                 selectors: ['li.card a', 'a[href*="videoGuid="]', '.vod_item a', '.vod_item_wrap a'],
                 fields: {
                     name: { selector: 'strong.title' },
                     url: { attribute: 'href' },
                     guid: { attribute: 'href', regex: /\/VOD-([\w-]+)\.htm/ }
                 },
                 base: url
            }
        };

        const config = configs[contentType];
        const items = [];
        const seen = new Set();

        let elements = [];
        for (const selector of config.selectors) {
            elements = $(selector).toArray();
            if (elements.length) {
                console.log(`Found ${elements.length} elements with selector: ${selector}`);
                break;
            }
        }

        if (contentType === 'shows') {
            console.log(`Processing ${elements.length} potential show elements`);
        }

        for (const elem of elements) {
            const item = {};
            for (const [field, fieldConfig] of Object.entries(config.fields)) {
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
                    value = new URL(value, config.base).href;
                }

                if (value !== undefined && value !== null) item[field] = value;
            }

            // Ensure essential fields exist before adding
            if ((contentType === 'shows' && item.url && !item.url.includes('purchase') && !item.url.includes('index')) ||
                (contentType === 'seasons' && item.url && item.name) ||
                (contentType === 'episodes' && item.url))
            {
                const key = item.guid || item.url;
                if (key && !seen.has(key)) {
                    if (contentType === 'shows') {
                        // Try to get a better name from various sources
                        item.name = item.tempName || 
                                  $(elem).find('.title').text().trim() ||
                                  $(elem).find('h2, h3').text().trim() ||
                                  'Unknown Show';
                        delete item.tempName;
                        item.poster = processImageUrl(item.poster);
                        if (item.poster && item.poster.includes('_next/static')) {
                            item.poster = 'https://www.mako.co.il/assets/images/svg/mako_logo.svg';
                        }
                        console.log(`Found show: ${item.name} at ${item.url}`);
                    }
                    items.push(item);
                    seen.add(key);
                }
            }
        }

        if (contentType === 'shows') {
            console.log(`Found ${items.length} valid shows`);
            // Log first few shows for debugging
            if (items.length > 0) {
                console.log('First 5 shows:', items.slice(0, 5).map(s => ({ name: s.name, url: s.url })));
            }

            // Load cache and process show names
            const cache = await loadCache();
            const cacheIsFresh = Date.now() - cache.timestamp < CACHE_TTL;

            console.log("\nLoading accurate show names...");

            let cachedCount = 0;
            if (cacheIsFresh) {
                for (const show of items) {
                    if (cache.shows[show.url]) {
                        show.name = cache.shows[show.url].name;
                        show.poster = cache.shows[show.url].poster || show.poster;
                        show.background = cache.shows[show.url].background || show.poster;
                        cachedCount++;
                    }
                }
            }

            if (cachedCount) {
                console.log(`Using ${cachedCount} show names from cache`);
            }

            // Process shows that aren't in cache
            const toFetch = items.filter(show => !(cacheIsFresh && cache.shows[show.url]));
            if (toFetch.length > 0) {
                console.log(`Need to fetch ${toFetch.length} show names`);
                // Process shows in smaller batches to avoid timeouts
                const BATCH_SIZE = process.env.NODE_ENV === 'production' ? 2 : 5;
                for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
                    const batch = toFetch.slice(i, i + BATCH_SIZE);
                    const batchPromises = batch.map(async (show) => {
                        try {
                            const details = await extractShowName(show.url);
                            if (details) {
                                show.name = details.name;
                                show.poster = details.poster;
                                show.background = details.background;
                                
                                // Update cache
                                if (!cache.shows[show.url]) cache.shows[show.url] = {};
                                cache.shows[show.url] = {
                                    name: details.name,
                                    poster: details.poster,
                                    background: details.background,
                                    lastUpdated: Date.now()
                                };
                            }
                        } catch (e) {
                            console.error(`Error processing show ${show.url}:`, e.message);
                        }
                    });
                    await Promise.all(batchPromises);
                    await sleep(100); // Small delay between batches
                }
                await saveCache(cache);
            }
        }

        return items;
    } catch (e) {
        console.error(`Error extracting ${contentType} from ${url}:`, e.message);
        return [];
    }
};


// *** MODIFIED getVideoUrl function ***
const getVideoUrl = async (episodeUrl) => {
    console.log(`getVideoUrl: Starting process for episode URL: ${episodeUrl}`);
    try {
        // 1. Fetch Episode Page HTML (remains same)
        console.log(`getVideoUrl: Fetching episode page HTML...`);
        const episodePageResponse = await axios.get(episodeUrl, {
            headers: HEADERS, timeout: REQUEST_TIMEOUT, responseType: 'text'
        });
        const $ = cheerio.load(episodePageResponse.data);
        const script = $('#__NEXT_DATA__').html();
        if (!script) { /* ... error handling ... */ return null; }

        // 2. Parse __NEXT_DATA__ (remains same)
        let details;
        try {
            const data = JSON.parse(script);
            const vod = data?.props?.pageProps?.data?.vod || {};
            details = { vcmid: vod.itemVcmId, galleryChannelId: vod.galleryChannelId, videoChannelId: vod.channelId };
            if (!details.vcmid || !details.galleryChannelId || !details.videoChannelId) { /* ... error handling ... */ return null; }
            console.log("getVideoUrl: Successfully extracted video details:", details);
        } catch (e) { /* ... error handling ... */ return null; }

        // 3. Construct Playlist URL (remains same)
        const ajaxUrl = `${BASE_URL}/AjaxPage?jspName=playlist12.jsp&vcmid=${details.vcmid}&videoChannelId=${details.videoChannelId}&galleryChannelId=${details.galleryChannelId}&consumer=responsive`;
        console.log(`getVideoUrl: Fetching encrypted playlist from: ${ajaxUrl}`);

        // 4. *** Fetch as ArrayBuffer and Sanitize Base64 Input ***
        const playlistResponse = await axios.get(ajaxUrl, {
            headers: { ...HEADERS, 'Accept': 'text/plain', 'Content-Type': 'text/plain' },
            timeout: REQUEST_TIMEOUT,
            responseType: 'arraybuffer' // <-- Fetch raw bytes
        });

        if (!playlistResponse.data || playlistResponse.data.byteLength === 0) {
            console.error("getVideoUrl: Error - Received empty playlist response buffer");
            return null;
        }

        // Convert buffer to string using latin1 (safe byte-to-char)
        const rawText = Buffer.from(playlistResponse.data).toString('latin1');

        // Clean the string: remove ALL whitespace and any non-base64 characters
        // Base64 chars: A-Z, a-z, 0-9, +, /, = (for padding)
        const base64CharsRegex = /[^A-Za-z0-9+/=]/g;
        const encryptedDataClean = rawText.replace(base64CharsRegex, '');

        if (!encryptedDataClean) {
             console.error("getVideoUrl: Error - Playlist data was empty after cleaning non-base64 characters.");
             return null;
        }

        console.log(`getVideoUrl: Cleaned Base64 playlist data length: ${encryptedDataClean.length}`);
        // console.log("getVideoUrl: First 100 chars of cleaned data:", encryptedDataClean.substring(0, 100));


        // 5. Decrypt Playlist Data (using the cleaned string)
        console.log("getVideoUrl: Attempting playlist decryption...");
        const decrypted = cryptoOp(encryptedDataClean, "decrypt", "playlist");
        if (!decrypted) { // cryptoOp returns null on failure
             console.error("getVideoUrl: cryptoOp returned null during playlist decryption.");
            return null;
        }
        // Assuming cryptoOp logs success/failure internally now

        // 6. Parse Decrypted JSON (remains same)
        let playlistData;
        try {
            playlistData = JSON.parse(decrypted);
            console.log("getVideoUrl: Successfully parsed playlist data");
            // console.log("getVideoUrl: Media array length:", playlistData.media?.length || 0);
        } catch (e) {
            console.error("getVideoUrl: Error parsing decrypted JSON:", e.message);
            console.error("getVideoUrl: Decrypted data snippet (first 500):", decrypted.substring(0, 500));
            return null;
        }

        // 7. Extract HLS URL (remains same)
        const media = playlistData.media || [];
        const hlsUrl = media[0]?.url; // Assuming first media item is the one
        if (!hlsUrl) {
            console.error("getVideoUrl: No media URL found in playlist data");
            return null;
        }
        console.log("getVideoUrl: Found HLS URL:", hlsUrl);

        // --- Entitlement Process (remains same, uses cryptoOp) ---

        // 8. Prepare Entitlement Payload
        const payload = JSON.stringify({ lp: new URL(hlsUrl).pathname, rv: "AKAMAI" });
        console.log("getVideoUrl: Prepared entitlement payload:", payload);

        // 9. Encrypt Entitlement Payload
        const encryptedPayload = cryptoOp(payload, "encrypt", "entitlement");
        if (!encryptedPayload) {
            console.error("getVideoUrl: Failed to encrypt entitlement payload");
            return hlsUrl; // Fallback
        }

        // 10. Fetch Entitlement Ticket
        const entitlementResponse = await axios.post(CRYPTO.entitlement.url, encryptedPayload, {
            headers: { ...HEADERS, 'Content-Type': 'text/plain;charset=UTF-8', 'Accept': 'text/plain' },
            timeout: REQUEST_TIMEOUT,
            responseType: 'text' // Fetch entitlement response as text
        });

        if (!entitlementResponse.data || !entitlementResponse.data.trim()) {
            console.log("getVideoUrl: No entitlement response data, using HLS URL without ticket");
            return hlsUrl;
        }

        // 11. Clean entitlement response and Decrypt
        // Assuming entitlement response is also base64 text
        const entitlementEncryptedClean = entitlementResponse.data.replace(base64CharsRegex, '');
        if (!entitlementEncryptedClean) {
             console.error("getVideoUrl: Entitlement response empty after cleaning.");
             return hlsUrl; // Fallback
        }

        const entitlementDecrypted = cryptoOp(entitlementEncryptedClean, "decrypt", "entitlement");
        if (!entitlementDecrypted) {
            console.error("getVideoUrl: Failed to decrypt entitlement response");
            return hlsUrl; // Fallback
        }

        // 12. Parse Entitlement Data
        let entitlementData;
        try {
            entitlementData = JSON.parse(entitlementDecrypted);
            // console.log("getVideoUrl: Successfully parsed entitlement data:", entitlementData);
        } catch (e) {
            console.error("getVideoUrl: Error parsing entitlement JSON:", e.message);
            console.error("getVideoUrl: Entitlement decrypted data snippet:", entitlementDecrypted.substring(0, 500));
            return hlsUrl; // Fallback
        }

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
        // Log axios errors specifically if possible
        if (error.response) {
             console.error(`getVideoUrl: Axios Error - Status: ${error.response.status}, Data: ${error.response.data}`);
        } else if (error.request) {
             console.error('getVideoUrl: Axios Error - No response received:', error.message);
        } else {
             console.error('getVideoUrl: Unexpected Error:', error.message);
        }
        // console.error(error.stack); // Optional: Log stack trace
        return null;
    }
};


// Stremio addon builder setup (remains the same)
// ... builder = new addonBuilder ...
const builder = new addonBuilder({
    id: 'org.stremio.mako-vod',
    version: '1.0.2', // Increment version
    name: 'Mako VOD',
    description: 'Watch VOD content from Mako (Israeli TV)',
    logo: 'https://www.mako.co.il/assets/images/svg/mako_logo.svg',
    resources: ['catalog', 'meta', 'stream'], // Simplified resources
    types: ['series'],
    catalogs: [{
        type: 'series',
        id: 'mako-vod-shows',
        name: 'Mako VOD Shows',
        extra: [{ name: 'search', isRequired: false }]
    }],
    behaviorHints: { adult: false, configurationRequired: false }
});


// Catalog handler (remains mostly the same, uses updated extractContent/processShowNames)
// ... builder.defineCatalogHandler ...
builder.defineCatalogHandler(async ({ type, id, extra }) => {
    if (type !== 'series' || id !== 'mako-vod-shows') {
        return Promise.resolve({ metas: [] });
    }

    try {
        const shows = await extractContent(`${BASE_URL}/mako-vod-index`, 'shows');
        const search = extra?.search?.toLowerCase() || '';

        let filteredShows = shows;
        if (search) {
            console.log(`Searching for: ${search}`);
            // Ensure name exists before filtering
            filteredShows = shows.filter(show => show.name && show.name.toLowerCase().includes(search));
            console.log(`Found ${filteredShows.length} matching shows`);
        }

        const metas = filteredShows.map(show => ({
            id: `mako:${encodeURIComponent(show.url)}`,
            type: 'series',
            name: show.name || 'Loading...', // Use cached name or placeholder
            poster: show.poster || 'https://www.mako.co.il/assets/images/svg/mako_logo.svg',
            posterShape: 'poster',
            background: show.background || show.poster || 'https://www.mako.co.il/assets/images/svg/mako_logo.svg',
            logo: 'https://www.mako.co.il/assets/images/svg/mako_logo.svg',
            description: 'מאקו VOD',
        }));

        return Promise.resolve({ metas });
    } catch (error) {
        console.error('Error in catalog handler:', error.message);
        return Promise.resolve({ metas: [] });
    }
});


// Meta handler (remains mostly the same)
// ... builder.defineMetaHandler ...
builder.defineMetaHandler(async ({ type, id }) => {
     if (type !== 'series' || !id.startsWith('mako:')) {
        return Promise.resolve({ meta: null });
    }

    const showUrl = decodeURIComponent(id.replace('mako:', ''));

    try {
         // Attempt to get basic show info quickly from cache or minimal fetch
         const cache = await loadCache();
         const cachedShowData = cache.shows[showUrl];
         let showName = cachedShowData?.name || 'Loading...';
         let showPoster = cachedShowData?.poster || 'https://www.mako.co.il/assets/images/svg/mako_logo.svg';
         let showBackground = cachedShowData?.background || showPoster;

         // If not cached, fetch basic details
         if (!cachedShowData) {
             const showDetails = await extractShowName(showUrl);
             if(showDetails) {
                 showName = showDetails.name;
                 showPoster = showDetails.poster;
                 showBackground = showDetails.background;
                 
                 // Save to cache for future use
                 if (!cache.shows[showUrl]) cache.shows[showUrl] = {};
                 cache.shows[showUrl].name = showDetails.name;
                 cache.shows[showUrl].poster = showDetails.poster;
                 cache.shows[showUrl].background = showDetails.background;
                 cache.shows[showUrl].lastUpdated = Date.now();
                 
                 await saveCache(cache);
             }
         }


        const seasons = await extractContent(showUrl, 'seasons');
        const videos = [];

        // If no seasons dropdown, check for episodes directly on the show page
        let episodesToProcess = [];
        if (!seasons || seasons.length === 0) {
             console.log(`No seasons found for ${showUrl}, checking for episodes directly.`);
             episodesToProcess = await extractContent(showUrl, 'episodes');
             if (episodesToProcess.length > 0) {
                  // Assign a default season number if none are specified
                  episodesToProcess.forEach((ep, index) => {
                      ep.seasonNum = 1;
                      ep.episodeNum = index + 1;
                  });
             }
        } else {
             for (const season of seasons) {
                 const episodes = await extractContent(season.url, 'episodes');
                 const seasonNum = parseInt(season.name?.match(/\d+/)?.[0] || '1'); // Default to 1 if no number
                 episodes.forEach((episode, index) => {
                    if (episode.guid) {
                        episode.seasonNum = seasonNum;
                        episode.episodeNum = index + 1; // Simple episode index within season fetch
                        episodesToProcess.push(episode);
                    }
                });
             }
        }


        // Sort all collected episodes
        episodesToProcess.sort((a, b) => {
            if (a.seasonNum !== b.seasonNum) return a.seasonNum - b.seasonNum;
            return a.episodeNum - b.episodeNum;
        });

        // Create video objects for Stremio
        episodesToProcess.forEach(episode => {
             videos.push({
                id: `${id}:ep:${episode.guid}`,
                title: episode.name || `Episode ${episode.episodeNum}`,
                season: episode.seasonNum,
                episode: episode.episodeNum,
                // thumbnail: episode.poster || showPoster, // Optional: Use episode specific thumb if available
                released: null, // Mako doesn't provide reliable release dates easily
                // overview: episode.description || null // Optional: Add overview if available
            });
        });


        return Promise.resolve({
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
        });
    } catch (error) {
        console.error(`Error in meta handler for ${id}:`, error.message);
        return Promise.resolve({ meta: null });
    }
});


// Stream handler (uses updated getVideoUrl)
// ... builder.defineStreamHandler ...
builder.defineStreamHandler(async ({ type, id }) => {
    if (type !== 'series' || !id.startsWith('mako:')) {
        return Promise.resolve({ streams: [] });
    }

    const [showIdRaw, episodeGuid] = id.split(':ep:');
    if (!showIdRaw || !episodeGuid) {
        console.error(`Stream handler: Invalid ID format ${id}`);
        return Promise.resolve({ streams: [] });
    }
    // const showId = showIdRaw + ":ep"; // Not needed

    const showUrl = decodeURIComponent(showIdRaw.replace('mako:', ''));
    console.log(`Stream handler: Looking for GUID ${episodeGuid} within show ${showUrl}`);

    let episodeUrl = null;
    try {
        // Find episode URL logic (keep your existing logic here)
        const seasons = await extractContent(showUrl, 'seasons');
        let episodesFound = [];
        if (!seasons || seasons.length === 0) {
            episodesFound = await extractContent(showUrl, 'episodes');
        } else {
            for (const season of seasons) {
                const episodes = await extractContent(season.url, 'episodes');
                episodesFound.push(...episodes);
                // Optimization: Check if the episode is found in this season's fetch
                if (episodes.some(ep => ep.guid === episodeGuid)) {
                     console.log(`Stream handler: Found GUID ${episodeGuid} in season ${season.name || 'unknown'}`);
                     break; // Stop fetching more seasons if found
                }
            }
        }
        const episode = episodesFound.find(ep => ep.guid === episodeGuid);
        if (episode && episode.url) {
            episodeUrl = episode.url;
            console.log(`Stream handler: Found episode URL: ${episodeUrl}`);
        } else {
            console.error(`Stream handler: Could not find episode URL for GUID ${episodeGuid}`);
            return Promise.resolve({ streams: [] });
        }

    } catch (error) {
        console.error(`Stream handler: Error finding episode URL: ${error.message}`);
        return Promise.resolve({ streams: [] });
    }

    // Get the HLS URL
    const videoUrl = await getVideoUrl(episodeUrl);

    if (!videoUrl) {
        console.error(`Stream handler: getVideoUrl failed for ${episodeUrl}`);
        return Promise.resolve({ streams: [] });
    }

    console.log(`Stream handler: Got video URL: ${videoUrl}`);

    // *** SIMPLIFIED STREAM OBJECT ***
    const streams = [{
        url: videoUrl,
        title: 'Play (Default Player)', // Changed title for clarity
        // Removed behaviorHints and headers to test Stremio's default handling
    }];

    // --- Alternative: Minimal Hints (if the above fails) ---
    // const streams = [{
    //     url: videoUrl,
    //     title: 'Play (HLS)',
    //     behaviorHints: {
    //         // Only hint that web player might struggle
    //         notWebReady: true
    //     }
    // }];
    // --- End Alternative ---


    return Promise.resolve({ streams });
});



// Get the addon interface
const addonInterface = builder.getInterface();

// Create Express app for serverless
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());

// Define manifest endpoint
app.get('/', (req, res) => {
    res.redirect('/manifest.json');
});

app.get('/manifest.json', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(addonInterface.manifest);
});

// Define catalog endpoint
app.get('/catalog/:type/:id/:extra?.json', async (req, res) => {
    try {
        console.log('Processing catalog request:', req.params);
        const { type, id } = req.params;
        
        let extra = {};
        if (req.params.extra) {
            try {
                extra = JSON.parse(decodeURIComponent(req.params.extra));
            } catch (e) {
                console.error('Error parsing extra:', e);
            }
        }
        
        // Check if valid catalog request for our addon
        if (type !== 'series' || id !== 'mako-vod-shows') {
            return res.send({ metas: [] });
        }
        
        // Implement simplified catalog logic directly
        try {
            const shows = await extractContent(`${BASE_URL}/mako-vod-index`, 'shows');
            const search = extra?.search?.toLowerCase() || '';

            let filteredShows = shows;
            if (search) {
                console.log(`Searching for: ${search}`);
                // Ensure name exists before filtering
                filteredShows = shows.filter(show => show.name && show.name.toLowerCase().includes(search));
                console.log(`Found ${filteredShows.length} matching shows`);
            }

            // In serverless, limit shows for performance
            if (process.env.NODE_ENV === 'production' && !search && filteredShows.length > 100) {
                console.log(`Limiting to 100 shows in production mode for performance`);
                filteredShows = filteredShows.slice(0, 100);
            }

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

            res.setHeader('Content-Type', 'application/json');
            res.send({ metas });
        } catch (error) {
            console.error('Error building catalog:', error);
            res.setHeader('Content-Type', 'application/json');
            res.send({ metas: [] });
        }
    } catch (err) {
        console.error('Catalog error:', err);
        res.status(500).json({ error: 'Error processing catalog request', message: err.message });
    }
});

// Define meta endpoint
app.get('/meta/:type/:id.json', async (req, res) => {
    try {
        console.log('Processing meta request:', req.params);
        const { type, id } = req.params;
        
        // Check if valid meta request for our addon
        if (type !== 'series' || !id.startsWith('mako:')) {
            return res.send({ meta: null });
        }

        const showUrl = decodeURIComponent(id.replace('mako:', ''));

        try {
            // Attempt to get basic show info quickly from cache or minimal fetch
            const cache = await loadCache();
            const cachedShowData = cache.shows[showUrl];
            let showName = cachedShowData?.name || 'Loading...';
            let showPoster = cachedShowData?.poster || 'https://www.mako.co.il/assets/images/svg/mako_logo.svg';
            let showBackground = cachedShowData?.background || showPoster;

            // If not cached, fetch basic details
            if (!cachedShowData) {
                const showDetails = await extractShowName(showUrl);
                if(showDetails) {
                    showName = showDetails.name;
                    showPoster = showDetails.poster;
                    showBackground = showDetails.background;
                    
                    // Save to cache for future use
                    if (!cache.shows[showUrl]) cache.shows[showUrl] = {};
                    cache.shows[showUrl].name = showDetails.name;
                    cache.shows[showUrl].poster = showDetails.poster;
                    cache.shows[showUrl].background = showDetails.background;
                    cache.shows[showUrl].lastUpdated = Date.now();
                    
                    await saveCache(cache);
                }
            }

            const seasons = await extractContent(showUrl, 'seasons');
            const videos = [];

            // If no seasons dropdown, check for episodes directly on the show page
            let episodesToProcess = [];
            if (!seasons || seasons.length === 0) {
                console.log(`No seasons found for ${showUrl}, checking for episodes directly.`);
                episodesToProcess = await extractContent(showUrl, 'episodes');
                if (episodesToProcess.length > 0) {
                    // Assign a default season number if none are specified
                    episodesToProcess.forEach((ep, index) => {
                        ep.seasonNum = 1;
                        ep.episodeNum = index + 1;
                    });
                }
            } else {
                for (const season of seasons) {
                    const episodes = await extractContent(season.url, 'episodes');
                    const seasonNum = parseInt(season.name?.match(/\d+/)?.[0] || '1'); // Default to 1 if no number
                    episodes.forEach((episode, index) => {
                        if (episode.guid) {
                            episode.seasonNum = seasonNum;
                            episode.episodeNum = index + 1; // Simple episode index within season fetch
                            episodesToProcess.push(episode);
                        }
                    });
                }
            }

            // Sort all collected episodes
            episodesToProcess.sort((a, b) => {
                if (a.seasonNum !== b.seasonNum) return a.seasonNum - b.seasonNum;
                return a.episodeNum - b.episodeNum;
            });

            // Create video objects for Stremio
            episodesToProcess.forEach(episode => {
                videos.push({
                    id: `${id}:ep:${episode.guid}`,
                    title: episode.name || `Episode ${episode.episodeNum}`,
                    season: episode.seasonNum,
                    episode: episode.episodeNum,
                });
            });

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
            
            res.setHeader('Content-Type', 'application/json');
            res.send(metaResponse);
        } catch (error) {
            console.error(`Error in meta handler for ${id}:`, error);
            res.setHeader('Content-Type', 'application/json');
            res.send({ meta: null });
        }
    } catch (err) {
        console.error('Meta error:', err);
        res.status(500).json({ error: 'Error processing meta request', message: err.message });
    }
});

// Define stream endpoint
app.get('/stream/:type/:id.json', async (req, res) => {
    try {
        console.log('Processing stream request:', req.params);
        const { type, id } = req.params;
        
        // Check if valid stream request for our addon
        if (type !== 'series' || !id.startsWith('mako:')) {
            return res.send({ streams: [] });
        }

        const [showIdRaw, episodeGuid] = id.split(':ep:');
        if (!showIdRaw || !episodeGuid) {
            console.error(`Stream handler: Invalid ID format ${id}`);
            return res.send({ streams: [] });
        }

        const showUrl = decodeURIComponent(showIdRaw.replace('mako:', ''));
        console.log(`Stream handler: Looking for GUID ${episodeGuid} within show ${showUrl}`);

        let episodeUrl = null;
        try {
            // Find episode URL logic
            const seasons = await extractContent(showUrl, 'seasons');
            let episodesFound = [];
            if (!seasons || seasons.length === 0) {
                episodesFound = await extractContent(showUrl, 'episodes');
            } else {
                for (const season of seasons) {
                    const episodes = await extractContent(season.url, 'episodes');
                    episodesFound.push(...episodes);
                    // Optimization: Check if the episode is found in this season's fetch
                    if (episodes.some(ep => ep.guid === episodeGuid)) {
                        console.log(`Stream handler: Found GUID ${episodeGuid} in season ${season.name || 'unknown'}`);
                        break; // Stop fetching more seasons if found
                    }
                }
            }
            
            const episode = episodesFound.find(ep => ep.guid === episodeGuid);
            if (episode && episode.url) {
                episodeUrl = episode.url;
                console.log(`Stream handler: Found episode URL: ${episodeUrl}`);
            } else {
                console.error(`Stream handler: Could not find episode URL for GUID ${episodeGuid}`);
                return res.send({ streams: [] });
            }

            // Get the HLS URL
            const videoUrl = await getVideoUrl(episodeUrl);

            if (!videoUrl) {
                console.error(`Stream handler: getVideoUrl failed for ${episodeUrl}`);
                return res.send({ streams: [] });
            }

            console.log(`Stream handler: Got video URL: ${videoUrl}`);

            // Return stream object
            const streams = [{
                url: videoUrl,
                title: 'Play (Default Player)',
            }];

            res.setHeader('Content-Type', 'application/json');
            res.send({ streams });
        } catch (error) {
            console.error(`Stream handler error: ${error.message}`);
            res.setHeader('Content-Type', 'application/json');
            res.send({ streams: [] });
        }
    } catch (err) {
        console.error('Stream error:', err);
        res.status(500).json({ error: 'Error processing stream request', message: err.message });
    }
});

// Handle other requests
app.use((req, res) => {
    console.log('Unknown request:', req.url);
    res.status(404).json({ error: 'Not found' });
});

// Create the serverless handler
module.exports = app;

// Only start the server if we're not in a serverless environment
if (process.env.NODE_ENV !== 'production') {
    serveHTTP(addonInterface, { port: process.env.PORT || 8000 })
        .then(({ url }) => {
            console.log(`🚀 Mako VOD Stremio Add-on running at ${url}/manifest.json`);
            console.log(`Add to Stremio by opening: stremio://${url.replace(/^https?:\/\//, '')}/manifest.json`);
        })
        .catch(err => {
            console.error('Error starting server:', err);
        });
}