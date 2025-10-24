import { eq, sql, and, desc, max } from "drizzle-orm";
import { productsDb } from "../db/config/products";
import { oldDb } from "../db/config/old";
import { products, histories, providers, multimedia, type InsertHistory, type InsertProduct, type InsertProvider } from "../db/schemas/products";
import { history as oldHistory, product as oldProduct } from "../db/schemas/old/schema";
import { createHistoriesBatch } from "../services/products/histories";
import { createProductsBatch } from "../services/products/products";
import { createProvider } from "../services/products/providers";
import { getPlatformCountryId } from "../services/products";
import { getBaseCategoryByName } from "../services/products/categories";
import { BaseMigration, type ChunkState, type ChunkResult, type MigrationConfig } from "./BaseMigration";

const BATCH_SIZE = 50;
const TEST_MODE = process.env.TEST_MODE === 'true';
const TEST_PRODUCTS_LIMIT = 10;

// Use the same CloudFront URL completion logic as the existing project

interface UpdatedProduct {
    uuid: string;
    externalId: string;
    name: string;
    description?: string;
    salePrice: number;
    suggestedPrice: number;
    totalSalesAmount: number;
    salesLast7Days: number;
    salesLast30Days: number;
    totalSoldUnits: number;
    soldUnitsLast7Days: number;
    soldUnitsLast30Days: number;
    stock: number;
    variationsAmount: number;
    score: number;
    visible: boolean;
    country: string;
    platform: string;
    categories: any;
    provider: any;
    gallery: any;
    updatedAt: string;
    createdAt: string;
}

interface DailyMigrationResult extends ChunkResult {
    updatedProducts: number;
    newProducts: number;
    updatedHistories: number;
    updatedMultimedia: number;
    errors: number;
}

/**
 * Daily Migration - extends BaseMigration for daily incremental updates
 */
class DailyMigration extends BaseMigration<UpdatedProduct> {
    private updatedProducts: UpdatedProduct[] = [];
    private readonly yesterdayDate: string;

    constructor() {
        const config: MigrationConfig = {
            stateKey: "daily_migration_state",
            chunksKey: "daily_migration_chunks",
            lockPrefix: "daily_migration_lock:",
            batchSize: BATCH_SIZE,
            chunkSize: TEST_MODE ? 5 : 100,
            lockTTL: 600
        };
        super(config);

        // Calculate yesterday's date for incremental migration
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        this.yesterdayDate = yesterday.toISOString().split('T')[0];

        this.log(`Daily migration configured for date: ${this.yesterdayDate}`);
    }

    /**
     * Get ALL products from old database
     */
    private async getUpdatedProducts(): Promise<UpdatedProduct[]> {
        this.log(`Fetching ALL products from old database...`);

        if (TEST_MODE) {
            this.log(`🧪 TEST MODE: Limited to ${TEST_PRODUCTS_LIMIT} products`);
        }

        try {
            // Get ALL products, excluding rocketfy platform
            let query = oldDb
                .select()
                .from(oldProduct)
                .where(sql`${oldProduct.platform} != 'rocketfy'`);

            if (TEST_MODE) {
                query = query.limit(TEST_PRODUCTS_LIMIT);
            }

            const allProducts = await query;

            this.log(`Found ${allProducts.length} total products in old database${TEST_MODE ? ' (TEST MODE)' : ''}`);

            return allProducts.map(product => ({
                uuid: product.uuid,
                externalId: product.externalId,
                name: product.name,
                description: product.description || undefined,
                salePrice: product.salePrice,
                suggestedPrice: product.suggestedPrice,
                totalSalesAmount: product.totalSalesAmount,
                salesLast7Days: product.salesLast7Days,
                salesLast30Days: product.salesLast30Days,
                totalSoldUnits: product.totalSoldUnits,
                soldUnitsLast7Days: product.soldUnitsLast7Days,
                soldUnitsLast30Days: product.soldUnitsLast30Days,
                stock: product.stock,
                variationsAmount: product.variationsAmount,
                score: product.score,
                visible: product.visible,
                country: product.country,
                platform: product.platform,
                categories: product.categories,
                provider: product.provider,
                gallery: product.gallery,
                updatedAt: product.updatedAt,
                createdAt: product.createdAt
            }));

        } catch (error) {
            this.logError(`Error fetching all products:`, error);
            return [];
        }
    }

    protected async getTotalRecords(): Promise<number> {
        this.updatedProducts = await this.getUpdatedProducts();
        return this.updatedProducts.length;
    }

