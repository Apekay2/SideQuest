# Side Qwest errand platform design

_Started 2026-08-21 22:09 UTC_

---

## User

Re-engineer the ride-hailing architecture and Design a mobile app called "Side Qwest" for people to request other people to run errands for them at an agreed fee on the platform.  The app should be user friendly and should give reassurance through a KYC registration interface.

## Assistant



## Assistant

_[tool: ask_user]_

Waiting on your answers to the form — the design-system pick, market, and what you want from the "re-engineer the architecture" part matter most.

## User

Answered — Asked for follow-up questions; design_system: Picked a design system (now attached); side: Both, with a role switch; flows: KYC / ID verification onboarding, Post an errand request, Browse & accept errands, Live tracking of runner, Dispute / safety report, Wallet & payouts; market: Kenya (M-Pesa, Shilling); errands: Grocery / market run, Queue standing (bank, embassy), Document drop-off; trust: Heavy: full ID + address + bank match, gated; arch: A system architecture diagram/doc (services, matching, payments); matching: Hybrid: auto-match with option to open bidding; variations: Ho…

## Assistant



## Assistant

_[tool: ask_user]_

Round 2 is up — pre-verification permissions, who sets the fee, safety mechanics, and how deep the architecture doc goes.

## User

Answered — Asked for follow-up questions; gate: Browse only — can look, can't post or accept; fee: Runners bid blind; requester picks from offers; safety: In-app SOS button, Runner face + ID photo shown on match, Handover PIN / code at drop-off, Escrow held until requester confirms; arch_form: Engineer-grade doc: services, data model, matching logic, payment rails

## Assistant



## Assistant

_[tool: ask_user]_

Round 3 is up — bid card contents, escrow timing, and the architecture doc format.

## User

Answered — Asked for follow-up questions; bid_reveal: Full profile: name, photo, rating, jobs done, distance; escrow_timing: Charged at pickup/purchase, runner never fronts cash; doc_shape: Doc plus a separate large architecture diagram screen

## Assistant



## Assistant

_[tool: ask_user]_

Round 4 is up — how the runner pays at the counter, and copy tone.

## User

Answered — pay_at_till: Requester approves an itemised basket in-app, funds release instantly; tone: Warm and neighbourly

## Assistant

_[tool: list_files]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: update_todos]_

_[tool: copy_starter_component]_

_[tool: grep]_

_[tool: read_file]_

_[tool: dc_write]_

_[tool: show_html]_

Now the architecture doc.

_[tool: read_skill_prompt]_

_[tool: copy_starter_component]_

_[tool: dc_write]_

_[tool: dc_write]_

_[tool: update_todos]_

_[tool: ready_for_verification]_

Three files, built on the Organic system:

**Side Qwest App** — interactive prototype in a phone frame. Gated KYC (identity → documents → address/M-Pesa name match → verified), browse-only banner until verified, post a Qwest, blind bids with full runner profiles, live tracking with SOS and handover PIN, itemised basket approval that releases funds, wallet/escrow, and the safety report. Role switch flips to the runner side (open-Qwest feed, blind bid entry). Tweaks switch feed layout, KYC step visuals, offer list style, tracking view, and starting verified state.

**Side Qwest Architecture** — engineer-grade doc: what breaks when you port a ride-hailing stack to errands, service map, schema, the sealed-bid auction and scoring, the authorise-cap-then-capture-at-approval money flow, tiers, safety, NFRs, open risks. Printable as-is.

**Side Qwest Architecture Diagram** — the wide layered map (clients → gateway → four service clusters → event bus → stores/external rails) with the end-to-end errand flow and money invariants down the right.

Grey striped blocks are placeholders for map tiles, ID captures and receipt photos — I can't generate images. Say the word if you want the runner side fleshed out further or the fee-negotiation UI explored as more variants.

## User

