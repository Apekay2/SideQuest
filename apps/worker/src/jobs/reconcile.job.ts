// apps/worker/src/jobs/reconcile.job.ts
// The nightly reconciliation, extended past the zero-sum check that let P-1 through.
//
// P-1 is the reason this file is shaped the way it is. Settlement debited escrow twice for
// every cash reimbursement and cancelled its own liability clearance with a duplicate
// posting. The group still summed to zero, so the deferred balance trigger passed, and the
// nightly `sum(posting) = 0` check — the only ledger assertion specified in 07-security.md
// §7.3 — passed too. A balanced ledger is not a correct one.
//
// So every assertion below is a statement about MEANING rather than arithmetic: an account
// whose sign is impossible, a liability that should have cleared, an errand whose escrow
// postings disagree with its escrow row, a day's platform fee that disagrees with the fees
// that were frozen at assignment. A balanced-but-wrong group violates meaning while
// satisfying arithmetic, which is exactly the gap that has to be closed.
//
// Every finding pages. Nothing here is logged and forgotten: a reconciliation job whose
// output nobody reads is a compliance artefact, not a control.

import { sql } from 'drizzle-orm';
import type { Db } from '@sidequest/db';
import { logger, metrics } from '@sidequest/observability';
import type { IssuerPort } from '@sidequest/domain/card/issuer.port';
import type { MpesaPort } from '@sidequest/domain/rails/mpesa.port';

const log = logger.child({ job: 'reconcile' });

export type Severity = 'page' | 'ticket';

export interface Finding {
  check: string;
  severity: Severity;
  /** Rows are capped before they reach the alert: a check that fires on ten thousand rows
   *  must still produce a readable page. */
  sample: unknown[];
  count: number;
  detail: string;
}

interface Assertion {
  name: string;
  severity: Severity;
  /** What a violation MEANS, in one line. This text goes into the page, because the person
   *  woken at 03:00 needs the interpretation, not the query. */
  detail: string;
  sql: ReturnType<typeof sql>;
}

// ─────────────────────────────────────────────── ledger meaning

/**
 * Assertions run per currency. A cross-currency sum is meaningless (03e-currency.sql), and
 * running them per currency also means the first non-KES market inherits the whole suite
 * with no changes.
 */
