import express from 'express';
import cors from 'cors';
import { advanceDueDate, enrichDebt, simulatePayoff, todayIsoDate } from './services/payoff.js';
import { parseLeadDays, runReminderSweep } from './services/scheduler.js';
import { generateAssistantReply, parseNaturalLanguageDebt } from './services/ai.js';

function validateDebtPayload(body, partial = false) {
  const name = body.name !== undefined ? String(body.name).trim() : undefined;
  const nextDue = body.next_due_date !== undefined ? String(body.next_due_date).trim() : undefined;

  if (!partial && (!name || !nextDue)) {
    return { error: 'Debt name and next due date (YYYY-MM-DD) are required' };
  }
  if (nextDue !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(nextDue)) {
    return { error: 'next_due_date must use YYYY-MM-DD format' };
  }

  const principal = body.principal_amount !== undefined ? Number(body.principal_amount) : undefined;
  const remaining = body.remaining_balance !== undefined ? Number(body.remaining_balance) : principal;
  const interestRate = body.interest_rate !== undefined ? Number(body.interest_rate) : undefined;
  const minimumPayment = body.minimum_payment !== undefined ? Number(body.minimum_payment) : undefined;

  for (const [label, val] of [
    ['principal_amount', principal],
    ['remaining_balance', remaining],
    ['interest_rate', interestRate],
    ['minimum_payment', minimumPayment],
  ]) {
    if (val !== undefined && (!Number.isFinite(val) || val < 0)) {
      return { error: `${label} must be a non-negative number` };
    }
  }

  if (!partial && (principal === undefined || principal <= 0)) {
    return { error: 'principal_amount must be greater than 0' };
  }

  const freq = body.frequency !== undefined ? String(body.frequency).toUpperCase() : undefined;
  if (freq !== undefined && !['MONTHLY', 'BIWEEKLY', 'WEEKLY', 'QUARTERLY', 'ONE_TIME'].includes(freq)) {
    return { error: 'Invalid frequency' };
  }

  return {
    data: {
      name,
      lender: body.lender !== undefined ? String(body.lender).trim() : undefined,
      category: body.category !== undefined ? String(body.category).toUpperCase().trim() : undefined,
      principal_amount: principal,
      remaining_balance: remaining,
      interest_rate: interestRate,
      minimum_payment: minimumPayment,
      next_due_date: nextDue,
      frequency: freq,
      auto_pay: body.auto_pay !== undefined ? Boolean(body.auto_pay) : undefined,
      notes: body.notes !== undefined ? String(body.notes).trim() : undefined,
    },
  };
}

