import { and, eq } from "drizzle-orm";
import { productsDb } from "../../db/config/products";
import { providers, type InsertProviderPartial, type InsertProvider } from "../../db/schemas/products";

export const createProvider = async (provider: InsertProvider) => {
    const [product] = await productsDb.insert(providers).values(provider).onConflictDoNothing().returning();

    if (!product) {
        // Si no se insertó, buscar el proveedor existente
        const existingProvider = await getProviderByExternalIdAndPlatformCountryId(provider.externalId, provider.platformCountryId);
        if (existingProvider) {
            return existingProvider.id;
        }
        throw new Error('Provider not created and not found');
    }

    return product.id;
}

export const createProvidersBatch = async (providersList: {
    platformCountryId: string,
    providers: InsertProviderPartial[]
}) => {
    if (providersList.providers.length === 0) return;

    const providersToInsert = providersList.providers.map((provider) => ({
        ...provider,
        platformCountryId: providersList.platformCountryId,
    }));

    await productsDb.insert(providers).values(providersToInsert).onConflictDoNothing().returning();

    return providersToInsert.map((provider) => provider.id);
}

export const getProviderByExternalIdAndPlatformCountryId = async (externalId: string, platformCountryId: string) => {
    const [provider] = await productsDb.select().from(providers)
        .where(
            and(
                eq(providers.externalId, externalId),
                eq(providers.platformCountryId, platformCountryId)
            )
        )
        .execute();

    return provider;
}

export const getProviderByNameAndPlatformCountryId = async (name: string, platformCountryId: string) => {
    const [provider] = await productsDb.select().from(providers)
        .where(
            and(
                eq(providers.name, name),
                eq(providers.platformCountryId, platformCountryId)
            )
        )
        .execute();

    return provider;
}
