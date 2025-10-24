import { and, eq } from 'drizzle-orm';
import { productsDb } from '../../db/config/products';
import { countries, platformCountries, PlatformType, type Countries } from '../../db/schemas/products';

// Cache for countries to avoid repeated database queries
const countryCache = new Map<string, any>();

export const getCountry = async (countryCode: typeof Countries[keyof typeof Countries]) => {
    // Check cache first
    if (countryCache.has(countryCode)) {
        return countryCache.get(countryCode);
    }

    const country = await productsDb.select()
        .from(countries)
        .where(eq(countries.code, countryCode))
        .execute();

    if (country.length === 0) {
        throw new Error(`Country with code ${countryCode} not found`);
    }

    // Cache the result
    countryCache.set(countryCode, country[0]);
    return country[0];
};

export const getPlatformCountryId = async ({
    countryCode,
    platformId,
}: { countryCode: typeof Countries[keyof typeof Countries], platformId: PlatformType }) => {
    try {
        const country = await getCountry(countryCode);

        if (!country || !country.id) {
            throw new Error(`Country with code ${countryCode} not found`);
        }

        // Convert PlatformType enum to platform text ID (lowercase)
        // "DROPI" -> "dropi", "ALICLICK" -> "aliclick", etc.
        const platformTextId = platformId.toLowerCase();

        const platformCountry = await productsDb.select()
            .from(platformCountries)
            .where(
                and(
                    eq(platformCountries.countryId, country.id),
                    eq(platformCountries.platformId, platformTextId),
                ),
            )
            .execute();

        if (platformCountry.length === 0 || !platformCountry[0]?.id) {
            throw new Error(`Platform country not found for platform ${platformId} (${platformTextId}) and country ${countryCode}`);
        }

        return platformCountry[0].id;
    } catch (error) {
        throw error;
    }
};



