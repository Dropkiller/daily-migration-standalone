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

import { eq, and, inArray, ne, desc, like } from "drizzle-orm";
import { productsDb } from "../db/config/products";
import { oldDb } from "../db/config/old";
import { getPlatformCountryId } from "../services/products";
import { getBaseCategoryByName } from "../services/products/categories";
import {
  BaseMigration,
  type ChunkState,
  type ChunkResult,
  type MigrationConfig,
} from "./BaseMigration";
import * as fs from "fs";
import * as path from "path";

// Schemas
import {
  products,
  histories,
  providers,
  multimedia,
  PlatformType,
  Countries,
} from "../db/schemas/products";
import {
  product as oldProduct,
  history as oldHistory,
  OldProduct,
} from "../db/schemas/old/schema";

// Interfaces para tipos JSON
interface ProviderData {
  name?: string;
  provider_name?: string;
  external_id?: string;
  externalId?: string;
  providerId?: string;
  id?: string;
  verified?: boolean;
}

interface CategoryData {
  name?: string;
  externalId?: string;
}

interface MediaItem {
  url?: string;
  originalUrl?: string;
  ownImage?: string;
  sourceUrl?: string;
  type?: string;
  externalProductId?: string;
}

// Configuration
const TEST_MODE = process.env.TEST_MODE === "true";
const TEST_LIMIT = 20;

const MIGRATION_CONFIG: MigrationConfig = {
  stateKey: "simple_migration_state",
  chunksKey: "simple_migration_chunks",
  lockPrefix: "simple_migration_lock:",
  batchSize: 10, // Productos por batch dentro de cada chunk
  chunkSize: 100, // Productos por chunk
  lockTTL: 600, // 10 minutos
  lockRenewInterval: 240000, // 4 minutos
};

