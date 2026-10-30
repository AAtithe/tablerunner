// Vercel function serving every /api route (see the rewrite in vercel.json).
// All settings live in the app; the only environment input is the storage
// connection Vercel adds when Upstash Redis is connected to the project.
import { createHandler } from '../src/vercel.js';
import { redisFromEnv } from '../src/live.js';

export default createHandler({ getRedis: () => redisFromEnv(process.env) });
