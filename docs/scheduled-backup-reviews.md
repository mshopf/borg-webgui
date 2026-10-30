# Scheduled backup review record

The implementation is reviewed separately from the implementation work, with a
maximum of five review/fix rounds. Reviews examine the entire feature against
base commit `694f693`, with emphasis on permissions, retention, scheduling,
repository/index identity, cancellation, process cleanup and credentials.

## Round 1

Eight actionable findings; all addressed:

1. Resolve filesystem repositories against the service working directory so
   restore execution uses the same repository as backup creation.
2. Bind restore indexes to repository identity, hide mismatches immediately and
   rebuild into a fresh tree before publishing an index for another repository.
3. Keep a separate editing revision on every admin form, including when another
   form is saved or the list is refreshed.
4. Persist queued cancellation immediately so a cancelled backup no longer blocks
   edits or another run while earlier work is still executing.
5. Use dictionaries without prototypes for tree and watcher IDs.
6. Preserve errors from malformed/unreadable legacy configuration during setup;
   create defaults only when no legacy configuration exists.
7. Stop and await a child process when its log sink fails.
8. Preserve surrogate pairs at streaming log-redaction boundaries.

Validation: TypeScript 7 checking, typed ESLint and all 25 tests pass. Regression
coverage includes repository changes with identical archive names, live HTTP tree
invalidation and the ID `constructor`, stale-form conflicts, immediate queued
cancellation, migration rejection, a failing writable sink, and Unicode redaction.

## Round 2

Three actionable findings; all addressed:

1. Signal a POSIX process group even after its leader exits, so cancellation also
   kills descendants retaining inherited output pipes.
2. Apply per-form revisions to user/credential deletion as well as saving. This
   completes the stale-form fix from round 1.
3. Add main-page Cancel controls for queued/running backups visible to accounts
   with Run permission, without requiring administrator access.

Validation: TypeScript 7 checking, typed ESLint and all 29 tests pass. Added
regressions for a process whose parent exits before cancellation, stale user and
credential deletion, and a non-administrator cancelling from the main page.

## Round 3

Separate review pending after the round-2 fixes.
