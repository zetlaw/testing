// index.js
const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
// Use the external crypto.js module
const { CRYPTO, cryptoOp } = require('./crypto');

// Constants
const BASE_URL = "https://www.mako.co.il";
const CACHE_FILE = path.join(__dirname, "mako_shows_cache.json");
const CACHE_TTL = 30 * 24 * 60 * 60; // 30 days in seconds
const DELAY_BETWEEN_REQUESTS = 1000; // 1 second in milliseconds
const MAX_RETRIES = 3;
const REQUEST_TIMEOUT = 10000;

// Headers for requests
const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,he;q=0.8',
    'Referer': 'https://www.mako.co.il/mako-vod-index',
    'Connection': 'keep-alive'
};

// Cache management (remains the same)
// ... loadCache, saveCache ...

const loadCache = () => {
    try {
        if (fs.existsSync(CACHE_FILE)) {
            return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
        }
        return { timestamp: Date.now(), shows: {} };
    } catch (e) {
        console.error("Error loading cache:", e);
        return { timestamp: Date.now(), shows: {} };
    }
};

const saveCache = (cache) => {
    try {
        const cacheDir = path.dirname(CACHE_FILE);
        if (!fs.existsSync(cacheDir)) {
            fs.mkdirSync(cacheDir, { recursive: true });
        }
        fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
        console.log("Cache saved successfully");
    } catch (e) {
        console.error("Error saving cache:", e);
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


// Show name extraction (remains the same)
// ... extractShowName ...
const extractShowName = async (url) => {
    try {
        const response = await axios.get(url, {
            headers: HEADERS,
            timeout: REQUEST_TIMEOUT,
            maxRedirects: 5
        });
        const $ = cheerio.load(response.data);
        const jsonldTag = $('script[type="application/ld+json"]').html();

        if (!jsonldTag) return null;

        const data = JSON.parse(jsonldTag);

        let name;
        if (data['@type'] === 'TVSeason' && data.partOfTVSeries) {
            name = data.partOfTVSeries.name;
            // console.log(`Found TVSeason, using series name from partOfTVSeries: ${name}`);
        } else {
            name = data.name;
        }

        // console.log(`Raw name found in JSON: ${name}`);

        if (data.containsSeason && Array.isArray(data.containsSeason) && data.containsSeason.length > 1) {
             name = `${name} (${data.containsSeason.length} עונות)`;
        }

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

        return { name, poster, background };
    } catch (e) {
        console.error(`Error extracting show name from ${url}:`, e.message);
        return null;
    }
};

// Process show names (remains the same)
// ... processShowNames ...
const processShowNames = async (shows, cache, cacheIsFresh, maxShows = null) => {
    let updatesCount = 0;
    let processedCount = 0;

    const showsToProcess = maxShows && maxShows < shows.length ? shows.slice(0, maxShows) : shows;
    const total = showsToProcess.length;
    console.log(`Processing ${total} shows in background...`);

    const BATCH_SIZE = 5;
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

                const details = await extractShowName(url);
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
            }
        });

        await Promise.all(batchPromises);

        if (processedCount % 20 === 0 || processedCount === total) {
             console.log(`Background progress: ${processedCount}/${total} shows processed (${(processedCount/total*100).toFixed(1)}%)`);
        }

        if (updatesCount > 0) {
            cache.timestamp = Date.now();
            saveCache(cache);
            updatesCount = 0; // Reset after save
        }
        await sleep(100); // Small delay between batches
    }
    // Final save if any pending updates
    if (updatesCount > 0) {
         cache.timestamp = Date.now();
         saveCache(cache);
    }
};

