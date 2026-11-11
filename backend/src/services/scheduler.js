import cron from 'node-cron';
import nodemailer from 'nodemailer';
import { daysUntilDue, todayIsoDate } from './payoff.js';

export function parseLeadDays(raw = '7,3,1,0') {
  return String(raw)
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 90);
}

function formatAlertCopy(debt, daysLeft, currency = 'INR') {
  const symbol = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : '₹';
  const minPay = Number(debt.minimum_payment || debt.remaining_balance || 0).toLocaleString('en-IN');
  if (daysLeft < 0) {
    return {
      title: `Overdue: ${debt.name}`,
      message: `${debt.name}${debt.lender ? ` (${debt.lender})` : ''} was due ${Math.abs(daysLeft)} day(s) ago on ${debt.next_due_date}. Suggested payment: ${symbol}${minPay}.`,
    };
  }
  if (daysLeft === 0) {
    return {
      title: `Due Today: ${debt.name}`,
      message: `${debt.name}${debt.lender ? ` (${debt.lender})` : ''} is due today (${debt.next_due_date}). Payment due: ${symbol}${minPay}.`,
    };
  }
  return {
    title: `Due in ${daysLeft} day${daysLeft === 1 ? '' : 's'}: ${debt.name}`,
    message: `Upcoming payment for ${debt.name}${debt.lender ? ` (${debt.lender})` : ''} on ${debt.next_due_date}. Minimum due: ${symbol}${minPay}.`,
  };
}

async function sendEmailReminderIfConfigured(settings, createdReminders) {
  if (!settings?.email_enabled || !settings.reminder_email || !createdReminders.length) return false;
  const user = (process.env.SMTP_USERNAME || '').trim();
  const pass = (process.env.SMTP_PASSWORD || '').trim().replace(/\s+/g, '');
  if (!user || !pass) return false;

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT || 587) === 465,
    auth: { user, pass },
  });

  const lines = createdReminders.map((r) => `• ${r.title}: ${r.message}`).join('\n');
  await transporter.sendMail({
    from: process.env.SMTP_FROM_EMAIL || user,
    to: settings.reminder_email,
    subject: `Debt Repayment Reminder (${createdReminders.length} alert${createdReminders.length > 1 ? 's' : ''})`,
    text: `Here are your scheduled debt repayment reminders:\n\n${lines}\n\nOpen your Debt Repayment Assistant dashboard to mark payments as paid.`,
  });
  return true;
}

export async function runReminderSweep(db, referenceDate = todayIsoDate()) {
  const settings = (await db.queryOne('SELECT * FROM reminder_settings WHERE id = $1', [1])) || {
    lead_days: '7,3,1,0',
    email_enabled: false,
    reminder_email: '',
    currency: 'INR',
  };
  const leadSet = new Set(parseLeadDays(settings.lead_days));
  const debts = await db.query('SELECT * FROM debts WHERE status = $1 AND remaining_balance > 0', ['ACTIVE']);

  const created = [];
  for (const debt of debts) {
    const daysLeft = daysUntilDue(debt.next_due_date, referenceDate);
    const shouldTrigger = daysLeft < 0 || leadSet.has(daysLeft);
    if (!shouldTrigger) continue;

    // For overdue debts, collapse bucket to -1 per due_date so daily sweep doesn't duplicate endlessly
    const bucket = daysLeft < 0 ? -1 : daysLeft;
    const existing = await db.queryOne(
      'SELECT id FROM reminders WHERE debt_id = $1 AND due_date = $2 AND days_before = $3',
      [debt.id, debt.next_due_date, bucket]
    );
    if (existing) continue;

    const { title, message } = formatAlertCopy(debt, daysLeft, settings.currency);
    const channel = settings.email_enabled && settings.reminder_email ? 'IN_APP+EMAIL' : 'IN_APP';
    const id = await db.insert(
      `INSERT INTO reminders (debt_id, due_date, days_before, channel, title, message, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [debt.id, debt.next_due_date, bucket, channel, title, message, 'UNREAD']
    );
    created.push({ id, debt_id: debt.id, due_date: debt.next_due_date, days_before: bucket, title, message, status: 'UNREAD' });
  }

  let emailed = false;
  try {
    emailed = await sendEmailReminderIfConfigured(settings, created);
  } catch (err) {
    console.error('Reminder email delivery failed:', err.message);
  }

  return { checked_debts: debts.length, created_count: created.length, created, emailed };
}

export function startReminderScheduler(db, cronExpression = process.env.REMINDER_CRON || '0 9 * * *') {
  let task = null;
  const schedule = (expr) => {
    if (task) {
      task.stop();
      task = null;
    }
    if (!cron.validate(expr)) {
      console.warn(`Invalid cron expression "${expr}", falling back to "0 9 * * *"`);
      expr = '0 9 * * *';
    }
    task = cron.schedule(expr, () => {
      runReminderSweep(db).catch((err) => console.error('Scheduled reminder sweep failed:', err));
    });
  };

  schedule(cronExpression);
  // Run an initial sweep at startup so upcoming/overdue debts surface immediately
  runReminderSweep(db).catch((err) => console.error('Initial reminder sweep failed:', err));

  return {
    reschedule: schedule,
    stop: () => {
      if (task) task.stop();
    },
  };
}