export function createApp(db, options = {}) {
  const app = express();
  const corsOrigin = options.corsOrigin || process.env.CORS_ORIGIN || '*';
  app.use(cors({ origin: corsOrigin === '*' ? '*' : corsOrigin.split(',').map((s) => s.trim()) }));
  app.use(express.json());

  app.get('/api/health', async (_req, res, next) => {
    try {
      await db.queryOne('SELECT 1 AS ok');
      res.json({ status: 'ok', service: 'debt-repayment-assistant', database: db.dialect, persistence: db.persistence });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/dashboard', async (_req, res, next) => {
    try {
      const today = todayIsoDate();
      const rawDebts = await db.query('SELECT * FROM debts ORDER BY next_due_date ASC, id DESC');
      const debts = rawDebts.map((d) => enrichDebt(d, today));
      const active = debts.filter((d) => d.status === 'ACTIVE' && d.remaining_balance > 0);
      const settings = await db.queryOne('SELECT * FROM reminder_settings WHERE id = $1', [1]);
      const unreadReminders = await db.query(
        'SELECT * FROM reminders WHERE status = $1 ORDER BY sent_at DESC, id DESC LIMIT 20',
        ['UNREAD']
      );
      const recentPayments = await db.query(
        `SELECT p.*, d.name AS debt_name FROM payments p
         JOIN debts d ON d.id = p.debt_id
         ORDER BY p.paid_on DESC, p.id DESC LIMIT 10`
      );

      const summary = {
        active_count: active.length,
        paid_off_count: debts.filter((d) => d.status === 'PAID_OFF').length,
        total_remaining_debt: Math.round(active.reduce((s, d) => s + d.remaining_balance, 0) * 100) / 100,
        monthly_minimum_total: Math.round(active.reduce((s, d) => s + d.minimum_payment, 0) * 100) / 100,
        overdue_count: active.filter((d) => d.days_until_due < 0).length,
        due_this_week_count: active.filter((d) => d.days_until_due >= 0 && d.days_until_due <= 7).length,
        unread_reminders_count: unreadReminders.length,
        today,
      };

      res.json({
        summary,
        debts,
        unread_reminders: unreadReminders,
        recent_payments: recentPayments,
        settings: settings
          ? {
              ...settings,
              browser_notifications: Boolean(settings.browser_notifications),
              email_enabled: Boolean(settings.email_enabled),
            }
          : null,
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/debts', async (req, res, next) => {
    try {
      const { status } = req.query;
      const rows = status
        ? await db.query('SELECT * FROM debts WHERE status = $1 ORDER BY next_due_date ASC', [String(status).toUpperCase()])
        : await db.query('SELECT * FROM debts ORDER BY next_due_date ASC, id DESC');
      res.json({ debts: rows.map((d) => enrichDebt(d)) });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/debts', async (req, res, next) => {
    try {
      const parsed = validateDebtPayload(req.body || {}, false);
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      const d = parsed.data;

      const id = await db.insert(
        `INSERT INTO debts (name, lender, category, principal_amount, remaining_balance, interest_rate, minimum_payment, next_due_date, frequency, auto_pay, status, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          d.name,
          d.lender || '',
          d.category || 'LOAN',
          d.principal_amount,
          d.remaining_balance ?? d.principal_amount,
          d.interest_rate ?? 0,
          d.minimum_payment ?? 0,
          d.next_due_date,
          d.frequency || 'MONTHLY',
          Boolean(d.auto_pay),
          (d.remaining_balance ?? d.principal_amount) <= 0 ? 'PAID_OFF' : 'ACTIVE',
          d.notes || '',
        ]
      );

      await runReminderSweep(db);
      const created = await db.queryOne('SELECT * FROM debts WHERE id = $1', [id]);
      res.status(201).json({ debt: enrichDebt(created), message: 'Debt added to tracker' });
    } catch (err) {
      next(err);
    }
  });

  app.put('/api/debts/:id', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const existing = await db.queryOne('SELECT * FROM debts WHERE id = $1', [id]);
      if (!existing) return res.status(404).json({ error: 'Debt not found' });

      const parsed = validateDebtPayload(req.body || {}, true);
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      const d = parsed.data;

      const remaining = d.remaining_balance ?? existing.remaining_balance;
      const status = remaining <= 0 ? 'PAID_OFF' : existing.status === 'PAID_OFF' ? 'ACTIVE' : existing.status;

      await db.execute(
        `UPDATE debts
         SET name = $1, lender = $2, category = $3, principal_amount = $4, remaining_balance = $5,
             interest_rate = $6, minimum_payment = $7, next_due_date = $8, frequency = $9,
             auto_pay = $10, status = $11, notes = $12, updated_at = CURRENT_TIMESTAMP
         WHERE id = $13`,
        [
          d.name ?? existing.name,
          d.lender ?? existing.lender,
          d.category ?? existing.category,
          d.principal_amount ?? existing.principal_amount,
          remaining,
          d.interest_rate ?? existing.interest_rate,
          d.minimum_payment ?? existing.minimum_payment,
          d.next_due_date ?? existing.next_due_date,
          d.frequency ?? existing.frequency,
          d.auto_pay ?? Boolean(existing.auto_pay),
          status,
          d.notes ?? existing.notes,
          id,
        ]
      );

      await runReminderSweep(db);
      const updated = await db.queryOne('SELECT * FROM debts WHERE id = $1', [id]);
      res.json({ debt: enrichDebt(updated), message: 'Debt updated' });
    } catch (err) {
      next(err);
    }
  });

  app.patch('/api/debts/:id/status', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const existing = await db.queryOne('SELECT * FROM debts WHERE id = $1', [id]);
      if (!existing) return res.status(404).json({ error: 'Debt not found' });

      const nextStatus = String(req.body?.status || '').toUpperCase();
      if (!['ACTIVE', 'ARCHIVED', 'PAID_OFF'].includes(nextStatus)) {
        return res.status(400).json({ error: 'Status must be ACTIVE, ARCHIVED, or PAID_OFF' });
      }
      await db.execute('UPDATE debts SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [nextStatus, id]);
      const updated = await db.queryOne('SELECT * FROM debts WHERE id = $1', [id]);
      res.json({ debt: enrichDebt(updated), message: `Debt status set to ${nextStatus}` });
    } catch (err) {
      next(err);
    }
  });

  app.delete('/api/debts/:id', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const result = await db.execute('DELETE FROM debts WHERE id = $1', [id]);
      if (!result.changes) return res.status(404).json({ error: 'Debt not found' });
      res.json({ message: 'Debt permanently deleted' });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/debts/:id/pay', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const debt = await db.queryOne('SELECT * FROM debts WHERE id = $1', [id]);
      if (!debt) return res.status(404).json({ error: 'Debt not found' });

      const amount = Number(req.body?.amount ?? debt.minimum_payment ?? debt.remaining_balance);
      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ error: 'Payment amount must be greater than 0' });
      }
      const paidOn = String(req.body?.paid_on || todayIsoDate());
      const note = String(req.body?.note || '').trim();
      const advanceCycle = req.body?.advance_cycle !== false;

      const appliedAmount = Math.min(amount, Number(debt.remaining_balance));
      const newBalance = Math.max(0, Math.round((Number(debt.remaining_balance) - appliedAmount) * 100) / 100);
      const newStatus = newBalance <= 0.01 ? 'PAID_OFF' : 'ACTIVE';
      const nextDueDate =
        newStatus === 'PAID_OFF' || !advanceCycle || debt.frequency === 'ONE_TIME'
          ? debt.next_due_date
          : advanceDueDate(debt.next_due_date, debt.frequency);

      await db.insert(
        'INSERT INTO payments (debt_id, amount, paid_on, note) VALUES ($1, $2, $3, $4)',
        [id, appliedAmount, paidOn, note]
      );

      await db.execute(
        `UPDATE debts
         SET remaining_balance = $1, next_due_date = $2, status = $3, updated_at = CURRENT_TIMESTAMP
         WHERE id = $4`,
        [newBalance, nextDueDate, newStatus, id]
      );

      // Acknowledge reminders belonging to the due date just paid
      await db.execute(
        'UPDATE reminders SET status = $1 WHERE debt_id = $2 AND due_date = $3',
        ['ACKNOWLEDGED', id, debt.next_due_date]
      );

      await runReminderSweep(db);
      const updated = await db.queryOne('SELECT * FROM debts WHERE id = $1', [id]);
      res.json({
        debt: enrichDebt(updated),
        payment: { debt_id: id, amount: appliedAmount, paid_on: paidOn },
        message: newStatus === 'PAID_OFF' ? `${debt.name} is completely paid off!` : `Payment recorded. Next due date: ${nextDueDate}`,
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/payments', async (_req, res, next) => {
    try {
      const payments = await db.query(
        `SELECT p.*, d.name AS debt_name, d.category
         FROM payments p
         JOIN debts d ON d.id = p.debt_id
         ORDER BY p.paid_on DESC, p.id DESC LIMIT 100`
      );
      res.json({ payments });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/strategy', async (req, res, next) => {
    try {
      const method = String(req.query.method || 'avalanche').toLowerCase() === 'snowball' ? 'snowball' : 'avalanche';
      const extra = Math.max(0, Number(req.query.extra || 0));
      const debts = await db.query('SELECT * FROM debts WHERE status = $1 AND remaining_balance > 0', ['ACTIVE']);

      const selected = simulatePayoff(debts, method, extra);
      const alternative = simulatePayoff(debts, method === 'avalanche' ? 'snowball' : 'avalanche', extra);
      const baseline = simulatePayoff(debts, method, 0);

      res.json({
        selected,
        alternative,
        baseline,
        interest_saved_vs_baseline: Math.max(0, Math.round((baseline.total_interest - selected.total_interest) * 100) / 100),
        months_saved_vs_baseline: Math.max(0, baseline.months - selected.months),
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/reminders', async (_req, res, next) => {
    try {
      const reminders = await db.query(
        `SELECT r.*, d.name AS debt_name, d.remaining_balance, d.minimum_payment
         FROM reminders r
         JOIN debts d ON d.id = r.debt_id
         ORDER BY CASE WHEN r.status = 'UNREAD' THEN 0 ELSE 1 END, r.sent_at DESC, r.id DESC
         LIMIT 50`
      );
      res.json({ reminders });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/reminders/run', async (_req, res, next) => {
    try {
      const report = await runReminderSweep(db);
      res.json(report);
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/cron/reminders', async (req, res, next) => {
    try {
      const secret = (process.env.CRON_SECRET || '').trim();
      if (secret && req.headers.authorization !== `Bearer ${secret}`) {
        return res.status(401).json({ error: 'Unauthorized cron request' });
      }
      const report = await runReminderSweep(db);
      res.json({ ok: true, ...report });
    } catch (err) {
      next(err);
    }
  });

  app.patch('/api/reminders/:id/ack', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const result = await db.execute('UPDATE reminders SET status = $1 WHERE id = $2', ['ACKNOWLEDGED', id]);
      if (!result.changes) return res.status(404).json({ error: 'Reminder not found' });
      res.json({ message: 'Reminder acknowledged' });
    } catch (err) {
      next(err);
    }
  });

  app.patch('/api/reminders/ack-all', async (_req, res, next) => {
    try {
      const result = await db.execute('UPDATE reminders SET status = $1 WHERE status = $2', ['ACKNOWLEDGED', 'UNREAD']);
      res.json({ acknowledged: result.changes, message: 'All reminders marked as read' });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/settings', async (_req, res, next) => {
    try {
      const settings = await db.queryOne('SELECT * FROM reminder_settings WHERE id = $1', [1]);
      res.json({
        settings: {
          ...settings,
          browser_notifications: Boolean(settings.browser_notifications),
          email_enabled: Boolean(settings.email_enabled),
        },
      });
    } catch (err) {
      next(err);
    }
  });

  app.put('/api/settings', async (req, res, next) => {
    try {
      const current = await db.queryOne('SELECT * FROM reminder_settings WHERE id = $1', [1]);
      const body = req.body || {};
      const leadList = body.lead_days !== undefined ? parseLeadDays(body.lead_days) : parseLeadDays(current.lead_days);
      if (!leadList.length) {
        return res.status(400).json({ error: 'lead_days must contain comma-separated numbers between 0 and 90 (e.g. 7,3,1,0)' });
      }
      const leadDaysStr = [...new Set(leadList)].sort((a, b) => b - a).join(',');
      const dailyCron = body.daily_cron ? String(body.daily_cron).trim() : current.daily_cron;
      const browserNotifications = body.browser_notifications !== undefined ? Boolean(body.browser_notifications) : Boolean(current.browser_notifications);
      const emailEnabled = body.email_enabled !== undefined ? Boolean(body.email_enabled) : Boolean(current.email_enabled);
      const reminderEmail = body.reminder_email !== undefined ? String(body.reminder_email).trim() : current.reminder_email;
      const preferredStrategy = ['avalanche', 'snowball'].includes(String(body.preferred_strategy || '').toLowerCase())
        ? String(body.preferred_strategy).toLowerCase()
        : current.preferred_strategy;
      const currency = ['INR', 'USD', 'EUR'].includes(String(body.currency || '').toUpperCase())
        ? String(body.currency).toUpperCase()
        : current.currency;

      await db.execute(
        `UPDATE reminder_settings
         SET lead_days = $1, daily_cron = $2, browser_notifications = $3, email_enabled = $4,
             reminder_email = $5, preferred_strategy = $6, currency = $7, updated_at = CURRENT_TIMESTAMP
         WHERE id = $8`,
        [leadDaysStr, dailyCron, browserNotifications, emailEnabled, reminderEmail, preferredStrategy, currency, 1]
      );

      if (options.onCronChange && dailyCron !== current.daily_cron) {
        options.onCronChange(dailyCron);
      }
      const updated = await db.queryOne('SELECT * FROM reminder_settings WHERE id = $1', [1]);
      res.json({
        settings: {
          ...updated,
          browser_notifications: Boolean(updated.browser_notifications),
          email_enabled: Boolean(updated.email_enabled),
        },
        message: 'Reminder preferences saved',
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/ai/history', async (_req, res, next) => {
    try {
      const messages = await db.query('SELECT * FROM chat_messages ORDER BY id ASC LIMIT 60');
      res.json({ messages });
    } catch (err) {
      next(err);
    }
  });

  app.delete('/api/ai/history', async (_req, res, next) => {
    try {
      await db.execute('DELETE FROM chat_messages');
      res.json({ message: 'Chat history cleared' });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/ai/chat', async (req, res, next) => {
    try {
      const message = String(req.body?.message || '').trim();
      if (!message) return res.status(400).json({ error: 'Message is required' });

      await db.insert('INSERT INTO chat_messages (role, content, metadata) VALUES ($1, $2, $3)', ['user', message, '{}']);

      const parsedDebt = parseNaturalLanguageDebt(message);
      let createdDebt = null;
      if (parsedDebt) {
        const newId = await db.insert(
          `INSERT INTO debts (name, lender, category, principal_amount, remaining_balance, interest_rate, minimum_payment, next_due_date, frequency, auto_pay, status, notes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            parsedDebt.name,
            parsedDebt.lender,
            parsedDebt.category,
            parsedDebt.principal_amount,
            parsedDebt.remaining_balance,
            parsedDebt.interest_rate,
            parsedDebt.minimum_payment,
            parsedDebt.next_due_date,
            parsedDebt.frequency,
            parsedDebt.auto_pay,
            'ACTIVE',
            parsedDebt.notes,
          ]
        );
        createdDebt = await db.queryOne('SELECT * FROM debts WHERE id = $1', [newId]);
        await runReminderSweep(db);
      }

      const debts = await db.query('SELECT * FROM debts ORDER BY next_due_date ASC');
      const settings = await db.queryOne('SELECT * FROM reminder_settings WHERE id = $1', [1]);
      const aiResult = await generateAssistantReply({ message, debts, settings, createdDebt });

      await db.insert(
        'INSERT INTO chat_messages (role, content, metadata) VALUES ($1, $2, $3)',
        ['assistant', aiResult.reply, JSON.stringify({ provider: aiResult.provider, created_debt_id: createdDebt?.id || null })]
      );

      res.json({
        reply: aiResult.reply,
        provider: aiResult.provider,
        created_debt: createdDebt ? enrichDebt(createdDebt) : null,
      });
    } catch (err) {
      next(err);
    }
  });

  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  });

  return app;
}