What if we have a different payment system per errand. A general one-time virtual card loaded per task and expires when the errand is over. But there is a twist. For market runs, have a shopping basket that the runner ticks out via taking a picture of every item so that the funds can check out at every vendor. For shop items the receipt will be used to verify purchase and direct release of funds. For door dash and document drops, the requester will verify cashout.

## Assistant

Good twist — that changes the money model from one escrow capture to a per-errand card with three release modes. Updating the prototype and the architecture in step.

_[tool: dc_js_str_replace]_

_[tool: dc_js_str_replace]_

_[tool: dc_js_str_replace]_

_[tool: dc_js_str_replace]_

_[tool: dc_js_str_replace]_

_[tool: dc_html_str_replace]_

_[tool: dc_html_str_replace]_

_[tool: dc_html_str_replace]_

_[tool: dc_html_str_replace]_

Now removing the old basket sheet and adding the runner's card screen.

_[tool: dc_html_str_replace]_

_[tool: dc_html_str_replace]_

_[tool: dc_html_str_replace]_

_[tool: dc_set_props]_

Now the escrow/legal-ops framing in the safety screen, and the doc + diagram updates.

_[tool: dc_html_str_replace]_

_[tool: dc_html_str_replace]_

_[tool: dc_html_str_replace]_

_[tool: dc_html_str_replace]_

Understood — I'll keep any private material out of what I write, and I've noted it for this project.

_[tool: write_file]_

_[tool: dc_html_str_replace]_

_[tool: dc_html_str_replace]_

_[tool: dc_html_str_replace]_

_[tool: dc_html_str_replace]_

_[tool: dc_html_str_replace]_

_[tool: dc_html_str_replace]_

_[tool: dc_html_str_replace]_

_[tool: write_file]_

_[tool: dc_html_str_replace]_

_[tool: dc_html_str_replace]_

Now section 7 (escrow + legal operations) and the risks list.

_[tool: dc_html_str_replace]_

_[tool: dc_html_str_replace]_

Now the diagram: money cluster, event topics, flow rail and invariants.

_[tool: dc_html_str_replace]_

_[tool: dc_html_str_replace]_

_[tool: dc_html_str_replace]_

_[tool: dc_html_str_replace]_

_[tool: dc_html_str_replace]_

_[tool: dc_html_str_replace]_

_[tool: ready_for_verification]_

Payment model reworked across all three files.

**App** — the basket-approval sheet is gone; money is now a one-time Qwest card, and release depends on errand type:
- *Market run* — new runner card screen: vendor legs (greens stall, cereals, boda), tap each item to photograph it, then unlock that stall's subtotal onto the card. Requester side just watches the legs release, with a "query an item" escape.
- *Shop pickup* — card charge matched against the receipt, released with no requester action.
- *Queue standing / document drop* — card carries the fee only; requester confirms the handover to cash it out.

Errand type is switchable on the post screen or in Tweaks. Safety screen now states that opening a report freezes escrow and voids the card, and that Legal Operations rules on the evidence pack (item photos, card charges, receipts, PIN + geo-stamp), binding both sides with one review each.

**Doc** — new §5 on card issuance, tranche loading and the three release modes as a table; added `card` and `legal ops` services, vendor-leg/card/dispute schema, and a rewritten §7 on symmetrical escrow and adjudication. Risks now cover card acceptance at informal stalls, gameable photo proof, and issuer dependency. Header and footer mark it restricted to the system administrator.

**Diagram** — money cluster gains the card service, new event topics, the flow rail shows tranche loading and the disputed branch.

I also saved your two confidentiality instructions to the project's CLAUDE.md so they carry into future sessions.

## User

Found issues — fixing…

## Assistant

_[tool: dc_html_str_replace]_

_[tool: dc_html_str_replace]_

_[tool: dc_html_str_replace]_

_[tool: dc_html_str_replace]_

_[tool: ready_for_verification]_

Card number now sits on one line at 23px, and all three files load the Organic bundle in `<helmet>`.

## User

validate the app and ask follow-up questions to refine the build. Please critique so as to get the best output

## Assistant



