const fs = require('fs');
const path = require('path');

// Create special output directories for Vercel
const outputDir = path.join(process.cwd(), '.vercel/output/static');
const precachedOutputDir = path.join(outputDir, 'precached');

// Make sure the output directories exist
try {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  if (!fs.existsSync(precachedOutputDir)) {
    fs.mkdirSync(precachedOutputDir, { recursive: true });
  }
  
  // Source of the precached data
  const precachedDir = path.join(process.cwd(), 'precached');
  
  if (fs.existsSync(precachedDir)) {
    // Copy the metadata.json file
    const sourceMetadataFile = path.join(precachedDir, 'metadata.json');
    const destMetadataFile = path.join(precachedOutputDir, 'metadata.json');
    
    if (fs.existsSync(sourceMetadataFile)) {
      fs.copyFileSync(sourceMetadataFile, destMetadataFile);
      console.log(`Copied ${sourceMetadataFile} to ${destMetadataFile}`);
    } else {
      console.error(`Source metadata file not found: ${sourceMetadataFile}`);
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
    
    console.log('Precached files prepared for Vercel deployment');
  } else {
    console.error(`Precached directory not found: ${precachedDir}`);
  }
} catch (error) {
  console.error('Error preparing files for Vercel:', error);
  process.exit(1);
} 