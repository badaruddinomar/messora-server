# Messora — Roadmap to v1.0

> This file is mirrored in **messora-server/docs** and **messora-client/docs**. When you tick a box or change a phase, update both copies.

**Goal:** a complete, production-ready mess management platform. A mess can run its entire month in Messora: meals, bazar, deposits, shared bills, closing, settlement, and talking to each other. The UI should feel premium and consistent, and the code should be well-tested and easy to extend.

**How to use this plan**

- Work through the phases **in order**. Each phase depends on the ones before it (mess → month → money entries → month close).
- A phase is done only when every item in its **Done when** list holds. That includes tests and the UI polish rules in `DESIGN_SYSTEM.md`.
- Each phase ships as one or more PRs per repo. Keep PRs small: one module or one screen at a time.
- Where things live:
  - **messora-server/docs:** `BUSINESS_RULES.md` (calculations and permissions), `BACKEND_GUIDE.md`
  - **messora-client/docs:** `DESIGN_SYSTEM.md` (UI), `FRONTEND_GUIDE.md`

**Legend:** ✅ done · 🔜 next · ⬜ not started

---

## Overview

| #   | Phase                                            | Status |
| --- | ------------------------------------------------ | ------ |
| 0   | Project setup & authentication                   | ✅     |
| 1   | Engineering foundations & design system          | ✅     |
| 2   | Mess & membership                                | ✅     |
| 3   | Billing months                                   | ✅     |
| 4   | Meals & daily menu                               | 🔜     |
| 5   | Bazar (groceries)                                | ⬜     |
| 6   | Deposits                                         | ⬜     |
| 7   | Rooms, staff, shared expenses & charges          | ⬜     |
| 8   | Month close & settlement                         | ⬜     |
| 9   | Dashboards & reports                             | ⬜     |
| 10  | Notifications & notice board                     | ⬜     |
| 11  | Chat                                             | ⬜     |
| 12  | Account, profile & phone verification            | ⬜     |
| 13  | Audit log & super admin                          | ⬜     |
| 14  | Bangla/English, PWA, accessibility & performance | ⬜     |
| 15  | Hardening & launch                               | ⬜     |

---

## Phase 0 — Project setup & authentication ✅

- [x] Express 5 + TypeScript + Prisma + PostgreSQL project, Zod-validated env
- [x] Full Prisma schema + initial migration
- [x] Auth: register (phone, optional email), login by phone or email, rotating refresh-token families, logout, `me`
- [x] Email verification and password reset with 6-digit codes via Brevo
- [x] Next.js 16 client: Redux store, RTK Query with automatic token refresh, nuqs, React Hook Form + Zod
- [x] Auth pages, route guards, dashboard shell
- [x] Feature-based folder structure in both repos

---

## Phase 1 — Engineering foundations & design system ✅

Build the shared building blocks **before** features, so every later screen and module is consistent from day one.

### Backend

- [x] ESLint (typescript-eslint) + Prettier, `npm run lint` / `format`
- [x] Structured logging with **pino** (+ `pino-http`): request id per request, no secrets in logs
- [x] **Vitest + Supertest**, separate test database, factories for users/messes, `npm test`
- [x] Shared helpers:
  - [x] Cursor pagination (`paginationQuery`, `cursorArgs`, `toPage`) (`?cursor=&limit=`) with a standard `{ items, nextCursor }` response
  - [x] Money helpers on `Prisma.Decimal`; never JavaScript floats (see BUSINESS_RULES §1)
  - [x] Date helpers that respect the mess timezone (`Asia/Dhaka` by default): "today" for a mess, `@db.Date` conversion
  - [x] Decimal and Date serialization: money as strings in JSON (Decimal `toJSON`), dates as `YYYY-MM-DD` (`fromDbDate()` in module responses)
- [x] **Tenant middleware** `requireMessMember({ roles?, allowMonthManager? })`: loads the membership for `:messId`, rejects non-members and inactive members, sets `req.membership`
- [x] `audit()` helper that writes `AuditLog` rows (used from Phase 2 on)
- [x] `notify()` service that writes in-app `Notification` rows (delivery channels come in Phase 10)
- [x] Error codes: add a machine-readable `code` (e.g. `MONTH_CLOSED`, `NOT_A_MEMBER`) next to `message`
- [x] GitHub Actions CI: lint, typecheck, test (with a Postgres service), build

