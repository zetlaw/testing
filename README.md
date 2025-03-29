# Mako VOD Stremio Addon

A Stremio addon that provides access to Mako VOD content (Israeli TV).

## Features

- Browse Mako VOD shows catalog
- Search shows
- Watch episodes with multiple stream options
- Support for HLS and MP4 streams
- External player support

## Installation

### Local Development

1. Make sure you have Node.js installed (version 18 or higher)
2. Clone this repository or download the source code
3. Install dependencies:
   ```bash
   npm install
   ```
4. Start the addon:
   ```bash
   npm start
   ```

The addon will start on port 8000 by default. You can change the port by setting the `PORT` environment variable.

### Vercel Deployment

1. Install Vercel CLI (optional):
   ```bash
   npm install -g vercel
   ```

2. Deploy to Vercel:
   ```bash
   vercel
   ```
   Or connect your GitHub repository to Vercel for automatic deployments.

3. After deployment, your addon will be available at:
   ```
   https://your-project-name.vercel.app/manifest.json
   ```

## Adding to Stremio

1. Open Stremio
2. Go to Addons
3. Click "Add Addon"
4. Enter the addon URL:
   - For local development: `http://127.0.0.1:8000/manifest.json`
   - For Vercel deployment: `https://your-project-name.vercel.app/manifest.json`
5. Click "Install"

## Development

The addon is built using:
- Node.js
- Express.js
- Stremio Addon SDK
- Axios for HTTP requests
- Cheerio for HTML parsing
- CryptoJS for encryption/decryption

## License

ISC 