/**
 * SECURE Virtual Try-On Server
 * All API keys and sensitive data are kept server-side only
 * Never exposed to client/browser
 */

const express = require('express');
const multer = require('multer');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// CRITICAL: Store these in environment variables, NEVER in code
const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY;
const RUNPOD_API_URL = process.env.RUNPOD_API_URL;

if (!RUNPOD_API_KEY || !RUNPOD_API_URL) {
    console.error('❌ MISSING ENVIRONMENT VARIABLES!');
    console.error('Please set RUNPOD_API_KEY and RUNPOD_API_URL in your environment variables');
    console.error('Create a .env file with:');
    console.error('RUNPOD_API_KEY=your_api_key_here');
    console.error('RUNPOD_API_URL=your_api_url_here');
    process.exit(1);
}

const RUNPOD_BASE_URL = RUNPOD_API_URL.replace('/runsync', '').replace('/run', '');

// Simple in-memory rate limiting (use Redis in production)
const requestCounts = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 5;

// Configure multer for temporary file storage
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, 'temp');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1E9)}${path.extname(file.originalname)}`;
        cb(null, uniqueName);
    }
});

const upload = multer({ 
    storage: storage,
    limits: {
        fileSize: 10 * 1024 * 1024 // 10MB limit
    },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed'), false);
        }
    }
});

// Serve static files
app.use(express.static(path.join(__dirname)));
app.use(express.json());

// Main route - serve the HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Security headers and middleware
app.use((req, res, next) => {
    // Security headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Powered-By', 'Cameleon-Server'); // Hide Express
    
    // Add request ID for tracking (helps with debugging)
    req.id = crypto.randomBytes(8).toString('hex');
    next();
});

// Rate limiting middleware
function rateLimitMiddleware(req, res, next) {
    const clientId = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    
    // Clean up old entries
    for (const [key, data] of requestCounts.entries()) {
        if (now - data.firstRequest > RATE_LIMIT_WINDOW) {
            requestCounts.delete(key);
        }
    }
    
    // Check rate limit
    if (requestCounts.has(clientId)) {
        const clientData = requestCounts.get(clientId);
        if (now - clientData.firstRequest <= RATE_LIMIT_WINDOW) {
            if (clientData.count >= MAX_REQUESTS_PER_WINDOW) {
                return res.status(429).json({ 
                    error: 'Too many requests',
                    message: 'Please wait before trying again'
                });
            }
            clientData.count++;
        } else {
            requestCounts.set(clientId, { firstRequest: now, count: 1 });
        }
    } else {
        requestCounts.set(clientId, { firstRequest: now, count: 1 });
    }
    
    next();
}

/**
 * Upload image to free hosting service
 * ImgBB is more reliable than Imgur for server uploads
 */
async function uploadImageToHost(filePath) {
    try {
        const imageData = fs.readFileSync(filePath);
        const base64Image = imageData.toString('base64');
        
        // Option 1: Upload to ImgBB (RECOMMENDED - more reliable)
        const imgbbApiKey = process.env.IMGBB_API_KEY;
        
        if (imgbbApiKey) {
            try {
                const formData = new FormData();
                formData.append('image', base64Image);
                
                const imgbbResponse = await axios.post(
                    `https://api.imgbb.com/1/upload?key=${imgbbApiKey}`,
                    formData,
                    {
                        headers: formData.getHeaders(),
                        timeout: 30000
                    }
                );
                
                if (imgbbResponse.data.success) {
                    console.log('Image uploaded to ImgBB successfully');
                    return imgbbResponse.data.data.url;
                }
            } catch (imgbbError) {
                console.log('ImgBB upload failed, trying Imgur as fallback...');
            }
        } else {
            console.log('No ImgBB API key provided, using Imgur...');
        }
        
        // Option 2: Fallback to Imgur (less reliable from servers)
        try {
            const imgurResponse = await axios.post(
                'https://api.imgur.com/3/image',
                {
                    image: base64Image,
                    type: 'base64'
                },
                {
                    headers: {
                        'Authorization': 'Client-ID 8e5b0e2b5f8c9a3'
                    },
                    timeout: 30000
                }
            );
            
            if (imgurResponse.data.success) {
                console.log('Image uploaded to Imgur as fallback');
                return imgurResponse.data.data.link;
            }
        } catch (imgurError) {
            console.log('Imgur also failed');
        }
        
        // Option 3: Upload to Cloudinary (free tier available)
        // You would need to sign up and get credentials
        
        // Option 4: Use file.io for temporary hosting
        const formData = new FormData();
        formData.append('file', fs.createReadStream(filePath));
        
        const fileioResponse = await axios.post(
            'https://file.io/?expires=1d',
            formData,
            {
                headers: formData.getHeaders()
            }
        );
        
        if (fileioResponse.data.success) {
            return fileioResponse.data.link;
        }
        
        throw new Error('All image upload services failed');
        
    } catch (error) {
        console.error('Image upload error:', error.message);
        throw error;
    }
}

