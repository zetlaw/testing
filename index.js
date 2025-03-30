// index.js
const { addonBuilder } = require('stremio-addon-sdk'); // Removed serveHTTP
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const express = require('express'); // Require express
const cors = require('cors');     // Require cors

// Use the external crypto.js module that uses AES-192
const { CRYPTO, cryptoOp } = require('./crypto');

// ** Log NODE_ENV on startup **
console.log(`Current NODE_ENV: ${process.env.NODE_ENV}`);
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// Import Vercel Blob for serverless storage
let blob;
if (IS_PRODUCTION) {
    try {
        const vercelBlob = require('@vercel/blob');
        blob = {
            put: vercelBlob.put,
            list: vercelBlob.list,
            del: vercelBlob.del // Keep del for cleanup
        };
        console.log("Successfully required @vercel/blob package.");
    } catch (e) {
        console.error('Failed to load @vercel/blob, cache will not persist:', e.message);
        blob = null;
    }
} else {
    console.log("Not in production, Vercel Blob will not be used.");
    blob = null;
}

// --- Constants ---
const BASE_URL = "https://www.mako.co.il";
// Define Local Cache Paths using .cache directory
const LOCAL_CACHE_DIR = path.join(__dirname, '.cache');
const LOCAL_CACHE_FILE = path.join(LOCAL_CACHE_DIR, "mako_shows_cache.json");
const LOCAL_METADATA_FILE = path.join(LOCAL_CACHE_DIR, "mako_shows_metadata.json");

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days in milliseconds
const DELAY_BETWEEN_REQUESTS_MS = 500; // 0.5 second delay
const REQUEST_TIMEOUT_MS = 10000; // 10 seconds for standard axios requests
const EPISODE_FETCH_TIMEOUT_MS = 20000; // Longer timeout for episode fetches

// --- Cache Storage Constants ---
// Use PREFFIX for Blob keys as put adds random suffix
const BLOB_CACHE_KEY_PREFIX = 'mako-shows-cache-v1'; // Main cache for show list
const BLOB_METADATA_KEY_PREFIX = 'mako-shows-metadata-v1'; // Separate cache for show metadata
const MAX_BLOB_FILES_TO_KEEP = 2; // Keep the 2 most recent cache blobs

// Headers for requests
const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,he;q=0.8',
    'Referer': `${BASE_URL}/mako-vod-index`,
    'Connection': 'keep-alive'
};
const DEFAULT_LOGO = 'https://www.mako.co.il/assets/images/svg/mako_logo.svg';

// --- In-memory Caches ---
let memoryCache = null; // For main show list
let memoryCacheTimestamp = 0;
let memoryMetadataCache = null; // For show details/episodes
let memoryMetadataTimestamp = 0;

// --- Cache Management Functions (Use the improved versions) ---

const ensureCacheStructure = (cacheData, type = 'main') => {
    // Defines the expected empty state for each cache type
    const emptyMain = { timestamp: 0, shows: {} };
    const emptyMetadata = { timestamp: 0, metadata: {}, seasons: {} }; // Added seasons here

    if (typeof cacheData !== 'object' || cacheData === null) {
        return type === 'main' ? emptyMain : emptyMetadata;
    }

    if (type === 'main') {
        cacheData.shows = cacheData.shows || {};
    } else { // metadata type
        cacheData.metadata = cacheData.metadata || {};
        cacheData.seasons = cacheData.seasons || {}; // Ensure seasons exists for metadata cache
    }
    cacheData.timestamp = cacheData.timestamp || 0;
    return cacheData;
};

