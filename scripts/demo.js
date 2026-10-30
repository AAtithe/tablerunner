// Runs the dashboard locally against the synthetic demo. No vendor is contacted.
import { buildDemo as build } from '../src/demo-data.js';
import { createDashboardServer } from '../src/server.js';
import { exampleConfig as config } from '../config/allocation.example.js';


export function buildDemo(opts = {}) {
  return build({ config, ...opts });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await buildDemo();
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '127.0.0.1';
  const password = process.env.DASHBOARD_PASSWORD;
  createDashboardServer(app, { password }).listen(port, host, () => {
    console.log(`Table Runner demo dashboard on http://${host}:${port}`);
    if (!password && host !== '127.0.0.1') console.warn('WARNING: no DASHBOARD_PASSWORD set and not bound to localhost.');
  });
}
