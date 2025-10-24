import { createClient } from "redis";
import { env } from "../../config";

export const redisClient = createClient({
    url: env.REDIS_URL,
});

// Manejo de eventos de conexión
redisClient.on('connect', () => {
    console.log('Redis: Conectado exitosamente');
});

redisClient.on('reconnecting', () => {
    console.log('Redis: Reconectando...');
});

redisClient.on('error', (error) => {
    console.error('Redis: Error de conexión:', error);
});

redisClient.on('end', () => {
    console.log('Redis: Conexión cerrada');
});

// Conectar con reintentos automáticos
try {
    await redisClient.connect();
} catch (error) {
    console.error("Redis: Error inicial al conectar:", error);
    // El cliente intentará reconectar automáticamente según la estrategia configurada
}
