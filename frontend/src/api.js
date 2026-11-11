const API_BASE = (import.meta.env.VITE_API_URL || '/api').replace(/\/+$/, '');
const TOKEN_KEY = 'debtguard_token';

let unauthorizedHandler = null;

export function getToken() {
  try {
    return window.localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

export function setToken(token) {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Ignore storage quota / privacy mode errors
  }
}

export function setUnauthorizedHandler(fn) {
  unauthorizedHandler = fn;
}

export async function api(path, options = {}) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15000);
  const token = getToken();
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  let res;
  try {
    res = await fetch(`${API_BASE}${normalizedPath}`, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers || {}),
      },
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Request timed out. Please try again.');
    throw new Error('Could not reach the DebtGuard backend server.');
  } finally {
    window.clearTimeout(timeout);
  }

  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }
  if (!res.ok) {
    if (res.status === 401 && !normalizedPath.startsWith('/auth/') && unauthorizedHandler) {
      setToken('');
      unauthorizedHandler();
    }
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

export function formatMoney(amount, currency = 'INR') {
  const symbol = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : '₹';
  return `${symbol}${Math.round(Number(amount || 0)).toLocaleString('en-IN')}`;
}

export function urgencyMeta(urgency, daysLeft) {
  if (urgency === 'OVERDUE') return { label: `${Math.abs(daysLeft)}d overdue`, cls: 'badge-danger' };
  if (urgency === 'DUE_TODAY') return { label: 'Due today', cls: 'badge-warn' };
  if (urgency === 'DUE_SOON') return { label: `In ${daysLeft}d`, cls: 'badge-amber' };
  if (urgency === 'PAID_OFF') return { label: 'Paid off', cls: 'badge-success' };
  if (urgency === 'ARCHIVED') return { label: 'Archived', cls: 'badge-muted' };
  return { label: `In ${daysLeft}d`, cls: 'badge-ok' };
}
