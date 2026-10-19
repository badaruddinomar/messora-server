# Messora Server

REST API for **Messora** — a multi-tenant mess management platform (meals, bazar, deposits, expenses, monthly settlement, chat, notifications).

**Stack:** Express 5 · TypeScript · Prisma 6 · PostgreSQL · Zod 4 · Brevo (email)

**Docs:** [Roadmap](docs/ROADMAP.md) · [Business rules](docs/BUSINESS_RULES.md) · [Backend guide](docs/BACKEND_GUIDE.md)

## Getting started

```bash
npm install
cp .env.example .env        # then fill in values
npm run db:migrate          # create tables
npm run dev                 # http://localhost:5000
```

Leave `BREVO_API_KEY` empty in development and emails (OTP codes) are printed to the console.

### Tests

Tests run against a separate database (`messora_test` on the same local Postgres by default; override it with `TEST_DATABASE_URL`).
Migrations are applied automatically, and every table is emptied before each test.

```bash
npm test                 # run once
npm run test:watch       # watch mode
npm run test:coverage    # with a coverage report
```

## Scripts

| Script                        | What it does                            |
| ----------------------------- | --------------------------------------- |
| `npm run dev`                 | Start with hot reload (tsx)             |
| `npm run build` / `npm start` | Compile to `dist/` and run              |
| `npm run typecheck`           | Type-check without emitting             |
| `npm run lint` / `format`     | ESLint / Prettier                       |
| `npm test`                    | Unit + integration tests (Vitest)       |
| `npm run db:migrate`          | Create/apply a migration in development |
| `npm run db:deploy`           | Apply migrations in production          |
| `npm run db:studio`           | Open Prisma Studio                      |

## Project structure

```
prisma/
  schema.prisma             # full data model
  migrations/
src/
  server.ts                 # starts the HTTP server, graceful shutdown
  app.ts                    # express app: global middlewares, routes, error handler
  config/env.ts             # env vars validated with Zod
  constants/                # API prefix, cookie names, ...
  routes/index.ts           # mounts every module router under /api/v1
  lib/
    prisma.ts               # Prisma client (+ DbClient type for transactions)
    logger.ts               # pino logger
    mail/                   # Brevo mailer + email templates
    audit.ts, notify.ts     # audit log + in-app notifications
  middlewares/              # requireAuth, requireMessMember (tenant), validate, rate limit, errors
  modules/
    auth/
      auth.routes.ts        # endpoints + per-route middlewares
      auth.controller.ts    # HTTP layer: read req, call service, send response
      auth.service.ts       # business logic + database access
      auth.schema.ts        # Zod request schemas
      auth.types.ts         # module types
      auth.cookies.ts       # auth cookie helpers
      auth.otp.ts           # one-time codes (issue / verify)
  types/express.d.ts        # req.user / req.membership typing
  utils/                    # ApiError, money (Decimal + splitting), dates (mess timezone), pagination
  test/                     # test setup and factories
```

**Adding a module** (e.g. `mess`): create `src/modules/mess/` with `mess.routes.ts`, `mess.controller.ts`,
`mess.service.ts` and `mess.schema.ts`, then register it in `src/routes/index.ts`.

## Auth

Sessions use a short-lived JWT access token plus a rotating refresh token (stored hashed, grouped by `familyId`; reusing an old refresh token revokes the whole family).
The web client gets both as httpOnly cookies; mobile clients can use the `accessToken` from the response body as `Authorization: Bearer` and send `refreshToken` in the body.

Responses use the shape `{ success, message, data }`; errors use `{ success: false, code, message, details? }`, where `code` is a stable machine-readable value from `src/constants/error-codes.ts`.

| Method | Path                                   | Body                                      |
| ------ | -------------------------------------- | ----------------------------------------- |
| POST   | `/api/v1/auth/register`                | `name, phone, email?, password`           |
| POST   | `/api/v1/auth/login`                   | `identifier` (phone or email), `password` |
| POST   | `/api/v1/auth/refresh`                 | — (cookie)                                |
| POST   | `/api/v1/auth/logout`                  | —                                         |
| GET    | `/api/v1/auth/me`                      | —                                         |
| POST   | `/api/v1/auth/email/send-verification` | —                                         |
| POST   | `/api/v1/auth/email/verify`            | `code`                                    |
| POST   | `/api/v1/auth/password/forgot`         | `email`                                   |
| POST   | `/api/v1/auth/password/reset`          | `email, code, password`                   |

Phone numbers are normalized to E.164 (`01712345678` → `+8801712345678`).
