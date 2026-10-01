// The harness. One World per test file: the real API (in-process via inject), the real worker
// handlers (drained inline), and an owner connection used ONLY to set up fixtures a test is
// not about (a verified tier, a staff grant). Everything under test goes through the API.

import { randomUUID, randomInt } from 'node:crypto';
import postgres from 'postgres';
import type { FastifyInstance } from 'fastify';
import { loadConfig, type Config } from '@sidequest/config';
import { LEGAL_VERSIONS } from '@sidequest/contracts';
import { build, buildDeps } from '@sidequest/api/server';
import { buildWorkerDeps, drain } from '@sidequest/worker/runtime';
import type { WorkerDeps } from '@sidequest/worker/context';
import type { ConsoleSms } from '@sidequest/adapters';
import type { Deps } from '@sidequest/api/types';
import { ADMIN_URL, testEnv } from './env.js';

export interface Res<T = any> { status: number; body: T; headers: Record<string, string | string[] | undefined> }

export interface User {
  id: string; msisdn: string; access: string; refresh: string; role: 'requester' | 'runner' | 'staff';
  client: Client;
}

export class Client {
  /** Each simulated device gets its own address, as real phones on a carrier NAT would not —
   *  the per-IP OTP limit is exercised deliberately in security.test.ts, not by accident. */
  readonly ip = `10.${randomInt(0, 255)}.${randomInt(0, 255)}.${randomInt(1, 254)}`;
  constructor(private readonly app: FastifyInstance, public token?: string, private readonly extraHeaders: Record<string, string> = {}) {}

  async req<T = any>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT', url: string, body?: unknown,
                     opts: { idem?: string | false; headers?: Record<string, string> } = {}): Promise<Res<T>> {
    const headers: Record<string, string> = { ...this.extraHeaders, ...(opts.headers ?? {}) };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (method === 'POST' && opts.idem !== false) headers['idempotency-key'] = opts.idem ?? randomUUID();
    const res = await this.app.inject({ method, url, headers, remoteAddress: this.ip, ...(body !== undefined ? { payload: body as object } : {}) });
    let parsed: unknown = res.body;
    try { parsed = res.body ? JSON.parse(res.body) : null; } catch { /* non-JSON body */ }
    return { status: res.statusCode, body: parsed as T, headers: res.headers as Res["headers"] };
  }
  get<T = any>(url: string, opts?: { headers?: Record<string, string> }) { return this.req<T>('GET', url, undefined, opts); }
  post<T = any>(url: string, body?: unknown, opts?: { idem?: string | false; headers?: Record<string, string> }) { return this.req<T>('POST', url, body ?? {}, opts); }
  patch<T = any>(url: string, body?: unknown) { return this.req<T>('PATCH', url, body ?? {}); }
  put<T = any>(url: string, body?: unknown) { return this.req<T>('PUT', url, body ?? {}); }
  delete<T = any>(url: string, body?: unknown) { return this.req<T>('DELETE', url, body); }
}

export const NAIROBI = {
  kangemi: { lat: -1.2641, lng: 36.7519 },
  westlands: { lat: -1.2676, lng: 36.8108 },
  kilimani: { lat: -1.2921, lng: 36.7836 },
};

export class World {
  cfg!: Config;
  app!: FastifyInstance;
  apiDeps!: Deps;
  worker!: WorkerDeps;
  admin!: postgres.Sql;

  async start(env: Record<string, string> = {}) {
    this.cfg = loadConfig({ ...testEnv(), ...env });
    this.apiDeps = buildDeps(this.cfg);
    this.app = await build(this.apiDeps);
    await this.app.ready();
    this.worker = buildWorkerDeps(this.cfg, { redis: this.apiDeps.redis });
    this.admin = postgres(ADMIN_URL, { max: 2, onnotice: () => {} });
    return this;
  }

  async stop() {
    await this.app.close();
    await this.worker.sql.end({ timeout: 2 });
    await this.admin.end({ timeout: 2 });
  }

  anon() { return new Client(this.app); }

  /** Run the worker until the outbox is empty, letting the fake rail's timers fire between rounds. */
  async settle(opts: { ignoreDelay?: boolean; only?: string[] } = {}) {
    const all: string[] = [];
    for (let quiet = 0; quiet < 2;) {
      const ran = await drain(this.worker, opts);
      all.push(...ran);
      if (ran.length === 0) quiet++; else quiet = 0;
      await new Promise((r) => setTimeout(r, 15));
    }
    return all;
  }

  sms(): ConsoleSms { return this.apiDeps.sms as ConsoleSms; }

