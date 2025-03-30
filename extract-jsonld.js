// extract-jsonld.js
const axios = require('axios');
const cheerio = require('cheerio');

const url = 'https://www.mako.co.il/mako-vod-keshet/nesli_and_yoav';

async function extractJsonLd() {
  try {
    console.log(`Fetching URL: ${url}`);
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      }
    });
    
    console.log(`Got response, content length: ${response.data.length}`);
    
    const $ = cheerio.load(response.data);
    
    // Try different approaches
    console.log('Approach 1: Using .html()');
    const jsonldHtml = $('script[type="application/ld+json"]').html();
    console.log('HTML content:', jsonldHtml);
    
    console.log('\nApproach 2: Using [0].children[0].data');
    const scripts = $('script[type="application/ld+json"]');
    if (scripts.length > 0 && scripts[0].children && scripts[0].children.length > 0) {
      console.log('Data content:', scripts[0].children[0].data);
    } else {
      console.log('No children data found');
    }
    
    console.log('\nApproach 3: Using each to iterate');
    $('script[type="application/ld+json"]').each((i, el) => {
      console.log(`Script ${i}:`, $(el).html());
    });
    
    // If there's valid JSON, try to parse it
    if (jsonldHtml) {
      try {
        const jsonData = JSON.parse(jsonldHtml);
        console.log('\nParsed JSON-LD:');
        console.log('Type:', jsonData['@type']);
        console.log('Name:', jsonData.name);
        console.log('Description:', jsonData.description);
        
        // Check for case-insensitive type match
        const typeMatch = jsonData['@type'] && 
                         (jsonData['@type'].toLowerCase() === 'tvseries' || 
                          jsonData['@type'].toLowerCase() === 'tvseason');
                          
        console.log('Type match (case-insensitive):', typeMatch);
      } catch (e) {
        console.error('Error parsing JSON:', e.message);
      }
    }
    
  } catch (error) {
    console.error('Error:', error.message);
  }
}

extractJsonLd(); 