# Millo — full Canadian marketplace implementation roadmap

## Business configuration

| Setting | Value |
| --- | --- |
| Launch market | Canada |
| Currency | CAD |
| Supplier listing fee | $35.00 CAD per product |
| Millo commission | 10% (1,000 basis points) |
| Inventory owner | Supplier |
| Fulfilment and shipping | Supplier ships directly to customer |

## Workstreams

### Phase 1 — Secure foundation
- [x] Inspect current GitHub source before editing.
- [x] Preserve existing storefront and branding; work on a feature branch.
- [x] Define durable PostgreSQL data model and row-level access policies.
- [x] Document security invariants and rollout sequence.
- [x] Add Supabase and marketplace configuration template.
- [ ] Provision Supabase project and apply migration.
- [ ] Configure environment variables in Vercel.
- [ ] Replace localStorage accounts and process-memory sessions with durable authentication.

### Phase 2 — Marketplace data and supplier operations
- Supabase Auth for customers and suppliers.
- Supplier application submission, admin approval and suspension.
- Product CRUD, image storage, listing-fee payment state and admin moderation.
- Supplier-owned stock quantities and stock reservation checks.
- Remove demo credentials and all trust in browser-provided supplier IDs.

### Phase 3 — Customer shopping and payment
- Product search, category browsing and product detail pages.
- Persistent carts and Canadian addresses.
- Server-calculated checkout totals and applicable tax.
- Stripe Connect onboarding and compliant payment routing.
- 10% commission ledger, listing fees, webhook verification and idempotency.

### Phase 4 — Supplier fulfilment and owner control
- Supplier order queue, shipment confirmation, carrier and tracking number.
- Customer order history, notifications, returns and refund workflows.
- Owner dashboard, approvals, account controls, reporting and audit trail.
- Supplier payout visibility and reconciliation.

### Phase 5 — Canadian launch readiness
- Canadian shipping provider integration and shipping policies.
- GST/HST/PST/QST assessment, receipts and tax reporting.
- Privacy, terms, supplier agreement, returns and consumer disclosures.
- Accessibility, mobile, load, fraud, security and recovery tests.
- Test-mode end-to-end checkout, then production launch checklist.

## Release gates

No real customer orders until:
1. Database migration is applied and RLS tests pass.
2. Authentication is server-verified and cross-account access is blocked.
3. Prices, listing fees and commission are calculated server-side.
4. Stripe webhook signatures are verified and webhook events are idempotent.
5. Supplier Connect onboarding and payouts have been tested end-to-end.
6. Order, shipping, refund and tax records reconcile.
