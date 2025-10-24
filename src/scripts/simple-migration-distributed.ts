#!/usr/bin/env bun

/**
 * Distributed Simple Migration Script usando BaseMigration
 *
 * Funcionalidades:
 * 1. Crear proveedores desde el JSON del producto
 * 2. Crear/actualizar productos
 * 3. Detectar gaps en historiales y crear días faltantes
 * 4. Migrar multimedia desde el campo gallery JSON
 * 5. Procesamiento distribuido con múltiples workers
 */

import { eq, and, inArray, ne, desc } from "drizzle-orm";
import { productsDb } from "../db/config/products";
import { oldDb } from "../db/config/old";
import { getPlatformCountryId } from "../services/products";
import { getBaseCategoryByName } from "../services/products/categories";
import { BaseMigration, type ChunkState, type ChunkResult, type MigrationConfig } from "./BaseMigration";

// Schemas
import { products, histories, providers, multimedia, PlatformType, Countries } from "../db/schemas/products";
import { product as oldProduct, history as oldHistory } from "../db/schemas/old/schema";

// Configuration
const TEST_MODE = process.env.TEST_MODE === 'true';
const TEST_LIMIT = 20;

const MIGRATION_CONFIG: MigrationConfig = {
    stateKey: "simple_migration_state",
    chunksKey: "simple_migration_chunks",
    lockPrefix: "simple_migration_lock:",
    batchSize: 10, // Productos por batch dentro de cada chunk
    chunkSize: 100, // Productos por chunk
    lockTTL: 600, // 10 minutos
    lockRenewInterval: 240000 // 4 minutos
};

// Mapear plataforma string a PlatformType enum
function mapPlatformToPlatformType(platform: string): PlatformType {
    switch (platform.toLowerCase()) {
        case 'dropi':
            return PlatformType.DROPI;
        case 'aliclick':
            return PlatformType.ALICLICK;
        case 'droplatam':
            return PlatformType.DROPLATAM;
        case 'seventy block':
            return PlatformType.SEVENTY_BLOCK;
        default:
            console.warn(`Unknown platform: ${platform}, defaulting to DROPI`);
            return PlatformType.DROPI;
    }
}

/**
 * Simple Migration usando BaseMigration para procesamiento distribuido
 */
export class SimpleMigration extends BaseMigration {
    private processedUUIDs = new Set<string>();

    constructor() {
        super(MIGRATION_CONFIG);
    }

    /**
     * Obtener total de productos a migrar
     */
    protected async getTotalRecords(): Promise<number> {
        this.log('Fetching ALL products from old database...');

        if (TEST_MODE) {
            this.log(`🧪 TEST MODE: Limited to ${TEST_LIMIT} products`);
            return TEST_LIMIT;
        }

        const result = await oldDb
            .select({ count: oldProduct.uuid })
            .from(oldProduct)
            .where(ne(oldProduct.platform, 'rocketfy'));

        const count = result.length;
        this.log(`Found ${count} total products in old database${TEST_MODE ? ' (TEST MODE)' : ''}`);
        return count;
    }

    /**
     * Procesar un chunk de productos
     */
    protected async processChunk(chunk: ChunkState): Promise<ChunkResult> {
        this.log(`Processing chunk ${chunk.chunkId} (offset ${chunk.startOffset}-${chunk.endOffset})`);

        // Obtener productos para este chunk ordenados por fecha
        let query = oldDb
            .select()
            .from(oldProduct)
            .where(ne(oldProduct.platform, 'rocketfy'))
            .orderBy(desc(oldProduct.updatedAt))
            .offset(chunk.startOffset)
            .limit(chunk.endOffset - chunk.startOffset);

        const products = await query;

        let stats = {
            processed: 0,
            providersCreated: 0,
            productsCreated: 0,
            productsUpdated: 0,
            historiesFilled: 0,
            multimediaCreated: 0,
            duplicatesSkipped: 0,
            errors: 0
        };

        // Procesar productos en mini-batches
        for (let i = 0; i < products.length; i += this.config.batchSize) {
            const batch = products.slice(i, i + this.config.batchSize);

            for (const oldProd of batch) {
                try {
                    // Verificar duplicados
                    if (this.processedUUIDs.has(oldProd.uuid)) {
                        stats.duplicatesSkipped++;
                        this.log(`⏭️ Duplicate UUID skipped [UUID: ${oldProd.uuid}] - External ID: ${oldProd.externalId}`);
                        continue;
                    }

                    this.processedUUIDs.add(oldProd.uuid);

                    // 1. Crear/actualizar proveedor
                    const providerId = await this.createOrUpdateProvider(oldProd);
                    if (providerId) stats.providersCreated++;

                    // 2. Crear/actualizar producto
                    const result = await this.createOrUpdateProduct(oldProd, providerId);
                    if (!result) {
                        stats.errors++;
                        continue;
                    }

                    const { productId, created } = result;
                    if (created) {
                        stats.productsCreated++;
                    } else {
                        stats.productsUpdated++;
                    }

                    // 3. Llenar gaps en historiales
                    const historiesCount = await this.fillHistoryGaps(oldProd, productId);
                    stats.historiesFilled += historiesCount;

                    // 4. Migrar multimedia
                    const multimediaCount = await this.migrateMultimedia(oldProd, productId);
                    stats.multimediaCreated += multimediaCount;

                    stats.processed++;

                } catch (error) {
                    stats.errors++;
                    this.logError(`Error processing product [UNIQUE_ID: ${oldProd.externalId}]:`, error);
                }
            }
        }

        this.log(`Chunk ${chunk.chunkId} completed: ${stats.processed} processed, ${stats.errors} errors, ${stats.duplicatesSkipped} duplicates skipped`);
        return stats;
    }

