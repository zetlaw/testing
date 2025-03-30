// index.js
const express = require('express');
const cors = require('cors');
const { addonBuilder } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const fs = require('fs');
const { CRYPTO, cryptoOp } = require('./crypto');

// --- Constants ---
const BASE_URL = 'https://www.mako.co.il';
const DEFAULT_LOGO = 'https://img.mako.co.il/2016/02/17/logo12plus_i.jpg';
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const DELAY_BETWEEN_REQUESTS_MS = 500;
const REQUEST_TIMEOUT_MS = 10000;
const EPISODE_FETCH_TIMEOUT_MS = 20000;
const BATCH_SIZE = 5;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

// Detect if we're running in a serverless environment
const IS_SERVERLESS = process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.VERCEL || process.env.NETLIFY;
const WRITABLE_DIR = IS_SERVERLESS ? '/tmp' : __dirname;

// --- Cache Paths ---
const LOCAL_CACHE_DIR = path.join(WRITABLE_DIR, '.cache');
const LOCAL_CACHE_FILE = path.join(LOCAL_CACHE_DIR, 'shows.json');
const LOCAL_METADATA_FILE = path.join(LOCAL_CACHE_DIR, "metadata.json");
const BLOB_METADATA_KEY_PREFIX = 'mako-shows-metadata-v1';
const MAX_BLOB_FILES_TO_KEEP = 2;

// --- Precached data paths ---
// Keep precached data in the read-only filesystem since it's pregenerated
let PRECACHED_DIR = path.join(__dirname, 'precached');
let PRECACHED_METADATA_FILE = path.join(PRECACHED_DIR, 'metadata.json');

// In serverless environments, try alternate paths if the file doesn't exist
if (IS_SERVERLESS) {
    // Log the environment for debugging
    console.log(`Running in serverless environment. __dirname=${__dirname}`);
    console.log(`Default precached path: ${PRECACHED_METADATA_FILE}`);
    
    // Try fallback paths for serverless environments
    const fallbackPaths = [
        path.join(process.cwd(), 'precached/metadata.json'),
        '/tmp/precached/metadata.json',
        path.join(__dirname, '../precached/metadata.json'),
        path.join(__dirname, '../../precached/metadata.json')
    ];
    
    if (!fs.existsSync(PRECACHED_METADATA_FILE)) {
        console.log(`Primary precached metadata file not found, trying fallbacks...`);
        for (const fallbackPath of fallbackPaths) {
            if (fs.existsSync(fallbackPath)) {
                console.log(`Found precached metadata at fallback path: ${fallbackPath}`);
                PRECACHED_METADATA_FILE = fallbackPath;
                PRECACHED_DIR = path.dirname(fallbackPath);
                break;
            } else {
                console.log(`Fallback path not found: ${fallbackPath}`);
            }
        }
    }
}

// --- Headers ---
const HEADERS = {
    'User-Agent': USER_AGENT,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,he;q=0.8',
    'Referer': 'https://www.mako.co.il/mako-vod-index',
    'Connection': 'keep-alive'
};

// --- Background Queue Configuration ---
const QUEUE_BATCH_SIZE = 5;
const QUEUE_DELAY_MS = 1000;
const MAX_QUEUE_RETRIES = 3;

// --- Metadata Processing Queue ---
const metadataQueue = [];
let isProcessingQueue = false;
let lastQueueProcess = 0;
let globalMetadataCache = {};

// --- Initialize ---
// Create cache directory if it doesn't exist
try {
    if (!fs.existsSync(LOCAL_CACHE_DIR)) {
        console.log(`Creating cache directory: ${LOCAL_CACHE_DIR}`);
        fs.mkdirSync(LOCAL_CACHE_DIR, { recursive: true });
    }
} catch (err) {
    console.error(`Error creating cache directory: ${err.message}`);
    // In serverless environments, we can continue without the cache directory
    // as we'll still have the pre-cached metadata in memory
}

// Load pre-cached metadata at startup
try {
    if (fs.existsSync(PRECACHED_METADATA_FILE)) {
        console.log(`Loading pre-cached metadata from ${PRECACHED_METADATA_FILE}`);
        const precachedData = JSON.parse(fs.readFileSync(PRECACHED_METADATA_FILE, 'utf8'));
        
        // Initialize the metadata cache with the precached data
        globalMetadataCache = precachedData;
        console.log(`Loaded ${Object.keys(globalMetadataCache).length} pre-cached metadata entries`);
        
        // If in serverless, copy precached data to /tmp for future invocations
        if (IS_SERVERLESS) {
            try {
                const tmpDir = '/tmp/precached';
                if (!fs.existsSync(tmpDir)) {
                    fs.mkdirSync(tmpDir, { recursive: true });
                }
                const tmpFile = path.join(tmpDir, 'metadata.json');
                fs.writeFileSync(tmpFile, JSON.stringify(precachedData));
                console.log(`Copied precached metadata to ${tmpFile} for future invocations`);
            } catch (copyErr) {
                console.error(`Failed to copy precached data to /tmp: ${copyErr.message}`);
            }
        }
    } else {
        console.log(`Pre-cached metadata file not found at ${PRECACHED_METADATA_FILE}`);
        
        // Try a direct HTTP fetch of the metadata if in serverless
        if (IS_SERVERLESS) {
            try {
                console.log('Attempting to fetch precached metadata via HTTP');
                const deploymentUrl = process.env.VERCEL_URL || '';
                if (deploymentUrl) {
                    const metadataUrl = `https://${deploymentUrl}/precached/metadata.json`;
                    console.log(`Fetching from: ${metadataUrl}`);
                    const response = await axios.get(metadataUrl, { timeout: 10000 });
                    if (response.data && typeof response.data === 'object') {
                        globalMetadataCache = response.data;
                        console.log(`Successfully fetched ${Object.keys(globalMetadataCache).length} metadata entries via HTTP`);
                        
                        // Save to tmp for future invocations
                        const tmpDir = '/tmp/precached';
                        if (!fs.existsSync(tmpDir)) {
                            fs.mkdirSync(tmpDir, { recursive: true });
                        }
                        fs.writeFileSync(path.join(tmpDir, 'metadata.json'), JSON.stringify(globalMetadataCache));
                    }
                } else {
                    console.log('No deployment URL found in environment variables');
                }
            } catch (httpErr) {
                console.error(`HTTP fetch of metadata failed: ${httpErr.message}`);
            }
        }
    }
    
    // Load any additional locally cached metadata if it exists
    if (fs.existsSync(LOCAL_METADATA_FILE)) {
        console.log(`Loading local metadata cache from ${LOCAL_METADATA_FILE}`);
        const localData = JSON.parse(fs.readFileSync(LOCAL_METADATA_FILE, 'utf8'));
        
        // Merge with priority to local cache (as it might be more recent)
        Object.keys(localData).forEach(url => {
            if (!globalMetadataCache[url] || 
                (localData[url].lastUpdated && 
                (!globalMetadataCache[url].lastUpdated || 
                localData[url].lastUpdated > globalMetadataCache[url].lastUpdated))) {
                globalMetadataCache[url] = localData[url];
            }
        });
        
        console.log(`Merged local metadata cache, now have ${Object.keys(globalMetadataCache).length} entries`);
    }
} catch (err) {
    console.error(`Error loading cached metadata: ${err.message}`);
    // Initialize with empty cache if loading fails
    globalMetadataCache = {};
}

