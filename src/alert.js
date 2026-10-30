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

  open() {
    return this.sent.filter((a) => !a.acknowledged);
  }

  acknowledge(id, by = 'dashboard') {
    const a = this.sent.find((x) => x.id === id);
    if (!a) return null;
    Object.assign(a, { acknowledged: true, acknowledgedBy: by, acknowledgedAt: this.clock() });
    return a;
  }
}

// Fans one alert out to several sinks, e.g. the dashboard and a webhook.
export class FanoutAlerts {
  constructor(sinks) {
    this.sinks = sinks;
  }

  async send(alert) {
    await Promise.all(this.sinks.map((s) => s.send(alert)));
  }
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
