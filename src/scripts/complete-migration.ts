#!/usr/bin/env bun

/**
 * Complete Migration Script - Migra todos los datos de la base vieja a la nueva
 *
 * Este script migra:
 * - Proveedores (providers)
 * - Productos (products)
 * - Históricos (histories)
 * - Multimedia (multimedia)
 *
 * Usage:
 *   bun src/scripts/complete-migration.ts
 *   TEST_MODE=true bun src/scripts/complete-migration.ts (para testing)
 */

import { eq, sql, and, desc, max, inArray } from "drizzle-orm";
import { productsDb } from "../db/config/products";
import { oldDb } from "../db/config/old";

// Schemas
import { products, histories, providers, multimedia } from "../db/schemas/products";
import { product as oldProduct, history as oldHistory } from "../db/schemas/old/schema";

// Configuration
const BATCH_SIZE = 100;
const TEST_MODE = process.env.TEST_MODE === 'true';
const TEST_LIMIT = 50; // Número de productos para test

/**
 * Logger con timestamp y formato mejorado
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
 * 1. Migrar Proveedores
 */
async function migrateProviders() {
    log("🔄 Iniciando migración de proveedores...");

    try {
        // Obtener todos los proveedores únicos de la base vieja
        const oldProviders = await oldDb
            .selectDistinct({
                name: oldProduct.provider,
                externalId: oldProduct.providerId,
                platform: oldProduct.platform,
                country: oldProduct.country
            })
            .from(oldProduct)
            .where(
                and(
                    sql`${oldProduct.provider} IS NOT NULL`,
                    sql`${oldProduct.provider} != ''`,
                    sql`${oldProduct.providerId} IS NOT NULL`,
                    sql`${oldProduct.providerId} != ''`
                )
            )
            .limit(TEST_MODE ? TEST_LIMIT : 10000);

        log(`Encontrados ${oldProviders.length} proveedores únicos para migrar`);

        let migratedCount = 0;
        let updatedCount = 0;
        let errorCount = 0;

        // Procesar en lotes
        for (let i = 0; i < oldProviders.length; i += BATCH_SIZE) {
            const batch = oldProviders.slice(i, i + BATCH_SIZE);

            for (const oldProvider of batch) {
                try {
                    // Crear platformCountryId (necesitamos obtenerlo de la nueva DB)
                    const platformCountryId = `${oldProvider.platform}_${oldProvider.country}`;

                    // Verificar si el proveedor ya existe
                    const existingProvider = await productsDb
                        .select()
                        .from(providers)
                        .where(
                            and(
                                eq(providers.externalId, oldProvider.externalId),
                                eq(providers.platformCountryId, platformCountryId)
                            )
                        )
                        .limit(1);

                    const providerData = {
                        id: `${oldProvider.externalId}_${platformCountryId}`,
                        name: oldProvider.name,
                        externalId: oldProvider.externalId,
                        verified: false,
                        platformCountryId: platformCountryId,
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString()
                    };

                    if (existingProvider.length === 0) {
                        // Crear nuevo proveedor
                        await productsDb.insert(providers).values(providerData);
                        migratedCount++;
                        log(`✅ Proveedor creado [UNIQUE_ID: ${oldProvider.externalId}] - Platform: ${oldProvider.platform}, Country: ${oldProvider.country}`);
                    } else {
                        // Actualizar proveedor existente
                        await productsDb
                            .update(providers)
                            .set({
                                name: providerData.name,
                                updatedAt: providerData.updatedAt
                            })
                            .where(eq(providers.id, existingProvider[0].id));
                        updatedCount++;
                        log(`🔄 Proveedor actualizado [UNIQUE_ID: ${oldProvider.externalId}] - Platform: ${oldProvider.platform}, Country: ${oldProvider.country}`);
                    }

                } catch (error) {
                    errorCount++;
                    logError(`Error procesando proveedor [UNIQUE_ID: ${oldProvider.externalId}] - Platform: ${oldProvider.platform}, Country: ${oldProvider.country}:`, error);
                }
            }
        }

        log(`✅ Migración de proveedores completada: ${migratedCount} creados, ${updatedCount} actualizados, ${errorCount} errores`);
        return { migratedCount, updatedCount, errorCount };

    } catch (error) {
        logError("Error en migración de proveedores:", error);
        throw error;
    }
}

/**
 * 2. Migrar Productos
 */