// Set a timeout to handle serverless timeouts gracefully
if (IS_SERVERLESS) {
    // Most serverless platforms have a 10 second timeout
    const SERVERLESS_TIMEOUT_MS = 9500; // Just under 10 seconds to be safe
    
    setTimeout(() => {
        console.log('Serverless timeout approaching, clearing queue and freeing resources');
        // Clear the queue to prevent further processing
        metadataQueue.length = 0;
        isProcessingQueue = false;
        
        // Free memory in case we're approaching limits
        if (Object.keys(globalMetadataCache).length > 200) {
            console.log(`Trimming metadata cache from ${Object.keys(globalMetadataCache).length} to 200 entries`);
            // Keep only the 200 most recently used entries
            const entries = Object.entries(globalMetadataCache)
                .sort((a, b) => (b[1].lastUpdated || 0) - (a[1].lastUpdated || 0))
                .slice(0, 200);
            
            globalMetadataCache = Object.fromEntries(entries);
        }
    }, SERVERLESS_TIMEOUT_MS);
}

// --- Queue Management Functions ---
/**
 * Add a URL to the metadata fetch queue
 * @param {string} url - The URL to fetch metadata for
 * @param {number} priority - Priority level (higher = more important)
 */
function queueMetadataFetch(url, priority = 0) {
    // Don't add duplicates to the queue
    const existingIndex = metadataQueue.findIndex(item => item.url === url);
    
    if (existingIndex >= 0) {
        // Update priority if new priority is higher
        if (priority > metadataQueue[existingIndex].priority) {
            metadataQueue[existingIndex].priority = priority;
            // Re-sort queue by priority (higher first)
            metadataQueue.sort((a, b) => b.priority - a.priority);
        }
        return;
    }
    
    // Add to queue
    metadataQueue.push({ url, priority, retries: 0 });
    
    // Sort by priority
    metadataQueue.sort((a, b) => b.priority - a.priority);
    
    // Start processing queue if not already running
    if (!isProcessingQueue) {
        processMetadataQueue();
    }
}

/**
 * Process items in the metadata queue
 */
async function processMetadataQueue() {
    if (isProcessingQueue || metadataQueue.length === 0) return;
    
    isProcessingQueue = true;
    console.log(`Processing metadata queue (${metadataQueue.length} items remaining)`);
    
    // Throttle queue processing
    const now = Date.now();
    if (now - lastQueueProcess < QUEUE_DELAY_MS) {
        await new Promise(resolve => setTimeout(resolve, QUEUE_DELAY_MS));
    }
    lastQueueProcess = Date.now();
    
    // For serverless environments, process a smaller batch to avoid timeouts and memory issues
    const batchSize = IS_SERVERLESS ? Math.min(3, QUEUE_BATCH_SIZE) : QUEUE_BATCH_SIZE;
    
    try {
        // Process a batch of items
        const batch = metadataQueue.slice(0, batchSize);
        const promises = batch.map(async (item) => {
            try {
                console.log(`Fetching metadata for ${item.url} (background)`);
                const metadata = await extractShowNameAndImages(item.url);
                
                // Store in cache
                globalMetadataCache[item.url] = {
                    ...metadata,
                    lastUpdated: Date.now()
                };
                
                // Remove from queue
                const index = metadataQueue.findIndex(i => i.url === item.url);
                if (index >= 0) metadataQueue.splice(index, 1);
                
                console.log(`Successfully fetched metadata for: ${metadata.name} [Source: ${metadata.nameSource}]`);
                return { success: true, url: item.url };
            } catch (err) {
                console.error(`Error fetching metadata for ${item.url}: ${err.message}`);
                
                // Handle retries
                const index = metadataQueue.findIndex(i => i.url === item.url);
                if (index >= 0) {
                    if (metadataQueue[index].retries < MAX_QUEUE_RETRIES) {
                        metadataQueue[index].retries++;
                        // Move to the end of the queue for retry
                        const item = metadataQueue.splice(index, 1)[0];
                        metadataQueue.push(item);
                    } else {
                        // Give up after max retries
                        console.log(`Giving up on ${item.url} after ${MAX_QUEUE_RETRIES} retries`);
                        metadataQueue.splice(index, 1);
                    }
                }
                
                return { success: false, url: item.url, error: err.message };
            }
        });
        
        await Promise.all(promises);
        
        // Save updated metadata to cache file
        try {
            fs.writeFileSync(LOCAL_METADATA_FILE, JSON.stringify(globalMetadataCache, null, 2));
        } catch (err) {
            console.error(`Error saving metadata cache: ${err.message}`);
        }
        
    } finally {
        isProcessingQueue = false;
        
        // If there are more items, continue processing after a delay
        if (metadataQueue.length > 0) {
            // In serverless environments, we need to be careful about recursive setTimeout calls
            // as they can cause memory leaks if the function keeps running
            const nextDelay = IS_SERVERLESS ? 
                Math.max(QUEUE_DELAY_MS, 2000) : // Longer delay in serverless
                QUEUE_DELAY_MS;
                
            // Limit the queue size in serverless environments to prevent memory issues
            if (IS_SERVERLESS && metadataQueue.length > 100) {
                console.log(`Pruning queue from ${metadataQueue.length} to 100 items to prevent memory issues`);
                // Keep only the highest priority items
                metadataQueue.sort((a, b) => b.priority - a.priority);
                metadataQueue.splice(100);
            }
            
            setTimeout(processMetadataQueue, nextDelay);
        }
    }
}

// --- Metadata Functions ---
/**
 * Get metadata for a show URL, using cache if available
 * @param {string} url - The URL to get metadata for
 * @param {number} maxAgeSec - Maximum age of cached metadata in seconds
 * @returns {Promise<Object>} - The show metadata
 */
