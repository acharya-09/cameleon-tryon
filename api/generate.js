/**
 * SECURE Virtual Try-On API Endpoint for Vercel
 * All API keys and sensitive data are kept server-side only
 * Never exposed to client/browser
 */

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
                const formData = new URLSearchParams();
                formData.append('image', base64Image);
                
                const imgbbResponse = await fetch(
                    `https://api.imgbb.com/1/upload?key=${imgbbApiKey}`,
                    {
                        method: 'POST',
                        body: formData,
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded'
                        }
                    }
                );
                
                const imgbbData = await imgbbResponse.json();
                
                if (imgbbData.success) {
                    console.log('Image uploaded to ImgBB successfully');
                    return imgbbData.data.url;
                }
            } catch (imgbbError) {
                console.log('ImgBB upload failed, trying Imgur as fallback...');
            }
        } else {
            console.log('No ImgBB API key provided, using Imgur...');
        }
        
        // Option 2: Fallback to Imgur (less reliable from servers)
        try {
            const imgurResponse = await fetch(
                'https://api.imgur.com/3/image',
                {
                    method: 'POST',
                    headers: {
                        'Authorization': 'Client-ID 8e5b0e2b5f8c9a3',
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        image: base64Image,
                        type: 'base64'
                    })
                }
            );
            
            const imgurData = await imgurResponse.json();
            
            if (imgurData.success) {
                console.log('Image uploaded to Imgur as fallback');
                return imgurData.data.link;
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

/**
 * Parse multipart form data manually for Vercel
 */
async function parseMultipartFormData(request) {
    const boundary = request.headers['content-type']?.split('boundary=')[1];
    if (!boundary) {
        throw new Error('No boundary found in content-type');
    }

    const body = Buffer.from(await request.arrayBuffer());
    const boundaryBuffer = Buffer.from(`--${boundary}`);
    const parts = [];
    
    let start = 0;
    while (true) {
        const boundaryIndex = body.indexOf(boundaryBuffer, start);
        if (boundaryIndex === -1) break;
        
        if (start > 0) {
            const partData = body.slice(start, boundaryIndex);
            const headerEndIndex = partData.indexOf('\r\n\r\n');
            if (headerEndIndex !== -1) {
                const headers = partData.slice(0, headerEndIndex).toString();
                const content = partData.slice(headerEndIndex + 4, -2); // Remove trailing \r\n
                
                const nameMatch = headers.match(/name="([^"]+)"/);
                if (nameMatch) {
                    parts.push({
                        name: nameMatch[1],
                        data: content
                    });
                }
            }
        }
        
        start = boundaryIndex + boundaryBuffer.length + 2; // +2 for \r\n
    }
    
    return parts;
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
    const requestId = Math.random().toString(36).substr(2, 8);
    
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
        console.log(`[${requestId}] Processing request...`);
        
        // Parse form data
        const parts = await parseMultipartFormData(req);
        
        const userImagePart = parts.find(p => p.name === 'userImage');
        const clothingImagePart = parts.find(p => p.name === 'clothingImage');
        
        if (!userImagePart || !clothingImagePart) {
            return res.status(400).json({ 
                error: 'Both user image and clothing image are required' 
            });
        }

        console.log(`[${requestId}] Uploading images to hosting service...`);
        
        // Upload images to get public URLs
        const [userImageUrl, clothingImageUrl] = await Promise.all([
            uploadImageToHost(userImagePart.data),
            uploadImageToHost(clothingImagePart.data)
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

        const runpodResponse = await fetch(RUNPOD_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${RUNPOD_API_KEY}`
            },
            body: JSON.stringify(runpodPayload)
        });

        const runpodData = await runpodResponse.json();
        console.log(`[${requestId}] Initial response status:`, runpodData.status);

        // Check if completed immediately (rare)
        if (runpodData.status === 'COMPLETED' && 
            runpodData.output && 
            runpodData.output[0] && 
            runpodData.output[0].image) {
            
            const generatedImageUrl = runpodData.output[0].image;
            console.log(`[${requestId}] ✅ Generation completed immediately!`);
            
            return res.json({
                success: true,
                imageUrl: generatedImageUrl
            });
        }

        // If we get IN_PROGRESS, we need to poll the status
        if (runpodData.status === 'IN_PROGRESS') {
            const jobId = runpodData.id;
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
                    
                    const statusResponse = await fetch(statusUrl, {
                        headers: {
                            'Authorization': `Bearer ${RUNPOD_API_KEY}`
                        }
                    });

                    const statusData = await statusResponse.json();
                    const status = statusData.status;
                    console.log(`[${requestId}] Poll result: ${status}`);

                    if (status === 'COMPLETED') {
                        if (statusData.output && 
                            statusData.output[0] && 
                            statusData.output[0].image) {
                            
                            const generatedImageUrl = statusData.output[0].image;
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
                    if (pollError.message.includes('404')) {
                        try {
                            const altStatusUrl = `${RUNPOD_BASE_URL}/${jobId}`;
                            console.log(`[${requestId}] Trying alternative URL: ${altStatusUrl}`);
                            
                            const altStatusResponse = await fetch(altStatusUrl, {
                                headers: {
                                    'Authorization': `Bearer ${RUNPOD_API_KEY}`
                                }
                            });

                            const altStatusData = await altStatusResponse.json();
                            const altStatus = altStatusData.status;
                            console.log(`[${requestId}] Alternative poll result: ${altStatus}`);

                            if (altStatus === 'COMPLETED') {
                                if (altStatusData.output && 
                                    altStatusData.output[0] && 
                                    altStatusData.output[0].image) {
                                    
                                    const generatedImageUrl = altStatusData.output[0].image;
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
        if (runpodData.status === 'FAILED') {
            throw new Error('Generation failed on RunPod server');
        }

        if (runpodData.status === 'CANCELLED') {
            throw new Error('Generation was cancelled');
        }

        // If we reach here, we got an unexpected status
        console.log(`[${requestId}] Unexpected status: ${runpodData.status}`);
        console.log(`[${requestId}] Full response:`, JSON.stringify(runpodData, null, 2));
        throw new Error(`Unexpected response status: ${runpodData.status}`);

    } catch (error) {
        console.error(`[${requestId}] ❌ Error:`, error.message);
        
        // Return generic error to client (no sensitive details)
        res.status(500).json({ 
            error: 'Failed to generate image',
            message: 'An error occurred during processing. Please try again.'
        });
    }
}