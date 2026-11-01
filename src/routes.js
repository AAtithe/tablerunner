// The dashboard API, independent of transport. The Node server and the
// static browser build both answer requests through this one function.

import { DASHBOARD_ACTOR, actorRecord } from './alert.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// `actor` is who is making the request: { name, email }. The Vercel service
// passes the signed-in account; the demo server and static build have no named
// users and act as the dashboard.
export async function route(app, method, url, readBody, actor = DASHBOARD_ACTOR) {
  const key = `${method} ${url.pathname}`;
  const today = app.today ? app.today() : (await app.status()).now.slice(0, 10);
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
    return (await (all ? app.alerts.all() : app.alerts.open())).slice().sort((a, b) => b.id - a.id);
  }
  if (key === 'GET /api/activity') return app.activity.list({ limit: 100 });
  if (key === 'POST /api/reconcile') return app.reconcile();
  if (key === 'POST /api/release') return app.release();
  if (key === 'POST /api/opentable-closed') {
    const body = await readBody();
    if (!Array.isArray(body.keys) && !(typeof body.date === 'string' && DATE.test(body.date))) throw httpError(400, 'send keys, or a date (and optional sitting)');
    return app.confirmClosed({ keys: body.keys, date: body.date, sitting: body.sitting });
  }
  if (key === 'GET /api/coaching') return app.coaching({ weeks: 8 });
  if (key === 'GET /api/late-demand') {
    const weeks = Number(url.searchParams.get('weeks') ?? 8);
    if (!Number.isInteger(weeks) || weeks < 1 || weeks > 52) throw httpError(400, 'weeks must be 1 to 52');
    return app.lateDemand({ weeks });
  }
  if (key === 'POST /api/inbound-email') {
    const body = await readBody();
    // Plain { subject, text } or a Postmark inbound webhook.
    const subject = body.subject ?? body.Subject ?? '';
    const text = body.text ?? body.TextBody ?? stripHtml(body.HtmlBody ?? '');
    return app.ingestEmail({ subject: String(subject), text: String(text) });
  }
  const ack = key.match(/^POST \/api\/alerts\/(\d+)\/ack$/);
  if (ack) {
    const by = actorRecord(actor);
    const a = await app.alerts.acknowledge(Number(ack[1]), by);
    if (!a) throw httpError(404, 'alert not found');
    await app.activity.add('alert.ack', `Alert ${a.id} acknowledged by ${by.name}: ${a.code}`, { by });
    return a;
  }
  throw httpError(404, 'not found');
}

function stripHtml(html) {
  return String(html).replace(/<br\s*\/?>|<\/(p|div|tr|li)>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}
