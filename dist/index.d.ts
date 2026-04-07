import mysql from 'mysql2/promise';
import Redis from 'ioredis';
import winston from 'winston';
declare const app: import("express-serve-static-core").Express;
declare const logger: winston.Logger;
export declare function getDatabase(): mysql.Pool;
export declare function getRedis(): Redis;
export { app, logger };
//# sourceMappingURL=index.d.ts.map