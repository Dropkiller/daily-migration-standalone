#!/usr/bin/env bun

/**
 * Simple Migration Script - Migra datos de la base vieja a la nueva
 *
 * Funcionalidades:
 * 1. Crear proveedores desde el JSON del producto
 * 2. Crear/actualizar productos
 * 3. Detectar gaps en historiales y crear días faltantes
 * 4. Migrar multimedia desde el campo gallery JSON
 */

import { eq, and, inArray, ne, desc } from "drizzle-orm";
import { productsDb } from "../db/config/products";
import { oldDb } from "../db/config/old";
import { getPlatformCountryId } from "../services/products";
import { getBaseCategoryByName } from "../services/products/categories";

// Schemas
import { products, histories, providers, multimedia, PlatformType, Countries } from "../db/schemas/products";
import { product as oldProduct, history as oldHistory } from "../db/schemas/old/schema";

// Configuration
const BATCH_SIZE = 50;
const TEST_MODE = process.env.TEST_MODE === 'true';
const TEST_LIMIT = 20;

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
 * Logger con timestamp
 */
function log(message: string, data?: any) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${message}`);
    if (data) {
        console.log(`[${timestamp}] Data:`, JSON.stringify(data, null, 2));
    }
}

function logError(message: string, error?: any) {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] ERROR: ${message}`);
    if (error) {
        console.error(`[${timestamp}] Error details:`, error);
    }
}

/**
 * 1. Crear/actualizar proveedor desde los datos JSON del producto
 */
async function createOrUpdateProvider(productData: any): Promise<string | null> {
    try {
        if (!productData.provider || typeof productData.provider !== 'object') {
            log(`⚠️ No provider data for product [UNIQUE_ID: ${productData.externalId}]`);
            return null;
        }

        const providerData = productData.provider;
        const providerName = providerData.name || providerData.provider_name || 'Unknown Provider';
        const providerExternalId = providerData.external_id || providerData.providerId || providerData.id || `provider_${productData.externalId}`;

        // Usar la función correcta para obtener platformCountryId
        const platformType = mapPlatformToPlatformType(productData.platform);
        let countryCode = productData.country as keyof typeof Countries;

        // Manejar casos especiales de país
        if (countryCode === 'CO1') {
            countryCode = 'CO' as keyof typeof Countries;
        }

        let platformCountryId: string;
        try {
            platformCountryId = await getPlatformCountryId({
                countryCode,
                platformId: platformType
            });
        } catch (error) {
            logError(`Platform country not found for platform ${productData.platform} and country ${productData.country}:`, error);
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
            log(`✅ Provider created [UNIQUE_ID: ${providerExternalId}] - Platform: ${productData.platform}, Country: ${productData.country}`);
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

            log(`🔄 Provider updated [UNIQUE_ID: ${providerExternalId}] - Platform: ${productData.platform}, Country: ${productData.country}`);
        }

        return providerId;

    } catch (error) {
        logError(`Error creating/updating provider for product ${productData.externalId}:`, error);
        return null;
    }
}

/**
 * 2. Crear/actualizar producto
 */
async function createOrUpdateProduct(productData: any, providerId: string | null): Promise<string | null> {
    try {
        // Si no hay providerId, no podemos crear el producto
        if (!providerId) {
            logError(`Cannot create product [UNIQUE_ID: ${productData.externalId}] - No provider ID`);
            return null;
        }

        // Usar la función correcta para obtener platformCountryId
        const platformType = mapPlatformToPlatformType(productData.platform);
        let countryCode = productData.country as keyof typeof Countries;

        // Manejar casos especiales de país
        if (countryCode === 'CO1') {
            countryCode = 'CO' as keyof typeof Countries;
        }

        let platformCountryId: string;
        try {
            platformCountryId = await getPlatformCountryId({
                countryCode,
                platformId: platformType
            });
        } catch (error) {
            logError(`Platform country not found for platform ${productData.platform} and country ${productData.country}:`, error);
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
                    baseCategoryId = await getBaseCategoryByName(firstCategory.name, platformType);
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
            log(`✅ Product created [UNIQUE_ID: ${productData.externalId}] - Platform: ${productData.platform}, Country: ${productData.country}`);
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

            log(`🔄 Product updated [UNIQUE_ID: ${productData.externalId}] - Platform: ${productData.platform}, Country: ${productData.country} (External ID reused)`);
        }

        return productId;

    } catch (error) {
        logError(`Error creating/updating product [UNIQUE_ID: ${productData.externalId}] - Platform: ${productData.platform}, Country: ${productData.country}:`, error);
        return null;
    }
}

/**
 * 3. Detectar gaps en historiales y crear días faltantes
 */
async function fillHistoryGaps(productData: any, productId: string): Promise<number> {
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
            log(`No missing history dates for product [UNIQUE_ID: ${productId}] - Platform: ${productData.platform}, Country: ${productData.country}`);
            return 0;
        }

        log(`Found ${missingDates.length} missing history dates for product [UNIQUE_ID: ${productId}] - Platform: ${productData.platform}, Country: ${productData.country}`);

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
            log(`✓ Filled ${historiesToInsert.length} missing history gaps for product [UNIQUE_ID: ${productId}] - Platform: ${productData.platform}, Country: ${productData.country}`);
        }

        return historiesToInsert.length;

    } catch (error) {
        logError(`Error updating history for product [UNIQUE_ID: ${productData.externalId}] - Platform: ${productData.platform}, Country: ${productData.country}:`, error);
        return 0;
    }
}

