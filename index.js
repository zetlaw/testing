// index.js
const { addonBuilder } = require('stremio-addon-sdk'); // Removed serveHTTP as we use Express
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');

// Use the external crypto.js module that uses AES-192
const { CRYPTO, cryptoOp } = require('./crypto');

// ** Log NODE_ENV on startup **
console.log(`Current NODE_ENV: ${process.env.NODE_ENV}`);
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// Import Vercel Blob for serverless storage conditionally
let blob = null;
if (IS_PRODUCTION) {
    try {
        const vercelBlob = require('@vercel/blob');
        blob = {
            put: vercelBlob.put,
            list: vercelBlob.list,
            del: vercelBlob.del
        };
        console.log("Successfully required @vercel/blob package.");
    } catch (e) {
        console.error('Failed to load @vercel/blob, persistent cache will be disabled:', e.message);
        blob = null; // Ensure blob is null if require fails
    }
} else {
    console.log("Not in production, Vercel Blob will not be used. Using local file cache.");
    blob = null;
}

// --- Constants ---
const BASE_URL = "https://www.mako.co.il";
const LOCAL_CACHE_DIR = path.join(__dirname, '.cache'); // Cache directory for local dev
const LOCAL_CACHE_FILE = path.join(LOCAL_CACHE_DIR, "mako_shows_cache.json"); // Local cache file path
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days in MILLISECONDS
const DELAY_BETWEEN_REQUESTS_MS = 500; // 0.5 second delay between Mako requests
const REQUEST_TIMEOUT_MS = 10000; // 10 seconds for standard axios requests
const EPISODE_FETCH_TIMEOUT_MS = 20000; // 20 seconds for potentially longer episode list fetches
const BLOB_CACHE_KEY_PREFIX = 'mako-shows-cache-v1'; // Prefix for blob files
const MAX_CATALOG_INITIAL_LOAD = 50; // Max items to process synchronously for catalog response
const MAX_BLOB_FILES_TO_KEEP = 2; // Keep the 2 most recent cache blobs

// Request Headers
const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,he;q=0.8',
    'Referer': `${BASE_URL}/mako-vod-index`,
    'Connection': 'keep-alive'
};

// --- In-memory Cache ---
let memoryCache = null;
let memoryCacheTimestamp = 0;

// --- Helper Functions ---
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const processImageUrl = (url) => {
    if (!url || typeof url !== 'string') return null;
    // Basic cleaning and validation
    url = url.trim();
    if (url.startsWith('//_next/')) return null; // Common placeholder/error pattern
    if (url.startsWith('http')) return url;
    if (url.startsWith('//')) return `https:${url}`;
    if (url.startsWith('/')) return `${BASE_URL}${url}`;
    // If it's not clearly absolute or relative, treat as potentially invalid
    // console.warn(`Potentially invalid image URL format: ${url}`); // Optional warning
    return null; // Return null for unclear cases
};

// Default image if processing fails or returns null
const DEFAULT_LOGO = 'https://www.mako.co.il/assets/images/svg/mako_logo.svg';
const getValidImage = (url) => processImageUrl(url) || DEFAULT_LOGO;


// --- Cache Management (Revised for Blob Prefix Logic) ---

// Ensures cache object has the necessary structure
const ensureCacheStructure = (cacheData) => {
    if (typeof cacheData !== 'object' || cacheData === null) {
        return { timestamp: 0, shows: {}, seasons: {} };
    }
    cacheData.shows = cacheData.shows || {};
    cacheData.seasons = cacheData.seasons || {};
    cacheData.timestamp = cacheData.timestamp || 0;
    return cacheData;
};

