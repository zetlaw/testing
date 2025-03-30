// test-extraction.js
const axios = require('axios');
const cheerio = require('cheerio');

// Test URLs
const urls = [
  'https://www.mako.co.il/mako-vod-keshet/nesli_and_yoav',
  'https://www.mako.co.il/mako-vod-keshet/design-ltd',    // This one had JSON-LD in the output
  'https://www.mako.co.il/mako-vod-bip/metumtam'          // Try another one
];

// Copy of the extractShowNameAndImages function with our updated JSON-LD extraction
async function extractShowNameAndImages(url) {
    try {
        const response = await axios.get(url, { 
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9,he;q=0.8',
                'Referer': 'https://www.mako.co.il/mako-vod-index',
                'Connection': 'keep-alive'
            }, 
            timeout: 10000 
        });
        
        const $ = cheerio.load(response.data);
        let name = null;
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
                        console.log("Extracted using children[0].data approach");
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
                            console.log("Extracted using .html() approach");
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
                                console.log(`Extracted from script index ${i}`);
                                break;
                            }
                        } catch (e) {
                            console.log(`Failed parsing script at index ${i}: ${e.message}`);
                        }
                    }
                }
            }
            
            if (jsonldData) {
                console.log("JSON-LD Data:", JSON.stringify(jsonldData).substring(0, 100) + "...");
                console.log("Type:", jsonldData['@type']);
                
                // IMPORTANT: Use case-insensitive type checking
                const type = jsonldData['@type'] && jsonldData['@type'].toLowerCase();
                console.log("Lowercase type:", type);
                
                // Check for TVSeries (case insensitive)
                if (type === 'tvseries' || type === 'series' || type === 'videoobject') {
                    name = jsonldData.name;
                    nameSource = "json-ld";
                    description = jsonldData.description || description;
                    
                    if (jsonldData.image) {
                        const poster = Array.isArray(jsonldData.image) ? jsonldData.image[0] : jsonldData.image;
                        console.log("Found poster:", poster);
                    }
                    
                    if (jsonldData.containsSeason && Array.isArray(jsonldData.containsSeason)) {
                        seasons = jsonldData.containsSeason;
                        console.log(`Found ${seasons.length} seasons`);
                    }
                    
                    console.log("MATCHED as tvseries");
                } 
                // If it points to a TV series
                else if (jsonldData.partOfTVSeries) {
                    const series = jsonldData.partOfTVSeries;
                    name = series.name;
                    nameSource = "json-ld";
                    description = series.description || description;
                    
                    if (series.image) {
                        const poster = Array.isArray(series.image) ? series.image[0] : series.image;
                        console.log("Found poster:", poster);
                    }
                    
                    if (series.containsSeason && Array.isArray(series.containsSeason)) {
                        seasons = series.containsSeason;
                        console.log(`Found ${seasons.length} seasons`);
                    }
                    
                    console.log("MATCHED as partOfTVSeries");
                }
                // If it's a TVSeason (case insensitive)
                else if (type === 'tvseason') {
                    name = jsonldData.name;
                    nameSource = "json-ld";
                    description = jsonldData.description || description;
                    
                    if (jsonldData.image) {
                        const poster = Array.isArray(jsonldData.image) ? jsonldData.image[0] : jsonldData.image;
                        console.log("Found poster:", poster);
                    }
                    
                    console.log("MATCHED as tvseason");
                } else {
                    console.log("NO MATCH in JSON-LD type checks");
                }

                if (name && name.trim() && seasons && seasons.length > 1) {
                    name = `${name} (${seasons.length} עונות)`;
                }
                
                // Clean up fields
                if (name) name = name.replace(/\s+/g, ' ').trim();
            } else {
                console.log("No JSON-LD data could be extracted");
            }
        } catch (jsonErr) {
            console.warn(`Error parsing JSON-LD: ${jsonErr.message}`);
            name = null;
        }

        // Fallback Meta Tags / H1
        if (!name) {
            const ogTitle = $('meta[property="og:title"]').attr('content');
            const h1Title = $('h1').first().text();
            name = ogTitle || h1Title;
            nameSource = "html";
            if (name) name = name.replace(/\s+/g, ' ').trim();
            console.log("Using HTML fallback:", name);
        }

        if (description === 'מאקו VOD') {
            description = $('meta[property="og:description"]').attr('content') || 
                         $('meta[name="description"]').attr('content') || 
                         description;
            if(description) description = description.replace(/\s+/g, ' ').trim();
        }

        return {
            name: name || 'Unknown Show',
            nameSource: nameSource,
            description: description,
            seasons: Array.isArray(seasons) ? seasons.length : 0
        };
    } catch (e) {
        console.error(`Error extracting show details from ${url}:`, e.message);
        return {
            name: 'Error Loading Show',
            nameSource: "error",
            description: 'Error loading description',
            seasons: 0
        };
    }
}

async function runTest() {
    for (const url of urls) {
        console.log(`\n========== Testing ${url} ==========`);
        const result = await extractShowNameAndImages(url);
        console.log("RESULT:", JSON.stringify(result, null, 2));
    }
}

runTest().catch(err => {
    console.error("Error:", err);
}); 