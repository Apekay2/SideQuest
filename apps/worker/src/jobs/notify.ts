// apps/worker/src/jobs/notify.ts
// The notify service (06-services.md §6.1). Every message exists in English and Swahili and is
// sent in the recipient's language. In-app delivery is always a `notification` row plus a
// socket event; SMS is added for the messages that must reach someone whose app is closed —
// money arriving, an offer with a 90-second clock, and anything that needs a decision.
//
// Templates are keys and variables, never free text from another user, except the one
// deliberately bounded case (a decline reason, already sanitised by the API).

import { format, money } from '@sidequest/domain/money/money';
import { type Handler, publish, str } from '../context.js';

type Vars = Record<string, unknown>;
type Tpl = { en: (v: Vars) => string; sw: (v: Vars) => string; sms?: boolean };

const kes = (v: unknown) => (typeof v === 'number' ? format(money(v, 'KES')) : '');

export const TEMPLATES: Record<string, Tpl> = {
  'errand.offered': {
    sms: true,
    en: (v) => `You have a new Side Qwest offer for ${kes(v.feeCents)}. Open the app within 90 seconds to accept.`,
    sw: (v) => `Una ofa mpya ya Side Qwest ya ${kes(v.feeCents)}. Fungua programu ndani ya sekunde 90 kuikubali.`,
  },
  'errand.awarded': {
    sms: true,
    en: () => 'You got the errand. Open Side Qwest to start.',
    sw: () => 'Umepata kazi. Fungua Side Qwest kuanza.',
  },
  'offer.declined': {
    en: () => 'Your runner declined. Pick another from the map.',
    sw: () => 'Mkimbiaji amekataa. Chagua mwingine kwenye ramani.',
  },
  'errand.en_route': { en: () => 'Your runner is on the way.', sw: () => 'Mkimbiaji wako yuko njiani.' },
  'errand.shopping': { en: () => 'Your runner has arrived at the market.', sw: () => 'Mkimbiaji amefika sokoni.' },
  'errand.handover': {
    en: () => 'Everything is bought. Show your QR code when your runner arrives.',
    sw: () => 'Kila kitu kimenunuliwa. Onyesha msimbo wako wa QR mkimbiaji akifika.',
  },
  'stall.submitted': {
    sms: true,
    en: () => 'A stall is photographed and waiting for your approval.',
    sw: () => 'Kibanda kimepigwa picha na kinasubiri idhini yako.',
  },
  'stall.declined': {
    en: (v) => `The requester declined a stall: ${String(v.reason ?? '')}`,
    sw: (v) => `Mteja amekataa kibanda: ${String(v.reason ?? '')}`,
  },
  'stall.retake': {
    en: (v) => `Please retake the photo: ${String(v.reason ?? '')}`,
    sw: (v) => `Tafadhali piga picha tena: ${String(v.reason ?? '')}`,
  },
  'card.ready': {
    sms: true,
    en: (v) => `Your card is loaded with ${kes(v.amountCents)}. You can pay now.`,
    sw: (v) => `Kadi yako imewekwa ${kes(v.amountCents)}. Unaweza kulipa sasa.`,
  },
  'ladder.reimbursement_requested': {
    sms: true,
    en: (v) => `The card was declined. Can your runner pay ${kes(v.amountCents)} cash, repaid from your escrow? Answer in 5 minutes.`,
    sw: (v) => `Kadi imekataliwa. Mkimbiaji alipe ${kes(v.amountCents)} taslimu, kurudishwa kutoka escrow yako? Jibu ndani ya dakika 5.`,
  },
  'ladder.pay_cash': {
    en: (v) => `Pay ${kes(v.amountCents)} in cash. It is added to your earnings at handover.`,
    sw: (v) => `Lipa ${kes(v.amountCents)} taslimu. Itaongezwa kwenye mapato yako wakati wa kukabidhi.`,
  },
  'ladder.escalate.no_rung_left': {
    en: () => 'We could not pay this stall. The money is back in your escrow. Decide what to do next.',
    sw: () => 'Hatukuweza kulipa kibanda hiki. Pesa imerudi kwenye escrow yako. Amua hatua inayofuata.',
  },
  'ladder.escalate.confirmation_timeout': {
    en: () => 'No answer on the cash payment, so this stall was not paid. Your money is back in escrow.',
    sw: () => 'Hakuna jibu kuhusu malipo ya taslimu, kibanda hakikulipwa. Pesa yako imerudi escrow.',
  },
  'ladder.escalate.cap_exhausted': {
    en: () => 'This stall is over your spending cap and was not paid.',
    sw: () => 'Kibanda hiki kimezidi kikomo chako cha matumizi na hakikulipwa.',
  },
  'ladder.escalated_wait': {
    en: () => 'Payment for this stall failed. Wait for the requester to decide.',
    sw: () => 'Malipo ya kibanda hiki yameshindwa. Subiri mteja aamue.',
  },
  'errand.handed_over': { en: () => 'Handover complete. Thank you!', sw: () => 'Makabidhiano yamekamilika. Asante!' },
  'errand.settled_runner': {
    sms: true,
    en: (v) => `Errand settled. ${kes(v.amountCents)} added to your earnings.`,
    sw: (v) => `Kazi imelipwa. ${kes(v.amountCents)} imeongezwa kwenye mapato yako.`,
  },
  'errand.settled_requester': {
    en: (v) => `Errand settled. ${kes(v.refundCents)} returned to your wallet.`,
    sw: (v) => `Kazi imelipwa. ${kes(v.refundCents)} imerudishwa kwenye pochi yako.`,
  },
  'errand.expired': {
    en: () => 'No runner took your errand in time. Your deposit is back in your wallet.',
    sw: () => 'Hakuna mkimbiaji aliyechukua kazi yako kwa wakati. Amana yako imerudi kwenye pochi.',
  },
  'errand.cancelled_by_requester': { sms: true, en: () => 'The requester cancelled this errand.', sw: () => 'Mteja ameghairi kazi hii.' },
  'errand.cancelled_by_runner': { sms: true, en: () => 'Your runner cancelled. Your deposit is being returned.', sw: () => 'Mkimbiaji ameghairi. Amana yako inarudishwa.' },
  'message.new': { en: () => 'New message about your errand.', sw: () => 'Ujumbe mpya kuhusu kazi yako.' },
  'dispute.opened': {
    sms: true,
    en: () => 'A report was opened on your errand. Payments are paused while Legal Operations reviews it.',
    sw: () => 'Ripoti imefunguliwa kuhusu kazi yako. Malipo yamesimamishwa wakati Operesheni za Kisheria zinakagua.',
  },
  'dispute.ruled': {
    sms: true,
    en: () => 'Legal Operations has ruled on your report. Open the app to see the outcome.',
    sw: () => 'Operesheni za Kisheria zimetoa uamuzi kuhusu ripoti yako. Fungua programu kuona matokeo.',
  },
  'kyc.approved': {
    sms: true,
    en: (v) => `You are verified to tier ${String(v.tier)}. Karibu!`,
    sw: (v) => `Umethibitishwa kiwango cha ${String(v.tier)}. Karibu!`,
  },
  'kyc.rejected': {
    sms: true,
    en: () => 'We could not verify your documents. Open the app to see why and try again.',
    sw: () => 'Hatukuweza kuthibitisha nyaraka zako. Fungua programu kuona sababu na ujaribu tena.',
  },
  'payout.confirmed': {
    sms: true,
    en: (v) => `${kes(v.amountCents)} sent to your M-Pesa.`,
    sw: (v) => `${kes(v.amountCents)} imetumwa kwa M-Pesa yako.`,
  },
  'payout.failed': {
    sms: true,
    en: (v) => `Your payout of ${kes(v.amountCents)} failed. It is back in your earnings.`,
    sw: (v) => `Malipo yako ya ${kes(v.amountCents)} yameshindwa. Yamerudi kwenye mapato yako.`,
  },
};

