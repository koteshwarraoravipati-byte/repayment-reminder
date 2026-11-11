import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { advanceDueDate, simulatePayoff, todayIsoDate } from '../src/services/payoff.js';
import { runReminderSweep } from '../src/services/scheduler.js';

function offsetIso(days) {
  const dt = new Date(`${todayIsoDate()}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

async function startTestServer() {
  const db = createDb({ sqlitePath: ':memory:' });
  await db.init();
  const app = createApp(db);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const req = async (path, options = {}) => {
    const res = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    const body = await res.json();
    return { status: res.status, body };
  };
  return {
    db,
    req,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await db.close();
    },
  };
}

test('health, debt CRUD, payment cycle advance, and reminder sweep', async () => {
  const ctx = await startTestServer();
  try {
    const health = await ctx.req('/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.database, 'sqlite');

    // Create debt due in 3 days (matches default lead day 3)
    const dueIn3 = offsetIso(3);
    const created = await ctx.req('/api/debts', {
      method: 'POST',
      body: JSON.stringify({
        name: 'HDFC Card',
        lender: 'HDFC',
        category: 'CREDIT_CARD',
        principal_amount: 30000,
        interest_rate: 24,
        minimum_payment: 3000,
        next_due_date: dueIn3,
        frequency: 'MONTHLY',
      }),
    });
    assert.equal(created.status, 201);
    const debtId = created.body.debt.id;
    assert.equal(created.body.debt.days_until_due, 3);
    assert.equal(created.body.debt.urgency, 'DUE_SOON');

    // Reminder should have been automatically generated on creation
    const reminders = await ctx.req('/api/reminders');
    assert.equal(reminders.body.reminders.length, 1);
    assert.equal(reminders.body.reminders[0].status, 'UNREAD');

    // Deduplication: re-running sweep on same day does not create duplicate
    const sweep2 = await runReminderSweep(ctx.db);
    assert.equal(sweep2.created_count, 0);

    // Record payment and verify remaining balance reduces & due date advances by 1 month
    const paid = await ctx.req(`/api/debts/${debtId}/pay`, {
      method: 'POST',
      body: JSON.stringify({ amount: 5000 }),
    });
    assert.equal(paid.status, 200);
    assert.equal(paid.body.debt.remaining_balance, 25000);
    assert.equal(paid.body.debt.next_due_date, advanceDueDate(dueIn3, 'MONTHLY'));

    // Previous reminder should be acknowledged automatically after paying
    const afterPayReminders = await ctx.req('/api/reminders');
    assert.equal(afterPayReminders.body.reminders[0].status, 'ACKNOWLEDGED');

    // Soft archive and hard delete
    const archived = await ctx.req(`/api/debts/${debtId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'ARCHIVED' }),
    });
    assert.equal(archived.body.debt.status, 'ARCHIVED');

    const deleted = await ctx.req(`/api/debts/${debtId}`, { method: 'DELETE' });
    assert.equal(deleted.status, 200);
  } finally {
    await ctx.close();
  }
});

test('payoff strategy simulator compares avalanche vs snowball accurately', () => {
  const debts = [
    { id: 1, name: 'High APR Card', status: 'ACTIVE', remaining_balance: 40000, interest_rate: 36, minimum_payment: 2000 },
    { id: 2, name: 'Small Loan', status: 'ACTIVE', remaining_balance: 15000, interest_rate: 10, minimum_payment: 1500 },
  ];
  const avalanche = simulatePayoff(debts, 'avalanche', 3000);
  const snowball = simulatePayoff(debts, 'snowball', 3000);

  assert.equal(avalanche.payoff_order[0].name, 'High APR Card');
  assert.equal(snowball.payoff_order[0].name, 'Small Loan');
  assert.ok(avalanche.total_interest <= snowball.total_interest);
});

test('AI chat parses natural language debt entry and answers due date queries', async () => {
  const ctx = await startTestServer();
  try {
    const addReply = await ctx.req('/api/ai/chat', {
      method: 'POST',
      body: JSON.stringify({ message: 'Add a ₹20000 Axis Credit Card at 24% interest due on 2026-11-15' }),
    });
    assert.equal(addReply.status, 200);
    assert.ok(addReply.body.created_debt);
    assert.equal(addReply.body.created_debt.principal_amount, 20000);

    const askReply = await ctx.req('/api/ai/chat', {
      method: 'POST',
      body: JSON.stringify({ message: 'Which debt should I pay off first?' }),
    });
    assert.equal(askReply.status, 200);
    assert.match(askReply.body.reply, /Avalanche/i);

    const history = await ctx.req('/api/ai/history');
    assert.equal(history.body.messages.length, 4);
  } finally {
    await ctx.close();
  }
});