### Frontend

- [x] Install the **design system** (see DESIGN_SYSTEM.md): shadcn/ui on Radix, lucide-react icons, sonner toasts, next-themes (light/dark), motion for animation
- [x] Replace the hand-made `Button`, `Field`, `Alert`, `Spinner` with design-system components; restyle the auth pages with them
- [x] Design tokens in `globals.css`: colors, radius, shadows, spacing; light and dark
- [x] **App shell**: desktop sidebar, mobile bottom navigation, top bar with mess switcher, user menu and notification bell
- [x] Shared building blocks: `PageHeader`, `EmptyState`, `ErrorState`, skeleton loaders, `DataTable` (TanStack Table), `ConfirmDialog`, `StatCard`, `MoneyText`, `DatePicker`, `FormField` wrappers for React Hook Form
- [x] Formatting helpers: `formatMoney` (৳ BDT), `formatDate` and relative time (date-fns)
- [x] RTK Query conventions: tag types, a `messUrl(messId, path)` URL helper, global error toasts for 5xx and network errors
- [x] ESLint + Prettier (with the Tailwind class-sorting plugin), Vitest + Testing Library, Playwright e2e (port the current auth flow test)
- [x] GitHub Actions CI: lint, typecheck, unit tests, build
- [ ] Run the Playwright e2e suite in CI too (needs the API + a database in the client workflow; do it in Phase 15 at the latest)

**Done when:** CI is green in both repos; the auth pages and app shell use only design-system components, in both light and dark mode, at 360 px and desktop widths; the tenant middleware and helpers have tests.

---

## Phase 2 — Mess & membership ✅

### Backend

- [x] `POST /messes`: create a mess. In **one transaction**, also create `MessSetting`, the ADMIN `MessMember`, default meal slots (Breakfast 0.5, Lunch 1, Dinner 1), the `MESS_GROUP` conversation and the first `MessMonth`. Generate a unique `slug` and `joinCode`.
- [x] `GET /messes` (my messes), `GET/PATCH /messes/:messId`, `DELETE` (ADMIN only; soft delete)
- [x] `GET/PATCH /messes/:messId/settings`
- [x] Join by code: `POST /messes/join { joinCode }` creates a `PENDING` member and notifies admins and managers
- [x] `POST /messes/:messId/members/:memberId/approve | reject`
- [x] Invitations: `POST /messes/:messId/invitations` (phone or email; email sent via Brevo), accept, decline, revoke, expiry
- [x] Members: list (filter by status), change role (ADMIN only; a mess must always keep at least one ADMIN), suspend, remove, leave (`leftAt`, `leaveReason`)
- [x] `POST /messes/:messId/join-code` (regenerate)
- [x] Audit log and notifications for joins, approvals and role changes
- [x] Tests: permission matrix per endpoint (see BUSINESS_RULES §2), the last-admin guard, duplicate joins

### Frontend

- [x] Onboarding after first login: **Create a mess** or **Join with a code**
- [x] Create-mess wizard: name, address, gender, month start day, meal slots
- [x] Mess switcher. The active mess lives in the URL (`/m/[slug]/…`), so links can be shared and the page survives a refresh.
- [x] Members page: tabs for Active, Requests, Invited and Left; approve or reject; role menu; invite dialog; join code with copy and share buttons
- [x] Mess settings page
- [x] `useCurrentMess()` and `useMessPermissions()` hooks for hiding or disabling actions by role
- [x] Invitation landing page (`/invite/[token]`) that works before login, and invitations sent to your phone/email listed in the app

**Done when:** a user can create a mess, invite or approve another user, and both can see the mess; every mutation is checked against its role; there are empty, loading and error states everywhere.

---

## Phase 3 — Billing months ✅

### Backend

- [x] Month lifecycle: `OPEN → CLOSING → CLOSED` (BUSINESS_RULES §3). Months open by themselves; an ended month stays OPEN until closed, and months close in order (the close/reopen endpoints come with Phase 8)
- [x] Month dates follow `monthStartDay` (1–28), including bridging months when the start day changes
- [x] `GET /messes/:messId/months`, `/months/current`, `/months/:monthId`, `PATCH /months/:monthId/manager`
- [x] `monthForDate()` + `assertMonthEditable()` guards for every money and meal mutation (`MONTH_CLOSED`, `DATE_OUTSIDE_MONTHS`)
- [x] Tests: date math across month and year boundaries, start days such as 5 → 4, every start-day change, mess timezone

