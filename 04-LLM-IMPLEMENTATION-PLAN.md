# MoneyWhere — LLM Implementation Plan

> **Purpose:** Define how MoneyWhere should be implemented, verified, and evolved when using Claude Code or other LLM-assisted coding agents.
>
> This document defines **how to build the product**.
> `01-APP-SPEC.md` defines **what the product must do**.
> `02-ROADMAP.md` defines **what we plan to build**.
> `03-CHANGELOG.md` records **what has actually been implemented**.

---

# 1. Document Hierarchy

MoneyWhere uses four primary project documents:

```text
01-APP-SPEC.md
      │
      │ Product contract
      ▼
02-ROADMAP.md
      │
      │ Planned features
      ▼
04-LLM-IMPLEMENTATION-PLAN.md
      │
      │ Implementation methodology
      ▼
03-CHANGELOG.md
      │
      │ Verified implementation history
      ▼
Repository / Application
```

## Authority

### `01-APP-SPEC.md`

The product specification is the highest-level implementation contract.

It defines:

* product behavior
* business rules
* permissions
* data model
* UX requirements
* security expectations
* functional requirements

If implementation conflicts with the specification, stop and resolve the conflict.

---

### `02-ROADMAP.md`

The roadmap defines:

* future features
* implementation order
* dependencies
* planned improvements
* feature status

The roadmap must not become a detailed implementation checklist.

---

### `03-CHANGELOG.md`

The changelog records:

* what was actually implemented
* important implementation decisions
* verification results
* migrations
* production changes
* relevant lessons

Do not claim a feature is complete until its required verification has passed.

---

### `04-LLM-IMPLEMENTATION-PLAN.md`

This document defines:

* implementation strategy
* LLM coding workflow
* vertical-slice methodology
* testing expectations
* verification gates
* security rules
* commit discipline
* handoff/reporting format

This document should remain relatively stable.

---

# 2. Core Implementation Strategy

MoneyWhere uses a **modified vertical-slice implementation approach**.

The goal is to implement small, complete, verifiable pieces of functionality rather than building the application layer-by-layer.

A typical slice looks like:

```text
Requirement
    ↓
Understand existing system
    ↓
Define contract
    ↓
Data / domain
    ↓
Authorization / security
    ↓
Service / business logic
    ↓
UI / UX
    ↓
Automated tests
    ↓
DEV verification
    ↓
Documentation
    ↓
Focused commit
```

Not:

```text
Build all database code
    ↓
Build all services
    ↓
Build all UI
    ↓
Test everything at the end
```

The vertical-slice approach allows every completed slice to leave the application in a usable and testable state.

---

# 3. Why This Approach

MoneyWhere is being developed with LLM-assisted coding.

LLMs perform more reliably when work has:

* a clearly bounded objective
* explicit constraints
* visible dependencies
* concrete acceptance criteria
* immediate feedback
* limited unrelated changes

Therefore, features should be implemented as **small complete slices** rather than large open-ended phases.

The approach also reduces:

* speculative infrastructure
* large untested changes
* accidental architectural drift
* security regressions
* difficult debugging
* unclear completion states

---

# 4. The Standard Slice Lifecycle

Every feature or significant change should follow this lifecycle:

```text
1. Reconnaissance
2. Contract
3. Plan
4. Implement
5. Test
6. Verify
7. Document
8. Commit
9. Gate
```

Do not skip steps simply because the change appears small.

---

# 5. Step 1 — Reconnaissance

Before modifying code, the LLM must understand the existing implementation.

Inspect:

* `01-APP-SPEC.md`
* relevant `02-ROADMAP.md` section
* relevant `03-CHANGELOG.md` entries
* existing implementation
* related services
* related components
* related database migrations
* RLS policies
* existing tests
* existing validation/utilities
* existing offline mechanisms

Search before creating new abstractions.

### Output

Before implementation, identify:

```text
Current behavior
Relevant files
Existing reusable systems
Missing functionality
Dependencies
Security considerations
Potential risks
```

Do not immediately start coding after receiving a feature request.

---

# 6. Step 2 — Define the Contract

Before implementation, define the behavior being added.

