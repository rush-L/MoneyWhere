# Money Tracking PWA
## Application Specification & Build Contract

> **Document:** `01-APP-SPEC.md`  
> **Purpose:** Defines the current application that should be built.  
> **Status:** Living specification  
> **Rule:** The AI agent must treat this document as the current source of truth for implementation.  
> **Companions:** `02-ROADMAP.md` (future scope) and `03-CHANGELOG.md` (implementation history). All three live in the repository root.  
> **Contract:** The Phase D0 product contract is finalized in this document (see `03-CHANGELOG.md`). Items marked **Deferred** are *not* required; see section 25.

---

# 1. Product Vision

Build a modern Progressive Web App (PWA) for **personal and shared financial management**.

The application should help users:

- Track income and expenses
- Manage multiple wallets and accounts
- Manage household/shared finances
- Create and monitor budgets
- Understand what money they have across accounts
- Avoid overspending and unnecessary debt
- Work offline and synchronize when connectivity returns
- Eventually (**Deferred**, section 25) understand what money is *available* after reservations, plan future purchases, and track predictable future financial events

The product should not feel like a traditional accounting system.

It should feel like a **financial decision assistant**.

The core philosophy is:

> **Know what you have → Know what is committed → Plan ahead → Spend safely → Review what happened**

---

# 2. Product Model

The application uses four financial concepts. **Actual Balance** and **Budgeted** are implemented. **Reserved** and **Available** are **Deferred** (section 25): until Reserved Funds exist, the dashboard shows *Total Balance* (the sum of actual balances) and never an "Available" figure.

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

## Reserved (Deferred)

Money intentionally protected for a future purpose.

Examples:

```text
Christmas = ₱8,000 reserved
Laptop Purchase = ₱5,000 reserved
```

## Available (Deferred)

Money that can reasonably be spent without violating the user's financial plan. Depends on Reserved.

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

Purchase planning and financial goals are **Deferred** (section 25).

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
- Password recovery (email link; production delivery to arbitrary users needs custom SMTP, see section 17)
- Google authentication (production use is **Deferred** until a custom domain exists, see section 17 and `03-CHANGELOG.md`)
- Display name
- Profile avatar

Users must be able to:

- Export their data (section 17.1)
- Delete their account (section 17.2)

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

## Wallet mode

Every wallet is a **Shared Log**:

- Transactions remain individual entries; there is no balancing between members.
- Each income/expense records a payer (section 9.1).
- The owner and members can both create transactions.

**Split Mode** (equal / exact amount / percentage) is **Deferred** (section 25). There is no split data model, and the wallet `mode` stays `shared_log` only.

## Wallet lifecycle

- Wallets are active. A wallet can be created, renamed and **deleted** by its owner. Deleting a wallet permanently deletes its accounts, categories, budgets and transactions for all members.
- **Wallet Archive is Deferred** (section 25). There is no archived state, no archive column and no archive UI.

---

# 6. Wallet Permissions and Membership

## 6.1 Roles

Every wallet has **exactly one Owner** at all times, plus zero or more Members. Authorization is enforced server-side (RLS / secure RPCs); the UI only mirrors it.

| Action | Owner | Member |
|---|---|---|
| View wallet, accounts, categories, budgets, transactions, co-members | Yes | Yes |
| Add transactions | Yes | Yes |
| Edit / delete **own** transactions (`created_by` = self) | Yes | Yes |
| Edit / delete **another member's** transaction | Yes | No |
| Edit / delete a transaction whose `created_by` is anonymized (former account) | Yes | No |
| Manage accounts, categories, budgets | Yes | No |
| Rename wallet | Yes | No |
| Invite members / revoke invites | Yes | No |
| Remove a member | Yes | No |
| Transfer ownership | Yes | No |
| Delete wallet | Yes | No |
| Leave wallet | No (transfer ownership or delete the wallet first) | Yes |

Members cannot modify another member's transactions unless a future permission system grants it.

## 6.2 Invitations

```text
Owner creates invite → secure random token → link shared by owner
→ recipient signs in and accepts → membership created → invite consumed
```