### Frontend

- [x] Month picker shared by every money and meal screen (`<MonthPicker>` + `useSelectedMonth()`, stored in the URL: `?month=2026-10`)
- [x] Month status badge ("Waiting to close" for ended months); `<MonthReadOnlyBanner>` + `isMonthEditable()` for read-only screens
- [x] Months page with the current month, months waiting to close, history, and month manager assignment (ADMIN)

**Done when:** months are created correctly for any start day, and edits to a non-OPEN month are rejected by the API and disabled in the UI.

---

## Phase 4 — Meals & daily menu 🔜

### Backend

- [ ] Meal slots CRUD (name, weight, cutoff time, order, active)
- [ ] Meal entries:
  - [ ] `GET /messes/:messId/meals?date=` (one day, all members) and `?from=&to=&memberId=` (range)
  - [ ] `PUT /meals` bulk upsert `{ memberId, slotId, date, quantity, guestQuantity, note }`
  - [ ] Members can edit their own meals before the slot cutoff; managers can edit anyone's (BUSINESS_RULES §4)
- [ ] Generate entries **idempotently** (upsert on `memberId+slotId+date`):
  - [ ] a daily job (BullMQ + Redis) creates tomorrow's entries from `defaultMealOn` and `MealOffPeriod`
  - [ ] generate on demand when a day is opened, so a missed job never shows an empty day
- [ ] Meal off periods: create, list, delete (also zero any existing future entries)
- [ ] Meal requests: create, respond (manager), list
- [ ] Daily menu: upsert per date and slot; `MENU_POSTED` notification
- [ ] Notify the member when a manager changes their meals (`MEAL_UPDATED_BY_MANAGER`)
- [ ] Tests: cutoff in the mess timezone, generation idempotency, off periods

### Frontend

- [ ] **My meals** (mobile first): today's slots as large toggles with guest +/−, a countdown to each cutoff, and optimistic updates with rollback on error
- [ ] **Meal sheet** (manager): members × slots grid for one day, keyboard friendly, sticky header, live totals per slot
- [ ] Monthly calendar view of a member's meals with totals
- [ ] Meal-off dialog (date range + reason), meal requests list, today's menu card and menu editor

**Done when:** toggling a meal feels instant on a phone; the cutoff rules hold on both server and client; the day and month totals match the database.

---

## Phase 5 — Bazar (groceries)

### Backend

- [ ] File uploads (receipts first; reused for avatars and chat later): presigned uploads to object storage (see Open decisions), size and type limits
- [ ] Bazar duty schedule: generate a rotation for the month, swap duties, mark done; reminder job (`BAZAR_DUTY_REMINDER`)
- [ ] Bazar CRUD with items (`totalAmount` = sum of item prices, checked on the server), `paidFrom`, receipt
- [ ] Approval flow: PENDING → APPROVED / REJECTED with a reason. When `requireBazarApproval` is off, entries are auto-approved.
- [ ] Only the shopper or a manager can edit, and only while PENDING (managers can always edit)
- [ ] Tests: totals, approval permissions, closed-month guard

### Frontend

- [ ] Add-bazar form with dynamic item rows (name, quantity, unit, price), a running total and a receipt photo (camera on mobile)
- [ ] Bazar list with filters (status, shopper, date) kept in the URL with nuqs, and month totals
- [ ] Approval queue for managers (approve or reject with a reason)
- [ ] Duty calendar

**Done when:** a member can submit a bazar with a receipt from a phone in under 30 seconds, and a manager can approve it from the queue.

---

## Phase 6 — Deposits

### Backend

- [ ] Deposits: a member submits (amount, method such as bKash/Nagad/cash, transaction ref), a manager approves or rejects; managers can also record a deposit directly as APPROVED
- [ ] `requireDepositApproval` setting, notifications, audit log
- [ ] Tests

### Frontend

- [ ] Deposit form, "My deposits" history, manager approval queue, per-member deposit totals for the month

**Done when:** approved deposits show up immediately in the member's balance preview (Phase 8 makes it final).

---

## Phase 7 — Rooms, staff, shared expenses & charges

### Backend

