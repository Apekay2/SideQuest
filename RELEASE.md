# Releasing Side Qwest

How to go from this repository to the apps in the stores and the platform taking real money.
Everything the code can do is done; what remains needs accounts, credentials and decisions that
only the business can provide. Work through the sections in order: each one is verified before
the next starts.

## 1. Accounts and credentials

| You need | Where | Used for | Goes in |
|---|---|---|---|
| Apple Developer Program | developer.apple.com (organisation enrolment needs a D-U-N-S number) | iOS builds, TestFlight, App Store | EAS credentials |
| Google Play Console | play.google.com/console | Android builds, internal testing, Play Store | EAS submit |
| Expo account and project | expo.dev; `eas init` in `apps/mobile` | builds, push notifications | `EAS_PROJECT_ID` (EAS env) |
| Safaricom Daraja, production app | developer.safaricom.co.ke; Go-Live needs a paybill/till and business documents | M-Pesa STK top-ups, B2C payouts and refunds | `DARAJA_*` |
| Virtual card issuer | your issuing partner | per-errand cards | `ISSUER_*` |
| Africa's Talking | africastalking.com; register the sender ID `SIDEQWEST` | sign-in codes, money SMS | `AT_*` |
| Cloudflare R2 bucket | dash.cloudflare.com | evidence photos, KYC documents | `R2_*` |
| Google Maps Platform key, restricted to the Android app | console.cloud.google.com | the live map on Android | `GOOGLE_MAPS_ANDROID_API_KEY` (EAS env) |
| Hosting | any container platform | API, worker, console | the `infra/` images |
| Postgres 16 with PostGIS **and h3** | managed or self-run | the database | `*_DATABASE_URL` |
| Redis 7 | managed | queues, rate limits, live updates | `REDIS_URL` |
| Domains and TLS | DNS provider | `api.` and `console.` hosts, at minimum | `API_PUBLIC_ORIGIN`, `ALLOWED_ORIGINS` |
| Privacy policy and terms URLs | your site | store listings; the app collects location, camera and ID documents | store listings |

h3 is not offered by every managed Postgres. Check before choosing, or run `infra/postgres`
(PostGIS + h3) yourself with backups and point-in-time recovery.

## 2. Configure the platform

1. Copy `.env.example` to your secret store and fill every value. Generate each secret with
   `openssl rand -base64 48`. Boot refuses `CHANGEME`, reused secrets, short or patterned values,
   and every development driver (`fake`, `mock`, `console`, `local`).
2. `TRUSTED_PROXY_HOPS` is the number of proxies in front of the API that append
   `X-Forwarded-For`. Get it right: rate limits and the Daraja source check depend on it.
3. `OPS_IP_ALLOWLIST` is the console server's egress address; the console calls `/ops` server to
   server.
4. `DARAJA_CALLBACK_BASE` is the API's public origin. `DARAJA_CALLBACK_TOKEN` is a fresh secret
   (callback URLs carry it). `DARAJA_SOURCE_CIDRS` is Safaricom's published callback ranges.

## 3. Deploy the backend

```sh
# Build the images (CI builds and scans the same ones on every push).
docker build -f infra/docker/node.Dockerfile --build-arg APP=api    -t sidequest/api .
docker build -f infra/docker/node.Dockerfile --build-arg APP=worker -t sidequest/worker .
docker build -f infra/docker/console.Dockerfile                     -t sidequest/console .

# Before each deploy: forward migrations, as the database owner, as a one-off job.
docker run --rm -e DATABASE_URL="$MIGRATE_DATABASE_URL" -e APP_ROLE_PASSWORD="$APP_ROLE_PASSWORD" \
  sidequest/worker node dist/migrate.js
```

Then run:
- the API: two or more replicas behind TLS, health checks on `/health/live` and `/health/ready`
- the worker: one or more replicas
- the console: one replica, or several with sticky sessions (see README, Known limits)

Create the first staff admin once, as the database owner:

```sh
MIGRATE_DATABASE_URL=… node scripts/create-admin.mjs 07XXXXXXXX "Your Name"
```

Use a dedicated number, not one that already has a customer account; the script refuses those.
Sign in to the console with it. Every other officer is then added from **Users → Make staff**.

**Check it:**
- `GET /health/ready` returns `{"ok":true,"db":true,"redis":true}`.
- The console's Finance page shows a balanced ledger.
- The first nightly reconciliation appears there with 0 findings.

## 4. Prove the money path in sandbox first

Point a staging environment at the Daraja **sandbox** (`DARAJA_ENV=sandbox`), the issuer's test
mode and Africa's Talking's sandbox. Production refuses the Daraja sandbox, so this is a
separate environment. Then:

1. Top up through STK and check the wallet is credited only after the callback.
2. Run a market errand end to end: stall approval, card load, handover scan.
3. Check settlement, the runner's payout (B2C) and its reversal on failure.
4. Raise a dispute and record a ruling from the console.
5. Run reconciliation and confirm 0 findings.

Only then switch the environment variables to production credentials.

## 5. Build the apps

In `apps/mobile`:

```sh
npm i -g eas-cli && eas login
eas init                                  # creates the project; note the projectId
eas env:create --name EAS_PROJECT_ID --value <projectId> --environment production --environment preview
eas env:create --name GOOGLE_MAPS_ANDROID_API_KEY --value <key> --environment production --environment preview --visibility secret
eas build --profile preview --platform all     # installable test builds
```

Install the preview builds on real phones and check:
- sign-in
- push arriving with the app closed, and tapping it opens the errand
- the live map
- the camera at a stall
- QR handover
- Swahili
- an Android 9 phone and an iOS 15 phone

The preview profile points at `https://staging-api.sidequest.co.ke`; edit `eas.json` if your
hosts differ.

```sh
eas build  --profile production --platform all  # build numbers auto-increment
eas submit --profile production --platform all  # Play: internal track, as a draft
```

### Store review

Reviewers cannot receive our SMS. For the review period, set a review number nobody owns and a
fixed code:

```
REVIEW_LOGIN_MSISDN=+2547XXXXXXXX
REVIEW_LOGIN_CODE=<6 non-trivial digits>
```

Put both in the review notes. The number receives no SMS, every use is logged, OTP limits still
apply, and it can never sign in to the console. Unset both after approval.

Have these answers ready for the store questionnaires:
- **Location:** shared only during a live errand, between its two parties, with consent (tier 3
  for runners).
- **Camera:** stall photos and the handover scan.
- **Identity documents:** KYC, encrypted at rest, reviewed by staff.
- **Payments:** M-Pesa, with no card data stored on the device.

## 6. Before opening the doors

- [ ] `pnpm verify` and CI green on the release commit
- [ ] Database backups with point-in-time recovery, restore tested once
- [ ] Alerts on `/health/ready`, the worker's parked outbox jobs, and reconciliation findings
- [ ] At least two staff with `accounts.manage`, and someone watching the SOS queue during
      operating hours
- [ ] Review-login variables unset after store approval
- [ ] Performance targets measured on real devices (not yet measured; see README)
