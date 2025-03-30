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

const BASE_URL = "https://www.mako.co.il";
const LOCAL_CACHE_FILE = path.join(__dirname, "mako_shows_cache.json"); // Keep for local dev
const LOCAL_METADATA_FILE = path.join(__dirname, "mako_shows_metadata.json"); // Keep for local dev
const CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days in milliseconds
const CACHE_TTL_MS = CACHE_TTL; // Alias for consistency
const DELAY_BETWEEN_REQUESTS_MS = 500; // 0.5 second delay
const REQUEST_TIMEOUT_MS = 10000; // 10 seconds for axios requests
const EPISODE_FETCH_TIMEOUT_MS = 20000; // Longer timeout for episode fetches

// --- Cache Storage Constants ---
const BLOB_CACHE_KEY = 'mako-shows-cache-v1.json'; // Main cache for show list
const BLOB_METADATA_KEY = 'mako-shows-metadata-v1.json'; // Separate cache for show metadata
const MAX_BLOB_FILES_TO_KEEP = 1;

// Headers for requests
const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,he;q=0.8',
    'Referer': 'https://www.mako.co.il/mako-vod-index',
    'Connection': 'keep-alive'
};

// In-memory cache (simple version)
let memoryCache = null;
let memoryCacheTimestamp = 0;
let memoryMetadataCache = null;
let memoryMetadataTimestamp = 0;

// --- Cache Management Functions ---
const ensureCacheStructure = (cacheData, type = 'main') => {
    if (typeof cacheData !== 'object' || cacheData === null) {
        return type === 'main' 
            ? { timestamp: 0, shows: {} }
            : { timestamp: 0, metadata: {} };
    }
    
    if (type === 'main') {
        cacheData.shows = cacheData.shows || {};
        cacheData.timestamp = cacheData.timestamp || 0;
    } else {
        cacheData.metadata = cacheData.metadata || {};
        cacheData.timestamp = cacheData.timestamp || 0;
    }
    
    return cacheData;
};

const loadCache = async (type = 'main') => {
    const now = Date.now();
    // Return recent memory cache immediately (cache memory for 1 min)
    if (type === 'main' && memoryCache && (now - memoryCacheTimestamp < 60 * 1000)) {
        return memoryCache;
    }
    if (type === 'metadata' && memoryMetadataCache && (now - memoryMetadataTimestamp < 60 * 1000)) {
        return memoryMetadataCache;
    }

    let loadedData = null;
    const emptyCache = ensureCacheStructure(null, type);
    const cacheKey = type === 'main' ? BLOB_CACHE_KEY : BLOB_METADATA_KEY;

    if (blob) { // Production with Vercel Blob
        try {
            console.log(`Attempting to load ${type} cache blob: ${cacheKey}`);
            
            try {
                // List blobs to get the URL
                const { blobs } = await blob.list({ prefix: cacheKey });
                
                if (blobs && blobs.length > 0) {
                    // Get the most recent blob
                    const mostRecent = blobs
                        .filter(b => b.uploadedAt)
                        .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))[0];
                    
                    if (mostRecent && mostRecent.url) {
                        console.log(`Found ${type} cache blob: ${mostRecent.pathname}`);
                        const response = await axios.get(mostRecent.url, { 
                            timeout: REQUEST_TIMEOUT_MS + 5000 
                        });
                        
                        if (response.data && typeof response.data === 'object') {
                            loadedData = response.data;
                            console.log(`Successfully loaded ${type} cache from Blob: ${mostRecent.pathname}`);
                        } else {
                            console.warn(`Found ${type} cache blob ${mostRecent.pathname} but content was invalid type: ${typeof response.data}`);
                        }
                    }
                } else {
                    console.log(`No ${type} cache blob found: ${cacheKey}`);
                }
            } catch (getError) {
                if (getError.response && getError.response.status === 404) {
                    console.log(`Cache blob ${cacheKey} not found, will initialize new cache.`);
                } else {
                    console.error(`Error fetching ${type} cache blob ${cacheKey}:`, getError.message);
                }
            }

            if (!loadedData) {
                console.log(`Initializing new empty ${type} cache (Blob).`);
                loadedData = emptyCache;
            }
        } catch (e) {
            console.error(`Error during ${type} Blob cache loading:`, e.message);
            loadedData = emptyCache;
        }
    } else { // Local Development
        const localFile = type === 'main' ? LOCAL_CACHE_FILE : LOCAL_METADATA_FILE;
        try {
            if (fs.existsSync(localFile)) {
                const fileData = fs.readFileSync(localFile, 'utf8');
                loadedData = JSON.parse(fileData);
                console.log(`Loaded ${type} cache from local file: ${localFile}`);
            } else {
                console.log(`Local ${type} cache file not found. Initializing empty cache.`);
                loadedData = emptyCache;
            }
        } catch (e) {
            console.error(`Error loading ${type} cache from local file:`, e.message);
            loadedData = emptyCache;
        }
    }

    const cache = ensureCacheStructure(loadedData, type);
    if (type === 'main') {
        memoryCache = cache;
        memoryCacheTimestamp = now;
    } else {
        memoryMetadataCache = cache;
        memoryMetadataTimestamp = now;
    }
    
    return cache;
};

