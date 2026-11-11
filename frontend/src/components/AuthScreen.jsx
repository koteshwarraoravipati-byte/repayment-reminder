import React, { useState } from 'react';
import { ArrowLeft, KeyRound, Lock, Mail, ShieldCheck, User } from 'lucide-react';
import { api, setToken } from '../api';

export default function AuthScreen({ onAuthenticated }) {
  const [mode, setMode] = useState('login'); // 'login' | 'register' | 'forgot' | 'reset'
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const switchMode = (nextMode, { keepNotice = false } = {}) => {
    setMode(nextMode);
    setError('');
    if (!keepNotice) setNotice('');
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    setError('');
    setNotice('');
    setBusy(true);
    try {
      const data = await api('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: email.trim(), password }),
      });
      setToken(data.token);
      onAuthenticated(data.user, '');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleRegister = async (e) => {
    e.preventDefault();
    setError('');
    setNotice('');
    if (password.length < 6) {
      setError('Password must be at least 6 characters long.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      const data = await api('/auth/register', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim(), email: email.trim(), password }),
      });
      setToken(data.token);
      const welcome = data.claimed_legacy_data
        ? 'Account created and linked to your existing debts & cashflow records.'
        : 'Welcome to DebtGuard AI!';
      onAuthenticated(data.user, welcome);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleSendOtp = async (e) => {
    if (e) e.preventDefault();
    setError('');
    setNotice('');
    setBusy(true);
    try {
      const data = await api('/auth/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ email: email.trim() }),
      });
      setNotice(data.message || 'Verification OTP sent to your email.');
      setMode('reset');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleResetPassword = async (e) => {
    e.preventDefault();
    setError('');
    setNotice('');
    if (!/^\d{6}$/.test(otp.trim())) {
      setError('Please enter the 6-digit OTP code from your email.');
      return;
    }
    if (password.length < 6) {
      setError('New password must be at least 6 characters long.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      const data = await api('/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({
          email: email.trim(),
          otp: otp.trim(),
          new_password: password,
        }),
      });
      setOtp('');
      setPassword('');
      setConfirmPassword('');
      setNotice(data.message || 'Password updated successfully. You can now sign in.');
      switchMode('login', { keepNotice: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-shell">
      <div className="auth-hero">
        <div className="auth-brand">
          <div className="brand-badge">
            <ShieldCheck size={22} />
          </div>
          <div>
            <h1>DebtGuard AI</h1>
            <p>Repayment &amp; Cashflow Copilot</p>
          </div>
        </div>
        <h2>Stay ahead of every due date and cashflow gap.</h2>
        <p className="auth-lead">
          Track EMIs, cards, and business income timelines in one place — get early alerts when incoming business payouts arrive after a due date.
        </p>
        <ul className="auth-points">
          <li>Priority queue sorted by overdue &amp; urgent due dates</li>
          <li>Income-vs-debt coverage &amp; exact shortage warnings</li>
          <li>Snowball vs. Avalanche payoff planner &amp; AI copilot</li>
        </ul>
      </div>

      <div className="auth-card">
        <div className="auth-tabs" role="tablist">
          <button
            type="button"
            className={`auth-tab ${mode === 'login' ? 'active' : ''}`}
            onClick={() => switchMode('login')}
          >
            Sign In
          </button>
          <button
            type="button"
            className={`auth-tab ${mode === 'register' ? 'active' : ''}`}
            onClick={() => switchMode('register')}
          >
            Create Account
          </button>
        </div>

        {error && <div className="auth-alert error">{error}</div>}
        {notice && <div className="auth-alert success">{notice}</div>}

        {mode === 'login' && (
          <form className="auth-form" onSubmit={handleLogin}>
            <div className="auth-heading">
              <h3>Welcome back</h3>
              <p>Sign in to access your repayment dashboard.</p>
            </div>
            <label>
              Email Address
              <div className="input-icon">
                <Mail size={16} />
                <input
                  type="email"
                  required
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
            </label>
            <label>
              Password
              <div className="input-icon">
                <Lock size={16} />
                <input
                  type="password"
                  required
                  autoComplete="current-password"
                  placeholder="Enter your password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
            </label>
            <div className="auth-links">
              <button type="button" className="text-link" onClick={() => switchMode('forgot')}>
                Forgot password?
              </button>
            </div>
            <button type="submit" className="primary auth-submit" disabled={busy}>
              {busy ? 'Signing in...' : 'Sign In'}
            </button>
          </form>
        )}

        {mode === 'register' && (
          <form className="auth-form" onSubmit={handleRegister}>
            <div className="auth-heading">
              <h3>Create your account</h3>
              <p>Protect your debts and business income records with a private login.</p>
            </div>
            <label>
              Full Name
              <div className="input-icon">
                <User size={16} />
                <input
                  type="text"
                  required
                  autoComplete="name"
                  placeholder="Koteshwar Rao"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
            </label>
            <label>
              Email Address
              <div className="input-icon">
                <Mail size={16} />
                <input
                  type="email"
                  required
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
            </label>
            <label>
              Password (min 6 characters)
              <div className="input-icon">
                <Lock size={16} />
                <input
                  type="password"
                  required
                  autoComplete="new-password"
                  placeholder="Create a password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
            </label>
            <label>
              Confirm Password
              <div className="input-icon">
                <Lock size={16} />
                <input
                  type="password"
                  required
                  autoComplete="new-password"
                  placeholder="Repeat your password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                />
              </div>
            </label>
            <button type="submit" className="primary auth-submit" disabled={busy}>
              {busy ? 'Creating account...' : 'Create Account'}
            </button>
          </form>
        )}

        {mode === 'forgot' && (
          <form className="auth-form" onSubmit={handleSendOtp}>
            <div className="auth-heading">
              <h3>Forgot password?</h3>
              <p>Enter your registered email and we will send a 6-digit OTP code via Google SMTP.</p>
            </div>
            <label>
              Registered Email
              <div className="input-icon">
                <Mail size={16} />
                <input
                  type="email"
                  required
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
            </label>
            <button type="submit" className="primary auth-submit" disabled={busy}>
              {busy ? 'Sending OTP...' : 'Send 6-Digit OTP'}
            </button>
            <div className="auth-links between">
              <button type="button" className="text-link inline-icon" onClick={() => switchMode('login')}>
                <ArrowLeft size={14} /> Back to Sign In
              </button>
              <button type="button" className="text-link" onClick={() => switchMode('reset')}>
                Already have an OTP?
              </button>
            </div>
          </form>
        )}

        {mode === 'reset' && (
          <form className="auth-form" onSubmit={handleResetPassword}>
            <div className="auth-heading">
              <h3>Reset password with OTP</h3>
              <p>Enter the 6-digit OTP sent to <strong>{email || 'your email'}</strong> and choose a new password.</p>
            </div>
            <label>
              Email Address
              <div className="input-icon">
                <Mail size={16} />
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
            </label>
            <label>
              6-Digit OTP Code
              <div className="input-icon">
                <KeyRound size={16} />
                <input
                  type="text"
                  required
                  maxLength={6}
                  inputMode="numeric"
                  placeholder="123456"
                  value={otp}
                  onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                />
              </div>
            </label>
            <label>
              New Password (min 6 characters)
              <div className="input-icon">
                <Lock size={16} />
                <input
                  type="password"
                  required
                  autoComplete="new-password"
                  placeholder="New password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
            </label>
            <label>
              Confirm New Password
              <div className="input-icon">
                <Lock size={16} />
                <input
                  type="password"
                  required
                  autoComplete="new-password"
                  placeholder="Repeat new password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                />
              </div>
            </label>
            <button type="submit" className="primary auth-submit" disabled={busy}>
              {busy ? 'Resetting password...' : 'Reset Password'}
            </button>
            <div className="auth-links between">
              <button type="button" className="text-link inline-icon" onClick={() => switchMode('login')}>
                <ArrowLeft size={14} /> Back to Sign In
              </button>
              <button type="button" className="text-link" disabled={busy} onClick={handleSendOtp}>
                Resend OTP
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