## Assistant

_[tool: multi_screenshot]_

Fixing the two layout defects I found while probing, then my critique and questions.

_[tool: dc_html_str_replace]_

_[tool: run_script]_

_[tool: dc_html_str_replace]_

_[tool: ask_user]_

**Validation** — I drove the app through every screen. Navigation, the KYC stepper, blind bids, tracking, the runner card and the runner feed all work; photographing items unlocks a stall and the card balance moves 0 → 840 with the tracking panel updating to "1 of 3 stalls released". No console errors. I fixed two real defects: the card's balance figure was wrapping mid-number, and the screen-jump buttons were breaking across lines.

**Critique** — where it's weakest:

*Dead ends.* "Query an item" does nothing, and there's no path for the case the whole model rests on: a photo or price that fails the check. Same for a card declined at the till and an out-of-stock item. Right now the happy path is beautiful and the edges are unbuilt, which is exactly backwards for a payments product.

*The requester lost their job.* Moving market runs to photo-release makes the flow elegant but leaves the requester watching a progress list. That may be right, but it's a decision worth making deliberately rather than inheriting from the mechanic.

*No ending.* Approving jumps to the wallet. There's no completion screen, no rating, no receipt to look back at — so the trust loop that KYC opens never closes.

*Runner side is thinner than requester side.* Heavy KYC was meant to weigh more on runners, and their onboarding is currently identical. No earnings view either.

*Queue standing is a chosen errand type with no design* — it has no goods, no basket, and its real content (a ticket number, a wait, a proxy handover) isn't represented anywhere.

*Accessibility.* Several icon buttons sit at 34px, under the 44px minimum, and the type is tuned for indoors rather than midday sun in a market.

Form's up with the calls I'd need — the proof-failure path and the card-decline recovery are the two that most change the architecture.

## User

Answered — gaps: Exception path when a photo or price is rejected, Card declined at the till (runner is stuck), Messaging thread between the two parties, Runner-specific KYC (heavier than requester), Wallet showing c…; exception: Runner retakes the photo; two failures escalate to the requester; requester_role: Approve every stall; decline: Fall back to an M-Pesa till payment from the same balance; unavailable: Runner proposes a substitute, requester accepts in-app; handover: QR code scan; audience: All three, breadth over depth; polish: Raise all tap targets to 44px, Swahili / English languag…

## Assistant

Building the answers into the prototype. On your open question: yes — that's the right third tier, so the decline ladder is card → platform-initiated M-Pesa till payment from the same balance → requester pays the till directly and escrow reimburses them at close.

_[tool: update_todos]_

_[tool: dc_js_str_replace]_

_[tool: grep]_

_[tool: dc_js_str_replace]_

_[tool: read_file]_

Now the new stall lifecycle logic.

_[tool: dc_js_str_replace]_

_[tool: dc_js_str_replace]_

_[tool: dc_js_str_replace]_

_[tool: dc_js_str_replace]_

_[tool: dc_js_str_replace]_

_[tool: dc_html_str_replace]_

_[tool: dc_html_str_replace]_

Now the requester side: stall approvals and exceptions on the tracking panel.

_[tool: dc_html_str_replace]_

Now QR handover, chat screen, runner KYC, wallet float, skeleton, and language toggle.

_[tool: dc_html_str_replace]_

_[tool: dc_html_str_replace]_

Good addition — batching for top-rated runners, with each errand still carrying its own card. Re-issuing the interrupted edit, then adding it.

_[tool: dc_html_str_replace]_

_[tool: dc_js_str_replace]_

_[tool: dc_js_str_replace]_

_[tool: dc_js_str_replace]_

_[tool: dc_js_str_replace]_

_[tool: dc_js_str_replace]_

Now the template for the timer, batching, wallet float, skeleton and language toggle.

_[tool: dc_html_str_replace]_

_[tool: dc_html_str_replace]_

Now the runner feed: batching, regulars, and time-left tags.

_[tool: dc_html_str_replace]_

