# Mako VOD Stremio Addon

This addon allows watching VOD content from Mako (Israeli TV) in Stremio.

## Features

- Browse and search for shows from Mako VOD
- Watch episodes directly in Stremio
- Optimized performance with pre-cached metadata
- Background metadata fetching for a smoother experience

## Deployment to Vercel

### Setting up Vercel Blob Storage

1. **Sign up for Vercel**: If you haven't already, sign up at [vercel.com](https://vercel.com).

2. **Install Vercel CLI**: Install the Vercel CLI globally:
   ```
   npm install -g vercel
   ```

3. **Set up Blob Storage**:
   - Create a new Vercel project or use an existing one
   - Go to the project settings in the Vercel dashboard
   - Navigate to the "Storage" tab 
   - Click "Create" and select "Blob Storage"
   - Follow the prompts to set up a new Blob store

4. **Get Blob Storage Token**:
   - After creating the Blob store, Vercel will provide a token
   - Copy the token and add it as an environment variable in your Vercel project
   - Set the environment variable name as `BLOB_READ_WRITE_TOKEN`

### Deploying the Addon

1. **Clone this repository**:
   ```
   git clone https://github.com/yourusername/mako-vod-stremio-addon.git
   cd mako-vod-stremio-addon
   ```

2. **Install dependencies**:
   ```
   npm install
   ```

3. **Generate pre-cached metadata**:
   ```
   node download-metadata.js
   ```

4. **Deploy to Vercel**:
   ```
   vercel
   ```

5. **Environment Variables**:
   Make sure to set the following environment variables in your Vercel project:
   - `BLOB_READ_WRITE_TOKEN`: Your Vercel Blob Storage token
   - `NODE_ENV`: Set to `production`

## Local Development

1. **Install dependencies**:
   ```
   npm install
   ```

2. **Generate pre-cached metadata**:
   ```
   node download-metadata.js
   ```

3. **Start the development server**:
   ```
   npm run dev
   ```

4. **Access the addon**:
   - The addon will be available at `http://localhost:8000/manifest.json`
   - To install in Stremio, use: `stremio://localhost:8000/manifest.json`

## How It Works

This addon uses a hybrid caching system to optimize performance:

1. **Pre-cached Metadata**: Metadata for all shows is pre-cached during build time and stored in the Vercel Blob Storage.

2. **Background Fetching**: New metadata is fetched in the background while serving requests.

3. **Serverless Optimization**: The code is optimized for serverless environments, gracefully handling timeouts and memory constraints.

## License

MIT 