const saveCache = async (cache, type = 'main') => {
    if (!cache || typeof cache !== 'object') {
        console.error(`Attempted to save invalid ${type} cache object.`);
        return;
    }

    // Ensure structure and update timestamp *before* saving
    const cacheToSave = ensureCacheStructure({ ...cache }, type);
    cacheToSave.timestamp = Date.now();

    // Update memory cache immediately with the latest data
    if (type === 'main') {
        memoryCache = cacheToSave;
        memoryCacheTimestamp = cacheToSave.timestamp;
    } else {
        memoryMetadataCache = cacheToSave;
        memoryMetadataTimestamp = cacheToSave.timestamp;
    }

    const count = type === 'main' 
        ? Object.keys(cacheToSave.shows).length 
        : Object.keys(cacheToSave.metadata).length;

    if (blob) { // Production with Vercel Blob
        try {
            // First, delete any existing cache files
            const cacheKey = type === 'main' ? BLOB_CACHE_KEY : BLOB_METADATA_KEY;
            try {
                const { blobs } = await blob.list({ prefix: cacheKey });
                const deletePromises = blobs.map(oldBlob =>
                    blob.del(oldBlob.url)
                        .then(() => console.log(`Deleted old ${type} cache file: ${oldBlob.pathname}`))
                        .catch(delError => console.error(`Failed to delete old ${type} cache file ${oldBlob.pathname}:`, delError.message))
                );
                await Promise.all(deletePromises);
            } catch (cleanupError) {
                console.error(`Failed during ${type} cache cleanup:`, cleanupError.message);
            }

            // Save the new cache file with a deterministic name
            const putResult = await blob.put(cacheKey, JSON.stringify(cacheToSave), {
                access: 'public',
                contentType: 'application/json',
                addRandomSuffix: false
            });
            console.log(`${type} Cache saved successfully to Blob: ${putResult.pathname} (URL: ${putResult.url})`);

        } catch (e) {
            console.error(`Error saving ${type} cache to Blob storage:`, e.message);
            if (e.response) {
                console.error(`Axios Error Details: Status=${e.response.status}`);
            }
        }
    } else { // Local Development
        const localFile = type === 'main' ? LOCAL_CACHE_FILE : LOCAL_METADATA_FILE;
        try {
            const cacheDir = path.dirname(localFile);
            if (!fs.existsSync(cacheDir)) {
                fs.mkdirSync(cacheDir, { recursive: true });
            }
            fs.writeFileSync(localFile, JSON.stringify(cacheToSave, null, 2), 'utf8');
            console.log(`${type} Cache saved locally (${count} items) to ${localFile}`);
        } catch (e) {
            console.error(`Error saving ${type} cache to local file:`, e.message);
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
        const response = await axios.get(url, { headers: HEADERS, timeout: REQUEST_TIMEOUT_MS, maxRedirects: 5 });
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
        await sleep(DELAY_BETWEEN_REQUESTS_MS);
        console.log(`Extracting ${contentType} from ${url}`);
        
        // Increase timeout for initial show extraction
        const timeout = contentType === 'shows' ? REQUEST_TIMEOUT_MS * 2 : REQUEST_TIMEOUT_MS;
        const response = await axios.get(url, { 
            headers: HEADERS, 
            timeout: timeout,
            maxRedirects: 5
        });
        
        const $ = cheerio.load(response.data);

        const configs = {
            shows: {
                selectors: [
                    '.vod_item_wrap article a[href^="/mako-vod-"]',
                    '.vod_item article a[href^="/mako-vod-"]',
                    'li.grid-item a[href^="/mako-vod-"]',
                    'section[class*="vod"] a[href^="/mako-vod-"]',
                    'a[href^="/mako-vod-"]:not([href*="purchase"]):not([href*="index"])',
                ],
                fields: {
                    url: { attribute: 'href' },
                    name: [
                        { selector: '.title strong' },
                        { selector: 'h3.title' },
                        { selector: 'h2.title' },
                        { selector: '.vod-title' },
                        { selector: '.caption' },
                        { selector: 'img', attribute: 'alt' },
                        { text: true }
                    ],
                    poster: { selector: 'img', attribute: 'src' }
                },
                base: BASE_URL,
                filter: (item) => {
                    if (!item.url) return false;
                    
                    // Only filter out obviously invalid URLs
                    if (item.url.includes('purchase')) return false;
                    if (item.url.includes('index')) return false;
                    if (item.url.includes('live')) return false;
                    
                    return true;
                }
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

        // For shows, we want to preserve the original order from the HTML
        if (contentType === 'shows') {
            // Find all show links in the order they appear in the HTML
            const showLinks = [];
            const seenUrls = new Set();

            // Try each selector and combine results
            for (const selector of config.selectors) {
                $(selector).each((_, elem) => {
                    const $elem = $(elem);
                    const href = $elem.attr('href');
                    if (href && !seenUrls.has(href)) {
                        seenUrls.add(href);
                        showLinks.push({
                            element: $elem,
                            url: href
                        });
                    }
                });
            }

            console.log(`Found ${showLinks.length} unique show links from all selectors`);

            // Process each show in the original order
            for (const { element, url } of showLinks) {
                const item = {
                    url: new URL(url, config.base).href.split('?')[0].split('#')[0]
                };

                // Extract name using the same logic as before
                for (const nameConf of config.fields.name) {
                    try {
                        const target = nameConf.selector ? element.find(nameConf.selector) : element;
                        if (target.length) {
                            let value = nameConf.attribute ? target.first().attr(nameConf.attribute) : (nameConf.text ? element.text() : target.first().text());
                            if (value) {
                                item.name = value.replace(/\s+/g, ' ').trim();
                                break;
                            }
                        }
                    } catch(nameSelectorError){ continue; }
                }

                // Extract poster
                try {
                    item.poster = processImageUrl(
                        element.find('img').attr('src') ||
                        element.find('meta[property="og:image"]').attr('content') ||
                        element.find('meta[name="twitter:image"]').attr('content')
                    );
                } catch(posterError) { }

                if (config.filter(item)) {
                    items.push(item);
                }
            }
        } else {
            // For other content types, use the existing logic
            let elements = [];
            for (const selector of config.selectors) {
                try {
                    elements = $(selector).toArray();
                    if (elements.length > 0) {
                        console.log(`Found ${elements.length} elements for ${contentType} with selector: ${selector}`);
                        break;
                    }
                } catch(selectorError) {
                    console.warn(`Selector "${selector}" failed: ${selectorError.message}`);
                }
            }
            if (elements.length === 0) console.warn(`No elements found for ${contentType} at ${url}`);

            for (const elem of elements) {
                const item = {};
                for (const [field, fieldConfig] of Object.entries(config.fields)) {
                    if (field === 'name' && Array.isArray(fieldConfig)) {
                        for (const nameConf of fieldConfig) {
                            try {
                                const target = nameConf.selector ? $(elem).find(nameConf.selector) : $(elem);
                                if (target.length) {
                                    let value = nameConf.attribute ? target.first().attr(nameConf.attribute) : (nameConf.text ? $(elem).text() : target.first().text());
                                    if (value) {
                                        item[field] = value.replace(/\s+/g, ' ').trim();
                                        break;
                                    }
                                }
                            } catch(nameSelectorError){ continue; }
                        }
                        continue;
                    }

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
                                else value = null;
                            }
                            if (value && field === 'url') {
                                value = new URL(value, config.base).href.split('?')[0].split('#')[0];
                            }
                            if (value !== undefined && value !== null && value !== '') item[field] = value;
                        }
                    } catch(fieldError) { continue; }
                }

                if (config.filter(item)) {
                    const key = item.guid || item.url;
                    if (key && !seen.has(key)) {
                        if (contentType === 'shows') {
                            item.name = item.name || 'Unknown Show';
                            item.poster = processImageUrl(item.poster) || 'https://www.mako.co.il/assets/images/svg/mako_logo.svg';
                            item.background = item.poster;
                        } else if (contentType === 'episodes' && !item.name) {
                            item.name = $(elem).text().replace(/\s+/g, ' ').trim() || null;
                        }

                        items.push(item);
                        seen.add(key);
                    }
                }
            }
        }

        if (contentType === 'shows') {
            console.log(`Extracted ${items.length} valid initial show items for ${url}`);
            const cache = await loadCache();
            const cacheIsFresh = Date.now() - (cache.timestamp || 0) < CACHE_TTL_MS;
            
            for (const show of items) {
                if (cache.shows && cache.shows[show.url]) {
                    const cachedData = cache.shows[show.url];
                    show.name = cachedData.name || show.name;
                    show.poster = cachedData.poster || show.poster;
                    show.background = cachedData.background || show.poster;
                }
                show.name = show.name || 'Loading...';
                show.poster = show.poster || 'https://www.mako.co.il/assets/images/svg/mako_logo.svg';
                show.background = show.background || show.poster;
            }
            
            if(cacheIsFresh) console.log("Applied cached details where available.");
            else console.log("Cache is stale or empty, applying defaults.");
        }

        return items;
    } catch (e) {
        console.error(`Error in extractContent (${contentType}, ${url}):`, e.message);
        return [];
    }
};