- [ ] Rooms & seats CRUD, assign or unassign a member to a seat, monthly rent
- [ ] Staff CRUD (cook, maid, …) with monthly salary
- [ ] Shared expenses: category, amount, split type `EQUAL | BY_MEAL | CUSTOM`, `paidFrom`, receipt. For `CUSTOM`, the shares must add up to the amount exactly.
- [ ] Salary shortcut: "Pay staff" creates a `SharedExpense` linked to `staffId`
- [ ] Member charges: seat rent (prorated, BUSINESS_RULES §6), fine, personal, adjustment (can be negative)
- [ ] Tests: split rounding (shares always add up to the total), proration

### Frontend

- [ ] Rooms & seats board, staff list, expense form with a live split preview, and a charges list
- [ ] Expense breakdown by category

**Done when:** every cost type that feeds the month close can be entered and edited.

---

## Phase 8 — Month close & settlement ⭐ (the core of the product)

### Backend

- [ ] A **calculation engine** as pure, framework-free functions (`modules/settlement/engine.ts`) that implements BUSINESS_RULES §5–§8 exactly
  - [ ] 100% unit-test coverage of the engine, including rounding, members who join or leave mid-month, zero meals, own-pocket spending, negative adjustments, and carried-over balances
- [ ] `GET /months/:monthId/preview`: a live calculation for an OPEN month (what everyone owes so far)
- [ ] `POST /months/:monthId/start-closing` (→ CLOSING, locks edits), `POST /reopen` (CLOSING → OPEN, ADMIN only)
- [ ] `POST /months/:monthId/close`: in **one transaction** with an optimistic lock on `version`, write the `MemberMonthSummary` snapshots and the month totals, set the month to CLOSED, and open the next month. Notify everyone with `MONTH_CLOSED`.
- [ ] Settlement payments against a summary (due paid / refund given); update `settledAmount` and `isSettled`
- [ ] Fund handover between managers (expected vs handed amount, confirm or dispute)
- [ ] Due-reminder job (`dueReminderDay`)

### Frontend

- [ ] **Month summary** screen: meal rate, totals, a per-member table (meals, meal cost, shared cost, charges, deposits, balance) with colour-coded due and refund
- [ ] Close-month wizard: review warnings (pending bazars or deposits, members with no meals) → start closing → confirm → done
- [ ] Settlement screen: record payments, filter settled / unsettled
- [ ] Member's own bill view with a line-by-line breakdown ("why do I owe this?")
- [ ] Fund handover flow

**Done when:** closing a month written up by hand on paper gives the same numbers in Messora (keep 2–3 real-world fixtures as tests); a closed month is never recalculated.

---

## Phase 9 — Dashboards & reports

- [ ] **Member dashboard:** today's meals and menu, my balance so far this month, my next bazar duty, latest notices
- [ ] **Manager dashboard:** cash in hand, pending approvals (bazar, deposits, joins, meal requests), today's meal count per slot (for the cook), meal-rate trend
- [ ] Charts (meal rate over months, expense by category, bazar per day), following the dataviz guidelines in DESIGN_SYSTEM.md
- [ ] Reports: monthly summary, member statement, bazar list, as print-friendly pages + **PDF** and **CSV** export
- [ ] Backend aggregate endpoints, tuned with the right indexes (check the query plans)

**Done when:** a manager can answer "who owes what" and "how much cash do I hold" from the dashboard without opening other pages.

---

## Phase 10 — Notifications & notice board

### Backend

- [ ] Notifications API: list (cursor-paginated), unread count, mark read / mark all read
- [ ] Delivery worker (BullMQ): one `NotificationDelivery` row per channel, with retries and backoff: **in-app** (Socket.IO), **email** (Brevo), **web push** (FCM)
- [ ] Notification preferences (type × channel matrix; no row means ON)
- [ ] Push device registration
- [ ] Notice board: CRUD, pinning, `NOTICE_POSTED`
- [ ] Socket.IO server with authenticated connections and one room per mess and per user (shared with Phase 11)

### Frontend

- [ ] Notification bell with a live unread count, a dropdown and a full page; each item deep-links to its entity
- [ ] Preferences page, web push opt-in prompt (asked at a sensible moment, not on first load)
- [ ] Notice board with pinned notices on top

**Done when:** approving a deposit shows a notification on the member's other device within a second.

---

## Phase 11 — Chat

### Backend

