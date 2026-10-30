// Turns an OpenTable notification email into a sync event. Fallback route for
// when partner API access is not granted.
//
// PROVISIONAL: the patterns below are placeholders written without real
// OpenTable emails. They must be replaced from the sample confirmation,
// modification and cancellation emails before go-live. The parser fails
// closed: if any required field is missing it returns an error for review
// and never guesses.

export const PROVISIONAL_PATTERNS = {
  type: [
    { match: /cancel/i, value: 'cancelled' },
    { match: /(modif|change|update)/i, value: 'modified' },
    { match: /(new|confirm)/i, value: 'created' },
  ],
  confirmation: /Confirmation(?: number| #|:)?\s*[:#]?\s*([A-Z0-9-]{4,})/i,
  partySize: /Party(?: size)?\s*(?:of|:)?\s*(\d{1,2})/i,
  date: /Date:\s*(\d{4}-\d{2}-\d{2})/i,
  time: /Time:\s*(\d{1,2}:\d{2})\s*(am|pm)?/i,
  name: /Guest(?: name)?:\s*([^\n]+)/i,
  email: /Email:\s*([^\s]+@[^\s]+)/i,
  phone: /Phone:\s*([+\d][\d\s-]{6,})/i,
  notes: /(?:Special requests?|Notes?):\s*([^\n]*)/i,
};

export function parseOpenTableEmail({ subject = '', text = '' }, patterns = PROVISIONAL_PATTERNS) {
  const type = patterns.type.find((t) => t.match.test(subject))?.value;
  const confirmation = text.match(patterns.confirmation)?.[1];
  const partySize = Number(text.match(patterns.partySize)?.[1]);
  const date = text.match(patterns.date)?.[1];
  const timeMatch = text.match(patterns.time);
  const name = text.match(patterns.name)?.[1]?.trim();

  const missing = [];
  if (!type) missing.push('type');
  if (!confirmation) missing.push('confirmation');
  if (type !== 'cancelled') {
    if (!Number.isInteger(partySize) || partySize < 1) missing.push('partySize');
    if (!date) missing.push('date');
    if (!timeMatch) missing.push('time');
    if (!name) missing.push('guest name');
  }
  if (missing.length) return { ok: false, error: `unparseable OpenTable email, missing: ${missing.join(', ')}`, subject };

  const [firstName, ...rest] = (name ?? '').split(/\s+/);
  return {
    ok: true,
    event: {
      source: 'opentable',
      type,
      confirmation,
      partySize: type === 'cancelled' ? undefined : partySize,
      date,
      time: timeMatch ? to24h(timeMatch[1], timeMatch[2]) : undefined,
      guest: {
        firstName,
        lastName: rest.join(' '),
        email: text.match(patterns.email)?.[1],
        phone: text.match(patterns.phone)?.[1]?.trim(),
      },
      notes: text.match(patterns.notes)?.[1]?.trim() ?? '',
    },
  };
}

function to24h(hm, meridiem) {
  let [h, m] = hm.split(':').map(Number);
  if (meridiem) {
    const pm = meridiem.toLowerCase() === 'pm';
    if (pm && h < 12) h += 12;
    if (!pm && h === 12) h = 0;
  }
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
