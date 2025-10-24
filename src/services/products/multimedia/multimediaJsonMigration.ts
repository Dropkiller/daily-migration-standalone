import { eq, count, notExists, asc } from "drizzle-orm";
import { BaseMigration, type ChunkState, type ChunkResult, type MigrationConfig } from "../../../scripts/BaseMigration";
import { productsDb } from "../../../db/config/products";
import { multimedia, products } from "../../../db/schemas/products";
import { getOldProductsFromJson, getOldProductsCountFromJson, hasJsonData } from "../old/products-json";
import type { OldProduct } from "../../../db/schemas/old/schema";

// Global cache para evitar cargar JSON en cada chunk
let jsonProductMapCache: Map<string, OldProduct> | null = null;

interface NewMultimediaItem {
    id: string;
    type: string;
    url: string;
    originalUrl: string;
    productId: string;
    extracted: boolean;
    createdAt: string;
    updatedAt: string;
}

/**
 * Multimedia migration service using JSON data source
 * Migrates gallery/multimedia data from JSON products to new products database
 */
export class MultimediaJsonMigration extends BaseMigration<OldProduct> {

    constructor(config?: MigrationConfig) {
        const defaultConfig: MigrationConfig = {
            stateKey: 'multimedia-json-migration-state',
            chunksKey: 'multimedia-json-migration-chunks',
            lockPrefix: 'multimedia-json-migration-lock:',
            batchSize: 100,
            chunkSize: 500,
            lockTTL: 300,
            lockRenewInterval: 60000
        };
        super(config || defaultConfig);
    }

    /**
     * Get total count of products without multimedia (for chunk processing)
     * Strategy: Count ALL products without multimedia, then process JSON in chunks
     */
    protected async getTotalRecords(): Promise<number> {
        if (!hasJsonData()) {
            throw new Error('JSON data file not found. Please place all-products.json in data/products/ directory');
        }

        this.log('Counting products without multimedia in new database...');

        // Count ALL products that don't have any multimedia records
        const [result] = await productsDb
            .select({ count: count() })
            .from(products)
            .where(
                notExists(
                    productsDb
                        .select()
                        .from(multimedia)
                        .where(eq(multimedia.productId, products.id))
                )
            );

        const productsWithoutMultimedia = result.count;
        this.log(`Found ${productsWithoutMultimedia} products without multimedia - will process against JSON data`);

        return productsWithoutMultimedia;
    }