Every slice should establish:

## User outcome

What can the user do after this change?

## Data contract

What data is created, read, modified, or deleted?

## Authorization

Who can perform each operation?

## Validation

What inputs are valid?

## State transitions

What happens before, during, and after the operation?

## Offline behavior

What happens:

* online?
* offline?
* with pending outbox changes?
* after reconnect?

## Failure behavior

What happens when:

* validation fails?
* authorization fails?
* network fails?
* database operation fails?
* synchronization fails?

## Acceptance criteria

Define concrete pass/fail conditions.

---

# 7. Step 3 — Create the Smallest Complete Slice

Implement only what the current slice requires.

Prefer existing architecture.

Typical implementation order:

```text
Domain/data contract
        ↓
Database/security
        ↓
Service/business logic
        ↓
UI/UX
        ↓
Integration
        ↓
Tests
```

The exact order may change when another order is more appropriate.

Do not create speculative infrastructure for future roadmap items.

---

# 8. Step 4 — Automated Testing

Tests must be created alongside implementation.

Test at the appropriate layers.

## Unit tests

Use for:

* calculations
* validation
* transformations
* filtering
* business rules
* pure functions

## Service tests

Use for:

* data loading
* mutations
* integration behavior
* error handling

## RLS/security tests

Required when a feature changes:

* data visibility
* ownership
* membership
* authorization
* database access

## Regression tests

Existing behavior must remain protected.

Run the complete test suite before marking a slice complete.

---

# 9. Step 5 — Verification

Every slice must pass the appropriate verification layers.

## Required

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

## When applicable

Perform DEV browser verification.

Browser verification should test the actual user workflow rather than only checking that the page renders.

Example:

```text
Open feature
    ↓
Perform action
    ↓
Verify result
    ↓
Reload
    ↓
Verify persistence
    ↓
Test relevant permission
    ↓
Test relevant error state
```

---

# 10. Step 6 — Documentation

After implementation:

Update `03-CHANGELOG.md`.

Document:

* feature/change
* important decisions
* migrations
* security changes
* verification
* known limitations

Do not document planned behavior as implemented behavior.

Do not add unrelated documentation cleanup to a focused feature commit unless necessary.

---

# 11. Step 7 — Focused Commit

Each completed slice should have a focused Git commit.

A commit should contain:

* the feature
* its tests
* necessary documentation
* necessary migrations

Avoid mixing:

* unrelated refactors
* unrelated formatting
* unrelated bug fixes
* speculative improvements

Before committing:

```bash
git status
git diff
git diff --check
```

Review the actual diff.

Never assume the diff contains only intended changes.

---

# 12. Step 8 — Completion Gate

A slice is complete only when:

```text
Implementation
      +
Tests
      +
Typecheck
      +
Lint
      +
Build
      +
Required DEV verification
      +
Documentation
      +
Focused commit
      =
COMPLETE
```

If a required verification step has not happened, the feature is not fully complete.

It may be:

```text
IMPLEMENTED — VERIFICATION PENDING
```

but should not be marked complete.

---

# 13. Production Gate

Production verification is a separate stage.

For production-sensitive features:

```text
Local
  ↓
Automated tests
  ↓
DEV
  ↓
Focused commit
  ↓
Push
  ↓
Deployment verification
  ↓
Production smoke test
  ↓
Production verification
  ↓
Feature closed
```

Production verification is especially important for:

* authentication
* authorization
* RLS
* data export
* account deletion
* destructive operations
* data migration
* security-sensitive behavior

Never claim production success without evidence.

---

# 14. Security Rules

Security is part of the vertical slice.

It is not a final cleanup task.

Whenever data access changes, consider:

```text
Database
    ↓
RLS / authorization
    ↓
Service
    ↓
UI
```

All layers must agree.

## Never

* trust UI-only authorization
* weaken RLS to make a feature work
* expose service-role credentials
* accept arbitrary user IDs for privileged operations
* bypass existing authorization
* expose private fields unnecessarily

## Always

* validate authorization server-side
* test outsider access
* test signed-out access when relevant
* test member/owner differences
* test destructive operations carefully

---

# 15. Data Ownership and Privacy

