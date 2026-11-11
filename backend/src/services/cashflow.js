import { advanceDueDate, daysUntilDue, todayIsoDate } from './payoff.js';

function addDaysIso(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

function formatMoney(amount, currency = 'INR') {
  const symbol = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : '₹';
  return `${symbol}${Math.round(Number(amount || 0)).toLocaleString('en-IN')}`;
}

export function enrichIncome(row, referenceDate = todayIsoDate()) {
  const daysLeft = daysUntilDue(row.expected_date, referenceDate);
  return {
    ...row,
    amount: Number(row.amount),
    days_until_income: daysLeft,
  };
}

export function analyzeCashflow({
  debts = [],
  incomes = [],
  startingCash = 0,
  horizonDays = 30,
  referenceDate = todayIsoDate(),
  currency = 'INR',
}) {
  const startCash = Math.max(0, Number(startingCash || 0));
  const windowDays = Math.min(365, Math.max(7, Number(horizonDays || 30)));
  const endDate = addDaysIso(referenceDate, windowDays);

  const events = [];
  const delayedIncomes = [];

  for (const inc of incomes) {
    if (inc.status !== 'ACTIVE' || Number(inc.amount) <= 0) continue;
    const amt = Number(inc.amount);
    if (inc.expected_date < referenceDate) {
      delayedIncomes.push({
        id: inc.id,
        name: inc.name,
        source_type: inc.source_type,
        amount: amt,
        expected_date: inc.expected_date,
        days_overdue: Math.abs(daysUntilDue(inc.expected_date, referenceDate)),
      });
    }

    let cursor = inc.expected_date;
    let safety = 0;
    while (cursor < referenceDate && inc.frequency !== 'ONE_TIME' && safety < 60) {
      cursor = advanceDueDate(cursor, inc.frequency);
      safety += 1;
    }

    while (cursor >= referenceDate && cursor <= endDate && safety < 120) {
      events.push({
        type: 'INFLOW',
        date: cursor,
        source_id: inc.id,
        name: inc.name,
        category: inc.source_type,
        reliability: inc.reliability || 'CERTAIN',
        amount: amt,
      });
      if (inc.frequency === 'ONE_TIME') break;
      cursor = advanceDueDate(cursor, inc.frequency);
      safety += 1;
    }
  }

  for (const debt of debts) {
    if (debt.status !== 'ACTIVE' || Number(debt.remaining_balance) <= 0) continue;
    let remaining = Number(debt.remaining_balance);
    const minPay = Number(debt.minimum_payment || 0) > 0 ? Number(debt.minimum_payment) : remaining;
    let cursor = debt.next_due_date;
    let safety = 0;

    if (cursor < referenceDate) {
      const dueAmt = Math.min(remaining, minPay);
      events.push({
        type: 'OUTFLOW',
        date: referenceDate,
        original_due_date: cursor,
        is_overdue: true,
        debt_id: debt.id,
        name: debt.name,
        category: debt.category,
        amount: dueAmt,
      });
      remaining = Math.max(0, remaining - dueAmt);
      if (debt.frequency === 'ONE_TIME' || remaining <= 0) continue;
      cursor = advanceDueDate(cursor, debt.frequency);
      while (cursor < referenceDate && safety < 60) {
        cursor = advanceDueDate(cursor, debt.frequency);
        safety += 1;
      }
    }

    while (cursor >= referenceDate && cursor <= endDate && remaining > 0.01 && safety < 120) {
      const dueAmt = Math.min(remaining, minPay);
      events.push({
        type: 'OUTFLOW',
        date: cursor,
        original_due_date: cursor,
        is_overdue: false,
        debt_id: debt.id,
        name: debt.name,
        category: debt.category,
        amount: dueAmt,
      });
      remaining = Math.max(0, remaining - dueAmt);
      if (debt.frequency === 'ONE_TIME') break;
      cursor = advanceDueDate(cursor, debt.frequency);
      safety += 1;
    }
  }

  // Chronological order; inflows on the same day are credited before outflows
  events.sort((a, b) => a.date.localeCompare(b.date) || (a.type === 'INFLOW' ? -1 : 1));

  let running = startCash;
  let peakShortfall = 0;
  let totalInflow = 0;
  let totalOutflow = 0;
  const timeline = [];
  const debtChecks = [];

  for (let i = 0; i < events.length; i += 1) {
    const ev = events[i];
    const balanceBefore = Math.round(running * 100) / 100;
    if (ev.type === 'INFLOW') {
      totalInflow += ev.amount;
      running += ev.amount;
    } else {
      totalOutflow += ev.amount;
      running -= ev.amount;
    }
    const balanceAfter = Math.round(running * 100) / 100;
    if (balanceAfter < 0) {
      peakShortfall = Math.max(peakShortfall, Math.abs(balanceAfter));
    }

    const row = { ...ev, balance_before: balanceBefore, balance_after: balanceAfter };
    timeline.push(row);

    if (ev.type === 'OUTFLOW') {
      const shortfallAtDate = balanceAfter < 0 ? Math.round(Math.abs(balanceAfter) * 100) / 100 : 0;
      const nextInflow = shortfallAtDate > 0 ? events.slice(i + 1).find((x) => x.type === 'INFLOW') || null : null;
      const daysUntilInflow = nextInflow ? daysUntilDue(nextInflow.date, ev.date) : null;
      debtChecks.push({
        debt_id: ev.debt_id,
        name: ev.name,
        due_date: ev.date,
        original_due_date: ev.original_due_date,
        is_overdue: ev.is_overdue,
        amount_due: ev.amount,
        available_before: balanceBefore,
        balance_after: balanceAfter,
        status: shortfallAtDate > 0 ? 'SHORTFALL' : 'COVERED',
        shortfall: shortfallAtDate,
        next_income_name: nextInflow?.name || null,
        next_income_date: nextInflow?.date || null,
        next_income_amount: nextInflow?.amount || null,
        gap_days: daysUntilInflow,
      });
    }
  }

  const totalAvailable = Math.round((startCash + totalInflow) * 100) / 100;
  const totalDueRounded = Math.round(totalOutflow * 100) / 100;
  const totalInflowRounded = Math.round(totalInflow * 100) / 100;
  const shortfallRounded = Math.round(peakShortfall * 100) / 100;
  const endingBalance = Math.round(running * 100) / 100;
  const timingGapOnly = shortfallRounded > 0 && totalAvailable >= totalDueRounded;

  const firstShortfall = debtChecks.find((c) => c.status === 'SHORTFALL') || null;
  let overallStatus = 'SUFFICIENT';
  let headline = '';
  let recommendation = '';

  if (totalDueRounded === 0) {
    headline = `No debt repayments due in the next ${windowDays} days.`;
    recommendation = totalInflowRounded > 0
      ? `You have ${formatMoney(totalInflowRounded, currency)} in scheduled income arriving over the next ${windowDays} days.`
      : 'Add your debts and business income dates to forecast cash sufficiency.';
  } else if (shortfallRounded === 0) {
    overallStatus = 'SUFFICIENT';
    headline = `Money is sufficient for all repayments over the next ${windowDays} days.`;
    recommendation = `Your cash on hand (${formatMoney(startCash, currency)}) + scheduled income (${formatMoney(totalInflowRounded, currency)}) covers all ${formatMoney(totalDueRounded, currency)} in debt due dates, leaving an estimated surplus of ${formatMoney(endingBalance, currency)}.`;
  } else if (timingGapOnly && firstShortfall) {
    overallStatus = 'ARRANGE_FUNDS';
    headline = `Timing gap: Arrange ${formatMoney(shortfallRounded, currency)} temporarily before ${firstShortfall.due_date}.`;
    const nextPart = firstShortfall.next_income_date
      ? ` Your next income (${firstShortfall.next_income_name}: ${formatMoney(firstShortfall.next_income_amount, currency)}) arrives ${firstShortfall.gap_days} day(s) later on ${firstShortfall.next_income_date}.`
      : '';
    recommendation = `Total ${windowDays}-day income (${formatMoney(totalAvailable, currency)}) covers your total debt due (${formatMoney(totalDueRounded, currency)}), but "${firstShortfall.name}" is due before business cash arrives.${nextPart} Arrange ${formatMoney(shortfallRounded, currency)} from outside or shift your payout/due date.`;
  } else if (firstShortfall) {
    overallStatus = 'ARRANGE_FUNDS';
    const netDeficit = Math.round(Math.max(shortfallRounded, totalDueRounded - totalAvailable) * 100) / 100;
    headline = `Shortfall detected: Need to arrange ${formatMoney(shortfallRounded, currency)} from outside.`;
    recommendation = `Available cash + ${windowDays}-day income (${formatMoney(totalAvailable, currency)}) is short of upcoming repayments (${formatMoney(totalDueRounded, currency)}). Earliest shortfall is ${formatMoney(firstShortfall.shortfall, currency)} on ${firstShortfall.due_date} for "${firstShortfall.name}". Peak outside funds needed: ${formatMoney(netDeficit, currency)}.`;
  }

  return {
    horizon_days: windowDays,
    reference_date: referenceDate,
    end_date: endDate,
    starting_cash: startCash,
    total_projected_income: totalInflowRounded,
    total_projected_debt_due: totalDueRounded,
    projected_ending_balance: endingBalance,
    total_shortfall_to_arrange: shortfallRounded,
    overall_status: overallStatus,
    timing_gap_only: timingGapOnly,
    headline,
    recommendation,
    delayed_incomes: delayedIncomes,
    debt_checks: debtChecks,
    timeline,
  };
}
