import crypto from 'node:crypto';
import nodemailer from 'nodemailer';

function jwtSecret() {
  return (process.env.JWT_SECRET || 'debtguard-dev-secret-change-in-production').trim();
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, keyHex] = stored.split(':');
  const derived = crypto.scryptSync(String(password), salt, 64);
  const storedBuf = Buffer.from(keyHex, 'hex');
  if (derived.length !== storedBuf.length) return false;
  return crypto.timingSafeEqual(derived, storedBuf);
}

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

export function signToken(user, expiresSeconds = 60 * 60 * 24 * 7) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({
      sub: user.id,
      email: user.email,
      name: user.name,
      exp: Math.floor(Date.now() / 1000) + expiresSeconds,
    })
  );
  const sig = crypto.createHmac('sha256', jwtSecret()).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts;
  const expected = crypto.createHmac('sha256', jwtSecret()).update(`${header}.${payload}`).digest();
  const actual = Buffer.from(sig, 'base64url');
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!decoded.sub || (decoded.exp && decoded.exp < Math.floor(Date.now() / 1000))) return null;
    return decoded;
  } catch {
    return null;
  }
}

export function generateOtp() {
  return String(crypto.randomInt(100000, 1000000));
}

export function hashOtp(userId, otp) {
  return crypto.createHmac('sha256', jwtSecret()).update(`${userId}:${otp}`).digest('hex');
}

export function smtpConfigured(customSender = null) {
  if (customSender) return true;
  const user = (process.env.SMTP_USERNAME || '').trim();
  const pass = (process.env.SMTP_PASSWORD || '').trim();
  return Boolean(user && pass);
}

export async function sendOtpEmail(recipient, otp, expiryMinutes = 10, customSender = null) {
  if (/[\r\n]/.test(recipient)) throw new Error('Invalid recipient email');
  if (customSender) {
    await customSender(recipient, otp, expiryMinutes);
    return;
  }

  const host = (process.env.SMTP_HOST || 'smtp.gmail.com').trim();
  const port = Number(process.env.SMTP_PORT || 587);
  const user = (process.env.SMTP_USERNAME || '').trim();
  let pass = (process.env.SMTP_PASSWORD || '').trim();
  if (host.toLowerCase() === 'smtp.gmail.com') {
    pass = pass.replace(/\s+/g, '');
  }
  const from = (process.env.SMTP_FROM_EMAIL || user).trim();

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });

  await transporter.sendMail({
    from,
    to: recipient,
    subject: `DebtGuard AI Password Reset OTP: ${otp}`,
    text: `Your DebtGuard AI password reset OTP is ${otp}. It expires in ${expiryMinutes} minutes. If you did not request this, please ignore this email.`,
    html: `<div style="font-family:sans-serif;max-width:480px;margin:auto;padding:24px;border:1px solid #e6e9f2;border-radius:14px;">
      <h2 style="color:#4f46e5;margin:0 0 10px;">DebtGuard AI Password Reset</h2>
      <p style="color:#4e5368;">Use this 6-digit verification code to reset your password:</p>
      <div style="font-size:32px;font-weight:700;letter-spacing:8px;text-align:center;background:#eef0ff;color:#4f46e5;padding:16px;border-radius:10px;margin:20px 0;">${otp}</div>
      <p style="color:#71768c;font-size:13px;">This code expires in <strong>${expiryMinutes} minutes</strong> and can only be used once.</p>
    </div>`,
  });
}
