import ExcelJS from 'exceljs';
import fs from 'fs';
import Database from 'better-sqlite3';
import { getAllergens } from './openFoodFacts';

export const processExcelStream = async (
    filePath: string,
    onProgress?: (data: any) => void
) => {
    // 1. SETUP TEMP DATABASE
    // We create a temp DB file so we don't use RAM for sorting
    const dbPath = filePath + '.db';
    const db = new Database(dbPath);

    // Create a table for raw inputs.
    // We index 'product' for fast retrieval later.
    db.exec(`
        CREATE TABLE raw_recipes (
            product TEXT,
            ingredient TEXT
        );
        CREATE INDEX idx_product ON raw_recipes(product);
    `);

    const insertStmt = db.prepare('INSERT INTO raw_recipes (product, ingredient) VALUES (?, ?)');

    // 2. INGEST (Excel -> SQLite)
    // Running this in a transaction for speed (batch inserts are much faster)
    const insertMany = db.transaction((rows: { product: string; ingredient: string }[]) => {
        for (const row of rows) insertStmt.run(row.product, row.ingredient);
    });

    const workbookReader = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {});
    let batch: { product: string; ingredient: string }[] = [];

    for await (const worksheetReader of workbookReader) {
        for await (const row of worksheetReader) {
            if (row.number === 1) continue; // Skip header row

            const rowData = row.values as any[];
            const product = rowData[1];
            const ingredient = rowData[2];

            if (product) {
                batch.push({ product, ingredient });
                // Batch insert every 1000 rows to keep it fast
                if (batch.length >= 1000) {
                    insertMany(batch);
                    batch = [];
                }
            }
        }
    }
    // Insert remaining rows
    if (batch.length > 0) insertMany(batch);

    // 3. PROCESS (SQLite -> External API)
    // Now we query the DB sorted by Product.
    // This effectively "Groups" the scrambled file.
    const stmt = db.prepare('SELECT product, ingredient FROM raw_recipes ORDER BY product');

    let currentRecipeName: string | null = null;
    let currentIngredients: Set<string> = new Set();

    // Iterate strictly through the cursor (Memory safe)
    for (const row of stmt.iterate()) {
        const { product, ingredient } = row as { product: string; ingredient: string };

        console.log("Processing Recipe:", product, "with ingredient:", ingredient);

        // Group change detection - when we encounter a new product, process the previous one
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

    ingredients.forEach((ing, idx) => {
        const found = allergensArray[idx];
        if (found.length > 0) {
            flagged_ingredients[ing] = found;
            found.forEach(a => recipeAllergens.add(a));
        }
    });

    const result = {
        recipe_name: name,
        allergens: Array.from(recipeAllergens),
        flagged_ingredients,
        message: recipeAllergens.size > 0 ? "Processed successfully." : "No allergens found."
    };

    // Emitting Result via WebSocket Callback
    if (onProgress) {
        onProgress({ type: 'RECIPE_COMPLETE', result });
    }
}