Every feature that exposes user data must explicitly answer:

> What data should this user be allowed to see?

Do not export or expose fields merely because they exist in the database.

Prefer explicit field selection over spreading entire database objects.

For sensitive features:

```text
Database row
    ↓
Allowed fields
    ↓
Domain object
    ↓
UI/export/API
```

This prevents accidental data leakage when the database model gains new fields later.

---

# 16. Money Handling Rules

MoneyWhere uses integer minor units.

All monetary implementation must:

* use integer minor units
* preserve currency
* avoid floating-point money calculations
* reuse existing money helpers
* validate positive/negative rules according to transaction type
* use safe integer handling

Do not introduce a second money representation.

---

# 17. Offline-First Rules

Offline behavior must be intentionally designed.

For every relevant feature, document:

```text
Offline:
Online:
Pending outbox:
Reconnect:
```

Determine whether the feature:

* works offline
* queues mutations
* requires fresh server data
* uses cached data
* must be disabled offline

Never assume that an online-only feature should automatically use stale local data.

Never export or mutate the offline outbox unless the product specification explicitly requires it.

---

# 18. Database and Migration Rules

When database changes are required:

1. Understand the existing schema.
2. Inspect existing migrations.
3. Identify affected RLS policies.
4. Design the smallest safe migration.
5. Test locally/DEV.
6. Verify existing regression tests.
7. Document the migration.
8. Only then consider production.

Never modify production schema directly as a shortcut.

Avoid destructive migrations unless explicitly required.

---

# 19. RLS Rules

When a feature changes data access:

Test at least the relevant combinations:

```text
Owner
Member
Former member
Outsider
Signed-out user
```

Not every feature requires every role, but the authorization boundary must be explicitly tested.

A feature is not secure merely because the UI hides an action.

---

# 20. Reuse Before Abstraction

Before creating:

* service
* hook
* utility
* validation function
* component
* database helper

search the repository for an existing equivalent.

Prefer:

```text
existing abstraction + small extension
```

over:

```text
new abstraction + duplicated behavior
```

However, do not force unrelated features into a shared abstraction simply for theoretical reuse.

---

# 21. Avoid Scope Creep

During implementation, the LLM will often discover unrelated issues.

Classify them:

### Required

Needed for the current feature to work correctly.

→ Fix now.

### Blocking

Prevents safe implementation or verification.

→ Fix now.

### Related improvement

Useful but not required.

→ Record for later.

### Unrelated

Not connected to the current feature.

→ Do not change.

This protects focused commits and reduces LLM drift.

---

# 22. Handling Ambiguity

If the PRD/spec does not define behavior and the decision materially affects:

* data model
* permissions
* money calculations
* destructive actions
* privacy
* user-visible behavior

STOP and ask for clarification.

Do not invent business rules.

For minor implementation details, prefer existing project conventions.

---

# 23. Existing Behavior Is a Constraint

Before changing an existing feature:

1. Identify current behavior.
2. Identify tests protecting it.
3. Determine whether the new requirement intentionally changes it.
4. Preserve behavior unless the specification explicitly changes it.

Never assume that a cleaner implementation is automatically a correct implementation.

---

# 24. Regression Discipline

After each significant feature:

```bash
npm test
```

must pass across the entire suite.

Do not rely only on newly added tests.

A feature that passes its own tests but breaks existing functionality is not complete.

---

# 25. Browser Verification Discipline

For UI features, automated tests are not enough.

Verify:

* correct navigation
* loading state
* empty state
* success state
* error state
* permissions
* persistence
* mobile behavior when relevant
* offline behavior when relevant

Do not perform destructive production testing unnecessarily.

Use disposable DEV data/accounts for destructive workflows.

---

# 26. Test Data Discipline

DEV test data should be:

* clearly identifiable
* disposable
* minimal
* cleaned up when practical

Do not pollute production with test data.

Do not give an LLM production credentials merely to perform routine verification.

---

# 27. Commit and Deployment Separation

A commit does not mean deployment.

Track these separately:

```text
Implemented
    ↓
Tested
    ↓
Committed
    ↓
Pushed
    ↓
Deployed
    ↓
Production verified
```