  /** The real sign-in flow: request an OTP, read it off the console SMS driver, verify it. */
  async signIn(opts: { role?: 'requester' | 'runner'; name?: string; msisdn?: string } = {}): Promise<User> {
    const msisdn = opts.msisdn ?? `07${String(randomInt(10_000_000, 99_999_999))}`;
    const anon = this.anon();
    const otp = await anon.post('/auth/otp', { msisdn }, { idem: false });
    if (otp.status !== 201) throw new Error(`otp ${otp.status} ${JSON.stringify(otp.body)}`);
    const text = this.sms().outbox.at(-1)!.text;
    const code = /(\d{6})/.exec(text)![1]!;
    const v = await anon.post('/auth/verify', {
      challenge_id: otp.body.challenge_id, code, role: opts.role ?? 'requester', display_name: opts.name ?? 'Amina Wanjiru',
      accept_legal: { ...LEGAL_VERSIONS, adult: true },
    }, { idem: false });
    if (v.status !== 200) throw new Error(`verify ${v.status} ${JSON.stringify(v.body)}`);
    return {
      id: v.body.account.id, msisdn: `+254${msisdn.slice(1)}`, access: v.body.access, refresh: v.body.refresh,
      role: v.body.account.role, client: new Client(this.app, v.body.access),
    };
  }

  /** Fresh tokens after a tier or role change, through the real refresh endpoint. */
  async refresh(u: User): Promise<User> {
    const r = await this.anon().post('/auth/refresh', { refresh: u.refresh }, { idem: false });
    if (r.status !== 200) throw new Error(`refresh ${r.status} ${JSON.stringify(r.body)}`);
    u.access = r.body.access; u.refresh = r.body.refresh; u.client = new Client(this.app, u.access);
    return u;
  }

  /** Fixture: a verified tier, as if KYC had been approved. Tier 3 includes movement consent. */
  async verify(u: User, tier: 2 | 3): Promise<User> {
    await this.admin`UPDATE account SET verification_tier = ${tier} WHERE id = ${u.id}`;
    await this.admin`INSERT INTO kyc_case (account_id, target_tier, status, movement_consent, reviewed_at)
                     VALUES (${u.id}, ${tier}, 'approved', ${tier === 3}, now())`;
    return this.refresh(u);
  }

  async requester(name = 'Amina Wanjiru') { return this.signIn({ role: 'requester', name }); }
  async runner(name = 'Peter Kamau', tier: 2 | 3 = 3) { return this.verify(await this.signIn({ role: 'runner', name }), tier); }

  async staff(grants: string[]): Promise<User> {
    const u = await this.signIn({ role: 'requester', name: 'Ops Officer' });
    await this.admin`UPDATE account SET role = 'staff', staff_grants = ${grants} WHERE id = ${u.id}`;
    return this.refresh(u);
  }

  /** Top up through the real rail path: STK push → fake callback → mpesa.callback → ledger. */
  async topUp(u: User, amountCents: number) {
    const r = await u.client.post('/wallet/topup', { amount_cents: amountCents });
    if (r.status !== 202) throw new Error(`topup ${r.status} ${JSON.stringify(r.body)}`);
    await this.settle();
    return r.body.payment_id as string;
  }

  /** Let a sealed auction close, as time would. */
  async closeAuction(errandId: string) {
    await this.admin`UPDATE errand SET auction_closes_at = now() - interval '1 second' WHERE id = ${errandId}`;
  }

  async one<T = any>(q: TemplateStringsArray, ...v: any[]): Promise<T> {
    const rows = await this.admin(q, ...v);
    return rows[0] as T;
  }
}

/** A market run with two stalls, as the prototype's Kangemi example. */
export function marketRun(over: Record<string, unknown> = {}) {
  return {
    kind: 'market_run',
    title: 'Kangemi Market run',
    notes: 'Sukuma from the third row, she knows me',
    pickup: { ...NAIROBI.kangemi, label: 'Kangemi Market' },
    dropoff: { ...NAIROBI.kilimani, label: 'Kilimani, Wood Ave 12' },
    spend_cap_cents: 100_000,
    max_fee_cents: 40_000,
    bonus_cents: 5_000,
    deadline_at: new Date(Date.now() + 3 * 3600_000).toISOString(),
    auction_minutes: 5,
    assignment_mode: 'pick',
    stalls: [
      { seq: 1, name: 'Mama Ngina Greens', till_number: '174379',
        items: [{ label: 'Sukuma wiki', qty: 2, unit: 'bunch' }, { label: 'Tomatoes', qty: 1, unit: 'kg' }, { label: 'Onions', qty: 1, unit: 'kg' }] },
      { seq: 2, name: 'Cereals — Mzee Otieno', items: [{ label: 'Beans', qty: 2, unit: 'kg' }] },
    ],
    ...over,
  };
}
