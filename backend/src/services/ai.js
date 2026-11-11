import { enrichDebt, simulatePayoff, todayIsoDate } from './payoff.js';
import { analyzeCashflow, enrichIncome } from './cashflow.js';

function formatMoney(amount, currency = 'INR') {
  const symbol = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : '₹';
  return `${symbol}${Math.round(Number(amount || 0)).toLocaleString('en-IN')}`;
}

const MAX_REASONABLE_AMOUNT = 1_000_000_000_000;

function extractAmountAndDate(text, referenceDate = todayIsoDate()) {
  const amountMatches = [...text.matchAll(/(?:₹|\$|€|rs\.?|inr|usd)?\s*(\d[\d,]*(?:\.\d+)?)\s*(k|m|million|lakh|lakhs|l)?/gi)];
  let amount = 0;
  for (const m of amountMatches) {
    const idx = m.index || 0;
    const before = text.slice(Math.max(0, idx - 12), idx).toLowerCase();
    const after = text.slice(idx + m[0].length, idx + m[0].length + 12).toLowerCase();
    if (after.startsWith('%') || (/\b(apr|interest|rate|due|on|the)\b/.test(before) && Number(m[1].replace(/,/g, '')) <= 31)) continue;
    let val = Number(m[1].replace(/,/g, ''));
    const unit = (m[2] || '').toLowerCase();
    if (unit === 'k') val *= 1000;
    if (unit === 'm' || unit === 'million') val *= 1000000;
    if (unit === 'l' || unit.startsWith('lakh')) val *= 100000;
    if (Number.isFinite(val) && val <= MAX_REASONABLE_AMOUNT && val > amount) amount = val;
  }

  let dateStr = null;
  const isoMatch = text.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (isoMatch) {
    dateStr = isoMatch[1];
  } else {
    const dayMatch = text.match(/\b(?:on\s+(?:the\s+)?|due\s+(?:on\s+)?)(\d{1,2})(?:st|nd|rd|th)?\b/i);
    const now = new Date(`${referenceDate}T00:00:00Z`);
    if (dayMatch) {
      const targetDay = Math.min(28, Math.max(1, Number(dayMatch[1])));
      const dt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), targetDay));
      if (dt < now) dt.setUTCMonth(dt.getUTCMonth() + 1);
      dateStr = dt.toISOString().slice(0, 10);
    } else {
      const dt = new Date(now);
      dt.setUTCDate(dt.getUTCDate() + 15);
      dateStr = dt.toISOString().slice(0, 10);
    }
  }

  const frequency = /\bweekly\b/i.test(text) ? 'WEEKLY' : /\bbiweekly\b/i.test(text) ? 'BIWEEKLY' : /\bone[- ]?time\b/i.test(text) ? 'ONE_TIME' : 'MONTHLY';
  return { amount, dateStr, frequency };
}

export function parseNaturalLanguageCashUpdate(text) {
  const lower = text.toLowerCase();
  const cashContext = /\b(in my account|my balance|bank balance|cash on hand|cash balance|have in account|set cash|update cash)\b/.test(lower);
  const debtKeyword = /\b(debt|loan|emi|credit card|card|owe|borrow)\b/.test(lower);
  if (!cashContext || debtKeyword) return null;
  const { amount } = extractAmountAndDate(text);
  if (amount <= 0) return null;
  return { starting_cash: amount };
}

export function parseNaturalLanguageIncome(text, referenceDate = todayIsoDate()) {
  const lower = text.toLowerCase();
  if (/\b(in my account|my balance|bank balance|cash on hand|cash balance)\b/.test(lower)) return null;
  const hasIncomeKeyword = /\b(income|business|salary|payout|revenue|earning|client|rent|dividend|get money|receive money|receiving)\b/.test(lower);
  const addIntent = /\b(add|create|track|expecting|expect|get|receive|new)\b/.test(lower);
  if (!hasIncomeKeyword || !addIntent) return null;

  const { amount, dateStr, frequency } = extractAmountAndDate(text, referenceDate);
  if (amount <= 0) return null;

  let sourceType = 'BUSINESS';
  if (/\bsalary|paycheck\b/i.test(text)) sourceType = 'SALARY';
  else if (/\bfreelance|consulting|client\b/i.test(text)) sourceType = 'FREELANCE';
  else if (/\brent|rental\b/i.test(text)) sourceType = 'RENTAL';

  const cleanedName = text
    .replace(/^(please\s+)?(add|create|track|i\s+get|i\s+receive|expecting)\s+(a|an|my|new)?\s*/i, '')
    .replace(/(?:₹|\$|€|rs\.?)\s*\d[\d,]*(?:\.\d+)?\s*(k|m|million|lakhs?|l)?/gi, '')
    .replace(/\b(?:from|on|due|every|weekly|biweekly|monthly|one-time|expected)\b.*$/i, '')
    .trim();

  const name = cleanedName.length >= 3 ? cleanedName.slice(0, 60) : `${sourceType.charAt(0) + sourceType.slice(1).toLowerCase()} Income`;

  return {
    name,
    source_type: sourceType,
    amount,
    expected_date: dateStr,
    frequency,
    reliability: /\bvariable|estimate\b/i.test(text) ? 'VARIABLE' : 'CERTAIN',
    notes: `Created by AI Assistant from: "${text.slice(0, 120)}"`,
  };
}