async function getMetadata(url, maxAgeSec = 86400) {
    const maxAgeMs = maxAgeSec * 1000;
    
    // Check if metadata exists in cache and is fresh enough
    if (globalMetadataCache[url] && 
        globalMetadataCache[url].lastUpdated && 
        Date.now() - globalMetadataCache[url].lastUpdated < maxAgeMs) {
        console.log(`Metadata cache hit for ${url}`);
        return globalMetadataCache[url];
    }
    
    console.log(`Metadata cache miss or stale for ${url}`);
    
    // Try to get from cache even if stale, as a fallback
    const cachedData = globalMetadataCache[url];
    
    // Queue for background refresh regardless of whether we have cached data
    queueMetadataFetch(url, cachedData ? 1 : 2); // Prioritize if we have no cached data
    
    if (cachedData) {
        return cachedData;
    }
    
    // If no cached data, fetch directly (this will block the response)
    try {
        console.log(`Direct fetch for ${url} (blocking)`);
        const metadata = await extractShowNameAndImages(url);
        
        // Store in cache
        globalMetadataCache[url] = {
            ...metadata,
            lastUpdated: Date.now()
        };
        
        // Save to cache file
        try {
            fs.writeFileSync(LOCAL_METADATA_FILE, JSON.stringify(globalMetadataCache, null, 2));
        } catch (err) {
            console.error(`Error saving metadata cache: ${err.message}`);
        }
        
        return metadata;
    } catch (err) {
        console.error(`Error fetching metadata for ${url}: ${err.message}`);
        throw err;
    }
}

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
    try {
        const response = await axios.get(url, { headers: HEADERS, timeout: REQUEST_TIMEOUT_MS });
        const $ = cheerio.load(response.data);
        let name = null;
        let poster = null;
        let background = null;
        let description = 'מאקו VOD';
        let seasons = [];
        let nameSource = "unknown";

        // Try JSON-LD - This is our primary source of information
        try {
            const jsonldTag = $('script[type="application/ld+json"]').html();
            if (jsonldTag) {
                const data = JSON.parse(jsonldTag);
                
                // Direct extraction of name if it's a TVSeries (highest priority)
                if (data['@type'] === 'TVSeries' && data.name) {
                    name = data.name; // Directly use name property
                    nameSource = "json-ld";
                    description = data.description || description;
                    
                    if (data.image) {
                        poster = Array.isArray(data.image) ? data.image[0] : data.image;
                    }
                    
                    if (data.containsSeason && Array.isArray(data.containsSeason)) {
                        seasons = data.containsSeason;
                    }
                } 
                // If it points to a TV series
                else if (data.partOfTVSeries) {
                    name = data.partOfTVSeries.name;
                    nameSource = "json-ld";
                    description = data.partOfTVSeries.description || description;
                    
                    if (data.partOfTVSeries.image) {
                        poster = Array.isArray(data.partOfTVSeries.image) ? 
                                 data.partOfTVSeries.image[0] : data.partOfTVSeries.image;
                    }
                    
                    if (data.partOfTVSeries.containsSeason && Array.isArray(data.partOfTVSeries.containsSeason)) {
                        seasons = data.partOfTVSeries.containsSeason;
                    }
                }
                // If it's a TVSeason
                else if (data['@type'] === 'TVSeason') {
                    name = data.name;
                    nameSource = "json-ld";
                    description = data.description || description;
                    
                    if (data.image) {
                        poster = Array.isArray(data.image) ? data.image[0] : data.image;
                    }
                }

                if (name && name.trim() && seasons && seasons.length > 1) {
                    name = `${name} (${seasons.length} עונות)`;
                }
                
                // Clean up fields
                if (name) name = name.replace(/\s+/g, ' ').trim();
            }
        } catch (jsonErr) {
            console.warn(`Warn parsing JSON-LD for ${url}: ${jsonErr.message.substring(0, 100)}...`);
            name = null;
        }

        // Fallback Meta Tags / H1
        if (!name) {
            const ogTitle = $('meta[property="og:title"]').attr('content');
            const h1Title = $('h1').first().text();
            name = ogTitle || h1Title;
            nameSource = "html";
            if (name) name = name.replace(/\s+/g, ' ').trim();
        }

        if (description === 'מאקו VOD') {
            description = $('meta[property="og:description"]').attr('content') || 
                         $('meta[name="description"]').attr('content') || 
                         description;
            if(description) description = description.replace(/\s+/g, ' ').trim();
        }

        if (!poster) {
            poster = getValidImage(
                $('meta[property="og:image"]').attr('content') ||
                $('meta[name="twitter:image"]').attr('content') ||
                $('link[rel="image_src"]').attr('href') ||
                $('.vod_item img').first().attr('src') ||
                $('.vod_item_wrap img').first().attr('src')
            );
        } else {
            poster = getValidImage(poster);
        }

        background = getValidImage($('meta[property="og:image:width"][content="1920"]').parent().attr('content')) || poster;

        return {
            name: name || 'Unknown Show',
            poster: poster,
            background: background,
            description: description,
            seasons: seasons.length,
            nameSource: nameSource
        };
    } catch (e) {
        console.error(`Error extracting show details from ${url}:`, e.message);
        return {
            name: 'Error Loading Show',
            poster: DEFAULT_LOGO,
            background: DEFAULT_LOGO,
            description: 'Error loading description',
            seasons: 0,
            nameSource: "error"
        };
    }
};