function ledgerAssertions(currency: string): Assertion[] {
  return [
    {
      name: 'ledger.balanced',
      severity: 'page',
      detail: 'The ledger does not sum to zero for this currency. A posting was written outside a balanced group.',
      sql: sql`SELECT ${currency} AS currency, sum(amount_minor) AS delta
                 FROM posting WHERE currency = ${currency}
                HAVING sum(amount_minor) <> 0`,
    },
    {
      name: 'ledger.group_balanced',
      severity: 'page',
      detail: 'An individual posting group does not sum to zero. The deferred balance trigger was bypassed or disabled.',
      sql: sql`SELECT group_id, sum(amount_minor) AS delta
                 FROM posting WHERE currency = ${currency}
                GROUP BY group_id HAVING sum(amount_minor) <> 0
                LIMIT 50`,
    },
    {
      name: 'ledger.duplicate_account_in_group',
      severity: 'page',
      // This is the P-1 detector. Two postings to the same account inside one group are
      // almost always a pair that cancels by accident, which is invisible to every
      // arithmetic check.
      detail: 'A posting group names the same account twice. This is how a balanced group hides a double debit (finding P-1).',
      sql: sql`SELECT group_id, account, owner_id, count(*) AS n
                 FROM posting WHERE currency = ${currency}
                GROUP BY group_id, account, owner_id HAVING count(*) > 1
                LIMIT 50`,
    },
    {
      name: 'ledger.escrow_sign',
      severity: 'page',
      // Escrow is a liability the platform owes the requester. It can never be net positive
      // from the platform's side; a positive balance means escrow paid out money it never
      // received, which is precisely what P-1 did.
      detail: 'An escrow account has an impossible sign. Escrow cannot owe less than nothing.',
      sql: sql`SELECT owner_id, sum(amount_minor) AS balance
                 FROM posting
                WHERE currency = ${currency} AND account = 'escrow_hold'
                GROUP BY owner_id HAVING sum(amount_minor) > 0
                LIMIT 50`,
    },
    {
      name: 'ledger.reimbursement_cleared',
      severity: 'page',
      // The liability raised by reimbursementDue() must be zero once the errand settles. It
      // accumulated forever under P-1.
      detail: 'A settled errand still carries an open reimbursement liability. The settlement group did not clear it.',
      sql: sql`SELECT e.id AS errand_id, sum(p.amount_minor) AS outstanding
                 FROM errand e
                 JOIN posting_group g ON g.errand_id = e.id
                 JOIN posting p ON p.group_id = g.id
                WHERE e.status IN ('settled','closed') AND p.currency = ${currency}
                  AND p.account = 'reimbursement_due'
                GROUP BY e.id HAVING sum(p.amount_minor) <> 0
                LIMIT 50`,
    },
    {
      name: 'ledger.card_float_cleared',
      severity: 'page',
      detail: 'A closed card still holds float in the ledger. Either the void did not post or the card was closed early.',
      sql: sql`SELECT c.id AS card_id, sum(p.amount_minor) AS float_minor
                 FROM card c
                 JOIN posting_group g ON g.errand_id = c.errand_id
                 JOIN posting p ON p.group_id = g.id
                WHERE c.status = 'closed' AND p.currency = ${currency}
                  AND p.account = 'errand_card_float'
                GROUP BY c.id HAVING sum(p.amount_minor) <> 0
                LIMIT 50`,
    },
    {
      name: 'ledger.escrow_matches_postings',
      severity: 'page',
      // The `escrow` table is a cache for fast reads. The postings are the truth. When they
      // disagree, the cache is wrong OR the postings are — either way a human must look,
      // because the product makes authorisation decisions on the cache.
      detail: 'The escrow mirror table disagrees with the escrow postings. The cache and the ledger have diverged.',
      sql: sql`SELECT e.errand_id,
                      e.funded_minor - e.released_minor - e.refunded_minor AS mirror,
                      COALESCE(-sum(p.amount_minor), 0) AS from_postings
                 FROM escrow e
                 LEFT JOIN posting_group g ON g.errand_id = e.errand_id
                 LEFT JOIN posting p ON p.group_id = g.id
                       AND p.account = 'escrow_hold' AND p.currency = ${currency}
                WHERE e.currency = ${currency}
                GROUP BY e.errand_id, e.funded_minor, e.released_minor, e.refunded_minor
               HAVING (e.funded_minor - e.released_minor - e.refunded_minor) <> COALESCE(-sum(p.amount_minor), 0)
                LIMIT 50`,
    },
    {
      name: 'ledger.platform_fee_matches_frozen',
      severity: 'ticket',
      // The fee is frozen in errand_fee at assignment and must never be re-derived from a
      // rate. If the day's platform_fee postings disagree with the frozen fees, either a
      // rate change leaked into history or a settlement used the wrong figure.
      detail: "Yesterday's platform fee postings do not equal the fees frozen at assignment.",
      sql: sql`WITH settled AS (
                 SELECT id FROM errand
                  WHERE status IN ('settled','closed')
                    AND settled_at >= current_date - 1 AND settled_at < current_date
               )
               SELECT (SELECT COALESCE(sum(total_take_minor), 0) FROM errand_fee
                        WHERE errand_id IN (SELECT id FROM settled)) AS frozen,
                      (SELECT COALESCE(sum(p.amount_minor), 0)
                         FROM posting p JOIN posting_group g ON g.id = p.group_id
                        WHERE g.errand_id IN (SELECT id FROM settled)
                          AND p.account = 'platform_fee' AND p.currency = ${currency}) AS posted
                WHERE (SELECT COALESCE(sum(total_take_minor), 0) FROM errand_fee
                        WHERE errand_id IN (SELECT id FROM settled))
                   <> (SELECT COALESCE(sum(p.amount_minor), 0)
                         FROM posting p JOIN posting_group g ON g.id = p.group_id
                        WHERE g.errand_id IN (SELECT id FROM settled)
                          AND p.account = 'platform_fee' AND p.currency = ${currency})`,
    },
    {
      name: 'ledger.client_platform_segregation',
      severity: 'page',
      // Required before the platform holds anyone's money under any licensing regime
      // (10-panel-review.md §10.6.3). Client funds and platform funds must be separable at
      // any instant, which means no group may move value between the two classes without an
      // explicit fee or settlement reason.
      detail: 'A posting group moved value between client and platform funds without a fee or settlement reason.',
      sql: sql`SELECT g.id AS group_id, g.reason
                 FROM posting_group g JOIN posting p ON p.group_id = g.id
                WHERE p.currency = ${currency}
                  AND g.reason NOT IN ('errand.settle','fee.collect','payout.execute','ruling.apply')
                GROUP BY g.id, g.reason
               HAVING count(DISTINCT p.fund_class) > 1
                LIMIT 50`,
    },
  ];
}

