// Builds what Vercel serves:
//   dist/index.html       live dashboard, reads the /api function
//   dist/demo/index.html  the same dashboard with the sync engine and synthetic
//                         demo bundled in; runs entirely in the browser
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { exampleConfig } from '../config/allocation.example.js';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');

// Dependency order. Each module's imports are satisfied by those above it.
const MODULES = [
  'src/clock.js',
  'src/allocation.js',
  'src/store.js',
  'src/adapters/sevenrooms.js',
  'src/adapters/opentable-ledger.js',
  'src/adapters/opentable-email.js',
  'src/alert.js',
  'src/activity.js',
  'src/reconcile.js',
  'src/release.js',
  'src/sync.js',
  'src/app.js',
  'src/routes.js',
  'src/mode.js',
  'src/demo-data.js',
];

export function bundle() {
  const code = MODULES.map((p) => {
    const src = read(p)
      .split('\n')
      .filter((line) => !/^import .* from '.*';$/.test(line))
      .map((line) => line.replace(/^export (?=(async function|function|class|const) )/, ''))
      .join('\n');
    if (/^(import|export) /m.test(src)) throw new Error(`${p}: unsupported import/export form`);
    return `// ---- ${p}\n${src}`;
  }).join('\n');

  return `${code}
// ---- browser API
const appReady = buildDemo({ config: ${JSON.stringify(exampleConfig)}, note: 'Anything you do here resets when the page reloads.' });
window.tableRunnerApi = async (path, opts = {}) => {
  const app = await appReady;
  const body = async () => JSON.parse(opts.body ?? '{}');
  const result = await route(app, opts.method ?? 'GET', new URL(path, 'http://local'), body);
  return JSON.parse(JSON.stringify(result));
};
`;
}

export function buildDemoPage() {
  const html = read('public/index.html');
  const marker = '<script>';
  if (html.split(marker).length !== 2) throw new Error('expected exactly one <script> in public/index.html');
  return html.replace(marker, `<script type="module">\n${bundle()}</script>\n<script type="module">`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  mkdirSync(new URL('dist/demo/', root), { recursive: true });
  writeFileSync(new URL('dist/index.html', root), read('public/index.html'));
  writeFileSync(new URL('dist/demo/index.html', root), buildDemoPage());
  console.log('Built dist/index.html and dist/demo/index.html');
}
