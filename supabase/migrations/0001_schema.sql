-- =====================================================================
-- Tarifador BIDCOM · Fase 2 · Esquema de base de datos
-- PostgreSQL 15+ / Supabase
-- Principios:
--   * Cotización = cabecera -> versiones inmutables -> rutas -> líneas
--   * Todo lo comparable apunta a catálogos maestros (con alias)
--   * Cada tabla con datos comerciales lleva agent_id (para RLS)
--   * mode = 'sea' | 'air' para crecer a aéreo sin rediseñar
-- =====================================================================

create extension if not exists pgcrypto;
create extension if not exists unaccent;

-- ---------------------------------------------------------------------
-- Tipos
-- ---------------------------------------------------------------------
create type transport_mode   as enum ('sea', 'air');
create type user_role        as enum ('agent', 'bidcom_analyst', 'bidcom_admin');
create type service_type     as enum ('direct', 'transshipment');
create type payment_terms    as enum ('COLLECT', 'PREPAID');
create type charge_category  as enum ('fixed', 'variable');
create type traffic_light    as enum ('green', 'yellow', 'orange', 'red', 'no_reference');
create type quote_status as enum (
  'draft',               -- Borrador
  'submitted',           -- Enviada
  'in_review',           -- En revisión BIDCOM
  'incomplete',          -- Información incompleta
  'within_target',       -- Dentro de objetivo
  'needs_renegotiation', -- Requiere renegociación
  'renegotiation_requested', -- Renegociación solicitada
  'renegotiated',        -- Renegociada
  'shortlist',           -- Mejor oferta / Shortlist
  'approved',            -- Aprobada
  'rejected',            -- Rechazada
  'expired'              -- Vencida
);

-- Normaliza texto para comparar alias: mayúsculas, sin tildes, espacios simples
create or replace function norm_text(t text) returns text
language sql immutable as $$
  select nullif(regexp_replace(upper(trim(unaccent(coalesce(t, '')))), '\s+', ' ', 'g'), '')
$$;

-- ---------------------------------------------------------------------
-- Catálogos maestros
-- ---------------------------------------------------------------------
create table countries (
  code char(2) primary key,
  name text not null
);

create table currencies (
  code char(3) primary key,
  name text not null,
  active boolean not null default true
);

create table exchange_rates (
  currency char(3) not null references currencies(code),
  rate_date date not null,
  rate_to_base numeric(18,8) not null check (rate_to_base > 0),
  primary key (currency, rate_date)
);

create table ports (
  id uuid primary key default gen_random_uuid(),
  unlocode varchar(5) unique,
  name text not null,
  country_code char(2) references countries(code),
  mode transport_mode not null default 'sea',
  active boolean not null default true
);

create table port_aliases (
  alias text primary key,                -- siempre norm_text(...)
  port_id uuid not null references ports(id) on delete cascade
);

create table port_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  agent_id uuid,                          -- grupo definido por un agente (ej. "BASE PORT" de KN)
  notes text
);

create table port_group_members (
  group_id uuid not null references port_groups(id) on delete cascade,
  port_id uuid not null references ports(id),
  primary key (group_id, port_id)
);

create table shipping_lines (
  id uuid primary key default gen_random_uuid(),
  scac varchar(4) unique,
  name text not null unique,
  is_carrier boolean not null default true,  -- false para NVOCC / "SPOT" / "Varias líneas"
  active boolean not null default true
);

create table shipping_line_aliases (
  alias text primary key,
  shipping_line_id uuid not null references shipping_lines(id) on delete cascade
);

create table container_types (
  code varchar(10) primary key,           -- 20ST, 40ST, 40HQ, 40NOR, 40RF...
  iso_code varchar(4),
  teu numeric(3,1) not null,
  description text,
  mode transport_mode not null default 'sea',
  active boolean not null default true
);

create table container_aliases (
  alias text primary key,
  container_code varchar(10) not null references container_types(code)
);

create table charge_units (
  code varchar(20) primary key,           -- per_bl, per_container...
  name text not null
);

create table charge_types (
  id uuid primary key default gen_random_uuid(),
  code varchar(30) not null unique,       -- HANDLING, VGM, EIR...
  name text not null,
  category charge_category not null,
  default_unit varchar(20) references charge_units(code),
  is_standard boolean not null default true,
  requires_description boolean not null default false,
  mode transport_mode not null default 'sea',
  sort_order int not null default 100,
  active boolean not null default true
);

create table charge_aliases (
  alias text primary key,
  charge_type_id uuid not null references charge_types(id) on delete cascade
);

-- ---------------------------------------------------------------------
-- Agentes y usuarios
-- ---------------------------------------------------------------------
create table agents (
  id uuid primary key default gen_random_uuid(),
  code varchar(20) not null unique,       -- KN, DHL...
  name text not null,
  legal_name text,
  forwarder_network text,                 -- FFWW / red
  contact_email text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table port_groups
  add constraint port_groups_agent_fk foreign key (agent_id) references agents(id);

-- Perfil 1:1 con auth.users de Supabase
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  role user_role not null default 'agent',
  agent_id uuid references agents(id),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint agent_requires_agent_id check (role <> 'agent' or agent_id is not null)
);

