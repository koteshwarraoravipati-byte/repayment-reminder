import 'dotenv/config';
import { createDb } from './db.js';

function offsetIsoDate(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

async function seed() {
  const db = createDb();
  await db.init();

  const existing = await db.queryOne('SELECT COUNT(*) AS count FROM debts');
  if (Number(existing?.count || 0) > 0) {
    console.log('Database already contains debt records; skipping seed.');
    await db.close();
    return;
  }

  const samples = [
    ['HDFC Millennia Credit Card', 'HDFC Bank', 'CREDIT_CARD', 85000, 48000, 36.0, 4500, offsetIsoDate(2), 'MONTHLY', false, 'High APR card — prioritize payoff'],
    ['Education Loan', 'State Bank of India', 'STUDENT_LOAN', 450000, 310000, 9.2, 8200, offsetIsoDate(6), 'MONTHLY', true, 'Section 80E eligible'],
    ['Two-Wheeler EMI', 'Bajaj Finserv', 'AUTO_LOAN', 95000, 22000, 13.5, 4200, offsetIsoDate(-1), 'MONTHLY', false, 'Only 5 installments remaining'],
    ['Personal Loan', 'ICICI Bank', 'PERSONAL_LOAN', 150000, 112000, 14.2, 6500, offsetIsoDate(14), 'MONTHLY', false, 'Flexible prepayment allowed'],
  ];

  for (const row of samples) {
    await db.insert(
      `INSERT INTO debts (name, lender, category, principal_amount, remaining_balance, interest_rate, minimum_payment, next_due_date, frequency, auto_pay, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      row
    );
  }

  console.log(`Seeded ${samples.length} sample debts (${db.dialect}).`);
  await db.close();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