export function parseNaturalLanguageDebt(text, referenceDate = todayIsoDate()) {
  const lower = text.toLowerCase();
  if (/\b(income|business|salary|payout|revenue|earning|get money|receive money|in my account|my balance|bank balance|cash)\b/.test(lower)) return null;
  const addIntent = /\b(add|create|track|remind me about|new debt|new loan|new card|new emi)\b/.test(lower);
  const hasDebtTerm = /\b(debt|loan|emi|card|mortgage|owe|apr|interest|due)\b/.test(lower);
  if (!addIntent || !hasDebtTerm) return null;

  const { amount: principal, dateStr: nextDueDate, frequency } = extractAmountAndDate(text, referenceDate);
  if (principal <= 0) return null;

  const aprMatch = text.match(/(\d+(?:\.\d+)?)\s*%\s*(?:apr|interest|rate)?/i);
  const interestRate = aprMatch ? Number(aprMatch[1]) : 12;

  const minMatch = text.match(/(?:min(?:imum)?(?:\s+payment)?|emi|monthly)\s*(?:of|is|:)?\s*(?:₹|\$|€|rs\.?)?\s*(\d[\d,]*(?:\.\d+)?)\s*(k)?/i);
  let minimumPayment = minMatch ? Number(minMatch[1].replace(/,/g, '')) * (minMatch[2] ? 1000 : 1) : Math.round(principal * 0.05);
  if (minimumPayment > principal) minimumPayment = principal;

  let category = 'PERSONAL_LOAN';
  if (/credit\s*card|card/i.test(text)) category = 'CREDIT_CARD';
  else if (/student|education/i.test(text)) category = 'STUDENT_LOAN';
  else if (/car|auto|bike|vehicle|two[- ]wheeler/i.test(text)) category = 'AUTO_LOAN';
  else if (/home|mortgage|house/i.test(text)) category = 'MORTGAGE';

  const cleanedName = text
    .replace(/^(please\s+)?(add|create|track|remind me about|remind me to pay)\s+(a|an|my|new)?\s*/i, '')
    .replace(/\b(debt|loan)\b.*$/i, (m) => m.split(/\s+/).slice(0, 1).join(''))
    .replace(/(?:₹|\$|€|rs\.?)\s*\d[\d,]*(?:\.\d+)?\s*(k|lakhs?|l)?/gi, '')
    .replace(/\b(?:at|with|due|on|monthly|minimum|emi|interest|apr|rate)\b.*$/i, '')
    .trim();

  const name = cleanedName.length >= 3 ? cleanedName.slice(0, 60) : `${category.replace('_', ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())}`;

  return {
    name,
    lender: '',
    category,
    principal_amount: principal,
    remaining_balance: principal,
    interest_rate: interestRate,
    minimum_payment: minimumPayment,
    next_due_date: nextDueDate,
    frequency,
    auto_pay: false,
    notes: `Created by AI Assistant from: "${text.slice(0, 120)}"`,
  };
}