_[tool: dc_html_str_replace]_

Now the wallet card-float section, the offers skeleton, and the language toggle on home.

_[tool: dc_html_str_replace]_

_[tool: dc_html_str_replace]_

_[tool: dc_js_str_replace]_

_[tool: dc_html_str_replace]_

_[tool: dc_html_str_replace]_

_[tool: dc_html_str_replace]_

_[tool: dc_html_str_replace]_

Now the ops console.

_[tool: dc_write]_

_[tool: update_todos]_

_[tool: update_todos]_

_[tool: ready_for_verification]_

Everything you asked for is in the prototype, plus the new ops console.

**App** — requester now approves every stall before the card can pay it. Photos that fail get one retake, then escalate to the requester as a decision. Out-of-stock items become a substitute proposal the requester accepts or drops. Card declines offer the full ladder: M-Pesa till from the card balance, or Amina pays the till and escrow reimburses her at close — your suggestion, and it's the better third tier. Handover is now a QR scan. Added a message thread, a tier-3 runner verification screen (good conduct, next of kin, how you move), wallet showing held vs on-card vs still-yours, a bid-collection skeleton, EN/SW toggle, and 44px tap targets.

**Batching** — the runner feed now shows tier-3 eligibility, a "regulars" strip where past requesters invite them directly, and per-Qwest "add to trip" selection. Selecting across regions is refused with a reason. Each Qwest in a batch keeps its own card, approvals and escrow — that isolation is the whole point of the card model, so batching is a trip-planning feature, not a money-pooling one.

**Timers** — requesters set 30 min / 1 h / 2 h / by 6pm with an optional KSh 50 on-time bonus; the tracking screen carries a live countdown that turns amber under 15 minutes.

**Ops console** (new, desktop) — KYC queue, dispute workspace with the evidence pack and the four rulings, and an append-only rulings log. Marked restricted.

I'm at the usage limit for this stretch, so I stopped before folding the new mechanics into the architecture doc and diagram — stall approvals, the decline ladder, batching eligibility, timers and the QR handover are in the app but not yet in the written architecture. Say the word and I'll bring those two documents up to date.

## User

Found issues — fixing…

## Assistant

_[tool: dc_js_str_replace]_

## Assistant

_[tool: dc_js_str_replace]_

_[tool: dc_js_str_replace]_

_[tool: dc_html_str_replace]_

_[tool: dc_html_str_replace]_

Now the last todo: bringing the architecture doc and diagram up to date.

_[tool: dc_html_str_replace]_

_[tool: dc_html_str_replace]_

_[tool: dc_html_str_replace]_

_[tool: dc_html_str_replace]_

_[tool: dc_html_str_replace]_

_[tool: dc_html_str_replace]_

_[tool: dc_html_str_replace]_

_[tool: dc_html_str_replace]_

Now the diagram.

_[tool: dc_html_str_replace]_

_[tool: dc_html_str_replace]_

_[tool: dc_html_str_replace]_

_[tool: dc_html_str_replace]_

_[tool: update_todos]_

_[tool: ready_for_verification]_

All three defects fixed and the architecture is now in step with the app.

Fixes: the countdown chip holds one line (bonus shortened to "+50 on time"); the post-screen money copy now says the card loads only after you approve each stall; and requester-settled legs no longer count as card balance — they appear as a separate line on the card, reimbursed from escrow at close.

Doc and diagram updated for everything added since: requester approval per stall, the retake/escalate and substitution paths, the three-tier decline ladder with its `requester_settled` account, QR handover, deadlines with the on-time bonus, tier 3 for runners, and batching/direct invites — batching described as trip planning, never money pooling.

Four files now: the app, the architecture doc, the wall diagram, and the restricted ops console.

## User

Found issues — fixing…

## Assistant

_[tool: dc_html_str_replace]_

_[tool: ready_for_verification]_

Caption under the phone now matches the built flow: photograph → send → requester approves → card loads that stall.

