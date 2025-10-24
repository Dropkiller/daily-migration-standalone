import { productsDb } from "../../db/config/products";
import { products, type InsertProductPartial, type InsertProduct } from "../../db/schemas/products";

export const createProductsBatch = async ({ platformCountryId, productsToInsert }: { platformCountryId: string, productsToInsert: InsertProductPartial[] }) => {
    try {
        const mappedProducts = productsToInsert.map((product) => ({
            ...product,
            platformCountryId: platformCountryId,
        }));

        await productsDb.insert(products).values(mappedProducts as InsertProduct[]);
    } catch (error) {
        console.error('Error creating products batch:', error);
        throw error;
    }
}


