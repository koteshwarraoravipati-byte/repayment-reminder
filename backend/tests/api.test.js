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

async function startTestServer({ appOptions = {}, autoAuth = true } = {}) {
  const db = createDb({ sqlitePath: ':memory:' });
  await db.init();
  const app = createApp(db, appOptions);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  let defaultToken = '';

  const rawReq = async (path, options = {}) => {
    const res = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    const body = await res.json();
    return { status: res.status, body };
  };

  const req = async (path, options = {}) => {
    const authHeader = defaultToken && !options.headers?.Authorization ? { Authorization: `Bearer ${defaultToken}` } : {};
    return rawReq(path, {
      ...options,
      headers: { ...authHeader, ...(options.headers || {}) },
    });
  };

  let user = null;
  if (autoAuth) {
    const reg = await rawReq('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ name: 'Test User', email: 'test@debtguard.local', password: 'password123' }),
    });
    defaultToken = reg.body.token;
    user = reg.body.user;
  }

  return {
    db,
    req,
    rawReq,
    user,
    setToken: (t) => {
      defaultToken = t;
    },
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

test('Vercel cron reminder endpoint enforces optional CRON_SECRET', async () => {
  const ctx = await startTestServer();
  const prevSecret = process.env.CRON_SECRET;
  try {
    process.env.CRON_SECRET = 'top-secret-cron';
    const unauth = await ctx.req('/api/cron/reminders');
    assert.equal(unauth.status, 401);

    const auth = await ctx.req('/api/cron/reminders', {
      headers: { Authorization: 'Bearer top-secret-cron' },
    });
    assert.equal(auth.status, 200);
    assert.equal(auth.body.ok, true);
  } finally {
    if (prevSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = prevSecret;
    await ctx.close();
  }
});

test('income sources CRUD, cashflow timing-gap vs sufficient analysis, and AI income queries', async () => {
  const ctx = await startTestServer();
  try {
    // Debt due in 2 days for 20,000; starting cash = 5,000; business income arrives in 6 days for 35,000
    await ctx.req('/api/cash', { method: 'PUT', body: JSON.stringify({ starting_cash: 5000 }) });
    await ctx.req('/api/debts', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Business Loan EMI',
        category: 'PERSONAL_LOAN',
        principal_amount: 100000,
        remaining_balance: 80000,
        interest_rate: 12,
        minimum_payment: 20000,
        next_due_date: offsetIso(2),
        frequency: 'MONTHLY',
      }),
    });

    const incRes = await ctx.req('/api/incomes', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Wholesale Store Payout',
        source_type: 'BUSINESS',
        amount: 35000,
        expected_date: offsetIso(6),
        frequency: 'MONTHLY',
      }),
    });
    assert.equal(incRes.status, 201);
    const incId = incRes.body.income.id;

    // Timing gap detected: total 30d money (5k + 35k = 40k) covers 20k, but 15k is missing on day 2 before day 6 payout
    const cf1 = await ctx.req('/api/cashflow?days=30');
    assert.equal(cf1.status, 200);
    assert.equal(cf1.body.overall_status, 'ARRANGE_FUNDS');
    assert.equal(cf1.body.timing_gap_only, true);
    assert.equal(cf1.body.total_shortfall_to_arrange, 15000);
    assert.equal(cf1.body.debt_checks[0].status, 'SHORTFALL');
    assert.equal(cf1.body.debt_checks[0].gap_days, 4);

    // AI answers sufficiency question accurately
    const aiCheck = await ctx.req('/api/ai/chat', {
      method: 'POST',
      body: JSON.stringify({ message: 'Will my business income be sufficient or do I need to arrange money?' }),
    });
    assert.equal(aiCheck.status, 200);
    assert.match(aiCheck.body.reply, /Arrange|Timing gap|15,000/i);

    // Receive income early -> adds 35,000 to cash (40,000 total) and advances payout date
    const rec = await ctx.req(`/api/incomes/${incId}/receive`, { method: 'POST', body: JSON.stringify({}) });
    assert.equal(rec.status, 200);
    assert.equal(rec.body.income.expected_date, advanceDueDate(offsetIso(6), 'MONTHLY'));

    // Now cashflow is SUFFICIENT
    const cf2 = await ctx.req('/api/cashflow?days=30');
    assert.equal(cf2.body.overall_status, 'SUFFICIENT');
    assert.equal(cf2.body.total_shortfall_to_arrange, 0);

    // AI parses natural language business income
    const aiAddInc = await ctx.req('/api/ai/chat', {
      method: 'POST',
      body: JSON.stringify({ message: 'Add ₹45000 Shop Revenue business income due on 2026-11-20' }),
    });
    assert.equal(aiAddInc.status, 200);
    assert.ok(aiAddInc.body.created_income);
    assert.equal(aiAddInc.body.created_income.amount, 45000);

    // Delete income
    const del = await ctx.req(`/api/incomes/${incId}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
  } finally {
    await ctx.close();
  }
});

test('auth: legacy data claim for first user, multi-user isolation, and unauthenticated 401 guard', async () => {
  const ctx = await startTestServer({ autoAuth: false });
  try {
    // Unauthenticated access returns 401
    const unauth = await ctx.rawReq('/api/debts');
    assert.equal(unauth.status, 401);

    // Seed legacy debt with NULL user_id before first signup
    await ctx.db.insert(
      `INSERT INTO debts (name, lender, category, principal_amount, remaining_balance, interest_rate, minimum_payment, next_due_date, frequency, auto_pay, status, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      ['Legacy Loan', 'SBI', 'LOAN', 50000, 50000, 12, 5000, offsetIso(5), 'MONTHLY', false, 'ACTIVE', '']
    );

    const reg1 = await ctx.rawReq('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ name: 'Owner One', email: 'owner1@example.com', password: 'password123' }),
    });
    assert.equal(reg1.status, 201);
    assert.equal(reg1.body.claimed_legacy_data, true);

    const reg2 = await ctx.rawReq('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ name: 'User Two', email: 'user2@example.com', password: 'password123' }),
    });
    assert.equal(reg2.status, 201);
    assert.equal(reg2.body.claimed_legacy_data, false);

    // User 1 sees the claimed legacy debt
    const u1Debts = await ctx.rawReq('/api/debts', { headers: { Authorization: `Bearer ${reg1.body.token}` } });
    assert.equal(u1Debts.body.debts.length, 1);
    assert.equal(u1Debts.body.debts[0].name, 'Legacy Loan');
    const debtId = u1Debts.body.debts[0].id;

    // User 2 does not see or delete User 1's debt
    const u2Debts = await ctx.rawReq('/api/debts', { headers: { Authorization: `Bearer ${reg2.body.token}` } });
    assert.equal(u2Debts.body.debts.length, 0);
    const u2Delete = await ctx.rawReq(`/api/debts/${debtId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${reg2.body.token}` },
    });
    assert.equal(u2Delete.status, 404);
  } finally {
    await ctx.close();
  }
});

