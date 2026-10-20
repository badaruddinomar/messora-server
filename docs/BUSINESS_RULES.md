# Business rules

This file is the source of truth for **how Messora calculates money and who may do what**. Code and tests must match it. If a rule changes, change it here first, in the same PR as the code.

Terms: _mess_ is the tenant, _member_ is a `MessMember`, _month_ is a `MessMonth` (billing cycle), _manager_ is a member with role MANAGER/ADMIN or the month's assigned `managerId`.

---

## 1. Money, numbers and dates

- All money is `Decimal(12,2)` in the database and `Prisma.Decimal` in code. **Never** use JavaScript `number` for money: no `parseFloat` and no `+` on amounts.
- The API sends money as **strings** (`"1250.50"`). The client formats it for display only.
- Meal counts are `Decimal(5,2)` (half meals are allowed). The meal rate is `Decimal(10,4)`.
- Rounding: **half-up**, done once at the end. When splitting an amount between people, use the **largest-remainder** method, so that the parts always add up exactly to the total (see §7).
- "Calendar day" fields (`@db.Date`) are dates in the **mess timezone** (`Mess.timezone`, default `Asia/Dhaka`). "Today" always means today in the mess timezone, never in UTC or server time.

## 2. Roles & permissions

Effective roles: **ADMIN**, **MANAGER**, **MONTH MANAGER** (the member set as `MessMonth.managerId`, with manager powers for that month only), and **MEMBER**. Only `ACTIVE` members can act. `PENDING` and `SUSPENDED` members can read nothing except their own membership.

| Action                                                       |            Member             | Manager / Month manager | Admin |
| ------------------------------------------------------------ | :---------------------------: | :---------------------: | :---: |
| View mess, members, menu, notices, month summary             |              ✅               |           ✅            |  ✅   |
| Edit own meals before cutoff                                 | ✅ (if `allowMemberMealEdit`) |           ✅            |  ✅   |
| Edit anyone's meals / after cutoff                           |               —               |           ✅            |  ✅   |
| Submit bazar / deposit / meal request                        |              ✅               |           ✅            |  ✅   |
| Approve or reject bazar, deposits, meal requests             |               —               |           ✅            |  ✅   |
| Add shared expenses, charges, menu, notices                  |               —               |           ✅            |  ✅   |
| Approve join requests, invite members                        |               —               |           ✅            |  ✅   |
| Start closing / close a month, record settlements            |               —               |           ✅            |  ✅   |
| Reopen a CLOSING month                                       |               —               |            —            |  ✅   |
| Change roles, remove members, settings, rooms & seats, staff |               —               |            —            |  ✅   |
| Delete the mess                                              |               —               |            —            |  ✅   |

- A mess must always have **at least one ACTIVE ADMIN**. Demoting or removing the last admin, or the last admin leaving, is rejected.
- Members can only see **their own** detailed statement. Everyone can see the month summary table (that transparency is normal in a mess).

## 3. Months

- `monthStartDay` is between 1 and 28. A month labelled `(year, month)` runs from `year-month-startDay` to the day
  before the same start day in the next month. Example: start day 5 → Oct 5 to Nov 4 is the "October" month. Months
  are always labelled by the calendar month they start in.
- **Months open by themselves.** The month that contains today (in the mess timezone) always exists: creating a mess
  opens it, and each new month opens automatically on its first day. If nobody used the mess for a while, every month
  in between is opened too, so there are never gaps.
- **Last month stays open until it's closed.** A month that has ended stays `OPEN` (shown as "ended, waiting to be
  closed"), so late bazars, deposits and corrections can still be added while the new month is already running.
  Several months can therefore be `OPEN` at once.
- **Months are closed in order**: a month can only start closing once every earlier month is `CLOSED`
  (`MONTHS_OUT_OF_ORDER`).
- Status flow: `OPEN → CLOSING → CLOSED`. An ADMIN may move `CLOSING` back to `OPEN`. `CLOSED` is final.
- In `CLOSING` and `CLOSED`, every meal or money change for that month is rejected (`MONTH_CLOSED`). Corrections to
  a closed month go into a later month as an `ADJUSTMENT` charge, with a description that points back to the
  original month.
- Every meal or money record belongs to the month whose date range contains its date. Dates before the first month or
  more than **7 days after today** are rejected (`DATE_OUTSIDE_MONTHS`). The 7-day planning window means next month
  opens up to a week early, so members can plan meals across the month boundary.
- **Changing the start day** applies from the next month that opens. That month starts the day after the previous one
  ends, and runs until the next new start day that is in a later calendar month and at least 14 days away, so there is
  no overlap, no gap and no stub month. Example: months on the 1st, switched to the 5th → November runs Nov 1 – Dec 4,
  then December starts on Dec 5.
