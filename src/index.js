import { SyncService } from './sync.js';
import { parseOpenTableEmail } from './adapters/opentable-email.js';
import { runReconciliation } from './reconcile.js';
import { runReleases } from './release.js';

export { SyncService, parseOpenTableEmail, runReconciliation, runReleases };

// Entry point for an inbound OpenTable email (from the dedicated mailbox).
// Unparseable emails alert for manual handling; they are never dropped.
export async function handleInboundEmail(email, { sync, alert }) {
  const parsed = parseOpenTableEmail(email);
  if (!parsed.ok) {
    await alert.send({
      severity: 'high',
      code: 'unparseable_email',
      message: `${parsed.error}. Subject: "${parsed.subject}". Enter this booking in SevenRooms by hand and send the email to the sync owner.`,
    });
    return { action: 'unparseable' };
  }
  return sync.handle(parsed.event);
}