const loadCache = async () => {
    const now = Date.now();
    // Return recent memory cache immediately (cache memory for 1 min)
    if (memoryCache && (now - memoryCacheTimestamp < 60 * 1000)) {
        // console.log("Returning recent memory cache.");
        return memoryCache;
    }

    let loadedData = null;
    const emptyCache = ensureCacheStructure(null); // Predefined empty structure

    if (blob) { // Production with Vercel Blob
        try {
            console.log(`Attempting to load cache blob with prefix: ${BLOB_CACHE_KEY_PREFIX}`);
            let mostRecent = null;

            try {
                const { blobs } = await blob.list({ prefix: BLOB_CACHE_KEY_PREFIX });
                if (blobs && blobs.length > 0) {
                    // Sort by uploadedAt (more reliable than lastModified for creation time)
                    mostRecent = blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))[0];
                    console.log(`Found most recent cache blob: ${mostRecent.pathname}, Size: ${mostRecent.size}, URL: ${mostRecent.url}, Uploaded: ${mostRecent.uploadedAt}`);

                    if (mostRecent.size > 0) {
                        const response = await axios.get(mostRecent.url, { timeout: REQUEST_TIMEOUT_MS + 5000 }); // Slightly longer timeout for cache fetch
                        if (typeof response.data === 'object' && response.data !== null) {
                            loadedData = response.data;
                            console.log(`Successfully loaded cache from Blob: ${mostRecent.pathname}`);
                        } else {
                            console.warn(`Workspaceed cache blob ${mostRecent.pathname} but content was invalid type: ${typeof response.data}`);
                        }
                    } else {
                        console.warn(`Found most recent cache blob ${mostRecent.pathname} but it has size 0. Ignoring.`);
                    }
                } else {
                    console.log(`No cache blobs found with prefix: ${BLOB_CACHE_KEY_PREFIX}`);
                }
            } catch (listOrGetError) {
                if (listOrGetError.response) {
                    console.error(`Error fetching cache blob ${mostRecent?.url || 'N/A'}: Status ${listOrGetError.response.status}`, listOrGetError.message);
                } else {
                    console.error("Error listing or fetching cache blob:", listOrGetError.message);
                }
            }

            // If loading failed or no valid blob found, initialize
            if (!loadedData) {
                console.log("Initializing new empty cache (Blob).");
                loadedData = emptyCache;
                // Try to save this initial empty cache (best effort)
                try {
                     // Use a unique name even for the empty cache init
                    const initialPath = `${BLOB_CACHE_KEY_PREFIX}-${Date.now()}.json`;
                    await blob.put(initialPath, JSON.stringify(loadedData), {
                        access: 'public', contentType: 'application/json'
                    });
                    console.log(`Initialized and saved new empty cache to Blob: ${initialPath}`);
                } catch (saveError) {
                    console.error("Failed to save initial empty cache to Blob:", saveError.message);
                }
            }
        } catch (e) {
            console.error("Outer error during Blob cache loading:", e.message);
            loadedData = emptyCache; // Fallback
        }
    } else { // Local Development
        try {
            if (fs.existsSync(LOCAL_CACHE_FILE)) {
                const fileData = fs.readFileSync(LOCAL_CACHE_FILE, 'utf8');
                loadedData = JSON.parse(fileData);
                console.log(`Loaded cache from local file: ${LOCAL_CACHE_FILE}`);
            } else {
                 console.log("Local cache file not found. Initializing empty cache.");
                loadedData = emptyCache;
            }
        } catch (e) {
            console.error("Error loading cache from local file:", e.message);
            loadedData = emptyCache; // Fallback
        }
    }

    // Ensure structure and update memory cache
    memoryCache = ensureCacheStructure(loadedData);
    memoryCacheTimestamp = now; // Timestamp of when it was loaded into memory
    // console.log(`Cache loaded. Timestamp: ${memoryCache.timestamp}, Shows: ${Object.keys(memoryCache.shows).length}, Seasons: ${Object.keys(memoryCache.seasons).length}`);
    return memoryCache;
};

const saveCache = async (cache) => {
    if (!cache || typeof cache !== 'object') {
        console.error("Attempted to save invalid cache object.");
        return;
    }

    // Ensure structure and update timestamp before saving
    const cacheToSave = ensureCacheStructure({ ...cache }); // Work on a copy
    cacheToSave.timestamp = Date.now();

    // Update memory cache immediately
    memoryCache = cacheToSave;
    memoryCacheTimestamp = cacheToSave.timestamp; // Use the save timestamp

    const showCount = Object.keys(cacheToSave.shows).length;
    const seasonCount = Object.keys(cacheToSave.seasons).length;

    if (blob) { // Production with Vercel Blob
        try {
             // Generate a unique pathname for this save operation
             const uniquePathname = `${BLOB_CACHE_KEY_PREFIX}-${Date.now()}-${Math.random().toString(36).substring(2, 10)}.json`;
            console.log(`Attempting to save cache (${showCount} shows, ${seasonCount} seasons) to Blob: ${uniquePathname}`);

            await blob.put(uniquePathname, JSON.stringify(cacheToSave), {
                access: 'public',
                contentType: 'application/json'
            });
            console.log(`Cache saved successfully to Blob: ${uniquePathname}`);

            // Clean up old cache files (best effort)
            try {
                const { blobs } = await blob.list({ prefix: BLOB_CACHE_KEY_PREFIX });
                if (blobs && blobs.length > MAX_BLOB_FILES_TO_KEEP) {
                    const sortedBlobs = blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
                    const blobsToDelete = sortedBlobs.slice(MAX_BLOB_FILES_TO_KEEP);
                    console.log(`Found ${blobs.length} blobs, deleting ${blobsToDelete.length} older ones.`);
                    await Promise.all(blobsToDelete.map(oldBlob =>
                        blob.del(oldBlob.url) // Use blob.del with the full URL
                           .then(() => console.log(`Deleted old cache file: ${oldBlob.pathname}`))
                           .catch(delError => console.error(`Failed to delete old cache file ${oldBlob.pathname}:`, delError.message))
                    ));
                }
            } catch (cleanupError) {
                console.error("Failed during cache cleanup:", cleanupError.message);
            }
        } catch (e) {
            console.error("Error saving cache to Blob storage:", e.message);
        }
    } else { // Local Development
        try {
            if (!fs.existsSync(LOCAL_CACHE_DIR)) {
                fs.mkdirSync(LOCAL_CACHE_DIR, { recursive: true });
            }
            fs.writeFileSync(LOCAL_CACHE_FILE, JSON.stringify(cacheToSave, null, 2), 'utf8');
            console.log(`Cache saved locally (${showCount} shows, ${seasonCount} seasons) to ${LOCAL_CACHE_FILE}`);
        } catch (e) {
            console.error("Error saving cache to local file:", e.message);
        }
    }
};


// --- Data Extraction Functions ---

