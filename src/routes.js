// The dashboard API, independent of transport. The Node server and the
// static browser build both answer requests through this one function.

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

export async function route(app, method, url, readBody) {
  const key = `${method} ${url.pathname}`;
  const today = app.status().now.slice(0, 10);
  const date = (name) => {
    const v = url.searchParams.get(name) ?? today;
    if (!DATE.test(v)) throw httpError(400, `${name} must be YYYY-MM-DD`);
    return v;
  };

  if (key === 'GET /api/status') return app.status();
  if (key === 'GET /api/day') return app.dayView(date('date'));
  if (key === 'GET /api/week') return app.weekView(date('from'), 7);
  if (key === 'GET /api/alerts') {
    const all = url.searchParams.get('all') === '1';
    return (all ? app.alerts.sent : app.alerts.open()).slice().reverse();
  }
  if (key === 'GET /api/activity') return app.activity.list({ limit: 100 });
  if (key === 'POST /api/reconcile') return app.reconcile();
  if (key === 'POST /api/release') return app.release();
  if (key === 'POST /api/inbound-email') {
    const body = await readBody();
    return app.ingestEmail({ subject: String(body.subject ?? ''), text: String(body.text ?? '') });
  }
  const ack = key.match(/^POST \/api\/alerts\/(\d+)\/ack$/);
  if (ack) {
    const a = app.alerts.acknowledge(Number(ack[1]));
    if (!a) throw httpError(404, 'alert not found');
    app.activity.add('alert.ack', `Alert ${a.id} acknowledged: ${a.code}`);
    return a;
  }
  throw httpError(404, 'not found');
}
