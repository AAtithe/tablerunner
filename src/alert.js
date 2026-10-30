// Alert sinks. Production target (email, Slack or SMS to the GM and host) is
// chosen at go-live; every sink exposes send(alert).

export class MemoryAlerts {
  constructor() {
    this.sent = [];
  }

  async send(alert) {
    this.sent.push(alert);
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
