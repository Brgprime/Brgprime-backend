# BRG Prime — Backend API

Professional REST API for **BRG Prime**, a Nigerian real-estate marketplace.
This single backend powers **both** the mobile app (`StudioProjects/BRG-Prime`, Flutter)
and the web app (`Documents/BRG-Prime-Web`, Vue 3) — they share the same data and behaviour.

Built with **Node.js + Express**, **Prisma ORM**, JWT auth, bcrypt password hashing,
Zod validation, Helmet/CORS/rate-limiting, and a seed derived from the exact mock data
the frontends already ship with.

---

## Tech stack

| Concern | Choice |
|---|---|
| Runtime | Node.js (ESM) |
| Framework | Express 4 |
| ORM / DB | Prisma + **SQLite** (default, zero setup) — swap to PostgreSQL in one line |
| Auth | JWT (`Bearer` tokens) + bcrypt |
| Validation | Zod |
| Security | Helmet, CORS allow-list, express-rate-limit |
| Logging | Morgan (dev) |

---

## Quick start

```bash
cd BRG-Prime-Backend

# 1. install
npm install

# 2. copy env (already created for you if .env exists)
cp .env.example .env

# 3. create the database + generate client + seed data
npm run setup        # = prisma generate && prisma migrate dev && seed

# 4. run
npm run dev          # auto-reload
# or
npm start
```

Server: **http://localhost:4000** · API root: **http://localhost:4000/api**

### Seeded demo accounts

| Role | Email | Password |
|---|---|---|
| User | `tunde@example.com` | `password123` |
| Admin | `admin@brgprime.ng` | `password123` |

Seller/agent accounts (e.g. `sarah.williams@brgprime.ng`) also use `password123`.

---

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Start with `--watch` auto-reload |
| `npm start` | Start (production style) |
| `npm run setup` | generate + migrate + seed (one-shot bootstrap) |
| `npm run db:seed` | Re-seed the database from mock data |
| `npm run db:reset` | Drop, re-migrate and re-seed |
| `npm run db:studio` | Open Prisma Studio (visual DB browser) |

---

## Environment (`.env`)

```
NODE_ENV=development
PORT=4000
CORS_ORIGIN=http://localhost:5173,http://localhost:3000
DATABASE_URL="file:./dev.db"
JWT_SECRET=change-this-to-a-long-random-secret-in-production
JWT_EXPIRES_IN=30d
OTP_RETURN_IN_RESPONSE=true     # dev: OTP is returned in the response for auto-fill
```

---

## Response envelope

Success:
```json
{ "success": true, "data": <payload>, "meta": { ... }, "message": "…" }
```
Error:
```json
{ "success": false, "error": { "message": "…", "details": [ { "path": "email", "message": "…" } ] } }
```

Auth: send `Authorization: Bearer <token>` (or `?token=` for image-style GETs).

---

## Endpoints

### Auth — `/api/auth`
| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/register` | – | Creates account, issues OTP. Body: `firstName,lastName,email,phone,password` (or `name`). Returns `devOtp` in dev. |
| POST | `/verify-otp` | – | Body `{ email, code }` → `{ token, user }`. |
| POST | `/resend-otp` | – | Re-issues OTP. |
| POST | `/login` | – | Body `{ email, password }` → `{ token, user }`. |
| POST | `/forgot-password` | – | Emails a 6-digit reset **code** (OTP), not a link. |
| POST | `/reset-password` | – | Body `{ email, code, newPassword }` → logs in with a fresh token. |
| GET | `/me` | ✅ | Current user. |

### Users — `/api/users`
| GET `/me` · PATCH `/me` · POST `/me/change-password` · DELETE `/me` | ✅ |

### Properties — `/api/properties`
| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/` | optional | Filters: `search,q,location,tab,listingType,propertyType,minPrice,maxPrice,bedrooms,bathrooms,verifiedOnly,featured,recent,saved,sort,page,limit`. Default sort = premium → boosted → newest. `tab` accepts `All,Buy,Sell,Rent,Lease,Shortlet,Commercial,Land,New Dev`. |
| GET | `/featured` | optional | Verified, first 6. |
| GET | `/recent` | optional | Recently posted, first 4. |
| GET | `/mine` | ✅ | Caller's listings. |
| GET | `/:id` | optional | Detail (increments view count). |
| POST | `/` | ✅ | Create listing. **Quota-gated** — 403 `LISTING_LIMIT_REACHED` when at plan limit. Consumes premium/boost allowance when `isPremium`/`isBoosted` set on a paid plan. |
| PATCH | `/:id` | ✅ | Owner/admin edit. |
| DELETE | `/:id` | ✅ | Owner/admin delete. |