export const notify: Handler = async (payload, ctx) => {
  const accountId = typeof payload.accountId === 'string' ? payload.accountId : null;
  // Addressed or nothing. A notification with no recipient is dropped, never broadcast.
  if (!accountId) { ctx.log.warn({ template: payload.template }, 'notification with no recipient dropped'); return; }
  const template = str(payload, 'template');
  const vars = (payload.vars ?? {}) as Vars;
  const tpl = TEMPLATES[template];
  if (!tpl) { ctx.log.error({ template }, 'unknown notification template'); return; }

  const [a] = await ctx.deps.sql<{ msisdn: string; language: 'en' | 'sw' }[]>`
    SELECT msisdn, language FROM account WHERE id = ${accountId}`;
  if (!a) return;
  const text = tpl[a.language === 'sw' ? 'sw' : 'en'](vars);

  // Idempotent per outbox row: a redelivered job does not notify twice.
  const [n] = await ctx.deps.sql<{ id: string }[]>`
    INSERT INTO notification (id, account_id, channel, template, vars)
    VALUES (md5(${`notify:${ctx.outboxId}`})::uuid, ${accountId}, ${tpl.sms ? 'sms' : 'push'}, ${template},
            ${ctx.deps.sql.json(vars as never)})
    ON CONFLICT (id) DO NOTHING RETURNING id`;
  if (!n) return;

  await publish(ctx.deps, accountId, 'notification', { id: n.id, template, text, vars });
  if (tpl.sms) {
    try {
      await ctx.deps.sms.send(a.msisdn, text);
      await ctx.deps.sql`UPDATE notification SET sent_at = now() WHERE id = ${n.id}`;
    } catch (err) {
      // SMS failing must not fail the job and redeliver the in-app message; it is logged and
      // the row stays unsent for the retention report.
      ctx.log.warn({ err, template }, 'sms delivery failed');
    }
  } else {
    await ctx.deps.sql`UPDATE notification SET sent_at = now() WHERE id = ${n.id}`;
  }
};
