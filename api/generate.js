/**
 * SECURE Virtual Try-On API Endpoint for Vercel
 * All API keys and sensitive data are kept server-side only
 * Never exposed to client/browser
 */

import { IncomingForm } from 'formidable';
import fs from 'fs';
import path from 'path';

// CRITICAL: Store these in environment variables, NEVER in code
const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY;
const RUNPOD_API_URL = process.env.RUNPOD_API_URL;

if (!RUNPOD_API_KEY || !RUNPOD_API_URL) {
    console.error('❌ MISSING ENVIRONMENT VARIABLES!');
    console.error('Please set RUNPOD_API_KEY and RUNPOD_API_URL in your environment variables');
}

const RUNPOD_BASE_URL = RUNPOD_API_URL ? RUNPOD_API_URL.replace('/runsync', '').replace('/run', '') : '';

// Simple in-memory rate limiting
const requestCounts = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 5;

/**
 * Upload image to free hosting service
 */
async function uploadImageToHost(imageBuffer) {
    try {
        const base64Image = imageBuffer.toString('base64');
        
        // Try ImgBB first (more reliable)
        const imgbbApiKey = process.env.IMGBB_API_KEY;
        
        if (imgbbApiKey) {
            try {
                const formData = new URLSearchParams();
                formData.append('image', base64Image);
                
                const response = await fetch(`https://api.imgbb.com/1/upload?key=${imgbbApiKey}`, {
                    method: 'POST',
                    body: formData,
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    }
                });
                
                const data = await response.json();
                
                if (data.success) {
                    console.log('✅ Image uploaded to ImgBB successfully');
                    return data.data.url;
                }
            } catch (imgbbError) {
                console.log('ImgBB failed, trying Imgur...');
            }
        }
        
        // Fallback to Imgur
        try {
            const response = await fetch('https://api.imgur.com/3/image', {
                method: 'POST',
                headers: {
                    'Authorization': 'Client-ID 8e5b0e2b5f8c9a3',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    image: base64Image,
                    type: 'base64'
                })
            });
            
            const data = await response.json();
            
            if (data.success) {
                console.log('✅ Image uploaded to Imgur as fallback');
                return data.data.link;
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

// Disable body parser for multipart
export const config = {
    api: {
        bodyParser: false,
    },
};

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
        console.error('Missing environment variables');
        return res.status(500).json({ 
            error: 'Server configuration error',
            message: 'Missing API configuration'
        });
    }
    
    // Generate request ID for tracking
    const requestId = Math.random().toString(36).substr(2, 8);
    console.log(`[${requestId}] Processing request...`);
    
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
        // Parse form data using formidable
        console.log(`[${requestId}] Starting form parsing...`);
        const form = new IncomingForm();
        
        // Set formidable options for better compatibility
        form.keepExtensions = true;
        form.maxFileSize = 4.5 * 1024 * 1024; // 4.5MB per file (safe for Vercel's 5MB body limit)
        form.maxTotalFileSize = 8 * 1024 * 1024; // Total limit for both files combined
        
        const { fields, files } = await new Promise((resolve, reject) => {
            form.parse(req, (err, fields, files) => {
                if (err) reject(err);
                else resolve({ fields, files });
            });
        });

        console.log(`[${requestId}] Form parsed successfully`);
        console.log(`[${requestId}] Files received:`, Object.keys(files));
        console.log(`[${requestId}] Fields received:`, Object.keys(fields));

        // Get the uploaded files (handle both formidable v2 and v3+ formats)
        const userImageFile = Array.isArray(files.userImage) ? files.userImage[0] : files.userImage;
        const clothingImageFile = Array.isArray(files.clothingImage) ? files.clothingImage[0] : files.clothingImage;
        
        // Get swap type from form fields
        const swapType = Array.isArray(fields.swapType) ? fields.swapType[0] : fields.swapType || 'Auto';
        console.log(`[${requestId}] Swap type selected: ${swapType}`);

        if (!userImageFile || !clothingImageFile) {
            console.log(`[${requestId}] Missing files - userImage: ${!!userImageFile}, clothingImage: ${!!clothingImageFile}`);
            return res.status(400).json({ 
                error: 'Both user image and clothing image are required' 
            });
        }

        console.log(`[${requestId}] Reading image files...`);

        // Read the file buffers
        const userImageBuffer = fs.readFileSync(userImageFile.filepath);
        const clothingImageBuffer = fs.readFileSync(clothingImageFile.filepath);

        console.log(`[${requestId}] Image buffers read - User: ${userImageBuffer.length} bytes, Clothing: ${clothingImageBuffer.length} bytes`);
        console.log(`[${requestId}] Uploading images to hosting service...`);

        // Upload images to get public URLs
        const [userImageUrl, clothingImageUrl] = await Promise.all([
            uploadImageToHost(userImageBuffer),
            uploadImageToHost(clothingImageBuffer)
        ]);

        console.log(`[${requestId}] Images uploaded successfully`);
        console.log(`[${requestId}] User image URL: ${userImageUrl}`);
        console.log(`[${requestId}] Clothing image URL: ${clothingImageUrl}`);

        // Clean up temporary files
        try {
            fs.unlinkSync(userImageFile.filepath);
            fs.unlinkSync(clothingImageFile.filepath);
        } catch (cleanupError) {
            console.log(`[${requestId}] Cleanup warning:`, cleanupError.message);
        }

        console.log(`[${requestId}] Calling RunPod API...`);

        // Call RunPod API to start generation
        const runpodPayload = {
            input: {
                request_id: generateRequestId(),
                model_img: userImageUrl,
                cloth_img: clothingImageUrl,
                swap_type: swapType,
                output_format: "jpg",
                output_quality: 90
            }
        };

        console.log(`[${requestId}] RunPod payload:`, JSON.stringify(runpodPayload, null, 2));

        const runpodResponse = await fetch(RUNPOD_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${RUNPOD_API_KEY}`
            },
            body: JSON.stringify(runpodPayload)
        });

        if (!runpodResponse.ok) {
            throw new Error(`RunPod API error: ${runpodResponse.status} ${runpodResponse.statusText}`);
        }

        const runpodData = await runpodResponse.json();
        console.log(`[${requestId}] RunPod response:`, JSON.stringify(runpodData, null, 2));

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

            // Poll for completion
            const maxWaitTime = 300000; // 5 minutes total
            const startTime = Date.now();
            let pollInterval = 10000; // Start with 10 seconds

            while (Date.now() - startTime < maxWaitTime) {
                await new Promise(resolve => setTimeout(resolve, pollInterval));
                
                try {
                    const statusUrl = `${RUNPOD_BASE_URL}/status/${jobId}`;
                    console.log(`[${requestId}] Polling: ${statusUrl}`);
                    
                    const statusResponse = await fetch(statusUrl, {
                        headers: {
                            'Authorization': `Bearer ${RUNPOD_API_KEY}`
                        }
                    });

                    if (!statusResponse.ok) {
                        throw new Error(`Status check failed: ${statusResponse.status}`);
                    }

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
                    
                    // Gradually increase poll interval
                    pollInterval = Math.min(pollInterval * 1.2, 30000);

                } catch (pollError) {
                    console.log(`[${requestId}] Poll error:`, pollError.message);
                    
                    // Try alternative status endpoint format
                    try {
                        const altStatusUrl = `${RUNPOD_BASE_URL}/${jobId}`;
                        console.log(`[${requestId}] Trying alternative URL: ${altStatusUrl}`);
                        
                        const altStatusResponse = await fetch(altStatusUrl, {
                            headers: {
                                'Authorization': `Bearer ${RUNPOD_API_KEY}`
                            }
                        });

                        if (altStatusResponse.ok) {
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
                        }
                    } catch (altError) {
                        console.log(`[${requestId}] Alternative URL also failed:`, altError.message);
                    }
                    
                    // Continue polling despite errors
                    console.log(`[${requestId}] Continuing to poll despite error...`);
                }
            }

            // Timeout
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

        // Unexpected status
        console.log(`[${requestId}] Unexpected status: ${runpodData.status}`);
        console.log(`[${requestId}] Full response:`, JSON.stringify(runpodData, null, 2));
        throw new Error(`Unexpected response status: ${runpodData.status}`);

    } catch (error) {
        console.error(`[${requestId}] ❌ Error:`, error.message);
        console.error(`[${requestId}] Stack trace:`, error.stack);
        
        // More specific error handling
        let errorMessage = 'An error occurred during processing. Please try again.';
        let statusCode = 500;
        
        if (error.message.includes('maxFileSize') || error.message.includes('maxTotalFileSize') || 
            error.message.includes('LIMIT_FILE_SIZE') || error.message.includes('File too large')) {
            errorMessage = 'Image file too large. Please use images smaller than 4.5MB each. The app will automatically compress large images.';
            statusCode = 413; // Payload Too Large
        } else if (error.message.includes('formidable') || error.message.includes('parse')) {
            errorMessage = 'Error processing uploaded images. Please try uploading different images.';
            statusCode = 400;
        } else if (error.message.includes('upload') || error.message.includes('hosting')) {
            errorMessage = 'Error uploading images to processing service. Please try again.';
            statusCode = 502;
        } else if (error.message.includes('RunPod') || error.message.includes('API')) {
            errorMessage = 'AI generation service temporarily unavailable. Please try again in a few minutes.';
            statusCode = 502;
        } else if (error.message.includes('timeout') || error.message.includes('TIMEOUT')) {
            errorMessage = 'Processing took too long. Please try again with smaller images.';
            statusCode = 408; // Request Timeout
        }
        
        // Return error to client
        res.status(statusCode).json({ 
            error: 'Failed to generate image',
            message: errorMessage,
            requestId: requestId,
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
}