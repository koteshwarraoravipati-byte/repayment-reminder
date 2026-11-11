import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  ArrowUpDown,
  Bell,
  BellRing,
  CalendarClock,
  CheckCheck,
  CheckCircle2,
  CreditCard,
  LayoutDashboard,
  LogOut,
  Plus,
  RefreshCw,
  Settings,
  Trash2,
  TrendingDown,
  Wallet,
} from 'lucide-react';
import { api, formatMoney, getToken, setToken, setUnauthorizedHandler, urgencyMeta } from './api.js';
import CalendarPanel from './components/CalendarPanel.jsx';
import AiAssistantPanel from './components/AiAssistantPanel.jsx';
import PayoffPlanner from './components/PayoffPlanner.jsx';
import IncomeCashflowPanel from './components/IncomeCashflowPanel.jsx';
import AuthScreen from './components/AuthScreen.jsx';

const emptyDebtForm = {
  name: '',
  lender: '',
  category: 'CREDIT_CARD',
  principal_amount: '',
  remaining_balance: '',
  interest_rate: '18',
  minimum_payment: '',
  next_due_date: new Date().toISOString().slice(0, 10),
  frequency: 'MONTHLY',
  auto_pay: false,
  notes: '',
};

export default function App() {
  const [authChecking, setAuthChecking] = useState(true);
  const [user, setUser] = useState(null);
  const [tab, setTab] = useState('overview');
  const [dashboard, setDashboard] = useState(null);
  const [reminders, setReminders] = useState([]);
  const [payments, setPayments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState({ text: '', kind: 'success' });
  const [debtFilter, setDebtFilter] = useState('ACTIVE');
  const [formModal, setFormModal] = useState(null);
  const [payModal, setPayModal] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [notifPerm, setNotifPerm] = useState(
    typeof Notification !== 'undefined' ? Notification.permission : 'unsupported'
  );
  const [refreshKey, setRefreshKey] = useState(0);
  const notifiedIds = useRef(new Set());

  const showNotice = (text, kind = 'success') => setNotice({ text, kind });

  const handleLogout = useCallback((message = '') => {
    setToken('');
    setUser(null);
    setDashboard(null);
    setReminders([]);
    setPayments([]);
    setLoading(true);
    if (message) setNotice({ text: message, kind: 'error' });
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      handleLogout('Your session expired. Please sign in again.');
    });
    return () => setUnauthorizedHandler(null);
  }, [handleLogout]);

  useEffect(() => {
    let active = true;
    const token = getToken();
    if (!token) {
      setAuthChecking(false);
      return undefined;
    }
    api('/auth/me')
      .then((data) => {
        if (active) setUser(data.user);
      })
      .catch(() => {
        if (active) {
          setToken('');
          setUser(null);
        }
      })
      .finally(() => {
        if (active) setAuthChecking(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const fireBrowserNotifications = useCallback((unreadList, enabled) => {
    if (!enabled || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    for (const r of unreadList) {
      if (notifiedIds.current.has(r.id)) continue;
      notifiedIds.current.add(r.id);
      try {
        new Notification(r.title, { body: r.message, tag: `debt-rem-${r.id}` });
      } catch {
        // Ignore browser-specific notification constructor restrictions
      }
    }
  }, []);

  const loadAll = useCallback(async () => {
    try {
      const [dashData, remData, payData] = await Promise.all([
        api('/dashboard'),
        api('/reminders'),
        api('/payments'),
      ]);
      setDashboard(dashData);
      setReminders(remData.reminders || []);
      setPayments(payData.payments || []);
      setRefreshKey((k) => k + 1);
      fireBrowserNotifications(
        dashData.unread_reminders || [],
        dashData.settings?.browser_notifications
      );
    } catch (err) {
      showNotice(err.message, 'error');
    } finally {
      setLoading(false);
    }
  }, [fireBrowserNotifications]);

  useEffect(() => {
    if (!user) return undefined;
    setLoading(true);
    loadAll();
    const timer = window.setInterval(loadAll, 60000);
    return () => window.clearInterval(timer);
  }, [user, loadAll]);

  const requestNotifications = async () => {
    if (typeof Notification === 'undefined') {
      return showNotice('Browser notifications are not supported in this browser.', 'error');
    }
    const perm = await Notification.requestPermission();
    setNotifPerm(perm);
    if (perm === 'granted') {
      showNotice('Browser notifications enabled! You will be alerted on due dates.', 'success');
      if (dashboard?.unread_reminders?.length) {
        fireBrowserNotifications(dashboard.unread_reminders, true);
      }
    } else {
      showNotice('Browser notification permission was denied.', 'error');
    }
  };

  const runReminderCheck = async () => {
    try {
      const res = await api('/reminders/run', { method: 'POST' });
      showNotice(
        res.created_count > 0
          ? `Generated ${res.created_count} new reminder alert(s).`
          : 'Checked all active debts — all due alerts are already up to date.',
        'success'
      );
      await loadAll();
    } catch (err) {
      showNotice(err.message, 'error');
    }
  };

  const ackReminder = async (id) => {
    try {
      await api(`/reminders/${id}/ack`, { method: 'PATCH' });
      await loadAll();
    } catch (err) {
      showNotice(err.message, 'error');
    }
  };

  const ackAllReminders = async () => {
    try {
      await api('/reminders/ack-all', { method: 'PATCH' });
      showNotice('All reminders marked as read.', 'success');
      await loadAll();
    } catch (err) {
      showNotice(err.message, 'error');
    }
  };

  const toggleArchive = async (debt) => {
    const nextStatus = debt.status === 'ARCHIVED' ? 'ACTIVE' : 'ARCHIVED';
    try {
      await api(`/debts/${debt.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: nextStatus }),
      });
      showNotice(nextStatus === 'ARCHIVED' ? `${debt.name} archived (soft deleted).` : `${debt.name} restored to active.`, 'success');
      await loadAll();
    } catch (err) {
      showNotice(err.message, 'error');
    }
  };

  const confirmHardDelete = async () => {
    if (!deleteTarget) return;
    try {
      await api(`/debts/${deleteTarget.id}`, { method: 'DELETE' });
      showNotice(`${deleteTarget.name} permanently deleted.`, 'success');
      setDeleteTarget(null);
      await loadAll();
    } catch (err) {
      showNotice(err.message, 'error');
    }
  };

  if (authChecking) {
    return <div className="loading-screen">Checking session…</div>;
  }

  if (!user) {
    return (
      <AuthScreen
        onAuthenticated={(authedUser, welcomeMsg) => {
          setUser(authedUser);
          if (welcomeMsg) showNotice(welcomeMsg, 'success');
        }}
      />
    );
  }

  if (loading || !dashboard) {
    return <div className="loading-screen">Loading DebtGuard AI…</div>;
  }

  const { summary, debts, incomes = [], cashflow, settings } = dashboard;
  const currency = settings?.currency || 'INR';
  const filteredDebts = debts.filter((d) => (debtFilter === 'ALL' ? true : d.status === debtFilter));
  const urgentDebts = debts.filter((d) => d.status === 'ACTIVE' && (d.urgency === 'OVERDUE' || d.urgency === 'DUE_TODAY' || d.urgency === 'DUE_SOON'));

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-badge"><Wallet size={20} /></div>
          <div>
            <h1>DebtGuard AI</h1>
            <p>Smart Debt Repayment &amp; Reminder Copilot</p>
          </div>
        </div>

        <nav className="top-nav">
          {[
            ['overview', 'Overview & Calendar', LayoutDashboard],
            ['cashflow', 'Income & Cashflow', ArrowUpDown],
            ['debts', 'Debts & Payments', CreditCard],
            ['planner', 'Payoff Planner', TrendingDown],
            ['reminders', `Reminders${summary.unread_reminders_count ? ` (${summary.unread_reminders_count})` : ''}`, Bell],
          ].map(([id, label, Icon]) => (
            <button key={id} type="button" className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
              <Icon size={16} />
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <div className="top-actions">
          {notifPerm !== 'granted' && notifPerm !== 'unsupported' && (
            <button type="button" className="secondary small" onClick={requestNotifications}>
              <BellRing size={15} /> Enable Browser Alerts
            </button>
          )}
          <button type="button" className="primary small" onClick={() => setFormModal({ mode: 'create', data: { ...emptyDebtForm } })}>
            <Plus size={15} /> Add Debt
          </button>
          <span className="user-pill" title={user.email}>{user.name}</span>
          <button type="button" className="secondary small" onClick={() => handleLogout('')}>
            <LogOut size={15} /> Sign Out
          </button>
        </div>
      </header>

      {notice.text && (
        <div className={`banner-notice ${notice.kind === 'error' ? 'error' : 'success'}`}>
          <span>{notice.text}</span>
          <button type="button" onClick={() => setNotice({ text: '', kind: 'success' })}>×</button>
        </div>
      )}

      {urgentDebts.length > 0 && (
        <div className="urgent-strip">
          <CalendarClock size={18} />
          <div>
            <strong>{urgentDebts.length} urgent repayment{urgentDebts.length > 1 ? 's' : ''}:</strong>{' '}
            {urgentDebts.slice(0, 3).map((d) => `${d.name} (${d.next_due_date})`).join(' · ')}
          </div>
          <button type="button" className="mini-btn" onClick={() => setTab('reminders')}>View Alerts</button>
        </div>
      )}

      {cashflow && (
        <div className={`cashflow-banner ${cashflow.overall_status === 'ARRANGE_FUNDS' ? 'warn' : 'ok'}`}>
          <div className="cashflow-banner-copy">
            <strong>{cashflow.overall_status === 'ARRANGE_FUNDS' ? '⚠️ ' : '✅ '}{cashflow.headline}</strong>
            <span>{cashflow.recommendation}</span>
          </div>
          <button type="button" className="secondary small" onClick={() => setTab('cashflow')}>
            {incomes.length ? 'Check Cashflow Dates' : '+ Add Business Income'}
          </button>
        </div>
      )}

      <div className="workspace-grid">
        <main className="main-col">
          {tab === 'overview' && (
            <>
              <div className="stat-grid four">
                <div className="stat-card accent-indigo">
                  <span>Total remaining debt</span>
                  <strong>{formatMoney(summary.total_remaining_debt, currency)}</strong>
                  <small>{summary.active_count} active account(s)</small>
                </div>
                <div className="stat-card accent-emerald">
                  <span>30d expected income</span>
                  <strong>{formatMoney(summary.projected_30d_income || 0, currency)}</strong>
                  <small>{incomes.filter((i) => i.status === 'ACTIVE').length} income source(s)</small>
                </div>
                <div className="stat-card accent-amber">
                  <span>Due within 7 days</span>
                  <strong>{summary.due_this_week_count}</strong>
                  <small>Next reminder check active</small>
                </div>
                <div className={`stat-card ${summary.shortfall_to_arrange > 0 ? 'accent-rose' : 'accent-emerald'}`}>
                  <span>Need from outside</span>
                  <strong>{formatMoney(summary.shortfall_to_arrange || 0, currency)}</strong>
                  <small>{summary.shortfall_to_arrange > 0 ? 'Shortfall detected' : 'Covered by cash & income'}</small>
                </div>
              </div>

              <CalendarPanel
                debts={debts}
                incomes={incomes}
                currency={currency}
                today={summary.today}
                onPay={(debt) => setPayModal({ debt, amount: String(debt.minimum_payment || debt.remaining_balance), paid_on: summary.today, note: '' })}
              />

              <section className="panel">
                <div className="panel-head">
                  <div>
                    <p className="eyebrow">PRIORITY QUEUE</p>
                    <h2>Upcoming due dates</h2>
                  </div>
                  <button type="button" className="secondary small" onClick={loadAll}><RefreshCw size={14} /> Refresh</button>
                </div>
                {!debts.filter((d) => d.status === 'ACTIVE').length ? (
                  <div className="empty-box">No active debts! Click <strong>Add Debt</strong> or ask the AI Assistant to track your first repayment.</div>
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr><th>Debt</th><th>Due date</th><th>Status</th><th>Minimum</th><th>Remaining</th><th>Action</th></tr>
                      </thead>
                      <tbody>
                        {debts.filter((d) => d.status === 'ACTIVE').map((d) => {
                          const meta = urgencyMeta(d.urgency, d.days_until_due);
                          return (
                            <tr key={d.id}>
                              <td><strong>{d.name}</strong><small>{d.lender || d.category} · {d.interest_rate}% APR</small></td>
                              <td>{d.next_due_date}</td>
                              <td><span className={`badge ${meta.cls}`}>{meta.label}</span></td>
                              <td>{formatMoney(d.minimum_payment, currency)}</td>
                              <td><strong>{formatMoney(d.remaining_balance, currency)}</strong></td>
                              <td className="row-actions">
                                <button type="button" className="mini-btn primary-tint" onClick={() => setPayModal({ debt: d, amount: String(d.minimum_payment || d.remaining_balance), paid_on: summary.today, note: '' })}>
                                  <CheckCircle2 size={14} /> Mark Paid
                                </button>
                                <button type="button" className="mini-btn danger-tint" title="Delete Debt" onClick={() => setDeleteTarget(d)}>
                                  <Trash2 size={13} /> Delete
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </>
          )}

          {tab === 'cashflow' && (
            <IncomeCashflowPanel
              incomes={incomes}
              startingCash={summary.starting_cash || 0}
              currency={currency}
              onChanged={loadAll}
              onNotice={showNotice}
            />
          )}

          {tab === 'debts' && (
            <>
              <section className="panel">
                <div className="panel-head">
                  <div>
                    <p className="eyebrow">PORTFOLIO</p>
                    <h2>All tracked debts</h2>
                  </div>
                  <div className="segmented">
                    {['ACTIVE', 'PAID_OFF', 'ARCHIVED', 'ALL'].map((st) => (
                      <button key={st} type="button" className={debtFilter === st ? 'selected' : ''} onClick={() => setDebtFilter(st)}>
                        {st === 'PAID_OFF' ? 'Paid Off' : st.charAt(0) + st.slice(1).toLowerCase()}
                      </button>
                    ))}
                  </div>
                </div>

                {!filteredDebts.length ? (
                  <div className="empty-box">No debts in this category.</div>
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr><th>Account</th><th>Category</th><th>APR</th><th>Min Due</th><th>Remaining</th><th>Next Due</th><th>Actions</th></tr>
                      </thead>
                      <tbody>
                        {filteredDebts.map((d) => {
                          const meta = urgencyMeta(d.urgency, d.days_until_due);
                          return (
                            <tr key={d.id} className={d.status === 'ARCHIVED' ? 'row-dim' : ''}>
                              <td>
                                <strong>{d.name}</strong>
                                <small>{d.lender || 'No lender'} · {d.frequency.toLowerCase()}</small>
                              </td>
                              <td>{d.category.replace('_', ' ')}</td>
                              <td>{d.interest_rate}%</td>
                              <td>{formatMoney(d.minimum_payment, currency)}</td>
                              <td>
                                <strong>{formatMoney(d.remaining_balance, currency)}</strong>
                                <small>of {formatMoney(d.principal_amount, currency)}</small>
                              </td>
                              <td>
                                <div>{d.next_due_date}</div>
                                <span className={`badge ${meta.cls}`}>{meta.label}</span>
                              </td>
                              <td className="row-actions">
                                {d.status === 'ACTIVE' && (
                                  <button type="button" className="mini-btn primary-tint" onClick={() => setPayModal({ debt: d, amount: String(d.minimum_payment || d.remaining_balance), paid_on: summary.today, note: '' })}>Pay</button>
                                )}
                                <button type="button" className="mini-btn" onClick={() => setFormModal({ mode: 'edit', id: d.id, data: { ...d, principal_amount: String(d.principal_amount), remaining_balance: String(d.remaining_balance), interest_rate: String(d.interest_rate), minimum_payment: String(d.minimum_payment) } })}>Edit</button>
                                <button type="button" className="mini-btn" onClick={() => toggleArchive(d)} title="Soft delete / Archive">
                                  <Archive size={13} /> {d.status === 'ARCHIVED' ? 'Restore' : 'Archive'}
                                </button>
                                <button type="button" className="mini-btn danger-tint" onClick={() => setDeleteTarget(d)} title="Hard delete">
                                  <Trash2 size={13} />
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              <section className="panel">
                <div className="panel-head">
                  <div>
                    <p className="eyebrow">HISTORY</p>
                    <h2>Recent payments</h2>
                  </div>
                </div>
                {!payments.length ? (
                  <div className="empty-box">No payments recorded yet.</div>
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead><tr><th>Date</th><th>Debt</th><th>Amount Paid</th><th>Note</th></tr></thead>
                      <tbody>
                        {payments.map((p) => (
                          <tr key={p.id}>
                            <td>{p.paid_on}</td>
                            <td><strong>{p.debt_name}</strong></td>
                            <td><span className="badge badge-success">{formatMoney(p.amount, currency)}</span></td>
                            <td>{p.note || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </>
          )}

          {tab === 'planner' && (
            <PayoffPlanner
              currency={currency}
              defaultMethod={settings?.preferred_strategy || 'avalanche'}
              refreshKey={refreshKey}
            />
          )}

          {tab === 'reminders' && (
            <>
              <section className="panel">
                <div className="panel-head">
                  <div>
                    <p className="eyebrow">AUTOMATED ALERTS</p>
                    <h2><Bell size={18} /> Reminder inbox</h2>
                  </div>
                  <div className="row-actions">
                    <button type="button" className="secondary small" onClick={runReminderCheck}><RefreshCw size={14} /> Run Check Now</button>
                    {reminders.some((r) => r.status === 'UNREAD') && (
                      <button type="button" className="primary small" onClick={ackAllReminders}><CheckCheck size={14} /> Mark All Read</button>
                    )}
                  </div>
                </div>

                {!reminders.length ? (
                  <div className="empty-box">No reminders triggered yet. Add a debt due soon or click <strong>Run Check Now</strong>.</div>
                ) : (
                  <div className="reminder-list">
                    {reminders.map((r) => (
                      <div key={r.id} className={`reminder-card ${r.status === 'UNREAD' ? 'unread' : ''}`}>
                        <div>
                          <div className="reminder-title">
                            <strong>{r.title}</strong>
                            <span className={`badge ${r.status === 'UNREAD' ? 'badge-warn' : 'badge-muted'}`}>{r.status}</span>
                          </div>
                          <p>{r.message}</p>
                          <small>Channel: {r.channel} · Due date: {r.due_date}</small>
                        </div>
                        {r.status === 'UNREAD' && (
                          <button type="button" className="mini-btn" onClick={() => ackReminder(r.id)}>Dismiss</button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <SettingsPanel settings={settings} onSaved={async () => { showNotice('Reminder preferences updated.', 'success'); await loadAll(); }} onError={(m) => showNotice(m, 'error')} />
            </>
          )}
        </main>

        <AiAssistantPanel onDataChanged={loadAll} />
      </div>

      {formModal && (
        <DebtModal
          modal={formModal}
          onClose={() => setFormModal(null)}
          onSaved={async (msg) => {
            setFormModal(null);
            showNotice(msg, 'success');
            await loadAll();
          }}
        />
      )}

      {payModal && (
        <PaymentModal
          modal={payModal}
          currency={currency}
          onClose={() => setPayModal(null)}
          onSaved={async (msg) => {
            setPayModal(null);
            showNotice(msg, 'success');
            await loadAll();
          }}
        />
      )}

      {deleteTarget && (
        <div className="modal-backdrop">
          <div className="modal panel delete-modal">
            <div className="delete-icon"><AlertTriangle size={28} /></div>
            <h2>Permanently delete debt?</h2>
            <p className="muted">You are about to permanently delete <strong>{deleteTarget.name}</strong> and its payment &amp; reminder history.</p>
            <div className="modal-actions">
              <button type="button" className="secondary" onClick={() => setDeleteTarget(null)}>Cancel</button>
              <button type="button" className="danger-btn" onClick={confirmHardDelete}>Yes, delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DebtModal({ modal, onClose, onSaved }) {
  const [form, setForm] = useState(modal.data);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const update = (e) => {
    const val = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setForm((prev) => ({ ...prev, [e.target.name]: val }));
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const payload = {
        ...form,
        principal_amount: Number(form.principal_amount),
        remaining_balance: form.remaining_balance === '' ? Number(form.principal_amount) : Number(form.remaining_balance),
        interest_rate: Number(form.interest_rate || 0),
        minimum_payment: Number(form.minimum_payment || 0),
      };
      if (modal.mode === 'create') {
        await api('/debts', { method: 'POST', body: JSON.stringify(payload) });
        onSaved('Debt created and added to reminder schedule.');
      } else {
        await api(`/debts/${modal.id}`, { method: 'PUT', body: JSON.stringify(payload) });
        onSaved('Debt updated successfully.');
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
          <h2>{modal.mode === 'create' ? 'Add debt' : 'Edit debt'}</h2>
          <button type="button" className="close-btn" onClick={onClose}>×</button>
        </div>
        <form onSubmit={submit} className="stack-form">
          <div className="two-col">
            <label>Debt name<input name="name" value={form.name} onChange={update} required placeholder="HDFC Credit Card" /></label>
            <label>Lender<input name="lender" value={form.lender} onChange={update} placeholder="HDFC Bank" /></label>
          </div>
          <div className="two-col">
            <label>Category
              <select name="category" value={form.category} onChange={update}>
                <option value="CREDIT_CARD">Credit Card</option>
                <option value="STUDENT_LOAN">Education Loan</option>
                <option value="PERSONAL_LOAN">Personal Loan</option>
                <option value="AUTO_LOAN">Auto / Bike EMI</option>
                <option value="MORTGAGE">Home / Mortgage</option>
                <option value="OTHER">Other</option>
              </select>
            </label>
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
            <label>Original principal<input type="number" min="1" step="0.01" name="principal_amount" value={form.principal_amount} onChange={update} required /></label>
            <label>Remaining balance<input type="number" min="0" step="0.01" name="remaining_balance" value={form.remaining_balance} onChange={update} placeholder="Same as principal" /></label>
          </div>
          <div className="three-col">
            <label>Interest APR (%)<input type="number" min="0" step="0.1" name="interest_rate" value={form.interest_rate} onChange={update} /></label>
            <label>Min payment<input type="number" min="0" step="0.01" name="minimum_payment" value={form.minimum_payment} onChange={update} /></label>
            <label>Next due date<input type="date" name="next_due_date" value={form.next_due_date} onChange={update} required /></label>
          </div>
          <label className="checkbox-row">
            <input type="checkbox" name="auto_pay" checked={Boolean(form.auto_pay)} onChange={update} />
            <span>Auto-pay enabled</span>
          </label>
          <label>Notes<input name="notes" value={form.notes || ''} onChange={update} placeholder="Optional reminder note" /></label>
          {error && <div className="notice error">{error}</div>}
          <div className="modal-actions">
            <button type="button" className="secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="primary small" disabled={busy}>{busy ? 'Saving…' : 'Save Debt'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function PaymentModal({ modal, currency, onClose, onSaved }) {
  const [amount, setAmount] = useState(modal.amount);
  const [paidOn, setPaidOn] = useState(modal.paid_on);
  const [note, setNote] = useState(modal.note);
  const [advanceCycle, setAdvanceCycle] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await api(`/debts/${modal.debt.id}/pay`, {
        method: 'POST',
        body: JSON.stringify({ amount: Number(amount), paid_on: paidOn, note, advance_cycle: advanceCycle }),
      });
      onSaved(res.message);
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
          <h2>Record payment — {modal.debt.name}</h2>
          <button type="button" className="close-btn" onClick={onClose}>×</button>
        </div>
        <p className="muted small-note">Remaining balance: {formatMoney(modal.debt.remaining_balance, currency)} · Current due date: {modal.debt.next_due_date}</p>
        <form onSubmit={submit} className="stack-form">
          <div className="two-col">
            <label>Payment amount<input type="number" min="1" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required /></label>
            <label>Paid on<input type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} required /></label>
          </div>
          <label>Note<input value={note} onChange={(e) => setNote(e.target.value)} placeholder="UPI / Netbanking ref" /></label>
          {modal.debt.frequency !== 'ONE_TIME' && (
            <label className="checkbox-row">
              <input type="checkbox" checked={advanceCycle} onChange={(e) => setAdvanceCycle(e.target.checked)} />
              <span>Automatically advance next due date by 1 {modal.debt.frequency.toLowerCase()} cycle</span>
            </label>
          )}
          {error && <div className="notice error">{error}</div>}
          <div className="modal-actions">
            <button type="button" className="secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="primary small" disabled={busy}>{busy ? 'Saving…' : 'Confirm Payment'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function SettingsPanel({ settings, onSaved, onError }) {
  const [form, setForm] = useState(settings || {});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (settings) setForm(settings);
  }, [settings]);

  const update = (e) => {
    const val = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setForm((prev) => ({ ...prev, [e.target.name]: val }));
  };

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/settings', { method: 'PUT', body: JSON.stringify(form) });
      await onSaved();
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <p className="eyebrow">SCHEDULER &amp; ALERTS</p>
          <h2><Settings size={18} /> Reminder preferences</h2>
        </div>
      </div>
      <form onSubmit={save} className="stack-form">
        <div className="three-col">
          <label>Remind days before due<input name="lead_days" value={form.lead_days || ''} onChange={update} placeholder="7,3,1,0" required /></label>
          <label>Daily cron schedule<input name="daily_cron" value={form.daily_cron || ''} onChange={update} placeholder="0 9 * * *" required /></label>
          <label>Currency
            <select name="currency" value={form.currency || 'INR'} onChange={update}>
              <option value="INR">INR (₹)</option>
              <option value="USD">USD ($)</option>
              <option value="EUR">EUR (€)</option>
            </select>
          </label>
        </div>
        <div className="two-col">
          <label>Preferred payoff strategy
            <select name="preferred_strategy" value={form.preferred_strategy || 'avalanche'} onChange={update}>
              <option value="avalanche">Avalanche (Highest APR first)</option>
              <option value="snowball">Snowball (Smallest balance first)</option>
            </select>
          </label>
          <label>Optional email recipient<input type="email" name="reminder_email" value={form.reminder_email || ''} onChange={update} placeholder="you@gmail.com" /></label>
        </div>
        <div className="two-col">
          <label className="checkbox-row"><input type="checkbox" name="browser_notifications" checked={Boolean(form.browser_notifications)} onChange={update} /><span>Show browser/desktop notifications</span></label>
          <label className="checkbox-row"><input type="checkbox" name="email_enabled" checked={Boolean(form.email_enabled)} onChange={update} /><span>Send email reminders (requires SMTP env)</span></label>
        </div>
        <button type="submit" className="primary small" disabled={busy}>{busy ? 'Saving…' : 'Save Preferences'}</button>
      </form>
    </section>
  );
}