- Delivery is **copy-link**; email delivery is not required (custom SMTP is deferred).
- The token is random and high-entropy. **Only a hash of the token is stored**; the raw token is shown once, at creation.
- Expires **7 days** after creation. Single-use. Revocable by the owner.
- Acceptance requires an authenticated user. An invalid, expired, revoked or already-used token yields one generic error that does not reveal which case applied.
- A user who is already a member accepting a valid link is a harmless no-op that does not consume the token.
- Invite creation and acceptance attempts are **rate limited**.
- All invitation logic is server-enforced.

## 6.3 Removing and leaving

- The owner may remove any other member. A member may leave. The owner cannot leave.
- Removal or leaving ends access immediately. It does **not** change transaction history: `created_by` and `paid_by_user_id` are retained (see 6.5).

## 6.4 Ownership transfer

- Only the current owner can transfer.
- The destination must already be a member of that wallet, and not the owner.
- The transfer is **atomic**: the old owner becomes a Member and the destination becomes Owner in one transaction, so there are never zero or two owners.
- The destination must be a **current** member of the same wallet (not an outsider, a former member or a member of another wallet); nothing is created as a side effect. The old owner stays a member.
- Transaction history (`created_by`, `paid_by_user_id`) and all wallet data are unchanged; it is the same wallet.
- Online only; never queued in the offline outbox.
- If the owner is the only member there is no destination, so transfer is rejected (the owner may delete the wallet instead).

## 6.5 Co-member visibility and former-member privacy

- Members of a wallet can see each other's **display name** and **avatar URL** (if present) and nothing else. Email addresses, authentication identifiers and other profile fields are never exposed to co-members.
- When a user's membership ends (left or removed), their profile is no longer visible to that wallet. Historical `created_by` / `paid_by_user_id` references remain, and the UI shows **Former member**. A profile is never exposed merely because a historical record references it.
- The UI shows the member's name wherever the member can be safely identified (replacing any generic "Another member" label).

---

# 7. Accounts

Wallets contain financial accounts.

Supported account types:

- Cash
- E-wallet
- Bank
- Credit Card
- Loan

Credit Card and Loan exist as account types only. **Special credit-card/loan semantics are Deferred** (section 25): they behave like any other account for balance purposes.

Each account should support:

```text
Name
Type
Opening Balance
Holder
Currency
```

Current Balance is **computed** (section 8), not a stored field.

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

