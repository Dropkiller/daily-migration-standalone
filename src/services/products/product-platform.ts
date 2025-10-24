import { productsDb } from "../../db/config/products";
import { productPlatforms, type InsertProductPlatform } from "../../db/schemas/products/schema";

export const createProductPlatformBatch = async (newProductPlatforms: InsertProductPlatform[]) => {
    return await productsDb.insert(productPlatforms).values(newProductPlatforms).returning();
}