    protected async processChunk(chunk: ChunkState): Promise<DailyMigrationResult> {
        this.log(`Processing daily migration chunk ${chunk.chunkId} (offset ${chunk.startOffset}-${chunk.endOffset})`);

        const chunkProducts = this.updatedProducts.slice(chunk.startOffset, chunk.endOffset);
        let updatedProducts = 0;
        let newProducts = 0;
        let updatedHistories = 0;
        let updatedMultimedia = 0;
        let errors = 0;

        for (const oldProduct of chunkProducts) {
            try {
                const result = await this.processProduct(oldProduct);
                updatedProducts += result.updatedProducts;
                newProducts += result.newProducts;
                updatedHistories += result.updatedHistories;
                updatedMultimedia += result.updatedMultimedia;
                errors += result.errors;

            } catch (error) {
                this.logError(`Error processing product [UNIQUE_ID: ${oldProduct.externalId}] - Platform: ${oldProduct.platform}, Country: ${oldProduct.country}:`, error);
                errors++;
            }
        }

        return {
            processed: chunkProducts.length,
            updatedProducts,
            newProducts,
            updatedHistories,
            updatedMultimedia,
            errors
        };
    }

    protected getCustomProgress(): Record<string, any> {
        return {
            migrationDate: this.yesterdayDate,
            totalUpdatedProducts: this.updatedProducts.length
        };
    }

    /**
     * Process a single product - update or create
     */
    private async processProduct(oldProduct: UpdatedProduct): Promise<{
        updatedProducts: number;
        newProducts: number;
        updatedHistories: number;
        updatedMultimedia: number;
        errors: number;
    }> {
        try {
            // Check if product exists in new database
            const existingProduct = await productsDb
                .select()
                .from(products)
                .where(eq(products.id, oldProduct.uuid))
                .limit(1);

            let isNewProduct = existingProduct.length === 0;
            let updatedProducts = 0;
            let newProducts = 0;

            if (isNewProduct) {
                // Create new product
                await this.createNewProduct(oldProduct);
                newProducts = 1;
                this.log(`Created new product [UNIQUE_ID: ${oldProduct.externalId}] - Platform: ${oldProduct.platform}, Country: ${oldProduct.country}`);
            } else {
                // Update existing product - external ID can be repeated across platform/country combinations
                await this.updateExistingProduct(oldProduct);
                updatedProducts = 1;
                this.log(`Updated existing product [UNIQUE_ID: ${oldProduct.externalId}] - Platform: ${oldProduct.platform}, Country: ${oldProduct.country} (External ID reused)`);
            }

            // Update histories (always check for new history data)
            const updatedHistories = await this.updateProductHistory(oldProduct);

            // Update multimedia
            const updatedMultimedia = await this.updateProductMultimedia(oldProduct);

            return {
                updatedProducts,
                newProducts,
                updatedHistories,
                updatedMultimedia,
                errors: 0
            };

        } catch (error) {
            this.logError(`Error in processProduct for [UNIQUE_ID: ${oldProduct.externalId}] - Platform: ${oldProduct.platform}, Country: ${oldProduct.country}:`, error);
            return {
                updatedProducts: 0,
                newProducts: 0,
                updatedHistories: 0,
                updatedMultimedia: 0,
                errors: 1
            };
        }
    }

