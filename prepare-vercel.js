const fs = require('fs');
const path = require('path');
const { put, list, del } = require('@vercel/blob');
const crypto = require('crypto');

// Constants
const BLOB_METADATA_KEY_PREFIX = 'mako-shows-metadata-v1';
const MAX_BLOB_FILES_TO_KEEP = 2;

async function preparePrecachedData() {
  console.log('Starting Vercel build preparation...');
  
  try {
    // Source of the precached data
    const precachedDir = path.join(process.cwd(), 'precached');
    const sourceMetadataFile = path.join(precachedDir, 'metadata.json');
    
    // Create static output directory for Vercel
    const outputDir = path.join(process.cwd(), '.vercel/output/static');
    const precachedOutputDir = path.join(outputDir, 'precached');
    
    // Make sure the output directories exist
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    if (!fs.existsSync(precachedOutputDir)) {
      fs.mkdirSync(precachedOutputDir, { recursive: true });
    }
    
    // Copy to static output directory (for direct access)
    if (fs.existsSync(precachedDir)) {
      // Copy the metadata.json file
      if (fs.existsSync(sourceMetadataFile)) {
        const destMetadataFile = path.join(precachedOutputDir, 'metadata.json');
        fs.copyFileSync(sourceMetadataFile, destMetadataFile);
        console.log(`Copied ${sourceMetadataFile} to ${destMetadataFile} for static access`);
      } else {
        console.error(`Source metadata file not found: ${sourceMetadataFile}`);
        return;
      }
      
      // Copy any other files that might be in the precached directory
      const files = fs.readdirSync(precachedDir);
      for (const file of files) {
        if (file !== 'metadata.json') {
          const sourcePath = path.join(precachedDir, file);
          const destPath = path.join(precachedOutputDir, file);
          fs.copyFileSync(sourcePath, destPath);
          console.log(`Copied ${sourcePath} to ${destPath}`);
        }
      }
      
      console.log('Precached files prepared for static access');
    } else {
      console.error(`Precached directory not found: ${precachedDir}`);
      return;
    }
    
    // Now handle the blob storage
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      console.log('No BLOB_READ_WRITE_TOKEN found in environment. Skipping blob storage operations.');
      return;
    }
    
    console.log('Starting blob storage operations...');
    
    // Calculate hash of the current metadata file
    const metadataContent = fs.readFileSync(sourceMetadataFile, 'utf8');
    const currentHash = crypto.createHash('md5').update(metadataContent).digest('hex');
    console.log(`Current metadata file hash: ${currentHash}`);
    
    // Get the list of existing blobs
    const { blobs } = await list({ prefix: BLOB_METADATA_KEY_PREFIX });
    console.log(`Found ${blobs.length} existing metadata blobs`);
    
    // Check if we need to upload the new metadata
    let needsUpload = true;
    
    if (blobs && blobs.length > 0) {
      // Sort blobs by uploadedAt (newest first)
      const validBlobs = blobs.filter(b => b.uploadedAt);
      validBlobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
      
      if (validBlobs.length > 0) {
        try {
          // Download the most recent blob
          const latestBlob = validBlobs[0];
          console.log(`Checking latest blob: ${latestBlob.url}`);
          
          // Extract hash from the blob pathname
          const blobHashMatch = latestBlob.pathname.match(/-([a-f0-9]{32})\./i);
          const blobHash = blobHashMatch ? blobHashMatch[1] : null;
          
          if (blobHash && blobHash === currentHash) {
            console.log('Metadata file unchanged. No need to upload to blob storage.');
            needsUpload = false;
          } else {
            console.log(`Metadata file has changed. Current: ${currentHash}, Latest blob: ${blobHash || 'unknown'}`);
          }
        } catch (latestBlobError) {
          console.error(`Error checking latest blob: ${latestBlobError.message}`);
        }
      }
    }
    
    // Upload if needed
    if (needsUpload) {
      console.log('Uploading metadata to blob storage...');
      const uniquePathname = `${BLOB_METADATA_KEY_PREFIX}-${Date.now()}-${currentHash}.json`;
      
      const { url } = await put(uniquePathname, metadataContent, {
        access: 'public',
        contentType: 'application/json',
        addRandomSuffix: false
      });
      
      console.log(`Uploaded metadata to blob storage: ${url}`);
      
      // Cleanup old files if needed
      if (blobs.length >= MAX_BLOB_FILES_TO_KEEP) {
        console.log('Cleaning up old blob files...');
        const sortedBlobs = blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
        const blobsToDelete = sortedBlobs.slice(MAX_BLOB_FILES_TO_KEEP - 1);
        
        for (const oldBlob of blobsToDelete) {
          await del(oldBlob.url);
          console.log(`Deleted old blob: ${oldBlob.url}`);
        }
      }
    }
    
    console.log('Vercel build preparation completed successfully');
  } catch (error) {
    console.error('Error during Vercel build preparation:', error);
    process.exit(1);
  }
}

// Execute the preparation
preparePrecachedData(); 