// Mapear plataforma string a PlatformType enum
function mapPlatformToPlatformType(platform: string): PlatformType {
  switch (platform.toLowerCase()) {
    case "dropi":
      return PlatformType.DROPI;
    case "aliclick":
      return PlatformType.ALICLICK;
    case "droplatam":
      return PlatformType.DROPLATAM;
    case "seventy block":
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
  private productUUIDs: string[] = [];

  constructor() {
    super(MIGRATION_CONFIG);
    this.loadProductUUIDs();
  }

  /**
   * Load product UUIDs from JSON file
   */
  private loadProductUUIDs(): void {
    try {
      const dataDir = path.join(process.cwd(), 'data');
      const files = fs.readdirSync(dataDir);
      const jsonFile = files.find(file => file.startsWith('product_') && file.endsWith('.json'));

      if (!jsonFile) {
        throw new Error('No product JSON file found in data directory');
      }

      const filePath = path.join(dataDir, jsonFile);
      const fileContent = fs.readFileSync(filePath, 'utf8');
      const products = JSON.parse(fileContent) as Array<{ uuid: string }>;

      this.productUUIDs = products.map(p => p.uuid);
      this.log(`Loaded ${this.productUUIDs.length} product UUIDs from ${jsonFile}`);
    } catch (error) {
      this.logError('Error loading product UUIDs from JSON:', error);
      throw error;
    }
  }

  /**
   * Obtener total de productos a migrar
   */
  protected async getTotalRecords(): Promise<number> {
    this.log("Using product UUIDs from JSON file...");

    if (TEST_MODE) {
      this.log(`🧪 TEST MODE: Limited to ${TEST_LIMIT} products`);
      return Math.min(TEST_LIMIT, this.productUUIDs.length);
    }

    const count = this.productUUIDs.length;
    this.log(
      `Found ${count} total products in JSON file${
        TEST_MODE ? " (TEST MODE)" : ""
      }`
    );
    return count;
  }

  /**
   * Procesar un chunk de productos
   */
  protected async processChunk(chunk: ChunkState): Promise<ChunkResult> {
    this.log(
      `Processing chunk ${chunk.chunkId} (offset ${chunk.startOffset}-${chunk.endOffset})`
    );

    // Get UUIDs for this chunk
    const chunkSize = chunk.endOffset - chunk.startOffset;
    let uuidsForChunk = this.productUUIDs.slice(chunk.startOffset, chunk.endOffset);

    if (TEST_MODE) {
      uuidsForChunk = uuidsForChunk.slice(0, Math.min(TEST_LIMIT - chunk.startOffset, chunkSize));
    }

    if (uuidsForChunk.length === 0) {
      this.log(`No UUIDs to process for chunk ${chunk.chunkId}`);
      return {
        processed: 0,
        providersCreated: 0,
        productsCreated: 0,
        productsUpdated: 0,
        historiesFilled: 0,
        multimediaCreated: 0,
        duplicatesSkipped: 0,
        errors: 0,
      };
    }

    // Fetch products by UUIDs from old database
    const products = await oldDb
      .select()
      .from(oldProduct)
      .where(
        and(
          inArray(oldProduct.uuid, uuidsForChunk),
          ne(oldProduct.platform, "rocketfy")
        )
      )
      .orderBy(desc(oldProduct.updatedAt));

    let stats = {
      processed: 0,
      providersCreated: 0,
      productsCreated: 0,
      productsUpdated: 0,
      historiesFilled: 0,
      multimediaCreated: 0,
      duplicatesSkipped: 0,
      errors: 0,
    };

    // Procesar productos en mini-batches
    for (let i = 0; i < products.length; i += this.config.batchSize) {
      const batch = products.slice(i, i + this.config.batchSize);

      for (const oldProd of batch) {
        try {
          console.log(
            `[PRODUCT] 🔄 Iniciando procesamiento de producto: ${oldProd.externalId} (UUID: ${oldProd.uuid}) - Platform: ${oldProd.platform}, Country: ${oldProd.country}`
          );

          // Verificar duplicados
          if (this.processedUUIDs.has(oldProd.uuid)) {
            stats.duplicatesSkipped++;
            this.log(
              `⏭️ Duplicate UUID skipped [UUID: ${oldProd.uuid}] - External ID: ${oldProd.externalId}`
            );
            continue;
          }

          this.processedUUIDs.add(oldProd.uuid);

          // 1. Crear/actualizar proveedor PRIMERO - SIEMPRE obtenemos un providerId válido
          console.log(
            `[PRODUCT] 👤 Procesando proveedor para producto: ${oldProd.externalId}`
          );
          const providerId = await this.createOrUpdateProvider(oldProd);
          stats.providersCreated++;
          console.log(`[PRODUCT] ✅ Proveedor procesado con ID: ${providerId}`);

          // 2. Crear/actualizar producto CON providerId válido garantizado
          console.log(
            `[PRODUCT] 📦 Creando/actualizando producto: ${oldProd.externalId} con proveedor: ${providerId}`
          );
          const result = await this.createOrUpdateProduct(oldProd, providerId);
          if (!result) {
            stats.errors++;
            console.log(
              `[PRODUCT] ❌ Error al procesar producto: ${oldProd.externalId}`
            );
            continue;
          }

          const { productId, created } = result;
          if (created) {
            stats.productsCreated++;
            console.log(`[PRODUCT] ✅ Producto creado con ID: ${productId}`);
          } else {
            stats.productsUpdated++;
            console.log(
              `[PRODUCT] ✅ Producto actualizado con ID: ${productId}`
            );
          }

          // 3. Llenar gaps en historiales
          console.log(
            `[HISTORY] 📊 Iniciando procesamiento de historial para producto: ${oldProd.externalId} (ID: ${productId})`
          );
          const historiesCount = await this.fillHistoryGaps(oldProd, productId);
          stats.historiesFilled += historiesCount;
          console.log(
            `[HISTORY] ✅ Historial procesado: ${historiesCount} registros agregados para producto: ${oldProd.externalId}`
          );

          // 4. Migrar multimedia
          console.log(
            `[MULTIMEDIA] 🖼️ Procesando multimedia para producto: ${oldProd.externalId}`
          );
          const multimediaCount = await this.migrateMultimedia(
            oldProd,
            productId
          );
          stats.multimediaCreated += multimediaCount;
          console.log(
            `[MULTIMEDIA] ✅ Multimedia procesada: ${multimediaCount} elementos para producto: ${oldProd.externalId}`
          );

          stats.processed++;
          console.log(
            `[PRODUCT] ✅ Producto completamente procesado: ${
              oldProd.externalId
            } - Total stats: ${JSON.stringify({
              processed: stats.processed,
              errors: stats.errors,
            })}`
          );
        } catch (error) {
          stats.errors++;
          console.log(
            `[PRODUCT] ❌ Error crítico procesando producto: ${oldProd.externalId}`
          );
          this.logError(
            `Error processing product [UNIQUE_ID: ${oldProd.externalId}]:`,
            error
          );
        }
      }
    }

    this.log(
      `Chunk ${chunk.chunkId} completed: ${stats.processed} processed, ${stats.errors} errors, ${stats.duplicatesSkipped} duplicates skipped`
    );
    return stats;
  }

  /**
   * Hook personalizado para métricas adicionales
   */
  protected getCustomProgress(): Record<string, any> {
    return {
      migrationDate: new Date().toISOString().split("T")[0],
      totalDuplicatesSkipped: this.processedUUIDs.size,
    };
  }

  /**
   * Crear/actualizar proveedor desde los datos JSON del producto
   */
  private async createOrUpdateProvider(
    productData: OldProduct
  ): Promise<string> {
    try {
      if (!productData.provider) {
        console.log(
          `[DEBUG] No provider data for product ${productData.externalId}, creating fallback`
        );
        return await this.createFallbackProvider(productData);
      }

      // El provider viene como string JSON, necesitamos parsearlo
      let providerData: ProviderData;
      if (typeof productData.provider === "string") {
        try {
          providerData = JSON.parse(productData.provider);
        } catch (parseError) {
          this.logError(
            `Error parsing provider JSON for product ${productData.externalId}:`,
            parseError
          );
          // Si falla el parsing, crear proveedor fallback
          return await this.createFallbackProvider(productData);
        }
      } else if (typeof productData.provider === "object") {
        providerData = productData.provider as ProviderData;
      } else {
        // Si el tipo no es válido, crear proveedor fallback
        return await this.createFallbackProvider(productData);
      }

      const providerName =
        providerData.name || providerData.provider_name || "null";
      const providerExternalId =
        providerData.externalId || providerData.external_id;

      console.log(
        `[DEBUG] Processing provider for product ${productData.externalId}: name=${providerName}, externalId=${providerExternalId}`
      );

      // Si no hay externalId válido, crear proveedor fallback
      if (!providerExternalId) {
        console.log(
          `[DEBUG] No valid externalId for provider, creating fallback for product ${productData.externalId}`
        );
        return await this.createFallbackProvider(productData);
      }

      // Usar la función correcta para obtener platformCountryId
      const platformType = mapPlatformToPlatformType(productData.platform);
      let countryCode = productData.country;

      // Manejar casos especiales de país
      if (countryCode === "CO1") {
        countryCode = "CO";
      }

      countryCode = countryCode as keyof typeof Countries;

      let platformCountryId: string;
      try {
        platformCountryId = await getPlatformCountryId({
          countryCode: countryCode as keyof typeof Countries,
          platformId: platformType,
        });
      } catch (error) {
        this.logError(
          `Platform country not found for platform ${productData.platform} and country ${productData.country}:`,
          error
        );
        // Si falla obtener platformCountryId, crear proveedor fallback
        return await this.createFallbackProvider(productData);
      }

      console.log(`[DEBUG] Platform country ID: ${platformCountryId}`);

      // Buscar proveedor por name y platformCountryId (método más confiable)
      const existingProvider = await productsDb
        .select()
        .from(providers)
        .where(
          and(
            like(providers.name, providerName),
            eq(providers.externalId, providerExternalId as string)
          )
        )
        .limit(1);

      if (existingProvider.length > 0) {
        console.log(
          `[DEBUG] Found existing provider with ID: ${existingProvider[0].id}`
        );

        // Verificar si el externalId que queremos asignar ya existe en otro proveedor
        const conflictingProvider = await productsDb
          .select()
          .from(providers)
          .where(
            and(
              eq(providers.externalId, providerExternalId as string),
              eq(providers.platformCountryId, platformCountryId),
              ne(providers.id, existingProvider[0].id) // Excluir el proveedor actual
            )
          )
          .limit(1);

        if (conflictingProvider.length > 0) {
          console.log(
            `[DEBUG] ExternalId ${providerExternalId} already exists in another provider ${conflictingProvider[0].id}, skipping externalId update`
          );
          // Solo actualizar campos que no causan conflicto
          await productsDb
            .update(providers)
            .set({
              verified: providerData.verified || false,
              updatedAt: new Date().toISOString(),
            })
            .where(eq(providers.id, existingProvider[0].id));
        } else {
          // Actualizar proveedor existente incluyendo externalId
          await productsDb
            .update(providers)
            .set({
              externalId: providerExternalId,
              verified: providerData.verified || false,
              updatedAt: new Date().toISOString(),
            })
            .where(eq(providers.id, existingProvider[0].id));
        }

        return existingProvider[0].id;
      } else {
        // Verificar si ya existe un proveedor con el mismo externalId y platformCountryId
        const existingByExternalId = await productsDb
          .select()
          .from(providers)
          .where(
            and(
              eq(providers.externalId, providerExternalId as string),
              eq(providers.platformCountryId, platformCountryId)
            )
          )
          .limit(1);

        if (existingByExternalId.length > 0) {
          console.log(
            `[DEBUG] Provider with externalId ${providerExternalId} already exists with ID: ${existingByExternalId[0].id}, using existing provider`
          );
          // Actualizar el proveedor existente con el nombre actual
          await productsDb
            .update(providers)
            .set({
              name: providerName, // Actualizar nombre si cambió
              verified: providerData.verified || false,
              updatedAt: new Date().toISOString(),
            })
            .where(eq(providers.id, existingByExternalId[0].id));

          return existingByExternalId[0].id;
        }

        // Crear nuevo proveedor con UUID único
        const providerId = crypto.randomUUID();
        const newProvider = {
          id: providerId,
          name: providerName,
          externalId: providerExternalId as string,
          verified: providerData.verified || false,
          platformCountryId: platformCountryId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        console.log(
          `[DEBUG] Creating new provider with ID: ${providerId}, name: ${providerName}`
        );
        await productsDb.insert(providers).values(newProvider);

        // Verificar que se creó correctamente
        const verifyProvider = await productsDb
          .select()
          .from(providers)
          .where(eq(providers.id, providerId))
          .limit(1);

        if (verifyProvider.length === 0) {
          console.error(
            `[ERROR] Provider ${providerId} was not created successfully!`
          );
          throw new Error(`Provider creation failed for ${providerId}`);
        }

        console.log(`[DEBUG] Provider created successfully: ${providerId}`);
        return providerId;
      }
    } catch (error) {
      this.logError(
        `Error creating/updating provider for product ${productData.externalId}:`,
        error
      );
      // En caso de cualquier error, crear proveedor fallback
      return await this.createFallbackProvider(productData);
    }
  }

  /**
   * Crear proveedor fallback cuando no se puede obtener/crear el proveedor principal
   */
  private async createFallbackProvider(
    productData: OldProduct
  ): Promise<string> {
    try {
      const platformType = mapPlatformToPlatformType(productData.platform);
      let countryCode = productData.country;

      // Manejar casos especiales de país
      if (countryCode === "CO1") {
        countryCode = "CO";
      }

      countryCode = countryCode as keyof typeof Countries;

      let platformCountryId: string;
      try {
        platformCountryId = await getPlatformCountryId({
          countryCode: countryCode as keyof typeof Countries,
          platformId: platformType,
        });
      } catch (error) {
        this.logError(
          `Cannot get platform country for fallback provider:`,
          error
        );
        throw new Error(
          `Cannot create fallback provider without valid platformCountryId`
        );
      }

      const fallbackExternalId = productData.externalId;
      const fallbackName = "null";

      console.log(
        `[DEBUG] Creating fallback provider: externalId=${fallbackExternalId}, name=${fallbackName}`
      );

      // Verificar si ya existe un proveedor fallback para este producto
      const existingFallback = await productsDb
        .select()
        .from(providers)
        .where(
          and(
            eq(providers.externalId, fallbackExternalId),
            eq(providers.platformCountryId, platformCountryId)
          )
        )
        .limit(1);

      if (existingFallback.length > 0) {
        console.log(
          `[DEBUG] Found existing fallback provider with ID: ${existingFallback[0].id}`
        );
        return existingFallback[0].id;
      }

      // Crear nuevo proveedor fallback
      const providerId = crypto.randomUUID();
      const fallbackProvider = {
        id: providerId,
        name: fallbackName,
        externalId: fallbackExternalId,
        verified: false,
        platformCountryId: platformCountryId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      console.log(
        `[DEBUG] Creating new fallback provider with ID: ${providerId}`
      );
      await productsDb.insert(providers).values(fallbackProvider);

      // Verificar que se creó correctamente
      const verifyFallback = await productsDb
        .select()
        .from(providers)
        .where(eq(providers.id, providerId))
        .limit(1);

      if (verifyFallback.length === 0) {
        console.error(
          `[ERROR] Fallback provider ${providerId} was not created successfully!`
        );
        throw new Error(`Fallback provider creation failed for ${providerId}`);
      }

      console.log(
        `[DEBUG] Fallback provider created successfully: ${providerId}`
      );
      this.logError(
        `Created fallback provider for product ${productData.externalId}`,
        providerId
      );
      return providerId;
    } catch (error) {
      this.logError(
        `Critical error creating fallback provider for product ${productData.externalId}:`,
        error
      );
      throw error; // Re-lanzar el error porque no podemos continuar sin proveedor
    }
  }

  /**
   * Crear/actualizar producto
   */
  private async createOrUpdateProduct(
    productData: OldProduct,
    providerId: string
  ): Promise<{ productId: string; created: boolean } | null> {
    try {
      // Usar la función correcta para obtener platformCountryId
      const platformType = mapPlatformToPlatformType(productData.platform);
      let countryCode = productData.country;

      // Manejar casos especiales de país
      if (countryCode === "CO1") {
        countryCode = "CO";
      }

      countryCode = countryCode as keyof typeof Countries;

      let platformCountryId: string;
      try {
        platformCountryId = await getPlatformCountryId({
          countryCode: countryCode as keyof typeof Countries,
          platformId: platformType,
        });
      } catch (error) {
        this.logError(
          `Platform country not found for platform ${productData.platform} and country ${productData.country}:`,
          error
        );
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
        if (
          productData.categories &&
          Array.isArray(productData.categories) &&
          productData.categories.length > 0
        ) {
          const firstCategory = productData.categories[0] as CategoryData;
          if (firstCategory && firstCategory.name) {
            baseCategoryId = await getBaseCategoryByName(firstCategory.name);
          }
        }
      } catch (error) {
        console.warn(
          `Category error for product ${productData.externalId}, using fallback:`,
          error
        );
      }

      const productPayload = {
        id: productId,
        externalId: productData.externalId,
        name: productData.name || "Sin nombre",
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
        status: (productData.visible ? "ACTIVE" : "INACTIVE") as
          | "ACTIVE"
          | "INACTIVE",
        platformCountryId: platformCountryId,
        providerId: providerId,
        baseCategoryId: baseCategoryId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
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
            updatedAt: productPayload.updatedAt,
          })
          .where(eq(products.id, existingProduct[0].id));

        return { productId, created: false };
      }
    } catch (error) {
      this.logError(
        `Error creating/updating product [UNIQUE_ID: ${productData.externalId}] - Platform: ${productData.platform}, Country: ${productData.country}:`,
        error
      );
      return null;
    }
  }

  /**
   * Detectar gaps en historiales y crear días faltantes
   */
  private async fillHistoryGaps(
    productData: OldProduct,
    productId: string
  ): Promise<number> {
    try {
      console.log(
        `[HISTORY] 🔍 Verificando historial existente para producto: ${productData.externalId} (ID: ${productId})`
      );

      // Obtener fechas existentes en la nueva base para este producto
      const existingHistories = await productsDb
        .select({ date: histories.date })
        .from(histories)
        .where(eq(histories.productId, productId));

      const existingDatesSet = new Set(existingHistories.map((h) => h.date));
      console.log(
        `[HISTORY] 📅 Fechas existentes en nueva DB: ${existingHistories.length} registros`
      );

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

      console.log(
        `[HISTORY] 📅 Fechas disponibles en DB antigua: ${allOldHistories.length} registros`
      );

      // Encontrar fechas faltantes
      const missingDates = allOldHistories
        .map((h) => h.date)
        .filter((date) => !existingDatesSet.has(date));

      if (missingDates.length === 0) {
        console.log(
          `[HISTORY] ✅ No hay fechas faltantes para producto: ${productData.externalId}`
        );
        return 0;
      }

      console.log(
        `[HISTORY] 📊 Fechas faltantes encontradas: ${missingDates.length} para producto: ${productData.externalId}`
      );

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

      console.log(
        `[HISTORY] 📋 Datos históricos obtenidos: ${missingHistoriesData.length} registros para producto: ${productData.externalId}`
      );

      // Crear registros de historial ordenados por fecha
      const historiesToInsert = missingHistoriesData
        .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()) // Ordenar por fecha ascendente
        .map((h) => ({
          id: crypto.randomUUID(),
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
          updatedAt: new Date().toISOString(),
        }));

      // Update the last history record (most recent date) with current product stats
      if (historiesToInsert.length > 0) {
        const lastHistoryByDate =
          historiesToInsert[historiesToInsert.length - 1]; // El último por fecha después del sort
        if (lastHistoryByDate) {
          lastHistoryByDate.suggestedPrice = productData.suggestedPrice || 0;
          lastHistoryByDate.soldUnitsLast7Days =
            productData.soldUnitsLast7Days || 0;
          lastHistoryByDate.soldUnitsLast30Days =
            productData.soldUnitsLast30Days || 0;
          lastHistoryByDate.totalSoldUnits = productData.totalSoldUnits || 0;
          lastHistoryByDate.billingLast7Days = productData.salesLast7Days || 0;
          lastHistoryByDate.billingLast30Days =
            productData.salesLast30Days || 0;
          lastHistoryByDate.totalBilling = productData.totalSalesAmount || 0;
        }

        console.log(
          `[HISTORY] 💾 Insertando ${historiesToInsert.length} registros de historial para producto: ${productData.externalId}`
        );
        await productsDb.insert(histories).values(historiesToInsert);
        console.log(
          `[HISTORY] ✅ Historial insertado exitosamente para producto: ${productData.externalId}`
        );
      }

      return historiesToInsert.length;
    } catch (error) {
      console.log(
        `[HISTORY] ❌ Error procesando historial para producto: ${productData.externalId}`
      );
      this.logError(
        `Error updating history for product [UNIQUE_ID: ${productData.externalId}] - Platform: ${productData.platform}, Country: ${productData.country}:`,
        error
      );
      return 0;
    }
  }

  /**
   * Migrar multimedia desde gallery JSON
   */
  private async migrateMultimedia(
    productData: OldProduct,
    productId: string
  ): Promise<number> {
    try {
      if (!productData.gallery) {
        return 0;
      }

      // El gallery viene como string JSON, necesitamos parsearlo
      let gallery: MediaItem[];
      if (typeof productData.gallery === "string") {
        try {
          const parsedGallery = JSON.parse(productData.gallery);
          gallery = Array.isArray(parsedGallery)
            ? parsedGallery
            : [parsedGallery];
        } catch (parseError) {
          this.logError(
            `Error parsing gallery JSON for product ${productData.externalId}:`,
            parseError
          );
          return 0;
        }
      } else if (Array.isArray(productData.gallery)) {
        gallery = productData.gallery as MediaItem[];
      } else if (typeof productData.gallery === "object") {
        gallery = [productData.gallery as MediaItem];
      } else {
        return 0;
      }

      // Crear registros de multimedia
      const multimediaItems = gallery
        .filter(
          (item: MediaItem) =>
            item &&
            (item.url || item.originalUrl || item.ownImage || item.sourceUrl)
        )
        .map((item: MediaItem, index: number) => {
          // Priorizar las URLs en este orden: url > ownImage > sourceUrl > originalUrl
          let url =
            item.url || item.ownImage || item.sourceUrl || item.originalUrl;

          // Apply URL completion logic: SOLO concatenar si NO empieza con https://
          // Las URLs que ya tienen https:// se guardan tal cual
          if (url && !url.startsWith("https://") && /^[a-z]+\//.test(url)) {
            url = "https://d39ru7awumhhs2.cloudfront.net/" + url;
          }
          // Si ya tiene https://, se guarda sin modificar

          return {
            id: crypto.randomUUID(),
            type: item.type || "image",
            url: url,
            originalUrl: url, // Misma URL después de procesarla
            productId: productId,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
        });

      await productsDb
        .insert(multimedia)
        .values(multimediaItems)
        .onConflictDoUpdate({
          target: multimedia.id,
          set: {
            type: multimedia.type,
            url: multimedia.url,
            originalUrl: multimedia.originalUrl,
            updatedAt: new Date().toISOString(),
          },
        });

      return multimediaItems.length;
    } catch (error) {
      this.logError(
        `Error updating multimedia for product [UNIQUE_ID: ${productId}] - Platform: ${productData.platform}, Country: ${productData.country}:`,
        error
      );
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
    console.log(
      `Mode: ${TEST_MODE ? "TEST (limited)" : "PRODUCTION (complete)"}`
    );
    console.log(`Worker ID: ${process.env.WORKER_ID || "auto-generated"}`);

    await migration.execute();

    console.log(`✅ Migration completed successfully!`);
    process.exit(0);
  } catch (error) {
    console.error("Fatal error in migration:", error);
    process.exit(1);
  }
}

// Handle signals
process.on("SIGINT", () => {
  console.log("Received SIGINT, shutting down gracefully...");
  process.exit(130);
});

process.on("SIGTERM", () => {
  console.log("Received SIGTERM, shutting down gracefully...");
  process.exit(143);
});

// Start migration
main().catch((error) => {
  console.error("Fatal error in main function:", error);
  process.exit(1);
});
