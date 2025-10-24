import { env } from '../../config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as oldSchema from '../schemas/old';


export const oldDbPool = new Pool({
    connectionString: env.OLD_DATABASE_URL,
    max: 1,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000,
});

oldDbPool.on('connect', () => {
    console.log('Old DB: Connected successfully');
});

oldDbPool.on('error', (err) => {
    console.error('Old DB: Unexpected error on idle client', err);
    process.exit(1);
});

export const oldDb = drizzle(oldDbPool, {
    schema: oldSchema,
});

// Configurar timeouts a nivel de conexión
oldDbPool.on('connect', (client) => {
    // Configurar timeouts directamente en PostgreSQL
    client.query('SET statement_timeout = 300000'); // 5 minutos
    client.query('SET idle_in_transaction_session_timeout = 600000'); // 10 minutos
    client.query('SET lock_timeout = 120000'); // 2 minutos
});

export const closeOldDb = async () => {
    await oldDbPool.end();
    console.log('Old DB: Connection pool closed');
};
