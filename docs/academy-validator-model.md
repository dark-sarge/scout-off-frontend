# Academy/organization validator accounts: design

Design notes for how several validator wallets can act on behalf of one
academy/organization identity (issue #663), implemented in
`server/src/academyService.js` + `server/src/routes/academies.js`,
`lib/api.ts`'s academy functions, `components/admin/AcademyManager.tsx`,
and `components/player/ValidatorChip.tsx`.

## Problem

Validator authorization on-chain (`add_validator`/`remove_validator`/
`is_validator`/`approve_milestone`/`revoke_milestone` in `lib/contract.ts`)
is strictly one Stellar wallet = one validator identity. Real academies
have several staff (head coach, assistant coaches, academy director) who
all need to approve milestones on behalf of the same institution, and there
was no way to represent "this validator wallet represents Academy X"
anywhere in the frontend's data model.

## The split: on-chain stays untouched, academies are an off-chain overlay

**On-chain (unchanged):** `add_validator`/`remove_validator`/`is_validator`
remain single-address primitives, and `approve_milestone`/
`revoke_milestone` remain single-signing-wallet transactions. The contract
has no concept of an "academy" and this design doesn't ask it to. Every
academy member wallet must still be individually authorized via
`add_validator` for its milestone approvals to be valid — an academy record
grants no on-chain authorization by itself.

**Off-chain (new):** `server/` (the existing Node/Express + better-sqlite3
service that already backs referrals) gains two tables:

```
academies         (id, name, owner_wallet, created_at)
academy_members   (wallet PRIMARY KEY, academy_id, added_at, added_by)
```

A wallet maps to **at most one** academy at a time (`wallet` is the primary
key on `academy_members`) — this models real institutional staff, not
individuals holding simultaneous membership in several academies. The
roster is purely a _label_: "wallet G... is a registered signer for Academy
X." It has no bearing on whether that wallet can actually call
`approve_milestone` — that's decided entirely on-chain, independently.

Why keep these separate instead of, say, extending the contract to store an
academy tag per validator? Two reasons:

1. **Blast radius.** A contract migration is expensive to deploy and risky
   to get wrong; an off-chain label is a schema migration on a service that
   already exists and already owns comparable off-chain, wallet-keyed data
   (referral codes).
2. **Decoupled failure modes.** If the off-chain roster service is down,
   on-chain validator authorization (the security-critical half) is
   completely unaffected — milestones can still be approved/revoked exactly
   as before. The academy grouping degrades to "no academy label shown,"
   never to "validators can't do their job."

## Admin flow

Today's authorization model is a single super-admin
(`NEXT_PUBLIC_ADMIN_ADDRESS`, checked both client-side in
`app/[locale]/admin/page.tsx` and server-side via the `session` cookie in
`app/api/admin/**` routes) — there is no scoped/delegated admin role. Rather
than invent a second authorization system for "academy owners" managing
their own roster (a materially larger change with its own security surface),
academy creation and membership changes go through the **same** super-admin
gate as the existing "Add/Remove Validator" section, via
`app/api/admin/academies/**` proxy routes that check the session cookie
before forwarding to the `server/` service.

The admin UI (`AcademyManager`, rendered directly below the existing
Validators section on the admin page) is intentionally **not** wired to
also call `add_validator`/`remove_validator` when a wallet is added to or
removed from an academy. Adding a wallet to an academy and authorizing it
on-chain are two separate admin actions:

1. Add the wallet as a validator (existing "Add Validator" section — on-chain).
2. Add the wallet to an academy (new "Academies" section — off-chain label).

`AcademyManager` cross-checks each member's on-chain status via
`checkIsValidator` and shows a `not on-chain` badge next to any member
wallet that isn't (yet, or no longer) an authorized validator, so an admin
who only does step 2 gets a visible nudge rather than a silent gap. This
also means removing a wallet from an academy does **not** revoke its
on-chain validator status — those stay independent by design; an admin who
wants both must do both, deliberately.

## Milestone attribution display

`Milestone.validator` (types/index.ts) still records the single on-chain
signing wallet — that doesn't change. `ValidatorChip` (rendered per
milestone by `MilestoneList`/`MilestoneTimeline`) now additionally calls
`fetchAcademyForWallet(address)` (`GET /academies/wallet/:wallet`, public
and unauthenticated) and shows the academy's name instead of the bare
wallet when one is found — e.g. "FC Sahel · Active validator · 12
milestones approved" instead of "GABC…WXYZ · Active validator". The lookup
fails open: a down roster service or a wallet with no academy just falls
back to the address-only display that existed before this feature, exactly
like the existing `fetchValidatorMilestoneCount` indexer lookup already
does.