async function migrateProducts() {
    log("🔄 Iniciando migración de productos...");

    try {
        // Obtener productos de la base vieja
        const oldProducts = await oldDb
            .select()
            .from(oldProduct)
            .where(sql`${oldProduct.platform} != 'rocketfy'`) // Excluir rocketfy
            .limit(TEST_MODE ? TEST_LIMIT : 50000);

        log(`Encontrados ${oldProducts.length} productos para migrar`);

        let migratedCount = 0;
        let updatedCount = 0;
        let errorCount = 0;

        // Procesar en lotes
        for (let i = 0; i < oldProducts.length; i += BATCH_SIZE) {
            const batch = oldProducts.slice(i, i + BATCH_SIZE);

            for (const oldProd of batch) {
                try {
                    const platformCountryId = `${oldProd.platform}_${oldProd.country}`;

                    // Verificar si el producto ya existe
                    const existingProduct = await productsDb
                        .select()
                        .from(products)
                        .where(
                            and(
                                eq(products.externalId, oldProd.externalId),
                                eq(products.platformCountryId, platformCountryId)
                            )
                        )
                        .limit(1);

                    // Buscar el proveedor
                    const provider = await productsDb
                        .select()
                        .from(providers)
                        .where(
                            and(
                                eq(providers.externalId, oldProd.providerId || ''),
                                eq(providers.platformCountryId, platformCountryId)
                            )
                        )
                        .limit(1);

                    const productData = {
                        id: `${oldProd.externalId}_${platformCountryId}`,
                        externalId: oldProd.externalId,
                        name: oldProd.name || 'Sin nombre',
                        description: oldProd.description || null,
                        salePrice: oldProd.salePrice || 0,
                        suggestedPrice: oldProd.suggestedPrice || 0,
                        totalSalesAmount: oldProd.totalSalesAmount || 0,
                        salesLast7Days: oldProd.salesLast7Days || 0,
                        salesLast30Days: oldProd.salesLast30Days || 0,
                        totalSoldUnits: oldProd.totalSoldUnits || 0,
                        soldUnitsLast7Days: oldProd.soldUnitsLast7Days || 0,
                        soldUnitsLast30Days: oldProd.soldUnitsLast30Days || 0,
                        stock: oldProd.stock || 0,
                        variationsAmount: oldProd.variationsAmount || 0,
                        score: oldProd.score || 0,
                        status: oldProd.visible ? 'ACTIVE' : 'INACTIVE',
                        platformCountryId: platformCountryId,
                        providerId: provider.length > 0 ? provider[0].id : null,
                        platformCategoryId: null, // TODO: mapear categorías
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString()
                    };

                    if (existingProduct.length === 0) {
                        // Crear nuevo producto
                        await productsDb.insert(products).values(productData);
                        migratedCount++;
                        log(`✅ Producto creado [UNIQUE_ID: ${oldProd.externalId}] - Platform: ${oldProd.platform}, Country: ${oldProd.country}`);
                    } else {
                        // Actualizar producto existente
                        await productsDb
                            .update(products)
                            .set({
                                name: productData.name,
                                description: productData.description,
                                salePrice: productData.salePrice,
                                suggestedPrice: productData.suggestedPrice,
                                totalSalesAmount: productData.totalSalesAmount,
                                salesLast7Days: productData.salesLast7Days,
                                salesLast30Days: productData.salesLast30Days,
                                totalSoldUnits: productData.totalSoldUnits,
                                soldUnitsLast7Days: productData.soldUnitsLast7Days,
                                soldUnitsLast30Days: productData.soldUnitsLast30Days,
                                stock: productData.stock,
                                variationsAmount: productData.variationsAmount,
                                score: productData.score,
                                status: productData.status,
                                providerId: productData.providerId,
                                updatedAt: productData.updatedAt
                            })
                            .where(eq(products.id, existingProduct[0].id));
                        updatedCount++;
                        log(`🔄 Producto actualizado [UNIQUE_ID: ${oldProd.externalId}] - Platform: ${oldProd.platform}, Country: ${oldProd.country}`);
                    }

                } catch (error) {
                    errorCount++;
                    logError(`Error procesando producto [UNIQUE_ID: ${oldProd.externalId}] - Platform: ${oldProd.platform}, Country: ${oldProd.country}:`, error);
                }
            }
        }

        log(`✅ Migración de productos completada: ${migratedCount} creados, ${updatedCount} actualizados, ${errorCount} errores`);
        return { migratedCount, updatedCount, errorCount };

    } catch (error) {
        logError("Error en migración de productos:", error);
        throw error;
    }
}

/**
 * 3. Migrar Históricos
 */
