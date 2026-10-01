// apps/worker/src/jobs/reconcile.job.ts
// The nightly reconciliation, extended past the zero-sum check that let P-1 through.
//
// P-1 is the reason this file is shaped the way it is. Settlement debited escrow twice for
// every cash reimbursement and cancelled its own liability clearance with a duplicate
// posting. The group still summed to zero, so the deferred balance trigger passed, and a
// nightly `sum(posting) = 0` check would have passed too. A balanced ledger is not a correct one.
//
// So every assertion below is a statement about MEANING rather than arithmetic: an account
// whose sign is impossible, a liability that should have cleared, an errand whose escrow
// mirror disagrees with its postings, a card whose float outlived it.
//
// CORRECTED: the handoff version queried columns that do not exist (amount_minor,
// funded_minor/released_minor/refunded_minor, loaded_minor, total_take_minor, card.status,
// errand.settled_at) and a rail statement method no port declares. Every check would have
// failed to execute and, by the rule below, paged — nightly, forever — which trains people to
// ignore the page. These run against the real schema, and the test suite runs them.
//
// Every finding pages or tickets. A reconciliation job whose output nobody reads is a
// compliance artefact, not a control.

import type { Sql } from '@sidequest/db';
import type { IssuerPort } from '@sidequest/domain/card/issuer.port';
import { logger, metrics } from '@sidequest/observability';
import type { PendingQuery, Row } from 'postgres';

const log = logger.child({ job: 'reconcile' });

export type Severity = 'page' | 'ticket';

export interface Finding {
  check: string;
  severity: Severity;
  sample: unknown[];
  count: number;
  detail: string;
}

interface Assertion {
  name: string;
  severity: Severity;
  /** What a violation MEANS, in one line — the person woken at 03:00 needs the reading. */
  detail: string;
  query: (sql: Sql) => PendingQuery<Row[]>;
}

// ─────────────────────────────────────────────── ledger meaning (per currency)

