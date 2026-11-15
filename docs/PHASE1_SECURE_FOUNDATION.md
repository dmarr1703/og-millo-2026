# Millo Phase 1 — Secure foundation

## Confirmed product rules

- Canadian launch; CAD as the storefront and settlement currency.
- Supplier listing fee: **$35.00 CAD per product** (3,500 cents).
- Marketplace commission: **10%** of the eligible item subtotal (1,000 basis points).
- Suppliers own and maintain their inventory.
- Suppliers package and ship orders directly to customers.
- Preserve the current black-and-gold Millo storefront and brand identity.

## Repository findings (before changes)

The existing app is a single large HTML/JavaScript storefront plus an Express server. Customer and supplier accounts, product records and session state are stored in browser localStorage. Owner sessions, rate-limit counters, pending listing data and confirmed payment data are held in Node process memory. Those stores are not durable or shared across customers, suppliers, or serverless instances.

The current listing checkout is hard-coded to **$25 CAD** in the backend and in the payment success UI. This phase establishes the $35 CAD rule in the database and configuration plan; the live checkout flow must not be considered migrated until the later payment integration replaces all hard-coded values and stores verified webhook results durably.

## Phase 1 deliverables

1. A PostgreSQL schema for user profiles, supplier applications and supplier accounts, categories, products, product images, Canadian customer addresses, orders, per-supplier order items, listing-fee payments, payment transactions, supplier payouts, returns, reviews, webhook idempotency and audit logs.
2. Row Level Security on every application table. Public visitors can read active products and categories; users can read their own account data; supplier access is scoped to their own products and fulfilment records; payment webhooks and audit records are service-role only.
3. Supabase Auth is the intended identity provider. The auth trigger creates a customer profile and intentionally ignores user-controlled role metadata. Supplier status and admin privileges must be granted only by trusted server-side actions.
4. Environment variable template for Supabase and payment provider credentials. Real secrets must be entered in the hosting provider's encrypted environment settings, never committed to Git or pasted into chat.
5. This implementation note and the staged migration plan.

## Phase 1 not yet complete / prerequisites

- The SQL migration has been committed but has **not** been applied to a Supabase project.
- No Supabase project URL, anon key or service-role key has been supplied/configured for this repository.
- Existing browser-based signup/sign-in has not yet been switched to Supabase Auth.
- Existing owner login still uses process-memory sessions; durable owner/admin auth is a required next implementation task.
- Product, checkout, webhook, order and payout routes still need to be migrated to database-backed operations.
- The current Vercel deployment architecture must be validated before changing the Express entrypoint. Do not assume a successful Git commit means the application is deployed or working.

## Security invariants

- Never expose the Supabase service-role key or Stripe secret key in browser JavaScript.
- Never trust a product price, commission, supplier identity, order total, listing-fee amount or payment status supplied by the browser.
- Create orders and payment intents only on the server using prices re-read from the database.
- Verify Stripe webhook signatures and store event IDs before applying side effects; repeated webhook deliveries must be idempotent.
- A supplier may only read/update their own records and may never approve their own application or publish their own product.
- Only trusted admin operations may change account roles, supplier approval, product approval, refunds or payout state.
- Store money as integer cents. Tax must be calculated using the applicable Canadian place-of-supply rules; do not hard-code a universal tax rate.

## Next implementation sequence

1. Provision Supabase (Canada region where available), apply this migration, and configure Auth redirect URLs.
2. Implement server-side Supabase clients and replace browser localStorage auth with Supabase Auth; migrate the owner account securely and remove password-based local demo accounts.
3. Add protected API routes for supplier applications, product CRUD, product review and image uploads.
4. Move product and supplier data from localStorage into PostgreSQL; retain the current UI and gold/black styling.
5. Replace the listing checkout amount with a server-owned 3,500-cent constant and persist checkout/webhook state.
6. Only after identity and product persistence are verified, build Stripe Connect, cart checkout, per-supplier fulfilment, commission accounting and payouts.
7. Add tests for RLS isolation, role escalation, supplier cross-account access, price tampering, webhook replay and serverless cold starts.

## Business calculation

For an eligible $100.00 CAD item subtotal, the Millo commission is $10.00 CAD and the supplier share before payment processing, shipping and applicable taxes/adjustments is $90.00 CAD. Shipping is fulfilled by the supplier. Final settlement logic must account for refunds, disputes and Stripe Connect fees.