    /**
     * Create a new product with all required relationships
     */
    private async createNewProduct(oldProduct: UpdatedProduct): Promise<void> {
        // Parse provider data
        const providerData = typeof oldProduct.provider === 'string'
            ? JSON.parse(oldProduct.provider)
            : oldProduct.provider;

        if (!providerData?.name || !providerData?.externalId) {
            throw new Error(`Invalid provider data for product ${oldProduct.externalId}`);
        }

        // Get platform country ID
        const platformType = this.mapPlatformToPlatformType(oldProduct.platform);
        const platformCountryId = await getPlatformCountryId({
            countryCode: oldProduct.country as any,
            platformId: platformType
        });

        if (!platformCountryId) {
            throw new Error(`Platform country not found for ${oldProduct.country}-${oldProduct.platform}`);
        }

        // Find or create provider
        let provider = await this.findOrCreateProvider(providerData, platformCountryId);

        // Parse and get category
        const categoriesData = typeof oldProduct.categories === 'string'
            ? JSON.parse(oldProduct.categories)
            : oldProduct.categories;

        if (!categoriesData || categoriesData.length === 0) {
            throw new Error(`No categories for product ${oldProduct.externalId}`);
        }

        const firstCategory = categoriesData[0];
        if (!firstCategory?.name) {
            throw new Error(`No valid category name for product ${oldProduct.externalId}`);
        }

        const baseCategoryId = await getBaseCategoryByName(firstCategory.name, platformType);

        // Create product
        const productToInsert = {
            id: oldProduct.uuid,
            externalId: oldProduct.externalId,
            name: oldProduct.name,
            description: oldProduct.description || null,
            salePrice: oldProduct.salePrice,
            suggestedPrice: oldProduct.suggestedPrice,
            totalBilling: oldProduct.totalSalesAmount,
            billingLast7Days: oldProduct.salesLast7Days,
            billingLast30Days: oldProduct.salesLast30Days,
            totalSoldUnits: oldProduct.totalSoldUnits,
            soldUnitsLast7Days: oldProduct.soldUnitsLast7Days,
            soldUnitsLast30Days: oldProduct.soldUnitsLast30Days,
            stock: oldProduct.stock,
            variationsAmount: oldProduct.variationsAmount,
            score: oldProduct.score,
            status: (oldProduct.visible ? 'ACTIVE' : 'INACTIVE') as 'ACTIVE' | 'INACTIVE',
            platformCountryId: platformCountryId,
            baseCategoryId: baseCategoryId,
            providerId: provider.id,
            createdAt: oldProduct.createdAt,
            updatedAt: oldProduct.updatedAt
        };

        await createProductsBatch({
            platformCountryId,
            productsToInsert: [productToInsert]
        });
    }

    /**
     * Update an existing product
     */
    private async updateExistingProduct(oldProduct: UpdatedProduct): Promise<void> {
        const updateData = {
            name: oldProduct.name,
            description: oldProduct.description || null,
            salePrice: oldProduct.salePrice,
            suggestedPrice: oldProduct.suggestedPrice,
            totalBilling: oldProduct.totalSalesAmount,
            billingLast7Days: oldProduct.salesLast7Days,
            billingLast30Days: oldProduct.salesLast30Days,
            totalSoldUnits: oldProduct.totalSoldUnits,
            soldUnitsLast7Days: oldProduct.soldUnitsLast7Days,
            soldUnitsLast30Days: oldProduct.soldUnitsLast30Days,
            stock: oldProduct.stock,
            variationsAmount: oldProduct.variationsAmount,
            score: oldProduct.score,
            status: (oldProduct.visible ? 'ACTIVE' : 'INACTIVE') as 'ACTIVE' | 'INACTIVE',
            updatedAt: oldProduct.updatedAt || new Date().toISOString()
        };

        await productsDb
            .update(products)
            .set(updateData)
            .where(eq(products.id, oldProduct.uuid));
    }

