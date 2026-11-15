-- Millo Marketplace — Phase 1 database foundation
-- Apply with Supabase CLI: supabase db push
-- All money is stored in integer cents. Default marketplace currency is CAD.

create extension if not exists pgcrypto;

create type public.account_role as enum ('customer', 'supplier', 'admin');
create type public.supplier_status as enum ('pending', 'approved', 'rejected', 'suspended');
create type public.product_status as enum ('draft', 'pending_review', 'active', 'rejected', 'archived');
create type public.order_status as enum ('pending_payment', 'paid', 'processing', 'shipped', 'delivered', 'cancelled', 'partially_refunded', 'refunded');
create type public.payment_status as enum ('pending', 'succeeded', 'failed', 'refunded', 'partially_refunded');
create type public.return_status as enum ('requested', 'approved', 'rejected', 'in_transit', 'received', 'refunded', 'closed');

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text,
  phone text,
  role public.account_role not null default 'customer',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Role is deliberately NOT copied from user-controlled auth metadata.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, coalesce(new.email, ''), nullif(new.raw_user_meta_data ->> 'full_name', ''))
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

create table public.supplier_applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.profiles(id) on delete cascade,
  business_name text not null,
  legal_business_name text,
  contact_name text not null,
  contact_email text not null,
  phone text,
  website_url text,
  business_number text,
  province char(2),
  address jsonb not null default '{}'::jsonb,
  product_categories text[] not null default '{}',
  description text,
  status public.supplier_status not null default 'pending',
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  review_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.profiles(id) on delete restrict,
  application_id uuid unique references public.supplier_applications(id),
  business_name text not null,
  status public.supplier_status not null default 'pending',
  stripe_account_id text unique,
  stripe_onboarding_complete boolean not null default false,
  payout_currency char(3) not null default 'CAD',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  parent_id uuid references public.categories(id),
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references public.suppliers(id) on delete restrict,
  category_id uuid references public.categories(id),
  name text not null,
  slug text not null unique,
  description text not null default '',
  sku text,
  price_cents bigint not null check (price_cents > 0),
  currency char(3) not null default 'CAD' check (currency = 'CAD'),
  inventory_quantity integer not null default 0 check (inventory_quantity >= 0),
  status public.product_status not null default 'draft',
  listing_fee_status public.payment_status not null default 'pending',
  listing_fee_cents integer not null default 3500 check (listing_fee_cents = 3500),
  weight_grams integer check (weight_grams is null or weight_grams >= 0),
  shipping_details jsonb not null default '{}'::jsonb,
  approved_at timestamptz,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (supplier_id, sku)
);

create or replace function public.prevent_supplier_product_approval_bypass()
returns trigger language plpgsql security definer set search_path = ''
as $
begin
  if coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'admin'
     and coalesce(auth.role(), '') <> 'service_role' then
    if new.status is distinct from old.status
       or new.approved_at is distinct from old.approved_at
       or new.listing_fee_status is distinct from old.listing_fee_status
       or new.listing_fee_cents is distinct from old.listing_fee_cents then
      raise exception 'Product approval and listing payment state are controlled by Millo administrators and payment webhooks';
    end if;
  end if;
  return new;
end;
$;

create trigger prevent_supplier_product_approval_bypass
before update on public.products
for each row execute procedure public.prevent_supplier_product_approval_bypass();