/**
 * Extracts basic show details (name, poster, background) from a show's page URL.
 * Uses JSON-LD first, then falls back to meta tags/H1.
 */
const extractShowNameAndImages = async (url) => {
    console.log(`Extracting show details from ${url}`);
    try {
        const response = await axios.get(url, { headers: HEADERS, timeout: REQUEST_TIMEOUT_MS });
        const $ = cheerio.load(response.data);

        let name = null;
        let poster = null;
        let background = null;

        // 1. Try JSON-LD
        try {
            const jsonldTag = $('script[type="application/ld+json"]').html();
            if (jsonldTag) {
                const data = JSON.parse(jsonldTag);
                if (data['@type'] === 'TVSeason' && data.partOfTVSeries?.name) {
                    name = data.partOfTVSeries.name;
                } else {
                    name = data.name; // For TVSeries or other types
                }
                // Attempt to add season count if available and sensible
                if (data.containsSeason && Array.isArray(data.containsSeason) && data.containsSeason.length > 1) {
                     name = `${name} (${data.containsSeason.length} עונות)`;
                }
                 if(name) name = name.replace(/\s+/g, ' ').trim();
            }
        } catch (jsonErr) {
            console.warn(`Warn parsing JSON-LD for ${url}: ${jsonErr.message.substring(0, 100)}...`);
            name = null; // Reset name if JSON-LD parsing failed
        }

        // 2. Try Meta Tags / H1 (Fallback for name)
        if (!name) {
            const ogTitle = $('meta[property="og:title"]').attr('content');
            const h1Title = $('h1').first().text();
            name = ogTitle || h1Title;
            if (name) {
                 name = name.replace(/\s+/g, ' ').trim();
                console.log(`Using fallback name: ${name} for ${url}`);
            } else {
                 console.log(`No name found via JSON-LD, meta, or H1 for ${url}`);
            }
        }

        // 3. Extract Images (using helper for validation)
        poster = getValidImage(
            $('meta[property="og:image"]').attr('content') ||
            $('meta[name="twitter:image"]').attr('content') ||
            $('link[rel="image_src"]').attr('href') ||
            $('.vod_item img').first().attr('src') || // Common VOD item structures
            $('.vod_item_wrap img').first().attr('src')
        );

        // Try finding a potentially larger background image (often same as poster)
        background = getValidImage($('meta[property="og:image:width"][content="1920"]').parent().attr('content')) || poster;

        return {
            name: name || 'Unknown Show', // Ensure name is never null/undefined
            poster: poster, // Already has default via getValidImage
            background: background // Already has default via getValidImage
        };

    } catch (e) {
        console.error(`Error extracting show details from ${url}:`, e.message);
        return { // Return default structure on error
            name: 'Error Loading Show',
            poster: DEFAULT_LOGO,
            background: DEFAULT_LOGO
        };
    }
};


/**
 * Extracts content (shows, seasons, episodes) based on CSS selectors.
 */
