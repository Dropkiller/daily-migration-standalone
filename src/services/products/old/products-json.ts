import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { OldProduct } from '../../../db/schemas/old/schema';

const DATA_DIR = join(process.cwd(), 'data', 'products');
const JSON_FILE = join(DATA_DIR, 'all-products.json');

let allProductsCache: OldProduct[] | null = null;

/**
 * Convert snake_case JSON to camelCase OldProduct
 * JSON export uses snake_case, but Drizzle schema uses camelCase
 */
function convertSnakeToCamel(jsonProduct: any): OldProduct {
    return {
        uuid: jsonProduct.uuid,
        createdAt: jsonProduct.created_at,
        suggestedPrice: jsonProduct.suggested_price,
        country: jsonProduct.country,
        externalId: jsonProduct.external_id,
        name: jsonProduct.name,
        updatedAt: jsonProduct.updated_at,
        categories: jsonProduct.categories,
        salePrice: jsonProduct.sale_price,
        gallery: jsonProduct.gallery,
        provider: jsonProduct.provider,
        supplierVerified: jsonProduct.supplier_verified,
        totalSalesAmount: jsonProduct.total_sales_amount,
        totalSoldUnits: jsonProduct.total_sold_units,
        salesLast7Days: jsonProduct.sales_last_7_days,
        salesLast30Days: jsonProduct.sales_last_30_days,
        soldUnitsLast7Days: jsonProduct.sold_units_last_7_days,
        soldUnitsLast30Days: jsonProduct.sold_units_last_30_days,
        stock: jsonProduct.stock,
        profit: jsonProduct.profit,
        variationsAmount: jsonProduct.variations_amount,
        platform: jsonProduct.platform,
        visible: jsonProduct.visible,
        isFeatured: jsonProduct.is_featured,
        total: jsonProduct.total,
        description: jsonProduct.description,
        score: jsonProduct.score
    };
}

/**
 * Load all products from single JSON file
 */
function loadAllProducts(): OldProduct[] {
    if (allProductsCache) {
        return allProductsCache;
    }

    if (!existsSync(JSON_FILE)) {
        throw new Error(
            `Products JSON not found at: ${JSON_FILE}\n` +
            `Please export products from database to this file.`
        );
    }

    console.log(`[JSON] Loading all products from ${JSON_FILE}...`);
    const content = readFileSync(JSON_FILE, 'utf-8');
    const parsedData = JSON.parse(content);

    // Handle DBeaver format (wrapped in object) or direct array
    const products = Array.isArray(parsedData)
        ? parsedData
        : Object.values(parsedData)[0];

    if (!Array.isArray(products)) {
        throw new Error('Invalid JSON format - expected array of products');
    }

    // Filter out products without external_id and convert to camelCase
    const validProducts = products.filter((p: any) => {
        if (!p.external_id) {
            console.warn(`[JSON] Skipping product without external_id: ${p.uuid || p.name}`);
            return false;
        }
        return true;
    });

    // Convert all products from snake_case to camelCase
    allProductsCache = validProducts.map(p => convertSnakeToCamel(p));

    console.log(`[JSON] Loaded ${allProductsCache.length.toLocaleString()} products (filtered from ${products.length})`);

    return allProductsCache;
}

/**
 * Get products from JSON with pagination
 * Simple slice of the loaded array
 */
export const getOldProductsFromJson = (params: { take: number, skip: number }): OldProduct[] => {
    const { take, skip } = params;
    const allProducts = loadAllProducts();

    return allProducts.slice(skip, skip + take);
};

/**
 * Get total count from loaded JSON
 */
export const getOldProductsCountFromJson = (): number => {
    const allProducts = loadAllProducts();
    return allProducts.length;
};

/**
 * Check if JSON data exists
 */
export const hasJsonData = (): boolean => {
    return existsSync(JSON_FILE);
};

/**
 * Clear cache to free memory (optional)
 */
export const clearCache = (): void => {
    allProductsCache = null;
    console.log('[JSON] Cache cleared');
};