const extractContent = async (url, contentType) => {
    try {
        await sleep(DELAY_BETWEEN_REQUESTS_MS);
        const response = await axios.get(url, {
            headers: HEADERS,
            timeout: contentType === 'episodes' ? EPISODE_FETCH_TIMEOUT_MS : REQUEST_TIMEOUT_MS
        });
        const $ = cheerio.load(response.data);

        const configs = {
            shows: {
                selectors: [
                    'li > a[href^="/mako-vod-"]',
                    'li a[href^="/mako-vod-"]',
                    '.vod_item_wrap article a[href^="/mako-vod-"]',
                    '.vod_item article a[href^="/mako-vod-"]',
                    'section[class*="vod"] a[href^="/mako-vod-"]',
                    'a[href^="/mako-vod-"]:not([href*="purchase"]):not([href*="index"])'
                ],
                fields: {
                    url: { attribute: 'href' },
                    name: [
                        { selector: 'img', attribute: 'alt' },
                        { selector: '.title strong' }, 
                        { selector: 'h3.title' }, 
                        { selector: 'h2.title' },
                        { selector: '.vod-title' }, 
                        { selector: '.caption' },
                        { text: true }
                    ],
                    poster: { selector: 'img', attribute: 'src' }
                },
                base: BASE_URL,
                filter: (item) => item.url && !item.url.includes('/purchase') && !item.url.includes('/index') && !item.url.match(/live/i)
            },
            seasons: {
                selectors: ['div#seasonDropdown ul ul li a', '.seasons_nav a'],
                fields: { 
                    name: { selector: 'span', text: true }, 
                    url: { attribute: 'href' } 
                },
                base: url,
                filter: (item) => item.url && item.name && !item.name.toLowerCase().includes('כל הפרקים')
            },
            episodes: {
                selectors: [
                    'li.card a', 
                    'a[href*="videoGuid="]',
                    'li.vod_item a[href*="videoGuid="]', 
                    '.vod_item a[href*="videoGuid="]',
                    '.vod_item_wrap a[href*="videoGuid="]',
                    'li.vod_item a', 
                    '.vod_item a', 
                    '.vod_item_wrap a'
                ],
                fields: {
                    name: [
                        { selector: 'strong.title' },
                        { selector: '.title strong' }, 
                        { selector: '.vod-title' }, 
                        { selector: '.caption' },
                        { text: true }
                    ],
                    url: { attribute: 'href' }
                },
                base: url,
                filter: (item) => item.url
            }
        };

        const config = configs[contentType];
        const items = [];
        const seenUrlsOrGuids = new Set();

        // Find elements using selectors
        let combinedElements = [];
        for (const selector of config.selectors) {
            try {
                const elements = $(selector);
                if (elements.length > 0) {
                    elements.each((_, elem) => combinedElements.push(elem));
                    break; // Use the first successful selector that finds elements
                }
            } catch (selectorError) {
                console.warn(`Selector "${selector}" failed on ${url}: ${selectorError.message}`);
            }
        }

        console.log(`Found ${combinedElements.length} ${contentType} at ${url}`);

        if (combinedElements.length === 0) {
            console.warn(`No elements found for ${contentType} at ${url}`);
            return [];
        }

        for (const elem of combinedElements) {
            const item = {};
            const $elem = $(elem);

            // Process each field
            for (const [field, fieldConfig] of Object.entries(config.fields)) {
                if (Array.isArray(fieldConfig)) {
                    // Try multiple field configs
                    for (const subConf of fieldConfig) {
                        try {
                            const target = subConf.selector ? $elem.find(subConf.selector) : $elem;
                            if (target.length > 0) {
                                let value = subConf.attribute ? target.first().attr(subConf.attribute) : 
                                         (subConf.text && !subConf.selector ? $elem.text() : target.first().text());
                                if (value) {
                                    item[field] = value.replace(/\s+/g, ' ').trim();
                                    break;
                                }
                            }
                        } catch (subErr) { continue; }
                    }
                } else {
                    // Single field config
                    try {
                        const target = fieldConfig.selector ? $elem.find(fieldConfig.selector) : $elem;
                        if (target.length > 0) {
                            let value = fieldConfig.attribute ? target.first().attr(fieldConfig.attribute) : target.first().text();
                            if (value !== undefined && value !== null) {
                                value = String(value).replace(/\s+/g, ' ').trim();
                                if (field === 'url' && value) {
                                    try { 
                                        value = new URL(value, config.base).href.split('?')[0].split('#')[0]; 
                                    }
                                    catch (urlError) { value = null; }
                                }
                                if (value) item[field] = value;
                            }
                        }
                    } catch (fieldErr) { continue; }
                }
            }

            // Handle episodes GUID extraction
            if (contentType === 'episodes' && item.url) {
                // Try to extract GUID from URL patterns
                let guidMatch = item.url.match(/\/VOD-([\w-]+)\.htm/);
                if (guidMatch && guidMatch[1]) {
                    item.guid = guidMatch[1];
                } else {
                    guidMatch = item.url.match(/[?&](guid|videoGuid)=([\w-]+)/i);
                    if (guidMatch && guidMatch[2]) {
                        item.guid = guidMatch[2];
                    }
                }
                
                if (!item.guid) {
                    continue; // Skip episodes without a GUID
                }
                
                if (!item.name) {
                    item.name = `Episode ${item.guid.substring(0,6)}...`;
                }
            }

            // Determine unique key for deduplication
            let uniqueKey = null;
            if (contentType === 'episodes') {
                uniqueKey = item.guid;
            } else {
                uniqueKey = item.url;
                
                // Additional processing for shows and seasons
                if (contentType === 'shows') {
                    if (!item.name) item.name = 'Unknown Show';
                    if (item.poster) item.poster = getValidImage(item.poster);
                }
                if (contentType === 'seasons' && !item.name) {
                    const seasonMatch = item.url.match(/season-(\d+)/i);
                    if (seasonMatch) {
                        item.name = `Season ${seasonMatch[1]}`;
                    } else {
                        item.name = "Unknown Season";
                    }
                }
            }

            // Add to results if it passes filters and isn't a duplicate
            if (config.filter(item) && uniqueKey && !seenUrlsOrGuids.has(uniqueKey)) {
                items.push(item);
                seenUrlsOrGuids.add(uniqueKey);
            }
        }

        return items;
    } catch (e) {
        console.error(`Error in extractContent (${contentType}, ${url}):`, e.message);
        return [];
    }
};

