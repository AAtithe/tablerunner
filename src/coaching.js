import { addDays, allocatedTables, holdBackFor, releaseAt, weekday } from './allocation.js';

// Coaching: learns from the venue's own history and turns it into specific,
// measurable advice for the team. Two parts.
//
// 1. What the model has learned, per weekday and sitting:
//    - Late OpenTable demand (bookings after release time). A Gamma-Poisson
//      model: every night is a count, recent nights weigh more (half-life
//      four weeks), and nights with little history borrow strength from the
//      venue-wide average until their own evidence builds. The recommended
//      reserve is the smallest number of tables that covers 90% of nights
//      under the model's forecast.
//    - Sell-through before release: the share of the OpenTable allocation
//      sold by release time, which says whether the allocation is the right
//      size.
//    The model re-learns from scratch every time it is read, so it improves
//    as each week of service is recorded. There is nothing to train by hand.
//
// 2. Team habits, week by week: how quickly released tables are closed in
//    OpenTable, how quickly high alerts are answered, and how often the
//    reserve ran out or OpenTable oversold. These are the behaviours that
//    stop a double booking, so they are what the team is coached on.
//
// Everything here is advice. Nothing changes the floor plan on its own: an
// admin decides and edits Settings, which keeps the judgement with people.

const HALF_LIFE_DAYS = 28;
const COVER = 0.9;
const PRIOR_NIGHTS = 2;
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const minutes = (a, b) => (Date.parse(`${b}:00Z`) - Date.parse(`${a}:00Z`)) / 60000;
const round = (n, dp = 1) => (n == null || Number.isNaN(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp);
const pct = (num, den) => (den ? Math.round((num / den) * 100) : null);
const daysBetween = (a, b) => Math.round(minutes(`${a}T00:00`, `${b}T00:00`) / 1440);

export function median(list) {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function weekStart(date) {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, -((day + 6) % 7));
}

// Smallest k with P(X <= k) >= cover, where X is negative binomial: the
// predictive distribution of a Poisson count whose rate has a Gamma(alpha,
// beta) posterior.
export function reserveFor(alpha, beta, cover = COVER) {
  const p = beta / (beta + 1);
  let prob = p ** alpha;
  let cdf = prob;
  let k = 0;
  while (cdf < cover && k < 50) {
    prob *= ((k + alpha) / (k + 1)) * (1 - p);
    cdf += prob;
    k += 1;
  }
  return k;
}

// Late-demand and sell-through model per weekday and sitting.
export function learnNights(config, bookings, { today }) {
  const yesterday = addDays(today, -1);
  const tracked = bookings.filter((b) => b.bookedAt);
  if (!tracked.length) return { from: null, rows: [] };
  const from = tracked.reduce((m, b) => (b.date < m ? b.date : m), yesterday);

  const nights = [];
  for (let date = from; date <= yesterday; date = addDays(date, 1)) {
    const cut = releaseAt(config, date);
    for (const s of config.sittings) {
      const here = tracked.filter((b) => b.date === date && b.sitting === s.name);
      const allocated = allocatedTables(config, date, s.name).length;
      const soldBefore = here.filter((b) => b.status === 'active' && b.bookedAt < cut).length;
      nights.push({
        date, weekday: weekday(date), sitting: s.name,
        late: here.filter((b) => b.late).length,
        allocated, soldBefore,
        weight: 0.5 ** (daysBetween(date, today) / HALF_LIFE_DAYS),
      });
    }
  }

  // Venue-wide average late bookings per sitting: the prior every night
  // starts from before it has history of its own.
  const venueMean = nights.reduce((n, x) => n + x.late, 0) / nights.length;
  const alpha0 = Math.max(venueMean, 0.1) * PRIOR_NIGHTS;
  const beta0 = PRIOR_NIGHTS;

  const groups = new Map();
  for (const n of nights) {
    const key = `${n.weekday}|${n.sitting}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(n);
  }

  const rows = [...groups.values()].map((list) => {
    const { weekday: wd, sitting } = list[0];
    const w = list.reduce((n, x) => n + x.weight, 0);
    const alpha = alpha0 + list.reduce((n, x) => n + x.weight * x.late, 0);
    const beta = beta0 + w;
    const latest = list.at(-1).date;
    const recent = list.filter((x) => daysBetween(x.date, today) <= 28);
    const earlier = list.filter((x) => daysBetween(x.date, today) > 28 && daysBetween(x.date, today) <= 56);
    const mean = (l) => (l.length ? l.reduce((n, x) => n + x.late, 0) / l.length : null);

    const withAlloc = list.filter((x) => x.allocated);
    const soldW = withAlloc.reduce((n, x) => n + x.weight * x.soldBefore, 0);
    const allocW = withAlloc.reduce((n, x) => n + x.weight * x.allocated, 0);
    const sellThrough = withAlloc.length ? (soldW + 1) / (allocW + 2) : null;
    const fullShare = withAlloc.length ? withAlloc.filter((x) => x.soldBefore >= x.allocated).length / withAlloc.length : null;
    const allocated = allocatedTables(config, latest, sitting).length;
    let allocationAdvice = 'hold';
    if (list.length >= 4 && sellThrough != null) {
      if (sellThrough >= 0.9 && fullShare >= 0.5) allocationAdvice = 'raise';
      else if (sellThrough <= 0.5 && allocated > 0) allocationAdvice = 'lower';
    }

    return {
      weekday: wd, sitting, nights: list.length,
      averageLate: round(mean(list)),
      worstLate: Math.max(...list.map((x) => x.late)),
      expectedLate: round(alpha / beta),
      recommendedReserve: reserveFor(alpha, beta),
      currentReserve: holdBackFor(config, latest, sitting),
      confidence: list.length >= 8 ? 'good' : list.length >= 4 ? 'medium' : 'low',
      lateTrend: trend(mean(recent), mean(earlier)),
      allocated,
      sellThroughPct: sellThrough == null ? null : Math.round(sellThrough * 100),
      fullBeforeReleasePct: fullShare == null ? null : Math.round(fullShare * 100),
      allocationAdvice,
    };
  }).sort((a, b) => DAYS.indexOf(a.weekday) - DAYS.indexOf(b.weekday) || a.sitting.localeCompare(b.sitting));

  return { from, rows, venueMeanLate: round(venueMean, 2) };
}

function trend(recent, earlier) {
  if (recent == null || earlier == null) return null;
  if (recent > earlier + 0.25) return 'rising';
  if (recent < earlier - 0.25) return 'falling';
  return 'steady';
}

// Week-by-week team habits, newest week last.
export function learnHabits(config, { times, alerts, now, weeks = 8 }) {
  const today = now.slice(0, 10);
  const starts = [];
  for (let i = weeks - 1; i >= 0; i--) starts.push(addDays(weekStart(today), -7 * i));
  const inWeek = (at, ws) => at && at.slice(0, 10) >= ws && at.slice(0, 10) <= addDays(ws, 6);
  const sittingStart = Object.fromEntries(config.sittings.map((s) => [s.name, s.start]));

  return starts.map((ws) => {
    let releasedN = 0;
    let decided = 0;
    let closedBefore = 0;
    const hoursToClose = [];
    for (const [key, at] of times.released) {
      if (!inWeek(at, ws)) continue;
      releasedN += 1;
      const [date, sitting] = key.split('|');
      const service = `${date}T${sittingStart[sitting] ?? '00:00'}`;
      const closedAt = times.closed.get(key);
      if (closedAt) hoursToClose.push(Math.max(0, minutes(at, closedAt) / 60));
      if (closedAt && closedAt <= service) { decided += 1; closedBefore += 1; } else if (now >= service) decided += 1;
    }

    const high = alerts.filter((a) => a.severity === 'high' && inWeek(a.at, ws));
    const ackMins = high.filter((a) => a.acknowledgedAt).map((a) => minutes(a.at, a.acknowledgedAt));
    const judged = high.filter((a) => a.acknowledgedAt || minutes(a.at, now) >= 30);
    const quick = judged.filter((a) => a.acknowledgedAt && minutes(a.at, a.acknowledgedAt) <= 30).length;
    const count = (pred) => alerts.filter((a) => inWeek(a.at, ws) && pred(a)).length;

    return {
      weekStart: ws,
      released: releasedN,
      closedBeforeServicePct: pct(closedBefore, decided),
      medianHoursToClose: round(median(hoursToClose)),
      highAlerts: high.length,
      medianMinutesToAck: round(median(ackMins), 0),
      ackWithin30Pct: pct(quick, judged.length),
      reserveExhausted: count((a) => a.code === 'reserve_exhausted'),
      oversold: count((a) => a.code === 'over_allocation' && /still open there/.test(a.message ?? '')),
      unreadableEmails: count((a) => a.code === 'unparseable_email'),
    };
  });
}

// Plain-language coaching from the model and the habits. Each note says what
// the numbers show, why it matters, and the target to aim for.
export function coachingNotes(model, habits) {
  const notes = [];
  const last4 = habits.slice(-4);
  const prev4 = habits.slice(-8, -4);
  const sum = (list, k) => list.reduce((n, w) => n + (w[k] ?? 0), 0);
  const avg = (list, k) => {
    const v = list.map((w) => w[k]).filter((x) => x != null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const label = (r) => `${r.weekday[0].toUpperCase()}${r.weekday.slice(1)} ${r.sitting}`;
  const direction = (now, before, higherIsBetter) => {
    if (now == null || before == null || Math.abs(now - before) < 1) return '';
    return (now > before) === higherIsBetter ? ' That is better than the four weeks before.' : ' That is worse than the four weeks before.';
  };

  // Closing released tables in OpenTable.
  const closedPct = avg(last4, 'closedBeforeServicePct');
  const closeHours = avg(last4, 'medianHoursToClose');
  if (sum(last4, 'released') > 0 && closedPct != null) {
    const good = closedPct >= 90 && (closeHours == null || closeHours <= 2);
    notes.push({
      area: 'Closing tables in OpenTable',
      tone: good ? 'good' : 'improve',
      title: good
        ? `${Math.round(closedPct)}% of released tables closed in OpenTable before service.`
        : `Only ${Math.round(closedPct)}% of released tables were closed in OpenTable before service.`,
      detail: `${closeHours != null ? `Typical time from release to close: ${round(closeHours)} hours. ` : ''}Every hour a released table stays open is an hour OpenTable can sell a table SevenRooms may already have resold. The reserve covers the gap, but only up to its size.${direction(closedPct, avg(prev4, 'closedBeforeServicePct'), true)}`
        + (good ? '' : ' Make closing released tables part of the release-time routine: the host who sees the "close in OpenTable" alert closes them there and then and presses "Mark closed in OpenTable".'),
      target: 'At least 90% closed before service, within 2 hours of release.',
    });
  }

  // Answering high alerts.
  const ackPct = avg(last4, 'ackWithin30Pct');
  const ackMin = avg(last4, 'medianMinutesToAck');
  if (sum(last4, 'highAlerts') > 0 && ackPct != null) {
    const good = ackPct >= 90;
    notes.push({
      area: 'Answering high alerts',
      tone: good ? 'good' : 'improve',
      title: `${Math.round(ackPct)}% of high alerts answered within 30 minutes${ackMin != null ? `, typical ${Math.round(ackMin)} minutes` : ''}.`,
      detail: `A high alert is a booking at risk: a guest without a table, a reserve that has run out, or an email nobody could read. The cost of a slow answer lands on the guest at the door.${direction(ackPct, avg(prev4, 'ackWithin30Pct'), true)}`
        + (good ? '' : ' Name one person per shift who owns alerts, and send them to the team channel from Settings so they are seen away from the dashboard.'),
      target: '90% answered within 30 minutes.',
    });
  }

  // Reserve running out and OpenTable overselling.
  const exhausted = sum(last4, 'reserveExhausted');
  const oversold = sum(last4, 'oversold');
  if (oversold > 0) {
    notes.push({
      area: 'Double-booking risk',
      tone: 'improve',
      title: `OpenTable sold past the reserve ${oversold} time(s) in the last four weeks.`,
      detail: 'Each of these was a party OpenTable confirmed with no protected table left, on a sitting where released tables were still open in OpenTable. Two things stop it: close released tables sooner, and size the reserve from the model below.',
      target: 'Zero.',
    });
  } else if (exhausted > 0) {
    notes.push({
      area: 'Double-booking risk',
      tone: 'watch',
      title: `The reserve ran out ${exhausted} time(s) in the last four weeks, with no oversell.`,
      detail: 'The team stopped online sales in time. Each one is still a near miss: check whether the model recommends a larger reserve for those nights.',
      target: 'Reserve exhausted no more than once a month.',
    });
  }

  // Reserve sizing from the model.
  const raise = model.rows.filter((r) => r.recommendedReserve > r.currentReserve && r.confidence !== 'low');
  const lower = model.rows.filter((r) => r.recommendedReserve < r.currentReserve && r.confidence === 'good');
  if (raise.length) {
    notes.push({
      area: 'Reserve size',
      tone: 'improve',
      title: `Raise the reserve on ${raise.map(label).join(', ')}.`,
      detail: raise.map((r) => `${label(r)}: about ${r.expectedLate} late OpenTable booking(s) a night expected, worst seen ${r.worstLate}. A reserve of ${r.recommendedReserve} covers 9 nights in 10; it is ${r.currentReserve} now.`).join(' ')
        + ' Change release.holdBack on the Settings screen.',
      target: 'Reserve covers at least 9 nights in 10.',
    });
  }
  if (lower.length) {
    notes.push({
      area: 'Reserve size',
      tone: 'watch',
      title: `The reserve is larger than needed on ${lower.map(label).join(', ')}.`,
      detail: lower.map((r) => `${label(r)}: ${r.recommendedReserve} would cover 9 nights in 10; it is ${r.currentReserve} now.`).join(' ')
        + ' Every table held back is a table SevenRooms cannot sell. Lower it once the habits above are on target.',
      target: 'Hold back no more than the evidence needs.',
    });
  }

  // Allocation size from sell-through.
  const up = model.rows.filter((r) => r.allocationAdvice === 'raise');
  const down = model.rows.filter((r) => r.allocationAdvice === 'lower');
  const list = (rows) => rows.map((r) => `${label(r)} (${r.sellThroughPct}%)`).join(', ');
  if (up.length) {
    notes.push({
      area: 'OpenTable allocation',
      tone: 'watch',
      title: `Consider one more OpenTable table on ${up.map(label).join(', ')}.`,
      detail: `Share of the allocation sold before release: ${list(up)}, and full before release on at least half those nights. OpenTable demand is being turned away while SevenRooms holds tables it may not fill.`,
      target: 'Allocation 70% to 90% sold by release time.',
    });
  }
  if (down.length) {
    notes.push({
      area: 'OpenTable allocation',
      tone: 'watch',
      title: `Consider one fewer OpenTable table on ${down.map(label).join(', ')}.`,
      detail: `Share of the allocation sold before release: ${list(down)}. Tables that sit unsold until release are tables SevenRooms could have sold for longer. Change one night at a time and watch the effect for four weeks before the next change.`,
      target: 'Allocation 70% to 90% sold by release time.',
    });
  }

  if (sum(last4, 'unreadableEmails') > 0) {
    notes.push({
      area: 'Unreadable OpenTable emails',
      tone: 'improve',
      title: `${sum(last4, 'unreadableEmails')} OpenTable email(s) could not be read in the last four weeks.`,
      detail: 'Each one is a booking entered by hand. Send the original emails to the sync owner so the patterns can be updated; a run of them usually means OpenTable changed its format.',
      target: 'Zero.',
    });
  }

  const nights = model.rows.reduce((n, r) => n + r.nights, 0);
  if (!model.rows.length || model.rows.every((r) => r.confidence === 'low')) {
    notes.push({
      area: 'How much the model knows',
      tone: 'watch',
      title: model.rows.length ? `Still learning: ${nights} sitting-night(s) of history so far.` : 'No history yet.',
      detail: 'The model starts from the venue-wide average and moves towards each night\'s own pattern as service is recorded. Recommendations show once a night has four weeks of history and are reliable from eight.',
      target: 'Eight weeks of history per night.',
    });
  }

  const order = { improve: 0, watch: 1, good: 2 };
  return notes.sort((a, b) => order[a.tone] - order[b.tone]);
}

export function buildCoaching(config, { bookings, times, alerts, now, weeks = 8 }) {
  const today = now.slice(0, 10);
  const model = learnNights(config, bookings, { today });
  const habits = learnHabits(config, { times, alerts, now, weeks });
  return { at: now, dataFrom: model.from, model, habits, notes: coachingNotes(model, habits) };
}
