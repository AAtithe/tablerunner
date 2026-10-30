// Vercel function serving every /api route (see the rewrite in vercel.json).
import { createHandler } from '../src/vercel.js';
import { createLiveApp } from '../src/live.js';

export default createHandler(process.env, () => createLiveApp(process.env));