Current balance is computed from the account's opening balance and transactions.

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
Category                  (required for expense; income and transfers have none)
Account                   (a transfer also has a destination account)
Date
Note
Who Paid / Received by    (income and expense only)
created_by                (system-set audit and authorization identity)
```

**Receipts are Deferred** (section 25).

Users must be able to:

- Create
- Edit
- Delete
- Search
- Filter

Transactions should synchronize in near real-time when online (section 15).

## 9.1 `created_by` vs `paid_by_user_id`

These are independent fields.

- `created_by` is who recorded the transaction. It is set by the server, never client-supplied, and drives edit/delete permission (section 6.1).
- `paid_by_user_id` applies to income and expense. It is displayed as **Who Paid** for an expense and **Received by** for income.
- Default payer/recipient = the creator. The creator may select any **current member** of the wallet.
- The server validates that a selected payer is a current member whenever the payer is set or **changed**. An edit that leaves the payer unchanged is allowed even if that payer has since left.
- **Transfers have no payer.**
- A payer who is no longer a member is displayed as **Former member** (section 6.5).

## 9.2 Search and filters

Search and filtering operate over the wallet's **already-loaded** transactions, so they work offline and include pending offline rows.

- **Search** (case-insensitive substring): note, account name, category name (including its parent category), payer/member name, transaction type.
- **Filters:** date (single day or range), category, payer/member, account, transaction type.
- Different filters combine with **AND**. Multiple values selected within one filter combine with **OR**. Search combines with filters by AND.
- A transfer matches an account filter on either its source or its destination account.
- **Empty state:** when nothing matches, show a "no matching transactions" state with a *Clear filters* action. A wallet with no transactions at all keeps its normal empty state.

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
- Does NOT count as income
- Does NOT affect category spending totals
- Has no payer

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

Categories are expense-only. **Income categories** and **custom categories beyond the owner-managed defaults** are not required now (section 25).

---

# 12. Budgets

Users can create monthly budgets.

Example:

```text
Food
₱8,000 / month
```

Budgets support:

- Category
- Wallet
- Monthly limit, which must be **greater than zero**

**Rollover is Deferred** (section 25): budgets do not carry over between months.

Progress is `spent / budget` for the budget's category and month:

```text
< 80%           Normal
80% to < 100%   Warning
>= 100%         Exceeded
```

Exactly 100% is **Exceeded**.

Budget alerts are in-app indicators only; push and advanced notifications are Deferred (section 16).

Important rule:

> Budgeted money must not be silently reallocated to another purpose.

If a user wants to move money between budgets, they must explicitly do so.

---

# 13. Dashboard

The dashboard provides a simple financial overview for the **selected wallet and month**.

Display:

- **Total Balance**: the computed sum of the wallet's account balances (section 8)
- Account balances
- Budget progress
- **Monthly Income**: the sum of all income transactions in the month
- **Total Spent**: the sum of **all** expense transactions in the month, whether or not their category has a budget
- **Budgeted Spent**: the part of spending that falls in categories that have a budget
- **Total Remaining**: `Total Budgeted - Budgeted Spent`. This is budget capacity left, not cash on hand: unbudgeted expenses do not reduce it (they still count in Total Spent and in the account balances). It is negative when budgets are exceeded.

Transfers are excluded from both income and spending.

Change note: the dashboard's single "Spent" figure already summed every expense in the month; it is now labelled **Total Spent**, and **Budgeted Spent** and **Monthly Income** are new separate figures (Phase D3). The hero "Budget Remaining" figure is Total Remaining as defined above.

**Deferred** dashboard items (section 25): Net Worth, upcoming recurring transactions, planned purchases, reserved funds, and an "available to spend" figure.

The dashboard should prioritize decision-making rather than raw accounting information.

---

# 14. Offline-First Behavior

The application must support offline transaction entry.

Offline writes cover **transaction create, edit and delete only**. Wallet, account, category, budget and membership changes require a connection (**offline writes for non-transaction data are Deferred**, section 25).

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

Required now:

- In-app budget indicators (warning and exceeded states, section 12)

**Deferred** (section 25): web push notifications, and advanced notifications (upcoming bills, credit-card due dates, loan payment due, new shared-wallet transaction alerts). iOS PWA installation requirements apply when push is promoted.

---

# 17. Data Privacy

The application is intended for public distribution.

It must include:

- Privacy Policy page at `/privacy`
- Terms of Service page at `/terms`
- Account deletion (17.2)
- Data export (17.1)

Both pages are public (viewable signed out) and linked from the sign-in screen and the profile screen. Their legal text is written and reviewed separately; this specification is not legal advice. The Privacy Policy must describe at least:

- profile data collected (email, display name, avatar URL)
- financial data the user enters
- what co-members can see (display name and avatar only)
- the infrastructure processors (Supabase for authentication and database, Vercel for hosting)
- retention and anonymization after account deletion
- how to export or delete data

The implementation should consider the Philippine Data Privacy Act and applicable privacy requirements.

Do not expose private wallet data between unrelated users.

**Production email limitation:** the built-in Supabase mailer only reaches permitted addresses, so signup confirmation and password recovery for arbitrary public users require custom SMTP, which needs a domain we control. The project deliberately stays on free tiers with no custom domain during development and controlled testing. This is also why invitations use copy-link delivery. See the free-tier production strategy in `03-CHANGELOG.md`.

## 17.1 Data export

- One **JSON** file, generated client-side from data the user can already read (no extra privileges).
- Envelope: `schema_version`, `exported_at` (UTC), `exported_by` (user id), app name, and summary counts.
- Contents: the user's own profile (display name, avatar URL); wallets they belong to with their role; memberships (member id, display name, role); accounts, categories, budgets and all transactions of those wallets; computed account balances, labelled as derived. Amounts are integer minor units with a currency field.
- Includes historical data, including transactions whose creator/payer is now anonymized (exported as null / "Former member").
- Excludes other users' email or profile fields, authentication data, invite tokens and the offline outbox.
- Export is offered before account deletion.

## 17.2 Account deletion

Principle: preserve valid financial records for other members, and remove the deleted user's identity.

| Situation | Rule |
|---|---|
| Owns a wallet with **other members** | Deletion is **blocked** until the user transfers ownership, removes the other members, or deletes the wallet. The UI lists the blocking wallets. |
| Owns a wallet where they are the **only** member | The wallet and its accounts, categories, budgets and transactions are deleted with the account. The confirmation names each affected wallet, and export is offered first. No other user's data is affected. |
| Member of shared wallets | Membership ends automatically; no prior "leave" step is required. |
| Transactions they created or paid | **Retained.** `created_by` and `paid_by_user_id` become anonymous (null) and display as **Former member**. Anonymized transactions are editable/deletable by the wallet owner only. |
| Profile and avatar data | Deleted. |
| Pending offline mutations | Deletion is **blocked** while the local outbox has pending mutations: *"Sync or discard pending changes first."* Pending changes are never discarded automatically. |
| Shared wallets afterwards | Always have exactly one owner; a deletion that would leave a shared wallet without an owner is refused. |

Deleting the authentication identity is a privileged server-side operation. It must re-verify the caller and re-check the blockers on the server rather than trust the client.

---

# 18. Security

Security requirements:

- Server-side authorization
- Secure authentication
- Protected database access
- Rate limiting (invitation creation and acceptance at minimum)
- Secure invitation tokens (section 6.2)
- Input validation
- Server-validated payer membership (section 9.1)

File storage, file upload validation and private receipt storage are **Deferred** with Receipts (section 25).

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
- Spending and income totals

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
- Exactly 100% is Exceeded
- Over-budget

### Shared Wallets

- Owner permissions
- Member permissions
- Member editing own transaction
- Member attempting to edit another member's transaction
- Invitation lifecycle (expiry, single use, revoke, generic error)
- Ownership transfer (atomic, exactly one owner)
- Payer validation (current members only)
- Account deletion blockers and anonymization

### Offline

- Create transaction offline
- Reconnect
- Sync
- Duplicate prevention
- Conflict handling

### Financial calculations

Test:

- Zero income
- No budgets
- Multiple budgets
- Multiple accounts
- Total Spent includes unbudgeted expenses
- Transfers excluded from income and spending

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

Today the application answers the first and last questions (balances, budgets). The rest depend on Deferred features (section 25).

The application should guide users toward financial awareness without shaming them or unnecessarily blocking legitimate decisions.

---

# 25. Deferred Features

These are **not** part of the current implementation. They are kept as ideas in `02-ROADMAP.md` and must be promoted into this specification before they are built (section 23). "Deferred" means intentionally out of scope, not "required but missing".

| Feature | Notes |
|---|---|
| Split Mode (equal / exact / percentage) | Wallet `mode` stays `shared_log` only |
| Wallet Archive | No archived state, column or UI |
| Budget rollover | Budgets do not carry over |
| Net Worth | Needs credit-card/loan semantics |
| Credit-card / loan special semantics | Account types exist without special behavior |
| Receipts and file storage | Includes upload validation and private storage |
| Web push and advanced notifications | In-app budget indicators remain |
| Reserved Funds and "Available to spend" | Dashboard shows Total Balance instead |
| Wishlist / Purchase Goals | |
| Events | |
| Recurring and planned purchases | |
| Offline writes for non-transaction data | Offline writes are transactions only |
| Income categories and custom categories | Expense-only default categories |
| Custom domain, custom SMTP, production Google sign-in | Deployment strategy, see `03-CHANGELOG.md` |