async function migrateHistories() {
    log("🔄 Iniciando migración de históricos...");

    try {
        // Obtener históricos de la base vieja
        const oldHistories = await oldDb
            .select()
            .from(oldHistory)
            .limit(TEST_MODE ? TEST_LIMIT * 10 : 100000); // Más históricos que productos

        log(`Encontrados ${oldHistories.length} registros históricos para migrar`);

        let migratedCount = 0;
        let updatedCount = 0;
        let errorCount = 0;

        // Procesar en lotes
        for (let i = 0; i < oldHistories.length; i += BATCH_SIZE) {
            const batch = oldHistories.slice(i, i + BATCH_SIZE);

            for (const oldHist of batch) {
                try {
                    const platformCountryId = `${oldHist.platform}_${oldHist.country}`;

                    // Buscar el producto correspondiente
                    const product = await productsDb
                        .select()
                        .from(products)
                        .where(
                            and(
                                eq(products.externalId, oldHist.externalProductId),
                                eq(products.platformCountryId, platformCountryId)
                            )
                        )
                        .limit(1);

                    if (product.length === 0) {
                        // Producto no existe, saltear
                        continue;
                    }

                    // Verificar si el histórico ya existe
                    const existingHistory = await productsDb
                        .select()
                        .from(histories)
                        .where(
                            and(
                                eq(histories.productId, product[0].id),
                                eq(histories.date, oldHist.date)
                            )
                        )
                        .limit(1);

                    const historyData = {
                        id: `${product[0].id}_${oldHist.date}`,
                        date: oldHist.date,
                        stock: oldHist.stock || 0,
                        salePrice: oldHist.salePrice || 0,
                        suggestedPrice: 0, // No está en la base vieja
                        soldUnits: oldHist.soldUnits || 0,
                        soldUnitsLast7Days: 0,
                        soldUnitsLast30Days: 0,
                        totalSoldUnits: 0,
                        billing: oldHist.salesAmount || 0,
                        billingLast7Days: 0,
                        billingLast30Days: 0,
                        totalBilling: 0,
                        stockAdjustment: oldHist.stockAdjustment || false,
                        productId: product[0].id,
                        stockAdjustmentReason: oldHist.stockAdjustmentReason || null,
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString()
                    };

                    if (existingHistory.length === 0) {
                        // Crear nuevo histórico
                        await productsDb.insert(histories).values(historyData);
                        migratedCount++;

                        if (migratedCount % 100 === 0) {
                            log(`📊 Históricos procesados: ${migratedCount}`);
                        }
                    } else {
                        // Actualizar histórico existente
                        await productsDb
                            .update(histories)
                            .set({
                                stock: historyData.stock,
                                salePrice: historyData.salePrice,
                                soldUnits: historyData.soldUnits,
                                billing: historyData.billing,
                                stockAdjustment: historyData.stockAdjustment,
                                stockAdjustmentReason: historyData.stockAdjustmentReason,
                                updatedAt: historyData.updatedAt
                            })
                            .where(eq(histories.id, existingHistory[0].id));
                        updatedCount++;
                    }

                } catch (error) {
                    errorCount++;
                    logError(`Error procesando histórico para producto ${oldHist.externalProductId}, fecha ${oldHist.date}:`, error);
                }
            }
        }

        log(`✅ Migración de históricos completada: ${migratedCount} creados, ${updatedCount} actualizados, ${errorCount} errores`);
        return { migratedCount, updatedCount, errorCount };

    } catch (error) {
        logError("Error en migración de históricos:", error);
        throw error;
    }
}

/**
 * 4. Migrar Multimedia (placeholder - necesitamos ver la estructura de la base vieja)
 */
async function migrateMultimedia() {
    log("🔄 Iniciando migración de multimedia...");

    try {
        // TODO: Implementar cuando tengamos la estructura de multimedia en la base vieja
        log("⚠️ Migración de multimedia: Por implementar (necesitamos estructura de la base vieja)");
        return { migratedCount: 0, updatedCount: 0, errorCount: 0 };

    } catch (error) {
        logError("Error en migración de multimedia:", error);
        throw error;
    }
}

/**
 * Función principal
 */
async function main() {
    const startTime = Date.now();

    log(`🚀 Iniciando migración completa de datos...`);
    log(`Modo: ${TEST_MODE ? 'TEST (limitado)' : 'PRODUCCIÓN (completo)'}`);

    try {
        // 1. Migrar proveedores
        const providersResult = await migrateProviders();

        // 2. Migrar productos
        const productsResult = await migrateProducts();

        // 3. Migrar históricos
        const historiesResult = await migrateHistories();

        // 4. Migrar multimedia
        const multimediaResult = await migrateMultimedia();

        // Resumen final
        const duration = (Date.now() - startTime) / 1000;

        log(`🎉 Migración completada en ${duration.toFixed(1)} segundos`);
        log(`📊 Resumen:`);
        log(`   Proveedores: ${providersResult.migratedCount} creados, ${providersResult.updatedCount} actualizados, ${providersResult.errorCount} errores`);
        log(`   Productos: ${productsResult.migratedCount} creados, ${productsResult.updatedCount} actualizados, ${productsResult.errorCount} errores`);
        log(`   Históricos: ${historiesResult.migratedCount} creados, ${historiesResult.updatedCount} actualizados, ${historiesResult.errorCount} errores`);
        log(`   Multimedia: ${multimediaResult.migratedCount} creados, ${multimediaResult.updatedCount} actualizados, ${multimediaResult.errorCount} errores`);

        process.exit(0);

    } catch (error) {
        logError("Error fatal en la migración:", error);
        process.exit(1);
    }
}

// Handle process signals
process.on('SIGINT', () => {
    log('Recibida señal SIGINT, cerrando gracefully...');
    process.exit(130);
});

process.on('SIGTERM', () => {
    log('Recibida señal SIGTERM, cerrando gracefully...');
    process.exit(143);
});

// Start migration
main().catch((error) => {
    logError('Error fatal en función main:', error);
    process.exit(1);
});