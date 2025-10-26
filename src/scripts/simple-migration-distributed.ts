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

import { eq, and, inArray, ne, desc, like, sql } from "drizzle-orm";
import { productsDb } from "../db/config/products";
import { oldDb } from "../db/config/old";
import { getPlatformCountryId } from "../services/products";
import { getValidBaseCategoryId } from "../services/products/categories";
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

// Constantes de hosts CloudFront por país
const CLOUDFRONT_HOSTS = {
  AR: "https://d33yjn72e20ec6.cloudfront.net/",
  GT: "https://d2ob47cxeawi8a.cloudfront.net/",
  DEFAULT: "https://d39ru7awumhhs2.cloudfront.net/", // CO y otros
};

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

// Función de normalización de URLs
function normalizeUrl(url: string, countryCode: string): string {
  // Si ya tiene protocolo, retornar tal cual
  if (url.startsWith("http://") || url.startsWith("https://")) {
    return url;
  }

  // Determinar el host según código de país (2 letras)
  const host = CLOUDFRONT_HOSTS[countryCode as keyof typeof CLOUDFRONT_HOSTS] || CLOUDFRONT_HOSTS.DEFAULT;

  // Agregar host al path
  return host + url.replace(/^\//, "");
}

// Función de extracción de URLs válidas del array gallery
function extractValidUrls(galleryJson: any): string[] {
  if (!galleryJson) {
    console.log(`🔍 Gallery es null/undefined`);
    return [];
  }

  let gallery;
  try {
    gallery =
      typeof galleryJson === "string" ? JSON.parse(galleryJson) : galleryJson;
  } catch (error: any) {
    console.log(`🔍 Error parseando gallery: ${error.message}`);
    return [];
  }

  if (!Array.isArray(gallery)) {
    console.log(`🔍 Gallery no es array, es: ${typeof gallery}`);
    return [];
  }

  console.log(`🔍 Gallery tiene ${gallery.length} elementos`);

  const validUrls = gallery
    .map((item, index) => {
      // Solo usar el campo url
      let selectedUrl = item.url;
      if (!selectedUrl || selectedUrl === "URL_NOT_FOUND") {
        console.log(`🔍 Item ${index}: URL inválida (${selectedUrl})`);
        return null;
      }
      console.log(`🔍 Item ${index}: URL válida (${selectedUrl})`);
      return selectedUrl;
    })
    .filter((url) => url !== null);

  console.log(`🔍 URLs válidas extraídas: ${validUrls.length}`);
  return validUrls;
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
      const dataDir = path.join(process.cwd(), "data");
      const files = fs.readdirSync(dataDir);
      const jsonFile = files.find(
        (file) => file.startsWith("product_") && file.endsWith(".json")
      );

      if (!jsonFile) {
        throw new Error("No product JSON file found in data directory");
      }

      const filePath = path.join(dataDir, jsonFile);
      const fileContent = fs.readFileSync(filePath, "utf8");
      const products = JSON.parse(fileContent) as Array<{ uuid: string }>;

      this.productUUIDs = products.map((p) => p.uuid);
      this.log(
        `Loaded ${this.productUUIDs.length} product UUIDs from ${jsonFile}`
      );
    } catch (error) {
      this.logError("Error loading product UUIDs from JSON:", error);
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
    let uuidsForChunk = this.productUUIDs.slice(
      chunk.startOffset,
      chunk.endOffset
    );

    if (TEST_MODE) {
      uuidsForChunk = uuidsForChunk.slice(
        0,
        Math.min(TEST_LIMIT - chunk.startOffset, chunkSize)
      );
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
          // console.log(
          //   `[MULTIMEDIA] 🖼️ Procesando multimedia para producto: ${oldProd.externalId}`
          // );
          // const multimediaCount = await this.migrateMultimedia(
          //   oldProd,
          //   productId
          // );
          // stats.multimediaCreated += multimediaCount;
          // console.log(
          //   `[MULTIMEDIA] ✅ Multimedia procesada: ${multimediaCount} elementos para producto: ${oldProd.externalId}`
          // );

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
        `Error creating/updating provider for product ${productData.externalId} ${productData.platform} ${productData.country}: `,
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

      // Obtener categoría correcta usando la nueva lógica
      let baseCategoryId: string;
      try {
        // Verificar si el producto ya existe y tiene baseCategoryId
        const existingCategoryId = existingProduct.length > 0 ? existingProduct[0].baseCategoryId : null;

        // Obtener nombre de categoría del producto viejo
        let categoryName: string | null = null;
        if (
          productData.categories &&
          Array.isArray(productData.categories) &&
          productData.categories.length > 0
        ) {
          const firstCategory = productData.categories[0] as CategoryData;
          categoryName = firstCategory?.name || null;
        }

        baseCategoryId = await getValidBaseCategoryId(
          existingCategoryId,
          categoryName,
          platformType
        );

        console.log(
          `[CATEGORY] Categoría obtenida para ${productData.externalId}: ${baseCategoryId} (${existingCategoryId ? 'por ID' : 'por nombre'})`
        );
      } catch (error) {
        console.warn(
          `Category error for product ${productData.externalId}, using fallback:`,
          error
        );
        // Usar fallback de "otro" en caso de error
        baseCategoryId = "04c74a18-91d5-499d-bfe5-9593ce825d7b";
      }

      const productPayload = {
        id: productId,
        externalId: productData.externalId,
        name: productData.name || "Sin nombre",
        description: productData.description || undefined,
        salePrice: productData.salePrice,
        suggestedPrice: productData.suggestedPrice,
        totalBilling: productData.totalSalesAmount,
        billingLast7Days: productData.salesLast7Days,
        billingLast30Days: productData.salesLast30Days ,
        totalSoldUnits: productData.totalSoldUnits,
        soldUnitsLast7Days: productData.soldUnitsLast7Days,
        soldUnitsLast30Days: productData.soldUnitsLast30Days,
        stock: productData.stock,
        variationsAmount: productData.variationsAmount,
        score: productData.score || 0,
        status: (productData.visible ? "ACTIVE" : "INACTIVE") as
          | "ACTIVE"
          | "INACTIVE",
        platformCountryId: platformCountryId,
        providerId: providerId,
        baseCategoryId: baseCategoryId,
        createdAt: productData.createdAt,
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
          this.log(
            `[PRODUCT] 🔄 Actualizado producto: ${productId} (ID: ${productId})`
          );
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
          `[HISTORY] ✅ No hay fechas faltantes para producto: ${productId}`
        );
        return 0;
      }

      console.log(
        `[HISTORY] 📊 Fechas faltantes encontradas: ${missingDates.length} para producto: ${productId}`
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
        `[HISTORY] 📋 Datos históricos obtenidos: ${missingHistoriesData.length} registros para producto: ${productId}`
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

      // Track inserted count outside the block
      let insertedCount = 0;

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
          `[HISTORY] 💾 Insertando ${historiesToInsert.length} registros de historial para producto: ${productId}`
        );

        // Insert in smaller batches to avoid connection timeouts
        const batchSize = 50;

        for (let i = 0; i < historiesToInsert.length; i += batchSize) {
          const batch = historiesToInsert.slice(i, i + batchSize);
          try {
            await productsDb.insert(histories).values(batch);
            insertedCount += batch.length;
            console.log(
              `[HISTORY] 📝 Batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(
                historiesToInsert.length / batchSize
              )} insertado (${insertedCount}/${
                historiesToInsert.length
              }) para producto: ${productData.externalId}`
            );
          } catch (batchError) {
            console.warn(
              `[HISTORY] ⚠️ Error insertando batch ${
                Math.floor(i / batchSize) + 1
              } para producto: ${productId}:`,
              batchError
            );
            // Try individual inserts for this batch
            for (const item of batch) {
              try {
                await productsDb.insert(histories).values([item]);
                insertedCount++;
              } catch (itemError) {
                console.warn(
                  `[HISTORY] ⚠️ Error insertando registro individual para producto: ${productData.externalId}, fecha: ${item.date}:`,
                  itemError
                );
              }
            }
          }
        }

        console.log(
          `[HISTORY] ✅ Historial insertado exitosamente: ${insertedCount}/${historiesToInsert.length} registros para producto: ${productId}`
        );
      }

      return insertedCount;
    } catch (error) {
      console.log(
        `[HISTORY] ❌ Error procesando historial para producto: ${productId}`
      );
      this.logError(
        `Error updating history for product [UNIQUE_ID: ${productId}] - Platform: ${productData.platform}, Country: ${productData.country}:`,
        error
      );
      return 0;
    }
  }

  /**
   * Migrar multimedia desde gallery JSON usando la nueva lógica mejorada
   */
  private async migrateMultimedia(
    productData: OldProduct,
    productId: string
  ): Promise<number> {
    try {
      const { uuid: productUuid, gallery, country } = productData;

      // Extraer URLs válidas del gallery usando la nueva función
      const validUrls = extractValidUrls(gallery);

      if (validUrls.length === 0) {
        console.log(`⚠️  [${productUuid}] Sin URLs válidas en gallery`);
        return 0;
      }

      console.log(
        `✅ [${productUuid}] Producto existe, procesando ${validUrls.length} URLs`
      );

      // Verificar si ya existen registros multimedia para este producto
      const existingItems = await productsDb
        .select()
        .from(multimedia)
        .where(eq(multimedia.productId, productId));

      let updatedCount = 0;
      let insertedCount = 0;

      if (existingItems.length > 0) {
        // Actualizar registros existentes solo actualizando originalUrl
        for (let i = 0; i < Math.min(existingItems.length, validUrls.length); i++) {
          const normalizedUrl = normalizeUrl(validUrls[i], country);
          try {
            await productsDb
              .update(multimedia)
              .set({
                originalUrl: normalizedUrl,
                updatedAt: new Date().toISOString(),
              })
              .where(eq(multimedia.id, existingItems[i].id));
            updatedCount++;
          } catch (updateError) {
            console.warn(
              `[MULTIMEDIA] ⚠️ Error actualizando registro multimedia para producto: ${productId}:`,
              updateError
            );
          }
        }

        // Si hay más URLs que registros existentes, insertar los nuevos
        if (validUrls.length > existingItems.length) {
          const newUrls = validUrls.slice(existingItems.length);
          const multimediaItems = newUrls.map((url) => {
            const normalizedUrl = normalizeUrl(url, country);
            return {
              id: crypto.randomUUID(),
              productId: productId,
              originalUrl: normalizedUrl,
              type: "image",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            };
          });

          // Insertar en batches
          const batchSize = 20;
          for (let i = 0; i < multimediaItems.length; i += batchSize) {
            const batch = multimediaItems.slice(i, i + batchSize);
            try {
              await productsDb.insert(multimedia).values(batch);
              insertedCount += batch.length;
            } catch (batchError) {
              console.warn(
                `[MULTIMEDIA] ⚠️ Error insertando batch multimedia para producto: ${productId}:`,
                batchError
              );
              // Try individual inserts for this batch
              for (const item of batch) {
                try {
                  await productsDb.insert(multimedia).values([item]);
                  insertedCount++;
                } catch (itemError) {
                  console.warn(
                    `[MULTIMEDIA] ⚠️ Error insertando elemento multimedia individual para producto: ${productId}:`,
                    itemError
                  );
                }
              }
            }
          }
        }

        console.log(`✅ [${productUuid}] Actualizadas ${updatedCount} URLs, insertadas ${insertedCount} URLs nuevas`);
        return updatedCount + insertedCount;
      } else {
        // No hay registros existentes, insertar todos los nuevos
        const multimediaItems = validUrls.map((url) => {
          const normalizedUrl = normalizeUrl(url, country);
          return {
            id: crypto.randomUUID(),
            productId: productId,
            originalUrl: normalizedUrl,
            type: "image",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
        });

        // Insertar en batches
        const batchSize = 20;
        for (let i = 0; i < multimediaItems.length; i += batchSize) {
          const batch = multimediaItems.slice(i, i + batchSize);
          try {
            await productsDb.insert(multimedia).values(batch);
            insertedCount += batch.length;
          } catch (batchError) {
            console.warn(
              `[MULTIMEDIA] ⚠️ Error insertando batch multimedia para producto: ${productId}:`,
              batchError
            );
            // Try individual inserts for this batch
            for (const item of batch) {
              try {
                await productsDb.insert(multimedia).values([item]);
                insertedCount++;
              } catch (itemError) {
                console.warn(
                  `[MULTIMEDIA] ⚠️ Error insertando elemento multimedia individual para producto: ${productId}:`,
                  itemError
                );
              }
            }
          }
        }

        console.log(`✅ [${productUuid}] Insertadas ${insertedCount} URLs nuevas`);
        return insertedCount;
      }
    } catch (error: any) {
      console.error(`❌ [${productData.uuid}] Error:`, error.message);
      this.logError(
        `Error updating multimedia for product [UNIQUE_ID: ${productData.externalId}] - Platform: ${productData.platform}, Country: ${productData.country}:`,
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