function buildRuleBasedReply(message, debts, incomes, settings) {
  const currency = settings?.currency || 'INR';
  const enriched = debts.map((d) => enrichDebt(d)).filter((d) => d.status === 'ACTIVE' && d.remaining_balance > 0);
  const activeIncomes = incomes.map((i) => enrichIncome(i)).filter((i) => i.status === 'ACTIVE');
  const lower = message.toLowerCase();

  const cashflow = analyzeCashflow({
    debts,
    incomes,
    startingCash: settings?.starting_cash || 0,
    horizonDays: 30,
    currency,
  });

  if (/\b(sufficient|enough|arrange|shortfall|cashflow|cash flow|cover|business|income|salary|money)\b/.test(lower)) {
    const lines = [
      cashflow.overall_status === 'SUFFICIENT' ? `✅ **${cashflow.headline}**` : `⚠️ **${cashflow.headline}**`,
      cashflow.recommendation,
    ];
    if (activeIncomes.length) {
      const nextInc = [...activeIncomes].sort((a, b) => a.expected_date.localeCompare(b.expected_date))[0];
      lines.push(`💼 Next scheduled income: **${nextInc.name}** — **${formatMoney(nextInc.amount, currency)}** on **${nextInc.expected_date}**.`);
    } else {
      lines.push('💡 Tip: Add your business payout dates in **Income & Cashflow** (or tell me: *"Add ₹45,000 Retail Business income on the 18th"*) for exact date-by-date comparison.');
    }
    return lines.join('\n\n');
  }

  if (!enriched.length) {
    return 'You currently have no active debts tracked! Add a debt using the form or tell me something like: "Add HDFC Credit Card ₹50,000 at 18% interest due on the 15th".';
  }

  const totalDebt = enriched.reduce((sum, d) => sum + d.remaining_balance, 0);
  const overdue = enriched.filter((d) => d.days_until_due < 0).sort((a, b) => a.days_until_due - b.days_until_due);
  const dueSoon = enriched.filter((d) => d.days_until_due >= 0 && d.days_until_due <= 7).sort((a, b) => a.days_until_due - b.days_until_due);

  if (/\b(due|upcoming|week|today|overdue|late|remind|when|schedule)\b/.test(lower)) {
    const lines = [];
    if (overdue.length) {
      lines.push(`⚠️ **Overdue (${overdue.length}):**`);
      for (const d of overdue) {
        lines.push(`- **${d.name}** — ${Math.abs(d.days_until_due)} day(s) overdue (due ${d.next_due_date}), min payment ${formatMoney(d.minimum_payment, currency)}`);
      }
    }
    if (dueSoon.length) {
      lines.push(`📅 **Due within 7 days (${dueSoon.length}):**`);
      for (const d of dueSoon) {
        const when = d.days_until_due === 0 ? 'today' : `in ${d.days_until_due} day(s)`;
        lines.push(`- **${d.name}** — due ${when} (${d.next_due_date}), min payment ${formatMoney(d.minimum_payment, currency)}`);
      }
    }
    if (!overdue.length && !dueSoon.length) {
      const next = [...enriched].sort((a, b) => a.days_until_due - b.days_until_due)[0];
      lines.push(`✅ Nothing is overdue or due in the next 7 days! Your next due payment is **${next.name}** on **${next.next_due_date}** (${next.days_until_due} days away) for ${formatMoney(next.minimum_payment, currency)}.`);
    }
    lines.push(`\n${cashflow.overall_status === 'SUFFICIENT' ? '✅' : '⚠️'} **30-Day Cashflow Check:** ${cashflow.headline}`);
    return lines.join('\n');
  }

  const extraMatch = lower.match(/(?:(?:extra|additional|more)\s*(?:₹|\$|€|rs\.?)?\s*(\d[\d,]*)|(?:₹|\$|€|rs\.?)?\s*(\d[\d,]*)\s*(?:extra|additional|more))/i);
  const extra = extraMatch ? Number((extraMatch[1] || extraMatch[2]).replace(/,/g, '')) : 2000;
  const avalanche = simulatePayoff(enriched, 'avalanche', extra);
  const snowball = simulatePayoff(enriched, 'snowball', extra);

  if (/\b(snowball|avalanche|strategy|compare|interest|first|priority|pay off|faster|plan)\b/.test(lower)) {
    const topApr = [...enriched].sort((a, b) => b.interest_rate - a.interest_rate)[0];
    const smallest = [...enriched].sort((a, b) => a.remaining_balance - b.remaining_balance)[0];
    const saved = Math.max(0, Math.round(snowball.total_interest - avalanche.total_interest));
    return [
      `📊 **Payoff Strategy Analysis** (assuming ${formatMoney(extra, currency)}/mo extra toward debt):`,
      `- **Avalanche (saves the most money):** Focus extra money on **${topApr.name}** (${topApr.interest_rate}% APR). Debt-free in **${avalanche.months} months**, total interest **${formatMoney(avalanche.total_interest, currency)}**.`,
      `- **Snowball (quickest momentum):** Focus extra money on **${smallest.name}** (${formatMoney(smallest.remaining_balance, currency)} balance). Debt-free in **${snowball.months} months**, total interest **${formatMoney(snowball.total_interest, currency)}**.`,
      saved > 0
        ? `💡 Choosing **Avalanche** saves you approximately **${formatMoney(saved, currency)}** in interest!`
        : `💡 Both methods take a similar path right now — start with **${topApr.name}**.`,
    ].join('\n');
  }

  const next = [...enriched].sort((a, b) => a.days_until_due - b.days_until_due)[0];
  return [
    `You have **${enriched.length} active debt(s)** totaling **${formatMoney(totalDebt, currency)}**.`,
    `• Next due date: **${next.name}** on **${next.next_due_date}** — minimum ${formatMoney(next.minimum_payment, currency)}.`,
    `• 30-day cashflow: **${cashflow.headline}**`,
    `Ask me *"Will my money be sufficient this month?"*, *"What's due this week?"*, or *"Add ₹40,000 Business Income on the 18th"*.`,
  ].join('\n');
}