// getVideoUrl: No changes needed from previous working version
const getVideoUrl = async (episodeUrl) => {
    console.log(`getVideoUrl: Starting process for episode URL: ${episodeUrl}`);
    try {
        // 1. Fetch Episode Page HTML
        const episodePageResponse = await axios.get(episodeUrl, {
            headers: HEADERS, timeout: REQUEST_TIMEOUT_MS, responseType: 'text'
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
            timeout: REQUEST_TIMEOUT_MS,
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
            timeout: REQUEST_TIMEOUT_MS,
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

// --- Background Refresh Constants ---
const REFRESH_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
const BATCH_SIZE = 10; // Number of shows to process in each batch
let refreshInterval = null;

// --- Background Refresh Functions ---
const processShowMetadata = async (url) => {
    try {
        console.log(`Fetching fresh details for ${url}`);
        const response = await axios.get(`${BASE_URL}${url}`, {
            timeout: REQUEST_TIMEOUT_MS * 2,
            maxRedirects: 5
        });

        // Parse the HTML
        const $ = cheerio.load(response.data);
        
        // Extract JSON-LD data for show name (more accurate)
        let name = '';
        const jsonLdScript = $('script[type="application/ld+json"]').html();
        if (jsonLdScript) {
            try {
                const jsonData = JSON.parse(jsonLdScript);
                
                // Check if this is a TVSeason and get the series name
                if (jsonData['@type'] === 'TVSeason' && jsonData.partOfTVSeries) {
                    name = jsonData.partOfTVSeries.name;
                    console.log(`Found TVSeason, using series name: ${name}`);
                } else {
                    // Regular TVSeries handling
                    name = jsonData.name;
                }
                
                console.log(`Extracted name from JSON-LD: ${name}`);
                
                // Add season info if available
                if (jsonData.containsSeason && Array.isArray(jsonData.containsSeason) && jsonData.containsSeason.length > 1) {
                    const seasonsCount = jsonData.containsSeason.length;
                    name = `${name} (${seasonsCount} עונות)`;
                }
            } catch (jsonError) {
                console.warn(`Error parsing JSON-LD for ${url}: ${jsonError.message}`);
            }
        }
        
        // Fallback to meta tags if JSON-LD extraction failed
        if (!name) {
            name = $('meta[property="og:title"]').attr('content') ||
                   $('meta[name="title"]').attr('content') ||
                   $('title').text();
            
            // Clean up the name
            if (name) {
                name = name.replace('מאקו', '').replace('VOD', '').trim();
            }
        }
        
        // Get background image
        const background = $('meta[property="og:image"]').attr('content') || 
                          $('.hero-image img').attr('src') || 
                          $('.show-image img').attr('src');
                          
        // Get poster image
        let poster = $('.vod-item img').attr('src') || 
                     $('.show-poster img').attr('src') || 
                     $('meta[property="og:image:secure_url"]').attr('content');
                     
        if (!poster && background) {
            poster = background;
        }
        
        // Only return metadata if we have the necessary fields
        if (name && (poster || background)) {
            return {
                name,
                poster,
                background: background || poster,
                lastUpdated: Date.now()
            };
        }
        
        console.warn(`Could not extract metadata for ${url}`);
        return null;
    } catch (error) {
        console.error(`Error processing show metadata for ${url}:`, error.message);
        return null;
    }
};

const updateShowMetadata = async (shows) => {
    console.log('Starting show metadata update...');
    
    if (!shows || !Array.isArray(shows) || shows.length === 0) {
        console.warn('No shows to update metadata for');
        return;
    }
    
    try {
        let metadataCache = await loadCache('metadata');
        
        // Safety check: ensure metadataCache exists
        if (!metadataCache) {
            console.log('Creating new metadata cache object');
            metadataCache = { timestamp: Date.now(), metadata: {} };
        }
        
        // Ensure metadata structure exists
        if (!metadataCache.metadata) {
            console.log('Initializing empty metadata object');
            metadataCache.metadata = {};
        }
        
        // Process shows in batches
        for (let i = 0; i < shows.length; i += BATCH_SIZE) {
            const batch = shows.slice(i, i + BATCH_SIZE);
            console.log(`Processing metadata batch ${Math.floor(i/BATCH_SIZE) + 1}/${Math.ceil(shows.length/BATCH_SIZE)}`);
            
            const batchPromises = batch.map(async (show) => {
                if (!show || !show.url) {
                    console.log('Skipping show with missing URL');
                    return;
                }
                
                // Skip if we have fresh metadata
                try {
                    const existingMetadata = metadataCache.metadata[show.url];
                    if (existingMetadata && (Date.now() - existingMetadata.lastUpdated < CACHE_TTL_MS)) {
                        console.log(`Using cached metadata for ${show.url}`);
                        return;
                    }
                } catch (err) {
                    console.error(`Error checking existing metadata: ${err.message}`);
                }
                
                try {
                    const metadata = await processShowMetadata(show.url);
                    if (metadata) {
                        metadataCache.metadata[show.url] = metadata;
                        console.log(`Updated metadata for ${show.url}: ${metadata.name}`);
                    }
                } catch (err) {
                    console.error(`Error processing metadata for ${show.url}: ${err.message}`);
                }
                
                await sleep(100); // Small delay between requests
            });
            
            try {
                await Promise.all(batchPromises);
                await saveCache(metadataCache, 'metadata');
                console.log(`Saved metadata cache after batch ${Math.floor(i/BATCH_SIZE) + 1}`);
            } catch (err) {
                console.error(`Error processing batch: ${err.message}`);
            }
            
            await sleep(1000); // Delay between batches
        }
        
        console.log('Completed show metadata update');
    } catch (err) {
        console.error(`Error in updateShowMetadata: ${err.message}`);
    }
};

const backgroundRefresh = async () => {
    try {
        console.log('Starting background refresh...');
        
        // Get fresh show list from index page
        const shows = await extractContent(`${BASE_URL}/mako-vod-index`, 'shows');
        console.log(`Found ${shows.length} shows to process`);
        
        // Load metadata cache
        const metadataCache = await loadCache('metadata');
        
        // Ensure metadata structure exists
        if (!metadataCache.metadata) {
            console.log('Creating new metadata object in cache');
            metadataCache.metadata = {};
        }
        
        // Count shows needing metadata
        let needsMetadataCount = 0;
        for (const show of shows) {
            if (!show.url) continue;
            
            // Check if we need to update metadata for this show
            const existingMetadata = metadataCache.metadata[show.url];
            if (!existingMetadata || (Date.now() - (existingMetadata.lastUpdated || 0) > CACHE_TTL_MS)) {
                needsMetadataCount++;
            }
        }
        
        console.log(`Found ${needsMetadataCount} shows needing metadata updates out of ${shows.length} total shows`);
        
        // Update metadata for all shows
        await updateShowMetadata(shows);
        
        // Save the updated timestamp
        metadataCache.timestamp = Date.now();
        await saveCache(metadataCache, 'metadata');
        
        console.log('Background refresh completed successfully');
    } catch (err) {
        console.error('Background refresh error:', err);
    }
};

// Start background refresh immediately and set up interval
const startBackgroundRefresh = () => {
    if (refreshInterval) {
        clearInterval(refreshInterval);
    }
    
    console.log('Starting initial background refresh to populate metadata cache...');
    // Run immediately on startup with high priority
    setTimeout(() => {
        backgroundRefresh().catch(err => console.error('Initial background refresh failed:', err));
    }, 100);
    
    // Then set up interval for regular updates
    refreshInterval = setInterval(backgroundRefresh, REFRESH_INTERVAL);
    console.log(`Background refresh scheduled to run every ${REFRESH_INTERVAL/1000/60/60} hours`);
};

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

// Get the addon interface
const addonInterface = builder.getInterface();

// Use the SDK's serveHTTP function to handle all addon routes automatically
serveHTTP(addonInterface, { app });

// Redirect root to manifest
app.get('/', (req, res) => res.redirect('/manifest.json'));

// Handle other requests (404)
app.use((req, res) => {
    console.warn('Unknown request:', req.method, req.url);
    res.status(404).json({ error: 'Not Found' });
});

// Start background refresh when the app starts
startBackgroundRefresh();

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