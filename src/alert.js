// Alert sinks. Production target (email, Slack or SMS to the GM and host) is
// chosen at go-live; every sink exposes send(alert).

export class MemoryAlerts {
  constructor({ clock = () => new Date().toISOString() } = {}) {
    this.sent = [];
    this.clock = clock;
    this.seq = 0;
  }

  async send(alert) {
    this.sent.push({ id: ++this.seq, at: this.clock(), acknowledged: false, ...alert });
  }

  async open() {
    return this.sent.filter((a) => !a.acknowledged);
  }

  async all() {
    return this.sent;
  }

  async acknowledge(id, by = 'dashboard') {
    const a = this.sent.find((x) => x.id === id);
    if (!a) return null;
    Object.assign(a, { acknowledged: true, acknowledgedBy: by, acknowledgedAt: this.clock() });
    return a;
  }
}

// Records every alert in the primary store (the dashboard reads from it) and
// copies it to notify sinks such as a Slack or Teams webhook. A failed
// notification never loses the alert: it is still on the dashboard.
export class NotifyingAlerts {
  constructor(primary, notify = []) {
    this.primary = primary;
    this.notify = notify;
  }

  async send(alert) {
    await this.primary.send(alert);
    const results = await Promise.allSettled(this.notify.map((s) => s.send(alert)));
    for (const r of results) if (r.status === 'rejected') console.error('alert notification failed:', r.reason?.message);
  }

  open() { return this.primary.open(); }
  all() { return this.primary.all(); }
  acknowledge(id, by) { return this.primary.acknowledge(id, by); }
}

export class WebhookAlerts {
  constructor(url) {
    this.url = url;
  }

  async send(alert) {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: `[${alert.severity}] ${alert.message}`, alert }),
    });
    if (!res.ok) throw new Error(`alert webhook returned ${res.status}`);
  }
}
