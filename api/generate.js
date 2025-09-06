/**
 * VERCEL SERVERLESS API for Google Gemini Nano Banana
 * Vercel-compatible implementation with environment variables
 */

import { IncomingForm } from 'formidable';
import fs from 'fs';

// CRITICAL: Use environment variables for API key
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image-preview:generateContent';

// Simple in-memory rate limiting
const requestCounts = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 10;

/**
 * Generate dynamic prompt based on swap type - HIDDEN FROM CLIENT
 */
function generatePrompt(swapType) {
    const baseTemplate = "Create a new image by taking the subject from the first image and realistically dressing them with the {CATEGORY} item from the second image. Ensure the subject's appearance, body, face, hairstyle, background, and proportions remain exactly the same, while replacing only the {CATEGORY}. Reproduce the {CATEGORY} exactly as shown in the second image, with precise attention to its design, shape, length, cut, proportions, textures, colors, and details. In the generated image, ensure the {CATEGORY} fits naturally to the subject's body size and pose, preserving realism through accurate scaling, alignment, fabric drape, and seamless blending of lighting and shadows. Always return only the image.";
    
    const categoryMappings = {
        'Full Outfit': 'full outfit',
        'Upper-Body': 'upper-body garment',
        'Lower-Body': 'lower-body garment',
        'Dress': 'dress',
        'Shoes': 'footwear',
        'Headwear': 'headwear item (hat)',
        'Eyewear': 'eyewear (glasses)',
        'Bodywear': 'bodywear accessory (scarf/tie/belt)',
        'Jewelry': 'jewelry item',
        'Bags': 'bag'
    };
    
    const category = categoryMappings[swapType] || 'full outfit';
    return baseTemplate.replace(/{CATEGORY}/g, category);
}