/**
 * Generate unique request ID
 */
function generateRequestId() {
    return `karthik-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Main API endpoint - completely secure, no client-side exposure
 */
app.post('/api/generate', rateLimitMiddleware, upload.fields([
    { name: 'userImage', maxCount: 1 },
    { name: 'clothingImage', maxCount: 1 }
]), async (req, res) => {
    let tempFiles = [];
    
    try {
        // Validate uploads
        if (!req.files || !req.files.userImage || !req.files.clothingImage) {
            return res.status(400).json({ 
                error: 'Both user image and clothing image are required' 
            });
        }

        const userImagePath = req.files.userImage[0].path;
        const clothingImagePath = req.files.clothingImage[0].path;
        tempFiles = [userImagePath, clothingImagePath];

        console.log(`[${req.id}] Processing request...`);
        console.log(`[${req.id}] Uploading images to hosting service...`);
        
        // Upload images to get public URLs
        const [userImageUrl, clothingImageUrl] = await Promise.all([
            uploadImageToHost(userImagePath),
            uploadImageToHost(clothingImagePath)
        ]);

        console.log(`[${req.id}] Images uploaded successfully`);
        console.log(`[${req.id}] Calling virtual try-on API...`);

        // Call RunPod API (API key is NEVER sent to client)
        const runpodPayload = {
            input: {
                request_id: generateRequestId(),
                model_img: userImageUrl,
                cloth_img: clothingImageUrl,
                swap_type: "Auto",
                output_format: "jpg",
                output_quality: 90
            }
        };

        // Call RunPod API to start generation
        console.log(`[${req.id}] Calling RunPod API to start generation...`);
        
        const runpodResponse = await axios.post(
            RUNPOD_API_URL,
            runpodPayload,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${RUNPOD_API_KEY}`
                },
                timeout: 320000 // 5 minutes 20 seconds - RunPod can take up to 5+ minutes
            }
        );

        console.log(`[${req.id}] Initial response status:`, runpodResponse.data.status);

        // Check if completed immediately (rare)
        if (runpodResponse.data.status === 'COMPLETED' && 
            runpodResponse.data.output && 
            runpodResponse.data.output[0] && 
            runpodResponse.data.output[0].image) {
            
            const generatedImageUrl = runpodResponse.data.output[0].image;
            console.log(`[${req.id}] ✅ Generation completed immediately!`);
            
            return res.json({
                success: true,
                imageUrl: generatedImageUrl
            });
        }

        // If we get IN_PROGRESS, we need to poll the status
        if (runpodResponse.data.status === 'IN_PROGRESS') {
            const jobId = runpodResponse.data.id;
            if (!jobId) {
                throw new Error('No job ID received from RunPod');
            }

            console.log(`[${req.id}] Job ${jobId} is IN_PROGRESS, starting polling...`);

            // Poll for completion using the status endpoint
            const maxWaitTime = 300000; // 5 minutes total
            const startTime = Date.now();
            let pollInterval = 10000; // Start with 10 seconds
            const maxPollInterval = 30000; // Max 30 seconds between polls

            while (Date.now() - startTime < maxWaitTime) {
                await new Promise(resolve => setTimeout(resolve, pollInterval));
                
                try {
                    // Use the correct status endpoint
                    const statusUrl = `${RUNPOD_BASE_URL}/status/${jobId}`;
                    console.log(`[${req.id}] Polling: ${statusUrl}`);
                    
                    const statusResponse = await axios.get(statusUrl, {
                        headers: {
                            'Authorization': `Bearer ${RUNPOD_API_KEY}`
                        },
                        timeout: 30000
                    });

                    const status = statusResponse.data.status;
                    console.log(`[${req.id}] Poll result: ${status}`);

                    if (status === 'COMPLETED') {
                        if (statusResponse.data.output && 
                            statusResponse.data.output[0] && 
                            statusResponse.data.output[0].image) {
                            
                            const generatedImageUrl = statusResponse.data.output[0].image;
                            const totalTime = Math.round((Date.now() - startTime) / 1000);
                            
                            console.log(`[${req.id}] ✅ Generation completed after ${totalTime}s!`);
                            
                            return res.json({
                                success: true,
                                imageUrl: generatedImageUrl
                            });
                        } else {
                            throw new Error('Completed but no image URL in response');
                        }
                    }

                    if (status === 'FAILED') {
                        throw new Error('Generation failed on RunPod server');
                    }

                    if (status === 'CANCELLED') {
                        throw new Error('Generation was cancelled');
                    }

                    // Continue polling for IN_PROGRESS, IN_QUEUE, etc.
                    console.log(`[${req.id}] Still ${status}, continuing to poll...`);
                    
                    // Gradually increase poll interval to be more efficient
                    pollInterval = Math.min(pollInterval * 1.2, maxPollInterval);

                } catch (pollError) {
                    console.log(`[${req.id}] Poll error:`, pollError.message);
                    
                    // Try alternative status endpoint format
                    if (pollError.response && pollError.response.status === 404) {
                        try {
                            const altStatusUrl = `${RUNPOD_BASE_URL}/${jobId}`;
                            console.log(`[${req.id}] Trying alternative URL: ${altStatusUrl}`);
                            
                            const altStatusResponse = await axios.get(altStatusUrl, {
                                headers: {
                                    'Authorization': `Bearer ${RUNPOD_API_KEY}`
                                },
                                timeout: 30000
                            });

                            const altStatus = altStatusResponse.data.status;
                            console.log(`[${req.id}] Alternative poll result: ${altStatus}`);

                            if (altStatus === 'COMPLETED') {
                                if (altStatusResponse.data.output && 
                                    altStatusResponse.data.output[0] && 
                                    altStatusResponse.data.output[0].image) {
                                    
                                    const generatedImageUrl = altStatusResponse.data.output[0].image;
                                    const totalTime = Math.round((Date.now() - startTime) / 1000);
                                    
                                    console.log(`[${req.id}] ✅ Generation completed after ${totalTime}s!`);
                                    
                                    return res.json({
                                        success: true,
                                        imageUrl: generatedImageUrl
                                    });
                                }
                            }
                        } catch (altError) {
                            console.log(`[${req.id}] Alternative URL also failed:`, altError.message);
                        }
                    }
                    
                    // Continue polling despite errors (might be temporary)
                    console.log(`[${req.id}] Continuing to poll despite error...`);
                }
            }

            // If we get here, we've timed out
            const totalTime = Math.round((Date.now() - startTime) / 1000);
            throw new Error(`Generation timed out after ${totalTime} seconds`);
        }

        // Handle other statuses
        if (runpodResponse.data.status === 'FAILED') {
            throw new Error('Generation failed on RunPod server');
        }

        if (runpodResponse.data.status === 'CANCELLED') {
            throw new Error('Generation was cancelled');
        }

        // If we reach here, we got an unexpected status
        console.log(`[${req.id}] Unexpected status: ${runpodResponse.data.status}`);
        console.log(`[${req.id}] Full response:`, JSON.stringify(runpodResponse.data, null, 2));
        throw new Error(`Unexpected response status: ${runpodResponse.data.status}`);

    } catch (error) {
        console.error(`[${req.id}] ❌ Error:`, error.message);
        
        // Return generic error to client (no sensitive details)
        res.status(500).json({ 
            error: 'Failed to generate image',
            message: 'An error occurred during processing. Please try again.'
        });
        
    } finally {
        // Clean up temp files
        tempFiles.forEach(file => {
            if (fs.existsSync(file)) {
                fs.unlinkSync(file);
            }
        });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok',
        service: 'Virtual Try-On API (Secure)',
        timestamp: new Date().toISOString(),
        // NEVER include API keys or sensitive data in responses
        secure: true
    });
});

// Export for Vercel serverless or start local server
if (process.env.VERCEL) {
    // Running on Vercel
    module.exports = app;
} else {
    // Local development
    app.listen(PORT, () => {
        console.log(`\n🔒 Virtual Try-On Server Running`);
        console.log(`📍 Local: http://localhost:${PORT}`);
        console.log(`\n✅ Ready for testing!`);
        console.log(`   - Open http://localhost:${PORT} in your browser`);
        console.log(`   - Upload a user photo and clothing item`);
        console.log(`   - Click 'Genera' to test\n`);
        
        if (!RUNPOD_API_KEY || RUNPOD_API_KEY === 'your_runpod_api_key_here') {
            console.warn('⚠️  WARNING: Add your RunPod API key to .env file!');
        }
    });
}
