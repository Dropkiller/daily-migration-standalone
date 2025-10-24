import { productsDb } from "../../db/config/products";
import { histories, type InsertHistory } from "../../db/schemas/products";

export const createHistoriesBatch = async (historiesToCreate: InsertHistory[]) => {
    return await productsDb.insert(histories).values(historiesToCreate).returning();
}