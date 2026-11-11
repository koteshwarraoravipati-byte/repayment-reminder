import React, { useEffect, useState } from 'react';
import { TrendingDown, Flame, Snowflake } from 'lucide-react';
import { api, formatMoney } from '../api.js';

export default function PayoffPlanner({ currency, defaultMethod = 'avalanche', refreshKey }) {
  const [method, setMethod] = useState(defaultMethod);
  const [extra, setExtra] = useState(2000);
  const [plan, setPlan] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api(`/strategy?method=${method}&extra=${extra}`)
      .then(setPlan)
      .catch((e) => setError(e.message));
  }, [method, extra, refreshKey]);

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <p className="eyebrow">OPTIMIZATION ENGINE</p>
          <h2><TrendingDown size={18} /> Payoff strategy planner</h2>
        </div>
        <div className="segmented">
          <button type="button" className={method === 'avalanche' ? 'selected' : ''} onClick={() => setMethod('avalanche')}>
            <Flame size={14} /> Avalanche (Highest APR)
          </button>
          <button type="button" className={method === 'snowball' ? 'selected' : ''} onClick={() => setMethod('snowball')}>
            <Snowflake size={14} /> Snowball (Smallest First)
          </button>
        </div>
      </div>

      <div className="strategy-controls">
        <label>
          Extra monthly payment above minimums: <strong>{formatMoney(extra, currency)}/mo</strong>
          <input
            type="range"
            min="0"
            max="30000"
            step="500"
            value={extra}
            onChange={(e) => setExtra(Number(e.target.value))}
          />
        </label>
        <input
          type="number"
          min="0"
          step="500"
          className="extra-input"
          value={extra}
          onChange={(e) => setExtra(Math.max(0, Number(e.target.value) || 0))}
        />
      </div>

      {error && <div className="notice error">{error}</div>}
      {plan && (
        <>
          <div className="stat-grid three">
            <div className="stat-card accent-indigo">
              <span>Debt-free timeline</span>
              <strong>{plan.selected.months} months</strong>
              <small>{plan.months_saved_vs_baseline > 0 ? `${plan.months_saved_vs_baseline} mo faster than minimums` : 'At minimum payments'}</small>
            </div>
            <div className="stat-card accent-emerald">
              <span>Total interest paid</span>
              <strong>{formatMoney(plan.selected.total_interest, currency)}</strong>
              <small>Saved {formatMoney(plan.interest_saved_vs_baseline, currency)} vs minimums</small>
            </div>
            <div className="stat-card accent-amber">
              <span>Vs {method === 'avalanche' ? 'Snowball' : 'Avalanche'}</span>
              <strong>{formatMoney(Math.abs(plan.alternative.total_interest - plan.selected.total_interest), currency)}</strong>
              <small>{plan.selected.total_interest <= plan.alternative.total_interest ? 'Interest saved with this pick' : 'Extra interest for quicker wins'}</small>
            </div>
          </div>

          <div className="payoff-order">
            <h3>Recommended payoff sequence</h3>
            {!plan.selected.payoff_order.length ? (
              <p className="muted">No active debts with positive balance.</p>
            ) : (
              <ol className="order-list">
                {plan.selected.payoff_order.map((item, index) => (
                  <li key={item.id}>
                    <span className="step-num">{index + 1}</span>
                    <div>
                      <strong>{item.name}</strong>
                      <small>{item.apr}% APR</small>
                    </div>
                    <span className="badge badge-ok">Paid off in month {item.month_paid_off}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </>
      )}
    </section>
  );
}