const getVideoUrl = async (episodeUrl) => {
    try {
        const episodePageResponse = await axios.get(episodeUrl, { headers: HEADERS, timeout: REQUEST_TIMEOUT_MS, responseType: 'text' });
        const $ = cheerio.load(episodePageResponse.data);
        const script = $('#__NEXT_DATA__').html();
        if (!script) throw new Error("Could not find __NEXT_DATA__ script tag.");

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

        const ajaxUrl = `${BASE_URL}/AjaxPage?jspName=playlist12.jsp&vcmid=${videoDetails.vcmid}&videoChannelId=${videoDetails.videoChannelId}&galleryChannelId=${videoDetails.galleryChannelId}&consumer=responsive`;
        const playlistResponse = await axios.get(ajaxUrl, {
            headers: { ...HEADERS, 'Accept': 'text/plain' },
            timeout: REQUEST_TIMEOUT_MS, responseType: 'arraybuffer'
        });
        if (!playlistResponse.data || playlistResponse.data.byteLength === 0) throw new Error("Received empty playlist response buffer");

        const rawText = Buffer.from(playlistResponse.data).toString('latin1');
        const base64CharsRegex = /[^A-Za-z0-9+/=]/g;
        const encryptedDataClean = rawText.replace(base64CharsRegex, '');
        if (!encryptedDataClean) throw new Error("Playlist data was empty after cleaning.");
        const decryptedPlaylistJson = cryptoOp(encryptedDataClean, "decrypt", "playlist");
        if (!decryptedPlaylistJson) throw new Error("cryptoOp returned null during playlist decryption.");

        let playlistData;
        try { playlistData = JSON.parse(decryptedPlaylistJson); }
        catch (e) { throw new Error(`Parsing decrypted playlist JSON failed: ${e.message}`); }
        const hlsUrl = playlistData?.media?.[0]?.url;
        if (!hlsUrl) throw new Error("No media URL found in playlist data");

        let finalUrl = hlsUrl;
        try {
            const payload = JSON.stringify({ lp: new URL(hlsUrl).pathname, rv: "AKAMAI" });
            const encryptedPayload = cryptoOp(payload, "encrypt", "entitlement");
            if (!encryptedPayload) throw new Error("Failed to encrypt entitlement payload");

            const entitlementResponse = await axios.post(CRYPTO.entitlement.url, encryptedPayload, {
                headers: { ...HEADERS, 'Content-Type': 'text/plain;charset=UTF-8', 'Accept': 'text/plain' },
                timeout: REQUEST_TIMEOUT_MS, responseType: 'text'
            });
            const encryptedTicketData = entitlementResponse.data?.trim();
            if (!encryptedTicketData) throw new Error("Received empty entitlement response.");

            const ticketEncryptedClean = encryptedTicketData.replace(base64CharsRegex, '');
            if (!ticketEncryptedClean) throw new Error("Entitlement data empty after cleaning.");
            const decryptedTicketJson = cryptoOp(ticketEncryptedClean, "decrypt", "entitlement");
            if (!decryptedTicketJson) throw new Error("Failed to decrypt entitlement response");

            let entitlementData;
            try { entitlementData = JSON.parse(decryptedTicketJson); }
            catch (e) { throw new Error(`Parsing decrypted entitlement JSON failed: ${e.message}`); }

            const ticket = entitlementData?.tickets?.[0]?.ticket;
            if (ticket) {
                const separator = hlsUrl.includes('?') ? '&' : '?';
                finalUrl = `${hlsUrl}${separator}${ticket}`;
            }
        } catch (entitlementError) {
            console.warn(`Entitlement process failed: ${entitlementError.message}. Returning base HLS URL.`);
        }
        return finalUrl;
    } catch (error) {
        console.error(`getVideoUrl failed for ${episodeUrl}:`, error.message);
        if (error.response) console.error(`Axios Error Details: Status=${error.response.status}`);
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
        details = { ...cachedData };
    } else {
        console.log(`Metadata cache miss or stale for: ${showUrl}. Fetching...`);
        details = await extractShowNameAndImages(showUrl);
        if (details.name !== 'Error Loading Show' && details.name !== 'Unknown Show') {
            metadataCache.metadata[showUrl] = { ...details, lastUpdated: now };
            // Also update shows section for backward compatibility
            metadataCache.shows[showUrl] = { 
                name: details.name, 
                poster: details.poster 
            };
            needsSave = true;
            console.log(`Updated and cached metadata for: ${showUrl} [Source: ${details.nameSource}]`);
        } else {
            details = cachedData || details;
            console.warn(`Failed to fetch fresh metadata for ${showUrl}. Using stale/error data.`);
        }
    }
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
            const cacheKey = `season:${showUrl}`;
            const cachedSeasonEpisodes = metadataCache.seasons?.[cacheKey];

            if (cachedSeasonEpisodes && isCacheFresh) {
                console.log(`Using cached single-season episodes for ${showUrl}`);
                allEpisodes = cachedSeasonEpisodes;
            } else {
                console.log(`No seasons found (or single season) for ${showUrl}, fetching episodes directly.`);
                allEpisodes = await extractContent(showUrl, 'episodes');
                if (Array.isArray(allEpisodes)) {
                    metadataCache.seasons[cacheKey] = allEpisodes;
                    needsSave = true;
                    console.log(`Updated and cached ${allEpisodes.length} single-season episodes for ${showUrl}`);
                } else {
                    allEpisodes = [];
                }
            }
            allEpisodes.forEach((ep, i) => { ep.seasonNum = 1; ep.episodeNum = i + 1; });
        } else {
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
                            console.log(`Fetching episodes for season ${seasonNum}: ${season.name || season.url}`);
                            episodes = await extractContent(season.url, 'episodes');
                            if (Array.isArray(episodes)) {
                                metadataCache.seasons[cacheKey] = episodes;
                                needsSave = true;
                                console.log(`Updated and cached ${episodes.length} episodes for season ${seasonNum}`);
                            } else {
                                episodes = [];
                                console.warn(`Failed to fetch or got invalid episodes for season ${seasonNum}.`);
                            }
                        }
                        return episodes.map((ep, i) => ({ ...ep, seasonNum: seasonNum, episodeNum: i + 1 }));
                    })()
                );

                if (seasonProcessingPromises.length >= BATCH_SIZE || index === seasons.length - 1) {
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
        return { episodes: [], needsSave: false };
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

// Define catalog handler for the builder
builder.defineCatalogHandler(async ({ type, id, extra }) => {
    console.log(`Stremio SDK: catalog request for ${type}/${id}`);
    
    if (type !== 'series' || id !== 'mako-vod-shows') {
        return { metas: [] };
    }

    let searchTerm = null;
    if (extra && extra.search) {
        searchTerm = extra.search;
    }

    try {
        // Check if we already have shows in the cache
        let initialShows = [];
        if (fs.existsSync(LOCAL_CACHE_FILE)) {
            initialShows = JSON.parse(fs.readFileSync(LOCAL_CACHE_FILE, 'utf8'));
        } else {
            // Only fetch shows if not in cache
            initialShows = await extractContent(`${BASE_URL}/mako-vod-index`, 'shows');
            try {
                fs.writeFileSync(LOCAL_CACHE_FILE, JSON.stringify(initialShows, null, 2));
            } catch (err) {
                console.error(`Error saving shows cache: ${err.message}`);
            }
        }

        let filteredShows = initialShows;
        if (searchTerm) {
            const search = searchTerm.toLowerCase();
            filteredShows = initialShows.filter(show => {
                // Try to match by name first
                if (show.name && show.name.toLowerCase().includes(search)) {
                    return true;
                }
                
                // If we have metadata, try to match with that too
                const metadata = globalMetadataCache[show.url];
                if (metadata && metadata.name && metadata.name.toLowerCase().includes(search)) {
                    return true;
                }
                
                return false;
            });
        }

        // Limit to avoid timeout and memory issues
        const limitedShows = filteredShows.slice(0, 50);
        
        // Queue for background processing
        filteredShows.forEach((show, index) => {
            if (!show.url) return;
            const priority = index < 50 ? 2 : 0;
            queueMetadataFetch(show.url, priority);
        });

        // Create meta objects
        const metas = await Promise.all(limitedShows.map(async (show) => {
            if (!show.url) return null;
            
            try {
                // Use cached metadata if available
                const cachedMetadata = globalMetadataCache[show.url];
                
                if (cachedMetadata) {
                    return {
                        id: `mako:${encodeURIComponent(show.url)}`,
                        type: 'series',
                        name: cachedMetadata.name || show.name || 'Loading...',
                        poster: cachedMetadata.poster || show.poster || DEFAULT_LOGO,
                        posterShape: 'poster',
                        background: cachedMetadata.background || cachedMetadata.poster || show.poster || DEFAULT_LOGO,
                        logo: DEFAULT_LOGO,
                        description: cachedMetadata.description || 'מאקו VOD',
                    };
                }
                
                // Otherwise just return basic info
                return {
                    id: `mako:${encodeURIComponent(show.url)}`,
                    type: 'series',
                    name: show.name || 'Loading...',
                    poster: show.poster || DEFAULT_LOGO,
                    posterShape: 'poster',
                    logo: DEFAULT_LOGO,
                };
            } catch (error) {
                console.error(`Error creating meta for ${show.url}: ${error.message}`);
                return null;
            }
        }));

        return { metas: metas.filter(Boolean) };
    } catch (err) {
        console.error('Stremio catalog handler error:', err);
        return { metas: [] };
    }
});

// Define meta handler
builder.defineMetaHandler(async ({ type, id }) => {
    console.log(`Stremio SDK: meta request for ${type}/${id}`);
    
    if (type !== 'series' || !id.startsWith('mako:')) {
        return { meta: null };
    }

    try {
        const showUrl = decodeURIComponent(id.replace('mako:', ''));
        if (!showUrl.startsWith(BASE_URL)) {
            return { meta: null };
        }

        // Get metadata for the show (will use cache if available)
        const showDetails = await getMetadata(showUrl);
        
        // Queue background fetch for metadata refresh
        queueMetadataFetch(showUrl, 2);
        
        // Get seasons and episodes
        const seasons = await extractContent(showUrl, 'seasons');
        let allSeasons = [];
        
        // Process just the first two seasons to avoid timeouts
        const seasonsToProcess = seasons && seasons.length > 0 ? seasons.slice(0, 2) : [{ name: "Season 1", url: showUrl }];
        const allEpisodes = [];
        
        for (const season of seasonsToProcess) {
            const episodes = await extractContent(season.url, 'episodes');
            if (episodes && episodes.length > 0) {
                const seasonEpisodes = episodes.map((ep, idx) => ({
                    ...ep,
                    seasonNum: season.seasonNum,
                    episodeNum: idx + 1
                }));
                
                allEpisodes.push(...seasonEpisodes);
                console.log(`Added ${seasonEpisodes.length} episodes from season ${season.seasonNum}`);
            } else {
                console.log(`No episodes found for season ${season.seasonNum}`);
            }
            
            // Add a small delay between season processing
            await sleep(200);
        }
        
        // Sort episodes by season and episode number
        allEpisodes.sort((a, b) => {
            if (a.seasonNum !== b.seasonNum) return a.seasonNum - b.seasonNum;
            return a.episodeNum - b.episodeNum;
        });
        
        console.log(`Total episodes found: ${allEpisodes.length}`);
        
        // Organize episodes into videos for Stremio
        const videos = allEpisodes.map(ep => ({
            id: `${id}:ep:${ep.guid}`,
            title: ep.name || `S${ep.seasonNum}E${ep.episodeNum}`,
            season: ep.seasonNum,
            episode: ep.episodeNum,
            released: null,
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
        console.error('Stremio meta handler error:', err);
        return { meta: null };
    }
});

// Define stream handler
builder.defineStreamHandler(async ({ type, id }) => {
    console.log(`Stremio SDK: stream request for ${type}/${id}`);
    
    if (type !== 'series' || !id.startsWith('mako:')) {
        return { streams: [] };
    }

    try {
        const parts = id.split(':ep:');
        if (parts.length !== 2 || !parts[0] || !parts[1]) {
            return { streams: [] };
        }

        const showIdRaw = parts[0];
        const episodeGuid = parts[1];
        const showUrl = decodeURIComponent(showIdRaw.replace('mako:', ''));
        
        if (!showUrl.startsWith(BASE_URL)) {
            return { streams: [] };
        }

        // Find target episode
        let targetEpisode = null;
        const seasons = await extractContent(showUrl, 'seasons');
        let allSeasons = seasons && seasons.length > 0 ? 
            [{ name: "Season 1", url: showUrl }, ...seasons] :
            [{ name: "Season 1", url: showUrl }];
        
        for (const season of allSeasons) {
            const episodes = await extractContent(season.url, 'episodes');
            if (episodes && episodes.length > 0) {
                const found = episodes.find(ep => ep.guid === episodeGuid);
                if (found) {
                    targetEpisode = found;
                    break;
                }
            }
            if (season !== allSeasons[allSeasons.length - 1]) {
                await sleep(200);
            }
        }

        if (!targetEpisode || !targetEpisode.url) {
            return { streams: [] };
        }

        const videoUrl = await getVideoUrl(targetEpisode.url);
        if (!videoUrl) {
            return { streams: [] };
        }

        return {
            streams: [{
                url: videoUrl,
                title: `Play: ${targetEpisode.name || 'Episode'}`,
                type: 'hls',
                behaviorHints: {
                    bingeGroup: `mako-${showUrl}`,
                }
            }]
        };
    } catch (err) {
        console.error('Stremio stream handler error:', err);
        return { streams: [] };
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

// --- Express Routes ---
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

app.get('/', (req, res) => res.redirect('/manifest.json'));

app.get('/catalog/:type/:id/:extra?.json', async (req, res) => {
    try {
        const { type, id } = req.params;
        let extra = {};
        if (req.params.extra && req.params.extra.includes('search=')) {
            try { extra.search = decodeURIComponent(req.params.extra.split('search=')[1].split('/')[0]); }
            catch (e) { console.warn("Failed to parse search extra:", req.params.extra); }
        }

        // Handle catalog request
        if (type !== 'series' || id !== 'mako-vod-shows') {
            return res.status(404).json({ metas: [], error: 'Catalog not found.' });
        }

        let searchTerm = null;
        if (extra && extra.search) {
            searchTerm = extra.search;
        }

        // Check if we already have shows in the cache before trying to fetch
        let initialShows = [];
        if (fs.existsSync(LOCAL_CACHE_FILE)) {
            console.log(`Loading shows from cache ${LOCAL_CACHE_FILE}`);
            initialShows = JSON.parse(fs.readFileSync(LOCAL_CACHE_FILE, 'utf8'));
        } else {
            // Only fetch shows if not in cache
            initialShows = await extractContent(`${BASE_URL}/mako-vod-index`, 'shows');
            console.log(`Catalog: Extracted ${initialShows.length} initial show links.`);
            
            // Save to cache
            try {
                fs.writeFileSync(LOCAL_CACHE_FILE, JSON.stringify(initialShows, null, 2));
            } catch (err) {
                console.error(`Error saving shows cache: ${err.message}`);
            }
        }

        let filteredShows = initialShows;
        if (searchTerm) {
            const search = searchTerm.toLowerCase();
            filteredShows = initialShows.filter(show => {
                // Try to match by name first
                if (show.name && show.name.toLowerCase().includes(search)) {
                    return true;
                }
                
                // If we have metadata, try to match with that too
                const metadata = globalMetadataCache[show.url];
                if (metadata && metadata.name && metadata.name.toLowerCase().includes(search)) {
                    return true;
                }
                
                return false;
            });
            console.log(`Catalog: Found ${filteredShows.length} shows matching search: ${search}`);
        }

        // OPTIMIZATION: Limit number of shows to prevent timeouts
        // Only process the first 50 shows for initial response
        const MAX_SHOWS_TO_PROCESS = IS_SERVERLESS ? 50 : 100;
        let showsToProcess = filteredShows;
        let hasMoreShows = false;
        
        if (filteredShows.length > MAX_SHOWS_TO_PROCESS) {
            showsToProcess = filteredShows.slice(0, MAX_SHOWS_TO_PROCESS);
            hasMoreShows = true;
            console.log(`Limiting initial response to ${MAX_SHOWS_TO_PROCESS} shows to avoid timeout`);
        }

        // Queue all shows for background processing, but prioritize the ones we're displaying now
        filteredShows.forEach((show, index) => {
            if (!show.url) return;
            // High priority for visible items, low for the rest
            const priority = index < MAX_SHOWS_TO_PROCESS ? 2 : 0;
            queueMetadataFetch(show.url, priority);
        });

        const metas = [];
        // Use a smaller batch size for serverless environments
        const effectiveBatchSize = IS_SERVERLESS ? 10 : BATCH_SIZE;
        
        // Start a timer to make sure we don't exceed time limits
        const startTime = Date.now();
        const MAX_PROCESSING_TIME_MS = IS_SERVERLESS ? 5000 : 30000; // 5 seconds for serverless
        
        for (let i = 0; i < showsToProcess.length; i += effectiveBatchSize) {
            // Check if we're approaching the time limit
            if (Date.now() - startTime > MAX_PROCESSING_TIME_MS) {
                console.log(`Approaching time limit, returning ${metas.length} shows processed so far`);
                break;
            }
            
            const batch = showsToProcess.slice(i, i + effectiveBatchSize);
            const batchPromises = batch.map(async (show) => {
                if (!show.url) return null;
                
                try {
                    // First check if we have the metadata in cache
                    const cachedMetadata = globalMetadataCache[show.url];
                    
                    if (cachedMetadata) {
                        // Use the cached metadata
                        console.log(`Metadata cache hit for ${show.url}`);
                        return {
                            id: `mako:${encodeURIComponent(show.url)}`,
                            type: 'series',
                            name: cachedMetadata.name || show.name || 'Loading...',
                            poster: cachedMetadata.poster || show.poster || DEFAULT_LOGO,
                            posterShape: 'poster',
                            background: cachedMetadata.background || cachedMetadata.poster || show.poster || DEFAULT_LOGO,
                            logo: DEFAULT_LOGO,
                            description: cachedMetadata.description || 'מאקו VOD',
                        };
                    }
                    
                    // If we're in serverless, don't do direct fetches to avoid timeouts
                    // just return basic info and let the background job fetch metadata
                    if (IS_SERVERLESS) {
                        return {
                            id: `mako:${encodeURIComponent(show.url)}`,
                            type: 'series',
                            name: show.name || 'Loading...',
                            poster: show.poster || DEFAULT_LOGO,
                            posterShape: 'poster',
                            logo: DEFAULT_LOGO,
                        };
                    }
                    
                    // If not in serverless, we can try a direct fetch
                    const fetchedMetadata = await getMetadata(show.url);
                    
                    return {
                        id: `mako:${encodeURIComponent(show.url)}`,
                        type: 'series',
                        name: fetchedMetadata.name || show.name || 'Loading...',
                        poster: fetchedMetadata.poster || show.poster || DEFAULT_LOGO,
                        posterShape: 'poster',
                        background: fetchedMetadata.background || fetchedMetadata.poster || show.poster || DEFAULT_LOGO,
                        logo: DEFAULT_LOGO,
                        description: fetchedMetadata.description || 'מאקו VOD',
                    };
                } catch (error) {
                    console.error(`Error creating meta for ${show.url}: ${error.message}`);
                    return {
                        id: `mako:${encodeURIComponent(show.url)}`,
                        type: 'series',
                        name: show.name || 'Unknown Show',
                        poster: show.poster || DEFAULT_LOGO,
                        posterShape: 'poster',
                        logo: DEFAULT_LOGO,
                    };
                }
            });

            const batchResults = await Promise.all(batchPromises);
            metas.push(...batchResults.filter(Boolean));

            // If we have too many shows and it's a search, just return what we have so far
            if (searchTerm && metas.length > 0 && i + effectiveBatchSize < showsToProcess.length && 
                Date.now() - startTime > MAX_PROCESSING_TIME_MS / 2) {
                console.log(`Returning ${metas.length} search results before processing all shows to avoid timeout`);
                break;
            }

            // Small pause between batches
            if (i + effectiveBatchSize < showsToProcess.length) {
                await sleep(50); // Reduced from 100ms to 50ms
            }
        }

        // Add a note about pagination if there are more shows
        if (hasMoreShows) {
            console.log(`Returning ${metas.length} shows out of ${filteredShows.length} total. The rest will be processed in the background.`);
        }

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'public, s-maxage=900, stale-while-revalidate=300');
        res.status(200).json({ metas });
        
        // Start processing the queue after response is sent
        setTimeout(processMetadataQueue, 100);
    } catch (err) {
        console.error('Catalog endpoint error:', err);
        res.status(500).json({ metas: [], error: 'Failed to process catalog request' });
    }
});

app.get('/meta/:type/:id.json', async (req, res) => {
    try {
        const { type, id } = req.params;
        // Directly implement the meta handler logic
        if (type !== 'series' || !id.startsWith('mako:')) {
            return res.status(404).json({ meta: null, error: 'Meta not found.' });
        }

        let showUrl;
        try {
            showUrl = decodeURIComponent(id.replace('mako:', ''));
            if (!showUrl.startsWith(BASE_URL)) throw new Error('Invalid base URL');
        } catch (e) {
            console.error('Invalid show URL derived from meta ID:', id);
            return res.status(400).json({ meta: null, error: 'Invalid show URL in ID' });
        }

        // Get metadata for the show (will use cache if available)
        const showDetails = await getMetadata(showUrl);
        
        // Queue background fetch for episodes
        queueMetadataFetch(showUrl, 2); // High priority
        
        // Get seasons first
        const seasons = await extractContent(showUrl, 'seasons');
        let allSeasons = [];
        
        if (seasons && seasons.length > 0) {
            console.log(`Found ${seasons.length} seasons for ${showUrl}`);
            
            // Add main (root) URL as Season 1 if we have multiple seasons
            allSeasons = [
                { name: "Season 1", url: showUrl, seasonNum: 1 },
                ...seasons.map((season, index) => ({
                    ...season,
                    seasonNum: index + 2 // Start from 2 since main URL is season 1
                }))
            ];
        } else {
            // No seasons found, just use the main URL as the only season
            allSeasons = [{ name: "Season 1", url: showUrl, seasonNum: 1 }];
        }
        
        // Process episodes for all seasons
        const allEpisodes = [];
        
        // In serverless, limit to first 2 seasons to avoid timeouts
        const seasonsToProcess = IS_SERVERLESS ? allSeasons.slice(0, 2) : allSeasons;
        
        for (const season of seasonsToProcess) {
            console.log(`Processing season ${season.seasonNum}: ${season.name}`);
            
            const episodes = await extractContent(season.url, 'episodes');
            if (episodes && episodes.length > 0) {
                // Add season and episode numbers
                const seasonEpisodes = episodes.map((ep, idx) => ({
                    ...ep,
                    seasonNum: season.seasonNum,
                    episodeNum: idx + 1
                }));
                
                allEpisodes.push(...seasonEpisodes);
                console.log(`Added ${seasonEpisodes.length} episodes from season ${season.seasonNum}`);
            } else {
                console.log(`No episodes found for season ${season.seasonNum}`);
            }
            
            // Add a small delay between season processing
            await sleep(200);
        }
        
        // If we limited seasons due to serverless, log that info
        if (IS_SERVERLESS && allSeasons.length > 2) {
            console.log(`Note: Only processed ${seasonsToProcess.length} of ${allSeasons.length} seasons due to serverless environment limitations`);
        }
        
        // Sort episodes by season and episode number
        allEpisodes.sort((a, b) => {
            if (a.seasonNum !== b.seasonNum) return a.seasonNum - b.seasonNum;
            return a.episodeNum - b.episodeNum;
        });
        
        console.log(`Total episodes found: ${allEpisodes.length}`);
        
        // Organize episodes into videos for Stremio
        const videos = allEpisodes.map(ep => ({
            id: `${id}:ep:${ep.guid}`,
            title: ep.name || `S${ep.seasonNum}E${ep.episodeNum}`,
            season: ep.seasonNum,
            episode: ep.episodeNum,
            released: null,
        }));

        const result = {
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

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=1800');
        res.status(200).json(result);
    } catch (err) {
        console.error('Meta endpoint error:', err);
        res.status(500).json({ meta: null, error: 'Failed to process meta request' });
    }
});

app.get('/stream/:type/:id.json', async (req, res) => {
    try {
        const { type, id } = req.params;
        // Directly implement the stream handler logic
        if (type !== 'series' || !id.startsWith('mako:')) {
            return res.status(404).json({ streams: [], error: 'Stream not found.' });
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

        console.log(`Looking for episode with GUID: ${episodeGuid} from show: ${showUrl}`);
        
        // Find target episode
        let targetEpisode = null;
        
        // First get all seasons
        const seasons = await extractContent(showUrl, 'seasons');
        let allSeasons = [];
        
        if (seasons && seasons.length > 0) {
            // Add main URL as Season 1
            allSeasons = [
                { name: "Season 1", url: showUrl },
                ...seasons
            ];
        } else {
            // No seasons found, just use the main URL
            allSeasons = [{ name: "Season 1", url: showUrl }];
        }
        
        // Search through each season for the episode
        for (const season of allSeasons) {
            console.log(`Searching for episode in ${season.name}: ${season.url}`);
            const episodes = await extractContent(season.url, 'episodes');
            
            if (episodes && episodes.length > 0) {
                const found = episodes.find(ep => ep.guid === episodeGuid);
                if (found) {
                    targetEpisode = found;
                    console.log(`Found episode in ${season.name}: ${found.name}`);
                    break;
                }
            }
            
            // Don't sleep after the last season
            if (season !== allSeasons[allSeasons.length - 1]) {
                await sleep(200);
            }
        }

        if (!targetEpisode || !targetEpisode.url) {
            console.error(`Stream handler: Could not find episode URL for GUID ${episodeGuid} in show ${showUrl}`);
            return res.status(404).json({ streams: [], error: 'Episode GUID not found' });
        }

        const videoUrl = await getVideoUrl(targetEpisode.url);
        if (!videoUrl) {
            console.error(`Stream handler: getVideoUrl failed for ${targetEpisode.url}`);
            return res.status(500).json({ streams: [], error: 'Failed to retrieve video stream URL' });
        }

        const result = {
            streams: [{
                url: videoUrl,
                title: `Play: ${targetEpisode.name || 'Episode'}`,
                type: 'hls',
                behaviorHints: {
                    bingeGroup: `mako-${showUrl}`,
                }
            }]
        };

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store, max-age=0');
        res.status(200).json(result);
    } catch (err) {
        console.error(`Stream endpoint error:`, err);
        res.status(500).json({ streams: [], error: 'Failed to process stream request' });
    }
});

// Handle other requests (404)
app.use((req, res) => {
    console.warn('Unknown request (404):', req.method, req.url);
    res.status(404).json({ error: 'Not Found' });
});

// Export the app for serverless platforms
module.exports = app;

// --- Local Development Server ---
// Only start the server if not running in a serverless environment
if (!IS_SERVERLESS) {
    const PORT = process.env.PORT || 8000;
    app.listen(PORT, () => {
        console.log(`\n--- LOCAL DEVELOPMENT SERVER ---`);
        console.log(`Mako VOD Stremio Add-on running at:`);
        console.log(`Manifest: http://127.0.0.1:${PORT}/manifest.json`);
        console.log(`Install Link: stremio://127.0.0.1:${PORT}/manifest.json`);
        console.log(`---------------------------------\n`);
    });
}