import { env } from '../../config';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as productsSchema from '../schemas/products';
import { Pool } from 'pg';

const productsDbPool = new Pool({
    connectionString: env.PRODUCTS_DATABASE_URL,
    max: 1,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000,
});

productsDbPool.on('connect', () => {
    console.log('Products DB: Connected successfully');
});

productsDbPool.on('error', (err) => {
    console.error('Products DB: Unexpected error on idle client', err);
    process.exit(1);
});

export const productsDb = drizzle(productsDbPool, {
    schema: productsSchema,
});

export const closeProductsDb = async () => {
    await productsDbPool.end();
    console.log('Products DB: Connection pool closed');
};
