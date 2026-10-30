// Upstash Redis storage for the live service on Vercel, over its REST API so
// no client library is needed. Each class mirrors its in-memory counterpart.
// Keys are prefixed per venue, so one database can serve several venues.

export class RedisRest {
  constructor({ url, token, fetchImpl = fetch }) {
    this.url = url.replace(/\/$/, '');
    this.token = token;
    this.fetch = fetchImpl;
  }

  async cmd(...args) {
    const res = await this.fetch(this.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(args.map(String)),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error) throw new Error(`storage ${args[0]} failed: ${body.error ?? res.status}`);
    return body.result;
  }
}

const parse = (v) => (v == null ? null : JSON.parse(v));
const values = async (redis, key) => ((await redis.cmd('HVALS', key)) ?? []).map(parse);

export class RedisStore {
  constructor(redis, prefix) {
    this.redis = redis;
    this.key = `${prefix}:bookings`;
    this.releasedKey = `${prefix}:released`;
  }

  async get(confirmation) {
    return parse(await this.redis.cmd('HGET', this.key, confirmation));
  }

  async put(record) {
    await this.redis.cmd('HSET', this.key, record.confirmation, JSON.stringify(record));
  }

  async active({ fromDate, toDate } = {}) {
    return (await values(this.redis, this.key)).filter(
      (b) => b.status === 'active' && (!fromDate || b.date >= fromDate) && (!toDate || b.date <= toDate),
    );
  }

  async takenTables(date, sitting) {
    const active = await this.active({ fromDate: date, toDate: date });
    return new Set(active.filter((b) => b.sitting === sitting).map((b) => b.table));
  }

  async markReleased(key) {
    await this.redis.cmd('SADD', this.releasedKey, key);
  }

  async releasedKeys() {
    return new Set((await this.redis.cmd('SMEMBERS', this.releasedKey)) ?? []);
  }
}

export class RedisLedger {
  constructor(redis, prefix) {
    this.redis = redis;
    this.key = `${prefix}:opentable`;
  }

  async record(event) {
    if (event.type === 'cancelled') {
      const b = parse(await this.redis.cmd('HGET', this.key, event.confirmation));
      if (b) await this.redis.cmd('HSET', this.key, event.confirmation, JSON.stringify({ ...b, status: 'cancelled' }));
      return;
    }
    const { confirmation, date, time, partySize } = event;
    await this.redis.cmd('HSET', this.key, confirmation, JSON.stringify({ confirmation, date, time, partySize, status: 'active' }));
  }

  async listBookings({ fromDate, toDate }) {
    return (await values(this.redis, this.key)).filter((b) => b.date >= fromDate && b.date <= toDate);
  }
}

// Shadow SevenRooms: records the reservation Table Runner would have made,
// without contacting SevenRooms. Used for the parallel run before go-live.
export class RedisShadowSevenRooms {
  constructor(redis, prefix) {
    this.redis = redis;
    this.key = `${prefix}:shadow`;
    this.seqKey = `${prefix}:shadow:seq`;
  }

  async createReservation(r) {
    const id = `shadow_${await this.redis.cmd('INCR', this.seqKey)}`;
    await this.redis.cmd('HSET', this.key, id, JSON.stringify({ ...r, id, status: 'active' }));
    return id;
  }

  async updateReservation(id, r) {
    const existing = parse(await this.redis.cmd('HGET', this.key, id));
    if (!existing) throw new Error(`unknown reservation ${id}`);
    await this.redis.cmd('HSET', this.key, id, JSON.stringify({ ...existing, ...r }));
  }

  async cancelReservation(id) {
    const existing = parse(await this.redis.cmd('HGET', this.key, id));
    if (!existing) throw new Error(`unknown reservation ${id}`);
    await this.redis.cmd('HSET', this.key, id, JSON.stringify({ ...existing, status: 'cancelled' }));
  }

  async listReservations({ fromDate, toDate }) {
    return (await values(this.redis, this.key)).filter((r) => r.date >= fromDate && r.date <= toDate);
  }

  async releaseTable() {}
}

export class RedisAlerts {
  constructor(redis, prefix, { clock }) {
    this.redis = redis;
    this.key = `${prefix}:alerts`;
    this.seqKey = `${prefix}:alerts:seq`;
    this.clock = clock;
  }

  async send(alert) {
    const id = Number(await this.redis.cmd('INCR', this.seqKey));
    await this.redis.cmd('HSET', this.key, id, JSON.stringify({ id, at: this.clock(), acknowledged: false, ...alert }));
  }

  async all() {
    return (await values(this.redis, this.key)).sort((a, b) => a.id - b.id);
  }

  async open() {
    return (await this.all()).filter((a) => !a.acknowledged);
  }

  async acknowledge(id, by = 'dashboard') {
    const a = parse(await this.redis.cmd('HGET', this.key, id));
    if (!a) return null;
    const updated = { ...a, acknowledged: true, acknowledgedBy: by, acknowledgedAt: this.clock() };
    await this.redis.cmd('HSET', this.key, id, JSON.stringify(updated));
    return updated;
  }
}

export class RedisActivity {
  constructor(redis, prefix, { clock, limit = 1000 }) {
    this.redis = redis;
    this.key = `${prefix}:activity`;
    this.seqKey = `${prefix}:activity:seq`;
    this.clock = clock;
    this.limit = limit;
  }

  async add(kind, message, detail = {}) {
    const item = { id: Number(await this.redis.cmd('INCR', this.seqKey)), at: this.clock(), kind, message, detail };
    await this.redis.cmd('LPUSH', this.key, JSON.stringify(item));
    await this.redis.cmd('LTRIM', this.key, 0, this.limit - 1);
    return item;
  }

  async list({ limit = 100 } = {}) {
    return ((await this.redis.cmd('LRANGE', this.key, 0, limit - 1)) ?? []).map(parse);
  }
}

export class RedisState {
  constructor(redis, prefix) {
    this.redis = redis;
    this.key = `${prefix}:state`;
  }

  async get(name) {
    return parse(await this.redis.cmd('HGET', this.key, name));
  }

  async set(name, value) {
    await this.redis.cmd('HSET', this.key, name, JSON.stringify(value));
  }
}

const UNLOCK = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

// Cross-instance lock: only one function instance at a time may change table
// occupancy. The lock expires on its own if an instance dies holding it.
export class RedisLock {
  constructor(redis, prefix, { ttlMs = 20000, waitMs = 15000 } = {}) {
    this.redis = redis;
    this.key = `${prefix}:lock`;
    this.ttlMs = ttlMs;
    this.waitMs = waitMs;
  }

  async run(fn) {
    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const deadline = Date.now() + this.waitMs;
    while ((await this.redis.cmd('SET', this.key, token, 'NX', 'PX', this.ttlMs)) !== 'OK') {
      if (Date.now() > deadline) throw new Error('timed out waiting for the booking lock');
      await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
    }
    try {
      return await fn();
    } finally {
      await this.redis.cmd('EVAL', UNLOCK, 1, this.key, token);
    }
  }
}