const loadCache = async (type = 'main') => {
    const now = Date.now();
    // Return recent memory cache immediately (cache memory for 1 min)
    const memoryTarget = type === 'main' ? memoryCache : memoryMetadataCache;
    const memoryTimestampTarget = type === 'main' ? memoryCacheTimestamp : memoryMetadataTimestamp;

    if (memoryTarget && (now - memoryTimestampTarget < 60 * 1000)) {
        // console.log(`Returning recent memory cache for ${type}.`);
        return memoryTarget;
    }

    let loadedData = null;
    const emptyCache = ensureCacheStructure(null, type);
    const cacheKeyPrefix = type === 'main' ? BLOB_CACHE_KEY_PREFIX : BLOB_METADATA_KEY_PREFIX;
    const localFile = type === 'main' ? LOCAL_CACHE_FILE : LOCAL_METADATA_FILE;

    if (blob) { // Production with Vercel Blob
        try {
            console.log(`Attempting to load ${type} cache blob with prefix: ${cacheKeyPrefix}`);
            let mostRecent = null;

            try {
                const { blobs } = await blob.list({ prefix: cacheKeyPrefix });

                if (blobs && blobs.length > 0) {
                    const validBlobs = blobs.filter(b => b.uploadedAt);
                    if (validBlobs.length > 0) {
                        mostRecent = validBlobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))[0];
                        console.log(`Found most recent ${type} cache blob: ${mostRecent.pathname}, Size: ${mostRecent.size}, Uploaded: ${mostRecent.uploadedAt}`);

                        if (mostRecent.size > 0) {
                            const response = await axios.get(mostRecent.url, { timeout: REQUEST_TIMEOUT_MS + 5000 });
                            if (typeof response.data === 'object' && response.data !== null) {
                                loadedData = response.data;
                                console.log(`Successfully loaded ${type} cache from Blob: ${mostRecent.pathname}`);
                            } else {
                                console.warn(`Workspaceed ${type} cache blob ${mostRecent.pathname} but content was invalid type: ${typeof response.data}`);
                            }
                        } else {
                            console.warn(`Found most recent ${type} cache blob ${mostRecent.pathname} but it has size 0. Ignoring.`);
                        }
                    } else {
                        console.log(`No blobs found with prefix ${cacheKeyPrefix} that have valid upload dates.`);
                    }
                } else {
                    console.log(`No ${type} cache blobs found with prefix: ${cacheKeyPrefix}`);
                }
            } catch (listOrGetError) {
                if (listOrGetError.response) {
                     console.error(`Error fetching ${type} cache blob ${mostRecent?.url || 'N/A'}: Status ${listOrGetError.response.status}`, listOrGetError.message);
                } else if (listOrGetError.message && listOrGetError.message.includes('Failed to list blobs')) {
                     console.error(`Error listing ${type} blobs:`, listOrGetError.message);
                } else {
                     console.error(`Error during ${type} blob list/fetch operation:`, listOrGetError);
                }
            }

            if (!loadedData) {
                console.log(`Initializing new empty ${type} cache (Blob).`);
                loadedData = emptyCache;
            }
        } catch (e) {
            console.error(`Outer error during ${type} Blob cache loading:`, e.message);
            loadedData = emptyCache;
        }
    } else { // Local Development
        try {
            // Ensure cache directory exists for local dev
            const cacheDir = path.dirname(localFile);
            if (!fs.existsSync(cacheDir)) {
                fs.mkdirSync(cacheDir, { recursive: true });
            }

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

    // Ensure structure and update appropriate memory cache
    const cache = ensureCacheStructure(loadedData, type);
    if (type === 'main') {
        memoryCache = cache;
        memoryCacheTimestamp = now;
    } else {
        memoryMetadataCache = cache;
        memoryMetadataTimestamp = now;
    }
    // console.log(`${type} Cache loaded. Timestamp: ${new Date(cache.timestamp).toISOString()}`);
    return cache;
};

const saveCache = async (cache, type = 'main') => {
    if (!cache || typeof cache !== 'object') {
        console.error(`Attempted to save invalid ${type} cache object.`);
        return;
    }

    const cacheToSave = ensureCacheStructure({ ...cache }, type);
    cacheToSave.timestamp = Date.now();

    if (type === 'main') {
        memoryCache = cacheToSave;
        memoryCacheTimestamp = cacheToSave.timestamp;
    } else {
        memoryMetadataCache = cacheToSave;
        memoryMetadataTimestamp = cacheToSave.timestamp;
    }

    const count = type === 'main' ? Object.keys(cacheToSave.shows).length : Object.keys(cacheToSave.metadata).length;
    const cacheKeyPrefix = type === 'main' ? BLOB_CACHE_KEY_PREFIX : BLOB_METADATA_KEY_PREFIX;
    const localFile = type === 'main' ? LOCAL_CACHE_FILE : LOCAL_METADATA_FILE;

    if (blob) { // Production with Vercel Blob
        let uniquePathname = ''; // Define here for error logging scope
        try {
            uniquePathname = `${cacheKeyPrefix}-${cacheToSave.timestamp}-${Math.random().toString(36).substring(2, 10)}.json`;
            console.log(`Attempting to save ${type} cache (${count} items) to Blob: ${uniquePathname}`);

            const putResult = await blob.put(uniquePathname, JSON.stringify(cacheToSave), {
                access: 'public',
                contentType: 'application/json'
            });
            console.log(`${type} Cache saved successfully to Blob: ${putResult.pathname} (URL: ${putResult.url})`);

            // Cleanup old files
            try {
                const { blobs } = await blob.list({ prefix: cacheKeyPrefix });
                const validBlobs = blobs.filter(b => b.uploadedAt);

                if (validBlobs.length > MAX_BLOB_FILES_TO_KEEP) {
                    const sortedBlobs = validBlobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
                    const blobsToDelete = sortedBlobs.slice(MAX_BLOB_FILES_TO_KEEP);
                    console.log(`Found ${validBlobs.length} valid ${type} blobs, deleting ${blobsToDelete.length} older ones.`);
                    const deletePromises = blobsToDelete.map(oldBlob =>
                        blob.del(oldBlob.url)
                           .then(() => console.log(`Deleted old ${type} cache file: ${oldBlob.pathname}`))
                           .catch(delError => console.error(`Failed to delete old ${type} cache file ${oldBlob.pathname}:`, delError.message))
                    );
                    await Promise.all(deletePromises);
                }
            } catch (cleanupError) {
                console.error(`Failed during ${type} cache cleanup:`, cleanupError.message);
            }
        } catch (e) {
            console.error(`Error saving ${type} cache to Blob storage (Path: ${uniquePathname}):`, e.message);
            if (e.response) { console.error(`Axios Error Details: Status=${e.response.status}`); }
        }
    } else { // Local Development
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
    if (!url || typeof url !== 'string') return null;
    url = url.trim();
    if (url.startsWith('//_next/')) return null;
    if (url.startsWith('http')) return url;
    if (url.startsWith('//')) return `https:${url}`;
    if (url.startsWith('/')) return `${BASE_URL}${url}`;
    return null;
};
const getValidImage = (url) => processImageUrl(url) || DEFAULT_LOGO;

// --- Data Extraction Functions ---

const extractShowNameAndImages = async (url) => {
    // console.log(`Extracting show details from ${url}`); // Reduced logging noise
    try {
        const response = await axios.get(url, { headers: HEADERS, timeout: REQUEST_TIMEOUT_MS });
        const $ = cheerio.load(response.data);
        let name = null;
        let poster = null;
        let background = null;
        let description = 'מאקו VOD'; // Default description

        // 1. Try JSON-LD
        try {
            const jsonldTag = $('script[type="application/ld+json"]').html();
            if (jsonldTag) {
                const data = JSON.parse(jsonldTag);
                // Determine base entity (Series or Season)
                const seriesData = data['@type'] === 'TVSeries' ? data : data.partOfTVSeries;
                const seasonData = data['@type'] === 'TVSeason' ? data : null;

                if (seriesData?.name) {
                    name = seriesData.name;
                    // Add description if available
                    if (seriesData.description) description = seriesData.description;
                    // Try to get a good poster from the series data
                    if (seriesData.image) poster = Array.isArray(seriesData.image) ? seriesData.image[0] : seriesData.image;
                    if (seriesData.thumbnailUrl) poster = poster || seriesData.thumbnailUrl; // Fallback
                } else if (seasonData?.name) {
                    // Less ideal, but use season name if series name missing
                    name = seasonData.name;
                     if (seasonData.description) description = seasonData.description;
                     if (seasonData.image) poster = Array.isArray(seasonData.image) ? seasonData.image[0] : seasonData.image;
                }

                // Append season count if multiple seasons detected
                if (name && seriesData?.containsSeason && Array.isArray(seriesData.containsSeason) && seriesData.containsSeason.length > 1) {
                     name = `${name} (${seriesData.containsSeason.length} עונות)`;
                }
                 if(name) name = name.replace(/\s+/g, ' ').trim();
            }
        } catch (jsonErr) {
            console.warn(`Warn parsing JSON-LD for ${url}: ${jsonErr.message.substring(0, 100)}...`);
            name = null; // Reset if parsing failed
        }

        // 2. Fallback Meta Tags / H1 (if JSON-LD failed or didn't provide name)
        if (!name) {
            const ogTitle = $('meta[property="og:title"]').attr('content');
            const h1Title = $('h1').first().text();
            name = ogTitle || h1Title;
            if (name) {
                 name = name.replace(/\s+/g, ' ').trim();
                // console.log(`Using fallback name: ${name} for ${url}`);
            } else {
                 console.log(`No name found via JSON-LD, meta, or H1 for ${url}`);
            }
        }
        // Get description from meta if not found in JSON-LD
         if (description === 'מאקו VOD') {
             description = $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || description;
             if(description) description = description.replace(/\s+/g, ' ').trim();
         }

        // 3. Extract Images (try meta tags first, then common structures)
         if (!poster) { // Only run if JSON-LD didn't provide a poster
             poster = getValidImage(
                 $('meta[property="og:image"]').attr('content') ||
                 $('meta[name="twitter:image"]').attr('content') ||
                 $('link[rel="image_src"]').attr('href') ||
                 $('.vod_item img').first().attr('src') ||
                 $('.vod_item_wrap img').first().attr('src')
             );
         } else {
             poster = getValidImage(poster); // Validate poster from JSON-LD
         }

        // Try finding a potentially larger background image
        background = getValidImage($('meta[property="og:image:width"][content="1920"]').parent().attr('content')) || poster;

        return {
            name: name || 'Unknown Show',
            poster: poster,
            background: background,
            description: description
        };

    } catch (e) {
        console.error(`Error extracting show details from ${url}:`, e.message);
        return {
            name: 'Error Loading Show',
            poster: DEFAULT_LOGO,
            background: DEFAULT_LOGO,
            description: 'Error loading description'
        };
    }
};

const extractContent = async (url, contentType) => {
    // console.log(`Extracting ${contentType} from ${url}`); // Reduce noise
    try {
        await sleep(DELAY_BETWEEN_REQUESTS_MS);
        const response = await axios.get(url, {
            headers: HEADERS,
            timeout: contentType === 'episodes' ? EPISODE_FETCH_TIMEOUT_MS : REQUEST_TIMEOUT_MS
        });
        const $ = cheerio.load(response.data);

        const configs = {
            shows: { // Config for extracting initial show links from index
                selectors: [
                    '.vod_item_wrap article a[href^="/mako-vod-"]',
                    '.vod_item article a[href^="/mako-vod-"]',
                    'li.grid-item a[href^="/mako-vod-"]',
                    'section[class*="vod"] a[href^="/mako-vod-"]',
                    'a[href^="/mako-vod-"]:not([href*="purchase"]):not([href*="index"])',
                ],
                fields: { // Minimal fields needed for catalog list
                    url: { attribute: 'href' },
                    name: [ // Try various places for name
                        { selector: '.title strong' }, { selector: 'h3.title' }, { selector: 'h2.title' },
                        { selector: '.vod-title' }, { selector: '.caption' },
                        { selector: 'img', attribute: 'alt' },
                        { text: true } // Link text last resort
                    ],
                    poster: { selector: 'img', attribute: 'src' } // Initial poster guess
                },
                base: BASE_URL,
                filter: (item) => item.url && !item.url.includes('/purchase') && !item.url.includes('/index') && !item.url.match(/live/i)
            },
            seasons: {
                selectors: ['div#seasonDropdown ul ul li a', '.seasons_nav a'],
                fields: { name: { selector: 'span', text: true }, url: { attribute: 'href' } },
                base: url,
                filter: (item) => item.url && item.name && !item.name.toLowerCase().includes('כל הפרקים')
            },
            episodes: {
                selectors: [ // Order matters
                    'li.vod_item a[href*="videoGuid="]', '.vod_item a[href*="videoGuid="]',
                    '.vod_item_wrap a[href*="videoGuid="]', 'li.card a[href*="videoGuid="]',
                    'a[href*="videoGuid="]', // General GUID link
                     // Fallback selectors if GUID not directly in href
                     'li.vod_item a', '.vod_item a', '.vod_item_wrap a', 'li.card a'
                ],
                fields: {
                    name: [
                         { selector: '.title strong' }, { selector: '.vod-title' }, { selector: '.caption' },
                         { text: true } // Fallback to link text
                    ],
                    url: { attribute: 'href' },
                    // GUID extracted later from URL
                    // thumbnail: { selector: 'img', attribute: 'src'} // Optionally extract thumbnail
                },
                base: url,
                filter: (item) => item.url // Require URL initially
            }
        };

        const config = configs[contentType];
        const items = [];
        const seenUrlsOrGuids = new Set();

        // Use a combined approach for finding elements to preserve order better for shows
        let combinedElements = [];
        const addedHrefs = new Set(); // Track hrefs to avoid duplicates from multiple selectors

        for (const selector of config.selectors) {
            try {
                $(selector).each((_, elem) => {
                    const $elem = $(elem);
                    const href = $elem.attr('href'); // Use href as the primary identifier for uniqueness here
                    const uniqueKey = href; // For shows/seasons, URL is key

                    if (uniqueKey && !addedHrefs.has(uniqueKey)) {
                         combinedElements.push(elem);
                         addedHrefs.add(uniqueKey);
                    } else if (!uniqueKey && contentType === 'episodes') {
                        // For episodes without a clear href initially (less likely now), add anyway
                        combinedElements.push(elem);
                    }
                });
            } catch (selectorError) {
                console.warn(`Selector "${selector}" failed on ${url}: ${selectorError.message}`);
            }
        }

        if (combinedElements.length === 0) {
            console.warn(`No elements found for ${contentType} at ${url} using configured selectors.`);
            return [];
        }
         // console.log(`Processing ${combinedElements.length} potential ${contentType} elements for ${url}`);


        for (const elem of combinedElements) {
            const item = {};
            const $elem = $(elem); // Use wrapped element for easier access

            for (const [field, fieldConfig] of Object.entries(config.fields)) {
                // Handle array of selectors (like 'name')
                if (Array.isArray(fieldConfig)) {
                    for (const subConf of fieldConfig) {
                         try {
                            // Find within the current element $elem
                            const target = subConf.selector ? $elem.find(subConf.selector) : $elem;
                            if (target.length > 0) {
                                // Use $elem.text() if text: true and no selector
                                let value = subConf.attribute ? target.first().attr(subConf.attribute) : (subConf.text && !subConf.selector ? $elem.text() : target.first().text());
                                if (value) {
                                    item[field] = value.replace(/\s+/g, ' ').trim();
                                    break; // Use first successful selector
                                }
                            }
                         } catch (subErr) { console.warn(`Sub-selector error for ${field}: ${subErr.message}`); continue; }
                    }
                } else { // Handle single selector config
                    try {
                        const target = fieldConfig.selector ? $elem.find(fieldConfig.selector) : $elem;
                        if (target.length > 0) {
                            let value = fieldConfig.attribute ? target.first().attr(fieldConfig.attribute) : target.first().text();
                             if (value !== undefined && value !== null) {
                                 value = String(value).replace(/\s+/g, ' ').trim();
                                 if (field === 'url' && value) {
                                     try { value = new URL(value, config.base).href.split('?')[0].split('#')[0]; }
                                     catch (urlError) { value = null; }
                                 }
                                 if (value) item[field] = value;
                            }
                        }
                    } catch (fieldErr) { console.warn(`Field selector error for ${field}: ${fieldErr.message}`); continue; }
                }
            }

            // Post-processing and Uniqueness Check
             let uniqueKey = null;
             if (contentType === 'episodes') {
                 if (item.url) { // Extract GUID from URL
                     const guidMatch = item.url.match(/[?&](guid|videoGuid)=([\w-]+)/i) || item.url.match(/\/VOD-([\w-]+)\.htm/);
                     if (guidMatch && guidMatch[1]) item.guid = guidMatch[1];
                     else if (guidMatch && guidMatch[2]) item.guid = guidMatch[2];
                 }
                 if (!item.guid) continue; // Skip episodes without GUID
                 uniqueKey = item.guid;
                 if (!item.name) item.name = `Episode ${item.guid.substring(0,6)}...`; // Default name
                 // item.thumbnail = getValidImage(item.thumbnail); // Process thumbnail if extracted
             } else { // Shows or Seasons
                 if (!item.url) continue; // Skip if no URL
                 uniqueKey = item.url;
                 if (contentType === 'shows') {
                     item.name = item.name || 'Unknown Show';
                     item.poster = getValidImage(item.poster); // Validate initial poster
                     // Background/description fetched later in meta handler
                 }
                  if (contentType === 'seasons' && !item.name) {
                      const seasonMatch = item.url.match(/season-(\d+)/i);
                      if(seasonMatch) item.name = `Season ${seasonMatch[1]}`;
                      else item.name = "Unknown Season";
                  }
             }

            // Final filter check and add if unique
            if (config.filter(item) && uniqueKey && !seenUrlsOrGuids.has(uniqueKey)) {
                items.push(item);
                seenUrlsOrGuids.add(uniqueKey);
            }
        }

        // console.log(`Extracted ${items.length} valid unique ${contentType} items for ${url}`);
        return items;

    } catch (e) {
        console.error(`Error in extractContent (${contentType}, ${url}):`, e.message);
        return []; // Return empty array on error
    }
};


const getVideoUrl = async (episodeUrl) => {
    // This function seems correct based on previous iterations. Keep as is.
    console.log(`getVideoUrl: Starting process for episode URL: ${episodeUrl}`);
    try {
        // 1. Fetch Episode Page HTML
        const episodePageResponse = await axios.get(episodeUrl, { headers: HEADERS, timeout: REQUEST_TIMEOUT_MS, responseType: 'text' });
        const $ = cheerio.load(episodePageResponse.data);
        const script = $('#__NEXT_DATA__').html();
        if (!script) { throw new Error("Could not find __NEXT_DATA__ script tag."); }

        // 2. Parse __NEXT_DATA__
        let videoDetails;
        try {
            const data = JSON.parse(script);
            const vodData = data?.props?.pageProps?.data?.vod;
            if (!vodData) throw new Error("Could not find 'vod' data in __NEXT_DATA__.");
            videoDetails = {
                vcmid: vodData.itemVcmId,
                galleryChannelId: vodData.galleryChannelId,
                videoChannelId: vodData.channelId
            };
            if (!videoDetails.vcmid || !videoDetails.galleryChannelId || !videoDetails.videoChannelId) {
                throw new Error(`Missing required video details: ${JSON.stringify(videoDetails)}`);
            }
        } catch (e) { throw new Error(`Parsing __NEXT_DATA__ JSON failed: ${e.message}`); }

        // 3. Construct and Fetch Encrypted Playlist URL
        const ajaxUrl = `${BASE_URL}/AjaxPage?jspName=playlist12.jsp&vcmid=${videoDetails.vcmid}&videoChannelId=${videoDetails.videoChannelId}&galleryChannelId=${videoDetails.galleryChannelId}&consumer=responsive`;
        const playlistResponse = await axios.get(ajaxUrl, {
            headers: { ...HEADERS, 'Accept': 'text/plain' },
            timeout: REQUEST_TIMEOUT_MS, responseType: 'arraybuffer'
        });
        if (!playlistResponse.data || playlistResponse.data.byteLength === 0) { throw new Error("Received empty playlist response buffer"); }

        // 4. Sanitize Base64-like data and Decrypt Playlist
        const rawText = Buffer.from(playlistResponse.data).toString('latin1');
        const base64CharsRegex = /[^A-Za-z0-9+/=]/g;
        const encryptedDataClean = rawText.replace(base64CharsRegex, '');
        if (!encryptedDataClean) { throw new Error("Playlist data was empty after cleaning."); }
        const decryptedPlaylistJson = cryptoOp(encryptedDataClean, "decrypt", "playlist");
        if (!decryptedPlaylistJson) { throw new Error("cryptoOp returned null during playlist decryption."); }

        // 5. Parse Decrypted Playlist and Extract HLS URL
        let playlistData;
        try { playlistData = JSON.parse(decryptedPlaylistJson); }
        catch (e) { throw new Error(`Parsing decrypted playlist JSON failed: ${e.message}`); }
        const hlsUrl = playlistData?.media?.[0]?.url;
        if (!hlsUrl) { throw new Error("No media URL found in playlist data"); }

        // 6. Entitlement Process
        let finalUrl = hlsUrl;
        try {
            const payload = JSON.stringify({ lp: new URL(hlsUrl).pathname, rv: "AKAMAI" });
            const encryptedPayload = cryptoOp(payload, "encrypt", "entitlement");
            if (!encryptedPayload) { throw new Error("Failed to encrypt entitlement payload"); }

            const entitlementResponse = await axios.post(CRYPTO.entitlement.url, encryptedPayload, {
                headers: { ...HEADERS, 'Content-Type': 'text/plain;charset=UTF-8', 'Accept': 'text/plain' },
                timeout: REQUEST_TIMEOUT_MS, responseType: 'text'
            });
            const encryptedTicketData = entitlementResponse.data?.trim();
            if (!encryptedTicketData) { throw new Error("Received empty entitlement response."); }

            const ticketEncryptedClean = encryptedTicketData.replace(base64CharsRegex, '');
            if (!ticketEncryptedClean) { throw new Error("Entitlement data empty after cleaning."); }
            const decryptedTicketJson = cryptoOp(ticketEncryptedClean, "decrypt", "entitlement");
            if (!decryptedTicketJson) { throw new Error("Failed to decrypt entitlement response"); }

            let entitlementData;
            try { entitlementData = JSON.parse(decryptedTicketJson); }
            catch (e) { throw new Error(`Parsing decrypted entitlement JSON failed: ${e.message}`); }

            const ticket = entitlementData?.tickets?.[0]?.ticket;
            if (ticket) {
                const separator = hlsUrl.includes('?') ? '&' : '?';
                finalUrl = `${hlsUrl}${separator}${ticket}`;
                console.log("getVideoUrl: Successfully generated final URL with entitlement ticket.");
            } else {
                console.warn("getVideoUrl: No entitlement ticket found in response data.");
            }
        } catch (entitlementError) {
            console.warn(`Entitlement process failed: ${entitlementError.message}. Returning base HLS URL.`);
            finalUrl = hlsUrl;
        }
        return finalUrl;
    } catch (error) {
        console.error(`getVideoUrl failed for ${episodeUrl}:`, error.message);
        if (error.response) { console.error(`Axios Error Details: Status=${error.response.status}`); }
        return null;
    }
};

// --- Reusable Logic Helpers ---

const getOrUpdateShowMetadata = async (showUrl, metadataCache) => {
    const now = Date.now();
    const isCacheFresh = (now - (metadataCache.timestamp || 0)) < CACHE_TTL_MS;
    const cachedData = metadataCache.metadata?.[showUrl];
    let needsSave = false;
    let details;

    if (cachedData && isCacheFresh && cachedData.name !== 'Error Loading Show') {
        details = { ...cachedData }; // Use cached details
    } else {
        console.log(`Metadata cache miss or stale for: ${showUrl}. Fetching...`);
        details = await extractShowNameAndImages(showUrl);
        if (details.name !== 'Error Loading Show' && details.name !== 'Unknown Show') {
            metadataCache.metadata[showUrl] = { ...details, lastUpdated: now };
            needsSave = true;
            console.log(`Workspaceed and updated metadata cache for: ${showUrl}`);
        } else {
            // Use stale data if fetch failed but stale exists
            details = cachedData || details;
            console.warn(`Failed to fetch fresh metadata for ${showUrl}. Using stale/error data.`);
        }
    }
    // Ensure defaults
    details.name = details.name || 'Loading...';
    details.poster = details.poster || DEFAULT_LOGO;
    details.background = details.background || details.poster;
    details.description = details.description || 'מאקו VOD';

    return { details, needsSave };
};

const getShowEpisodes = async (showUrl, metadataCache) => {
    const now = Date.now();
    const isCacheFresh = (now - (metadataCache.timestamp || 0)) < CACHE_TTL_MS;
    let allEpisodes = [];
    let needsSave = false;
    const processedSeasonUrls = new Set();

    try {
        const seasons = await extractContent(showUrl, 'seasons');

        if (!seasons || seasons.length === 0) {
            // Handle single-season shows - check cache first
            const cacheKey = `season:${showUrl}`; // Use show URL as key for single season
             const cachedSeasonEpisodes = metadataCache.seasons?.[cacheKey];

             if (cachedSeasonEpisodes && isCacheFresh) {
                 console.log(`Using cached single-season episodes for ${showUrl}`);
                 allEpisodes = cachedSeasonEpisodes;
             } else {
                console.log(`No seasons found (or single season) for ${showUrl}, fetching episodes directly.`);
                allEpisodes = await extractContent(showUrl, 'episodes');
                 if (Array.isArray(allEpisodes)) {
                     metadataCache.seasons[cacheKey] = allEpisodes; // Cache single season eps
                     needsSave = true;
                     console.log(`Workspaceed and cached ${allEpisodes.length} single-season episodes for ${showUrl}`);
                 } else {
                      allEpisodes = []; // Ensure array on failure
                 }
             }
             allEpisodes.forEach((ep, i) => { ep.seasonNum = 1; ep.episodeNum = i + 1; });

        } else { // Multi-season show
            console.log(`Found ${seasons.length} seasons for ${showUrl}. Processing...`);
            const seasonProcessingPromises = [];

            for (const [index, season] of seasons.entries()) {
                if (!season.url || processedSeasonUrls.has(season.url)) continue;
                processedSeasonUrls.add(season.url);

                const seasonNumMatch = season.name?.match(/\d+/);
                const seasonNum = seasonNumMatch ? parseInt(seasonNumMatch[0]) : (index + 1);
                const cacheKey = `season:${season.url}`;

                 seasonProcessingPromises.push(
                    (async () => {
                        let episodes = null;
                        const cachedSeasonEpisodes = metadataCache.seasons?.[cacheKey];

                        if (cachedSeasonEpisodes && isCacheFresh) {
                            episodes = cachedSeasonEpisodes;
                        } else {
                            console.log(`Workspaceing episodes for season ${seasonNum}: ${season.name || season.url}`);
                            episodes = await extractContent(season.url, 'episodes');
                            if (Array.isArray(episodes)) {
                                metadataCache.seasons[cacheKey] = episodes; // Update cache
                                needsSave = true;
                                console.log(`Workspaceed and cached ${episodes.length} episodes for season ${seasonNum}`);
                            } else {
                                 episodes = [];
                                 console.warn(`Failed to fetch or got invalid episodes for season ${seasonNum}.`);
                            }
                        }
                         return episodes.map((ep, i) => ({ ...ep, seasonNum: seasonNum, episodeNum: i + 1 }));
                    })()
                );

                // Batch processing
                if (seasonProcessingPromises.length >= 5 || index === seasons.length - 1) {
                    const batchResults = await Promise.all(seasonProcessingPromises);
                    allEpisodes.push(...batchResults.flat());
                    seasonProcessingPromises.length = 0;
                     if(index < seasons.length -1) await sleep(100);
                }
            }
             console.log(`Completed processing ${seasons.length} seasons, total episodes found: ${allEpisodes.length}`);
        }
        allEpisodes.sort((a, b) => (a.seasonNum - b.seasonNum) || (a.episodeNum - b.episodeNum));
    } catch (error) {
        console.error(`Error getting episodes for ${showUrl}:`, error.message);
        return { episodes: [], needsSave: false }; // Return empty on error
    }
    return { episodes: allEpisodes, needsSave };
};


// --- Stremio Addon Builder ---
const builder = new addonBuilder({
    id: 'org.stremio.mako-vod.express',
    version: '1.2.0',
    name: 'Mako VOD (Express)',
    description: 'Watch VOD content from Mako (Israeli TV). Uses Vercel Blob caching.',
    logo: DEFAULT_LOGO,
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

// Define the catalog handler
builder.defineCatalogHandler(async ({ type, id, extra }) => {
    if (type !== 'series' || id !== 'mako-vod-shows') {
        throw new Error('Catalog not found');
    }

    let searchTerm = null;
    if (extra && extra.search) {
        searchTerm = extra.search;
    }

    try {
        // Load both caches
        const mainCache = await loadCache('main');
        const metadataCache = await loadCache('metadata');

        // Fetch initial show list (URLs, initial names/posters)
        const initialShows = await extractContent(`${BASE_URL}/mako-vod-index`, 'shows');
        console.log(`Catalog: Extracted ${initialShows.length} initial show links.`);

        // Apply search filter if present (using initial name)
        let filteredShows = initialShows;
        if (searchTerm) {
            const search = searchTerm.toLowerCase();
            filteredShows = initialShows.filter(show => show.name && show.name.toLowerCase().includes(search));
            console.log(`Catalog: Found ${filteredShows.length} shows matching initial name search: ${search}`);
        }

        const metas = [];
        // Process shows in batches to avoid overwhelming the server
        const BATCH_SIZE = 5;
        for (let i = 0; i < filteredShows.length; i += BATCH_SIZE) {
            const batch = filteredShows.slice(i, i + BATCH_SIZE);
            const batchPromises = batch.map(async (show) => {
                if (!show.url) return null;

                // Try to get metadata from cache first
                let showDetails = metadataCache.metadata?.[show.url];
                
                // If no cached metadata or it's stale, fetch it
                if (!showDetails || Date.now() - (showDetails.lastUpdated || 0) > CACHE_TTL_MS) {
                    console.log(`Catalog: Fetching metadata for ${show.url}`);
                    const { details } = await getOrUpdateShowMetadata(show.url, metadataCache);
                    showDetails = details;
                    metadataCache.metadata[show.url] = { ...details, lastUpdated: Date.now() };
                }

                // If searching, perform secondary filter based on fetched name
                if (searchTerm && showDetails.name && !showDetails.name.toLowerCase().includes(searchTerm.toLowerCase())) {
                    return null;
                }

                return {
                    id: `mako:${encodeURIComponent(show.url)}`,
                    type: 'series',
                    name: showDetails.name || show.name || 'Loading...',
                    poster: showDetails.poster || show.poster || DEFAULT_LOGO,
                    posterShape: 'poster',
                    background: showDetails.background || showDetails.poster || show.poster || DEFAULT_LOGO,
                    logo: DEFAULT_LOGO,
                    description: showDetails.description || 'מאקו VOD',
                };
            });

            const batchResults = await Promise.all(batchPromises);
            metas.push(...batchResults.filter(Boolean));

            // Add a small delay between batches to avoid overwhelming the server
            if (i + BATCH_SIZE < filteredShows.length) {
                await sleep(100);
            }
        }

        // Save updated metadata cache
        await saveCache(metadataCache, 'metadata');

        // Update main cache if needed
        const isMainCacheFresh = Date.now() - (mainCache.timestamp || 0) < CACHE_TTL_MS;
        if (!isMainCacheFresh && initialShows.length > 0) {
            mainCache.shows = {};
            initialShows.forEach(s => { if (s.url) mainCache.shows[s.url] = { name: s.name, poster: s.poster }; });
            await saveCache(mainCache, 'main');
        }

        return { metas };
    } catch (err) {
        console.error('Catalog handler error:', err);
        throw err;
    }
});

// Define the meta handler
builder.defineMetaHandler(async ({ type, id }) => {
    if (type !== 'series' || !id.startsWith('mako:')) {
        throw new Error('Invalid meta ID format');
    }

    let showUrl;
    try {
        showUrl = decodeURIComponent(id.replace('mako:', ''));
        if (!showUrl.startsWith(BASE_URL)) throw new Error('Invalid base URL');
    } catch (e) {
        console.error('Invalid show URL derived from meta ID:', id);
        throw new Error('Invalid show URL in ID');
    }

    try {
        // Load METADATA cache (show details & season episodes)
        const metadataCache = await loadCache('metadata');

        // 1. Get/Update Show Metadata
        const { details: showDetails } = await getOrUpdateShowMetadata(showUrl, metadataCache);

        // 2. Get/Update Episodes (uses/updates metadataCache.seasons)
        const { episodes } = await getShowEpisodes(showUrl, metadataCache);

        // 3. Save metadata cache if modified
        await saveCache(metadataCache, 'metadata');

        // 4. Format Stremio Meta Response
        const videos = episodes.map(ep => ({
            id: `${id}:ep:${ep.guid}`,
            title: ep.name || `Episode ${ep.episodeNum}`,
            season: ep.seasonNum,
            episode: ep.episodeNum,
            released: null, // Mako doesn't easily provide release dates
        }));

        return {
            meta: {
                id,
                type: 'series',
                name: showDetails.name,
                poster: showDetails.poster,
                posterShape: 'poster',
                background: showDetails.background,
                logo: DEFAULT_LOGO,
                description: showDetails.description,
                videos
            }
        };
    } catch (err) {
        console.error('Meta handler error:', err);
        throw err;
    }
});

// --- Express App Setup ---
const app = express();
app.use(cors());

// Basic logging middleware
app.use((req, res, next) => {
    console.log(`Request: ${req.method} ${req.url}`);
    next();
});

// Manifest endpoint
app.get('/manifest.json', (req, res) => {
    try {
        const manifest = builder.getInterface();
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=3600');
        res.send(manifest);
    } catch (err) {
        console.error("Error generating manifest:", err);
        res.status(500).json({ error: 'Failed to generate manifest' });
    }
});

// Redirect root to manifest
app.get('/', (req, res) => res.redirect('/manifest.json'));

// Catalog endpoint - Using Express Route
app.get('/catalog/:type/:id/:extra?.json', async (req, res) => {
    try {
        const { type, id } = req.params;
        let extra = {};
        if (req.params.extra && req.params.extra.includes('search=')) {
            try { extra.search = decodeURIComponent(req.params.extra.split('search=')[1].split('/')[0]); }
            catch (e) { console.warn("Failed to parse search extra:", req.params.extra); }
        }

        const result = await builder.getInterface().catalogs.find(cat => 
            cat.type === type && cat.id === id
        )?.handler({ type, id, extra });

        if (!result) {
            return res.status(404).json({ metas: [], error: 'Catalog not found.' });
        }

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'public, s-maxage=900, stale-while-revalidate=300');
        res.status(200).json(result);
    } catch (err) {
        console.error('Catalog endpoint error:', err);
        res.status(500).json({ metas: [], error: 'Failed to process catalog request' });
    }
});

// Meta endpoint - Using Express Route
app.get('/meta/:type/:id.json', async (req, res) => {
    try {
        const { type, id } = req.params;
        const result = await builder.getInterface().meta.find(m => 
            m.type === type
        )?.handler({ type, id });

        if (!result) {
            return res.status(404).json({ meta: null, error: 'Meta not found.' });
        }

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=1800');
        res.status(200).json(result);
    } catch (err) {
        console.error('Meta endpoint error:', err);
        res.status(500).json({ meta: null, error: 'Failed to process meta request' });
    }
});

// Stream endpoint - Using Express Route
app.get('/stream/:type/:id.json', async (req, res) => {
    const { type, id } = req.params;
    // console.log('Processing stream request via Express:', { type, id }); // Reduce noise

    if (type !== 'series' || !id.startsWith('mako:')) {
        return res.status(404).json({ streams: [], error: 'Invalid stream ID format' });
    }

    const parts = id.split(':ep:');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
         return res.status(400).json({ streams: [], error: 'Invalid stream ID format (missing GUID)' });
    }

    const showIdRaw = parts[0];
    const episodeGuid = parts[1];
    let showUrl;
    try {
        showUrl = decodeURIComponent(showIdRaw.replace('mako:', ''));
        if (!showUrl.startsWith(BASE_URL)) throw new Error('Invalid base URL');
    } catch (e) {
        console.error('Invalid show URL derived from stream ID:', showIdRaw);
        return res.status(400).json({ streams: [], error: 'Invalid show URL in ID' });
    }

    console.log(`Stream handler: Looking for GUID ${episodeGuid} within show ${showUrl}`);
    let metadataCacheNeedsSave = false; // Track potential cache updates

    try {
        // Load metadata cache (contains season episode lists)
        const metadataCache = await loadCache('metadata');

        // 1. Get episodes (potentially updating cache)
        const { episodes, needsSave } = await getShowEpisodes(showUrl, metadataCache);
        if (needsSave) metadataCacheNeedsSave = true;

        // 2. Find the specific episode by GUID
        const targetEpisode = episodes.find(ep => ep.guid === episodeGuid);

        if (!targetEpisode || !targetEpisode.url) {
            console.error(`Stream handler: Could not find episode URL for GUID ${episodeGuid} in show ${showUrl}`);
             // Save cache if needed, even if episode not found
             if (metadataCacheNeedsSave) {
                 console.log("Stream: Saving updated metadata cache (episode not found)...");
                 await saveCache(metadataCache, 'metadata');
             }
            return res.status(404).json({ streams: [], error: 'Episode GUID not found.' });
        }
         console.log(`Stream handler: Found episode URL: ${targetEpisode.url}`);

        // 3. Get the final video URL (decryption/entitlement)
        const videoUrl = await getVideoUrl(targetEpisode.url);

        // 4. Save cache if necessary (do this *before* checking videoUrl failure)
         if (metadataCacheNeedsSave) {
             console.log("Stream: Saving updated metadata cache...");
             await saveCache(metadataCache, 'metadata');
         }

        // 5. Check if video URL retrieval failed
        if (!videoUrl) {
            console.error(`Stream handler: getVideoUrl failed for ${targetEpisode.url}`);
            return res.status(500).json({ streams: [], error: 'Failed to retrieve video stream URL' });
        }

        // 6. Format Stremio Stream Response
        const streams = [{
            url: videoUrl,
            title: 'Play (HLS)',
            type: 'hls',
             behaviorHints: {
                 bingeGroup: `mako-${showUrl}`,
                 // Add proxy headers if needed via Vercel config or another layer
                 // headers: { "User-Agent": "Stremio" } // Example
             }
        }];

        console.log(`Stream: Responding with stream for GUID ${episodeGuid}`);
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store, max-age=0'); // Do not cache stream URLs
        res.status(200).json({ streams });

    } catch (err) {
        console.error(`Stream handler error for ID ${id} (GUID: ${episodeGuid}):`, err);
        res.status(500).json({ streams: [], error: 'Failed to process stream request' });
    }
});


// --- Final Middleware and Export ---

// Handle other requests (404) - Should be last .use()
app.use((req, res) => {
    console.warn('Unknown request (404):', req.method, req.url);
    res.status(404).json({ error: 'Not Found' });
});

// Export the app for Vercel
module.exports = app;

// --- Local Development Server (only if not in production) ---
if (!IS_PRODUCTION) {
    const PORT = process.env.PORT || 8000;
    app.listen(PORT, () => {
        console.log(`\n--- LOCAL DEVELOPMENT SERVER ---`);
        console.log(`Mako VOD Stremio Add-on running at:`);
        console.log(`Manifest: http://127.0.0.1:${PORT}/manifest.json`);
        console.log(`Install Link: stremio://127.0.0.1:${PORT}/manifest.json`);
        console.log(`---------------------------------\n`);
    });
}