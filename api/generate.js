/**
 * SECURE Virtual Try-On API Endpoint for Vercel
 * All API keys and sensitive data are kept server-side only
 * Never exposed to client/browser
 */

const axios = require('axios');
const FormData = require('form-data');
const multer = require('multer');
const crypto = require('crypto');

// CRITICAL: Store these in environment variables, NEVER in code
const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY;
const RUNPOD_API_URL = process.env.RUNPOD_API_URL;

if (!RUNPOD_API_KEY || !RUNPOD_API_URL) {
    console.error('❌ MISSING ENVIRONMENT VARIABLES!');
    console.error('Please set RUNPOD_API_KEY and RUNPOD_API_URL in your environment variables');
}

const RUNPOD_BASE_URL = RUNPOD_API_URL ? RUNPOD_API_URL.replace('/runsync', '').replace('/run', '') : '';

// Simple in-memory rate limiting (use Redis in production)
const requestCounts = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 5;

// Configure multer for memory storage (Vercel doesn't support disk storage)
const upload = multer({ 
    storage: multer.memoryStorage(),
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

// Rate limiting middleware
function rateLimitMiddleware(req, res, next) {
    const clientId = req.ip || req.connection.remoteAddress || 'unknown';
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
async function uploadImageToHost(imageBuffer) {
    try {
        const base64Image = imageBuffer.toString('base64');
        
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

// Main API handler
export default async function handler(req, res) {
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    // Handle preflight requests
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    // Only allow POST
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }
    
    // Check environment variables
    if (!RUNPOD_API_KEY || !RUNPOD_API_URL) {
        return res.status(500).json({ 
            error: 'Server configuration error',
            message: 'Missing API configuration'
        });
    }
    
    // Generate request ID for tracking
    const requestId = crypto.randomBytes(8).toString('hex');
    
    // Apply rate limiting
    const clientId = req.ip || req.headers['x-forwarded-for'] || 'unknown';
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
    
    try {
        // Parse multipart form data
        const uploadMiddleware = upload.fields([
            { name: 'userImage', maxCount: 1 },
            { name: 'clothingImage', maxCount: 1 }
        ]);
        
        // Promisify multer
        await new Promise((resolve, reject) => {
            uploadMiddleware(req, res, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        
        // Validate uploads
        if (!req.files || !req.files.userImage || !req.files.clothingImage) {
            return res.status(400).json({ 
                error: 'Both user image and clothing image are required' 
            });
        }

        const userImageBuffer = req.files.userImage[0].buffer;
        const clothingImageBuffer = req.files.clothingImage[0].buffer;

        console.log(`[${requestId}] Processing request...`);
        console.log(`[${requestId}] Uploading images to hosting service...`);
        
        // Upload images to get public URLs
        const [userImageUrl, clothingImageUrl] = await Promise.all([
            uploadImageToHost(userImageBuffer),
            uploadImageToHost(clothingImageBuffer)
        ]);

        console.log(`[${requestId}] Images uploaded successfully`);
        console.log(`[${requestId}] Calling virtual try-on API...`);

        // Call RunPod API to start generation
        console.log(`[${requestId}] Calling RunPod API to start generation...`);
        
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

        console.log(`[${requestId}] Initial response status:`, runpodResponse.data.status);

        // Check if completed immediately (rare)
        if (runpodResponse.data.status === 'COMPLETED' && 
            runpodResponse.data.output && 
            runpodResponse.data.output[0] && 
            runpodResponse.data.output[0].image) {
            
            const generatedImageUrl = runpodResponse.data.output[0].image;
            console.log(`[${requestId}] ✅ Generation completed immediately!`);
            
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

            console.log(`[${requestId}] Job ${jobId} is IN_PROGRESS, starting polling...`);

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
                    console.log(`[${requestId}] Polling: ${statusUrl}`);
                    
                    const statusResponse = await axios.get(statusUrl, {
                        headers: {
                            'Authorization': `Bearer ${RUNPOD_API_KEY}`
                        },
                        timeout: 30000
                    });

                    const status = statusResponse.data.status;
                    console.log(`[${requestId}] Poll result: ${status}`);

                    if (status === 'COMPLETED') {
                        if (statusResponse.data.output && 
                            statusResponse.data.output[0] && 
                            statusResponse.data.output[0].image) {
                            
                            const generatedImageUrl = statusResponse.data.output[0].image;
                            const totalTime = Math.round((Date.now() - startTime) / 1000);
                            
                            console.log(`[${requestId}] ✅ Generation completed after ${totalTime}s!`);
                            
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
                    console.log(`[${requestId}] Still ${status}, continuing to poll...`);
                    
                    // Gradually increase poll interval to be more efficient
                    pollInterval = Math.min(pollInterval * 1.2, maxPollInterval);

                } catch (pollError) {
                    console.log(`[${requestId}] Poll error:`, pollError.message);
                    
                    // Try alternative status endpoint format
                    if (pollError.response && pollError.response.status === 404) {
                        try {
                            const altStatusUrl = `${RUNPOD_BASE_URL}/${jobId}`;
                            console.log(`[${requestId}] Trying alternative URL: ${altStatusUrl}`);
                            
                            const altStatusResponse = await axios.get(altStatusUrl, {
                                headers: {
                                    'Authorization': `Bearer ${RUNPOD_API_KEY}`
                                },
                                timeout: 30000
                            });

                            const altStatus = altStatusResponse.data.status;
                            console.log(`[${requestId}] Alternative poll result: ${altStatus}`);

                            if (altStatus === 'COMPLETED') {
                                if (altStatusResponse.data.output && 
                                    altStatusResponse.data.output[0] && 
                                    altStatusResponse.data.output[0].image) {
                                    
                                    const generatedImageUrl = altStatusResponse.data.output[0].image;
                                    const totalTime = Math.round((Date.now() - startTime) / 1000);
                                    
                                    console.log(`[${requestId}] ✅ Generation completed after ${totalTime}s!`);
                                    
                                    return res.json({
                                        success: true,
                                        imageUrl: generatedImageUrl
                                    });
                                }
                            }
                        } catch (altError) {
                            console.log(`[${requestId}] Alternative URL also failed:`, altError.message);
                        }
                    }
                    
                    // Continue polling despite errors (might be temporary)
                    console.log(`[${requestId}] Continuing to poll despite error...`);
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
        console.log(`[${requestId}] Unexpected status: ${runpodResponse.data.status}`);
        console.log(`[${requestId}] Full response:`, JSON.stringify(runpodResponse.data, null, 2));
        throw new Error(`Unexpected response status: ${runpodResponse.data.status}`);

    } catch (error) {
        console.error(`[${requestId}] ❌ Error:`, error.message);
        
        // Return generic error to client (no sensitive details)
        res.status(500).json({ 
            error: 'Failed to generate image',
            message: 'An error occurred during processing. Please try again.'
        });
    }
}