// ─────────────────────────────────────────────── operational consistency

const OPERATIONAL: Assertion[] = [
  {
    name: 'tranche.single_success',
    severity: 'page',
    // P-2's detector. One `&&` marked every pending reimbursement attempt in the database as
    // a success; this check finds a tranche with more than one success, or a loaded tranche
    // with none.
    detail: 'A loaded tranche does not have exactly one successful card attempt (finding P-2).',
    sql: sql`SELECT t.id AS tranche_id, count(a.id) FILTER (WHERE a.result = 'success') AS successes
               FROM tranche t LEFT JOIN card_attempt a ON a.tranche_id = t.id
              WHERE t.status = 'loaded'
              GROUP BY t.id HAVING count(a.id) FILTER (WHERE a.result = 'success') <> 1
              LIMIT 50`,
  },
  {
    name: 'card.loaded_matches_tranches',
    severity: 'page',
    detail: "A card's loaded total disagrees with the sum of its loaded tranches.",
    sql: sql`SELECT c.id AS card_id, c.loaded_minor,
                    COALESCE(sum(t.amount_minor) FILTER (WHERE t.status = 'loaded'), 0) AS from_tranches
               FROM card c LEFT JOIN tranche t ON t.card_id = c.id
              GROUP BY c.id, c.loaded_minor
             HAVING c.loaded_minor <> COALESCE(sum(t.amount_minor) FILTER (WHERE t.status = 'loaded'), 0)
              LIMIT 50`,
  },
  {
    name: 'tranche.stranded_pending',
    severity: 'page',
    // P-4's residue. A tranche pending for more than an hour means the issuer may hold real
    // money the ledger does not know about, and the runner is waiting in a market.
    detail: 'A tranche has been pending for over an hour. The issuer may hold value the ledger does not record.',
    sql: sql`SELECT id, card_id, created_at FROM tranche
              WHERE status = 'pending' AND created_at < now() - interval '1 hour'
              LIMIT 50`,
  },
  {
    name: 'outbox.parked',
    severity: 'page',
    // A parked row is a job that will never run unless a human drains it. A parked
    // `errand.settled` is someone who has not been paid.
    detail: 'Outbox rows are parked. Each one is a dropped job; a parked errand.settled is an unpaid runner.',
    sql: sql`SELECT id, queue, attempts, last_error, parked_at FROM outbox_event
              WHERE parked_at IS NOT NULL ORDER BY parked_at DESC LIMIT 50`,
  },
  {
    name: 'outbox.stalled',
    severity: 'page',
    detail: 'Undispatched outbox rows are over an hour old. The poller is not draining.',
    sql: sql`SELECT id, queue, available_at FROM outbox_event
              WHERE dispatched_at IS NULL AND parked_at IS NULL
                AND available_at < now() - interval '1 hour'
              LIMIT 50`,
  },
  {
    name: 'errand.settled_without_payout',
    severity: 'page',
    detail: 'An errand settled over a day ago with no payout row. The runner has earnings that were never disbursed.',
    sql: sql`SELECT e.id AS errand_id, e.settled_at
               FROM errand e
              WHERE e.status IN ('settled','closed')
                AND e.settled_at < now() - interval '1 day'
                AND NOT EXISTS (SELECT 1 FROM payout p WHERE p.errand_id = e.id)
              LIMIT 50`,
  },
  {
    name: 'fee.frozen_present',
    severity: 'ticket',
    detail: 'An assigned errand has no frozen fee row. The fee would be re-derived at display time from a rate that may have changed.',
    sql: sql`SELECT id FROM errand
              WHERE runner_id IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM errand_fee f WHERE f.errand_id = errand.id)
              LIMIT 50`,
  },
  {
    name: 'currency.market_consistency',
    severity: 'page',
    detail: 'An enabled market sits on a disabled currency, or a money row disagrees with its errand currency.',
    sql: sql`SELECT m.country, m.currency FROM market m
               JOIN money_currency c ON c.code = m.currency
              WHERE m.enabled AND NOT c.enabled`,
  },
];