    /**
     * Update product history - identify gaps and fetch missing history records
     */
    private async updateProductHistory(oldProduct: UpdatedProduct): Promise<number> {
        try {
            // Get existing history dates in the new database for this product
            const existingHistoryDates = await productsDb
                .select({ date: histories.date })
                .from(histories)
                .where(eq(histories.productId, oldProduct.uuid))
                .orderBy(histories.date);

            // Get all available history dates from old database for this product
            const allOldHistoryDates = await oldDb
                .select({ date: oldHistory.date })
                .from(oldHistory)
                .where(and(
                    eq(oldHistory.externalProductId, oldProduct.externalId),
                    eq(oldHistory.country, oldProduct.country),
                    eq(oldHistory.platform, oldProduct.platform)
                ))
                .orderBy(oldHistory.date);

            if (allOldHistoryDates.length === 0) {
                return 0;
            }

            // Convert existing dates to Set for faster lookup
            const existingDatesSet = new Set(
                existingHistoryDates.map(h => {
                    if (!h.date) return '';
                    const date = typeof h.date === 'string' ? h.date : new Date(h.date).toISOString().split('T')[0];
                    return date;
                })
            );

            // Find missing dates (dates that exist in old DB but not in new DB)
            const missingDates = allOldHistoryDates
                .map(h => h.date)
                .filter(date => !existingDatesSet.has(date));

            if (missingDates.length === 0) {
                this.log(`No missing history dates for product [UNIQUE_ID: ${oldProduct.externalId}] - Platform: ${oldProduct.platform}, Country: ${oldProduct.country}`);
                return 0;
            }

            this.log(`Found ${missingDates.length} missing history dates for product [UNIQUE_ID: ${oldProduct.externalId}] - Platform: ${oldProduct.platform}, Country: ${oldProduct.country}`);

            // Limit missing dates to prevent SQL parameter overflow (max 1000 dates per batch)
            const batchSize = 1000;
            let allMissingHistories = [];

            for (let i = 0; i < missingDates.length; i += batchSize) {
                const datesBatch = missingDates.slice(i, i + batchSize);

                const batchHistories = await oldDb
                    .select()
                    .from(oldHistory)
                    .where(and(
                        eq(oldHistory.externalProductId, oldProduct.externalId),
                        eq(oldHistory.country, oldProduct.country),
                        eq(oldHistory.platform, oldProduct.platform),
                        sql`${oldHistory.date} = ANY(ARRAY[${datesBatch.map(d => `'${d}'`).join(',')}])`
                    ))
                    .orderBy(oldHistory.date);

                allMissingHistories.push(...batchHistories);
            }

            const missingHistories = allMissingHistories;

            if (missingHistories.length === 0) {
                return 0;
            }

            // Transform to new format
            const historiesToInsert: InsertHistory[] = missingHistories.map(history => ({
                id: crypto.randomUUID(),
                date: history.date,
                stock: history.stock,
                salePrice: history.salePrice,
                suggestedPrice: oldProduct.suggestedPrice,
                soldUnits: history.soldUnits,
                soldUnitsLast7Days: oldProduct.soldUnitsLast7Days,
                soldUnitsLast30Days: oldProduct.soldUnitsLast30Days,
                totalSoldUnits: oldProduct.totalSoldUnits,
                billing: history.salesAmount,
                billingLast7Days: oldProduct.salesLast7Days,
                billingLast30Days: oldProduct.salesLast30Days,
                totalBilling: oldProduct.totalSalesAmount,
                stockAdjustment: history.stockAdjustment || false,
                stockAdjustmentReason: history.stockAdjustmentReason || null,
                productId: oldProduct.uuid,
                createdAt: history.date,
                updatedAt: new Date().toISOString()
            }));

            // Update the most recent history record with current product stats
            const sortedHistories = historiesToInsert.sort((a, b) => {
                const dateA = typeof a.date === 'string' ? new Date(a.date) : (a.date || new Date());
                const dateB = typeof b.date === 'string' ? new Date(b.date) : (b.date || new Date());
                return dateB.getTime() - dateA.getTime();
            });
            const mostRecentHistory = sortedHistories[0];
            if (mostRecentHistory) {
                mostRecentHistory.suggestedPrice = oldProduct.suggestedPrice;
                mostRecentHistory.soldUnitsLast7Days = oldProduct.soldUnitsLast7Days;
                mostRecentHistory.soldUnitsLast30Days = oldProduct.soldUnitsLast30Days;
                mostRecentHistory.totalSoldUnits = oldProduct.totalSoldUnits;
                mostRecentHistory.billingLast7Days = oldProduct.salesLast7Days;
                mostRecentHistory.billingLast30Days = oldProduct.salesLast30Days;
                mostRecentHistory.totalBilling = oldProduct.totalSalesAmount;
            }

            await createHistoriesBatch(historiesToInsert);
            this.log(`✓ Filled ${historiesToInsert.length} missing history gaps for product [UNIQUE_ID: ${oldProduct.externalId}] - Platform: ${oldProduct.platform}, Country: ${oldProduct.country}`);
            return historiesToInsert.length;

        } catch (error) {
            this.logError(`Error updating history for product [UNIQUE_ID: ${oldProduct.externalId}] - Platform: ${oldProduct.platform}, Country: ${oldProduct.country}:`, error);
            return 0;
        }
    }