    /**
     * Hook personalizado para métricas adicionales
     */
    protected getCustomProgress(): Record<string, any> {
        return {
            migrationDate: new Date().toISOString().split('T')[0],
            totalDuplicatesSkipped: this.processedUUIDs.size
        };
    }

    /**
     * Crear/actualizar proveedor desde los datos JSON del producto
     */
    private async createOrUpdateProvider(productData: any): Promise<string | null> {
        try {
            if (!productData.provider || typeof productData.provider !== 'object') {
                return null;
            }

            const providerData = productData.provider;
            const providerName = providerData.name || providerData.provider_name || 'Unknown Provider';
            const providerExternalId = providerData.external_id || providerData.providerId || providerData.id || `provider_${productData.externalId}`;

            // Usar la función correcta para obtener platformCountryId
            const platformType = mapPlatformToPlatformType(productData.platform);
            let countryCode = productData.country;

            // Manejar casos especiales de país
            if (countryCode === 'CO1') {
                countryCode = 'CO';
            }

            countryCode = countryCode as keyof typeof Countries;

            let platformCountryId: string;
            try {
                platformCountryId = await getPlatformCountryId({
                    countryCode,
                    platformId: platformType
                });
            } catch (error) {
                this.logError(`Platform country not found for platform ${productData.platform} and country ${productData.country}:`, error);
                return null;
            }

            // Verificar si el proveedor ya existe
            const existingProvider = await productsDb
                .select()
                .from(providers)
                .where(
                    and(
                        eq(providers.externalId, providerExternalId),
                        eq(providers.platformCountryId, platformCountryId)
                    )
                )
                .limit(1);

            const providerId = `${providerExternalId}_${platformCountryId}`;

            if (existingProvider.length === 0) {
                // Crear nuevo proveedor
                const newProvider = {
                    id: providerId,
                    name: providerName,
                    externalId: providerExternalId,
                    verified: providerData.verified || false,
                    platformCountryId: platformCountryId,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString()
                };

                await productsDb.insert(providers).values(newProvider);
            } else {
                // Actualizar proveedor existente
                await productsDb
                    .update(providers)
                    .set({
                        name: providerName,
                        verified: providerData.verified || false,
                        updatedAt: new Date().toISOString()
                    })
                    .where(eq(providers.id, existingProvider[0].id));
            }

            return providerId;

        } catch (error) {
            this.logError(`Error creating/updating provider for product ${productData.externalId}:`, error);
            return null;
        }
    }