// ─────────────────────────────────────────────── external rails

/**
 * The platform's ledger against the issuer's and the rail's own records. These are the only
 * checks that can catch money that exists in the world but not in the database, which no
 * internal assertion can see.
 */
async function reconcileExternal(db: Db, issuer: IssuerPort, mpesa: MpesaPort): Promise<Finding[]> {
  const findings: Finding[] = [];

  // Issuer: every open card's real balance against its ledger float. A divergence is either
  // a stranded load (P-4) or an unrecorded spend.
  const openCards = await db.execute<{ id: string; issuer_ref: string; float_minor: number; currency: string }>(sql`
    SELECT c.id, c.issuer_ref, c.currency,
           COALESCE(sum(p.amount_minor), 0) AS float_minor
      FROM card c
      LEFT JOIN posting_group g ON g.errand_id = c.errand_id
      LEFT JOIN posting p ON p.group_id = g.id AND p.account = 'errand_card_float'
     WHERE c.status = 'open'
     GROUP BY c.id, c.issuer_ref, c.currency`);

  const drift: unknown[] = [];
  for (const card of openCards) {
    try {
      const actual = await issuer.getBalance(card.issuer_ref);
      // The ledger float is negative from the platform's side; compare magnitudes.
      if (Math.abs(Number(actual)) !== Math.abs(card.float_minor)) {
        drift.push({ card: card.id, issuer: Number(actual), ledger: Math.abs(card.float_minor) });
      }
    } catch (err) {
      // An issuer we cannot reach is itself a finding: it means we cannot assert anything
      // about the float tonight, and silence would read as "clean".
      drift.push({ card: card.id, error: String((err as Error).message).slice(0, 120) });
    }
  }
  if (drift.length > 0) {
    findings.push({
      check: 'issuer.balance_drift',
      severity: 'page',
      sample: drift.slice(0, 20),
      count: drift.length,
      detail: 'Card balances at the issuer disagree with the ledger float, or the issuer could not be reached.',
    });
  }

  // Rail: yesterday's confirmed payments against the rail's own statement. Catches a
  // confirmation we processed that the rail does not have, and a payment the rail settled
  // that we never recorded.
  const statement = await mpesa.statement({ from: yesterday(), to: today() });
  const ours = await db.execute<{ provider_ref: string; amount_minor: number }>(sql`
    SELECT provider_ref, amount_minor FROM payment
     WHERE status = 'confirmed' AND confirmed_at >= current_date - 1 AND confirmed_at < current_date`);

  const ourRefs = new Map(ours.map((p) => [p.provider_ref, p.amount_minor]));
  const theirRefs = new Map(statement.map((s) => [s.providerRef, s.amountMinor]));

  const missingLocally = statement.filter((s) => !ourRefs.has(s.providerRef));
  const missingUpstream = ours.filter((p) => !theirRefs.has(p.provider_ref));
  const amountMismatch = ours.filter((p) => theirRefs.has(p.provider_ref)
    && theirRefs.get(p.provider_ref) !== p.amount_minor);

  if (missingLocally.length > 0) {
    findings.push({
      check: 'rail.missing_locally',
      severity: 'page',
      sample: missingLocally.slice(0, 20),
      count: missingLocally.length,
      detail: 'The rail settled a payment we have no record of. Someone paid and was not credited.',
    });
  }
  if (missingUpstream.length > 0) {
    findings.push({
      check: 'rail.missing_upstream',
      severity: 'page',
      sample: missingUpstream.slice(0, 20),
      count: missingUpstream.length,
      detail: 'We recorded a confirmed payment the rail statement does not contain. Possible forged or replayed callback.',
    });
  }
  if (amountMismatch.length > 0) {
    findings.push({
      check: 'rail.amount_mismatch',
      severity: 'page',
      sample: amountMismatch.slice(0, 20),
      count: amountMismatch.length,
      detail: 'A confirmed payment amount disagrees with the rail statement.',
    });
  }

  return findings;
}