## Backward compatibility

Nothing about existing single-wallet validator flows changes:

- `ApproveForm`/`RevokeForm`/`ValidatorPlayerSearch` are untouched.
- `useValidator`'s `isValidator` check is untouched — it's still a flat
  on-chain roster membership check, unaware of academies.
- A solo validator with no academy record behaves identically to today:
  `fetchAcademyForWallet` returns `null`, and `ValidatorChip` falls back to
  address-only display.

## API surface

| Route                                                                                    | Auth        | Purpose                                                                                      |
| ---------------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------- |
| `POST /academies` (via `/api/admin/academies`)                                           | super-admin | Create an academy; owner wallet becomes its first member                                     |
| `GET /academies` (via `/api/admin/academies`)                                            | super-admin | List all academies with their members, for the admin panel                                   |
| `POST /academies/:id/members` (via `/api/admin/academies/:id/members`)                   | super-admin | Register an additional signer wallet under an academy                                        |
| `DELETE /academies/:id/members/:wallet` (via `/api/admin/academies/:id/members/:wallet`) | super-admin | Remove a signer wallet's academy membership (off-chain only)                                 |
| `GET /academies/wallet/:wallet`                                                          | public      | Look up the academy (if any) a wallet is registered under, for milestone-attribution display |

## Academy milestone rollup (issue #1172)

`GET /api/admin/academies/rollup?rangeDays=<7|30|90|all>` answers the
aggregate question the previous section flagged as unimplemented: total
milestones approved across all of an academy's registered signer wallets,
for a given time range. Surfaced on `AcademyManager` as a per-academy badge
next to the signer count, with a range selector.

**Why this route, not a new endpoint on either backend service:** the
indexer (`packages/indexer`, SQLite event store) and `server/`'s academy
service (a separate Node/Express process, its own SQLite DB) can't query
each other's data. This route is the one place that already talks to both
(matching `app/api/admin/health/route.ts`'s pattern): it fetches
`GET /academies` from `server/` for the wallet→academy roster (including
each member's `addedAt`), then calls the indexer's new
`POST /validators/approval-counts` — which groups `milestone_approved`
events by validator wallet in one indexed SQL query
(`EventStore.getApprovalCountsForWallets`) — and sums each academy's
member wallets' counts here.

**Performance:** `getApprovalCountsForWallets` filters via the
`(validator, event_type, timestamp)` index rather than scanning the whole
`events` table, and the indexer memoizes identical `(range, wallet set)`
requests for 30 seconds (cleared immediately on the next ingested
`milestone_approved` event) so a dashboard re-render or several academies
sharing a range don't each trigger a fresh query.

**Historical-attribution limitation:** `academy_members` has no
`removed_at`/tombstone — `removeMember` hard-deletes the row (see
`server/src/academyService.js`, `server/src/db.js`). This rollup uses each
current member's `added_at` as a lower bound, so it correctly excludes
approvals from **before** a wallet joined its academy — it is not the naive
"current member list x all-time approvals" the previous section warned
against. It cannot, however, exclude approvals a wallet made **after**
being removed from an academy, because a removed wallet has no
`academy_members` row left to resolve `since` from at all: instead of being
misattributed, a removed wallet's entire history — including approvals made
while it *was* a legitimate member — silently drops out of that academy's
total the moment it's removed. In practice, removal is rare relative to
roster churn happening within the queried range, so this undercount is the
deliberately safer failure mode versus overcounting, but it does mean the
number can dip when a wallet is removed rather than only ever going up.
Fully correct historical attribution would need `academy_members` to retain
removed rows with a `removed_at` timestamp instead of deleting them — not
implemented here to avoid a schema migration beyond what this issue's scope
calls for; a natural follow-up if roster turnover turns out to be common
enough to matter in practice.

## What this doesn't do

- No self-service academy-owner UI. An academy's `ownerWallet` is recorded
  but not yet authorization-checked against anything — today only the
  super-admin can manage rosters. Turning `ownerWallet` into an actual
  scoped-admin role is a larger, separate authorization change.