/**
 * Vercel serverless function handler
 */
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
    
    // Check API key
    if (!GEMINI_API_KEY) {
        console.error('❌ Missing Gemini API key - Please set GEMINI_API_KEY environment variable');
        return res.status(500).json({ 
            error: 'Server configuration error',
            message: 'Missing API configuration. Please contact support.'
        });
    }
    
    // Generate request ID
    const requestId = Math.random().toString(36).substr(2, 8);
    console.log(`\n🚀 [${requestId}] Starting Gemini request...`);
    
    // Rate limiting
    const clientId = req.headers['x-forwarded-for'] || req.connection?.remoteAddress || 'unknown';
    const now = Date.now();
    
    // Clean old entries
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
        // Parse form data
        console.log(`📋 [${requestId}] Parsing form data...`);
        const form = new IncomingForm({
            keepExtensions: true,
            maxFileSize: 4.5 * 1024 * 1024, // 4.5MB per file
            maxTotalFileSize: 8 * 1024 * 1024, // 8MB total
            multiples: false
        });
        
        const { fields, files } = await new Promise((resolve, reject) => {
            form.parse(req, (err, fields, files) => {
                if (err) {
                    console.error(`❌ [${requestId}] Form parsing error:`, err);
                    reject(err);
                } else {
                    resolve({ fields, files });
                }
            });
        });

        console.log(`✅ [${requestId}] Form parsed successfully`);
        console.log(`📁 [${requestId}] Files:`, Object.keys(files));
        console.log(`📝 [${requestId}] Fields:`, Object.keys(fields));

        // Get files (handle both array and single file formats)
        const userImageFile = Array.isArray(files.userImage) ? files.userImage[0] : files.userImage;
        const clothingImageFile = Array.isArray(files.clothingImage) ? files.clothingImage[0] : files.clothingImage;
        const swapType = Array.isArray(fields.swapType) ? fields.swapType[0] : fields.swapType || 'Full Outfit';

        console.log(`🎯 [${requestId}] Swap type: ${swapType}`);

        if (!userImageFile || !clothingImageFile) {
            console.log(`❌ [${requestId}] Missing files - user: ${!!userImageFile}, clothing: ${!!clothingImageFile}`);
            return res.status(400).json({ 
                error: 'Both user image and clothing image are required' 
            });
        }

        // Read image files
        console.log(`📖 [${requestId}] Reading image files...`);
        const userImageBuffer = fs.readFileSync(userImageFile.filepath);
        const clothingImageBuffer = fs.readFileSync(clothingImageFile.filepath);

        console.log(`📊 [${requestId}] Image sizes - User: ${(userImageBuffer.length / 1024 / 1024).toFixed(2)}MB, Clothing: ${(clothingImageBuffer.length / 1024 / 1024).toFixed(2)}MB`);

        // Convert to base64
        const userImageBase64 = userImageBuffer.toString('base64');
        const clothingImageBase64 = clothingImageBuffer.toString('base64');

        // Clean up temp files
        try {
            fs.unlinkSync(userImageFile.filepath);
            fs.unlinkSync(clothingImageFile.filepath);
            console.log(`🧹 [${requestId}] Temp files cleaned up`);
        } catch (cleanupError) {
            console.log(`⚠️ [${requestId}] Cleanup warning:`, cleanupError.message);
        }

        // Generate dynamic prompt (SERVER-SIDE ONLY)
        const dynamicPrompt = generatePrompt(swapType);
        console.log(`✨ [${requestId}] Generated dynamic prompt for ${swapType}`);

        // Prepare Gemini payload
        const geminiPayload = {
            contents: [{
                parts: [
                    { text: dynamicPrompt },
                    {
                        inlineData: {
                            mimeType: userImageFile.mimetype || 'image/jpeg',
                            data: userImageBase64
                        }
                    },
                    {
                        inlineData: {
                            mimeType: clothingImageFile.mimetype || 'image/jpeg',
                            data: clothingImageBase64
                        }
                    }
                ]
            }]
        };

        console.log(`🤖 [${requestId}] Calling Gemini API...`);

        // Call Gemini API
        const geminiResponse = await fetch(`${GEMINI_API_URL}?key=${GEMINI_API_KEY}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(geminiPayload)
        });

        if (!geminiResponse.ok) {
            const errorText = await geminiResponse.text();
            console.error(`❌ [${requestId}] Gemini API error: ${geminiResponse.status}`);
            console.error(`❌ [${requestId}] Error details:`, errorText);
            throw new Error(`Gemini API error: ${geminiResponse.status} - ${errorText}`);
        }

        const geminiData = await geminiResponse.json();
        console.log(`📨 [${requestId}] Gemini response received`);

        // Extract generated image
        if (geminiData.candidates && 
            geminiData.candidates[0] && 
            geminiData.candidates[0].content && 
            geminiData.candidates[0].content.parts) {
            
            const parts = geminiData.candidates[0].content.parts;
            let generatedImageData = null;
            
            for (const part of parts) {
                if (part.inlineData && part.inlineData.data) {
                    generatedImageData = part.inlineData.data;
                    break;
                }
            }
            
            if (generatedImageData) {
                const mimeType = parts.find(p => p.inlineData)?.inlineData?.mimeType || 'image/png';
                const imageUrl = `data:${mimeType};base64,${generatedImageData}`;
                
                console.log(`🎉 [${requestId}] SUCCESS! Image generated successfully`);
                
                return res.json({
                    success: true,
                    imageUrl: imageUrl,
                    requestId: requestId
                });
            }
        }

        // No image data found
        console.error(`❌ [${requestId}] No image data in response`);
        if (geminiData.error) {
            throw new Error(`Gemini API error: ${geminiData.error.message}`);
        }
        
        throw new Error('No image generated in response');

    } catch (error) {
        console.error(`💥 [${requestId}] ERROR:`, error.message);
        console.error(`📍 [${requestId}] Stack:`, error.stack);
        
        // Determine error type and message
        let errorMessage = 'An error occurred during processing. Please try again.';
        let statusCode = 500;
        
        if (error.message.includes('maxFileSize') || error.message.includes('File too large')) {
            errorMessage = 'Image files too large. Please use images smaller than 4.5MB each.';
            statusCode = 413;
        } else if (error.message.includes('formidable') || error.message.includes('parse')) {
            errorMessage = 'Error processing uploaded images. Please try different images.';
            statusCode = 400;
        } else if (error.message.includes('Gemini') || error.message.includes('API')) {
            errorMessage = 'AI generation service temporarily unavailable. Please try again in a few minutes.';
            statusCode = 502;
        } else if (error.message.includes('quota') || error.message.includes('limit')) {
            errorMessage = 'Service temporarily at capacity. Please try again in a few minutes.';
            statusCode = 503;
        }
        
        return res.status(statusCode).json({ 
            error: 'Failed to generate image',
            message: errorMessage,
            requestId: requestId
        });
    }
}