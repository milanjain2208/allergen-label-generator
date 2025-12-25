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
        const response = await limiter.schedule(() =>
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
                    'User-Agent': 'Alg (milanjain2208@gmail.com)'
                }
            })
        );

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
        console.error(`Error fetching ${ingredient}:`, error instanceof Error ? error.message : error);
        return null; // Treat API errors as "not found"
    }
};
