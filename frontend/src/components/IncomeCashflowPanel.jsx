import React, { useEffect, useState } from 'react';
import { AlertCircle, ArrowDownLeft, ArrowUpRight, Briefcase, CheckCircle2, Pause, Play, Plus, Trash2 } from 'lucide-react';
import { api, formatMoney } from '../api.js';

const emptyIncomeForm = {
  name: '',
  source_type: 'BUSINESS',
  amount: '',
  expected_date: new Date().toISOString().slice(0, 10),
  frequency: 'MONTHLY',
  reliability: 'CERTAIN',
  notes: '',
};

export default function IncomeCashflowPanel({ incomes = [], startingCash = 0, currency = 'INR', onChanged, onNotice }) {
  const [days, setDays] = useState(30);
  const [cashflow, setCashflow] = useState(null);
  const [cashInput, setCashInput] = useState(String(startingCash || 0));
  const [modal, setModal] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setCashInput(String(startingCash || 0));
  }, [startingCash]);

  const loadCashflow = async (horizon = days) => {
    try {
      const data = await api(`/cashflow?days=${horizon}`);
      setCashflow(data);
    } catch (err) {
      onNotice(err.message, 'error');
    }
  };

  useEffect(() => {
    loadCashflow(days);
  }, [days, incomes, startingCash]);

  const saveStartingCash = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/cash', { method: 'PUT', body: JSON.stringify({ starting_cash: Number(cashInput || 0) }) });
      onNotice('Available cash balance updated.', 'success');
      await onChanged();
    } catch (err) {
      onNotice(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const receiveIncome = async (inc) => {
    setBusy(true);
    try {
      const res = await api(`/incomes/${inc.id}/receive`, { method: 'POST', body: JSON.stringify({ add_to_cash: true }) });
      onNotice(res.message, 'success');
      await onChanged();
    } catch (err) {
      onNotice(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const toggleStatus = async (inc) => {
    const nextStatus = inc.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE';
    try {
      await api(`/incomes/${inc.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: nextStatus }) });
      onNotice(`${inc.name} ${nextStatus === 'ACTIVE' ? 'resumed' : 'paused'}.`, 'success');
      await onChanged();
    } catch (err) {
      onNotice(err.message, 'error');
    }
  };

  const deleteIncome = async (inc) => {
    try {
      await api(`/incomes/${inc.id}`, { method: 'DELETE' });
      onNotice(`${inc.name} deleted.`, 'success');
      await onChanged();
    } catch (err) {
      onNotice(err.message, 'error');
    }
  };

  return (
    <>
      <section className={`panel verdict-panel ${cashflow?.overall_status === 'ARRANGE_FUNDS' ? 'verdict-warn' : 'verdict-ok'}`}>
        <div className="panel-head">
          <div>
            <p className="eyebrow">INCOME VS DEBT DATE CHECK ({days} DAYS)</p>
            <h2>
              {cashflow?.overall_status === 'ARRANGE_FUNDS' ? <AlertCircle size={20} /> : <CheckCircle2 size={20} />}
              {' '}{cashflow?.headline || 'Analyzing cashflow…'}
            </h2>
          </div>
          <div className="segmented">
            {[30, 60, 90].map((d) => (
              <button key={d} type="button" className={days === d ? 'selected' : ''} onClick={() => setDays(d)}>
                {d} Days
              </button>
            ))}
          </div>
        </div>
        {cashflow && <p className="verdict-copy">{cashflow.recommendation}</p>}

        <form className="cash-inline-form" onSubmit={saveStartingCash}>
          <label>
            Current cash / bank balance available now:
            <input type="number" min="0" step="100" value={cashInput} onChange={(e) => setCashInput(e.target.value)} />
          </label>
          <button type="submit" className="secondary small" disabled={busy}>Update Cash Balance</button>
        </form>
      </section>

      {cashflow && (
        <div className="stat-grid four">
          <div className="stat-card accent-indigo">
            <span>Cash available now</span>
            <strong>{formatMoney(cashflow.starting_cash, currency)}</strong>
            <small>Starting buffer</small>
          </div>
          <div className="stat-card accent-emerald">
            <span>Expected income ({days}d)</span>
            <strong>{formatMoney(cashflow.total_projected_income, currency)}</strong>
            <small>{incomes.filter((i) => i.status === 'ACTIVE').length} active source(s)</small>
          </div>
          <div className="stat-card accent-amber">
            <span>Debt payments due ({days}d)</span>
            <strong>{formatMoney(cashflow.total_projected_debt_due, currency)}</strong>
            <small>{cashflow.debt_checks.length} scheduled payment(s)</small>
          </div>
          <div className={`stat-card ${cashflow.total_shortfall_to_arrange > 0 ? 'accent-rose' : 'accent-emerald'}`}>
            <span>Arrange from outside</span>
            <strong>{formatMoney(cashflow.total_shortfall_to_arrange, currency)}</strong>
            <small>
              {cashflow.total_shortfall_to_arrange === 0
                ? `Est. surplus: ${formatMoney(cashflow.projected_ending_balance, currency)}`
                : cashflow.timing_gap_only
                  ? 'Timing gap before income arrives'
                  : 'Net cash shortfall'}
            </small>
          </div>
        </div>
      )}

      <section className="panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">BUSINESS &amp; PERSONAL PAYOUTS</p>
            <h2><Briefcase size={18} /> Income sources</h2>
          </div>
          <button type="button" className="primary small" onClick={() => setModal({ mode: 'create', data: { ...emptyIncomeForm } })}>
            <Plus size={15} /> Add Income Source
          </button>
        </div>

        {!incomes.length ? (
          <div className="empty-box">
            No income sources added yet. Click <strong>Add Income Source</strong> (or ask the AI Assistant: <em>&quot;Add ₹45,000 Retail Business income due on the 18th&quot;</em>) to compare payout dates against debt due dates.
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Source</th><th>Category</th><th>Amount</th><th>Next Payout Date</th><th>Frequency</th><th>Actions</th></tr>
              </thead>
              <tbody>
                {incomes.map((inc) => (
                  <tr key={inc.id} className={inc.status !== 'ACTIVE' ? 'row-dim' : ''}>
                    <td>
                      <strong>{inc.name}</strong>
                      <small>{inc.reliability === 'VARIABLE' ? 'Variable estimate' : 'Expected fixed'} · {inc.status}</small>
                    </td>
                    <td>{inc.source_type}</td>
                    <td><span className="badge badge-success">{formatMoney(inc.amount, currency)}</span></td>
                    <td>
                      <div>{inc.expected_date}</div>
                      <small>{inc.days_until_income < 0 ? `${Math.abs(inc.days_until_income)}d ago` : inc.days_until_income === 0 ? 'Today' : `In ${inc.days_until_income}d`}</small>
                    </td>
                    <td>{inc.frequency}</td>
                    <td className="row-actions">
                      {inc.status === 'ACTIVE' && (
                        <button type="button" className="mini-btn primary-tint" disabled={busy} onClick={() => receiveIncome(inc)} title="Adds amount to cash on hand and advances payout date">
                          Received
                        </button>
                      )}
                      <button type="button" className="mini-btn" onClick={() => setModal({ mode: 'edit', id: inc.id, data: { ...inc, amount: String(inc.amount) } })}>Edit</button>
                      <button type="button" className="mini-btn" onClick={() => toggleStatus(inc)} title={inc.status === 'ACTIVE' ? 'Pause' : 'Resume'}>
                        {inc.status === 'ACTIVE' ? <Pause size={13} /> : <Play size={13} />}
                      </button>
                      <button type="button" className="mini-btn danger-tint" onClick={() => deleteIncome(inc)}><Trash2 size={13} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {cashflow && (
        <div className="two-col-panels">
          <section className="panel">
            <div className="panel-head">
              <div>
                <p className="eyebrow">PER-PAYMENT SUFFICIENCY</p>
                <h2>Will each due date be covered?</h2>
              </div>
            </div>
            {!cashflow.debt_checks.length ? (
              <div className="empty-box">No debt payments due in the next {days} days.</div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Due Date</th><th>Debt</th><th>Due</th><th>Verdict</th></tr></thead>
                  <tbody>
                    {cashflow.debt_checks.map((chk, idx) => (
                      <tr key={`${chk.debt_id}-${chk.due_date}-${idx}`}>
                        <td>{chk.due_date}{chk.is_overdue && <small className="text-danger">Overdue ({chk.original_due_date})</small>}</td>
                        <td><strong>{chk.name}</strong><small>Available before: {formatMoney(chk.available_before, currency)}</small></td>
                        <td>{formatMoney(chk.amount_due, currency)}</td>
                        <td>
                          {chk.status === 'COVERED' ? (
                            <span className="badge badge-success">Sufficient (left: {formatMoney(chk.balance_after, currency)})</span>
                          ) : (
                            <div>
                              <span className="badge badge-danger">Arrange {formatMoney(chk.shortfall, currency)}</span>
                              {chk.next_income_date && <small>Wait {chk.gap_days}d for {chk.next_income_name} ({chk.next_income_date})</small>}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <p className="eyebrow">CHRONOLOGICAL LEDGER</p>
                <h2>Date-by-date money flow</h2>
              </div>
            </div>
            {!cashflow.timeline.length ? (
              <div className="empty-box">Add income dates or debts to see your chronological cashflow ledger.</div>
            ) : (
              <div className="ledger-list">
                {cashflow.timeline.map((ev, i) => (
                  <div key={`${ev.type}-${ev.date}-${i}`} className={`ledger-row ${ev.type === 'INFLOW' ? 'inflow' : 'outflow'}`}>
                    <span className="ledger-icon">{ev.type === 'INFLOW' ? <ArrowDownLeft size={15} /> : <ArrowUpRight size={15} />}</span>
                    <div className="ledger-main">
                      <strong>{ev.name}</strong>
                      <small>{ev.date} · {ev.type === 'INFLOW' ? 'Money in' : 'Repayment due'}</small>
                    </div>
                    <div className="ledger-amounts">
                      <strong className={ev.type === 'INFLOW' ? 'amt-in' : 'amt-out'}>
                        {ev.type === 'INFLOW' ? '+' : '−'}{formatMoney(ev.amount, currency)}
                      </strong>
                      <small className={ev.balance_after < 0 ? 'text-danger' : ''}>
                        Bal: {ev.balance_after < 0 ? `−${formatMoney(Math.abs(ev.balance_after), currency)}` : formatMoney(ev.balance_after, currency)}
                      </small>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {modal && (
        <IncomeModal
          modal={modal}
          onClose={() => setModal(null)}
          onSaved={async (msg) => {
            setModal(null);
            onNotice(msg, 'success');
            await onChanged();
          }}
        />
      )}
    </>
  );
}

function IncomeModal({ modal, onClose, onSaved }) {
  const [form, setForm] = useState(modal.data);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const update = (e) => setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const payload = { ...form, amount: Number(form.amount) };
      if (modal.mode === 'create') {
        await api('/incomes', { method: 'POST', body: JSON.stringify(payload) });
        onSaved('Income source added to cashflow check.');
      } else {
        await api(`/incomes/${modal.id}`, { method: 'PUT', body: JSON.stringify(payload) });
        onSaved('Income source updated.');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal panel">
        <div className="panel-head">
          <h2>{modal.mode === 'create' ? 'Add income source' : 'Edit income source'}</h2>
          <button type="button" className="close-btn" onClick={onClose}>×</button>
        </div>
        <form onSubmit={submit} className="stack-form">
          <div className="two-col">
            <label>Income / Business name<input name="name" value={form.name} onChange={update} required placeholder="Retail Shop Settlement" /></label>
            <label>Type
              <select name="source_type" value={form.source_type} onChange={update}>
                <option value="BUSINESS">Business Revenue</option>
                <option value="SALARY">Salary</option>
                <option value="FREELANCE">Freelance / Client</option>
                <option value="RENTAL">Rental Income</option>
                <option value="OTHER">Other</option>
              </select>
            </label>
          </div>
          <div className="three-col">
            <label>Expected amount<input type="number" min="1" step="0.01" name="amount" value={form.amount} onChange={update} required /></label>
            <label>Expected payout date<input type="date" name="expected_date" value={form.expected_date} onChange={update} required /></label>
            <label>Frequency
              <select name="frequency" value={form.frequency} onChange={update}>
                <option value="MONTHLY">Monthly</option>
                <option value="BIWEEKLY">Biweekly</option>
                <option value="WEEKLY">Weekly</option>
                <option value="QUARTERLY">Quarterly</option>
                <option value="ONE_TIME">One-Time</option>
              </select>
            </label>
          </div>
          <div className="two-col">
            <label>Certainty
              <select name="reliability" value={form.reliability} onChange={update}>
                <option value="CERTAIN">Confirmed / Fixed</option>
                <option value="VARIABLE">Variable Estimate</option>
              </select>
            </label>
            <label>Notes<input name="notes" value={form.notes || ''} onChange={update} placeholder="Optional note" /></label>
          </div>
          {error && <div className="notice error">{error}</div>}
          <div className="modal-actions">
            <button type="button" className="secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="primary small" disabled={busy}>{busy ? 'Saving…' : 'Save Income'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