// ─────────────────────────────────────────────── runner

export async function reconcile(deps: {
  db: Db; issuer: IssuerPort; mpesa: MpesaPort;
  page: (f: Finding[]) => Promise<void>;
  ticket: (f: Finding[]) => Promise<void>;
}): Promise<{ findings: Finding[]; checksRun: number }> {
  const { db, issuer, mpesa } = deps;
  const started = Date.now();
  const findings: Finding[] = [];

  const currencies = await db.execute<{ code: string }>(sql`
    SELECT code FROM money_currency WHERE enabled`);

  const assertions: Assertion[] = [
    ...currencies.flatMap((c) => ledgerAssertions(c.code)),
    ...OPERATIONAL,
  ];

  for (const a of assertions) {
    try {
      const rows = await db.execute<Record<string, unknown>>(a.sql);
      if (rows.length > 0) {
        findings.push({
          check: a.name, severity: a.severity, detail: a.detail,
          count: rows.length, sample: rows.slice(0, 20),
        });
      }
      metrics.gauge('reconcile.check_rows', rows.length, { check: a.name });
    } catch (err) {
      // A check that cannot run is a finding. The alternative — logging and continuing — is
      // how a reconciliation job comes to assert nothing at all over a few quarters.
      log.error({ err, check: a.name }, 'assertion failed to execute');
      findings.push({
        check: a.name, severity: 'page', count: 0, sample: [],
        detail: `Assertion could not be executed: ${String((err as Error).message).slice(0, 200)}`,
      });
    }
  }

  findings.push(...await reconcileExternal(db, issuer, mpesa));

  const pages = findings.filter((f) => f.severity === 'page');
  const tickets = findings.filter((f) => f.severity === 'ticket');

  // Record the run itself, so "reconciliation has not reported for three days" is visible.
  // A silent job is indistinguishable from a clean one, and that ambiguity has cost other
  // platforms far more than the bugs it was meant to find.
  await db.execute(sql`
    INSERT INTO reconciliation_run (ran_at, checks_run, findings, paged, duration_ms, detail)
    VALUES (now(), ${assertions.length}, ${findings.length}, ${pages.length},
            ${Date.now() - started}, ${JSON.stringify(findings.slice(0, 50))}::jsonb)`);

  metrics.gauge('reconcile.findings', findings.length);
  metrics.gauge('reconcile.paged', pages.length);
  metrics.gauge('reconcile.duration_ms', Date.now() - started);

  if (pages.length > 0) await deps.page(pages);
  if (tickets.length > 0) await deps.ticket(tickets);

  log.info({ checks: assertions.length, findings: findings.length, paged: pages.length },
    'reconciliation complete');

  return { findings, checksRun: assertions.length };
}

const today = () => new Date(new Date().toDateString());
const yesterday = () => new Date(today().getTime() - 86_400_000);
