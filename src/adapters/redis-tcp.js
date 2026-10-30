import { createClient } from 'redis';

// Direct Redis connection (REDIS_URL), for databases attached in Vercel that
// do not offer Upstash's REST API. Same `cmd` interface as RedisRest, so every
// Redis adapter works over either. The connection is opened on first use and
// reused while the function instance stays warm.
export class RedisTcp {
  constructor(url) {
    this.url = url;
    this.ready = null;
  }

  #connect() {
    if (!this.ready) {
      const client = createClient({
        url: this.url,
        socket: { connectTimeout: 5000, reconnectStrategy: (attempt) => (attempt > 3 ? false : 200) },
      });
      client.on('error', (err) => console.error('storage connection error:', err.message));
      this.ready = client.connect().then(() => client).catch((err) => {
        this.ready = null;
        throw new Error(`storage connection failed: ${err.message}`);
      });
    }
    return this.ready;
  }

  async cmd(...args) {
    const client = await this.#connect();
    try {
      return await client.sendCommand(args.map(String));
    } catch (err) {
      throw new Error(`storage ${args[0]} failed: ${err.message}`);
    }
  }

  async close() {
    if (this.ready) (await this.ready).quit();
    this.ready = null;
  }
}
