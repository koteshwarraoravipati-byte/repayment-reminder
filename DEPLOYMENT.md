# Deploying DebtGuard AI to Production

## Option A: Vercel (Backend + Frontend) + Supabase/Neon PostgreSQL

1. **PostgreSQL Database (Free Tier):**
   - Create a PostgreSQL database on Supabase or Neon and copy the `postgresql://...` connection URL.
   - *(Optional)* You can run `backend/schema.sql` manually, or let `backend/api/index.js` create the tables automatically on its first request.

2. **Deploy Backend on Vercel:**
   - Import `koteshwarraoravipati-byte/repayment-reminder` in Vercel with **Root Directory** = `backend`.
   - Set environment variables:
     - `DATABASE_URL` = your PostgreSQL connection string
     - `JWT_SECRET` = strong random secret for JWT session tokens & OTP hashing
     - `CORS_ORIGIN` = your deployed frontend URL (e.g. `https://repayment-reminder.vercel.app`)
     - *(Optional)* `GEMINI_API_KEY` or `OPENAI_API_KEY` for LLM chat
     - *(Optional)* `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD` for email reminders
     - *(Optional)* `CRON_SECRET` to protect `/api/cron/reminders` (Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`)
   - `backend/vercel.json` runs the daily reminder sweep automatically at `0 3 * * *` UTC (08:30 AM IST).

3. **Deploy Frontend on Vercel:**
   - Import the same repo in Vercel as a second project with **Root Directory** = `frontend` (Framework: Vite).
   - Set environment variable:
     - `VITE_API_URL` = `https://<your-backend-vercel-domain>/api`

## Option B: Render Blueprint (`render.yaml`)
- Connect the repo to Render using Blueprints (`render.yaml`) to provision the Node server (with persistent `node-cron`) + managed PostgreSQL automatically, then deploy `frontend/` as a Static Site with `VITE_API_URL`.
