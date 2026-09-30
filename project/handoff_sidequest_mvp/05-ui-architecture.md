# 5. UI architecture

Two clients. One React Native binary carrying both roles, and a Next.js console for staff.

## 5.1 Design tokens

Taken from the Organic design system as applied in the prototypes. These are the only colour
values in the codebase; `apps/mobile/src/theme/tokens.ts` and the console's CSS variables both
read from one generated file.

| Token | Value | Used for |
| --- | --- | --- |
| `bg` | `#f5ead8` | App ground |
| `surface` | `#f9f4ed` | Cards, sheets |
| `surfaceSunk` | `#ebddc5` | Inset rows, inputs, item chips |
| `border` | `#dcd3c4` | Card borders |
| `borderSoft` | `#ece0ca` | Row rules |
| `borderSunk` | `#e2d5bd` | Rules on sunk surfaces |
| `text` | `#201e1d` | Primary text |
| `textBody` | `#3b3730` | Body copy |
| `textMuted` | `#645c50` | Secondary |
| `textFaint` | `#82796a` | Labels, eyebrow text |
| `accent` | `#c67139` | Terracotta — primary accent |
| `accentDeep` | `#8c491a` | Primary buttons, accent text at body size |
| `accentTint` | `#fff2eb` | Exception cards, alert grounds |
| `accentEdge` | `#ffc6a5` | Exception card borders |
| `accent2` | `#7a8a5e` | Sage — success, on-time, verified |

Type: **Caprasimo** for headings and button labels, **Figtree** for everything else.
Scale (mobile): 11 eyebrow / 12 meta / 13.5 body / 15 button / 17 screen title / 22 hero.
Radii: 20 sunk rows, 22 sheets, 26–28 cards, 999 buttons and inputs.
Spacing: 20px screen gutter, 12px between cards, 8–10px within a card.

**Hard constraints.** Every tap target is at least 44×44. Every string goes through `useT()`;
`en.json` and `sw.json` must stay key-identical, checked in CI. Nothing is communicated by
colour alone — the exception state carries an icon and a label as well as the terracotta tint.

## 5.2 Mobile navigation

```
RootNavigator
├── (unauthenticated)  Splash → Phone → OtpCode → RoleChoice
├── KycStack           TierIntro → Documents → Selfie → [tier 3] Conduct, NextOfKin, Movement → Pending
├── RequesterTabs      Home · Post · Activity · Wallet · Profile
├── RunnerTabs         Feed · Active · Earnings · Profile
└── Modals             LiveErrand, StallApproval, Chat, QrHandover, Sos, Dispute
```

`LiveErrand` is a full-screen modal rather than a tab, for both roles. An errand in flight is a
mode, not a place — the user should not be able to navigate away from a decision by accident.

## 5.3 Screens

**Requester**

| Screen | Purpose | Notes |
| --- | --- | --- |
| Home | Live errands, quick repost, regulars | Live cards show timer and stall progress |
| Post | Compose errand | Stepper: kind → stalls & items → dropoff → cap → timer & bonus |
| Bids | Blind auction | Count only until close, then ranked list with fee, ETA, completed count |
| LiveErrand | Watch the run | Timeline of stalls; tapping a photographed stall opens StallApproval |
| StallApproval | **The money screen** | Photo, itemised prices, running total against remaining cap, three actions: Approve, Substitute, Decline |
| ExceptionCard | Retake exhausted / reimbursement request / card declined | Terracotta tint, one decision, no dismiss |
| QrHandover | Show rotating QR | 60s rotation, large, high contrast |
| Wallet | Balance, escrow per errand, top-up | |
| Dispute | File and track | |

**Runner**

| Screen | Purpose | Notes |
| --- | --- | --- |
| Feed | Open errands | Distance, cap, deadline, bonus; never other bids |
| BidSheet | Place a sealed bid | Fee, ETA, note. Shows only the guide ceiling |
| Active | Current errand or batch | Batch shows per-errand cards, never a merged basket |
| StallRun | Work one stall | Item checklist, price entry, camera, submit |
| SpendNow | Card ready | Shows PAN reveal for tap/enter, countdown, ladder fallback state |
| Earnings | Fees, bonuses, reimbursements owed, cash out | |

## 5.4 State

**Server state is react-query.** Query keys are `['errand', id]`, `['feed', filters]`,
`['tranches', errandId]`. No errand data lives in a store. `staleTime` 30s for lists, 0 for the
live errand.

**Client state is Zustand, three slices only:** `session` (tokens, role, language),
`draft` (in-progress errand composition, persisted), `queue` (pending offline uploads).

**Live updates** come over the WebSocket and invalidate query keys. Every socket event has a
polling equivalent, so a dropped socket degrades to a 5-second poll on the active errand and
nothing else.

**Offline.** Photos are written to the device queue with their EXIF timestamp and location,
then uploaded on reconnect; the UI shows them as pending with a spinner, not as failures. Price
entry and item ticks are optimistic. Approvals are **never** optimistic — money only moves on a
server acknowledgement.

## 5.5 The approval interaction, precisely

The single most important interaction in the product.

1. Requester taps a photographed stall. Sheet rises 280ms `cubic-bezier(.2,.7,.3,1)`.
2. Photo at top, 16:9, `.washed` treatment, radius 26. Tap to zoom full screen.
3. Items list on `surfaceSunk` rows: label, qty, unit, price. Substituted items carry a sage
   tag reading the original label.
4. Running total in Caprasimo 22px, with `remaining cap` beneath in `textFaint` 12px. If the
   total exceeds the remaining cap the total turns `accentDeep` and Approve is disabled with an
   inline explanation — never a silent disabled button.
5. Approve is a full-width pill, `accentDeep` fill, `#fff2eb` label, 52px tall.
6. On tap: button enters a loading state and stays disabled. The request returns `202` and the
   sheet switches to a "loading the card" state with the tranche amount.
7. `tranche.loaded` closes the sheet and marks the stall done in sage.
8. `tranche.failed` replaces the sheet body with the ladder state — what was tried, what
   happens next, and the one action the requester can take. It does not dismiss itself.

## 5.6 Console

Next.js App Router, server components for every list, client components only for the ruling
form and the evidence viewer. Three routes matter: `kyc`, `disputes`, `errands/[id]`.

The errand trace page is the operational heart: postings, tranches and attempts in one
chronological table with provider references, so an operator can answer "where is the money"
in one screen. Every evidence view writes an audit row. The ruling form requires a rationale of
at least 40 characters and shows the escrow split arithmetic live before submission.
