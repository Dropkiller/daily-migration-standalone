import { and, eq, ilike } from "drizzle-orm";

import { productsDb } from "../../db/config/products";
import { baseCategories, platformCategories, PlatformType } from "../../db/schemas/products";

// Fallback category ID para "otro" - categoria que debe existir en DB después del cleanup
const FALLBACK_BASE_CATEGORY_ID = "04c74a18-91d5-499d-bfe5-9593ce825d7b";

// Cache en memoria para las categorías existentes (se carga una vez)
let categoryCache: Map<string, string> | null = null;

const loadCategoryCache = async (): Promise<Map<string, string>> => {
    if (categoryCache) {
        return categoryCache;
    }

    console.log('🗂️ Cargando caché de categorías existentes en DB...');

    // Cargar todas las categorías base existentes
    const allCategories = await productsDb.select({
        id: baseCategories.id,
        name: baseCategories.name
    }).from(baseCategories).execute();

    categoryCache = new Map<string, string>();

    for (const category of allCategories) {
        // Guardar tanto el nombre exacto como variaciones normalizadas
        const normalizedName = category.name.toLowerCase().trim();
        categoryCache.set(category.name, category.id); // Nombre exacto
        categoryCache.set(normalizedName, category.id); // Nombre normalizado
    }

    console.log(`✅ Caché cargado con ${allCategories.length} categorías existentes en DB`);
    return categoryCache;
};

export const getBaseCategoryByName = async (name: string, platform?: PlatformType): Promise<string> => {
    if (!name || typeof name !== 'string') {
        console.log(`⚠️ Nombre de categoría inválido: "${name}", usando fallback`);
        return FALLBACK_BASE_CATEGORY_ID;
    }

    const cache = await loadCategoryCache();
    const normalizedInputName = name.toLowerCase().trim();

    // 1. Búsqueda exacta (case sensitive)
    if (cache.has(name)) {
        return cache.get(name)!;
    }

    // 2. Búsqueda exacta normalizada (case insensitive)
    if (cache.has(normalizedInputName)) {
        return cache.get(normalizedInputName)!;
    }

    // 3. Buscar en platform_categories si se proporciona plataforma
    if (platform) {
        try {
            const platformCategoryId = await getPlatformCategoryByNameAndPlatform(name, platform);
            if (platformCategoryId) {
                const [platformCategory] = await productsDb.select().from(platformCategories)
                    .where(eq(platformCategories.id, platformCategoryId))
                    .execute();

                if (platformCategory) {
                    return platformCategory.baseCategoryId;
                }
            }
        } catch (error) {
            console.log(`⚠️ Error buscando en platform_categories: ${error}`);
        }
    }

    // 4. Búsqueda parcial/fuzzy en categorías existentes
    for (const [cachedName, categoryId] of cache.entries()) {
        // Verificar si el nombre de entrada contiene el nombre de la categoría
        if (normalizedInputName.includes(cachedName) || cachedName.includes(normalizedInputName)) {
            console.log(`🔍 Categoría encontrada por similitud: "${name}" → "${cachedName}"`);
            return categoryId;
        }
    }

    // 5. Mapeo especial para casos comunes (basado en tu output)
    const specialMappings: Record<string, string> = {
        'bienestar y salud': 'salud',
        'vehiculo': 'vehiculos',
        'cuidado personal': 'belleza',
        'belleza  cuidado personal': 'belleza',
        'libros': 'hogar',
        'juegos': 'jugueteria',
        'capilar': 'belleza',
        'halloween': 'jugueteria',
        'navidad': 'jugueteria',
        'importados': 'otro',
        'desarrollo': 'tecnologia'
    };

    const mappedCategory = specialMappings[normalizedInputName];
    if (mappedCategory && cache.has(mappedCategory)) {
        console.log(`🔄 Categoría mapeada: "${name}" → "${mappedCategory}"`);
        return cache.get(mappedCategory)!;
    }

    // 6. Si no se encuentra nada, usar categoría fallback "otro"
    console.log(`❌ Categoría "${name}" no encontrada, usando fallback "otro": ${FALLBACK_BASE_CATEGORY_ID}`);
    return FALLBACK_BASE_CATEGORY_ID;
}

/**
 * Validar si un baseCategoryId existe en las categorías válidas
 * Para productos existentes que ya tienen baseCategoryId
 */
export const validateBaseCategoryId = async (categoryId: string): Promise<string> => {
    if (!categoryId || typeof categoryId !== 'string') {
        console.log(`⚠️ ID de categoría inválido: "${categoryId}", usando fallback`);
        return FALLBACK_BASE_CATEGORY_ID;
    }

    const cache = await loadCategoryCache();

    // Buscar en el cache si existe el ID en las categorías válidas
    for (const [categoryName, cachedId] of cache.entries()) {
        if (cachedId === categoryId) {
            console.log(`✅ Categoría válida encontrada por ID: ${categoryId} (${categoryName})`);
            return categoryId;
        }
    }

    // Si el ID no existe en las categorías válidas, usar fallback
    console.log(`❌ ID de categoría "${categoryId}" no es válido, usando fallback "otro": ${FALLBACK_BASE_CATEGORY_ID}`);
    return FALLBACK_BASE_CATEGORY_ID;
}

/**
 * Función principal que decide si buscar por ID o por nombre
 * Usar para productos que pueden ser nuevos o existentes
 */
export const getValidBaseCategoryId = async (
    existingCategoryId: string | null | undefined,
    categoryName: string | null | undefined,
    platform?: PlatformType
): Promise<string> => {
    // Si el producto ya tiene baseCategoryId, validarlo
    if (existingCategoryId) {
        console.log(`🔍 Producto existente - validando categoría por ID: ${existingCategoryId}`);
        return await validateBaseCategoryId(existingCategoryId);
    }

    // Si es un producto nuevo, buscar por nombre
    if (categoryName) {
        console.log(`🔍 Producto nuevo - buscando categoría por nombre: "${categoryName}"`);
        return await getBaseCategoryByName(categoryName, platform);
    }

    // Si no hay ni ID ni nombre, usar fallback
    console.log(`⚠️ Sin ID ni nombre de categoría, usando fallback "otro"`);
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

// ⚠️ FUNCIONES DE CREACIÓN ELIMINADAS
// No se permiten crear nuevas categorías después del cleanup.
// Solo se usan las 25 categorías existentes en la DB.