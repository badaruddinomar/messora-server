# Backend guide

How the API is built, and the rules every module follows. Read this before adding a module.

## 1. Architecture

```
request → app.ts (helmet, cors, json, cookies, logger)
        → routes/index.ts → modules/<name>/<name>.routes.ts
        → middlewares: rate limit → requireAuth → requireMessMember → validate(zod)
        → controller (HTTP only) → service (business logic, Prisma) → response
        ↘ errors → error-handler.ts (one response shape)
```

| Layer             | May                                                                | May not                                   |
| ----------------- | ------------------------------------------------------------------ | ----------------------------------------- |
| `*.routes.ts`     | wire middlewares + controller                                      | contain logic                             |
| `*.controller.ts` | read `req`, call a service, `sendResponse`                         | touch Prisma, contain business rules      |
| `*.service.ts`    | business rules, Prisma, call other services, `audit()`, `notify()` | read `req`/`res`, set cookies             |
| `*.schema.ts`     | Zod schemas + inferred input types                                 | import Prisma or services                 |
| `lib/`, `utils/`  | generic helpers                                                    | import from `modules/`                    |
| `middlewares/`    | cross-cutting checks                                               | import from `modules/` (use `constants/`) |

Pure calculations (meal rate, splitting, settlement) go in **plain functions without Prisma** (e.g. `modules/settlement/engine.ts`), so they can be unit-tested in isolation.

## 2. Module layout

```
src/modules/<name>/
  <name>.routes.ts
  <name>.controller.ts
  <name>.service.ts
  <name>.schema.ts
  <name>.types.ts        (optional)
  <name>.test.ts         (integration tests for the routes)
```

Register the router in `src/routes/index.ts`. A mess-scoped module gets its own router created with
`Router({ mergeParams: true })` and mounted at `/messes/:messId/<module>` (before the `/messes` router), so
`requireMessMember()` can read `:messId`. Keep `messes.routes.ts` for the mess itself only.

Anything dated (meals, bazars, deposits, expenses…) finds its month with `monthForDate()` and calls
`assertMonthEditable()` before writing (`modules/months/months.service.ts`).

Planned modules: `auth`, `users`, `messes`, `members`, `invitations`, `rooms`, `months`, `meals`, `menus`, `bazars`, `deposits`, `staff`, `expenses`, `charges`, `settlement`, `funds`, `reports`, `notifications`, `notices`, `chat`, `uploads`, `audit`, `admin`.

## 3. Multi-tenancy (most important rule)

- Every mess-scoped route uses `requireMessMember()`, which sets `req.membership` (`{ id, messId, role, status }`).
- **Every Prisma query on tenant data filters by `messId` from `req.membership`**, never from the request body. Look rows up with `findFirst({ where: { id, messId } })`, not `findUnique({ where: { id } })`.
- Integration tests for every module include a "user from mess B can't read or change mess A" case.

## 4. API conventions

- Base path `/api/v1`. Resource names are plural nouns (`/messes/:messId/bazars`). Actions that aren't plain CRUD are sub-resources: `POST /bazars/:id/approve`.
- Success: `{ success: true, message, data }`. Lists: `data = { items, nextCursor }`.
- Errors: `{ success: false, code, message, details? }`. HTTP status: 400 validation · 401 not logged in · 403 not allowed · 404 not found (also for other tenants' rows, so their existence isn't leaked) · 409 conflict · 422 business rule (e.g. `MONTH_CLOSED`) · 429 rate limit.
- Pagination: cursor-based (`?cursor=<id>&limit=20`, max 100). No offset pagination on growing tables.
- Filters and sorting are query params validated with Zod.
- Money is sent as strings and dates as `YYYY-MM-DD` (`@db.Date`) or ISO timestamps.

## 5. Data & Prisma

- Change the schema only through migrations (`npm run db:migrate -- --name <change>`). Never edit an applied migration.
- Use `prisma.$transaction` for any operation that writes more than one row that must stay consistent (create mess, close month, approve with balance side effects).
- Use optimistic locking (`version`) where two managers may act at once (month close).
- `select` only the fields you need for lists. Avoid N+1 queries: use `include`/`select` or batch with `in`.
- Add an index for every new filter or sort pattern on a large table (meal entries, messages, notifications).
- Soft delete (`deletedAt`) for users and messes; hard delete elsewhere, with an audit log entry.

## 6. Validation & security

- Every route that takes input calls `validate({ body | query | params })`. Never trust `req.body` without it.
- Re-check business rules on the server even when the UI enforces them (cutoffs, roles, closed months).
- Rate-limit auth, OTP and upload routes, and anything that sends email or SMS.
- Never log passwords, tokens, OTP codes or full request bodies on auth routes.
- Secrets live only in env vars; add every new variable to `config/env.ts` and `.env.example`.

## 7. Background jobs & realtime

- **BullMQ** queues (Redis): `notifications`, `meals` (daily generation), `reminders`. Jobs must be **idempotent** (safe to run twice) and use a deterministic `jobId` where possible.
- The worker runs as a separate process (`src/worker.ts`, `npm run worker`) that shares services with the API.
  Queue names, job names and the Redis connection live in `src/jobs/queues.ts`; each job's logic is a plain
  function in `src/jobs/*.job.ts` so it can be tested without Redis.
- Schedules are registered with `queue.upsertJobScheduler(...)` when the worker starts, so restarts never duplicate
  them. `meals/generate-meals` runs hourly (each mess's midnight falls on a different UTC hour).
- Anything a job does must also happen on demand when it's missing (e.g. opening a day generates its meals), so the
  app stays correct while the worker is down.
- **Socket.IO**: authenticated with the access token; rooms `user:<id>` and `mess:<id>`. Services emit events after the database transaction commits.

## 8. Testing

| Kind        | Tool                         | What                                                                          |
| ----------- | ---------------------------- | ----------------------------------------------------------------------------- |
| Unit        | Vitest                       | pure functions: calculation engine, splitting, date math, phone normalization |
| Integration | Vitest + Supertest + test DB | every route: happy path, validation, permissions, tenant isolation            |
| Contract    | —                            | the client e2e suite (Playwright) covers the main flows end to end            |

- The settlement engine must have **100%** branch coverage, and fixtures taken from real messes.
- Each test file cleans up after itself (truncate tables between tests). Tests never depend on each other's order.

## 9. Code style

- TypeScript `strict`. No `any`; use `unknown` and narrow it.
- Function names are verbs (`approveBazar`); boolean names read as questions (`isClosed`, `canEdit`).
- Errors are thrown as `ApiError` from services; no `res.status()` outside controllers or the error handler.
- Comments explain **why**, not what. Public service functions get a one-line doc comment when the name isn't enough.
- Prettier formats; ESLint must pass with no warnings in CI.
- Commits: imperative mood (`Add bazar approval endpoint`), one logical change per commit.

## 10. PR checklist

- [ ] Lint, typecheck and tests pass locally
- [ ] New routes: validation, `requireMessMember` with the right roles, tenant-scoped queries, tests (including the permission and tenant-isolation cases)
- [ ] Schema change has a migration; new env vars are in `.env.example`
- [ ] Business-rule changes are reflected in `docs/BUSINESS_RULES.md`
- [ ] `docs/ROADMAP.md` boxes ticked (in both repos)