function ledgerAssertions(currency: string): Assertion[] {
  return [
    {
      name: 'ledger.balanced',
      severity: 'page',
      detail: 'The ledger does not sum to zero for this currency. A posting was written outside a balanced group.',
      query: (sql) => sql`SELECT ${currency} AS currency, sum(amount_cents) AS delta
                            FROM posting WHERE currency = ${currency} HAVING sum(amount_cents) <> 0`,
    },
    {
      name: 'ledger.group_balanced',
      severity: 'page',
      detail: 'An individual posting group does not sum to zero. The deferred balance trigger was bypassed or disabled.',
      query: (sql) => sql`SELECT group_id, sum(amount_cents) AS delta FROM posting WHERE currency = ${currency}
                           GROUP BY group_id HAVING sum(amount_cents) <> 0 LIMIT 50`,
    },
    {
      name: 'ledger.duplicate_account_in_group',
      severity: 'page',
      // The P-1 detector: two postings to one account in one group are a pair that cancels
      // by accident, invisible to every arithmetic check.
      detail: 'A posting group names the same account twice. This is how a balanced group hides a double debit (finding P-1).',
      query: (sql) => sql`SELECT group_id, account, owner_id, count(*) AS n FROM posting WHERE currency = ${currency}
                           GROUP BY group_id, account, owner_id HAVING count(*) > 1 LIMIT 50`,
    },
    {
      name: 'ledger.escrow_sign',
      severity: 'page',
      // Positive = held. Escrow for an errand can never go below nothing; P-1 drove it
      // negative by the reimbursed amount on every cash-ladder errand.
      detail: 'An errand escrow balance is negative. Escrow paid out money it never held.',
      query: (sql) => sql`SELECT g.errand_id, sum(p.amount_cents) AS balance
                            FROM posting p JOIN posting_group g ON g.id = p.group_id
                           WHERE p.currency = ${currency} AND p.account = 'escrow_hold'
                           GROUP BY g.errand_id HAVING sum(p.amount_cents) < 0 LIMIT 50`,
    },
    {
      name: 'ledger.wallet_sign',
      severity: 'page',
      detail: 'A wallet or earnings balance is negative. Someone spent money they did not have.',
      query: (sql) => sql`SELECT account, owner_id, sum(amount_cents) AS balance FROM posting
                           WHERE currency = ${currency} AND account IN ('user_wallet','runner_earnings')
                           GROUP BY account, owner_id HAVING sum(amount_cents) < 0 LIMIT 50`,
    },
    {
      name: 'ledger.reimbursement_cleared',
      severity: 'page',
      // The liability raised by reimbursementDue() must be zero once the errand settles. It
      // accumulated forever under P-1.
      detail: 'A settled errand still carries an open reimbursement liability. The settlement group did not clear it.',
      query: (sql) => sql`SELECT e.id AS errand_id, sum(p.amount_cents) AS outstanding
                            FROM errand e JOIN posting_group g ON g.errand_id = e.id JOIN posting p ON p.group_id = g.id
                           WHERE e.status = 'settled' AND p.currency = ${currency} AND p.account = 'reimbursement_due'
                             AND EXISTS (SELECT 1 FROM posting_group s WHERE s.errand_id = e.id AND s.reason IN ('errand.settle','dispute.ruling'))
                           GROUP BY e.id HAVING sum(p.amount_cents) <> 0 LIMIT 50`,
    },
    {
      name: 'ledger.escrow_released',
      severity: 'page',
      detail: 'A closed errand still holds escrow. The requester has money stuck in a finished errand.',
      query: (sql) => sql`SELECT e.id AS errand_id, e.status, sum(p.amount_cents) AS held
                            FROM errand e JOIN posting_group g ON g.errand_id = e.id JOIN posting p ON p.group_id = g.id
                           WHERE e.status IN ('settled','cancelled','expired') AND p.currency = ${currency}
                             AND p.account = 'escrow_hold' AND e.updated_at < now() - interval '1 hour'
                           GROUP BY e.id, e.status HAVING sum(p.amount_cents) <> 0 LIMIT 50`,
    },
    {
      name: 'ledger.card_float_cleared',
      severity: 'page',
      detail: 'A voided card still holds float in the ledger. Either the void did not post or a tranche was left pending.',
      query: (sql) => sql`SELECT c.id AS card_id, sum(p.amount_cents) AS float_cents
                            FROM card c JOIN posting_group g ON g.errand_id = c.errand_id JOIN posting p ON p.group_id = g.id
                           WHERE c.voided_at IS NOT NULL AND p.currency = ${currency} AND p.account = 'errand_card_float'
                           GROUP BY c.id HAVING sum(p.amount_cents) <> 0 LIMIT 50`,
    },
    {
      name: 'ledger.escrow_matches_mirror',
      severity: 'page',
      // The escrow row is a cache for fast reads; the postings are the truth. The product
      // makes decisions on the cache, so a divergence needs a human either way.
      detail: 'The escrow mirror row disagrees with the escrow postings. The cache and the ledger have diverged.',
      query: (sql) => sql`SELECT e.errand_id, e.held_cents AS mirror, COALESCE(sum(p.amount_cents), 0) AS from_postings
                            FROM escrow e
                            LEFT JOIN posting_group g ON g.errand_id = e.errand_id
                            LEFT JOIN posting p ON p.group_id = g.id AND p.account = 'escrow_hold' AND p.currency = ${currency}
                           WHERE e.currency = ${currency}
                           GROUP BY e.errand_id, e.held_cents
                          HAVING e.held_cents <> COALESCE(sum(p.amount_cents), 0) LIMIT 50`,
    },
    {
      name: 'ledger.fees_match_frozen',
      severity: 'ticket',
      // The fee is frozen in errand_fee at assignment and must never be re-derived from a
      // rate. Posted fee revenue for settled errands must equal the frozen halves exactly.
      detail: 'Posted fee revenue for a settled errand does not equal the fee frozen at assignment.',
      query: (sql) => sql`SELECT f.errand_id, f.requester_fee_cents + f.runner_fee_cents AS frozen,
                                 COALESCE((SELECT sum(p.amount_cents) FROM posting p JOIN posting_group g ON g.id = p.group_id
                                            WHERE g.errand_id = f.errand_id AND p.currency = ${currency}
                                              AND p.account IN ('service_fee_requester','maintenance_fee_runner')), 0) AS posted
                            FROM errand_fee f JOIN errand e ON e.id = f.errand_id
                           WHERE e.status = 'settled' AND f.runner_deducted_at IS NOT NULL
                             AND f.requester_fee_cents + f.runner_fee_cents <>
                                 COALESCE((SELECT sum(p.amount_cents) FROM posting p JOIN posting_group g ON g.id = p.group_id
                                            WHERE g.errand_id = f.errand_id AND p.currency = ${currency}
                                              AND p.account IN ('service_fee_requester','maintenance_fee_runner')), 0)
                           LIMIT 50`,
    },
    {
      name: 'ledger.client_platform_segregation',
      severity: 'page',
      // Client funds and platform funds must be separable at any instant: only a fee or
      // settlement group may move value between the two classes.
      detail: 'A posting group moved value between client and platform funds without a fee or settlement reason.',
      query: (sql) => sql`SELECT g.id AS group_id, g.reason FROM posting_group g JOIN posting p ON p.group_id = g.id
                           WHERE p.currency = ${currency}
                             AND g.reason NOT IN ('errand.settle','fee.requester','errand.cancel')
                           GROUP BY g.id, g.reason HAVING count(DISTINCT p.fund_class) > 1 LIMIT 50`,
    },
  ];
}

