// worker.js

// This worker script handles the backend API endpoints for the photo gallery.
// It interacts with Cloudflare R2, KV, AI, and the OpenAI API.

export default {
    async fetch(request, env, ctx) {
        // Define your R2 public URL prefix. This is where your R2 bucket contents are publicly accessible.
        // It should match the R2_PUBLIC_URL_PREFIX set in your wrangler.toml.
        // Example: 'https://<your-account-id>.r2.cloudflarestorage.com/<your-bucket-name>'
        const R2_PUBLIC_URL_PREFIX = env.R2_PUBLIC_URL_PREFIX;

        const url = new URL(request.url);

        // --- API Endpoint: /api/analyze-photos ---
        // Triggers the AI analysis of all photos in the R2 bucket.
        if (url.pathname === '/api/analyze-photos' && request.method === 'POST') {
            try {
                const results = await analyzePhotos(env, R2_PUBLIC_URL_PREFIX);
                return new Response(JSON.stringify({ status: 'success', message: 'Photos analyzed', details: results }), {
                    headers: { 'Content-Type': 'application/json' },
                });
            } catch (error) {
                console.error('Error in /api/analyze-photos:', error);
                return new Response(JSON.stringify({ status: 'error', message: error.message }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
        }

        // --- API Endpoint: /api/gallery-data ---
        // Retrieves all photo metadata from KV for the frontend gallery.
        if (url.pathname === '/api/gallery-data') {
            try {
                const photos = await getGalleryData(env);
                return new Response(JSON.stringify(photos), {
                    headers: { 'Content-Type': 'application/json' },
                });
            } catch (error) {
                console.error('Error in /api/gallery-data:', error);
                return new Response(JSON.stringify({ status: 'error', message: error.message }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
        }

        // --- API Endpoint: /api/search-photos ---
        // Searches photo metadata in KV based on a query string.
        if (url.pathname === '/api/search-photos') {
            try {
                const searchQuery = url.searchParams.get('query');
                if (!searchQuery) {
                    // If no query, return all photos (or empty array as per frontend expectation)
                    const allPhotos = await getGalleryData(env);
                    return new Response(JSON.stringify(allPhotos), {
                        headers: { 'Content-Type': 'application/json' },
                    });
                }

                const photos = await getGalleryData(env); // Fetch all photos
                const lowerCaseQuery = searchQuery.toLowerCase();

                const filteredPhotos = photos.filter(photo => {
                    const keyMatch = photo.key.toLowerCase().includes(lowerCaseQuery);
                    const descriptionMatch = photo.analysis?.description?.toLowerCase().includes(lowerCaseQuery);
                    const categoryMatch = photo.categories?.some(cat => cat.toLowerCase().includes(lowerCaseQuery));
                    const roomMatch = photo.room?.toLowerCase().includes(lowerCaseQuery);
                    const promptMatch = photo.promptUsed?.toLowerCase().includes(lowerCaseQuery); // For generated images

                    return keyMatch || descriptionMatch || categoryMatch || roomMatch || promptMatch;
                });

                return new Response(JSON.stringify(filteredPhotos), {
                    headers: { 'Content-Type': 'application/json' },
                });
            } catch (error) {
                console.error('Error in /api/search-photos:', error);
                return new Response(JSON.stringify({ status: 'error', message: error.message }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
        }

        // --- API Endpoint: /api/inpainting ---
        // Handles DALL-E 3 image generation for "inpainting" based on a prompt.
        if (url.pathname === '/api/inpainting' && request.method === 'POST') {
            try {
                const { originalImageUrl, inpaintingPrompt } = await request.json();

                if (!originalImageUrl || !inpaintingPrompt) {
                    return new Response(JSON.stringify({ status: 'error', message: 'Missing originalImageUrl or inpaintingPrompt' }), {
                        status: 400,
                        headers: { 'Content-Type': 'application/json' },
                    });
                }

                const imageUrl = await generateInpaintedImage(env, originalImageUrl, inpaintingPrompt);

                return new Response(JSON.stringify({ imageUrl: imageUrl }), {
                    headers: { 'Content-Type': 'application/json' },
                });
            } catch (error) {
                console.error('Error in /api/inpainting:', error);
                return new Response(JSON.stringify({ status: 'error', message: error.message }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
        }

        // --- API Endpoint: /api/save-generated-image ---
        // Saves a generated image (base64 encoded) to R2 and its metadata to KV.
        if (url.pathname === '/api/save-generated-image' && request.method === 'POST') {
            try {
                const { imageData, originalImageKey, promptUsed } = await request.json();

                if (!imageData) {
                    return new Response(JSON.stringify({ status: 'error', message: 'Missing image data' }), {
                        status: 400,
                        headers: { 'Content-Type': 'application/json' },
                    });
                }

                // Extract base64 part and determine mime type and extension
                const matches = imageData.match(/^data:(image\/(.+));base64,(.*)$/);
                if (!matches) {
                    return new Response(JSON.stringify({ status: 'error', message: 'Invalid image data format' }), {
                        status: 400,
                        headers: { 'Content-Type': 'application/json' },
                    });
                }
                const mimeType = matches[1];
                const extension = matches[2];
                const base64EncodedData = matches[3];

                // Decode base64 to ArrayBuffer (required for R2 put)
                const imageBuffer = Uint8Array.from(atob(base64EncodedData), c => c.charCodeAt(0));

                // Generate a unique key for the new image in R2
                const timestamp = Date.now();
                // Sanitize originalImageKey for file naming if it exists
                const safeOriginalKey = originalImageKey ? originalImageKey.replace(/[^a-zA-Z0-9-._]/g, '_').replace(/\.[^/.]+$/, "") : 'image';
                const newKey = 'generated/' + safeOriginalKey + '-' + timestamp + '.' + extension;
                const publicUrl = R2_PUBLIC_URL_PREFIX + '/' + newKey;

                // Save the image to R2
                await env.R2_BUCKET.put(newKey, imageBuffer, {
                    httpMetadata: { contentType: mimeType },
                });

                // Prepare metadata for KV
                const generatedMetadata = {
                    key: newKey,
                    publicUrl: publicUrl,
                    type: 'generated', // Mark this as a generated image
                    originalImageKey: originalImageKey, // Link to the original image
                    promptUsed: promptUsed,
                    analysis: {
                        description: 'Generated image based on prompt: "' + promptUsed + '". (Original: ' + (originalImageKey || 'N/A') + ')',
                    },
                    room: 'Generated', // Categorize generated images into a 'Generated' room
                    lastModified: new Date().toISOString(),
                };

                // Save metadata to KV
                await env.PHOTO_METADATA.put(newKey, JSON.stringify(generatedMetadata));

                return new Response(JSON.stringify({ status: 'success', key: newKey, publicUrl: publicUrl }), {
                    headers: { 'Content-Type': 'application/json' },
                });
            } catch (error) {
                console.error('Error saving generated image:', error);
                return new Response(JSON.stringify({ status: 'error', message: error.message }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
        }

       
       

/**
 * Analyzes photos in the R2 bucket using Cloudflare AI and stores metadata in KV.
 * @param {Object} env The Cloudflare Worker environment bindings.
 * @param {string} r2PublicUrlPrefix The base URL for R2 public access.
 */
async function analyzePhotos(env, r2PublicUrlPrefix) {
    const listObjectsOutput = await env.R2_BUCKET.list();
    const results = [];

    for (const object of listObjectsOutput.objects) {
        // Skip directories if R2 key ends with '/' or if it's already a generated image
        if (object.key.endsWith('/') || object.key.startsWith('generated/')) {
            continue;
        }

        const publicUrl = r2PublicUrlPrefix + '/' + object.key;

        // Fetch the image data from R2
        const r2Object = await env.R2_BUCKET.get(object.key);
        if (!r2Object) {
            console.warn('Could not retrieve R2 object: ' + object.key);
            continue;
        }

        const imageBytes = await r2Object.arrayBuffer();

        let aiAnalysis = {};
        let detectedRoom = 'Uncategorized';
        let detectedCategories = [];
        let description = '';

        try {
            // Use Cloudflare AI Vision model to describe the image and extract room information
            // LLava is good for descriptive answers
            const inputs = {
                image: [...new Uint8Array(imageBytes)],
                prompt: 'Analyze this image. What specific room is depicted (e.g., living room, kitchen, bedroom, bathroom, hallway, outdoor)? If no specific room is clear, state \'unknown\'. Then, provide a concise description of the image content and list 3-5 main categories or objects present, separated by commas. Also, consider the R2 key path: "' + object.key + '" for context.'
            };

            const response = await env.AI.run(
                "@cf/llava-hf/llava-1.5-7b-hf",
                inputs
            );

            description = response.description || 'No detailed description.';
            let rawAiText = response.description.toLowerCase();

            // Attempt to extract room from AI response
            const roomKeywords = ['living room', 'kitchen', 'bedroom', 'bathroom', 'hallway', 'dining room', 'office', 'garage', 'basement', 'attic', 'garden', 'patio', 'balcony', 'outdoor', 'unknown', 'exterior'];
            for (const keyword of roomKeywords) {
                if (rawAiText.includes(keyword)) {
                    detectedRoom = keyword;
                    break;
                }
            }

            // Attempt to extract categories (simple parsing, can be improved)
            const categoryMatch = rawAiText.match(/categories(?::|\s*-)?\s*([a-z0-9\s,]+)/);
            if (categoryMatch && categoryMatch[1]) {
                detectedCategories = categoryMatch[1].split(',').map(c => c.trim()).filter(Boolean);
            }
            if (detectedCategories.length === 0 && description) {
                // Fallback: try to extract categories from general description
                const defaultCategories = description.split(' ').filter((word, i, arr) => {
                    const nextWord = arr[i+1] || '';
                    // Simple heuristic: look for nouns that are not common articles/prepositions
                    return word.length > 3 && !['a', 'an', 'the', 'is', 'are', 'in', 'on', 'at', 'of', 'and', 'or'].includes(word.toLowerCase()) && !nextWord.startsWith('.') && !nextWord.startsWith(',');
                }).slice(0, 5); // Take first 5
                detectedCategories = [...new Set(defaultCategories)]; // Unique and limited
            }


            // Also try to infer room from R2 key path if it's explicitly there
            const pathParts = object.key.split('/').map(part => part.toLowerCase());
            for (const keyword of roomKeywords) {
                if (pathParts.includes(keyword.replace(/\s/g, '_')) || pathParts.includes(keyword)) {
                    detectedRoom = keyword;
                    break;
                }
            }


            aiAnalysis = {
                description: description,
                rawAiResponse: response, // Keep raw for debugging
                extractedRoom: detectedRoom,
                extractedCategories: detectedCategories,
            };

        } catch (aiError) {
            console.error('AI analysis failed for ' + object.key + ':', aiError);
            aiAnalysis = { error: aiError.message, description: 'AI analysis failed.', rawAiResponse: null };
        }

        const photoMetadata = {
            key: object.key,
            publicUrl: publicUrl,
            analysis: aiAnalysis,
            room: detectedRoom, // Storing extracted room explicitly for easy grouping
            categories: detectedCategories, // Storing extracted categories
            lastModified: object.uploaded,
            type: 'original', // Mark as original
        };

        await env.PHOTO_METADATA.put(object.key, JSON.stringify(photoMetadata));
        results.push({ key: object.key, status: 'processed', room: detectedRoom, type: 'original' });
    }
    return results;
}

/**
 * Retrieves all photo metadata from KV.
 * Each photo object will now include a 'type' field (either 'original' or 'generated').
 * @param {Object} env The Cloudflare Worker environment bindings.
 */
async function getGalleryData(env) {
    const listKeys = await env.PHOTO_METADATA.list();
    const photos = [];
    for (const key of listKeys.keys) {
        const value = await env.PHOTO_METADATA.get(key.name);
        if (value) {
            const photo = JSON.parse(value);
            // Assign a 'type' if it's not already present (for older entries or if analysis fails to set it)
            if (!photo.type) {
                photo.type = photo.key.startsWith('generated/') ? 'generated' : 'original';
            }
            photos.push(photo);
        }
    }
    // Sort for consistent display (e.g., original first, then generated, then by room/key)
    photos.sort((a, b) => {
        // Sort by type: original before generated
        if (a.type === 'original' && b.type === 'generated') return -1;
        if (a.type === 'generated' && b.type === 'original') return 1;

        // Within same type, sort by room, then by key
        const roomCompare = (a.room || 'Uncategorized').localeCompare(b.room || 'Uncategorized');
        if (roomCompare !== 0) {
            return roomCompare;
        }
        return a.key.localeCompare(b.key);
    });
    return photos;
}

/**
 * Generates an image using OpenAI DALL-E 3 based on an original image's context and an inpainting prompt.
 * DALL-E 3 (images/generations endpoint) generates new images from text prompts and does not directly use masks.
 * This function will use the stored description of the original image to augment the DALL-E 3 prompt.
 * @param {Object} env The Cloudflare Worker environment bindings.
 * @param {string} originalImageUrl The URL of the original image (used to find its metadata).
 * @param {string} inpaintingPrompt The user's prompt for inpainting.
 * @returns {Promise<string>} The URL of the generated image.
 */
async function generateInpaintedImage(env, originalImageUrl, inpaintingPrompt) {
    // 1. Find the metadata for the original image from KV
    const allPhotoKeys = await env.PHOTO_METADATA.list();
    let originalPhotoMetadata = null;
    for (const key of allPhotoKeys.keys) {
        const metadataString = await env.PHOTO_METADATA.get(key.name);
        if (metadataString) {
            const metadata = JSON.parse(metadataString);
            if (metadata.publicUrl === originalImageUrl) {
                originalPhotoMetadata = metadata;
                break;
            }
        }
    }

    let baseImageDescription = "a photo"; // Default description if metadata is not found
    if (originalPhotoMetadata && originalPhotoMetadata.analysis && originalPhotoMetadata.analysis.description) {
        baseImageDescription = originalPhotoMetadata.analysis.description;
    } else {
        // Fallback: If metadata not found or description missing, log a warning
        console.warn('Metadata for ' + originalImageUrl + ' not found or description missing. Using generic description.');
        // In a real application, you might re-fetch and re-analyze the image here,
        // but for a quick worker, relying on pre-analyzed data is simpler.
    }

    // 2. Construct a comprehensive prompt for DALL-E 3
    // This prompt tries to convey the original image context + the desired inpainting.
    // The canvas selection is a visual aid for the user to formulate a better `inpaintingPrompt`.
    const combinedPrompt = 'Based on an image that can be described as "' + baseImageDescription + '". Generate a new image incorporating the following: "' + inpaintingPrompt + '". The new image should be cohesive and realistic.';

    const openaiHeaders = {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + env.OPENAI_API_KEY, // Your OpenAI API Key from Worker secrets
    };

    const openaiPayload = {
        model: "dall-e-3",
        prompt: combinedPrompt,
        n: 1, // Number of images to generate (DALL-E 3 usually generates 1 per request)
        size: "1024x1024", // Choose a size: "1024x1024", "1792x1024", or "1024x1792"
        response_format: "url", // Request URL for the generated image
    };

    const openaiResponse = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: openaiHeaders,
        body: JSON.stringify(openaiPayload),
    });

    if (!openaiResponse.ok) {
        const errorData = await openaiResponse.json();
        console.error("OpenAI API full error response:", errorData);
        throw new Error('OpenAI API error: ' + (errorData.error ? errorData.error.message : JSON.stringify(errorData)));
    }

    const openaiData = await openaiResponse.json();
    if (openaiData.data && openaiData.data.length > 0 && openaiData.data[0].url) {
        return openaiData.data[0].url; // Return the URL of the generated image
    } else {
        throw new Error("OpenAI response did not contain a valid image URL.");
    }
}