const extractContent = async (url, contentType) => {
    // console.log(`Extracting ${contentType} from ${url}`);
    try {
        await sleep(DELAY_BETWEEN_REQUESTS_MS);
        const response = await axios.get(url, {
            headers: HEADERS,
            timeout: contentType === 'episodes' ? EPISODE_FETCH_TIMEOUT_MS : REQUEST_TIMEOUT_MS // Longer timeout for episode pages
        });
        const $ = cheerio.load(response.data);

        const configs = {
            shows: {
                selectors: [ // Order matters: more specific first
                    '.vod_item_wrap article a[href^="/mako-vod-"]',
                    '.vod_item article a[href^="/mako-vod-"]',
                    'li.grid-item a[href^="/mako-vod-"]',
                    'section[class*="vod"] a[href^="/mako-vod-"]',
                    'a[href^="/mako-vod-"]:not([href*="purchase"]):not([href*="index"])',
                ],
                fields: {
                    url: { attribute: 'href' },
                    name: [ // Try multiple selectors for name
                        { selector: '.title strong' }, { selector: 'h3.title' }, { selector: 'h2.title' },
                        { selector: '.vod-title' }, { selector: '.caption' },
                        { selector: 'img', attribute: 'alt' }, // Alt text fallback
                        { text: true } // Link text last resort
                    ],
                    poster: { selector: 'img', attribute: 'src' }
                },
                base: BASE_URL,
                filter: (item) => item.url && item.name && item.name !== 'Unknown Show' &&
                                !item.url.includes('/purchase') && !item.url.includes('/index') &&
                                !item.name.toLowerCase().includes('live') && !item.name.toLowerCase().includes('יחצ') &&
                                !item.name.toLowerCase().includes('מאקו') && !item.name.includes('Error Loading')
            },
            seasons: {
                selectors: ['div#seasonDropdown ul ul li a', '.seasons_nav a'], // Added alternative selector
                fields: { name: { selector: 'span', text: true }, url: { attribute: 'href' } }, // Ensure text:true for name span
                base: url, // Relative URLs on season page are relative to that page
                filter: (item) => item.url && item.name && !item.name.toLowerCase().includes('כל הפרקים') // Exclude 'All Episodes' link if present
            },
            episodes: {
                selectors: [ // Order matters
                    'li.vod_item a[href*="videoGuid="]', // Prioritize items with explicit GUID link
                    '.vod_item a[href*="videoGuid="]',
                    '.vod_item_wrap a[href*="videoGuid="]',
                    'li.card a[href*="videoGuid="]',
                    'a[href*="videoGuid="]', // General GUID link as fallback
                    // Fallback selectors if GUID isn't directly in href (less ideal)
                     'li.vod_item a', '.vod_item a', '.vod_item_wrap a', 'li.card a'
                ],
                fields: {
                    name: [ // Try multiple selectors
                         { selector: '.title strong' }, { selector: '.vod-title' }, { selector: '.caption' },
                         { text: true } // Fallback to link text
                    ],
                    url: { attribute: 'href' },
                    // GUID extraction logic moved to post-processing loop
                },
                base: url, // Relative URLs on episode page
                filter: (item) => item.url // Require at least a URL initially
            }
        };

        const config = configs[contentType];
        const items = [];
        const seenUrlsOrGuids = new Set();

        let elements = [];
        for (const selector of config.selectors) {
            try {
                elements = $(selector).toArray();
                if (elements.length > 0) {
                    // console.log(`Found ${elements.length} potential ${contentType} elements with selector: ${selector} on ${url}`);
                    break; // Use the first selector that finds elements
                }
            } catch (selectorError) {
                console.warn(`Selector "${selector}" failed on ${url}: ${selectorError.message}`);
            }
        }
        if (elements.length === 0) console.warn(`No elements found for ${contentType} at ${url} using configured selectors.`);

        for (const elem of elements) {
            const item = {};
            for (const [field, fieldConfig] of Object.entries(config.fields)) {
                let valueFound = false;
                // Handle array of selectors (like 'name')
                if (Array.isArray(fieldConfig)) {
                    for (const subConf of fieldConfig) {
                         try {
                            const target = subConf.selector ? $(elem).find(subConf.selector) : $(elem);
                            if (target.length > 0) {
                                let value = subConf.attribute ? target.first().attr(subConf.attribute) : target.first().text();
                                if (value) {
                                    item[field] = value.replace(/\s+/g, ' ').trim();
                                    valueFound = true;
                                    break; // Use first successful name selector
                                }
                            }
                         } catch (nameSelectorError) { continue; }
                    }
                } else { // Handle single selector config
                    try {
                        const target = fieldConfig.selector ? $(elem).find(fieldConfig.selector) : $(elem);
                        if (target.length > 0) {
                            let value = fieldConfig.attribute ? target.first().attr(fieldConfig.attribute) : target.first().text();
                             if (value !== undefined && value !== null) {
                                 value = String(value).replace(/\s+/g, ' ').trim(); // Ensure string and trim
                                 // Clean URL
                                 if (field === 'url' && value) {
                                     try {
                                         value = new URL(value, config.base).href.split('?')[0].split('#')[0];
                                     } catch (urlError) { value = null; } // Invalid URL
                                 }
                                 if(value) item[field] = value; // Add field only if value is valid
                            }
                        }
                    } catch (fieldError) { continue; }
                }
            }

            // Post-processing and Filtering specific to type
             if (contentType === 'episodes') {
                 // Extract GUID from URL (more reliable than initial selectors)
                 if (item.url) {
                     const guidMatch = item.url.match(/[?&](guid|videoGuid)=([\w-]+)/i) || item.url.match(/\/VOD-([\w-]+)\.htm/);
                     if (guidMatch && guidMatch[1]) item.guid = guidMatch[1]; // Use the captured group
                     else if (guidMatch && guidMatch[2]) item.guid = guidMatch[2]; // For query param match
                 }
                 // Require GUID for episodes
                 if (!item.guid) continue; // Skip if no GUID found
                 if (!item.name) item.name = `Episode (GUID: ${item.guid})`; // Default name if missing
             }

            // Final filter and uniqueness check
            const uniqueKey = item.guid || item.url;
            if (config.filter(item) && uniqueKey && !seenUrlsOrGuids.has(uniqueKey)) {
                // Apply defaults for shows
                if (contentType === 'shows') {
                    item.poster = getValidImage(item.poster);
                    item.background = item.poster; // Default background to poster
                }
                 if (contentType === 'seasons' && !item.name) {
                     // Try to derive season name from URL if needed (e.g., /season-2/)
                     const seasonMatch = item.url.match(/season-(\d+)/i);
                     if(seasonMatch) item.name = `Season ${seasonMatch[1]}`;
                 }

                items.push(item);
                seenUrlsOrGuids.add(uniqueKey);
            }
        }

        console.log(`Extracted ${items.length} valid ${contentType} items for ${url}`);
        return items;

    } catch (e) {
        console.error(`Error in extractContent (${contentType}, ${url}):`, e.message);
        return []; // Return empty array on error
    }
};


/**
 * Retrieves the final playable HLS URL for a given episode page URL.
 * Handles Mako's encryption and entitlement process.
 */