- **Month manager.** An ADMIN can assign one active member as a month's manager. While that month is `OPEN`, they
  have manager powers (BUSINESS_RULES §2) even if their role is MEMBER. A closed month's manager can't be changed.

## 4. Meals

- **Weighted meals** of an entry = `(quantity + guestQuantity) × slot.weight`. A member's meals for the month = the sum over all their entries in the month.
- Default slots: Breakfast 0.5, Lunch 1, Dinner 1 (the mess can edit these).
- Entries are generated for every ACTIVE member each day: `quantity = 1` if `defaultMealOn`, else `0`, and `0` inside a `MealOffPeriod`. Generation is an idempotent upsert, so running it twice changes nothing and never overwrites an edit.
- **Cutoff:** a member may change their own entry for a slot until `cutoffTime` (mess timezone) on that meal's date. A slot without a cutoff locks at the start of that day. After the cutoff, only managers can change it.
- Guest meals require `allowGuestMeal`. Guest meals are charged to the member who adds them.
- Members edit only their own meals, and only if `allowMemberMealEdit` is on. Managers edit anyone's meals on any day
  of an `OPEN` month; the member gets a `MEAL_UPDATED_BY_MANAGER` notification and the change is audited.
- Meal counts go in half steps (0–5 own, 0–10 guests). A bulk change is all-or-nothing.
- **Usual meals** (`defaultMealOn`): switching it changes the upcoming entries still at the old usual amount (custom
  amounts and meal-off days stay as they are).
- **Meal-off periods** (at most 90 days, no overlaps): members start them today or later and they only change meals
  still before their cutoff; managers can also cover earlier days of open months. Cancelling one that has started
  ends it yesterday, and the upcoming days go back to the usual meals.
- **Meal slots**: a mess keeps at least one active slot. Removing a slot that already has meals archives it (past
  months keep their numbers) and drops its upcoming entries.
- **Meal requests** go to every manager (`MEAL_REQUEST`) and are for today or later. Managers approve or reject them
  once (`MEAL_REQUEST_RESPONDED`); members can withdraw their own pending requests.
- **Daily menu**: one per slot per day, posted by managers. A new menu for today or later notifies every active
  member (`MENU_POSTED`); edits don't.

## 5. Meal rate

```
totalBazar   = Σ totalAmount of APPROVED bazars in the month (both MESS_FUND and OWN_POCKET)
totalMeals   = Σ weighted meals of all members in the month
mealRate     = totalBazar / totalMeals          (stored with 4 decimals)
```

