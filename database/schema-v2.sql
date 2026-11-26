
-- PharmaFind 2.0 - Updated Supabase Database Schema
-- Authentication is handled by Supabase Auth.
-- Trusted backend operations use the Supabase service-role key.

create extension if not exists pgcrypto;

-- 1. USER PROFILES
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  role text not null default 'customer'
    check (role in ('customer', 'owner', 'admin')),
  phone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- New signups always start as customers.
-- Backend must explicitly approve owner/admin roles.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', 'New User'),
    'customer'
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

-- 2. PHARMACIES
create table if not exists public.pharmacies (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id),
  name text not null,
  address text not null,
  city text not null,
  phone text,
  description text,
  latitude double precision,
  longitude double precision,
  verified boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (latitude is null or latitude between -90 and 90),
  check (longitude is null or longitude between -180 and 180)
);

-- 3. MEDICINE CATEGORIES
create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  category_name text not null unique,
  description text,
  created_at timestamptz not null default now()
);

-- 4. MEDICINE CATALOGUE
create table if not exists public.medicines (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  generic_name text,
  brand text,
  category_id uuid references public.categories(id),
  dosage_form text,
  prescription_required boolean not null default false,
  description text,
  created_at timestamptz not null default now()
);

-- 5. PHARMACY INVENTORY
 (
  id uuid primary key default gen_random_uuid(),
  pharmacy_id uuid not null references public.pharmacies(id) on delete cascade,
  medicine_id uuid not null references public.medicines(id),
  price numeric(10,2) not null check (price >= 0),create table if not exists public.inventory
  stock integer not null default 0 check (stock >= 0),
  low_stock_threshold integer not null default 10
    check (low_stock_threshold >= 0),
  updated_at timestamptz not null default now(),
  unique (pharmacy_id, medicine_id)
);

-- 6. INVENTORY BATCHES / EXPIRY TRACKING
create table if not exists public.inventory_batches (
  id uuid primary key default gen_random_uuid(),
  inventory_id uuid not null references public.inventory(id) on delete cascade,
  batch_number text,
  quantity integer not null check (quantity >= 0),
  expiry_date date not null,
  created_at timestamptz not null default now()
);

-- 7. VERIFIED MEDICINE ALTERNATIVES
create table if not exists public.medicine_alternatives (
  id uuid primary key default gen_random_uuid(),
  medicine_id uuid not null references public.medicines(id) on delete cascade,
  alternative_medicine_id uuid not null references public.medicines(id) on delete cascade,
  reason text,
  pharmacist_verified boolean not null default false,
  created_at timestamptz not null default now(),
  unique (medicine_id, alternative_medicine_id),
  check (medicine_id <> alternative_medicine_id)
);

-- 8. CUSTOMER ADDRESSES
create table if not exists public.customer_addresses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  label text,
  address text not null,
  city text not null,
  phone text,
  created_at timestamptz not null default now()
);

-- 9. ORDERS
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.profiles(id),
  pharmacy_id uuid not null references public.pharmacies(id),
  status text not null default 'Pending'
    check (status in (
      'Pending', 'Confirmed', 'Ready for pickup',
      'Completed', 'Cancelled'
    )),
  delivery_address text not null,
  contact_phone text not null,
  subtotal numeric(10,2) not null check (subtotal >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 10. ORDER ITEMS
create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  inventory_id uuid not null references public.inventory(id),
  medicine_name text not null,
  quantity integer not null check (quantity > 0),
  unit_price numeric(10,2) not null check (unit_price >= 0)
);

-- 11. ORDER STATUS HISTORY
create table if not exists public.order_status_history (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  changed_by uuid references public.profiles(id),
  old_status text,
  new_status text not null,
  note text,
  created_at timestamptz not null default now()
);

-- 12. REVIEWS
create table if not exists public.reviews (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.profiles(id) on delete cascade,
  pharmacy_id uuid not null references public.pharmacies(id) on delete cascade,
  rating integer not null check (rating between 1 and 5),
  comment text,
  created_at timestamptz not null default now(),
  unique (customer_id, pharmacy_id)
);

-- 13. NOTIFICATIONS
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  message text not null,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

-- 14. ADMIN AUDIT LOGS
create table if not exists public.admin_audit_logs (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid references public.profiles(id),
  action text not null,
  target_type text,
  target_id text,
  details jsonb,
  created_at timestamptz not null default now()
);

-- INDEXES
create index if not exists inventory_pharmacy_idx
  on public.inventory(pharmacy_id);
create index if not exists inventory_medicine_idx
  on public.inventory(medicine_id);
create index if not exists inventory_batch_expiry_idx
  on public.inventory_batches(expiry_date);
create index if not exists orders_customer_idx
  on public.orders(customer_id, created_at desc);
create index if not exists orders_pharmacy_idx
  on public.orders(pharmacy_id, created_at desc);
create index if not exists pharmacies_city_idx
  on public.pharmacies(city);
create index if not exists order_history_idx
  on public.order_status_history(order_id, created_at desc);
create index if not exists notifications_user_idx
  on public.notifications(user_id, created_at desc);

-- ENABLE ROW LEVEL SECURITY
alter table public.profiles enable row level security;
alter table public.pharmacies enable row level security;
alter table public.categories enable row level security;
alter table public.medicines enable row level security;
alter table public.inventory enable row level security;
alter table public.inventory_batches enable row level security;
alter table public.medicine_alternatives enable row level security;
alter table public.customer_addresses enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.order_status_history enable row level security;
alter table public.reviews enable row level security;
alter table public.notifications enable row level security;
alter table public.admin_audit_logs enable row level security;

-- PUBLIC READ POLICIES FOR CATALOGUE AND PHARMACY DISCOVERY
drop policy if exists "public read categories" on public.categories;
create policy "public read categories"
on public.categories for select using (true);

drop policy if exists "public read medicines" on public.medicines;
create policy "public read medicines"
on public.medicines for select using (true);

drop policy if exists "public read pharmacies" on public.pharmacies;
create policy "public read pharmacies"
on public.pharmacies for select using (true);
drop policy if exists "public read verified alternatives"
on public.medicine_alternatives;
create policy "public read verified alternatives"
on public.medicine_alternatives for select
using (pharmacist_verified = true);

-- USER-OWNED DATA POLICIES
drop policy if exists "profile owner access" on public.profiles;
create policy "profile owner access"
on public.profiles for select
using (auth.uid() = id);

drop policy if exists "customer address owner access"
on public.customer_addresses;
create policy "customer address owner access"
on public.customer_addresses for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "customer order access" on public.orders;
create policy "customer order access"
on public.orders for select
using (auth.uid() = customer_id);

drop policy if exists "customer order item access" on public.order_items;
create policy "customer order item access"
on public.order_items for select
using (
  exists (
    select 1 from public.orders o
    where o.id = order_id and o.customer_id = auth.uid()
  )
);

drop policy if exists "customer order history access"
on public.order_status_history;
create policy "customer order history access"
on public.order_status_history for select
using (
  exists (
    select 1 from public.orders o
    where o.id = order_id and o.customer_id = auth.uid()
  )
);

drop policy if exists "notification owner access"
on public.notifications;
create policy "notification owner access"
on public.notifications for select
using (auth.uid() = user_id);

drop policy if exists "notification owner update"
on public.notifications;
create policy "notification owner update"
on public.notifications for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "public read reviews" on public.reviews;
create policy "public read reviews"
on public.reviews for select using (true);

-- Backend uses the service-role key for trusted operations.
-- Never expose that key in frontend code.