test('auth: login, forgot-password SMTP check, OTP verification, lockout, and password reset', async () => {
  // Without SMTP configured, forgot-password fails explicitly with 503
  const noSmtpCtx = await startTestServer({ autoAuth: false });
  try {
    const prevUser = process.env.SMTP_USERNAME;
    const prevPass = process.env.SMTP_PASSWORD;
    delete process.env.SMTP_USERNAME;
    delete process.env.SMTP_PASSWORD;
    const missingSmtp = await noSmtpCtx.rawReq('/api/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email: 'nobody@example.com' }),
    });
    assert.equal(missingSmtp.status, 503);
    if (prevUser !== undefined) process.env.SMTP_USERNAME = prevUser;
    if (prevPass !== undefined) process.env.SMTP_PASSWORD = prevPass;
  } finally {
    await noSmtpCtx.close();
  }

  let sentOtp = null;
  let sentTo = null;
  const ctx = await startTestServer({
    appOptions: {
      otpSender: async (to, otp) => {
        sentTo = to;
        sentOtp = otp;
      },
    },
  });

  try {
    const me = await ctx.req('/api/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.user.email, 'test@debtguard.local');

    const forgot = await ctx.rawReq('/api/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email: 'test@debtguard.local' }),
    });
    assert.equal(forgot.status, 200);
    assert.equal(sentTo, 'test@debtguard.local');
    assert.match(sentOtp, /^\d{6}$/);

    // 5 wrong attempts lock out this OTP
    const wrongOtp = sentOtp === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i += 1) {
      const bad = await ctx.rawReq('/api/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({ email: 'test@debtguard.local', otp: wrongOtp, new_password: 'newpassword123' }),
      });
      assert.equal(bad.status, 400);
    }
    const locked = await ctx.rawReq('/api/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ email: 'test@debtguard.local', otp: sentOtp, new_password: 'newpassword123' }),
    });
    assert.equal(locked.status, 429);

    // Request fresh OTP and complete password reset
    await ctx.rawReq('/api/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email: 'test@debtguard.local' }),
    });
    const reset = await ctx.rawReq('/api/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ email: 'test@debtguard.local', otp: sentOtp, new_password: 'newpassword123' }),
    });
    assert.equal(reset.status, 200);

    // Reusing the same OTP fails
    const replay = await ctx.rawReq('/api/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ email: 'test@debtguard.local', otp: sentOtp, new_password: 'anotherpassword' }),
    });
    assert.equal(replay.status, 400);

    // Old password fails, new password works
    const oldLogin = await ctx.rawReq('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'test@debtguard.local', password: 'password123' }),
    });
    assert.equal(oldLogin.status, 401);

    const newLogin = await ctx.rawReq('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'test@debtguard.local', password: 'newpassword123' }),
    });
    assert.equal(newLogin.status, 200);
    assert.ok(newLogin.body.token);
  } finally {
    await ctx.close();
  }
});

test('AI chat updates cash-in-account safely without fake debts and parses trailing extra amount', async () => {
  const ctx = await startTestServer();
  try {
    await ctx.req('/api/debts', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Starter Card',
        category: 'CREDIT_CARD',
        principal_amount: 50000,
        interest_rate: 18,
        minimum_payment: 2500,
        next_due_date: offsetIso(10),
        frequency: 'MONTHLY',
      }),
    });

    // Cash-in-account update should set starting_cash and NOT create a fake debt
    const cashReply = await ctx.req('/api/ai/chat', {
      method: 'POST',
      body: JSON.stringify({ message: 'add 400k in my account' }),
    });
    assert.equal(cashReply.status, 200);
    assert.equal(cashReply.body.created_debt, null);
    assert.equal(cashReply.body.cash_updated, 400000);

    // Garbage numeric input should not create fake debts either
    const garbageReply = await ctx.req('/api/ai/chat', {
      method: 'POST',
      body: JSON.stringify({ message: 'add 777777777777777 in my account' }),
    });
    assert.equal(garbageReply.status, 200);
    assert.equal(garbageReply.body.created_debt, null);

    const debtsAfter = await ctx.req('/api/debts');
    assert.equal(debtsAfter.body.debts.length, 1);

    const compare = await ctx.req('/api/ai/chat', {
      method: 'POST',
      body: JSON.stringify({ message: 'Compare Snowball vs Avalanche with ₹3000 extra' }),
    });
    assert.equal(compare.status, 200);
    assert.match(compare.body.reply, /3,000/);
  } finally {
    await ctx.close();
  }
});
