# Mako VOD Stremio Addon

This addon allows you to watch VOD content from Mako (Israeli TV) on Stremio.

## Features

- Browse and stream shows from Mako VOD
- Search functionality
- Metadata caching for improved performance
- Episode streaming with HLS support

## Pre-caching Metadata

To avoid timeouts when running the addon on Vercel, you can pre-cache all show metadata locally:

1. Run the metadata downloader script:
   ```
   node download-metadata.js
   ```

2. This will create a `precached` directory containing a `metadata.json` file with all show information.

3. Deploy the addon to Vercel, ensuring the `precached` directory is included in your deployment.

The addon will automatically load the pre-cached data if available, which will significantly improve performance and prevent timeouts.

## Development

To run the addon locally:

```
npm install
npm start
```

The addon will be available at `http://localhost:8000/manifest.json`

## Deployment

This addon is designed to work on Vercel, utilizing Vercel Blob Storage for caching when running in production.

## License

MIT 