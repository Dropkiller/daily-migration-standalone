import { env } from '../../config';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as productsSchema from '../schemas/products';
import { Pool } from 'pg';

const productsDbPool = new Pool({
    connectionString: env.PRODUCTS_DATABASE_URL,
    max: 5,
    min: 1,
    idleTimeoutMillis: 60000,
    connectionTimeoutMillis: 30000,
});

productsDbPool.on('connect', (client) => {
    console.log('Products DB: Connected successfully');
    // Configure PostgreSQL timeouts directly
    client.query('SET statement_timeout = 300000'); // 5 minutes
    client.query('SET idle_in_transaction_session_timeout = 600000'); // 10 minutes
    client.query('SET lock_timeout = 120000'); // 2 minutes
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
