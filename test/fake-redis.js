// In-process stand-in for the Upstash REST API, covering the commands the
// Redis adapters use. Each call yields to the event loop, as a network call
// would, so concurrency bugs can surface in tests.
export class FakeRedis {
  constructor() {
    this.data = new Map();
    this.calls = 0;
  }

  async cmd(name, ...args) {
    this.calls++;
    await new Promise((r) => setImmediate(r));
    const d = this.data;
    const hash = (k) => (d.has(k) ? d.get(k) : d.set(k, new Map()).get(k));
    switch (name) {
      case 'GET': return d.get(args[0]) ?? null;
      case 'DEL': return d.delete(args[0]) ? 1 : 0;
      case 'EXPIRE': return d.has(args[0]) ? 1 : 0;
      case 'HGET': return d.get(args[0])?.get(String(args[1])) ?? null;
      case 'HSET': hash(args[0]).set(String(args[1]), args[2]); return 1;
      case 'HSETNX': if (hash(args[0]).has(String(args[1]))) return 0; hash(args[0]).set(String(args[1]), args[2]); return 1;
      case 'HGETALL': return [...(d.get(args[0])?.entries() ?? [])].flat();
      case 'HVALS': return [...(d.get(args[0])?.values() ?? [])];
      case 'SADD': (d.has(args[0]) ? d.get(args[0]) : d.set(args[0], new Set()).get(args[0])).add(args[1]); return 1;
      case 'SMEMBERS': return [...(d.get(args[0]) ?? [])];
      case 'INCR': d.set(args[0], String((Number(d.get(args[0])) || 0) + 1)); return Number(d.get(args[0]));
      case 'LPUSH': (d.has(args[0]) ? d.get(args[0]) : d.set(args[0], []).get(args[0])).unshift(args[1]); return 1;
      case 'LTRIM': d.set(args[0], (d.get(args[0]) ?? []).slice(Number(args[1]), Number(args[2]) + 1)); return 'OK';
      case 'LRANGE': return (d.get(args[0]) ?? []).slice(Number(args[1]), Number(args[2]) + 1);
      case 'SET': {
        const [key, value, ...opts] = args;
        if (opts.includes('NX') && d.has(key)) return null;
        d.set(key, String(value));
        return 'OK';
      }
      case 'EVAL': {
        const [, , key, token] = args;
        if (d.get(key) === token) { d.delete(key); return 1; }
        return 0;
      }
      default: throw new Error(`FakeRedis: ${name} not implemented`);
    }
  }
}