Each state must be reported accurately.

---

# 28. LLM Implementation Task Format

When creating a task for Claude Code, use this structure:

```markdown
# [Feature / Slice]

## Objective

[User-visible outcome]

## Context

[Relevant specification and roadmap sections]

## Existing Implementation

[Relevant files/systems]

## Dependencies

[Prerequisites]

## Scope

[What must be implemented]

## Out of Scope

[What must not be changed]

## Contract

### Data

[Data rules]

### Authorization

[Permission rules]

### UX

[UI behavior]

### Offline

[Offline behavior]

### Errors

[Failure behavior]

## Implementation

[Expected vertical slice]

## Tests

[Required automated tests]

## DEV Verification

[Browser checks]

## Acceptance Criteria

[Pass/fail conditions]

## Stop Conditions

[When Claude must stop]

## Documentation

[Required documentation]

## Commit

[Expected commit behavior]

## Final Report

[Required report format]
```

This format should be used for future Claude Code implementation tasks.

---

# 29. Standard Claude Code Completion Report

Claude should finish each implementation task with:

```markdown
## Summary

[What was implemented]

## Files Changed

[List]

## Tests

[X passed / Y files]

## Typecheck

[Result]

## Lint

[Result]

## Build

[Result]

## DEV Verification

[What was manually verified]

## Security / RLS

[Changes, if any]

## Database

[Migrations, if any]

## Known Limitations

[Anything intentionally not verified]

## Commit

[Commit hash]

## Deployment

[Not pushed / pushed / deployed / production verified]

## Status

[COMPLETE / IMPLEMENTED — VERIFICATION PENDING / BLOCKED]
```

Claude must not claim `COMPLETE` if a required gate remains unfinished.

---

# 30. Feature Dependency Discipline

Before implementing a roadmap feature, verify its dependencies.

Do not bypass incomplete foundations.

For example:

```text
Authentication
      ↓
Wallets
      ↓
Membership
      ↓
Accounts
      ↓
Transactions
      ↓
Budgets
      ↓
Export
      ↓
Account deletion
```

A dependent feature may only proceed when its prerequisite provides the behavior it requires.

---

# 31. Roadmap vs Implementation Plan

Do not duplicate the entire roadmap in this document.

`02-ROADMAP.md` answers:

> What are we building?

This document answers:

> How should an LLM build it?

When the roadmap changes, update the roadmap.

When the implementation methodology changes, update this document.

When implementation occurs, update the changelog.

---

# 32. Current Execution Rule

At any point, determine the next task from:

```text
01-APP-SPEC.md
        +
02-ROADMAP.md
        +
03-CHANGELOG.md
        +
current repository state
        +
04-LLM-IMPLEMENTATION-PLAN.md
```

Do not blindly follow an old plan if the repository has moved ahead.

Before starting a new feature:

1. Inspect current Git state.
2. Inspect latest changelog.
3. Inspect relevant roadmap item.
4. Inspect specification.
5. Confirm dependencies.
6. Create the smallest appropriate vertical slice.
7. Implement and verify it.
8. Commit it.
9. Update the changelog.
10. Continue only after the gate passes.

---

# 33. The Most Important Rule

> **Build small, complete, verifiable slices instead of large amounts of unverified code.**

For every feature, prefer:

```text
Understand
→ Contract
→ Implement
→ Test
→ Verify
→ Document
→ Commit
→ Gate
```

over:

```text
Plan everything
→ Generate everything
→ Test at the end
```

The purpose of this methodology is not merely to make development organized.

It is to make **LLM-assisted development predictable, reviewable, reversible, and safe.**

---

# 34. Definition of Done

A MoneyWhere feature is considered fully complete only when:

* implementation satisfies the specification
* required tests pass
* regression tests pass
* typecheck passes
* lint passes
* production build passes
* required DEV verification passes
* security boundaries are verified
* offline behavior is verified when applicable
* changelog is updated
* focused commit exists
* deployment status is accurately reported
* production verification is complete when required

Until then, use an explicit intermediate status:

```text
IMPLEMENTED — VERIFICATION PENDING
```

Never silently treat unverified work as complete.