// ─────────────────────────────────────────────── operational consistency

const OPERATIONAL: Assertion[] = [
  {
    name: 'tranche.single_success',
    severity: 'page',
    // P-2's detector. One `&&` marked every pending reimbursement attempt in the database as
    // a success; this finds a loaded tranche with more than one success, or none.
    detail: 'A loaded tranche does not have exactly one successful attempt (finding P-2).',
    query: (sql) => sql`SELECT t.id AS tranche_id, count(a.id) FILTER (WHERE a.result = 'success') AS successes
                          FROM tranche t LEFT JOIN card_attempt a ON a.tranche_id = t.id
                         WHERE t.status = 'loaded'
                         GROUP BY t.id HAVING count(a.id) FILTER (WHERE a.result = 'success') <> 1 LIMIT 50`,
  },
  {
    name: 'card.loaded_matches_tranches',
    severity: 'page',
    detail: "A card's loaded total disagrees with the sum of its card-loaded tranches.",
    query: (sql) => sql`SELECT c.id AS card_id, c.loaded_cents,
                               COALESCE(sum(t.amount_cents) FILTER (WHERE t.status = 'loaded'
                                 AND NOT EXISTS (SELECT 1 FROM card_attempt a WHERE a.tranche_id = t.id
                                                  AND a.rung IN ('mpesa_till','reimbursement') AND a.result = 'success')), 0) AS from_tranches
                          FROM card c LEFT JOIN tranche t ON t.card_id = c.id
                         GROUP BY c.id, c.loaded_cents
                        HAVING c.loaded_cents <> COALESCE(sum(t.amount_cents) FILTER (WHERE t.status = 'loaded'
                                 AND NOT EXISTS (SELECT 1 FROM card_attempt a WHERE a.tranche_id = t.id
                                                  AND a.rung IN ('mpesa_till','reimbursement') AND a.result = 'success')), 0)
                         LIMIT 50`,
  },
  {
    name: 'tranche.stranded_pending',
    severity: 'page',
    // A tranche pending for over an hour: the issuer may hold money the ledger does not know
    // about, and a runner is waiting in a market.
    detail: 'A tranche has been pending for over an hour. The issuer may hold value the ledger does not record.',
    query: (sql) => sql`SELECT t.id, t.card_id, t.created_at FROM tranche t
                         WHERE t.status = 'pending' AND t.created_at < now() - interval '1 hour'
                           AND NOT EXISTS (SELECT 1 FROM card_attempt a WHERE a.tranche_id = t.id
                                            AND a.rung = 'reimbursement' AND a.result = 'pending')
                         LIMIT 50`,
  },
  {
    name: 'card.outlived_errand',
    severity: 'page',
    detail: 'A card is still open on an errand that has ended. A card must outlive nothing.',
    query: (sql) => sql`SELECT c.id AS card_id, e.status FROM card c JOIN errand e ON e.id = c.errand_id
                         WHERE c.voided_at IS NULL AND e.status IN ('settled','cancelled','expired')
                           AND e.updated_at < now() - interval '1 hour' LIMIT 50`,
  },
  {
    name: 'outbox.parked',
    severity: 'page',
    detail: 'Outbox rows are parked. Each one is a dropped job; a parked errand.settle is an unpaid runner.',
    query: (sql) => sql`SELECT id, queue, attempts, last_error, parked_at FROM outbox_event
                         WHERE parked_at IS NOT NULL ORDER BY parked_at DESC LIMIT 50`,
  },
  {
    name: 'outbox.stalled',
    severity: 'page',
    detail: 'Undispatched outbox rows are over an hour old. The poller is not draining.',
    query: (sql) => sql`SELECT id, queue, available_at FROM outbox_event
                         WHERE dispatched_at IS NULL AND parked_at IS NULL AND available_at < now() - interval '1 hour' LIMIT 50`,
  },
  {
    name: 'errand.settled_without_settlement',
    severity: 'page',
    detail: 'An errand was handed over over an hour ago but has no settlement posting. The runner has not been paid.',
    query: (sql) => sql`SELECT e.id AS errand_id, e.handover_at FROM errand e
                         WHERE e.status = 'settled' AND e.handover_at < now() - interval '1 hour'
                           AND NOT EXISTS (SELECT 1 FROM posting_group g WHERE g.errand_id = e.id
                                            AND g.reason IN ('errand.settle','dispute.ruling')) LIMIT 50`,
  },
  {
    name: 'fee.frozen_present',
    severity: 'ticket',
    detail: 'An assigned errand has no frozen fee row. A fee would have to be re-derived from a rate that may have changed.',
    query: (sql) => sql`SELECT id FROM errand WHERE runner_id IS NOT NULL
                          AND NOT EXISTS (SELECT 1 FROM errand_fee f WHERE f.errand_id = errand.id) LIMIT 50`,
  },
  {
    name: 'currency.market_consistency',
    severity: 'page',
    detail: 'An enabled market sits on a disabled currency.',
    query: (sql) => sql`SELECT m.country, m.currency FROM market m JOIN money_currency c ON c.code = m.currency
                         WHERE m.enabled AND NOT c.enabled`,
  },
];