    /**
     * Crear/actualizar producto
     */
    private async createOrUpdateProduct(productData: any, providerId: string | null): Promise<{ productId: string; created: boolean } | null> {
        try {
            // Si no hay providerId, no podemos crear el producto
            if (!providerId) {
                this.logError(`Cannot create product [UNIQUE_ID: ${productData.externalId}] - No provider ID`);
                return null;
            }

            // Usar la función correcta para obtener platformCountryId
            const platformType = mapPlatformToPlatformType(productData.platform);
            let countryCode = productData.country;

            // Manejar casos especiales de país
            if (countryCode === 'CO1') {
                countryCode = 'CO';
            }

            countryCode = countryCode as keyof typeof Countries;

            let platformCountryId: string;
            try {
                platformCountryId = await getPlatformCountryId({
                    countryCode,
                    platformId: platformType
                });
            } catch (error) {
                this.logError(`Platform country not found for platform ${productData.platform} and country ${productData.country}:`, error);
                return null;
            }

            // Verificar si el producto ya existe (por UUID único)
            const existingProduct = await productsDb
                .select()
                .from(products)
                .where(eq(products.id, productData.uuid))
                .limit(1);

            // Usar el UUID original del producto de la base vieja
            const productId = productData.uuid;

            // Obtener categoría correcta
            let baseCategoryId = "09ad0d8c-9f58-45f8-8168-935b890ee70b"; // Fallback
            try {
                if (productData.categories && Array.isArray(productData.categories) && productData.categories.length > 0) {
                    const firstCategory = productData.categories[0];
                    if (firstCategory && firstCategory.name) {
                        baseCategoryId = await getBaseCategoryByName(firstCategory.name);
                    }
                }
            } catch (error) {
                console.warn(`Category error for product ${productData.externalId}, using fallback:`, error);
            }

            const productPayload = {
                id: productId,
                externalId: productData.externalId,
                name: productData.name || 'Sin nombre',
                description: productData.description || undefined,
                salePrice: productData.salePrice || 0,
                suggestedPrice: productData.suggestedPrice || 0,
                totalBilling: productData.totalSalesAmount || 0,
                billingLast7Days: productData.salesLast7Days || 0,
                billingLast30Days: productData.salesLast30Days || 0,
                totalSoldUnits: productData.totalSoldUnits || 0,
                soldUnitsLast7Days: productData.soldUnitsLast7Days || 0,
                soldUnitsLast30Days: productData.soldUnitsLast30Days || 0,
                stock: productData.stock || 0,
                variationsAmount: productData.variationsAmount || 0,
                score: productData.score || 0,
                status: (productData.visible ? 'ACTIVE' : 'INACTIVE') as 'ACTIVE' | 'INACTIVE',
                platformCountryId: platformCountryId,
                providerId: providerId,
                baseCategoryId: baseCategoryId,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };

            if (existingProduct.length === 0) {
                // Crear nuevo producto
                await productsDb.insert(products).values(productPayload);
                return { productId, created: true };
            } else {
                // Actualizar producto existente
                await productsDb
                    .update(products)
                    .set({
                        name: productPayload.name,
                        description: productPayload.description,
                        salePrice: productPayload.salePrice,
                        suggestedPrice: productPayload.suggestedPrice,
                        totalBilling: productPayload.totalBilling,
                        billingLast7Days: productPayload.billingLast7Days,
                        billingLast30Days: productPayload.billingLast30Days,
                        totalSoldUnits: productPayload.totalSoldUnits,
                        soldUnitsLast7Days: productPayload.soldUnitsLast7Days,
                        soldUnitsLast30Days: productPayload.soldUnitsLast30Days,
                        stock: productPayload.stock,
                        variationsAmount: productPayload.variationsAmount,
                        score: productPayload.score,
                        status: productPayload.status,
                        providerId: productPayload.providerId,
                        baseCategoryId: productPayload.baseCategoryId,
                        updatedAt: productPayload.updatedAt
                    })
                    .where(eq(products.id, existingProduct[0].id));

                return { productId, created: false };
            }

        } catch (error) {
            this.logError(`Error creating/updating product [UNIQUE_ID: ${productData.externalId}] - Platform: ${productData.platform}, Country: ${productData.country}:`, error);
            return null;
        }
    }

