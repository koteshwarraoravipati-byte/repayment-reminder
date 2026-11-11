import React, { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Calendar as CalendarIcon, CheckCircle2 } from 'lucide-react';
import { formatMoney, urgencyMeta } from '../api.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default function CalendarPanel({ debts = [], incomes = [], currency, today, onPay }) {
  const [cursor, setCursor] = useState(() => {
    const [y, m] = (today || new Date().toISOString().slice(0, 10)).split('-').map(Number);
    return { year: y, month: m - 1 };
  });
  const [selectedDay, setSelectedDay] = useState(today);

  const monthLabel = useMemo(
    () => new Date(Date.UTC(cursor.year, cursor.month, 1)).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    [cursor]
  );

  const debtsByDate = useMemo(() => {
    const map = {};
    for (const d of debts) {
      if (d.status === 'ARCHIVED') continue;
      if (!map[d.next_due_date]) map[d.next_due_date] = [];
      map[d.next_due_date].push(d);
    }
    return map;
  }, [debts]);

  const incomesByDate = useMemo(() => {
    const map = {};
    for (const inc of incomes) {
      if (inc.status !== 'ACTIVE') continue;
      if (!map[inc.expected_date]) map[inc.expected_date] = [];
      map[inc.expected_date].push(inc);
    }
    return map;
  }, [incomes]);

  const cells = useMemo(() => {
    const firstDay = new Date(Date.UTC(cursor.year, cursor.month, 1)).getUTCDay();
    const daysInMonth = new Date(Date.UTC(cursor.year, cursor.month + 1, 0)).getUTCDate();
    const list = [];
    for (let i = 0; i < firstDay; i++) list.push(null);
    for (let day = 1; day <= daysInMonth; day++) {
      const iso = `${cursor.year}-${String(cursor.month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      list.push({ day, iso, items: debtsByDate[iso] || [], incomeItems: incomesByDate[iso] || [] });
    }
    return list;
  }, [cursor, debtsByDate, incomesByDate]);

  const shiftMonth = (delta) => {
    setCursor((prev) => {
      const dt = new Date(Date.UTC(prev.year, prev.month + delta, 1));
      return { year: dt.getUTCFullYear(), month: dt.getUTCMonth() };
    });
  };

  const selectedItems = debtsByDate[selectedDay] || [];
  const selectedIncomes = incomesByDate[selectedDay] || [];

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <p className="eyebrow">INCOME &amp; REPAYMENT SCHEDULE</p>
          <h2><CalendarIcon size={18} /> Cashflow calendar</h2>
        </div>
        <div className="cal-nav">
          <button type="button" className="icon-btn" onClick={() => shiftMonth(-1)} aria-label="Previous month"><ChevronLeft size={16} /></button>
          <strong>{monthLabel}</strong>
          <button type="button" className="icon-btn" onClick={() => shiftMonth(1)} aria-label="Next month"><ChevronRight size={16} /></button>
        </div>
      </div>

      <div className="cal-grid">
        {WEEKDAYS.map((w) => <div key={w} className="cal-weekday">{w}</div>)}
        {cells.map((cell, idx) => {
          if (!cell) return <div key={`empty-${idx}`} className="cal-cell empty" />;
          const isToday = cell.iso === today;
          const isSelected = cell.iso === selectedDay;
          const combinedCount = cell.incomeItems.length + cell.items.length;
          return (
            <button
              type="button"
              key={cell.iso}
              onClick={() => setSelectedDay(cell.iso)}
              className={`cal-cell ${isToday ? 'today' : ''} ${isSelected ? 'selected' : ''}`}
            >
              <span className="cal-day">{cell.day}</span>
              <div className="cal-dots">
                {cell.incomeItems.slice(0, 2).map((inc) => (
                  <span key={`inc-${inc.id}`} className="cal-pill badge-success" title={`Income: ${inc.name} (+${formatMoney(inc.amount, currency)})`}>
                    +{inc.name}
                  </span>
                ))}
                {cell.items.slice(0, 2).map((d) => {
                  const meta = urgencyMeta(d.urgency, d.days_until_due);
                  return <span key={`debt-${d.id}`} className={`cal-pill ${meta.cls}`} title={`Due: ${d.name} (${formatMoney(d.minimum_payment, currency)})`}>{d.name}</span>;
                })}
                {combinedCount > 4 && <span className="cal-more">+{combinedCount - 4}</span>}
              </div>
            </button>
          );
        })}
      </div>

      <div className="cal-detail">
        <div className="cal-detail-head">
          <strong>Scheduled for {selectedDay}</strong>
          <span>{selectedIncomes.length} income · {selectedItems.length} {selectedItems.length === 1 ? 'debt' : 'debts'}</span>
        </div>
        {!selectedItems.length && !selectedIncomes.length ? (
          <p className="muted small-note">No income payouts or debt due dates on this date. Select a highlighted date to inspect.</p>
        ) : (
          <div className="cal-list">
            {selectedIncomes.map((inc) => (
              <div key={`inc-detail-${inc.id}`} className="cal-item cal-item-income">
                <div>
                  <strong>+ {inc.name}</strong>
                  <small>{inc.source_type} · Expected payout · {inc.frequency.toLowerCase()}</small>
                </div>
                <span className="badge badge-success">+{formatMoney(inc.amount, currency)}</span>
              </div>
            ))}
            {selectedItems.map((d) => {
              const meta = urgencyMeta(d.urgency, d.days_until_due);
              return (
                <div key={d.id} className="cal-item">
                  <div>
                    <strong>{d.name}</strong>
                    <small>{d.lender || d.category} · Min {formatMoney(d.minimum_payment, currency)} · Balance {formatMoney(d.remaining_balance, currency)}</small>
                  </div>
                  <div className="cal-item-actions">
                    <span className={`badge ${meta.cls}`}>{meta.label}</span>
                    {d.status === 'ACTIVE' && d.remaining_balance > 0 && (
                      <button type="button" className="mini-btn primary-tint" onClick={() => onPay(d)}>
                        <CheckCircle2 size={14} /> Pay
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
