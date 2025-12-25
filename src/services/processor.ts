import ExcelJS from 'exceljs';
import fs from 'fs';
import Database from 'better-sqlite3';
import { getAllergens } from './openFoodFacts';
import { extractCellValue } from '../utils/extractCellValue';

export const processExcelStream = async (
    filePath: string,
    onProgress?: (data: any) => void
) => {
    // 1. SETUP TEMP DATABASE
    const dbPath = filePath + '.db';
    const db = new Database(dbPath);
    const fileId = filePath.split('/').pop();

    db.exec(`
        CREATE TABLE raw_recipes (
            product TEXT,
            ingredient TEXT
        );
        CREATE INDEX idx_product ON raw_recipes(product);
    `);

    const insertStmt = db.prepare('INSERT INTO raw_recipes (product, ingredient) VALUES (?, ?)');

    // Running this in a transaction for speed (batch inserts are much faster)
    const insertMany = db.transaction((rows: { product: string; ingredient: string | null }[]) => {
        for (const row of rows) insertStmt.run(row.product, row.ingredient);
    });

    // File Corruption Check
    let workbookReader;
    try {
        workbookReader = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {});
    } catch (err) {
        if (onProgress) {
            onProgress({ type: 'ERROR', message: 'File is corrupted or not a valid Excel file.' });
        }
        // Cleanup
        db.close();
        try { fs.unlinkSync(dbPath); } catch (e) { /* ignore */ }
        return;
    }

    let batch: { product: string; ingredient: string | null }[] = [];
    let headerFound = false;
    let productColIdx = 1;    // Default Column A
    let ingredientColIdx = 2; // Default Column B

    // 2. INGEST (Excel -> SQLite)
    console.log(`Ingesting Excel File data to SQLite DB for file ${fileId}`);
    for await (const worksheetReader of workbookReader) {
        for await (const row of worksheetReader) {
            // Skip empty rows (Ghost Rows)
            if (!row.hasValues) continue;

            const rowData = row.values as any[];

            // Smart Header Detection
            // We don't assume Row 1 is header. We look for the FIRST row containing "Product" and "Ingredient"
            if (!headerFound) {
                const rowString = rowData
                    .map(v => (v ? extractCellValue(v)?.toLowerCase() : ''))
                    .join(' ');

                if (rowString.includes('product') && rowString.includes('ingredient')) {
                    headerFound = true;
                    // Dynamically find which column is which
                    productColIdx = rowData.findIndex(v => {
                        const val = extractCellValue(v);
                        return val && val.toLowerCase().includes('product');
                    });
                    ingredientColIdx = rowData.findIndex(v => {
                        const val = extractCellValue(v);
                        return val && val.toLowerCase().includes('ingredient');
                    });
                    console.log(`Header found: Product col=${productColIdx}, Ingredient col=${ingredientColIdx}, for file ${fileId}`);
                }
                continue;
            }

            // Data Cleaning: Extract value safely using the utility function
            const rawProduct = rowData[productColIdx];
            const rawIngredient = rowData[ingredientColIdx];

            const product = extractCellValue(rawProduct);
            const ingredient = extractCellValue(rawIngredient);

            if (product) {
                batch.push({ product, ingredient });
                // Batch insert every 1000 rows
                if (batch.length >= 1000) {
                    insertMany(batch);
                    batch = [];
                }
            }
        }
    }

    // Insert remaining rows
    if (batch.length > 0) insertMany(batch);

    // If no header was found, emit a warning but try to continue with defaults
    if (!headerFound) {
        console.warn('No header row found, using default columns (A=Product, B=Ingredient)');
        if (onProgress) {
            onProgress({
                type: 'WARNING',
                message: 'No header row found. Assuming Column A = Product, Column B = Ingredient.'
            });
        }
    }

    // 3. PROCESS (SQLite -> External API)
    const stmt = db.prepare('SELECT product, ingredient FROM raw_recipes ORDER BY product');

    let currentRecipeName: string | null = null;
    let currentIngredients: Set<string> = new Set();

    // Iterate through the cursor (Memory safe)
    console.log(`Processing Recipes for file ${fileId}`);
    for (const row of stmt.iterate()) {
        const { product, ingredient } = row as { product: string; ingredient: string };

        // console.log("Processing Recipe:", product, "with ingredient:", ingredient);

        // Group change detection
        if (product !== currentRecipeName && currentRecipeName !== null) {
            await processSingleRecipe(currentRecipeName, currentIngredients, onProgress);
            currentIngredients.clear();
        }

        currentRecipeName = product;
        if (ingredient) currentIngredients.add(ingredient);
    }

    // Process the final recipe
    if (currentRecipeName && currentIngredients.size > 0) {
        await processSingleRecipe(currentRecipeName, currentIngredients, onProgress);
    }

    // 4. CLEANUP
    db.close();
    try {
        fs.unlinkSync(filePath);   // Delete Excel
        fs.unlinkSync(dbPath);     // Delete Temp DB
    } catch (e) {
        console.error("Cleanup failed", e);
    }

    console.log(`Processing completed successfully for file ${fileId}.`);
};

async function processSingleRecipe(
    name: string,
    ingredientsSet: Set<string>,
    onProgress?: (data: any) => void
) {
    const ingredients = Array.from(ingredientsSet);

    // Parallel Fetching (Managed by Bottleneck rate limiter)
    const allergenPromises = ingredients.map(ing => getAllergens(ing));
    const allergensArray = await Promise.all(allergenPromises);

    const flagged_ingredients: Record<string, string[]> = {};
    const recipeAllergens = new Set<string>();
    const unrecognized_ingredients: string[] = [];

    ingredients.forEach((ing, idx) => {
        const found = allergensArray[idx];

        if (found === null) {
            // Ingredient not found in Open Food Facts database
            unrecognized_ingredients.push(ing);
        } else if (found.length > 0) {
            // Ingredient found with allergens
            flagged_ingredients[ing] = found;
            found.forEach(a => recipeAllergens.add(a));
        }
        // If found is an empty array, ingredient exists but has no allergens - nothing to do
    });

    // Determine message based on results
    const message = unrecognized_ingredients.length > 0
        ? "Some ingredients were not recognized."
        : "Processed successfully.";

    const result = {
        recipe_name: name,
        allergens: Array.from(recipeAllergens),
        flagged_ingredients,
        unrecognized_ingredients,
        message
    };

    // Emitting Result via WebSocket Callback
    if (onProgress) {
        onProgress({ type: 'RECIPE_COMPLETE', result });
    }
}

