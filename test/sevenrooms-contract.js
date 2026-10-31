import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// What every SevenRooms adapter must do for the sync, releases and
// reconciliation to be safe: the in-memory double, the shadow store and the
// live client. Run against the live client in the SevenRooms sandbox before
// `SevenRoomsClient.implemented` is set to true.
//
// `make()` returns { adapter, tables: [a, b], date }: two real table names and
// a service date with nothing booked on them. Each test uses its own
// references so it can run against a shared sandbox, and cancels what it
// creates.
export function sevenRoomsContract(name, make, { skip } = {}) {
  describe(`SevenRooms contract: ${name}`, { skip }, () => {
    const run = Date.now().toString(36);
    let seq = 0;
    let created = [];
    let ctx;

    const setup = async () => {
      ctx = await make();
      return ctx;
    };
    const reservation = (over = {}) => ({
      date: ctx.date,
      time: '19:30',
      partySize: 2,
      table: ctx.tables[0],
      sitting: 'late',
      guest: { firstName: 'Contract', lastName: 'Test' },
      notes: '',
      source: 'opentable',
      externalRef: `CT-${run}-${++seq}`,
      ...over,
    });
    const create = async (r) => {
      const id = await ctx.adapter.createReservation(r);
      created.push(id);
      return id;
    };
    const find = async (externalRef, { fromDate = ctx.date, toDate = ctx.date } = {}) =>
      (await ctx.adapter.listReservations({ fromDate, toDate })).filter((x) => x.externalRef === externalRef);
    const active = async (ref, range) => (await find(ref, range)).filter((x) => x.status === 'active');

    afterEach(async () => {
      for (const id of created) {
        try { await ctx.adapter.cancelReservation(id); } catch { /* already cancelled or never made */ }
      }
      created = [];
    });

    test('create returns an id and lists every field reconciliation reads', async () => {
      await setup();
      const r = reservation();
      const id = await create(r);
      assert.equal(typeof id, 'string');
      assert.ok(id.length > 0);

      const [listed] = await find(r.externalRef);
      assert.ok(listed, 'the new reservation is listed');
      assert.equal(listed.status, 'active');
      assert.equal(listed.source, 'opentable');
      for (const field of ['externalRef', 'date', 'time', 'partySize', 'table']) {
        assert.equal(listed[field], r[field], field);
      }
    });

    test('two creates give two different ids', async () => {
      await setup();
      const a = await create(reservation());
      const b = await create(reservation({ table: ctx.tables[1] }));
      assert.notEqual(a, b);
    });

    test('update changes time and party size and keeps the id', async () => {
      await setup();
      const r = reservation();
      const id = await create(r);
      await ctx.adapter.updateReservation(id, { ...r, time: '20:00', partySize: 3 });

      const listed = await active(r.externalRef);
      assert.equal(listed.length, 1, 'still one reservation, not a second one');
      assert.equal(listed[0].time, '20:00');
      assert.equal(listed[0].partySize, 3);
    });

    test('update can move a booking to a free table', async () => {
      await setup();
      const r = reservation();
      const id = await create(r);
      await ctx.adapter.updateReservation(id, { ...r, table: ctx.tables[1] });
      assert.equal((await active(r.externalRef))[0].table, ctx.tables[1]);
    });

    test('cancel removes it from the active list', async () => {
      await setup();
      const r = reservation();
      const id = await create(r);
      await ctx.adapter.cancelReservation(id);
      // SevenRooms may list a cancelled reservation as cancelled or not at
      // all. Reconciliation accepts either; it must not stay active.
      assert.equal((await active(r.externalRef)).length, 0);
    });

    test('update and cancel of an unknown id are rejected', async () => {
      await setup();
      const missing = `missing-${run}`;
      await assert.rejects(ctx.adapter.updateReservation(missing, reservation()));
      await assert.rejects(ctx.adapter.cancelReservation(missing));
    });

    test('listing respects the date range', async () => {
      await setup();
      const later = addDays(ctx.date, 2);
      const inside = reservation();
      const outside = reservation({ date: later });
      await create(inside);
      await create(outside);

      const range = { fromDate: ctx.date, toDate: addDays(ctx.date, 1) };
      assert.equal((await find(inside.externalRef, range)).length, 1);
      assert.equal((await find(outside.externalRef, range)).length, 0);
    });

    test('a second party on a taken table is rejected and nothing is created', async () => {
      await setup();
      await create(reservation());
      const second = reservation();
      await assert.rejects(create(second), (err) => err.code === 'table_taken');
      assert.equal((await active(second.externalRef)).length, 0);
    });

    test('moving a booking onto a taken table is rejected and leaves it where it was', async () => {
      await setup();
      await create(reservation());
      const r = reservation({ table: ctx.tables[1] });
      const id = await create(r);
      await assert.rejects(
        ctx.adapter.updateReservation(id, { ...r, table: ctx.tables[0] }),
        (err) => err.code === 'table_taken',
      );
      assert.equal((await active(r.externalRef))[0].table, ctx.tables[1]);
    });

    test('a cancelled table can be booked again', async () => {
      await setup();
      const id = await create(reservation());
      await ctx.adapter.cancelReservation(id);
      const again = reservation();
      await create(again);
      assert.equal((await active(again.externalRef)).length, 1);
    });

    test('the same table in a different sitting is not a clash', async () => {
      await setup();
      await create(reservation({ time: '12:30', sitting: 'early' }));
      const late = reservation({ time: '19:30', sitting: 'late' });
      await create(late);
      assert.equal((await active(late.externalRef)).length, 1);
    });

    test('releasing an unsold table is accepted', async () => {
      await setup();
      await ctx.adapter.releaseTable({ date: ctx.date, sitting: 'late', table: ctx.tables[1] });
    });
  });
}

function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
