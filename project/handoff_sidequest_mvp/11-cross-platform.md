# 11. Cross-platform parity: iOS and Android

One React Native binary already carries both roles. This document says what that binary is
allowed to change between platforms and what it is not, so that the two builds stay
recognisably the same product without either one feeling foreign in the hand.

The design is shown side by side in `Cross-Platform Parity.dc.html` — the requester shell,
the approval sheet and a destructive confirm, on both platforms, with the reasoning against
each difference.

## 11.1 The rule

**Brand is shared. Chrome is native.**

A difference between platforms is legitimate when it matches a convention the user's thumb
already knows: where a create action lives, how a sheet is dismissed, what a press feels
like, which side a confirming button sits on. A difference is illegitimate when it changes
what the product says, or the order it says it in.

Put the other way round: a runner who switches from an Android phone to an iPhone should
recognise the app instantly and never have to relearn their thumb. Those two goals only
conflict if you treat "consistent" as "pixel-identical", which is how cross-platform apps
end up feeling wrong on both.

## 11.2 Shared, from one source

Generated or shared, and unable to drift:

- **Tokens.** Colour, type, radii and spacing all come from `theme/tokens.ts`, generated
  from the Organic design system. Neither platform has a colour of its own.
- **Type.** Caprasimo for headings and button labels, Figtree for everything else, on both.
  Platform system fonts are used for nothing except the status bar the OS draws itself.
- **Every string**, through `useT()`, with `en.json` and `sw.json` key-identical and checked
  in CI.
- **The screen inventory and the navigation graph.** Same screens, same names, same
  relationships. Only the *presentation* of the graph differs.
- **Information order within every screen.** This is the part that matters most for support:
  an operator on a call should never need to ask which phone the user is holding.
- **The money path.** Approval, the decline ladder, settlement. Identical, including copy.
- **Error and empty states**, and what each one offers as the next action.
- **Never colour alone.** Every state carries an icon and a label as well as a tint.

## 11.3 Adapted per platform

Resolved in `mobile/platform/adaptive.ts`, which is the only file permitted to branch on
`Platform.OS`. Everything else imports from it, so a difference is a deliberate entry in one
table rather than a `Platform.select` sprinkled through a screen.

| Concern | iOS | Android |
| --- | --- | --- |
| Requester create action | Fifth tab, *Post* | Four tabs, Post promoted to a FAB |
| Tab bar | 49pt over the 34pt home indicator, icon and label tinted | 80dp, M3 pill indicator behind the active icon |
| Tab label size | 10px | 12px |
| Header | Large title left, collapsing to a centred inline title | M3 large top app bar, stays left |
| Back | Edge swipe, chevron with a label | System back gesture and button, bare arrow |
| Confirms | Action sheet from the bottom | Centred M3 dialog, confirm last on the right |
| Sheet affordance | 44×5 grabber, swipe down | 32×4 drag handle, plus system back |
| Press feedback | Dim to `accent` | Ripple in `accent` from the touch point |
| Primary button | 52pt tall | 56dp tall |
| Screen gutter | 20pt | 16dp |
| Sheet radius | 26 | 28 |
| Motion | 280ms `cubic-bezier(.2,.7,.3,1)` | 300ms M3 emphasised decelerate |
| Pickers | Native wheel for time and date | M3 date and time pickers |
| Share, files, camera roll | System share sheet, Photos | Share intent, Storage Access Framework |

Two of these deserve a note, because they are the ones most likely to be "corrected" later
by someone unifying the codebase:

**The FAB.** Moving *Post* out of the tab bar on Android is the largest visible divergence
in the app. It is correct: Material users look bottom-right for creation, and a five-tab bar
on Android reads as a port. Both keep Post to one thumb-reach, which is the actual
requirement.

**System back.** Any sheet or modal that ignores Android's back gesture feels broken — the
gesture is muscle memory, and when nothing happens the user presses it again and leaves.
`useSystemBack()` exists so every modal handles it, and returns a no-op on iOS so no call
site needs a conditional.

## 11.4 The approval sheet stays identical

The one screen held to pixel parity, in layout and copy:

- Order is fixed: photo, itemised prices, running total, remaining cap, actions.
- The amount appears in the button label, not only in the total.
- Approve is never optimistic on either platform. It enters a loading state, stays disabled,
  and the sheet closes only on `tranche.loaded`.
- Over cap: the total turns `accentDeep`, Approve disables, and an inline sentence says by
  how much. No silent disabled button on either platform.
- `tranche.failed` replaces the sheet body with the ladder state and does not
  self-dismiss.

What still adapts here is only feel: the drag affordance, the press treatment, the button
height, and the haptic. `haptic.moneyCommitted()` is the strongest signal in the set on both
platforms, because approval is the only irreversible action in the product.

## 11.5 Accessibility floor: the stricter of the two, on both

Not a per-platform table. Where the two platforms' guidance differs, the app takes the
stricter number and applies it everywhere.

- **Tap targets**: 48dp everywhere, including on iOS where 44pt would be legal. A market
  trader with wet hands is not reading the guidelines.
- **Text scaling to 200%** without clipping. The approval sheet scrolls; it never truncates
  a price.
- **Every control labelled** for VoiceOver and TalkBack, including the amount on Approve.
- **4.5:1 body contrast** against its own ground, checked on `surfaceSunk` and `accentTint`
  as well as `surface` — the tinted exception card is where this usually slips.
- **Reduce-motion honoured**: the sheet fades instead of rising.
- **Both languages fit** every button at the largest supported text size. Swahili strings run
  longer than English and the Approve label carries an amount, so this is checked at the
  widest case, not the average.

## 11.6 Notifications and permissions

**Channels are an Android concept and a real one.** A runner must be able to silence chat
without silencing "your card is ready". Four channels — money, errand, chat, offers — with
iOS mapping the same separation onto interruption levels, `money` as time-sensitive.

**Both platforms punish a cold permission request**, differently: iOS gives one chance
forever, Android gives two and then "don't ask again". So the in-app rationale screen runs
before the system prompt on both, with shared copy, and every permission has a settings
fallback for the user who has already said no.

## 11.7 What CI should check

Small additions to the Phase 0 pipeline in `code/ci/ci.yml` and `09-appsec-audit.md` §9.5:

1. `en.json` and `sw.json` stay key-identical (already specified in `05-ui-architecture.md`).
2. No `Platform.OS` or `Platform.select` outside `mobile/platform/`. A grep, same shape as
   the "no unscoped transaction in route code" gate.
3. Snapshot the approval sheet on both platforms at default and at 200% text scale — four
   snapshots, and a diff in the *layout order* fails the build.
4. A lint rule requiring `accessibilityLabel` on every `Pressable`.

## 11.8 Open questions for the product owner

Answer these before the mobile build starts in earnest; each one changes work rather than
opinion.

- **Tablet and landscape**: currently unsupported on both. Fine for the pilot, but Android's
  device spread makes a 7-inch tablet more likely than an iPad, and the approval sheet is the
  screen that would need a real answer.
- **Minimum OS versions**: Android's long tail is the harder constraint. A floor of Android 9
  covers most of the Kenyan market; anything higher needs a number from the field.
- **Low-end Android performance**: the location service pushes fixes every few seconds and
  the camera path writes full-resolution photos to a queue. Both need measuring on a device
  a runner actually owns, not a flagship.
- **Dark mode**: not designed on either platform. The Organic palette is warm and light by
  intent; a dark variant is a design exercise, not a token flip.