// ─────────────────────────────────────────────── external rails

/**
 * The platform's ledger against the issuer's own records: the only check that can catch money
 * that exists in the world but not in the database. For every open card, the issuer balance
 * must equal what was loaded minus what was spent — and nothing is spent until a capture
 * event says so, so for an open card it must equal loaded_cents.
 *
 * M-Pesa statement reconciliation needs Daraja's account-balance and transaction-status APIs,
 * which require production credentials; it is listed as an open item rather than faked here.
 */
async function reconcileIssuer(sql: Sql, issuer: IssuerPort): Promise<Finding[]> {
  const open = await sql<{ id: string; issuer_ref: string; loaded_cents: number }[]>`
    SELECT id, issuer_ref, loaded_cents FROM card WHERE voided_at IS NULL`;
  const drift: unknown[] = [];
  for (const c of open) {
    try {
      const actual = Number(await issuer.getBalance(c.issuer_ref));
      if (actual > c.loaded_cents) drift.push({ card: c.id, issuer: actual, loaded: c.loaded_cents });
    } catch (err) {
      // An issuer we cannot reach is itself a finding: silence would read as "clean".
      drift.push({ card: c.id, error: String((err as Error).message).slice(0, 120) });
    }
  }
  return drift.length === 0 ? [] : [{
    check: 'issuer.balance_drift',
    severity: 'page',
    sample: drift.slice(0, 20),
    count: drift.length,
    detail: 'A card holds more at the issuer than the ledger ever loaded onto it, or the issuer could not be reached.',
  }];
}

// ─────────────────────────────────────────────── runner

export async function reconcile(deps: {
  sql: Sql; issuer: IssuerPort;
  page: (f: Finding[]) => Promise<void>;
  ticket: (f: Finding[]) => Promise<void>;
}): Promise<{ findings: Finding[]; checksRun: number }> {
  const { sql, issuer } = deps;
  const started = Date.now();
  const findings: Finding[] = [];

  const currencies = await sql<{ code: string }[]>`SELECT code FROM money_currency WHERE enabled`;
  const assertions: Assertion[] = [...currencies.flatMap((c) => ledgerAssertions(c.code)), ...OPERATIONAL];

  for (const a of assertions) {
    try {
      const rows = await a.query(sql);
      if (rows.length > 0) {
        findings.push({ check: a.name, severity: a.severity, detail: a.detail, count: rows.length, sample: [...rows].slice(0, 20) });
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

  findings.push(...await reconcileIssuer(sql, issuer));

  const pages = findings.filter((f) => f.severity === 'page');
  const tickets = findings.filter((f) => f.severity === 'ticket');

  // Record the run itself, so "reconciliation has not reported for three days" is visible.
  await sql`
    INSERT INTO reconciliation_run (checks_run, findings, paged, duration_ms, detail)
    VALUES (${assertions.length + 1}, ${findings.length}, ${pages.length}, ${Date.now() - started},
            ${sql.json(findings.slice(0, 50) as never)})`;

  metrics.gauge('reconcile.findings', findings.length);
  metrics.gauge('reconcile.paged', pages.length);

  if (pages.length > 0) await deps.page(pages);
  if (tickets.length > 0) await deps.ticket(tickets);

  log.info({ checks: assertions.length, findings: findings.length, paged: pages.length }, 'reconciliation complete');
  return { findings, checksRun: assertions.length + 1 };
}
