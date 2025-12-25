/**
 * Extracts clean text from any Excel cell type.
 * Handles: strings, numbers, formulas, hyperlinks, rich text, dates, booleans
 */
export function extractCellValue(cellValue: any): string | null {
    if (cellValue === null || cellValue === undefined) return null;

    // 1. Handle Simple Strings & Numbers
    if (typeof cellValue === 'string') return cellValue.trim();
    if (typeof cellValue === 'number') return cellValue.toString();

    // 2. Handle Formulas { formula: '...', result: 'Val' }
    if (typeof cellValue === 'object' && 'result' in cellValue) {
        return cellValue.result ? cellValue.result.toString().trim() : null;
    }

    // 3. Handle Hyperlinks { text: 'Val', hyperlink: '...' }
    if (typeof cellValue === 'object' && 'text' in cellValue) {
        return cellValue.text.toString().trim();
    }

    // 4. Handle Rich Text { richText: [ { text: 'Val' }, ... ] }
    if (typeof cellValue === 'object' && 'richText' in cellValue) {
        return cellValue.richText
            .map((part: any) => part.text)
            .join('')
            .trim();
    }

    // 5. Fallback (Dates, Booleans, etc.)
    return cellValue.toString().trim();
}
