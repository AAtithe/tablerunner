import { sevenRoomsContract } from './sevenrooms-contract.js';
import { MemorySevenRooms, SevenRoomsClient } from '../src/adapters/sevenrooms.js';
import { RedisShadowSevenRooms } from '../src/adapters/redis.js';
import { FakeRedis } from './fake-redis.js';

const date = '2026-11-06';
const tables = ['T1', 'T10'];

sevenRoomsContract('in-memory double', () => ({ adapter: new MemorySevenRooms(), tables, date }));

sevenRoomsContract('shadow store', () => ({
  adapter: new RedisShadowSevenRooms(new FakeRedis(), 'tr:test'), tables, date,
}));

// The live client against the SevenRooms sandbox. These settings are read
// here only, by the test run; the service itself takes SevenRooms settings
// from the Settings screen. SEVENROOMS_SANDBOX_TABLES names two sandbox
// tables, comma separated, with nothing booked on SEVENROOMS_SANDBOX_DATE.
const env = process.env;
const sandbox = {
  clientId: env.SEVENROOMS_SANDBOX_CLIENT_ID,
  clientSecret: env.SEVENROOMS_SANDBOX_CLIENT_SECRET,
  venueId: env.SEVENROOMS_SANDBOX_VENUE_ID,
  baseUrl: env.SEVENROOMS_SANDBOX_BASE_URL,
};
const sandboxTables = (env.SEVENROOMS_SANDBOX_TABLES ?? '').split(',').map((t) => t.trim()).filter(Boolean);
const sandboxDate = env.SEVENROOMS_SANDBOX_DATE;
const ready = SevenRoomsClient.implemented && Object.values(sandbox).every(Boolean) && sandboxTables.length >= 2 && sandboxDate;

sevenRoomsContract(
  'live client (sandbox)',
  () => ({ adapter: new SevenRoomsClient(sandbox), tables: sandboxTables, date: sandboxDate }),
  { skip: ready ? false : 'needs the live client and SEVENROOMS_SANDBOX_* settings' },
);