    /**
     * Detectar gaps en historiales y crear días faltantes
     */
    private async fillHistoryGaps(productData: any, productId: string): Promise<number> {
        try {
            // Obtener fechas existentes en la nueva base para este producto
            const existingHistories = await productsDb
                .select({ date: histories.date })
                .from(histories)
                .where(eq(histories.productId, productId));

            const existingDatesSet = new Set(existingHistories.map(h => h.date));

            // Obtener todas las fechas de la base vieja para este producto
            const allOldHistories = await oldDb
                .select({ date: oldHistory.date })
                .from(oldHistory)
                .where(
                    and(
                        eq(oldHistory.externalProductId, productData.externalId),
                        eq(oldHistory.platform, productData.platform),
                        eq(oldHistory.country, productData.country)
                    )
                );

            // Encontrar fechas faltantes
            const missingDates = allOldHistories
                .map(h => h.date)
                .filter(date => !existingDatesSet.has(date));

            if (missingDates.length === 0) {
                return 0;
            }

            // Obtener datos históricos completos para las fechas faltantes
            const missingHistoriesData = await oldDb
                .select()
                .from(oldHistory)
                .where(
                    and(
                        eq(oldHistory.externalProductId, productData.externalId),
                        eq(oldHistory.platform, productData.platform),
                        eq(oldHistory.country, productData.country),
                        inArray(oldHistory.date, missingDates.slice(0, 1000)) // Limitar para evitar overflow
                    )
                );

            // Crear registros de historial ordenados por fecha
            const historiesToInsert = missingHistoriesData
                .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()) // Ordenar por fecha ascendente
                .map(h => ({
                    id: `${productId}_${h.date}`,
                    date: h.date,
                    stock: h.stock || 0,
                    salePrice: h.salePrice || 0,
                    suggestedPrice: productData.suggestedPrice || 0,
                    soldUnits: h.soldUnits || 0,
                    soldUnitsLast7Days: 0,
                    soldUnitsLast30Days: 0,
                    totalSoldUnits: productData.totalSoldUnits || 0,
                    billing: h.salesAmount || 0,
                    billingLast7Days: 0,
                    billingLast30Days: 0,
                    totalBilling: productData.totalSalesAmount || 0,
                    stockAdjustment: h.stockAdjustment || false,
                    productId: productId,
                    stockAdjustmentReason: h.stockAdjustmentReason || null,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString()
                }));

            // Update the last history record (most recent date) with current product stats
            if (historiesToInsert.length > 0) {
                const lastHistoryByDate = historiesToInsert[historiesToInsert.length - 1]; // El último por fecha después del sort
                if (lastHistoryByDate) {
                    lastHistoryByDate.suggestedPrice = productData.suggestedPrice || 0;
                    lastHistoryByDate.soldUnitsLast7Days = productData.soldUnitsLast7Days || 0;
                    lastHistoryByDate.soldUnitsLast30Days = productData.soldUnitsLast30Days || 0;
                    lastHistoryByDate.totalSoldUnits = productData.totalSoldUnits || 0;
                    lastHistoryByDate.billingLast7Days = productData.salesLast7Days || 0;
                    lastHistoryByDate.billingLast30Days = productData.salesLast30Days || 0;
                    lastHistoryByDate.totalBilling = productData.totalSalesAmount || 0;
                }

                await productsDb.insert(histories).values(historiesToInsert);
            }

            return historiesToInsert.length;

        } catch (error) {
            this.logError(`Error updating history for product [UNIQUE_ID: ${productData.externalId}] - Platform: ${productData.platform}, Country: ${productData.country}:`, error);
            return 0;
        }
    }

    /**
     * Migrar multimedia desde gallery JSON
     */
    private async migrateMultimedia(productData: any, productId: string): Promise<number> {
        try {
            if (!productData.gallery || typeof productData.gallery !== 'object') {
                return 0;
            }

            // Eliminar multimedia existente para este producto
            await productsDb
                .delete(multimedia)
                .where(eq(multimedia.productId, productId));

            const gallery = Array.isArray(productData.gallery) ? productData.gallery : [productData.gallery];

            if (gallery.length === 0) {
                return 0;
            }

            // Crear registros de multimedia
            const multimediaItems = gallery
                .filter((item: any) => item && (item.url || item.originalUrl))
                .map((item: any, index: number) => {
                    let url = item.url || item.originalUrl;

                    // Apply URL completion logic: SOLO concatenar si NO empieza con https://
                    // Las URLs que ya tienen https:// se guardan tal cual
                    if (url && !url.startsWith('https://') && /^[a-z]+\//.test(url)) {
                        url = 'https://d39ru7awumhhs2.cloudfront.net/' + url;
                    }
                    // Si ya tiene https://, se guarda sin modificar

                    return {
                        id: `${productId}_media_${index}`,
                        type: item.type || 'image',
                        url: url,
                        originalUrl: url, // Misma URL después de procesarla
                        productId: productId,
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString()
                    };
                });

            if (multimediaItems.length > 0) {
                await productsDb.insert(multimedia).values(multimediaItems);
            }

            return multimediaItems.length;

        } catch (error) {
            this.logError(`Error updating multimedia for product [UNIQUE_ID: ${productId}] - Platform: ${productData.platform}, Country: ${productData.country}:`, error);
            return 0;
        }
    }
}

/**
 * Función principal
 */
async function main() {
    const migration = new SimpleMigration();

    try {
        console.log(`🚀 Starting distributed simple migration...`);
        console.log(`Mode: ${TEST_MODE ? 'TEST (limited)' : 'PRODUCTION (complete)'}`);
        console.log(`Worker ID: ${process.env.WORKER_ID || 'auto-generated'}`);

        await migration.execute();

        console.log(`✅ Migration completed successfully!`);
        process.exit(0);

    } catch (error) {
        console.error("Fatal error in migration:", error);
        process.exit(1);
    }
}

// Handle signals
process.on('SIGINT', () => {
    console.log('Received SIGINT, shutting down gracefully...');
    process.exit(130);
});

process.on('SIGTERM', () => {
    console.log('Received SIGTERM, shutting down gracefully...');
    process.exit(143);
});

// Start migration
main().catch((error) => {
    console.error('Fatal error in main function:', error);
    process.exit(1);
});