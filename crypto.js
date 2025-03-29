// crypto.js
const crypto = require('crypto');

const CRYPTO_CONFIG = {
    playlist: {
        // Key string (literal ASCII will be used - 24 bytes for AES-192)
        keyString: "LTf7r/zM2VndHwP+4So6bw==",
        // IV string (literal ASCII will be used - 16 bytes)
        ivString: "theExact16Chars="
    },
    entitlement: {
        // Key string (literal ASCII will be used - 24 bytes? Assuming consistency)
        // NOTE: 'YhnU...' is 16 bytes base64 decoded, but 24 bytes as ASCII.
        // Let's try using the entitlement key also as literal ASCII for AES-192 first.
        // If entitlement fails later, we might need different logic for it.
        keyString: "YhnUaXMmltB6gd8p9SWleQ==", // 24 bytes as ASCII
        ivString: "theExact16Chars=", // 16 bytes as ASCII
        url: "https://mass.mako.co.il/ClicksStatistics/entitlementsServicesV2.jsp?et=egt"
    }
};

// Function to get crypto parameters, ensuring correct byte buffers
const getCryptoParams = (type) => {
    const config = CRYPTO_CONFIG[type];
    if (!config) return null;

    // Use literal ASCII bytes for Key (expecting 24 bytes for AES-192)
    const key = Buffer.from(config.keyString, 'ascii');
    // Use literal ASCII bytes for IV (expecting 16 bytes)
    const iv = Buffer.from(config.ivString, 'ascii');

    if (key.length !== 24) {
         console.error(`cryptoOp: Invalid key length for AES-192: ${key.length} bytes (expected 24) for key string: ${config.keyString}`);
         return null;
    }
     if (iv.length !== 16) {
         console.error(`cryptoOp: Invalid IV length: ${iv.length} bytes (expected 16) for IV string: ${config.ivString}`);
         return null;
    }
    return { key, iv };
};


const cryptoOp = (data, op, type) => {
    let result = null;
    try {
        const params = getCryptoParams(type);
        if (!params) {
            console.error(`cryptoOp: Failed to get valid crypto params for type: ${type}`);
            return null;
        }
        const { key, iv } = params; // Key is 24 bytes, IV is 16 bytes

        if (!data || typeof data !== 'string' || data.length === 0) {
            console.error(`cryptoOp: Invalid or empty input data string`);
            return null;
        }

        console.log(`cryptoOp: Starting ${op} operation for ${type} using AES-192-CBC`);
        // console.log(`cryptoOp: Key String: ${CRYPTO_CONFIG[type].keyString}`);
        // console.log(`cryptoOp: IV String: ${CRYPTO_CONFIG[type].ivString}`);
        // console.log(`cryptoOp: Key Hex (ASCII): ${key.toString('hex')}`);
        // console.log(`cryptoOp: IV Hex (ASCII): ${iv.toString('hex')}`);
        // console.log(`cryptoOp: Key length: ${key.length}, IV length: ${iv.length}`);


        if (op === "decrypt") {
            try {
                // 1. Decode Input Data from Base64
                const encryptedData = Buffer.from(data, 'base64');

                // 2. Create Decipher using AES-192-CBC
                const decipher = crypto.createDecipheriv('aes-192-cbc', key, iv);
                // Auto-padding enabled by default (handles PKCS7)

                // 3. Decrypt data
                let decryptedBuffer;
                try {
                    decryptedBuffer = Buffer.concat([
                        decipher.update(encryptedData),
                        decipher.final() // Handles padding removal
                    ]);
                } catch (decryptError) {
                    console.error(`cryptoOp: Decryption failed during update/final:`, decryptError);
                    console.error(`cryptoOp: Failed with AES-192-CBC`);
                    console.error(`cryptoOp: Failed Key Hex (ASCII): ${key.toString('hex')}`);
                    console.error(`cryptoOp: Failed IV Hex (ASCII): ${iv.toString('hex')}`);
                    return null;
                }

                // 4. Convert result to UTF-8 string
                result = decryptedBuffer.toString('utf8');

                if (!result) {
                    console.error('cryptoOp: Decryption resulted in empty string after padding removal.');
                    return null;
                }

                console.log(`cryptoOp: Decryption successful, result length: ${result.length} chars`);
                console.log(`cryptoOp: First 100 chars of decrypted data: ${result.substring(0, 100)}`);

            } catch (e) {
                console.error(`cryptoOp: Decryption error (e.g., bad base64 input):`, e);
                return null;
            }
        } else if (op === "encrypt") {
            // Encryption logic needs to use AES-192 now too
            try {
                const inputBuffer = Buffer.from(data, 'utf8');
                // Use AES-192-CBC for encryption
                const cipher = crypto.createCipheriv('aes-192-cbc', key, iv);
                // Auto-padding enabled by default

                const encryptedBuffer = Buffer.concat([
                    cipher.update(inputBuffer),
                    cipher.final() // Adds padding
                ]);

                result = encryptedBuffer.toString('base64');
                console.log(`cryptoOp: Encryption successful, result length: ${result.length} chars`);
            } catch (e) {
                console.error(`cryptoOp: Encryption error:`, e);
                return null;
            }
        } else {
            console.error(`cryptoOp: Invalid operation: ${op}`);
            return null;
        }
    } catch (e) {
        console.error(`cryptoOp: Unexpected error:`, e);
        return null;
    }

    return result;
};

// Export the crypto function and the original config structure if needed elsewhere
module.exports = {
    CRYPTO: CRYPTO_CONFIG, // Keep original export name if index.js uses it
    cryptoOp
};