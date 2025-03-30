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
const BATCH_SIZE = 50;
const PRECACHED_DIR = 'precached';
const PRECACHED_METADATA_FILE = `${PRECACHED_DIR}/metadata.json`;

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
        let nameSource = "unknown";

        // Try JSON-LD - This is our primary source of information
        try {
            // First try methods that might extract the data
            let jsonldData = null;
            const jsonldScripts = $('script[type="application/ld+json"]');
            
            if (jsonldScripts.length > 0) {
                // First approach: using children[0].data (most reliable)
                try {
                    if (jsonldScripts[0].children && jsonldScripts[0].children.length > 0) {
                        jsonldData = JSON.parse(jsonldScripts[0].children[0].data);
                    }
                } catch (e) {
                    console.log(`Failed with children approach: ${e.message}`);
                }
                
                // Second approach: using .html() if first approach failed
                if (!jsonldData) {
                    try {
                        const jsonldHtml = jsonldScripts.html();
                        if (jsonldHtml) {
                            jsonldData = JSON.parse(jsonldHtml);
                        }
                    } catch (e) {
                        console.log(`Failed with html approach: ${e.message}`);
                    }
                }
                
                // If both failed, try each script element
                if (!jsonldData) {
                    for (let i = 0; i < jsonldScripts.length; i++) {
                        try {
                            const content = $(jsonldScripts[i]).html();
                            if (content) {
                                jsonldData = JSON.parse(content);
                                break;
                            }
                        } catch (e) {
                            continue;
                        }
                    }
                }
            }
            
            if (jsonldData) {
                // IMPORTANT: Use case-insensitive type checking
                const type = jsonldData['@type'] && jsonldData['@type'].toLowerCase();
                
                // Check for TVSeries (case insensitive)
                if (type === 'tvseries' || type === 'series' || type === 'videoobject') {
                    name = jsonldData.name;
                    nameSource = "json-ld";
                    description = jsonldData.description || description;
                    
                    if (jsonldData.image) {
                        poster = Array.isArray(jsonldData.image) ? jsonldData.image[0] : jsonldData.image;
                    }
                    
                    if (jsonldData.containsSeason && Array.isArray(jsonldData.containsSeason)) {
                        seasons = jsonldData.containsSeason;
                    }
                } 
                // If it points to a TV series
                else if (jsonldData.partOfTVSeries) {
                    const series = jsonldData.partOfTVSeries;
                    name = series.name;
                    nameSource = "json-ld";
                    description = series.description || description;
                    
                    if (series.image) {
                        poster = Array.isArray(series.image) ? series.image[0] : series.image;
                    }
                    
                    if (series.containsSeason && Array.isArray(series.containsSeason)) {
                        seasons = series.containsSeason;
                    }
                }
                // If it's a TVSeason (case insensitive)
                else if (type === 'tvseason') {
                    name = jsonldData.name;
                    nameSource = "json-ld";
                    description = jsonldData.description || description;
                    
                    if (jsonldData.image) {
                        poster = Array.isArray(jsonldData.image) ? jsonldData.image[0] : jsonldData.image;
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
    console.log('Starting metadata download process...');
    
    try {
        // Create the precached directory if it doesn't exist
        if (!fs.existsSync(PRECACHED_DIR)) {
            fs.mkdirSync(PRECACHED_DIR, { recursive: true });
        }
        
        // Fetch the show list
        console.log('Fetching show list from index page...');
        const showList = await extractContent(`${BASE_URL}/mako-vod-index`, 'shows');
        console.log(`Found ${showList.length} shows.`);
        
        // Metadata cache - the complete precached data
        const metadata = {};
        let completedShows = 0;
        let nameSourceStats = {
            'json-ld': 0,
            'html': 0,
            'error': 0,
            'unknown': 0
        };
        
        // Fetch metadata for each show
        console.log('Fetching metadata for each show...');
        
        // Process shows in batches to avoid memory issues
        const batchSize = 20;
        for (let i = 0; i < showList.length; i += batchSize) {
            const batch = showList.slice(i, i + batchSize);
            console.log(`Fetching metadata for batch ${i+1}-${Math.min(i+batchSize, showList.length)}/${showList.length}`);
            
            // Create promise for each show in the batch
            const promises = batch.map(async (show, index) => {
                // Use the show's URL property, not the show object itself
                const url = show.url;
                console.log(`Fetching metadata for ${url} (${i+index+1}-${Math.min(i+batchSize, showList.length)}/${showList.length})`);
                try {
                    const showMetadata = await extractShowNameAndImages(url);
                    
                    // Add to statistics
                    if (showMetadata.nameSource) {
                        nameSourceStats[showMetadata.nameSource] = (nameSourceStats[showMetadata.nameSource] || 0) + 1;
                    } else {
                        nameSourceStats['unknown'] = (nameSourceStats['unknown'] || 0) + 1;
                    }
                    
                    // Store in metadata object with URL as key
                    metadata[url] = {
                        ...showMetadata,
                        lastUpdated: Date.now()
                    };
                    
                    completedShows++;
                    console.log(`✓ Successfully fetched metadata for: ${showMetadata.name} [Source: ${showMetadata.nameSource}]`);
                    return showMetadata;
                } catch (error) {
                    console.error(`Failed to fetch metadata for ${url}:`, error.message);
                    nameSourceStats['error'] = (nameSourceStats['error'] || 0) + 1;
                    return null;
                }
            });
            
            // Wait for all promises in the batch
            await Promise.all(promises);
            
            // Log progress after each batch
            console.log(`Progress: ${Math.min(i + batchSize, showList.length)}/${showList.length} (${Math.floor((Math.min(i + batchSize, showList.length) / showList.length) * 100)}%)`);
            console.log(`Name sources so far: JSON-LD: ${nameSourceStats['json-ld']}, HTML: ${nameSourceStats['html']}, Errors: ${nameSourceStats['error']}, Unknown: ${nameSourceStats['unknown']}`);
            
            // Save progress after each batch
            fs.writeFileSync(PRECACHED_METADATA_FILE, JSON.stringify(metadata, null, 2));
            
            // Wait a bit before the next batch to avoid rate limiting
            if (i + batchSize < showList.length) {
                console.log('Waiting before next batch...');
                await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_REQUESTS_MS));
            }
        }
        
        console.log('\nDownload complete! Metadata saved for', completedShows + '/' + showList.length, 'shows.');
        console.log('Name extraction statistics:');
        console.log(`- JSON-LD: ${nameSourceStats['json-ld']} (${Math.floor((nameSourceStats['json-ld'] / showList.length) * 100)}%)`);
        console.log(`- HTML fallback: ${nameSourceStats['html']} (${Math.floor((nameSourceStats['html'] / showList.length) * 100)}%)`);
        console.log(`- Errors: ${nameSourceStats['error']} (${Math.floor((nameSourceStats['error'] / showList.length) * 100)}%)`);
        console.log(`- Unknown: ${nameSourceStats['unknown']} (${Math.floor((nameSourceStats['unknown'] / showList.length) * 100)}%)`);
        console.log(`Metadata file: ${PRECACHED_METADATA_FILE}`);
        
    } catch (error) {
        console.error('Error in main process:', error.message);
    }
}

main().catch(err => {
    console.error("An error occurred:", err);
    process.exit(1);
}); 