async function callGemini(systemPrompt, userMessage) {
  const key = (process.env.GEMINI_API_KEY || '').trim();
  if (!key) return null;
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userMessage }] }],
    }),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
}

async function callOpenAI(systemPrompt, userMessage) {
  const key = (process.env.OPENAI_API_KEY || '').trim();
  if (!key) return null;
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    }),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.choices?.[0]?.message?.content || null;
}

export async function generateAssistantReply({
  message,
  debts,
  incomes = [],
  settings,
  createdDebt = null,
  createdIncome = null,
  cashUpdated = null,
}) {
  const currency = settings?.currency || 'INR';
  if (cashUpdated !== null && cashUpdated !== undefined) {
    const cashflow = analyzeCashflow({ debts, incomes, startingCash: Number(cashUpdated), horizonDays: 30, currency });
    return {
      provider: 'built-in-parser',
      reply: `✅ Updated your **Cash on Hand** to **${formatMoney(cashUpdated, currency)}**.\n\n${cashflow.overall_status === 'SUFFICIENT' ? '✅' : '⚠️'} **Updated 30-day Cashflow:** ${cashflow.headline}`,
    };
  }
  if (createdIncome) {
    const cashflow = analyzeCashflow({ debts, incomes, startingCash: settings?.starting_cash || 0, horizonDays: 30, currency });
    return {
      provider: 'built-in-parser',
      reply: `✅ Added income source **${createdIncome.name}**:\n- Amount: **${formatMoney(createdIncome.amount, currency)}** (${createdIncome.frequency.toLowerCase()})\n- Expected date: **${createdIncome.expected_date}**\n\n${cashflow.overall_status === 'SUFFICIENT' ? '✅' : '⚠️'} **Updated 30-day Cashflow:** ${cashflow.headline}`,
    };
  }
  if (createdDebt) {
    const cashflow = analyzeCashflow({ debts, incomes, startingCash: settings?.starting_cash || 0, horizonDays: 30, currency });
    return {
      provider: 'built-in-parser',
      reply: `✅ Added **${createdDebt.name}** to your repayment tracker:\n- Balance: **${formatMoney(createdDebt.remaining_balance, currency)}** at **${createdDebt.interest_rate}% APR**\n- Minimum payment: **${formatMoney(createdDebt.minimum_payment, currency)}** (${createdDebt.frequency.toLowerCase()})\n- Next due date: **${createdDebt.next_due_date}**\n\n${cashflow.overall_status === 'SUFFICIENT' ? '✅' : '⚠️'} **Cashflow impact:** ${cashflow.headline}`,
    };
  }

  const enriched = debts.map((d) => enrichDebt(d));
  const cashflow = analyzeCashflow({ debts, incomes, startingCash: settings?.starting_cash || 0, horizonDays: 30, currency });
  const contextSummary = JSON.stringify({
    today: todayIsoDate(),
    currency,
    preferred_strategy: settings?.preferred_strategy || 'avalanche',
    starting_cash: settings?.starting_cash || 0,
    cashflow_30d: {
      overall_status: cashflow.overall_status,
      timing_gap_only: cashflow.timing_gap_only,
      total_shortfall_to_arrange: cashflow.total_shortfall_to_arrange,
      headline: cashflow.headline,
      recommendation: cashflow.recommendation,
    },
    incomes: incomes.map((i) => ({
      name: i.name,
      source_type: i.source_type,
      amount: Number(i.amount),
      expected_date: i.expected_date,
      frequency: i.frequency,
      status: i.status,
    })),
    debts: enriched.map((d) => ({
      name: d.name,
      category: d.category,
      balance: d.remaining_balance,
      apr: d.interest_rate,
      minimum_payment: d.minimum_payment,
      next_due_date: d.next_due_date,
      days_until_due: d.days_until_due,
      status: d.status,
    })),
  });

  const systemPrompt =
    `You are a concise, encouraging Debt Repayment & Cashflow AI Assistant. Today is ${todayIsoDate()}. ` +
    `Use ONLY the user's real debt, business income, and cashflow data below to answer questions about due dates, whether income covers upcoming payments or if outside funds need to be arranged, and Snowball vs Avalanche payoff advice. ` +
    `Keep answers clear, structured, and under 180 words.\n\nUser Data: ${contextSummary}`;

  try {
    const geminiText = await callGemini(systemPrompt, message);
    if (geminiText) return { provider: 'gemini', reply: geminiText.trim() };

    const openaiText = await callOpenAI(systemPrompt, message);
    if (openaiText) return { provider: 'openai', reply: openaiText.trim() };
  } catch (err) {
    console.warn('External LLM call failed, using smart built-in advisor:', err.message);
  }

  return {
    provider: 'built-in-advisor',
    reply: buildRuleBasedReply(message, debts, incomes, settings),
  };
}
