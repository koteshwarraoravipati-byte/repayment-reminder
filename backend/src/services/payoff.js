export function todayIsoDate(now = new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function daysUntilDue(dueDateStr, referenceDateStr = todayIsoDate()) {
  const [y1, m1, d1] = dueDateStr.split('-').map(Number);
  const [y2, m2, d2] = referenceDateStr.split('-').map(Number);
  const target = Date.UTC(y1, m1 - 1, d1);
  const ref = Date.UTC(y2, m2 - 1, d2);
  return Math.round((target - ref) / 86400000);
}

export function advanceDueDate(dueDateStr, frequency = 'MONTHLY') {
  const [y, m, d] = dueDateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));

  if (frequency === 'WEEKLY') {
    dt.setUTCDate(dt.getUTCDate() + 7);
  } else if (frequency === 'BIWEEKLY') {
    dt.setUTCDate(dt.getUTCDate() + 14);
  } else if (frequency === 'QUARTERLY') {
    const targetMonth = dt.getUTCMonth() + 3;
    dt.setUTCMonth(targetMonth);
    if (dt.getUTCDate() !== d) dt.setUTCDate(0);
  } else if (frequency === 'MONTHLY') {
    const nextMonth = dt.getUTCMonth() + 1;
    dt.setUTCMonth(nextMonth);
    // Clamp month-end dates (e.g., Jan 31 -> Feb 28/29) instead of spilling into March
    if (dt.getUTCDate() !== d) dt.setUTCDate(0);
  }

  return dt.toISOString().slice(0, 10);
}

export function enrichDebt(row, referenceDate = todayIsoDate()) {
  const daysLeft = daysUntilDue(row.next_due_date, referenceDate);
  let urgency = 'ON_TRACK';
  if (row.status === 'PAID_OFF' || row.remaining_balance <= 0) urgency = 'PAID_OFF';
  else if (row.status === 'ARCHIVED') urgency = 'ARCHIVED';
  else if (daysLeft < 0) urgency = 'OVERDUE';
  else if (daysLeft === 0) urgency = 'DUE_TODAY';
  else if (daysLeft <= 7) urgency = 'DUE_SOON';

  return {
    ...row,
    auto_pay: Boolean(row.auto_pay),
    principal_amount: Number(row.principal_amount),
    remaining_balance: Number(row.remaining_balance),
    interest_rate: Number(row.interest_rate),
    minimum_payment: Number(row.minimum_payment),
    days_until_due: daysLeft,
    urgency,
  };
}

export function simulatePayoff(rawDebts, method = 'avalanche', extraMonthly = 0) {
  const active = rawDebts
    .filter((d) => d.status === 'ACTIVE' && Number(d.remaining_balance) > 0)
    .map((d) => ({
      id: d.id,
      name: d.name,
      balance: Number(d.remaining_balance),
      apr: Number(d.interest_rate || 0),
      minPayment: Math.max(0, Number(d.minimum_payment || 0)),
    }));

  if (!active.length) {
    return {
      method,
      extra_monthly: Number(extraMonthly) || 0,
      months: 0,
      total_interest: 0,
      total_paid: 0,
      payoff_order: [],
      timeline: [],
    };
  }

  const sortFn =
    method === 'snowball'
      ? (a, b) => a.balance - b.balance || b.apr - a.apr
      : (a, b) => b.apr - a.apr || a.balance - b.balance;

  const extra = Math.max(0, Number(extraMonthly) || 0);
  const ordered = [...active].sort(sortFn);
  const payoffOrder = [];
  const timeline = [];

  let month = 0;
  let totalInterest = 0;
  let totalPaid = 0;
  const maxMonths = 360;

  while (ordered.some((d) => d.balance > 0.01) && month < maxMonths) {
    month += 1;
    let monthInterest = 0;
    let monthPaid = 0;

    // 1. Apply monthly interest and minimum payments
    let snowballPool = extra;
    for (const debt of ordered) {
      if (debt.balance <= 0.01) {
        snowballPool += debt.minPayment;
        continue;
      }
      const interest = debt.balance * (debt.apr / 100 / 12);
      debt.balance += interest;
      monthInterest += interest;

      const scheduledMin = debt.minPayment > 0 ? debt.minPayment : Math.min(debt.balance, Math.max(500, debt.balance * 0.03));
      const payment = Math.min(debt.balance, scheduledMin);
      debt.balance -= payment;
      monthPaid += payment;

      if (debt.balance <= 0.01) {
        snowballPool += Math.max(0, scheduledMin - payment);
        debt.balance = 0;
        if (!payoffOrder.some((p) => p.id === debt.id)) {
          payoffOrder.push({ id: debt.id, name: debt.name, month_paid_off: month, apr: debt.apr });
        }
      }
    }

    // 2. Apply snowball/avalanche extra pool to priority debt(s)
    for (const debt of ordered) {
      if (snowballPool <= 0.01) break;
      if (debt.balance <= 0.01) continue;
      const payment = Math.min(debt.balance, snowballPool);
      debt.balance -= payment;
      snowballPool -= payment;
      monthPaid += payment;

      if (debt.balance <= 0.01) {
        debt.balance = 0;
        if (!payoffOrder.some((p) => p.id === debt.id)) {
          payoffOrder.push({ id: debt.id, name: debt.name, month_paid_off: month, apr: debt.apr });
        }
      }
    }

    totalInterest += monthInterest;
    totalPaid += monthPaid;

    if (month <= 24 || month % 6 === 0 || !ordered.some((d) => d.balance > 0.01)) {
      const remainingTotal = ordered.reduce((acc, d) => acc + d.balance, 0);
      timeline.push({
        month,
        remaining_balance: Math.round(remainingTotal * 100) / 100,
        cumulative_interest: Math.round(totalInterest * 100) / 100,
      });
    }
  }

  return {
    method,
    extra_monthly: extra,
    months: month,
    total_interest: Math.round(totalInterest * 100) / 100,
    total_paid: Math.round(totalPaid * 100) / 100,
    payoff_order: payoffOrder,
    timeline,
  };
}