create table public.product_images (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  storage_path text not null,
  alt_text text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table public.customer_addresses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  recipient_name text not null,
  phone text,
  address_line1 text not null,
  address_line2 text,
  city text not null,
  province char(2) not null,
  postal_code text not null,
  country char(2) not null default 'CA' check (country = 'CA'),
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique,
  customer_id uuid not null references public.profiles(id) on delete restrict,
  status public.order_status not null default 'pending_payment',
  currency char(3) not null default 'CAD' check (currency = 'CAD'),
  subtotal_cents bigint not null check (subtotal_cents >= 0),
  shipping_cents bigint not null default 0 check (shipping_cents >= 0),
  tax_cents bigint not null default 0 check (tax_cents >= 0),
  total_cents bigint not null check (total_cents >= 0),
  shipping_address_snapshot jsonb not null,
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id text unique,
  placed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  supplier_id uuid not null references public.suppliers(id) on delete restrict,
  product_name_snapshot text not null,
  sku_snapshot text,
  quantity integer not null check (quantity > 0),
  unit_price_cents bigint not null check (unit_price_cents >= 0),
  commission_rate_bps integer not null default 1000 check (commission_rate_bps between 0 and 10000),
  commission_cents bigint not null default 0 check (commission_cents >= 0),
  supplier_amount_cents bigint not null default 0 check (supplier_amount_cents >= 0),
  supplier_fulfilment_status text not null default 'awaiting_fulfilment',
  tracking_number text,
  carrier text,
  shipped_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.payment_transactions (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references public.orders(id) on delete set null,
  customer_id uuid references public.profiles(id) on delete set null,
  stripe_payment_intent_id text unique,
  stripe_charge_id text,
  amount_cents bigint not null check (amount_cents >= 0),
  currency char(3) not null default 'CAD',
  status public.payment_status not null default 'pending',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.listing_fee_payments (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete restrict,
  supplier_id uuid not null references public.suppliers(id) on delete restrict,
  amount_cents integer not null default 3500 check (amount_cents = 3500),
  currency char(3) not null default 'CAD' check (currency = 'CAD'),
  status public.payment_status not null default 'pending',
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id text unique,
  paid_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.supplier_payouts (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references public.suppliers(id) on delete restrict,
  order_item_id uuid not null references public.order_items(id) on delete restrict,
  gross_cents bigint not null check (gross_cents >= 0),
  commission_cents bigint not null check (commission_cents >= 0),
  stripe_fee_cents bigint not null default 0 check (stripe_fee_cents >= 0),
  net_cents bigint not null check (net_cents >= 0),
  currency char(3) not null default 'CAD',
  status public.payment_status not null default 'pending',
  stripe_transfer_id text unique,
  paid_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.returns (
  id uuid primary key default gen_random_uuid(),
  order_item_id uuid not null references public.order_items(id) on delete restrict,
  customer_id uuid not null references public.profiles(id) on delete restrict,
  reason text not null,
  details text,
  status public.return_status not null default 'requested',
  resolution_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.reviews (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  customer_id uuid not null references public.profiles(id) on delete cascade,
  order_item_id uuid not null unique references public.order_items(id) on delete restrict,
  rating integer not null check (rating between 1 and 5),
  title text,
  body text,
  is_published boolean not null default true,
  created_at timestamptz not null default now(),
  unique (product_id, customer_id, order_item_id)
);

create table public.webhook_events (
  id text primary key,
  provider text not null default 'stripe',
  event_type text not null,
  processed_at timestamptz,
  processing_error text,
  created_at timestamptz not null default now()
);

create table public.audit_logs (
  id bigint generated always as identity primary key,
  actor_id uuid references public.profiles(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index products_public_browse_idx on public.products(status, category_id, created_at desc);
create index products_supplier_idx on public.products(supplier_id, status);
create index orders_customer_idx on public.orders(customer_id, created_at desc);
create index order_items_supplier_idx on public.order_items(supplier_id, created_at desc);
create index supplier_payouts_supplier_idx on public.supplier_payouts(supplier_id, created_at desc);
create index applications_status_idx on public.supplier_applications(status, created_at desc);

do $$
declare t text;
begin
  foreach t in array array['profiles','supplier_applications','suppliers','products','customer_addresses','orders','payment_transactions','returns']
  loop
    execute format('create trigger set_%I_updated_at before update on public.%I for each row execute procedure public.set_updated_at()', t, t);
  end loop;
end $$;

alter table public.profiles enable row level security;
alter table public.supplier_applications enable row level security;
alter table public.suppliers enable row level security;
alter table public.categories enable row level security;
alter table public.products enable row level security;
alter table public.product_images enable row level security;
alter table public.customer_addresses enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.payment_transactions enable row level security;
alter table public.listing_fee_payments enable row level security;
alter table public.supplier_payouts enable row level security;
alter table public.returns enable row level security;
alter table public.reviews enable row level security;
alter table public.webhook_events enable row level security;
alter table public.audit_logs enable row level security;

create policy "Profiles are visible to their owner or admins" on public.profiles
for select to authenticated using (id = (select auth.uid()) or (select auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');
create or replace function public.prevent_profile_role_escalation()
returns trigger language plpgsql security definer set search_path = ''
as $
begin
  if new.role is distinct from old.role
     and coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'admin'
     and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Profile role changes require an administrator';
  end if;
  return new;
end;
$;

create trigger prevent_profile_role_escalation
before update of role on public.profiles
for each row execute procedure public.prevent_profile_role_escalation();

create policy "Users can update their own basic profile" on public.profiles
for update to authenticated using (id = (select auth.uid()))
with check (id = (select auth.uid()));

create policy "Users can submit their own supplier application" on public.supplier_applications
for insert to authenticated with check (user_id = (select auth.uid()) and status = 'pending');
create policy "Applicants can view their application" on public.supplier_applications
for select to authenticated using (user_id = (select auth.uid()) or (select auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

create policy "Suppliers can view their own supplier profile" on public.suppliers
for select to authenticated using (user_id = (select auth.uid()) or (select auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

create policy "Active categories are public" on public.categories
for select to anon, authenticated using (is_active = true);

create policy "Published products are public; suppliers see their own" on public.products
for select to anon, authenticated using (
  status = 'active'
  or exists (select 1 from public.suppliers s where s.id = supplier_id and s.user_id = (select auth.uid()))
  or (select auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
);
create policy "Approved suppliers can create draft products" on public.products
for insert to authenticated with check (
  status in ('draft','pending_review')
  and exists (select 1 from public.suppliers s where s.id = supplier_id and s.user_id = (select auth.uid()) and s.status = 'approved')
);
create policy "Suppliers can update their own non-live product fields" on public.products
for update to authenticated using (
  exists (select 1 from public.suppliers s where s.id = supplier_id and s.user_id = (select auth.uid()))
) with check (
  exists (select 1 from public.suppliers s where s.id = supplier_id and s.user_id = (select auth.uid()))
);

create policy "Images follow product visibility" on public.product_images
for select to anon, authenticated using (
  exists (select 1 from public.products p where p.id = product_id and (
    p.status = 'active' or exists (select 1 from public.suppliers s where s.id = p.supplier_id and s.user_id = (select auth.uid()))
    or (select auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  ))
);
create policy "Supplier can add images to own products" on public.product_images
for insert to authenticated with check (
  exists (select 1 from public.products p join public.suppliers s on s.id = p.supplier_id where p.id = product_id and s.user_id = (select auth.uid()))
);

create policy "Customers manage their own addresses" on public.customer_addresses
for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy "Customers and suppliers can view relevant orders" on public.orders
for select to authenticated using (
  customer_id = (select auth.uid())
  or exists (select 1 from public.order_items oi join public.suppliers s on s.id = oi.supplier_id where oi.order_id = id and s.user_id = (select auth.uid()))
  or (select auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
);
create policy "Order items visible to customer, supplier, or admin" on public.order_items
for select to authenticated using (
  exists (select 1 from public.orders o where o.id = order_id and o.customer_id = (select auth.uid()))
  or exists (select 1 from public.suppliers s where s.id = supplier_id and s.user_id = (select auth.uid()))
  or (select auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
);

create policy "Customers view their payment records" on public.payment_transactions
for select to authenticated using (customer_id = (select auth.uid()) or (select auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');
create policy "Suppliers view their listing fee payments" on public.listing_fee_payments
for select to authenticated using (
  exists (select 1 from public.suppliers s where s.id = supplier_id and s.user_id = (select auth.uid()))
  or (select auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
);
create policy "Suppliers view their payouts" on public.supplier_payouts
for select to authenticated using (
  exists (select 1 from public.suppliers s where s.id = supplier_id and s.user_id = (select auth.uid()))
  or (select auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
);
create policy "Customers view their returns" on public.returns
for select to authenticated using (customer_id = (select auth.uid()) or (select auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');
create policy "Customers request returns for their orders" on public.returns
for insert to authenticated with check (
  customer_id = (select auth.uid())
  and exists (select 1 from public.order_items oi join public.orders o on o.id = oi.order_id where oi.id = order_item_id and o.customer_id = (select auth.uid()))
);
create policy "Published reviews are public" on public.reviews
for select to anon, authenticated using (is_published = true);
create policy "Verified buyers can write reviews" on public.reviews
for insert to authenticated with check (
  customer_id = (select auth.uid())
  and exists (select 1 from public.order_items oi join public.orders o on o.id = oi.order_id where oi.id = order_item_id and oi.product_id = product_id and o.customer_id = (select auth.uid()) and o.status in ('delivered','shipped'))
);
create policy "Review authors can edit their own reviews" on public.reviews
for update to authenticated using (customer_id = (select auth.uid())) with check (customer_id = (select auth.uid()));

-- Sensitive financial records, webhook events and audit logs are service-role only.
-- No client-facing policies are intentionally defined for webhook_events or audit_logs.
