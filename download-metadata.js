// download-metadata.js
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const { CRYPTO, cryptoOp } = require('./crypto');

// --- Constants ---
const BASE_URL = "https://www.mako.co.il";
const DEFAULT_LOGO = 'https://www.mako.co.il/assets/images/svg/mako_logo.svg';
const DELAY_BETWEEN_REQUESTS_MS = 500;
const REQUEST_TIMEOUT_MS = 10000;
const BATCH_SIZE = 20;

// --- Output Files ---
const OUTPUT_DIR = path.join(__dirname, 'precached');
const METADATA_FILE = path.join(OUTPUT_DIR, 'metadata.json');

// --- Headers ---
const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,he;q=0.8',
    'Referer': `${BASE_URL}/mako-vod-index`,
    'Connection': 'keep-alive'
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
    try {
        const response = await axios.get(url, { headers: HEADERS, timeout: REQUEST_TIMEOUT_MS });
        const $ = cheerio.load(response.data);
        let name = null;
        let poster = null;
        let background = null;
        let description = 'מאקו VOD';
        let seasons = [];

        // Try JSON-LD - This is our primary source of information
        try {
            const jsonldTag = $('script[type="application/ld+json"]').html();
            if (jsonldTag) {
                const data = JSON.parse(jsonldTag);
                
                // Check if it's a TVSeries directly
                if (data['@type'] === 'TVSeries') {
                    name = data.name; // Directly use name from JSON-LD
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
            seasons: seasons.length
        };
    } catch (e) {
        console.error(`Error extracting show details from ${url}:`, e.message);
        return {
            name: 'Error Loading Show',
            poster: DEFAULT_LOGO,
            background: DEFAULT_LOGO,
            description: 'Error loading description',
            seasons: 0
        };
    }
};

const extractContent = async (url, contentType) => {
    try {
        await sleep(DELAY_BETWEEN_REQUESTS_MS);
        const response = await axios.get(url, {
            headers: HEADERS,
            timeout: REQUEST_TIMEOUT_MS
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
                        { selector: '.title strong' }, { selector: 'h3.title' }, { selector: 'h2.title' },
                        { selector: '.vod-title' }, { selector: '.caption' },
                        { selector: 'img', attribute: 'alt' },
                        { text: true }
                    ],
                    poster: { selector: 'img', attribute: 'src' }
                },
                base: BASE_URL,
                filter: (item) => item.url && !item.url.includes('/purchase') && !item.url.includes('/index') && !item.url.match(/live/i)
            }
        };

        const config = configs[contentType];
        const items = [];
        const seenUrlsOrGuids = new Set();
        const addedHrefs = new Set();

        let combinedElements = [];
        for (const selector of config.selectors) {
            try {
                $(selector).each((_, elem) => {
                    const $elem = $(elem);
                    const href = $elem.attr('href');
                    const uniqueKey = href;

                    if (uniqueKey && !addedHrefs.has(uniqueKey)) {
                        combinedElements.push(elem);
                        addedHrefs.add(uniqueKey);
                    }
                });
            } catch (selectorError) {
                console.warn(`Selector "${selector}" failed on ${url}: ${selectorError.message}`);
            }
        }

        if (combinedElements.length === 0) {
            console.warn(`No elements found for ${contentType} at ${url}`);
            return [];
        }

        for (const elem of combinedElements) {
            const item = {};
            const $elem = $(elem);

            for (const [field, fieldConfig] of Object.entries(config.fields)) {
                if (Array.isArray(fieldConfig)) {
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
                    } catch (fieldErr) { continue; }
                }
            }

            let uniqueKey = null;
            if (!item.url) continue;
            uniqueKey = item.url;
            if (contentType === 'shows') {
                item.name = item.name || 'Unknown Show';
                item.poster = getValidImage(item.poster);
            }

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

// --- Main Function ---
async function main() {
    console.log("Starting metadata download process...");
    
    // Create output directory if it doesn't exist
    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }
    
    // Step 1: Get all shows
    console.log("Fetching show list from index page...");
    const initialShows = await extractContent(`${BASE_URL}/mako-vod-index`, 'shows');
    console.log(`Found ${initialShows.length} shows.`);
    
    // Step 2: Get metadata for each show
    console.log("Fetching metadata for each show...");
    const metadataCache = {
        timestamp: Date.now(),
        metadata: {},
        seasons: {},
        shows: {}  // Include shows data within the metadata file
    };
    
    let completedShows = 0;
    const totalShows = initialShows.length;
    
    for (let i = 0; i < initialShows.length; i += BATCH_SIZE) {
        const batch = initialShows.slice(i, i + BATCH_SIZE);
        const batchPromises = batch.map(async (show) => {
            if (!show.url) return null;
            
            console.log(`Fetching metadata for ${show.url} (${i+1}-${Math.min(i+BATCH_SIZE, totalShows)}/${totalShows})`);
            const details = await extractShowNameAndImages(show.url);
            
            if (details.name !== 'Error Loading Show' && details.name !== 'Unknown Show') {
                // Store full metadata
                metadataCache.metadata[show.url] = {
                    ...details,
                    lastUpdated: Date.now()
                };
                
                // Also store basic info in shows section for backward compatibility
                metadataCache.shows[show.url] = { 
                    name: details.name, 
                    poster: details.poster 
                };
                
                console.log(`✓ Successfully fetched metadata for: ${details.name}`);
                return true;
            } else {
                console.warn(`✗ Failed to fetch metadata for: ${show.url}`);
                return false;
            }
        });
        
        const batchResults = await Promise.all(batchPromises);
        completedShows += batchResults.filter(Boolean).length;
        
        // Save progress after each batch
        fs.writeFileSync(METADATA_FILE, JSON.stringify(metadataCache, null, 2), 'utf8');
        console.log(`Progress: ${completedShows}/${totalShows} (${Math.round(completedShows/totalShows*100)}%)`);
        
        if (i + BATCH_SIZE < initialShows.length) {
            // Add a delay between batches to avoid hammering the server
            console.log("Waiting before next batch...");
            await sleep(1000);
        }
    }
    
    // Final save
    fs.writeFileSync(METADATA_FILE, JSON.stringify(metadataCache, null, 2), 'utf8');
    console.log(`\nDownload complete! Metadata saved for ${completedShows}/${totalShows} shows.`);
    console.log(`Metadata file: ${METADATA_FILE}`);
}

main().catch(err => {
    console.error("An error occurred:", err);
    process.exit(1);
}); 