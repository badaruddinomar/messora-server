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

- `monthStartDay` is between 1 and 28. A month labelled `(year, month)` runs from `year-month-startDay` to the day before the same start day in the next month. Example: start day 5 → Oct 5 to Nov 4 is the "October" month.
- Exactly one month per mess is `OPEN` at a time. Creating a mess opens the month that contains today.
- Status flow: `OPEN → CLOSING → CLOSED`. An ADMIN may move `CLOSING` back to `OPEN`. `CLOSED` is final.
- In `CLOSING` and `CLOSED`, every meal or money mutation for that month is rejected (`MONTH_CLOSED`). Corrections to a closed month go into the **next** month as an `ADJUSTMENT` charge, with a description that points back to the original month.
- Every meal or money record belongs to the month whose date range contains its date.

## 4. Meals

- **Weighted meals** of an entry = `(quantity + guestQuantity) × slot.weight`. A member's meals for the month = the sum over all their entries in the month.
- Default slots: Breakfast 0.5, Lunch 1, Dinner 1 (the mess can edit these).
- Entries are generated for every ACTIVE member each day: `quantity = 1` if `defaultMealOn`, else `0`, and `0` inside a `MealOffPeriod`. Generation is an idempotent upsert, so running it twice changes nothing and never overwrites an edit.
- **Cutoff:** a member may change their own entry for a slot until `cutoffTime` (mess timezone) on that meal's date. A slot without a cutoff locks at the start of that day. After the cutoff, only managers can change it.
- Guest meals require `allowGuestMeal`. Guest meals are charged to the member who adds them.

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
