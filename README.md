# Allergen Label Generator

A backend service that processes recipes from Excel files and determines allergens using the [Open Food Facts API](https://world.openfoodfacts.org/).

## Table of Contents

- [Features](#features)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Running the Server](#running-the-server)
- [API Documentation](#api-documentation)
- [Architecture & Approach](#architecture--approach)
- [Edge Cases Handling](#edge-cases-handling)
- [Potential Improvements](#potential-improvements)

---

## Features

- ✅ **Excel Streaming** – Processes large Excel files with low memory footprint
- ✅ **Robust Cell Parsing** – Custom cell parser normalizes Rich Text, Formula Results, and Hyperlinks into plain text
- ✅ **Smart Header Detection** – Dynamically finds header row and column positions
- ✅ **Unordered Recipe Handling** – SQLite-based sorting handles scrambled/unordered Excel data
- ✅ **Rate Limiting** – Token bucket algorithm prevents API throttling
- ✅ **In-Memory Caching** – Avoids redundant API calls for repeated ingredients
- ✅ **Real-Time Progress** – WebSocket support for live processing updates
- ✅ **Parallel Processing** – Concurrent allergen lookups with controlled concurrency


---

## Prerequisites

- **Node.js** >= 16.x
- **npm** >= 8.x

---

## Installation

1. **Clone the repository:**
   ```bash
   git clone <repository-url>
   cd allergen-label-generator
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure Environment Variables:**
   Create a `.env` file in the root directory (use `.env.example` as a reference):
   ```bash
   cp .env.example .env
   ```
   Open `.env` and update the values:
   ```env
   APP_NAME=AllergenLabelProject
   USER_EMAIL=your_email@example.com
   PORT=3000
   ```
   > **Note:** The `USER_EMAIL` is used for the User-Agent header in Open Food Facts API requests to identify your application.

---

## Running the Server

### Development Mode

```bash
npm run dev
```

This starts the server using `ts-node` with hot compilation.

### Production Mode

```bash
npm run build
npm start
```

The server will run on `http://localhost:3000` (HTTP) and `ws://localhost:3000` (WebSocket).

---

## API Documentation

### 1. Upload Excel File

**Endpoint:** `POST /api/upload`

**Content-Type:** `multipart/form-data`

**Request Body:**
| Field | Type | Description |
|-------|------|-------------|
| file  | File | Excel file (.xlsx) containing recipes |

**Example (cURL):**
```bash
curl -X POST http://localhost:3000/api/upload \
  -F "file=@recipes.xlsx"
```

**Response:**
```json
{
  "message": "File uploaded successfully",
  "fileId": "abc123def456"
}
```

---

### 2. Process File via WebSocket

**Endpoint:** `ws://localhost:3000`

**Message Format:**

Send to initiate processing:
```json
{
  "type": "START_PROCESS",
  "fileId": "abc123def456"
}
```

**Response Messages:**

1. **INFO** – Processing started
```json
{
  "type": "INFO",
  "message": "Starting processing..."
}
```

2. **RECIPE_COMPLETE** – Each recipe result

When some ingredients are not found:
```json
{
  "type": "RECIPE_COMPLETE",
  "result": {
    "recipe_name": "Margarita Pizza",
    "allergens": ["gluten", "milk"],
    "flagged_ingredients": {
      "wheat flour": ["gluten"],
      "mozzarella cheese": ["milk"]
    },
    "unrecognized_ingredients": ["tomato sauce"],
    "message": "Some ingredients were not recognized."
  }
}
```

When all ingredients are recognized:
```json
{
  "type": "RECIPE_COMPLETE",
  "result": {
    "recipe_name": "Caesar Salad",
    "allergens": ["gluten", "milk", "fish", "egg"],
    "flagged_ingredients": {
      "croutons": ["gluten"],
      "parmesan cheese": ["milk"],
      "anchovies": ["fish"],
      "egg": ["egg"]
    },
    "unrecognized_ingredients": [],
    "message": "Processed successfully."
  }
}
```

3. **DONE** – All recipes processed
```json
{
  "type": "DONE",
  "message": "All recipes processed."
}
```

4. **ERROR** – Processing failed
```json
{
  "type": "ERROR",
  "message": "Processing failed."
}
```

---

## Architecture & Approach

### Data Flow

```
Excel File → Upload API → Disk Storage
                              ↓
                    Stream Reader (ExcelJS)
                              ↓
                    Temp SQLite Database
                    (Batch Insert + Index)
                              ↓
                    Sorted Query (ORDER BY product)
                              ↓
           WebSocket ← Processor → Open Food Facts API
                                   (Rate Limited + Cached)
```

### Key Components

| Component | File | Purpose |
|-----------|------|---------|
| **HTTP Server** | `src/server.ts` | Entry point, binds HTTP + WS |
| **Express App** | `src/app.ts` | REST API configuration |
| **Upload Route** | `src/routes/api.ts` | File upload handling (multer) |
| **WebSocket Handler** | `src/websocket/handler.ts` | Real-time communication |
| **Processor** | `src/services/processor.ts` | Excel streaming + SQLite + batching |
| **API Client** | `src/services/openFoodFacts.ts` | Rate-limited API calls |
| **Cell Parser** | `src/utils/extractCellValue.ts` | Normalizes Rich Text, Formulas, Hyperlinks to plain text |

### Processing Strategy

1. **Streaming Excel Parser** – Uses ExcelJS streaming API to read row-by-row without loading entire file into memory
2. **Robust Cell Value Extraction** – Custom parser (`src/utils/extractCellValue.ts`) handles:
   - Plain strings and numbers
   - Formula cells (extracts the computed result)
   - Hyperlink cells (extracts the display text)
   - Rich Text cells (concatenates all text parts)
   - Dates, booleans, and other types (converts to string)
3. **Smart Header Detection** – Does not assume header is on Row 1:
   - Scans rows until it finds one containing both "Product" and "Ingredient"
   - Dynamically determines column indices for flexible spreadsheet layouts
   - Falls back to default columns (A, B) if no header is found
4. **Ghost Row Filtering** – Skips empty rows that may exist in the spreadsheet
5. **File Corruption Guard** – Catches and reports corrupted/invalid Excel files gracefully
6. **SQLite Intermediate Storage** – To handle unordered/scrambled recipes in Excel files:
   - Data is first ingested into a temporary SQLite database
   - Batch inserts (1000 rows at a time) optimize write performance
   - An index on the `product` column enables fast sorting
   - Query with `ORDER BY product` groups all ingredients for the same recipe together
   - This approach uses disk instead of RAM, maintaining memory efficiency
7. **Recipe Grouping** – Detects recipe boundaries by monitoring changes in the sorted product column
8. **Parallel Allergen Lookup** – Fetches allergen data for all ingredients in a recipe concurrently
9. **Rate Limiting** – Bottleneck library implements token bucket:
   - Max 5 concurrent connections
   - 500ms minimum gap between requests
   - 10 tokens per minute burst capacity
10. **Caching** – In-memory Map stores allergen results to avoid duplicate API calls
11. **Cleanup** – Both the uploaded Excel file and temporary SQLite database are deleted after processing

---

## Edge Cases Handling

| Edge Case | Handling Strategy |
|-----------|-------------------|
| **Rich Text cells** | Custom parser extracts and concatenates all text parts into plain text |
| **Formula cells** | Extracts the computed result value, not the formula string |
| **Hyperlink cells** | Extracts the display text, ignoring the URL |
| **Ghost/Empty rows** | Skips rows with `hasValues === false` |
| **Header not on Row 1** | Smart detection scans for row containing "Product" and "Ingredient" |
| **Non-standard column order** | Dynamically detects column positions from header row |
| **Corrupted Excel file** | Catches error, emits ERROR event, and cleans up gracefully |
| **Unordered/Scrambled recipes** | SQLite intermediate storage sorts data by product name before processing |
| **Ingredient not found** | Returns empty allergen array, ingredient not flagged |
| **No allergens for ingredient** | Returns empty allergen array (e.g., "water") |
| **Ambiguous names** | Uses first API result; could be improved with fuzzy matching |
| **Malformed Excel** | Gracefully skips invalid rows, continues processing |
| **API failure** | Logs error, returns empty array, doesn't break processing |
| **Large files** | Streaming + SQLite prevents memory issues |
| **Duplicate ingredients** | Set-based collection automatically deduplicates |

---

## Potential Improvements

### If I Had More Time

1. **Fuzzy Matching** – Implement Levenshtein distance for ambiguous ingredient names
2. **Ingredient Normalization** – Strip quantities, units, and modifiers (e.g., "1 cup chopped onions" → "onions")
3. **Redis Caching** – Replace in-memory cache with Redis for persistence across restarts
4. **Batch REST Endpoint** – Add synchronous endpoint that returns full JSON after processing
5. **Progress Percentage** – Pre-scan file to count recipes, then emit progress %
6. **Unit Tests** – Add Jest tests for processor and API client

### Scaling Further

1. **Worker Threads** – Offload CPU-intensive parsing to worker pool
2. **Message Queue** – Use Redis/RabbitMQ to decouple upload from processing
3. **Horizontal Scaling** – Stateless design allows multiple server instances
4. **Database** – Store processed results in PostgreSQL/MongoDB for historical queries
5. **CDN Upload** – Use S3/GCS for file storage instead of local disk

### Additional Features

1. **Allergen Confidence Scores** – Show probability of allergen presence
2. **Alternative Suggestions** – Recommend allergen-free ingredient substitutes
3. **PDF Generation** – Export allergen labels as printable PDFs
4. **Multi-language Support** – Translate allergen names
5. **Custom Allergen Rules** – Allow users to define additional allergens not in Open Food Facts

---

## Testing with Frontend

Open `public/index.html` in a browser (or serve it via a local server) to test:

1. Select an Excel file
2. Click "Upload & Process"
3. Watch real-time results appear

---

## Testing with Postman

### Step 1: Upload the Excel File

1. Open Postman and create a new **POST** request
2. Set the URL to: `http://localhost:3000/api/upload`
3. Go to the **Body** tab
4. Select **form-data**
5. Add a new key:
   - Key: `file` (set type to **File** using the dropdown)
   - Value: Select your `.xlsx` file
6. Click **Send**

**Expected Response:**
```json
{
  "message": "File uploaded successfully",
  "fileId": "abc123def456..."
}
```

### Step 2: Process via WebSocket

Since Postman supports WebSocket connections:

1. Create a new **WebSocket Request** in Postman
2. Set the URL to: `ws://localhost:3000`
3. Click **Connect**
4. Once connected, send this message (replace `fileId` with the one from Step 1):
```json
{
  "type": "START_PROCESS",
  "fileId": "abc123def456..."
}
```

**Expected Response Messages:**
```json
{"type":"INFO","message":"Starting processing..."}
{"type":"RECIPE_COMPLETE","result":{"recipe_name":"...","allergens":[...],...}}
{"type":"DONE","message":"All recipes processed."}
```

### Alternative: Using wscat (CLI Tool)

If you prefer command-line:

```bash
# Install wscat
npm install -g wscat

# Connect to WebSocket
wscat -c ws://localhost:3000

# Send message (after connecting)
{"type":"START_PROCESS","fileId":"abc123def456..."}
```

---

## Excel File Format

The expected format (Column A = Recipe Name, Column B = Ingredient):

| Product Name | Ingredient |
|--------------|------------|
| Margarita Pizza | wheat flour |
| Margarita Pizza | mozzarella cheese |
| Margarita Pizza | tomato sauce |
| Caesar Salad | romaine lettuce |
| Caesar Salad | parmesan cheese |
| Caesar Salad | croutons |

---