const getVideoUrl = async (episodeUrl) => {
    console.log(`getVideoUrl: Starting process for episode URL: ${episodeUrl}`);
    try {
        // 1. Fetch Episode Page HTML to get __NEXT_DATA__
        const episodePageResponse = await axios.get(episodeUrl, { headers: HEADERS, timeout: REQUEST_TIMEOUT_MS });
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
            headers: { ...HEADERS, 'Accept': 'text/plain' }, // Important: Accept plain text
            timeout: REQUEST_TIMEOUT_MS,
            responseType: 'arraybuffer' // Get raw bytes
        });
        if (!playlistResponse.data || playlistResponse.data.byteLength === 0) {
            throw new Error("Received empty playlist response buffer");
        }

        // 4. Sanitize Base64-like data and Decrypt Playlist
        const rawText = Buffer.from(playlistResponse.data).toString('latin1'); // Use latin1 encoding
        const base64CharsRegex = /[^A-Za-z0-9+/=]/g;
        const encryptedDataClean = rawText.replace(base64CharsRegex, '');
        if (!encryptedDataClean) { throw new Error("Playlist data was empty after cleaning."); }

        const decryptedPlaylistJson = cryptoOp(encryptedDataClean, "decrypt", "playlist");
        if (!decryptedPlaylistJson) { throw new Error("cryptoOp returned null during playlist decryption."); }

        // 5. Parse Decrypted Playlist and Extract HLS URL
        let playlistData;
        try {
            playlistData = JSON.parse(decryptedPlaylistJson);
        } catch (e) { throw new Error(`Parsing decrypted playlist JSON failed: ${e.message}`); }

        const hlsUrl = playlistData?.media?.[0]?.url;
        if (!hlsUrl) { throw new Error("No media URL found in playlist data"); }

        // --- Entitlement Process ---
        let finalUrl = hlsUrl; // Default to basic HLS URL
        try {
            // 6. Prepare and Encrypt Entitlement Payload
            const payload = JSON.stringify({ lp: new URL(hlsUrl).pathname, rv: "AKAMAI" });
            const encryptedPayload = cryptoOp(payload, "encrypt", "entitlement");
            if (!encryptedPayload) { throw new Error("Failed to encrypt entitlement payload"); }

            // 7. Fetch Entitlement Ticket
            const entitlementResponse = await axios.post(CRYPTO.entitlement.url, encryptedPayload, {
                headers: { ...HEADERS, 'Content-Type': 'text/plain;charset=UTF-8', 'Accept': 'text/plain' },
                timeout: REQUEST_TIMEOUT_MS,
                responseType: 'text' // Expecting text response
            });
            const encryptedTicketData = entitlementResponse.data?.trim();
            if (!encryptedTicketData) { throw new Error("Received empty entitlement response."); }

            // 8. Clean and Decrypt Entitlement Response
            const ticketEncryptedClean = encryptedTicketData.replace(base64CharsRegex, '');
            if (!ticketEncryptedClean) { throw new Error("Entitlement data empty after cleaning."); }

            const decryptedTicketJson = cryptoOp(ticketEncryptedClean, "decrypt", "entitlement");
            if (!decryptedTicketJson) { throw new Error("Failed to decrypt entitlement response"); }

            // 9. Parse Entitlement Data and Append Ticket
            let entitlementData;
            try {
                entitlementData = JSON.parse(decryptedTicketJson);
            } catch (e) { throw new Error(`Parsing decrypted entitlement JSON failed: ${e.message}`); }

            const ticket = entitlementData?.tickets?.[0]?.ticket;
            if (ticket) {
                const separator = hlsUrl.includes('?') ? '&' : '?';
                finalUrl = `${hlsUrl}${separator}${ticket}`;
                console.log("getVideoUrl: Successfully generated final URL with entitlement ticket.");
            } else {
                console.warn("getVideoUrl: No entitlement ticket found in response data.");
            }
        } catch (entitlementError) {
            // If any part of entitlement fails, log warning and return the base HLS URL
            console.warn(`Entitlement process failed: ${entitlementError.message}. Returning base HLS URL.`);
            finalUrl = hlsUrl;
        }

        return finalUrl;

    } catch (error) {
        console.error(`getVideoUrl failed for ${episodeUrl}:`, error.message);
        // Log Axios specific errors if available
        if (error.response) { console.error(`Axios Error Details: Status=${error.response.status}, Data=${JSON.stringify(error.response.data)?.substring(0, 200)}...`); }
        else if (error.request) { console.error('Axios Error: No response received.'); }
        return null; // Return null on failure
    }
};


