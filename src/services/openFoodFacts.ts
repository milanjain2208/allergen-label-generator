import axios from 'axios';
import Bottleneck from 'bottleneck';

// RATE LIMITER CONFIGURATION (Using the Token Bucket)
const limiter = new Bottleneck({
    maxConcurrent: 5,             // Max 5 parallel connections
    minTime: 500,                 // Minimum 500ms between requests (Safety gap)

    reservoir: 10,                // Start with 10 tokens (Burst capacity)
    reservoirRefreshAmount: 10,   // Add 10 tokens...
    reservoirRefreshInterval: 60 * 1000, // ...every 60 seconds
    reservoirIncreaseMaximum: 10  // Safety Lock: Never hoard more than 10 tokens
});

// INTELLIGENT RETRY LOGIC
limiter.on('failed', async (error, jobInfo) => {
    const { retryCount } = jobInfo;

    // Safety Break: Don't retry more than 3 times
    if (retryCount >= 3) return null;

    // Check if it's an Axios error with a response
    if (axios.isAxiosError(error) && error.response) {
        const status = error.response.status;

        // CASE 1: Rate Limited (429)
        // Wait 5 seconds to let the penalty cool down, then retry
        if (status === 429) {
            console.warn(`⚠️ Hit rate limit for job ${jobInfo.options.id}. Retrying in 5s... (Attempt ${retryCount + 1}/3)`);
            return 5000;
        }

        // CASE 2: Server Side Error (500, 502, 503)
        // Wait 1 second and try again (often temporary)
        if (status >= 500) {
            console.warn(`⚠️ Server error ${status}. Retrying... (Attempt ${retryCount + 1}/3)`);
            return 1000;
        }
    }

    // CASE 3: Network Dropouts (No response received)
    // Retry connection errors (ECONNRESET, etc.)
    if (axios.isAxiosError(error) && !error.response) {
        console.warn(`⚠️ Network error. Retrying... (Attempt ${retryCount + 1}/3)`);
        return 1000;
    }

    // For everything else (e.g., 404 Not Found, 400 Bad Request), DO NOT RETRY.
    return null;
});

// Cache stores: null = not found, string[] = allergens (can be empty if found but no allergens)
const cache = new Map<string, string[] | null>();

/**
 * Fetches allergens for an ingredient from Open Food Facts API
 * @returns string[] - allergens found (can be empty if ingredient exists but has no allergens)
 * @returns null - ingredient not found in database
 */
export const getAllergens = async (ingredient: string): Promise<string[] | null> => {
    const normalized = ingredient.toLowerCase().trim();
    if (cache.has(normalized)) return cache.get(normalized)!;

    try {
        // We wrap the call in limiter.schedule
        // If it fails, the 'failed' event above triggers.
        // If that event returns a number, Bottleneck waits and runs this block AGAIN.
        const response = await limiter.schedule({ id: normalized }, () =>
            axios.get('https://world.openfoodfacts.org/cgi/search.pl', {
                params: {
                    search_terms: normalized,
                    search_simple: 1,
                    action: 'process',
                    json: 1,
                    page_size: 1,
                    fields: 'product_name,allergens_tags'
                },
                headers: {
                    'User-Agent': (process.env.APP_NAME && process.env.USER_EMAIL) ? `${process.env.APP_NAME} (${process.env.USER_EMAIL})` : 'Alg (unknown2208@gmail.com)'
                },
                // Set a timeout so we don't wait forever for a hung request
                timeout: 30000
            })
        );

        // console.log("APP_Name", process.env.APP_NAME)
        // console.log("USER_EMAIL", process.env.USER_EMAIL)

        const product = response.data.products?.[0];

        // Product not found in database
        if (!product) {
            cache.set(normalized, null);
            return null;
        }

        // Product found but no allergens
        if (!product.allergens_tags || product.allergens_tags.length === 0) {
            cache.set(normalized, []);
            return [];
        }

        // Product found with allergens
        const cleanAllergens = product.allergens_tags.map((tag: string) =>
            tag.replace('en:', '').replace(/-/g, ' ')
        );

        cache.set(normalized, cleanAllergens);
        return cleanAllergens;

    } catch (error) {
        // This catch block ONLY runs if:
        // 1. It's a non-retriable error (404, 400)
        // 2. OR we exceeded max retries (3 attempts)
        console.error(`❌ Final failure for ${ingredient}:`, axios.isAxiosError(error) ? error.message : error);
        return null; // Graceful fallback
    }
};