// Content extraction (remains the same)
// ... extractContent ...
const extractContent = async (url, contentType) => {
    try {
        await sleep(DELAY_BETWEEN_REQUESTS);
        const response = await axios.get(url, { headers: HEADERS, timeout: REQUEST_TIMEOUT });
        const $ = cheerio.load(response.data);

        const configs = {
             shows: {
                selectors: [
                    'li > a[href^="/mako-vod-"]',
                    'li a[href^="/mako-vod-"]',
                    '.vod_item a[href^="/mako-vod-"]',
                    '.vod_item_wrap a[href^="/mako-vod-"]'
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
            if (elements.length) break;
        }

        // console.log(`Found ${elements.length} ${contentType} elements`);

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
             if ((contentType === 'shows' && item.url) ||
                (contentType === 'seasons' && item.url && item.name) ||
                (contentType === 'episodes' && item.url))
             {
                const key = item.guid || item.url;
                if (key && !seen.has(key)) {
                    if (contentType === 'shows') {
                        item.name = item.tempName || 'Unknown Show';
                        delete item.tempName;
                        item.poster = processImageUrl(item.poster);
                         if (item.poster && item.poster.includes('_next/static')) {
                            item.poster = 'https://www.mako.co.il/assets/images/svg/mako_logo.svg';
                         }
                    }
                    items.push(item);
                    seen.add(key);
                }
            }
        }

        if (contentType === 'episodes') {
            for (const ep of items) {
                if (!ep.guid && ep.url) {
                    const match = ep.url.match(/[?&](guid|videoGuid)=([\w-]+)/i);
                    if (match) ep.guid = match[2];
                }
            }
            return items.filter(ep => ep.guid); // Only return episodes with GUID
        }

        if (contentType === 'shows') {
            const cache = loadCache();
            const cacheIsFresh = Date.now() - cache.timestamp < CACHE_TTL;

            console.log("\nLoading accurate show names...");

            let cachedCount = 0;
            if (cacheIsFresh) {
                for (const show of items) {
                    if (cache.shows[show.url]) {
                        show.name = cache.shows[show.url].name;
                        show.poster = cache.shows[show.url].poster || show.poster; // Prefer cached poster if available
                        show.background = cache.shows[show.url].background || show.poster; // Use cached bg or poster
                        cachedCount++;
                    } else {
                         // Ensure defaults if not in cache
                         show.poster = show.poster || 'https://www.mako.co.il/assets/images/svg/mako_logo.svg';
                         show.background = show.poster;
                    }
                }
            } else {
                 // Ensure defaults if cache is stale
                 for (const show of items) {
                     show.poster = show.poster || 'https://www.mako.co.il/assets/images/svg/mako_logo.svg';
                     show.background = show.poster;
                 }
            }


            if (cachedCount) console.log(`Using ${cachedCount} show details from fresh cache`);

            const toFetch = items.filter(show => !(cacheIsFresh && cache.shows[show.url]));
            if (toFetch.length === 0 && cacheIsFresh) {
                console.log("All show names already in fresh cache!");
            } else {
                console.log(`Need to fetch/update ${toFetch.length} show names`);
                // Start background processing without await
                 processShowNames(toFetch, cache, cacheIsFresh).catch(err => console.error("Background show name processing failed:", err));
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
         const cache = loadCache();
         const cachedShowData = cache.shows[showUrl];
         let showName = cachedShowData?.name || 'Loading...';
         let showPoster = cachedShowData?.poster || 'https://www.mako.co.il/assets/images/svg/mako_logo.svg';
         let showBackground = cachedShowData?.background || showPoster;

         // If not cached, fetch basic details (extractContent does this)
         if (!cachedShowData) {
             const showDetails = await extractShowName(showUrl); // Fetch specific show details if needed
             if(showDetails) {
                 showName = showDetails.name;
                 showPoster = showDetails.poster;
                 showBackground = showDetails.background;
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
        
        // Call the handler we defined with defineCatalogHandler but directly
        const handlerResult = await addonInterface.get({ 
            resource: 'catalog', 
            type, 
            id, 
            extra 
        });
        
        res.setHeader('Content-Type', 'application/json');
        res.send(handlerResult);
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
        
        // Call the handler we defined with defineMetaHandler but directly
        const handlerResult = await addonInterface.get({ 
            resource: 'meta', 
            type, 
            id 
        });
        
        res.setHeader('Content-Type', 'application/json');
        res.send(handlerResult);
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
        
        // Call the handler we defined with defineStreamHandler but directly
        const handlerResult = await addonInterface.get({ 
            resource: 'stream', 
            type, 
            id 
        });
        
        res.setHeader('Content-Type', 'application/json');
        res.send(handlerResult);
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