- [ ] Conversations: the mess group (auto-joined by active members, read-only after leaving) and direct messages between members of the same mess (`uniqueKey`)
- [ ] Messages: send, edit, delete for everyone, delete for me (`MessageHidden`), reply, reactions, attachments (images, files, voice notes)
- [ ] Read state (`lastReadMessageId`), unread counts, typing indicators, online / last seen
- [ ] SYSTEM messages for mess events ("Rahim joined", "October closed")
- [ ] Cursor pagination on `(createdAt desc, id)`
- [ ] Rate limiting and size limits on messages and uploads

### Frontend

- [ ] Conversation list (pinned, archived, muted) and a chat view with infinite scroll upwards, date dividers, optimistic sends with retry, read ticks, reactions, replies, image previews and voice recording
- [ ] Mobile-first layout: list → conversation, with a back gesture

**Done when:** chat works in real time between two browsers, survives reconnects without duplicate or missing messages, and scrolls smoothly at 1,000+ messages.

---

## Phase 12 — Account, profile & phone verification

- [ ] Profile: name, avatar upload, language
- [ ] Change password, change email (re-verify), add or change phone
- [ ] **Phone verification by SMS OTP** (pick an SMS provider; see Open decisions); optional OTP login (`LOGIN_OTP`)
- [ ] Active sessions list (from refresh tokens: device, IP, last used) and "log out other devices"
- [ ] Delete account (soft delete, anonymize; block it while the user is the last ADMIN of a mess or has unsettled dues)

---

## Phase 13 — Audit log & super admin

- [ ] Audit log viewer per mess (ADMIN): filter by actor, entity and date; show a before/after diff
- [ ] Super admin area (`platformRole = SUPER_ADMIN`): platform stats, user search, block or unblock users, deactivate messes
- [ ] Super admin actions are also audited

---

## Phase 14 — Bangla/English, PWA, accessibility & performance

- [ ] **i18n** with `next-intl`: English and Bangla (users default to `bn`), with Bangla fonts and number formatting; translate server email templates too
- [ ] **PWA**: installable, offline shell, a cached "today's meals" view
- [ ] Accessibility: keyboard navigation, focus rings, labels, contrast (WCAG AA), honour `prefers-reduced-motion`
- [ ] Performance: Lighthouse ≥ 90 on mobile, bundle analysis, lazy-load heavy screens (charts, chat, PDF), image optimization
- [ ] Final UI polish pass on every screen against the DESIGN_SYSTEM checklist

---

## Phase 15 — Hardening & launch

- [ ] Security review: authorization on every endpoint (tenant isolation tests: user A can never read mess B), rate limits, upload validation, CSP headers, dependency audit
- [ ] Error monitoring (Sentry) on client and server; uptime check on `/health`
- [ ] Database: production migrations workflow (`prisma migrate deploy`), automated backups + a tested restore, index review
- [ ] Seed script with a realistic demo mess (for demos and local development)
- [ ] Deployment: client on Vercel; API + worker + Redis on a managed platform or VPS; managed PostgreSQL; staging and production environments
- [ ] Docs: API reference (OpenAPI generated from the Zod schemas), user guide, a runbook
- [ ] Launch checklist: legal pages (terms, privacy), support contact, analytics

**Done when:** v1.0 is live in production, with backups, monitoring and a staging environment.

---

## Open decisions

Decide these before the phase that needs them. Record the choice here.

| Decision                          | Needed by | Options / recommendation                                                                                     |
| --------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------ |
| File storage                      | Phase 5   | **Cloudflare R2** (S3-compatible, no egress fees) · AWS S3 · Cloudinary (adds image transforms)              |
| Background jobs                   | Phase 4   | **BullMQ + Redis** (the schema already assumes it)                                                           |
| Realtime                          | Phase 10  | **Socket.IO** (rooms, reconnects, fallbacks)                                                                 |
| Push notifications                | Phase 10  | **Firebase Cloud Messaging** (web now; Android and iOS later via `DevicePlatform`)                           |
| SMS provider (BD)                 | Phase 12  | Local Bangladeshi gateways (e.g. SSL Wireless, BulkSMSBD) or Twilio; compare price per SMS and delivery rate |
| Hosting                           | Phase 15  | Vercel (client) + Railway / Render / VPS (API, worker, Redis) + Neon / Supabase / RDS (Postgres)             |
| Payments in-app (bKash/Nagad API) | after v1  | v1 only _records_ payments; online payment collection is a later feature                                     |