/**
 * 4. Migrar multimedia desde gallery JSON
 */
async function migrateMultimedia(productData: any, productId: string): Promise<number> {
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
            .filter(item => item && (item.url || item.originalUrl))
            .map((item, index) => {
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
            log(`✓ Inserted ${multimediaItems.length} multimedia items for product [UNIQUE_ID: ${productId}] - Platform: ${productData.platform}, Country: ${productData.country}`);
        }

        return multimediaItems.length;

    } catch (error) {
        logError(`Error updating multimedia for product [UNIQUE_ID: ${productId}] - Platform: ${productData.platform}, Country: ${productData.country}:`, error);
        return 0;
    }
}

/**
 * Función principal
 */
async function main() {
    const startTime = Date.now();

    log(`🚀 Iniciando migración simple...`);
    log(`Modo: ${TEST_MODE ? 'TEST (limitado)' : 'PRODUCCIÓN (completo)'}`);

    try {
        // Obtener productos de la base vieja ordenados por fecha (más recientes primero)
        // Esto ayuda a evitar duplicados y procesar productos actualizados
        let query = oldDb
            .select()
            .from(oldProduct)
            .where(ne(oldProduct.platform, 'rocketfy')) // Excluir rocketfy
            .orderBy(desc(oldProduct.updatedAt)); // Ordenar por fecha de actualización descendente

        if (TEST_MODE) {
            query = query.limit(TEST_LIMIT);
        }

        const oldProducts = await query;

        log(`Found ${oldProducts.length} products to migrate${TEST_MODE ? ' (TEST MODE)' : ''}`);

        let providersCreated = 0;
        let productsCreated = 0;
        let productsUpdated = 0;
        let historiesFilled = 0;
        let multimediaCreated = 0;
        let errors = 0;
        let duplicatesSkipped = 0;

        // Set para trackear UUIDs ya procesados en esta ejecución
        const processedUUIDs = new Set<string>();

        // Procesar productos en lotes
        for (let i = 0; i < oldProducts.length; i += BATCH_SIZE) {
            const batch = oldProducts.slice(i, i + BATCH_SIZE);
            log(`Processing batch ${Math.floor(i / BATCH_SIZE) + 1} (${batch.length} products)`);

            for (const oldProd of batch) {
                try {
                    // Verificar si ya procesamos este UUID en esta ejecución
                    if (processedUUIDs.has(oldProd.uuid)) {
                        duplicatesSkipped++;
                        log(`⏭️ Duplicate UUID skipped [UUID: ${oldProd.uuid}] - External ID: ${oldProd.externalId}`);
                        continue;
                    }

                    // Marcar UUID como procesado
                    processedUUIDs.add(oldProd.uuid);

                    // 1. Crear/actualizar proveedor
                    const providerId = await createOrUpdateProvider(oldProd);
                    if (providerId) providersCreated++;

                    // 2. Crear/actualizar producto
                    const productId = await createOrUpdateProduct(oldProd, providerId);
                    if (!productId) {
                        errors++;
                        continue;
                    }

                    // Verificar si es nuevo o actualizado
                    const existingProduct = await productsDb
                        .select()
                        .from(products)
                        .where(eq(products.id, productId))
                        .limit(1);

                    if (existingProduct.length > 0) {
                        productsUpdated++;
                    } else {
                        productsCreated++;
                    }

                    // 3. Llenar gaps en historiales
                    const historiesCount = await fillHistoryGaps(oldProd, productId);
                    historiesFilled += historiesCount;

                    // 4. Migrar multimedia
                    const multimediaCount = await migrateMultimedia(oldProd, productId);
                    multimediaCreated += multimediaCount;

                } catch (error) {
                    errors++;
                    logError(`Error processing product [UNIQUE_ID: ${oldProd.externalId}]:`, error);
                }
            }
        }

        // Resumen final
        const duration = (Date.now() - startTime) / 1000;

        log(`🎉 Migration completed in ${duration.toFixed(1)} seconds`);
        log(`📊 Summary:`);
        log(`   Total products found: ${oldProducts.length}`);
        log(`   Duplicates skipped: ${duplicatesSkipped}`);
        log(`   Providers: ${providersCreated} processed`);
        log(`   Products: ${productsCreated} created, ${productsUpdated} updated`);
        log(`   Histories: ${historiesFilled} gaps filled`);
        log(`   Multimedia: ${multimediaCreated} items created`);
        log(`   Errors: ${errors}`);

        process.exit(0);

    } catch (error) {
        logError("Fatal error in migration:", error);
        process.exit(1);
    }
}

// Handle signals
process.on('SIGINT', () => {
    log('Received SIGINT, shutting down gracefully...');
    process.exit(130);
});

process.on('SIGTERM', () => {
    log('Received SIGTERM, shutting down gracefully...');
    process.exit(143);
});

// Start migration
main().catch((error) => {
    logError('Fatal error in main function:', error);
    process.exit(1);
});