- If `totalMeals = 0`, then `mealRate = 0` and the bazar total is treated as a shared cost split `EQUAL` (so the money isn't lost). The close wizard warns about this case.
- Shown to users rounded to `MessSetting.mealRateDecimals`.

## 6. Charges

- **Seat rent:** when a month is closed, a `SEAT_RENT` charge is created for every member who held a seat during the month. If `prorateSeatRent` is on and the member joined or left during the month:
  `rent × daysPresent / daysInMonth`, with `periodFrom`/`periodTo` and `isProrated = true`.
- Other charges (`FINE`, `PERSONAL`, `ADJUSTMENT`) are entered by managers. `ADJUSTMENT` may be negative (a discount or correction).

## 7. Shared expenses

A member **takes part** in a month if they were ACTIVE on at least one day of it.

- `EQUAL`: split equally between the members who took part.
- `BY_MEAL`: split in proportion to each member's weighted meals. If nobody had meals, it falls back to `EQUAL`.
- `CUSTOM`: explicit `ExpenseShare` rows. These must add up exactly to `amount`, which is checked on create and update.

**Splitting algorithm (largest remainder):** compute each share exactly, round each one _down_ to 0.01, then hand out the leftover cents one at a time to the shares with the largest remainders (ties go to the lower `memberId`). Σ shares = amount, always.

The same algorithm is used for each member's meal cost, so Σ meal costs = `totalBazar` exactly.

## 8. Member month summary (closing)

For each member who took part in the month:

```
mealCost       = member weighted meals × mealRate        (allocated with the largest-remainder method, §7)
sharedCost     = Σ the member's shares of APPROVED shared expenses
chargeTotal    = Σ the member's charges (can include negative adjustments)
totalDeposit   = Σ APPROVED deposits
               + Σ APPROVED bazars the member paid OWN_POCKET (as shopper)
               + Σ shared expenses the member paid OWN_POCKET (paidByMemberId)
openingBalance = previous month closingBalance
               + Σ MEMBER_TO_MESS settlements on it − Σ MESS_TO_MEMBER settlements on it
closingBalance = openingBalance + totalDeposit − (mealCost + sharedCost + chargeTotal)
```

- Sign convention: **`closingBalance > 0` means the mess owes the member; `< 0` means the member owes the mess.**
- A member who left keeps their summary. Their balance carries over until it is settled.
- Closing writes `MemberMonthSummary` rows plus `totalBazar`, `totalMeals`, `mealRate`, `totalExpenses`, `openingCash` and `closingCash` on the month, all in one transaction guarded by `version`. **A CLOSED month is never recalculated.**

## 9. Cash in hand (mess fund)

```
closingCash = openingCash
            + Σ APPROVED deposits
            + Σ MEMBER_TO_MESS settlements
            − Σ APPROVED MESS_FUND bazars
            − Σ MESS_FUND shared expenses
            − Σ MESS_TO_MEMBER settlements
```

`openingCash` = the previous month's `closingCash` (0 for the first month). When the manager changes, a `FundHandover` records `expectedAmount = closingCash` against `handedAmount`. A mismatch is shown, and it can be `DISPUTED`.

## 10. Approvals

- With `requireBazarApproval` / `requireDepositApproval` off, new entries are created `APPROVED`.
- Only `APPROVED` entries count in any calculation. `PENDING` entries show in the close wizard as warnings.
- Rejecting requires a reason. A rejected entry can be edited and resubmitted by its creator, which sets it back to `PENDING`.
- The creator can edit an entry while it is `PENDING`. Managers can edit it in any state, as long as the month is `OPEN`.
- Entries a manager adds are created `APPROVED` (they would approve them anyway).

### Bazar

- A bazar is dated today or earlier (`DATE_IN_FUTURE`) and belongs to the month containing that date.
- An itemised bazar's `totalAmount` is the sum of its items, computed on the server; a total sent along must match
  (`TOTAL_MISMATCH`). A quick bazar has no items, only a total.
- Members add bazars for themselves; managers can record one for any active member, who is notified.
- Pending bazars notify every manager (`BAZAR_SUBMITTED`); the shopper hears the decision (`BAZAR_APPROVED` /
  `BAZAR_REJECTED`). Everyone in the mess can see every bazar.
- Receipts are images (JPEG, PNG, WebP, at most 5 MB), stored privately and shown through short-lived links.
- **Bazar duty:** managers plan a rotation for a month (a bazar day every N days, 1–3 members per day, taking turns in
  a chosen order, skipping anyone not in the mess that day). Re-planning replaces duties from the start day on that
  aren't done yet. Managers move, reassign, swap or remove duties; a member ticks off their own. Adding a bazar ticks
  off the shopper's duty for that day. At 08:00 (mess time) members with undone duty today get one reminder.

## 11. Membership

**Creating a mess.** The creator becomes its first ADMIN (ACTIVE from today). The mess starts with default settings,
the default meal slots (or the ones chosen in the wizard), its group chat, and the billing month that contains today.

**Joining with a code.** Anyone with the 8-character join code can _ask_ to join. That creates a `PENDING`
membership and notifies the managers. A manager approves (the member becomes `ACTIVE` from that day and joins the group
chat) or declines (the request is removed, so the person can ask again). The requester can cancel their own request.
Managers can regenerate the code at any time; old codes stop working immediately.

**Invitations.** Managers invite by phone or email; only admins can invite managers, and nobody is invited as ADMIN
(admins are made by promoting a member).

- An invitation is a single-use link that is valid for **7 days**. Whoever opens it can accept it once, so it can be
  shared over WhatsApp/SMS. Email invitations are also sent by email. Only a hash of the link is stored.
- People who already have an account with the invited phone or email also see the invitation in the app and can
  accept it there (only they can).
- Accepting makes the person `ACTIVE` immediately with the invited role; there is no approval step.
- Inviting the same phone/email again replaces the previous pending invitation. Managers can revoke pending ones.

**Leaving and removal.** Members can leave; admins can remove members. Either way the membership becomes `LEFT` with
`leftAt` = today, and the person becomes read-only in the group chat. Their records stay, so past months and balances
remain correct. A member who left can ask to join again; their old membership is reused so history stays linked.

**Suspension.** Admins can suspend and reactivate members. Suspended members can't use the mess and can't rejoin
with a code until they are reactivated.

**Last admin.** Every action that would leave a mess without an `ACTIVE` ADMIN is rejected (`LAST_ADMIN`): demoting,
suspending, removing or leaving as the only admin. Admins can't suspend or remove themselves.

**Visibility.** All members see the member list with names and phone numbers. Emails, leave reasons, join requests and
invitations are visible to managers only.

**Deleting a mess.** Admin only, confirmed by typing the mess name. The mess is soft-deleted: it disappears for everyone,
and its data is kept.
