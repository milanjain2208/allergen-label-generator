import ExcelJS from 'exceljs';
import fs from 'fs';
import { getAllergens } from './openFoodFacts';

export const processExcelStream = async (
    filePath: string,
    onProgress?: (data: any) => void
) => {
    // Stream the file (Low RAM usage)
    const workbookReader = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {});

    let currentRecipeName: string | null = null;
    let currentIngredients: Set<string> = new Set();
    let recipeCount = 0;

    for await (const worksheetReader of workbookReader) {
        for await (const row of worksheetReader) {
            if (row.number === 1) continue;

            const rowData = row.values as any[];
            const product = rowData[1];
            const ingredient = rowData[2];

            if (!product) continue;
            if (product !== currentRecipeName && currentRecipeName !== null) {
                await processSingleRecipe(currentRecipeName, currentIngredients, onProgress);
                currentIngredients.clear();
                recipeCount++;
            }

            currentRecipeName = product;
            if (ingredient) currentIngredients.add(ingredient);
        }
    }

    // Process the final recipe
    if (currentRecipeName && currentIngredients.size > 0) {
        await processSingleRecipe(currentRecipeName, currentIngredients, onProgress);
    }

    // Cleanup: Delete the temp file
    try {
        fs.unlinkSync(filePath);
    } catch (e) { console.error("Could not delete temp file"); }
};

async function processSingleRecipe(
    name: string,
    ingredientsSet: Set<string>,
    onProgress?: (data: any) => void
) {
    const ingredients = Array.from(ingredientsSet);

    const allergenPromises = ingredients.map(ing => getAllergens(ing));
    const allergensArray = await Promise.all(allergenPromises);

    const flagged_ingredients: any = {};
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

    //Emiting Result via WebSocket Callback
    if (onProgress) {
        onProgress({ type: 'RECIPE_COMPLETE', result });
    }
}