-- ---------------------------------------------------------------------
-- Rondas de cotización (opcional, por quincena o mes)
-- ---------------------------------------------------------------------
create table rfq_rounds (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  mode transport_mode not null default 'sea',
  period_from date not null,
  period_to date not null,
  closes_at timestamptz,
  created_at timestamptz not null default now(),
  check (period_to >= period_from)
);

-- ---------------------------------------------------------------------
-- Cotizaciones
-- ---------------------------------------------------------------------
create sequence quote_number_seq;

create table quotes (
  id uuid primary key default gen_random_uuid(),
  number text not null unique
    default (to_char(now(), 'YYYY') || '-' || lpad(nextval('quote_number_seq')::text, 4, '0')),
  agent_id uuid not null references agents(id),
  rfq_round_id uuid references rfq_rounds(id),
  mode transport_mode not null default 'sea',
  status quote_status not null default 'draft',
  current_version int not null default 1,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on quotes (agent_id);
create index on quotes (status);

create table quote_versions (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references quotes(id) on delete restrict,
  agent_id uuid not null references agents(id),
  version_no int not null check (version_no >= 1),
  quote_date date not null default current_date,
  valid_from date,
  valid_to date,
  source text not null default 'form' check (source in ('form', 'excel', 'legacy')),
  remarks text,
  locked boolean not null default false,  -- true al enviar: queda inmutable
  submitted_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (quote_id, version_no),
  check (valid_to is null or valid_from is null or valid_to >= valid_from)
);
create index on quote_versions (agent_id);

create table quote_routes (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references quote_versions(id) on delete cascade,
  agent_id uuid not null references agents(id),
  origin_country char(2) references countries(code),
  pol_port_id uuid references ports(id),
  pol_group_id uuid references port_groups(id),
  pol_raw text,                           -- texto original, para trazabilidad
  pod_port_id uuid references ports(id),
  pod_raw text,
  dest_country char(2) references countries(code),
  service service_type,
  transship_port_id uuid references ports(id),
  shipping_line_id uuid references shipping_lines(id),
  shipping_line_raw text,
  transit_days int check (transit_days > 0),
  free_days_origin int check (free_days_origin >= 0),
  free_days_dest int check (free_days_dest >= 0),
  payment payment_terms,
  incoterm varchar(3),
  remarks text,
  check (pol_port_id is null or pol_group_id is null)  -- puerto O grupo, no ambos
);
create index on quote_routes (version_id);
create index on quote_routes (agent_id);

create table freight_rates (
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null references quote_routes(id) on delete cascade,
  agent_id uuid not null references agents(id),
  container_code varchar(10) not null references container_types(code),
  currency char(3) not null references currencies(code),
  amount numeric(14,2) not null check (amount >= 0),
  amount_base numeric(14,2),              -- convertido a moneda base
  all_in boolean not null default true,
  free_days int check (free_days >= 0),   -- los días libres varían por contenedor (ej. 18 en 20ST, 14 en 40NOR)
  unique (route_id, container_code)
);
create index on freight_rates (agent_id);

create table freight_surcharges (
  id uuid primary key default gen_random_uuid(),
  freight_rate_id uuid not null references freight_rates(id) on delete cascade,
  agent_id uuid not null references agents(id),
  code varchar(10) not null,              -- BAF, LSS, PSS, GRI, PEAK
  currency char(3) not null references currencies(code),
  amount numeric(14,2) not null,
  included_in_rate boolean not null default false
);

create table local_charges (
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null references quote_routes(id) on delete cascade,
  agent_id uuid not null references agents(id),
  charge_type_id uuid references charge_types(id),
  container_code varchar(10) references container_types(code),  -- si aplica a un contenedor
  currency char(3) not null references currencies(code),
  amount numeric(14,2) not null check (amount >= 0),
  amount_base numeric(14,2),
  unit varchar(20) not null references charge_units(code),
  description text,
  justification text,
  is_standard boolean not null default true
);
create index on local_charges (agent_id);
create index on local_charges (route_id);

create table quote_validation_issues (
  id bigserial primary key,
  version_id uuid not null references quote_versions(id) on delete cascade,
  agent_id uuid not null references agents(id),
  field text not null,
  row_ref text,
  message text not null,
  severity text not null default 'error' check (severity in ('error', 'warning'))
);

-- ---------------------------------------------------------------------
-- Importación de Excel
-- ---------------------------------------------------------------------
create table import_batches (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references agents(id),     -- nulo = importación legacy de BIDCOM
  kind text not null check (kind in ('agent_template', 'agent_legacy_format', 'bidcom_history')),
  file_name text not null,
  storage_path text,
  status text not null default 'preview' check (status in ('preview', 'confirmed', 'rejected')),
  row_count int,
  error_count int,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table import_rows (
  id bigserial primary key,
  batch_id uuid not null references import_batches(id) on delete cascade,
  agent_id uuid references agents(id),
  sheet text,
  row_no int not null,
  raw jsonb not null,
  errors jsonb not null default '[]'
);

-- ---------------------------------------------------------------------
-- Motor (solo BIDCOM)
-- ---------------------------------------------------------------------
create table settings (
  key text primary key,
  value jsonb not null,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);

create table target_rules (
  id uuid primary key default gen_random_uuid(),
  scope text not null default 'global' check (scope in ('global', 'route', 'line', 'container')),
  pol_port_id uuid references ports(id),
  pod_port_id uuid references ports(id),
  shipping_line_id uuid references shipping_lines(id),
  container_code varchar(10) references container_types(code),
  freight_reduction_pct numeric(5,2) not null default 15,
  local_reduction_pct numeric(5,2) not null default 15,
  min_observations int not null default 5,
  window_months int not null default 12,
  valid_from date not null default current_date,
  valid_to date,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table historical_rates (
  id bigserial primary key,
  source text not null check (source in ('legacy_excel', 'platform')),
  agent_id uuid references agents(id),
  quote_version_id uuid references quote_versions(id),
  pol_port_id uuid references ports(id),
  pol_group_id uuid references port_groups(id),
  pod_port_id uuid references ports(id),
  container_code varchar(10) references container_types(code),
  shipping_line_id uuid references shipping_lines(id),
  service service_type,
  charge_type_id uuid references charge_types(id),   -- nulo = flete
  unit varchar(20) references charge_units(code),
  period_date date not null,                          -- inicio de validez
  half_month smallint generated always as (case when extract(day from period_date) <= 15 then 1 else 2 end) stored,
  amount_base numeric(14,2) not null,
  negotiated boolean not null default false,
  version_no int
);
create index on historical_rates (pol_port_id, pod_port_id, container_code, period_date);
create index on historical_rates (charge_type_id, pol_port_id, period_date);

create table manual_benchmarks (
  id uuid primary key default gen_random_uuid(),
  pol_port_id uuid references ports(id),
  pod_port_id uuid references ports(id),
  container_code varchar(10) references container_types(code),
  charge_type_id uuid references charge_types(id),
  currency char(3) not null references currencies(code),
  amount numeric(14,2) not null,
  kind text not null default 'benchmark' check (kind in ('benchmark', 'manual_target', 'market')),
  valid_from date not null,
  valid_to date,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table rate_evaluations (
  id bigserial primary key,
  version_id uuid not null references quote_versions(id) on delete cascade,
  freight_rate_id uuid references freight_rates(id) on delete cascade,
  local_charge_id uuid references local_charges(id) on delete cascade,
  scope text not null check (scope in ('freight', 'local_line', 'local_total', 'total')),
  reference_type text not null,           -- historical_median, last_quote, benchmark, manual_target, none
  comparability_level smallint,           -- 1 exacto, 2 sin naviera, 3 grupo de puerto
  n_obs int,
  ref_min numeric(14,2), ref_p25 numeric(14,2), ref_median numeric(14,2),
  ref_p75 numeric(14,2), ref_max numeric(14,2),
  target numeric(14,2),
  quoted numeric(14,2) not null,
  gap numeric(14,2),
  gap_pct numeric(8,4),
  light traffic_light not null,
  rule_snapshot jsonb not null,           -- parámetros usados: cálculo reproducible
  evaluated_at timestamptz not null default now()
);

create table negotiations (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references quotes(id),
  agent_id uuid not null references agents(id),
  from_version_id uuid not null references quote_versions(id),
  to_version_id uuid references quote_versions(id),
  status text not null default 'requested' check (status in ('requested', 'answered', 'closed')),
  message_to_agent text,
  requested_by uuid references auth.users(id),
  requested_at timestamptz not null default now(),
  answered_at timestamptz
);

-- Lo ÚNICO que el agente ve del pedido: concepto, cotizado y máximo requerido
create table negotiation_items (
  id bigserial primary key,
  negotiation_id uuid not null references negotiations(id) on delete cascade,
  agent_id uuid not null references agents(id),
  label text not null,                    -- "Ocean Freight 40HQ", "Handling"
  container_code varchar(10),
  charge_type_id uuid references charge_types(id),
  quoted numeric(14,2) not null,
  max_required numeric(14,2) not null,
  currency char(3) not null default 'USD'
);

create table agent_performance (
  agent_id uuid not null references agents(id),
  period date not null,
  rollovers int default 0,
  post_award_changes int default 0,
  avg_response_hours numeric(8,2),
  score numeric(5,2),
  primary key (agent_id, period)
);

-- Notas internas BIDCOM (nunca visibles al agente)
create table internal_notes (
  id bigserial primary key,
  quote_id uuid not null references quotes(id) on delete cascade,
  body text not null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Auditoría (solo inserción)
-- ---------------------------------------------------------------------
create table audit_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  user_id uuid,
  action text not null,                   -- INSERT / UPDATE / DELETE / acción de negocio
  entity text not null,
  entity_id text,
  quote_id uuid,
  version_id uuid,
  old_value jsonb,
  new_value jsonb
);
create index on audit_log (quote_id);
create index on audit_log (at);