### Favorites — `/api/favorites`
`GET /` (full objects) · `GET /ids` · `POST /:propertyId/toggle` — all ✅.

### Subscriptions — `/api/subscriptions`
`GET /plans` (public) · `GET /me` · `POST /subscribe` `{ planId, billing }` (simulated Paystack) · `POST /use-premium` · `POST /use-boost`.

### Forum — `/api/forum`
`GET /messages` · `POST /messages` `{ text }` (returns your message + a simulated reply).

### Notifications — `/api/notifications`
`GET /` · `GET /unread-count` · `PATCH /:id/read` · `POST /read-all`.

### Payments — `/api/payments`
Rent ledger: `GET /` (history + summary totals) · `POST /` `{ tenantName, property, amount, status }`.
Paystack (subscriptions): `GET /paystack/config` · `POST /paystack/initialize` `{ planId, billing }`
→ returns `authorizationUrl` + `reference`; `GET /paystack/verify/:reference` activates the plan;
`POST /paystack/webhook` (Paystack → server, signature-verified).

### Uploads — `/api/uploads` (Cloudflare R2)
`GET /config` · `POST /image` (multipart field `image`) · `POST /images` (field `images`, up to 10)
→ returns public R2 URL(s) to store in a listing's `images`.

### Viewings — `/api/viewings`
`GET /` · `POST /` `{ propertyId, fullName, phone, email?, date, time, message? }`.

### Meta — `/api/meta`
`GET /locations` · `GET /dashboard-stats`.

### Admin — `/api/admin` (requires `role: admin`)
`GET /overview` · `GET /users` · `GET /users/:id` · `PATCH /users/:id/status` ·
`GET /listings` · `PATCH /listings/:id` (`action: toggleVerified|approve|enable|disable`) · `DELETE /listings/:id` ·
`GET /revenue` · `GET /analytics` · `GET /reports`.

---

## Connecting the frontends

The apps were originally frontend-only (mock data + `localStorage`). To use this API,
point them at `http://localhost:4000/api` and replace the store internals with HTTP calls:

- **Web (Vue/Pinia):** in each store action, call the matching endpoint and keep the JWT
  in `localStorage` under `user_token`. Attach it as `Authorization: Bearer`. The response
  shapes mirror the mock objects (property fields, plan snapshot, notifications, etc.).
- **Mobile (Flutter):** use an `http`/`dio` client with a base URL. On an Android emulator,
  reach the host machine via `http://10.0.2.2:4000/api` (not `localhost`). Add that origin
  to `CORS_ORIGIN` if needed. Store the token with `shared_preferences`.

Property images are still bundled in the apps (`/properties/pNN.jpeg`); the API returns the
same relative paths in each property's `images` array.

---

## Going live (Neon + Render + Resend + R2 + Paystack)

See **[DEPLOYMENT.md](./DEPLOYMENT.md)** for the full step-by-step, including exactly
where to get each API key. Quick switch to Postgres locally:

```bash
npm run use:postgres           # flips Prisma provider to postgresql
# set DATABASE_URL to your Neon string, then:
rm -rf prisma/migrations && npx prisma migrate dev --name init && npm run db:seed
```

All integrations degrade gracefully when their keys are absent (email → console log,
Paystack/uploads → `503` with a clear message), so the app runs locally with zero secrets.

---

## Project structure

```
src/
  app.js            Express app (middleware, CORS, routes)
  server.js         Bootstrap + graceful shutdown
  config/           env, prisma client, plan catalogue, locations
  middleware/       auth, validation, error handling
  controllers/      one per resource
  routes/           one per resource + index
  validators/       Zod schemas
  utils/            jwt, ApiError, serializers, responders
prisma/
  schema.prisma     data model
  seed.js           seed from mock data
  seed-data/        copied frontend mock data
```