    /**
     * Update product multimedia following the same logic as multimedia migration services
     */
    private async updateProductMultimedia(oldProduct: UpdatedProduct): Promise<number> {
        try {
            // Parse gallery JSON with robust validation (same as multimedia services)
            let galleryData: any[];
            try {
                // Limpiar y validar el JSON antes de parsearlo
                let galleryString = oldProduct.gallery as string;

                // Verificar que sea un string válido y no esté vacío
                if (typeof galleryString !== 'string' || galleryString.trim().length === 0) {
                    return 0;
                }

                // Limpiar datos
                galleryString = galleryString.trim();

                // Verificar que sea un array JSON válido
                if (!galleryString.startsWith('[') || !galleryString.endsWith(']')) {
                    return 0;
                }

                galleryData = JSON.parse(galleryString);
            } catch (parseError) {
                return 0;
            }

            if (!Array.isArray(galleryData) || galleryData.length === 0) {
                return 0;
            }

            // Filtrar solo elementos válidos (same as multimedia services)
            const validGalleryItems = galleryData.filter(item =>
                item &&
                typeof item === 'object' &&
                (item.url || item.sourceUrl)
            );

            if (validGalleryItems.length === 0) {
                return 0;
            }

            // Delete existing multimedia
            await productsDb
                .delete(multimedia)
                .where(eq(multimedia.productId, oldProduct.uuid));

            // Create multimedia items from gallery data (following exact pattern)
            const multimediaItems = [];
            const now = new Date().toISOString();

            for (const item of validGalleryItems) {
                const crypto = require('crypto');
                const multimediaId = crypto.randomUUID();

                // Process and complete the URL (exact same logic)
                let url = item.url || '';
                const originalUrl = item.sourceUrl || url;

                // Apply URL completion logic: SOLO concatenar si NO empieza con https://
                // Las URLs que ya tienen https:// se guardan tal cual
                if (url && !url.startsWith('https://') && /^[a-z]+\//.test(url)) {
                    url = 'https://d39ru7awumhhs2.cloudfront.net/' + url;
                }
                // Si ya tiene https://, se guarda sin modificar

                // Determine media type from URL (exact same logic)
                let type = 'image'; // Default type

                if (url.includes('.mp4') || url.includes('.mov') || url.includes('.avi') || url.includes('.webm')) {
                    type = 'video';
                } else if (url.includes('.jpg') || url.includes('.jpeg') || url.includes('.png') ||
                           url.includes('.gif') || url.includes('.webp') || url.includes('.svg')) {
                    type = 'image';
                }

                multimediaItems.push({
                    id: multimediaId,
                    type: type,
                    url: url, // URL completa con CloudFront si es necesario
                    originalUrl: originalUrl, // URL original sin modificar
                    productId: oldProduct.uuid,
                    extracted: false,
                    createdAt: now,
                    updatedAt: now
                });
            }

            // Insert multimedia items in batch
            if (multimediaItems.length > 0) {
                await productsDb.insert(multimedia).values(multimediaItems);
                this.log(`✓ Inserted ${multimediaItems.length} multimedia items for product [UNIQUE_ID: ${oldProduct.externalId}] - Platform: ${oldProduct.platform}, Country: ${oldProduct.country}`);
                return multimediaItems.length;
            }

            return 0;

        } catch (error) {
            this.logError(`Error updating multimedia for product [UNIQUE_ID: ${oldProduct.externalId}] - Platform: ${oldProduct.platform}, Country: ${oldProduct.country}:`, error);
            return 0;
        }
    }

    /**
     * Find or create provider
     */
    private async findOrCreateProvider(providerData: any, platformCountryId: string): Promise<any> {
        // Try to find existing provider
        const existingProvider = await productsDb
            .select()
            .from(providers)
            .where(and(
                eq(providers.name, providerData.name),
                eq(providers.platformCountryId, platformCountryId)
            ))
            .limit(1);

        if (existingProvider.length > 0) {
            return existingProvider[0];
        }

        // Create new provider
        const newProvider = {
            id: crypto.randomUUID(),
            name: providerData.name,
            externalId: providerData.externalId,
            verified: providerData.verified || false,
            platformCountryId: platformCountryId,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        await createProvider(newProvider);

        return await productsDb
            .select()
            .from(providers)
            .where(and(
                eq(providers.name, providerData.name),
                eq(providers.platformCountryId, platformCountryId)
            ))
            .limit(1)
            .then(results => results[0]);
    }


    /**
     * Map platform string to PlatformType enum
     */
    private mapPlatformToPlatformType(platform: string): any {
        switch (platform.toLowerCase()) {
            case 'dropi':
                return 'DROPI';
            case 'aliclick':
                return 'ALICLICK';
            case 'droplatam':
                return 'DROPLATAM';
            case 'seventy block':
                return 'SEVENTY_BLOCK';
            default:
                console.warn(`Unknown platform: ${platform}, defaulting to DROPI`);
                return 'DROPI';
        }
    }
}

// Create singleton instance
const dailyMigration = new DailyMigration();

/**
 * Main daily migration function
 */
export const runDailyMigration = async () => {
    await dailyMigration.execute();
};

/**
 * Get progress of daily migration
 */
export const getDailyMigrationProgress = async () => {
    return await dailyMigration.getProgress();
};

/**
 * Reset daily migration progress
 */
export const resetDailyMigrationProgress = async () => {
    await dailyMigration.reset();
};