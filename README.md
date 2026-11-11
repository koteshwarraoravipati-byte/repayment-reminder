# DebtGuard AI — Debt Repayment & Cashflow Assistant

Full-stack debt repayment, business income vs. cashflow sufficiency, and automated reminder assistant built with React, Node.js/Express, SQLite, and Neon PostgreSQL.

## Live deployment
- Frontend: https://repayment-reminder.vercel.app/
- API health: https://repayment-reminder-api.vercel.app/api/health
- Source repository: https://github.com/koteshwarraoravipati-byte/REPAYMENT-REMINDER

## Stack
- **Frontend:** React + Vite dashboard, authentication screens (Sign In / Create Account / OTP Forgot Password), interactive due-date calendar, payoff planner, browser `Notification` alerts, and AI Copilot panel
- **Backend:** Node.js (Express) REST API + `node-cron` daily reminder scheduler + Vercel serverless functions
- **Local database:** Built-in SQLite (`node:sqlite` at `backend/data/debts.db`) for zero-setup development
- **Production database:** Neon PostgreSQL (`pg` + `backend/schema.sql`) via `DATABASE_URL`
- **AI Assistant:** Supports Google Gemini (`GEMINI_API_KEY`) or OpenAI (`OPENAI_API_KEY`), with a built-in natural-language parser and deterministic advisor fallback

## Key features
- Account authentication with salted `scrypt` passwords, JWT sessions, first-user legacy data claim, and 6-digit OTP password reset via Google SMTP
- Priority queue of upcoming & overdue debts with one-click **Mark Paid** and **Delete** confirmation
- Business income source tracking and date-by-date 30-day cashflow sufficiency analysis (flags timing gaps and exact shortfall amounts to arrange)
- **Avalanche vs. Snowball** payoff comparison simulator
- Automated scheduled due-date reminders (`/api/cron/reminders`) with optional email alerts and persistent AI chat history

## Database Tables
- `users` — registered user accounts and hashed credentials
- `password_reset_otps` — expiring 6-digit HMAC-hashed OTP codes for password recovery
- `debts` — per-user accounts, balances, APRs, minimum payments, due dates, recurrence (`MONTHLY`, `BIWEEKLY`, `WEEKLY`, `QUARTERLY`, `ONE_TIME`), and status (`ACTIVE`, `PAID_OFF`, `ARCHIVED`)
- `incomes` — business payouts and recurring/one-time income sources with expected dates and reliability
- `payments` — recorded repayments that automatically deduct balances and advance `next_due_date`
- `reminders` — deduplicated scheduled alerts (`UNREAD` / `ACKNOWLEDGED`)
- `reminder_settings` — per-user lead days (`7,3,1,0`), cron expression, starting cash, currency, preferred strategy, and notification preferences
- `chat_messages` — per-user persistent AI conversation history

## Run Locally

### 1. Backend (API + Database + Daily Cron Scheduler)
```bash
cd backend
npm install
npm run seed      # Optional: adds sample debts
npm test          # Runs automated API, auth, cashflow, payoff, and AI tests
npm start         # Runs on http://127.0.0.1:4000
```

### 2. Frontend (Dashboard + Calendar + Cashflow + Auth)
```bash
cd frontend
npm install
npm run dev       # Runs on http://localhost:5174 (proxies /api -> 127.0.0.1:4000)
```

## Production Environment Variables
- `DATABASE_URL=postgresql://...` — PostgreSQL connection string (Neon / Supabase)
- `JWT_SECRET=...` — signing secret for authentication tokens
- `CORS_ORIGIN=https://repayment-reminder.vercel.app` — allowed frontend origin
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD` — Gmail SMTP + App Password for OTP password reset & email alerts
- `GEMINI_API_KEY` or `OPENAI_API_KEY` (optional) — external LLM provider for chat
