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

The platform super-admin (`NEXT_PUBLIC_ADMIN_ADDRESS`, checked both
client-side in `app/[locale]/admin/page.tsx` and server-side via the
`session` cookie in `app/api/admin/**` routes) can still manage every
academy's roster, unchanged. Academy *creation* remains super-admin-only —
`POST /api/admin/academies` and the full-listing `GET /api/admin/academies`
are unreachable by anything but the super-admin, deliberately: issue #1173
scoped the first version of the academy-owner role conservatively to roster
add/remove, not academy self-service.

On top of that, an academy's recorded `ownerWallet` can now manage that one
academy's own roster (issue #1173) — this is an *additive* second role, not
a replacement for the super-admin gate. `lib/academyAuth.ts`'s
`resolveAcademyRole`/`requireAcademyManager` do the session-to-role
resolution: a connected wallet is the super-admin if it matches
`NEXT_PUBLIC_ADMIN_ADDRESS`, or an academy-owner if the backend's new
`GET /academies/owner/:wallet` lookup (`academyService.listAcademiesByOwnerWallet`)
finds it recorded as `ownerWallet` on one or more academies, or neither (in
which case every route below rejects it). The backend lookup failing (or
erroring) resolves to "no role," not "allow" — this fails closed, unlike
the enrichment-only `fetchAcademyForWallet` lookup below which fails open.

`app/api/admin/academies/[id]/members/route.ts` (add a signer) and
`.../[id]/members/[wallet]/route.ts` (remove a signer) now authorize via
`requireAcademyManager(req, id)` instead of the flat `requireAdminWallet`:
the super-admin passes for any `id`; an academy-owner passes only when
`id` is one of the academy ids `resolveAcademyRole` found for their
wallet — an owner can never reach another academy's roster through these
routes, by construction rather than by an extra runtime check. A new
`GET /api/admin/academies/mine` route lets a connected wallet discover
which academy/academies (if any) it owns, without needing the
super-admin-only full list.

The scoped UI lives at `/academy/roster`
(`components/academy/AcademyOwnerRoster.tsx`), gated only to "any
authenticated wallet" the way `/academy/bulk-import` is — the real
authorization happens server-side as described above, so an owner-less
wallet loading the page simply sees an empty state. This is deliberately a
separate, smaller page from the super-admin `AcademyManager` component
(`/admin`), which keeps the create-academy flow and the full cross-academy
list.

**Compromised or departed owner wallet:** the super-admin's override above
is the answer — since `requireAcademyManager` always accepts the
super-admin regardless of `ownerWallet`, the super-admin can add/remove
signers (including replacing the compromised wallet's own membership) on
any academy at any time. There is no separate "transfer ownership" flow in
this first version; changing an academy's recorded `ownerWallet` itself
remains a direct database operation, same as it was before this role
existed — only roster management was delegated, per the issue's scope.

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
| `POST /academies/:id/members` (via `/api/admin/academies/:id/members`)                   | super-admin or that academy's owner | Register an additional signer wallet under an academy                       |
| `DELETE /academies/:id/members/:wallet` (via `/api/admin/academies/:id/members/:wallet`) | super-admin or that academy's owner | Remove a signer wallet's academy membership (off-chain only)                |
| `GET /academies/wallet/:wallet`                                                          | public      | Look up the academy (if any) a wallet is registered under, for milestone-attribution display |
| `GET /academies/owner/:wallet` (via `/api/admin/academies/mine`)                         | any authenticated wallet (returns only academies *that* wallet owns) | Session-to-role resolution for the academy-owner UI (issue #1173) |

## What this doesn't do

- No aggregate "academy reputation" (e.g. total milestones approved across
  all of an academy's wallets) — `fetchValidatorMilestoneCount` stays
  per-wallet. Building an academy-scoped rollup would need a new indexer
  query grouping by wallet-to-academy, layered on top of
  `packages/indexer`'s event store (see issue #662) — a natural follow-up,
  not required for the roster/attribution use case this issue asks for.
- No academy-*creation* self-service — an academy-owner can manage their
  own roster (see "Admin flow" above, issue #1173) but only the super-admin
  can create new academies or reassign an `ownerWallet`. Building that out
  is a natural follow-up, not required for the roster-delegation use case
  this issue asked for.
