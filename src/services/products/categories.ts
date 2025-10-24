import { and, eq, ilike } from "drizzle-orm";
import crypto from "crypto";

import { productsDb } from "../../db/config/products";
import { baseCategories, platformCategories, PlatformType } from "../../db/schemas/products";

const FALLBACK_BASE_CATEGORY_ID = "09ad0d8c-9f58-45f8-8168-935b890ee70b";

export const getBaseCategoryByName = async (name: string, platform?: PlatformType) => {
    let baseCategoryId: string | undefined;

    // 1. Buscar primero en base_categories (exacto)
    const [exactBaseCategory] = await productsDb.select().from(baseCategories)
        .where(eq(baseCategories.name, name))
        .execute();

    if (exactBaseCategory) {
        return exactBaseCategory.id;
    }

    // 2. Buscar en platform_categories (exacto) y obtener el baseCategoryId
    if (platform) {
        const platformCategoryId = await getPlatformCategoryByNameAndPlatform(name, platform);
        if (platformCategoryId) {
            const [platformCategory] = await productsDb.select().from(platformCategories)
                .where(eq(platformCategories.id, platformCategoryId))
                .execute();

            if (platformCategory) {
                return platformCategory.baseCategoryId;
            }
        }
    }

    // 3. Buscar con similitud en base_categories (case insensitive)
    const [similarBaseCategory] = await productsDb.select().from(baseCategories)
        .where(ilike(baseCategories.name, name))
        .execute();

    if (similarBaseCategory) {
        return similarBaseCategory.id;
    }

    // 4. Buscar con similitud en platform_categories (case insensitive)
    if (platform) {
        const [similarPlatformCategory] = await productsDb.select().from(platformCategories)
            .where(
                and(
                    eq(platformCategories.platformId, platform),
                    ilike(platformCategories.name, name)
                )
            )
            .execute();

        if (similarPlatformCategory) {
            return similarPlatformCategory.baseCategoryId;
        }
    }

    // 5. Buscar categorías similares por palabras clave (busqueda parcial)
    const searchTerm = `%${name.toLowerCase()}%`;

    const [partialBaseCategory] = await productsDb.select().from(baseCategories)
        .where(ilike(baseCategories.name, searchTerm))
        .execute();

    if (partialBaseCategory) {
        return partialBaseCategory.id;
    }

    // 6. Buscar en platform_categories con búsqueda parcial
    if (platform) {
        const [partialPlatformCategory] = await productsDb.select().from(platformCategories)
            .where(
                and(
                    eq(platformCategories.platformId, platform),
                    ilike(platformCategories.name, searchTerm)
                )
            )
            .execute();

        if (partialPlatformCategory) {
            return partialPlatformCategory.baseCategoryId;
        }
    }

    // 7. Si no se encuentra nada, usar categoría fallback
    console.log(`Category ${name} not found, using fallback category ID: ${FALLBACK_BASE_CATEGORY_ID}`);
    return FALLBACK_BASE_CATEGORY_ID;
}

export const getPlatformCategoryByNameAndPlatform = async (name: string, platform: PlatformType) => {
    const [category] = await productsDb.select().from(platformCategories)
        .where(
            and(
                eq(platformCategories.platformId, platform),
                eq(platformCategories.name, name),
            ),
        )
        .execute();

    return category?.id;
}

export const createBaseCategory = async (name: string) => {
    const newCategoryId = crypto.randomUUID();
    const [insertedCategory] = await productsDb.insert(baseCategories).values({
        id: newCategoryId,
        name: name,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    }).onConflictDoNothing().returning();

    if (!insertedCategory) {
        // Si no se insertó, buscar la categoría existente
        const [existingCategory] = await productsDb.select().from(baseCategories)
            .where(eq(baseCategories.name, name))
            .execute();
        
        if (existingCategory) {
            return existingCategory.id;
        }
        throw new Error(`Base category ${name} not created and not found`);
    }

    return newCategoryId;
}

export const createPlatformCategory = async (name: string, platform: PlatformType, baseCategoryId: string) => {
    const newPlatformCategoryId = crypto.randomUUID();
    const externalId = `${platform}_${name.toLowerCase().replace(/\s+/g, '_')}`;
    
    const [insertedCategory] = await productsDb.insert(platformCategories).values({
        id: newPlatformCategoryId,
        externalId: externalId,
        name: name,
        platformId: platform,
        baseCategoryId: baseCategoryId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    }).onConflictDoNothing().returning();

    if (!insertedCategory) {
        // Si no se insertó, buscar la categoría existente
        const [existingCategory] = await productsDb.select().from(platformCategories)
            .where(
                and(
                    eq(platformCategories.externalId, externalId),
                    eq(platformCategories.platformId, platform)
                )
            )
            .execute();
        
        if (existingCategory) {
            return existingCategory.id;
        }
        throw new Error(`Platform category ${name} not created and not found`);
    }

    return newPlatformCategoryId;
}