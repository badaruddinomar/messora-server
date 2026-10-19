# Messora Server

REST API for **Messora** — a multi-tenant mess management platform (meals, bazar, deposits, expenses, monthly settlement, chat, notifications).

**Stack:** Express 5 · TypeScript · Prisma 6 · PostgreSQL · Zod 4 · Brevo (email)

## Getting started

```bash
npm install
cp .env.example .env        # then fill in values
npm run db:migrate          # create tables
npm run dev                 # http://localhost:5000
```

Leave `BREVO_API_KEY` empty in development and emails (OTP codes) are printed to the console.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Start with hot reload (tsx) |
| `npm run build` / `npm start` | Compile to `dist/` and run |
| `npm run typecheck` | Type-check without emitting |
| `npm run db:migrate` | Create/apply a migration in development |
| `npm run db:deploy` | Apply migrations in production |
| `npm run db:studio` | Open Prisma Studio |

## Project structure

```
prisma/schema.prisma        # full data model
src/
  config/env.ts             # env vars validated with Zod
  lib/                      # prisma client, Brevo mailer, email templates
  middlewares/              # auth, validate (Zod), error handler
  modules/<feature>/        # *.routes / *.controller / *.service / *.schema
  utils/                    # ApiError, sendResponse, crypto helpers
```

## Auth

Sessions use a short-lived JWT access token plus a rotating refresh token (stored hashed, grouped by `familyId`; reusing an old refresh token revokes the whole family).
The web client gets both as httpOnly cookies; mobile clients can use the `accessToken` from the response body as `Authorization: Bearer` and send `refreshToken` in the body.

Responses use the shape `{ success, message, data }`; errors use `{ success: false, message, details? }`.

| Method | Path | Body |
| --- | --- | --- |
| POST | `/api/v1/auth/register` | `name, phone, email?, password` |
| POST | `/api/v1/auth/login` | `identifier` (phone or email), `password` |
| POST | `/api/v1/auth/refresh` | — (cookie) |
| POST | `/api/v1/auth/logout` | — |
| GET | `/api/v1/auth/me` | — |
| POST | `/api/v1/auth/email/send-verification` | — |
| POST | `/api/v1/auth/email/verify` | `code` |
| POST | `/api/v1/auth/password/forgot` | `email` |
| POST | `/api/v1/auth/password/reset` | `email, code, password` |

Phone numbers are normalized to E.164 (`01712345678` → `+8801712345678`).