    /**
     * Process a chunk of products and their gallery data from JSON
     */
    protected async processChunk(chunk: ChunkState): Promise<ChunkResult> {
        this.log(`Processing chunk ${chunk.chunkId} (${chunk.startOffset} to ${chunk.endOffset})`);

        // Get eligible products from this chunk (products with gallery that need migration)
        const eligibleProducts = await this.getEligibleProductsForChunk(chunk);

        if (eligibleProducts.length === 0) {
            return { processed: 0, inserted: 0, skipped: 0, errors: 0, processedCount: 0 };
        }

        let processed = 0;
        let inserted = 0;
        let skipped = 0;
        let errors = 0;

        // Process each eligible product's gallery
        for (const product of eligibleProducts) {
            try {
                processed++;

                // Parse gallery JSON con validación robusta
                let galleryData: any[];
                try {
                    galleryData = JSON.parse(product.gallery as string);
                } catch (parseError) {
                    errors++;
                    continue;
                }

                if (!Array.isArray(galleryData) || galleryData.length === 0) {
                    skipped++;
                    continue;
                }

                // Filtrar solo elementos válidos
                const validGalleryItems = galleryData.filter(item =>
                    item &&
                    typeof item === 'object' &&
                    (item.url || item.sourceUrl)
                );

                if (validGalleryItems.length === 0) {
                    skipped++;
                    continue;
                }

                // Create multimedia items from gallery data
                const multimediaItems: NewMultimediaItem[] = [];
                const now = new Date().toISOString();

                for (const item of validGalleryItems) {
                    const crypto = require('crypto');
                    const multimediaId = crypto.randomUUID();

                    // Process and complete the URL
                    let url = item.url || '';
                    const originalUrl = item.sourceUrl || url;

                    // Apply URL completion logic: SOLO concatenar si NO empieza con https://
                    // Las URLs que ya tienen https:// se guardan tal cual
                    if (url && !url.startsWith('https://') && /^[a-z]+\//.test(url)) {
                        url = 'https://d39ru7awumhhs2.cloudfront.net/' + url;
                    }
                    // Si ya tiene https://, se guarda sin modificar

                    // Determine media type from URL
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
                        url: url,
                        originalUrl: url,
                        productId: product.uuid,
                        extracted: false,
                        createdAt: now,
                        updatedAt: now
                    });
                }

                // Insert multimedia items in batch
                if (multimediaItems.length > 0) {
                    await productsDb.insert(multimedia).values(multimediaItems);
                    inserted += multimediaItems.length;
                    this.log(`✓ Inserted ${multimediaItems.length} multimedia items for product ${product.uuid}`);
                } else {
                    skipped++;
                }

            } catch (error) {
                this.logError(`Error processing product ${product.uuid}:`, error);
                errors++;
            }
        }

        return {
            processed,
            inserted,
            skipped,
            errors,
            processedCount: processed // Para compatibilidad con BaseMigration
        };
    }

    /**
     * Override initializeChunks to also initialize JSON cache
     */
    public async initializeChunks(totalRecords?: number): Promise<number> {
        // Initialize JSON cache first
        if (!jsonProductMapCache) {
            await this.initializeJsonCache();
        }

        // Then call parent implementation
        return await super.initializeChunks(totalRecords);
    }

    /**
     * Initialize global JSON cache from file
     */
    private async initializeJsonCache(): Promise<void> {
        this.log('Initializing JSON cache from file...');

        try {
            // Load all products from JSON using the existing utility
            const allProductsFromJson = getOldProductsFromJson({ take: 1000000, skip: 0 }); // Load all

            // Convert to Map for fast lookups by UUID
            jsonProductMapCache = new Map();
            for (const product of allProductsFromJson) {
                jsonProductMapCache.set(product.uuid, product);
            }

            this.log(`JSON cache initialized with ${jsonProductMapCache.size} products`);
        } catch (error) {
            this.logError('Failed to initialize JSON cache:', error);
            throw error;
        }
    }

    /**
     * Get products for a specific chunk and check their gallery data in JSON
     * Strategy: Get chunk of products without multimedia, then use SAME IDs to find in JSON
     */
    private async getEligibleProductsForChunk(
        chunk: ChunkState
    ): Promise<Array<{uuid: string, gallery: string}>> {
        this.log(`Processing chunk ${chunk.chunkId} (${chunk.startOffset} to ${chunk.endOffset})`);

        // 1. Get products without multimedia for this specific chunk (EXACTO mismo patrón)
        const chunkSize = chunk.endOffset - chunk.startOffset;
        const productsWithoutMultimedia = await productsDb
            .select({
                id: products.id
            })
            .from(products)
            .where(
                notExists(
                    productsDb
                        .select()
                        .from(multimedia)
                        .where(eq(multimedia.productId, products.id))
                )
            )
            .orderBy(asc(products.id)) // Use consistent ordering
            .offset(chunk.startOffset)
            .limit(chunkSize);

        this.log(`Found ${productsWithoutMultimedia.length} products without multimedia for chunk ${chunk.chunkId}`);

        if (productsWithoutMultimedia.length === 0) {
            return [];
        }

        // 2. Usar cache JSON global (ya inicializado)
        if (!jsonProductMapCache) {
            this.log('Warning: JSON cache not initialized, initializing now...');
            await this.initializeJsonCache();
        }

        this.log(`Using cached JSON data with ${jsonProductMapCache!.size} products`);

        // 3. Para cada producto sin multimedia, buscar EN EL JSON usando el MISMO ID (uuid)
        const eligibleProducts = [];

        for (const product of productsWithoutMultimedia) {
            try {
                // Buscar el producto específico en JSON usando el mismo ID (desde cache)
                const jsonProduct = jsonProductMapCache!.get(product.id);

                if (jsonProduct?.gallery) {
                    try {
                        // Limpiar y validar el JSON antes de parsearlo
                        let galleryString = jsonProduct.gallery as string;

                        // Verificar que sea un string válido y no esté vacío
                        if (typeof galleryString !== 'string' || galleryString.trim().length === 0) {
                            continue;
                        }

                        // Limpiar datos
                        galleryString = galleryString.trim();

                        // Verificar que sea un array JSON válido
                        if (!galleryString.startsWith('[') || !galleryString.endsWith(']')) {
                            continue;
                        }

                        const galleryData = JSON.parse(galleryString);
                        if (Array.isArray(galleryData) && galleryData.length > 0) {
                            // Verificar que tengan elementos válidos
                            const validItems = galleryData.filter(item =>
                                item &&
                                typeof item === 'object' &&
                                (item.url || item.sourceUrl)
                            );

                            if (validItems.length > 0) {
                                eligibleProducts.push({
                                    uuid: product.id, // Usar el mismo ID que se buscó
                                    gallery: JSON.stringify(validItems) // Guardar solo los items válidos
                                });
                            }
                        }
                    } catch (error) {
                        // Solo log críticos para evitar spam
                        this.log(`Warning: Invalid gallery JSON for product ${product.id}`);
                        continue;
                    }
                }
            } catch (error) {
                this.log(`Error searching product ${product.id} in JSON: ${error}`);
            }
        }

        this.log(`Found ${eligibleProducts.length} products with valid gallery data for chunk ${chunk.chunkId}`);
        return eligibleProducts;
    }

    /**
     * Custom progress with multimedia-specific metrics
     */
    protected getCustomProgress(): Record<string, any> {
        return {
            source: 'JSON file products data (gallery field)',
            target: 'Products database multimedia table',
            notes: 'Migrating gallery/multimedia data from JSON for products without existing gallery items'
        };
    }

    /**
     * Finalization logic
     */
    protected async onComplete(): Promise<void> {
        this.log('Multimedia JSON migration completed successfully!');

        try {
            // Apply URL completion to existing multimedia items
            await this.fixIncompleteUrls();

            // Get final counts from database
            const galleryCountResult = await productsDb.select({ count: count() })
                .from(multimedia);

            const productsCountResult = await productsDb.select({ count: count() })
                .from(products);

            const productsWithGalleryResult = await productsDb.select({ count: count() })
                .from(multimedia)
                .groupBy(multimedia.productId);

            this.log(`✓ Total multimedia items in database: ${galleryCountResult[0]?.count || 0}`);
            this.log(`✓ Total products in database: ${productsCountResult[0]?.count || 0}`);
            this.log(`✓ Products with multimedia items: ${productsWithGalleryResult.length || 0}`);

        } catch (error) {
            this.log('Could not get final counts from database, but migration completed');
        }
    }

    /**
     * Fix incomplete URLs in multimedia table
     * SOLO concatena CloudFront a URLs que NO empiecen con https://
     * Las URLs con https:// se mantienen intactas
     */
    private async fixIncompleteUrls(): Promise<void> {
        this.log('Applying URL completion to existing multimedia items (skipping https:// URLs)...');

        try {
            // Use raw SQL: SOLO actualiza URLs que NO tienen https://
            const result = await productsDb.execute(`
                UPDATE multimedia
                SET url = 'https://d39ru7awumhhs2.cloudfront.net/' || url,
                    updated_at = CURRENT_TIMESTAMP
                WHERE url NOT LIKE 'https://%'
                  AND url ~ '^[a-z]+/'
            `);

            this.log(`✓ Updated URLs for ${result.rowCount || 0} multimedia items (URLs with https:// were preserved)`);

        } catch (error) {
            this.logError('Error fixing incomplete URLs:', error);
        }
    }
}