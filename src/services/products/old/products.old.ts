import { and, eq, count, not, asc } from "drizzle-orm";
import { oldDb } from "../../../db/config/old";
import { product, history } from "../../../db/schemas/old";
import { hasJsonData, getOldProductsFromJson, getOldProductsCountFromJson } from "./products-json";

/**
 * Get products - uses JSON if available (PHASE 2), otherwise queries DB (PHASE 1)
 */
export const getOldProducts = async (params: { take: number, skip: number }) => {
    const { take, skip } = params;

    // Use JSON if available (faster, doesn't hit DB during multi-worker migration)
    if (hasJsonData()) {
        return getOldProductsFromJson({ take, skip });
    }

    // Fallback to database query (used during extraction phase)
    const products = await oldDb.select().from(product)
        .where(not(eq(product.platform, 'rocketfy')))
        .orderBy(asc(product.createdAt), asc(product.uuid))
        .limit(take)
        .offset(skip);
    return products;
}

/**
 * Get count - uses JSON metadata if available, otherwise queries DB
 */
export const getOldProductsCount = async () => {
    // Use JSON metadata if available (instant)
    if (hasJsonData()) {
        const count = getOldProductsCountFromJson();
        console.log(`[getOldProductsCount] Using JSON metadata: ${count} products`);
        return count;
    }

    // Fallback to database count (slow)
    console.log('[getOldProductsCount] Querying database for count...');
    try {
        const result = await oldDb.select({ count: count() }).from(product)
            .where(not(eq(product.platform, 'rocketfy')));
        console.log('[getOldProductsCount] Count query completed:', result[0]?.count || 0);
        return result[0]?.count || 0;
    } catch (error) {
        console.error('[getOldProductsCount] Error during count query:', error);
        throw error;
    }
}

export const getOldHistory = async (params: { externalProductId: string, country: string, platform: string }) => {
    const { externalProductId, country, platform } = params;
    const histories = await oldDb.select().from(history).where(
        and(
            eq(history.externalProductId, externalProductId),
            eq(history.country, country),
            eq(history.platform, platform)
        )
    );
    return histories;
}