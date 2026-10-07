# Roadmap

> **Status:** Future product direction.
> Items listed here are **not implementation requirements**.
>
> A roadmap item must be promoted into `01-APP-SPEC.md` before it is implemented.
>
> The roadmap describes future product direction and sequencing. Detailed business rules, database changes, UI requirements, security requirements, and acceptance criteria belong in `01-APP-SPEC.md` only when a feature is ready for implementation.

---

## Product Direction

The long-term goal is to evolve the application from a financial tracker into a **financial planning assistant**.

Core flow:

```text
Track
↓
Understand
↓
Plan
↓
Reserve
↓
Spend
↓
Review
↓
Improve
```

The product should help users:

> Know what they have → know what is committed → plan ahead → reserve money → spend safely → review what happened.

---

# Near-Term

## Phase 13 — Mobile / Offline / UX Hardening

Improve the reliability and usability of the existing application before introducing major new financial features.

Areas include:

* Mobile layout and responsive behavior
* Offline first-load experience
* Offline budget reads
* Outbox retry behavior
* FAILED mutation handling
* BLOCKED mutation management
* Create/edit synchronization edge cases
* Cached-data lifecycle
* Reconciliation and recovery UX
* General usability improvements

---

# Planning Features

## Wishlist

Allow users to record things they want to purchase and intentionally wait before deciding to buy.

Concept:

```text
Want Something
↓
Wait
↓
Still Want It?
↓
Review
↓
Will Buy?
↓
Plan Funding
↓
Fund Gradually
↓
Buy
```

The feature should discourage impulsive purchases and unnecessary debt.

---

## Purchase Budget / Reserved Funds

Introduce a planning layer for purchases that users have decided they want to make.

A Purchase Budget should allow users to:

* Define a target amount
* Track funding progress
* Reserve money toward the purchase
* See remaining funding requirements
* Contribute gradually
* Avoid silently consuming existing budgets

Purchase Budgets should eventually share the broader **Reserved Funds** concept with Events and other financial goals.

---

## Events / Event Planning

Treat events as **future financial commitments**, not merely calendar reminders.

Examples:

* Christmas
* Birthdays
* Anniversaries
* Trips
* Vacations
* Weddings
* School enrollment
* Insurance
* Vehicle registration

Users should be able to plan the financial requirements of an event ahead of time.

Recurring events should eventually be supported.

---

## Active Events

Allow an upcoming event to become active.

When an Event is active, new transactions may automatically associate with that Event by default.

Initially, the product should prefer:

> One active Event per wallet.

Users should still be able to manually remove or change the Event association for individual transactions.

---

## Event Reporting

After an event is completed, provide a financial report showing what actually happened.

Potential reporting dimensions:

* Planned vs actual spending
* Category
* Account
* Member
* Day
* Transaction
* Who paid
* Remaining funds

The goal is to allow users to learn from previous events and improve future planning.

---

# Income Planning

## Income Budgeting Plans

Allow users to turn incoming income into an intentional financial plan.

Instead of simply recording:

```text
Income = ₱30,000
```

the user can choose how that income should be allocated.

Potential built-in approaches include:

* 50/30/20 Rule
* Zero-Based Budget
* Pay Yourself First
* Other researched budgeting approaches
* Custom Budget Plan

The exact set of built-in plans should be determined during feature design and validation.

---

## Reusable Budgeting Plans

Users should be able to create and save reusable named plans.

Examples:

```text
Normal Salary
Tight Month
Bonus
Christmas
Freelance Income
```

A saved plan can be reused for future income events.

The goal is to allow users to establish their preferred financial system once and reuse it instead of rebuilding their allocation every month.

---

## Income Frequency Support

Income planning should eventually support different income patterns, including:

* Monthly
* Twice a month
* Weekly
* Bi-weekly
* Irregular income

The same plan may eventually be applied differently depending on the user's income frequency.

---

## Income Allocation

When a budgeting plan is applied to income, the system should calculate a proposed allocation before the user confirms it.

Potential destinations include:

* Existing category budgets
* Savings
* Reserved Funds
* Wishlist / Purchase Goals
* Events
* Debt obligations
* Other user-defined financial priorities

Important principle:

> **Planning an allocation does not automatically mean physically moving money between accounts.**

Actual account-to-account transfers should remain explicit and user-controlled.

---

## Custom Income Plans

Users should eventually be able to define their own allocation rules.

Example:

```text
Essentials          45%
Lifestyle            15%
Emergency Fund       10%
Investments          10%
Christmas Fund        5%
Travel                5%
Debt Payment         10%
```

The system should validate the allocation and clearly warn when planned allocations exceed available income.

---

## Adaptive Income Planning

A future version may recommend allocations based on the user's actual financial situation rather than blindly applying a percentage rule.

Potential factors:

* Essential expenses
* Debt obligations
* Existing budget commitments
* Savings goals
* Reserved Funds
* Upcoming Events
* Available spending capacity

The system should remain advisory rather than becoming a hard restriction on spending.

---

# Future Financial Management

## Credit Card Management

Future support for credit-card-specific financial behavior, balances, and planning.

---

## Installments

Support installment-based purchases and their future financial commitments.

---

## Debt / Loan Management

Track debt obligations and incorporate them into future financial planning and affordability calculations.

---

## Push Notifications

Future notifications for relevant financial events, reminders, commitments, and planning activities.

---

## Receipt Uploads

Allow users to attach receipts or supporting documents to financial records.

---

## Advanced Reports

Expand reporting beyond the current dashboard and event reporting.

Potential areas include:

* Spending trends
* Historical comparisons
* Category analysis
* Account analysis
* Income vs spending
* Budget performance

---

## Advanced Financial Insights

Provide higher-level financial guidance based on the user's financial history and plans.

Potential future capabilities include:

* Financial safety indicators
* Spending pattern analysis
* Affordability guidance
* Forecasting
* Upcoming commitment awareness
* Planning recommendations

These insights should remain advisory and should not prevent users from making legitimate financial decisions.

---

# Product Principles for Future Features

Future features should continue to follow these principles:

### 1. Planning before spending

The application should encourage users to plan for known obligations before spending available money elsewhere.

### 2. Reserved money is intentional

Money reserved for a future purpose should be treated differently from money that is genuinely available to spend.

### 3. Don't silently move money

Planning and allocation should not automatically cause physical account transfers unless the user explicitly requests the transfer.

### 4. Don't silently cannibalize existing plans

New goals, purchases, or events should not automatically consume existing budgets or reserved funds without the user's knowledge.

### 5. Guide, don't shame

Financial recommendations should be advisory and supportive rather than punitive.

### 6. Avoid unnecessary debt

The product should encourage users to delay or plan for purchases rather than turning wants into debt simply because the user wants them immediately.

### 7. Preserve the financial engine

Future UI and planning features must build on the existing financial domain model rather than introducing competing balance, budget, or transaction calculations.

### 8. Security remains server-side

Future features must preserve the existing authorization model, RLS protections, secure mutation architecture, and wallet isolation.

---

# Implementation Rule

A roadmap feature must **not** be implemented solely because it appears in this document.

Before implementation:

```text
Roadmap
↓
Feature research / design
↓
Business rules defined
↓
Promoted to 01-APP-SPEC.md
↓
Implementation
↓
Testing
↓
Verification
↓
03-CHANGELOG.md
```

This roadmap is therefore a **product direction document**, not an implementation specification.
