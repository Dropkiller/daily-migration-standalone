import { eq, count, notInArray, inArray, isNotNull, and, notExists, asc } from "drizzle-orm";
import { BaseMigration, type ChunkState, type ChunkResult,type MigrationConfig } from "../../../scripts/BaseMigration";
import { productsDb } from "../../../db/config/products";
import { multimedia, products } from "../../../db/schemas/products";
import { oldDb } from "../../../db/config/old";
import { product as oldProduct } from "../../../db/schemas/old/schema";
import type { OldProduct } from "../../../db/schemas/old/schema";

interface OldProductGallery {
    productId: string;
    externalId: string;
    gallery: Array<{
        url: string;
        ownImage: string;
        sourceUrl: string;
        externalProductId: string;
    }>;
}

interface NewMultimediaItem {
    id: string;
    type: string; // Required field!
    url: string;
    originalUrl: string;
    productId: string;
    extracted: boolean;
    createdAt: string;
    updatedAt: string;
}

/**
 * Multimedia migration service
 * Migrates gallery/multimedia data from JSON products to new products database
 */
export class MultimediaMigration extends BaseMigration<OldProduct> {

    constructor(config?: MigrationConfig) {
        const defaultConfig: MigrationConfig = {
            stateKey: 'multimedia-migration-state',
            chunksKey: 'multimedia-migration-chunks',
            lockPrefix: 'multimedia-migration-lock:',
            batchSize: 100,
            chunkSize: 500,
            lockTTL: 300,
            lockRenewInterval: 60000
        };
        super(config || defaultConfig);

        // Inicializar cache JSON al crear la instancia
        this.initializeJsonCache();
    }

    /**
     * Initialize JSON cache once for all chunks
     */
    private initializeJsonCache(): void {
        if (!jsonProductMapCache) {
            this.log('Initializing JSON product cache...');
            const allJsonProducts = getOldProductsFromJson({ take: Number.MAX_SAFE_INTEGER, skip: 0 });
            jsonProductMapCache = new Map<string, OldProduct>();

            allJsonProducts.forEach(p => {
                if (p.uuid) {
                    jsonProductMapCache!.set(p.uuid, p);
                }
            });

            this.log(`JSON cache initialized with ${jsonProductMapCache.size} products`);
        }
    }

    /**
     * Get total count of products without multimedia (for chunk processing)
     * Strategy: Count ALL products without multimedia, then process each chunk to find gallery
     */
    protected async getTotalRecords(): Promise<number> {
        this.log('Counting products without multimedia in new database...');

        // Count ALL products that don't have any multimedia records (using notExists pattern)
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
        this.log(`Found ${productsWithoutMultimedia} products without multimedia - will process in chunks`);

        return productsWithoutMultimedia;
    }

    /**
     * Process a chunk of products and their gallery data from old DB
     */
    protected async processChunk(chunk: ChunkState): Promise<ChunkResult> {
        this.log(`Processing chunk ${chunk.chunkId} (${chunk.startOffset} to ${chunk.endOffset})`);

        // Get eligible products from this chunk (products with gallery that need migration)
        const eligibleProducts = await this.getEligibleProductsForChunk(chunk);

        if (eligibleProducts.length === 0) {
            return { processed: 0, inserted: 0, skipped: 0, errors: 0 };
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
                    // Limpiar y validar el JSON antes de parsearlo
                    let galleryString = product.gallery as string;

                    // Verificar que sea un string válido y no esté vacío
                    if (typeof galleryString !== 'string' || galleryString.trim().length === 0) {
                        skipped++;
                        continue;
                    }

                    // Limpiar datos
                    galleryString = galleryString.trim();

                    // Verificar que sea un array JSON válido
                    if (!galleryString.startsWith('[') || !galleryString.endsWith(']')) {
                        skipped++;
                        continue;
                    }

                    galleryData = JSON.parse(galleryString);
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
                        url: url, // URL completa con CloudFront si es necesario
                        originalUrl: originalUrl, // URL original sin modificar
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
     * Get products for a specific chunk and check their gallery data in old DB
     * Strategy: Get chunk of products without multimedia, then check gallery in old DB
     */
    private async getEligibleProductsForChunk(
        chunk: ChunkState
    ): Promise<Array<{uuid: string, gallery: string}>> {
        this.log(`Processing chunk ${chunk.chunkId} (${chunk.startOffset} to ${chunk.endOffset})`);

        // 1. Get products without multimedia for this specific chunk
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

        // 2. Query old DB for gallery data for these products
        const productIds = productsWithoutMultimedia.map(p => p.id);
        const oldDbProducts = await oldDb.select({
            uuid: oldProduct.uuid,
            gallery: oldProduct.gallery
        })
        .from(oldProduct)
        .where(and(
            inArray(oldProduct.uuid, productIds),
            isNotNull(oldProduct.gallery)
        ));

        // 3. Validate gallery data and build final list
        const eligibleProducts = [];
        for (const oldDbProduct of oldDbProducts) {
            try {
                if (oldDbProduct.gallery) {
                    // Limpiar y validar el JSON antes de parsearlo
                    let galleryString = oldDbProduct.gallery as string;

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
                                uuid: oldDbProduct.uuid,
                                gallery: JSON.stringify(validItems) // Guardar solo los items válidos
                            });
                        }
                    }
                }
            } catch (error) {
                // Solo log críticos para evitar spam
                continue;
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
            source: 'Old database products table (gallery field)',
            target: 'Products database multimedia table',
            notes: 'Migrating gallery/multimedia data from old DB for products without existing gallery items'
        };
    }

    /**
     * Finalization logic
     */
    protected async onComplete(): Promise<void> {
        this.log('Multimedia migration completed successfully!');

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
     * Applies: UPDATE multimedia SET url = 'https://d39ru7awumhhs2.cloudfront.net/' || url
     *         WHERE url NOT LIKE 'https://%' AND url ~ '^[a-z]+/'
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