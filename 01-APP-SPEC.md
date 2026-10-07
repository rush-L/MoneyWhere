# Money Tracking PWA
## Application Specification & Build Contract

> **Document:** `01-APP-SPEC.md`  
> **Purpose:** Defines the current application that should be built.  
> **Status:** Living specification  
> **Rule:** The AI agent must treat this document as the current source of truth for implementation.

---

# 1. Product Vision

Build a modern Progressive Web App (PWA) for **personal and shared financial management**.

The application should help users:

- Track income and expenses
- Manage multiple wallets and accounts
- Manage household/shared finances
- Create and monitor budgets
- Understand what money is actually available to spend
- Plan future purchases
- Avoid overspending and unnecessary debt
- Work offline and synchronize when connectivity returns
- Eventually plan and track predictable future financial events

The product should not feel like a traditional accounting system.

It should feel like a **financial decision assistant**.

The core philosophy is:

> **Know what you have → Know what is committed → Plan ahead → Spend safely → Review what happened**

---

# 2. Product Model

The application uses four important financial concepts:

## Actual Balance

Money that actually exists in an account.

Example:

```text
GCash = ₱20,000
```

## Budgeted

Money allocated to normal spending categories.

Example:

```text
Food Budget = ₱5,000
Transportation Budget = ₱3,000
```

## Reserved

Money intentionally protected for a future purpose.

Examples:

```text
Christmas = ₱8,000 reserved
Laptop Purchase = ₱5,000 reserved
```

## Available

Money that can reasonably be spent without violating the user's financial plan.

The UI should make these concepts understandable without requiring accounting knowledge.

---

# 3. Target Users

The application supports:

### Personal users

Users managing their own:

- Cash
- Bank accounts
- E-wallets
- Credit cards
- Loans
- Budgets
- Purchases
- Financial goals

### Shared/household users

Users managing finances together through a wallet.

Examples:

- Couples
- Families
- Roommates
- Small groups

---

# 4. Authentication

Support:

- Email/password authentication
- Google authentication
- Display name
- Profile avatar

Users must be able to:

- Export their data
- Delete their account

Account deletion must follow proper data deletion rules.

Authentication and authorization must always be enforced server-side.

Never rely exclusively on frontend permission checks.

---

# 5. Wallets

A user can create multiple wallets.

Examples:

```text
Personal
Family
Travel
Household
```

Each wallet has exactly **one currency**.

Default currency:

```text
PHP
```

Wallet ownership:

```text
Owner
Member
```

## Wallet modes

### Shared Log

Transactions remain individual expenses, but the application records:

> Who paid?

### Split

Expenses can be split between members.

Only one split method may be used for a transaction:

- Equal
- Exact amount
- Percentage

Do not mix methods within one transaction.

---

# 6. Wallet Permissions

## Owner

Can:

- Edit wallet
- Invite members
- Remove members
- Change wallet settings
- Transfer ownership
- Archive wallet
- Delete wallet
- Perform transactions

## Member

Can:

- View wallet
- Add transactions
- Edit their own transactions
- Delete their own transactions
- Leave wallet

Members cannot modify another member's transactions unless explicitly granted permission by a future permission system.

---

# 7. Accounts

Wallets contain financial accounts.

Supported account types:

- Cash
- E-wallet
- Bank
- Credit Card
- Loan

Each account should support:

```text
Name
Type
Opening Balance
Current Balance
Holder
Currency
```

The holder field is optional.

Example:

```text
GCash
Holder: Russel

GCash
Holder: Trisha
```

This prevents confusion when multiple members use the same account type.

---

# 8. Account Balance

Current balance should be computed from the account's opening balance and transactions.

Conceptually:

```text
Current Balance
=
Opening Balance
+
Income
-
Expenses
+
Transfers In
-
Transfers Out
```

Transfers must not be treated as spending.

---

# 9. Transactions

Supported transaction types:

- Income
- Expense
- Transfer

Transaction fields:

```text
Type
Amount
Category
Account
Date
Note
Who Paid
Receipt
```

Users must be able to:

- Create
- Edit
- Delete
- Search
- Filter

Filters should include:

- Date
- Category
- Member
- Account
- Transaction type

Transactions should synchronize in near real-time when online.

---

# 10. Transfers

Transfers move money between accounts.

Example:

```text
BPI → GCash
```

A transfer:

- Reduces source account balance
- Increases destination account balance
- Does NOT count as spending
- Does NOT affect category spending totals

The UI should clearly distinguish transfers from expenses.

---

# 11. Categories

Provide sensible default categories during onboarding.

Examples:

### Food

- Groceries
- Restaurants
- Coffee

### Transportation

- Fuel
- Public Transportation
- Ride Sharing

### Bills

- Electricity
- Water
- Internet
- Phone

### Lifestyle

- Entertainment
- Shopping
- Hobbies

Users should eventually be able to create custom categories.

---

# 12. Budgets

Users can create monthly budgets.

Example:

```text
Food
₱8,000 / month
```

Budgets should support:

- Category
- Wallet
- Monthly limit
- Optional rollover

Progress indicators:

```text
0–79%   Normal
80–99%  Warning
100%+   Exceeded
```

Budget alerts should be supported.

Important rule:

> Budgeted money must not be silently reallocated to another purpose.

If a user wants to move money between budgets, they must explicitly do so.

---

# 13. Dashboard

The dashboard should provide a simple financial overview.

Display:

- Total available money
- Account balances
- Budget progress
- Monthly income
- Monthly spending
- Net worth
- Upcoming recurring transactions
- Planned purchases
- Reserved funds

Net worth:

```text
Assets - Credit Card Balances - Loan Balances
```

The dashboard should prioritize decision-making rather than raw accounting information.

---

# 14. Offline-First Behavior

The application must support offline transaction entry.

When offline:

```text
Transaction
↓
Local Storage / Offline Queue
↓
Pending Sync
↓
Internet Available
↓
Server Sync
↓
Synced
```

Transactions must not be silently lost.

The UI should communicate sync status.

Example:

```text
✓ Synced
↻ Syncing
⚠ Pending
```

Conflict handling must be deterministic and tested.

---

# 15. Realtime Synchronization

When online, changes should synchronize between devices/users.

Shared wallet changes should eventually appear for other members without requiring a manual refresh.

Server-side authorization remains authoritative.

---

# 16. Notifications

Support:

- In-app notifications
- Web push notifications

Potential notifications:

- Budget reaching 80%
- Budget exceeded
- Upcoming bill
- Credit card due date
- Loan payment due
- New shared-wallet transaction

iOS push support should account for PWA installation requirements.

---

# 17. Data Privacy

The application is intended for public distribution.

It must include:

- Privacy Policy
- Terms of Service
- Account deletion
- Data export

The implementation should consider the Philippine Data Privacy Act and applicable privacy requirements.

Do not expose private wallet data between unrelated users.

---

# 18. Security

Security requirements:

- Server-side authorization
- Secure authentication
- Protected database access
- Protected file storage
- Rate limiting
- Secure invitation tokens
- Input validation
- File upload validation
- Private receipt storage

Wallet invitations must not expose predictable or reusable authorization tokens.

---

# 19. Development Rules

The AI development agent MUST:

1. Inspect the existing codebase before changing architecture.
2. Reuse existing patterns where reasonable.
3. Avoid unnecessary rewrites.
4. Never invent undocumented business rules.
5. Ask for clarification when confidence is below 90–100%.
6. Make incremental changes.
7. Run tests after meaningful changes.
8. Verify migrations.
9. Verify authorization.
10. Verify mobile/PWA behavior.
11. Update documentation when behavior changes.

Development workflow:

```text
Analyze
↓
Plan
↓
Implement
↓
Test
↓
Verify
↓
Document
```

---

# 20. Architecture Principles

Prefer:

- Modular architecture
- Clear domain boundaries
- Reusable components
- Server-side validation
- Strong database constraints
- Deterministic financial calculations
- Testable business logic
- Offline-safe state management

Financial calculations must not be duplicated across unrelated UI components.

Create reusable services/functions for:

- Balance calculation
- Budget calculation
- Available money
- Reserved money
- Financial capacity
- Transaction totals

---

# 21. Testing Requirements

Financial features require automated tests.

At minimum test:

### Accounts

- Opening balance
- Income
- Expense
- Transfer
- Multiple accounts

### Budgets

- Normal spending
- 80% threshold
- 100% threshold
- Over-budget
- Rollover

### Shared Wallets

- Owner permissions
- Member permissions
- Member editing own transaction
- Member attempting to edit another member's transaction

### Offline

- Create transaction offline
- Reconnect
- Sync
- Duplicate prevention
- Conflict handling

### Financial calculations

Test:

- Zero income
- Zero capacity
- Negative capacity
- No budgets
- Multiple budgets
- Multiple accounts
- Reserved money
- Existing obligations

---

# 22. Definition of Done

A feature is not complete until:

- UI is implemented
- Database changes are implemented
- Server-side authorization exists
- Validation exists
- Error states exist
- Loading states exist
- Empty states exist
- Mobile layout works
- Offline behavior is considered
- Tests exist
- Existing tests pass
- Documentation is updated

---

# 23. Current Scope Boundary

Only features explicitly defined in this document should be considered part of the current implementation.

Future features belong in:

```text
02-ROADMAP.md
```

Do not implement roadmap features simply because they are documented there.

A roadmap item must first be promoted into this specification before implementation.

---

# 24. Product Philosophy

The application should consistently encourage:

> **Spend intentionally, not accidentally.**

The system should help users answer:

```text
How much do I have?

How much is already committed?

How much should I reserve?

How much can I safely spend?

What am I preparing for?

Am I going to exceed my plan?
```

The application should guide users toward financial awareness without shaming them or unnecessarily blocking legitimate decisions.