// --- Stremio Addon Definition ---
const builder = new addonBuilder({
    id: 'org.stremio.mako-vod.refactored',
    version: '1.1.0', // Increment version
    name: 'Mako VOD (Refactored)',
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

// --- Reusable Logic Helpers for Handlers ---

/**
 * Gets show details, using cache if fresh, otherwise fetches and updates cache.
 * Returns { details: { name, poster, background }, needsSave: boolean }
 */
const getOrUpdateShowDetails = async (showUrl, cache) => {
    const now = Date.now();
    const isCacheFresh = (now - (cache.timestamp || 0)) < CACHE_TTL_MS;
    const cachedData = cache.shows?.[showUrl];
    let needsSave = false;
    let details;

    if (cachedData && isCacheFresh && cachedData.name !== 'Error Loading Show' && cachedData.name !== 'Unknown Show') {
         // Use fresh cached data
        details = { name: cachedData.name, poster: cachedData.poster, background: cachedData.background };
        // console.log(`Using fresh cache for show details: ${showUrl}`);
    } else {
        console.log(`Cache miss or stale for show details: ${showUrl}. Fetching...`);
        details = await extractShowNameAndImages(showUrl);
        // Update cache only if fetch was successful
        if (details.name !== 'Error Loading Show' && details.name !== 'Unknown Show') {
            if (!cache.shows) cache.shows = {}; // Ensure structure
            cache.shows[showUrl] = { ...details, lastUpdated: now };
            needsSave = true;
            console.log(`Workspaceed and updated cache for show details: ${showUrl}`);
        } else {
            // If fetch failed, try to use stale cache data if available, otherwise use error state
            details = cachedData ? { name: cachedData.name, poster: cachedData.poster, background: cachedData.background } : details;
             console.warn(`Failed to fetch fresh details for ${showUrl}. Using stale/error data.`);
        }
    }
    // Ensure defaults even if using stale cache
    details.name = details.name || 'Loading...';
    details.poster = details.poster || DEFAULT_LOGO;
    details.background = details.background || details.poster;

    return { details, needsSave };
};

/**
 * Gets all episodes for a show, handling seasons and caching.
 * Returns { episodes: [], needsSave: boolean }
 */
 const getShowEpisodes = async (showUrl, cache) => {
    const now = Date.now();
    const isCacheFresh = (now - (cache.timestamp || 0)) < CACHE_TTL_MS;
    let allEpisodes = [];
    let needsSave = false;
    const processedSeasonUrls = new Set(); // Prevent processing the same season URL multiple times if duplicated

    try {
        const seasons = await extractContent(showUrl, 'seasons');

        if (!seasons || seasons.length === 0) {
            // No seasons found, fetch episodes directly from the show URL
            console.log(`No seasons found for ${showUrl}, fetching episodes directly.`);
            allEpisodes = await extractContent(showUrl, 'episodes');
            // Assign default season/episode numbers
            allEpisodes.forEach((ep, i) => { ep.seasonNum = 1; ep.episodeNum = i + 1; });
            // Cache these episodes under a generic key for the show URL? Maybe less useful than season caching.
            // Let's skip caching single-season shows for now to keep it simple.

        } else {
            console.log(`Found ${seasons.length} seasons for ${showUrl}. Processing...`);
            if (!cache.seasons) cache.seasons = {}; // Ensure cache structure

            const seasonProcessingPromises = [];
            for (const [index, season] of seasons.entries()) {
                // Skip if season URL is missing or already processed
                if (!season.url || processedSeasonUrls.has(season.url)) continue;
                processedSeasonUrls.add(season.url);

                const seasonNumMatch = season.name?.match(/\d+/);
                const seasonNum = seasonNumMatch ? parseInt(seasonNumMatch[0]) : (index + 1); // Fallback to index + 1
                const cacheKey = `season:${season.url}`; // Cache key based on season URL

                // Add promise to process this season
                 seasonProcessingPromises.push(
                    (async () => {
                        let episodes = null;
                        const cachedSeasonEpisodes = cache.seasons[cacheKey];

                        if (cachedSeasonEpisodes && isCacheFresh) {
                            // console.log(`Using cached episodes for season ${seasonNum} (${season.url})`);
                            episodes = cachedSeasonEpisodes;
                        } else {
                            console.log(`Workspaceing episodes for season ${seasonNum}: ${season.name || season.url}`);
                            episodes = await extractContent(season.url, 'episodes');
                            // Cache the fetched episodes only if fetch was successful (returned array)
                            if (Array.isArray(episodes)) {
                                cache.seasons[cacheKey] = episodes;
                                needsSave = true; // Mark cache as needing save
                                console.log(`Workspaceed and cached ${episodes.length} episodes for season ${seasonNum}`);
                            } else {
                                 console.warn(`Failed to fetch or got invalid episodes for season ${seasonNum}. Not caching.`);
                                 episodes = []; // Ensure it's an array even on failure
                            }
                        }

                        // Assign season/episode numbers and return
                         return episodes.map((ep, i) => ({
                            ...ep,
                            seasonNum: seasonNum,
                            episodeNum: i + 1
                         }));
                    })()
                );

                // Batch processing to avoid overwhelming the target server or hitting Vercel limits
                // Process in batches of e.g., 5
                if (seasonProcessingPromises.length >= 5 || index === seasons.length - 1) {
                    const batchResults = await Promise.all(seasonProcessingPromises);
                    allEpisodes.push(...batchResults.flat());
                    seasonProcessingPromises.length = 0; // Clear the promises array for the next batch
                     if(index < seasons.length -1) await sleep(100); // Small delay between batches
                }
            }
             console.log(`Completed processing ${seasons.length} seasons, total episodes found: ${allEpisodes.length}`);
        }

        // Sort final list
        allEpisodes.sort((a, b) => (a.seasonNum - b.seasonNum) || (a.episodeNum - b.episodeNum));

    } catch (error) {
        console.error(`Error getting episodes for ${showUrl}:`, error.message);
        // Return empty list but don't mark for save on error
        return { episodes: [], needsSave: false };
    }

    return { episodes: allEpisodes, needsSave };
};


// --- Express App Setup ---
const app = express();
app.use(cors()); // Enable CORS for all origins

// Basic logging middleware
app.use((req, res, next) => {
    console.log(`Request: ${req.method} ${req.url}`);
    next();
});

// --- Express Route Handlers ---

// Manifest endpoint
app.get('/manifest.json', (req, res) => {
    try {
        const manifest = builder.getInterface();
        res.setHeader('Content-Type', 'application/json');
        // Cache manifest for a day
        res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=3600');
        res.send(manifest);
    } catch (err) {
        console.error("Error generating manifest:", err);
        res.status(500).json({ error: 'Failed to generate manifest' });
    }
});

// Redirect root to manifest
app.get('/', (req, res) => res.redirect('/manifest.json'));

// Catalog endpoint
app.get('/catalog/:type/:id/:extra?.json', async (req, res) => {
    const { type, id } = req.params;
    let extra = {};
     if (req.params.extra && req.params.extra.includes('search=')) {
        try { extra.search = decodeURIComponent(req.params.extra.split('search=')[1]); }
        catch (e) { console.warn("Failed to parse search extra:", req.params.extra); }
    }
    console.log('Processing catalog request:', { type, id, extra });

    if (type !== 'series' || id !== 'mako-vod-shows') {
        console.log('Invalid catalog request.');
        return res.status(404).json({ metas: [], error: 'Catalog not found.' });
    }

    let cacheNeedsSave = false; // Track if cache needs saving *after* response

    try {
        const cache = await loadCache();
        const initialShows = await extractContent(`${BASE_URL}/mako-vod-index`, 'shows');
        console.log(`Catalog: Extracted ${initialShows.length} initial show links.`);

        // Filter based on search if needed
        let filteredShows = initialShows;
        if (extra.search) {
            const search = extra.search.toLowerCase();
            // Filter based on the initially scraped name first
            filteredShows = initialShows.filter(show => show.name && show.name.toLowerCase().includes(search));
            console.log(`Catalog: Found ${filteredShows.length} shows matching initial name search: ${search}`);
            // Note: Full name search requires fetching details, done below.
        }

        // Process only the first N shows synchronously for the response
        const showsForResponse = filteredShows.slice(0, MAX_CATALOG_INITIAL_LOAD);
        const processedMetas = [];
        let syncNeedsSave = false; // Track if sync processing modified cache

        console.log(`Catalog: Processing details for first ${showsForResponse.length} shows...`);
        for (const show of showsForResponse) {
             if (!show.url) continue; // Skip if URL is missing
             try {
                const { details, needsSave } = await getOrUpdateShowDetails(show.url, cache);
                 if (needsSave) syncNeedsSave = true; // Mark cache modified

                 // If searching, perform secondary filter based on potentially updated name
                 if (extra.search && details.name && !details.name.toLowerCase().includes(extra.search.toLowerCase())) {
                      continue; // Skip if updated name doesn't match search
                 }

                 processedMetas.push({
                     id: `mako:${encodeURIComponent(show.url)}`,
                     type: 'series',
                     name: details.name,
                     poster: details.poster,
                     posterShape: 'poster',
                     background: details.background,
                     logo: DEFAULT_LOGO,
                     description: 'מאקו VOD',
                 });
             } catch (showError) {
                  console.error(`Error processing show ${show.url} for catalog response:`, showError.message);
             }
             await sleep(50); // Small delay between detail fetches
        }
         console.log(`Catalog: Processed ${processedMetas.length} metas for initial response.`);

        // Send response quickly
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=600'); // Cache for 30 mins
        res.status(200).json({ metas: processedMetas });

        // --- Background Processing (after response) ---
        if (syncNeedsSave) cacheNeedsSave = true; // Mark for save if sync part changed cache

        const remainingShows = filteredShows.slice(MAX_CATALOG_INITIAL_LOAD);
        if (remainingShows.length > 0) {
             console.log(`Catalog: Starting background processing for ${remainingShows.length} remaining shows...`);
             let backgroundNeedsSave = false;
             for (const show of remainingShows) {
                  if (!show.url) continue;
                  try {
                      // Don't need the details here, just trigger potential cache update
                     const { needsSave } = await getOrUpdateShowDetails(show.url, cache);
                      if (needsSave) backgroundNeedsSave = true;
                  } catch (bgShowError) {
                       console.error(`Background error processing show ${show.url}:`, bgShowError.message);
                  }
                  await sleep(DELAY_BETWEEN_REQUESTS_MS); // Use standard delay for background tasks
             }
             if (backgroundNeedsSave) cacheNeedsSave = true;
             console.log(`Catalog: Background processing finished.`);
        }

        // Save cache if anything was updated
        if (cacheNeedsSave) {
             console.log("Catalog: Saving updated cache after processing...");
             await saveCache(cache);
        } else {
            // console.log("Catalog: No cache updates needed after processing.");
        }

    } catch (err) {
        console.error('Catalog handler main error:', err);
        // Ensure response is sent even on error if not already sent
        if (!res.headersSent) {
            res.status(500).json({ metas: [], error: 'Failed to process catalog request' });
        }
    }
});

// Meta endpoint
app.get('/meta/:type/:id.json', async (req, res) => {
    const { type, id } = req.params;
    console.log('Processing meta request:', { type, id });

    if (type !== 'series' || !id.startsWith('mako:')) {
        return res.status(404).json({ meta: null, error: 'Invalid meta ID format' });
    }

    let showUrl;
    try {
        showUrl = decodeURIComponent(id.replace('mako:', ''));
        if (!showUrl.startsWith(BASE_URL)) {
            throw new Error('Invalid base URL');
        }
    } catch (e) {
        console.error('Invalid show URL derived from meta ID:', id);
        return res.status(400).json({ meta: null, error: 'Invalid show URL in ID' });
    }

    let cacheNeedsSave = false;

    try {
        const cache = await loadCache();

        // 1. Get Show Details
        const { details: showDetails, needsSave: detailsNeedSave } = await getOrUpdateShowDetails(showUrl, cache);
        if (detailsNeedSave) cacheNeedsSave = true;

        // 2. Get Episodes
        const { episodes, needsSave: episodesNeedSave } = await getShowEpisodes(showUrl, cache);
        if (episodesNeedSave) cacheNeedsSave = true;

        // 3. Save cache if modified
        if (cacheNeedsSave) {
            console.log("Meta: Saving updated cache...");
            await saveCache(cache); // Await save before responding fully
        }

        // 4. Format Stremio Meta Response
        const videos = episodes.map(ep => ({
            id: `${id}:ep:${ep.guid}`, // Format: mako:encodedShowUrl:ep:guid
            title: ep.name || `Episode ${ep.episodeNum}`,
            season: ep.seasonNum,
            episode: ep.episodeNum,
            released: null, // Mako doesn't easily provide release dates
            // Add thumbnail here if available, e.g., ep.thumbnail ? { thumbnail: ep.thumbnail } : {}
        }));

        const metaResponse = {
            meta: {
                id,
                type: 'series',
                name: showDetails.name,
                poster: showDetails.poster,
                posterShape: 'poster',
                background: showDetails.background,
                logo: DEFAULT_LOGO,
                description: 'מאקו VOD',
                videos
            }
        };

        console.log(`Meta: Responding with ${videos.length} videos for ${showDetails.name}`);
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=1800'); // Cache for 1 hour
        res.status(200).json(metaResponse);

    } catch (err) {
        console.error(`Meta handler error for ID ${id} (URL: ${showUrl}):`, err);
        res.status(500).json({ meta: null, error: 'Failed to process meta request' });
    }
});

// Stream endpoint
app.get('/stream/:type/:id.json', async (req, res) => {
    const { type, id } = req.params;
    console.log('Processing stream request:', { type, id });

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
        if (!showUrl.startsWith(BASE_URL)) {
            throw new Error('Invalid base URL');
        }
    } catch (e) {
        console.error('Invalid show URL derived from stream ID:', showIdRaw);
        return res.status(400).json({ streams: [], error: 'Invalid show URL in ID' });
    }

    console.log(`Stream handler: Looking for GUID ${episodeGuid} within show ${showUrl}`);
    let cacheNeedsSave = false; // Track potential cache updates

    try {
        const cache = await loadCache();

        // 1. Get episodes (potentially updating cache)
        // We need the episode.url corresponding to the GUID
        const { episodes, needsSave } = await getShowEpisodes(showUrl, cache);
        if (needsSave) cacheNeedsSave = true;

        // 2. Find the specific episode by GUID
        const targetEpisode = episodes.find(ep => ep.guid === episodeGuid);

        if (!targetEpisode || !targetEpisode.url) {
            console.error(`Stream handler: Could not find episode URL for GUID ${episodeGuid} in show ${showUrl} after checking ${episodes.length} episodes.`);
            // Save cache even if episode not found, as getShowEpisodes might have updated season data
             if (cacheNeedsSave) {
                 console.log("Stream: Saving updated cache even though episode not found...");
                 await saveCache(cache);
             }
            return res.status(404).json({ streams: [], error: 'Episode GUID not found within the show.' });
        }

         console.log(`Stream handler: Found episode URL: ${targetEpisode.url}`);

        // 3. Get the final video URL (decryption/entitlement)
        const videoUrl = await getVideoUrl(targetEpisode.url);

        // 4. Save cache if necessary (do this *before* checking videoUrl failure)
         if (cacheNeedsSave) {
             console.log("Stream: Saving updated cache...");
             await saveCache(cache);
         }

        // 5. Check if video URL retrieval failed
        if (!videoUrl) {
            console.error(`Stream handler: getVideoUrl failed for ${targetEpisode.url}`);
            return res.status(500).json({ streams: [], error: 'Failed to retrieve video stream URL' });
        }

        // 6. Format Stremio Stream Response
        const streams = [{
            url: videoUrl,
            title: 'Play (HLS)', // Indicate format
            type: 'hls', // Specify HLS stream type (important for some players)
             behaviorHints: {
                 // notWebReady: true, // Let Stremio decide based on HLS support
                 bingeGroup: `mako-${showUrl}`, // Group episodes for binge watching
                 // Consider adding proxy headers if needed, but usually not required for direct HLS
                 // headers: { ... }
             }
        }];

        console.log(`Stream: Responding with stream for GUID ${episodeGuid}`);
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store, max-age=0'); // Do not cache stream URLs
        res.status(200).json({ streams });

    } catch (err) {
        console.error(`Stream handler error for ID ${id} (URL: ${showUrl}, GUID: ${episodeGuid}):`, err);
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