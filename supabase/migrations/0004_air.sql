-- =====================================================================
-- Tarifador BIDCOM · Módulo aéreo (tarifario semanal)
-- Reutiliza quotes / quote_versions (mode = 'air'), estados, negociaciones,
-- RLS y auditoría. Agrega aeropuertos, breaks por peso y gastos en origen
-- por aeropuerto (fijos o por kg con mínimo).
-- =====================================================================

-- Solicitud semanal (lo que BIDCOM envía a los agentes)
alter table rfq_rounds add column week_code text unique;            -- WK-2026-W41
alter table rfq_rounds add column response_deadline date;
alter table rfq_rounds add column agent_notes jsonb;                 -- indicaciones "Lo importante" vigentes

create table rfq_round_routes (
  round_id uuid not null references rfq_rounds(id) on delete cascade,
  origin_port_id uuid not null references ports(id),
  dest_port_id uuid not null references ports(id),
  primary key (round_id, origin_port_id, dest_port_id)
);

-- Unidad por kg (gastos aéreos tipo "USD 0,15 x kg, mínimo USD 55")
insert into charge_units values ('per_kg', 'Por kg');

-- Ruta aérea de una versión: una fila por aeropuerto de origen
create table air_routes (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references quote_versions(id) on delete cascade,
  agent_id uuid not null references agents(id),
  origin_port_id uuid references ports(id),
  origin_raw text,
  dest_port_id uuid references ports(id),
  airline text,
  transit_days int check (transit_days > 0),
  currency char(3) references currencies(code),
  minimum_charge numeric(12,2) check (minimum_charge >= 0),
  fuel_per_kg numeric(10,4) check (fuel_per_kg >= 0),
  imo_per_kg numeric(10,4) check (imo_per_kg >= 0),
  imo_on_request boolean not null default false,
  dest_charges_usd numeric(12,2),
  remarks text,
  rates_from_formula text,               -- trazabilidad: "=K6+0.4" detectado al importar
  check (not imo_on_request or imo_per_kg is null)
);
create index on air_routes (version_id);
create index on air_routes (agent_id);

-- Breaks de tarifa por peso (45 / 100 / 300 / 500 / 1000 kg)
create table air_rate_breaks (
  route_id uuid not null references air_routes(id) on delete cascade,
  agent_id uuid not null references agents(id),
  break_kg int not null check (break_kg > 0),
  rate numeric(10,4) not null check (rate > 0),
  primary key (route_id, break_kg)
);

-- Gastos en origen por aeropuerto y concepto
create table air_origin_charges (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references quote_versions(id) on delete cascade,
  agent_id uuid not null references agents(id),
  airport_id uuid not null references ports(id),
  charge_type_id uuid references charge_types(id),
  description text,
  currency char(3) references currencies(code),
  amount numeric(12,4),
  unit varchar(20) references charge_units(code),   -- per_shipment | per_kg
  minimum numeric(12,2),
  on_request boolean not null default false,
  check (on_request or (amount is not null and unit is not null)),
  check (unit is distinct from 'per_kg' or on_request or minimum is not null)
);
create index on air_origin_charges (version_id);

-- Catálogos aéreos
-- Aeropuertos: registros propios identificados por código IATA (los UN/LOCODE de ciudad ya los usan los puertos marítimos)
insert into countries values ('US', 'Estados Unidos') on conflict do nothing;
alter table ports add column iata char(3);
insert into ports (iata, name, country_code, mode) values
  ('MIA','MIAMI - MIA','US','air'), ('HKG','HONG KONG - HKG','HK','air'), ('PVG','SHANGHAI - PVG','CN','air'),
  ('SZX','SHENZHEN - SZX','CN','air'), ('NGB','NINGBO - NGB','CN','air'), ('CAN','GUANGZHOU - CAN','CN','air'), ('EZE','BUENOS AIRES - EZE','AR','air');
create unique index ports_iata_air on ports (iata) where mode = 'air';

insert into port_aliases (alias, port_id)
select norm_text(a), p.id from (values ('MIAMI - MIA','MIA'),('MIA','MIA'),('HONG KONG - HKG','HKG'),('HKG','HKG'),('SHANGHAI - PVG','PVG'),('PVG','PVG'),
  ('SHENZHEN - SZX','SZX'),('SZX','SZX'),('NINGBO - NGB','NGB'),('NGB','NGB'),('GUANGZHOU - CAN','CAN'),('BUENOS AIRES - EZE','EZE'),('EZE','EZE'),('EZEIZA','EZE')) v(a, iata)
join ports p on p.iata = v.iata and p.mode = 'air'
on conflict (alias) do nothing;

insert into charge_types (code, name, category, default_unit, is_standard, mode, sort_order) values
  ('AIR_PICKUP','Pick up','variable','per_shipment',true,'air',10),
  ('AIR_EXPORT_CUSTOMS','Export customs','fixed','per_shipment',true,'air',20),
  ('AIR_HANDLING','Handling','fixed','per_shipment',true,'air',30),
  ('AIR_DOC','Documentation','fixed','per_shipment',true,'air',40),
  ('AIR_WAREHOUSE','Warehouse','variable','per_kg',true,'air',50),
  ('AIR_SECURITY','Security','fixed','per_kg',true,'air',60),
  ('AIR_OTHER','Otro','variable',null,false,'air',900);

insert into settings (key, value) values
  ('air', '{"reference_weight_kg":500,"target_reduction_pct":15,"breaks_kg":[45,100,300,500,1000],"required_breaks_kg":[100,300,500,1000]}');

-- Histórico aéreo: una fila por ruta y semana, con el all-in ya calculado al peso de referencia
create table air_historical_rates (
  id bigserial primary key,
  source text not null check (source in ('legacy_excel', 'platform')),
  agent_id uuid references agents(id),
  quote_version_id uuid references quote_versions(id),
  origin_port_id uuid references ports(id),
  dest_port_id uuid references ports(id),
  week_code text,
  period_date date not null,
  rate_by_break jsonb not null,          -- {"45":3.5,"100":3.25,...}
  minimum_charge numeric(12,2),
  fuel_per_kg numeric(10,4),
  origin_charges jsonb,                  -- {"AIR_HANDLING":55,...} normalizado a USD por embarque
  dest_charges_usd numeric(12,2),
  reference_weight_kg int not null,
  all_in_per_kg numeric(10,4) not null
);
create index on air_historical_rates (origin_port_id, dest_port_id, period_date);

-- All-in por kg (misma fórmula que la plataforma y que el Excel actual, pero tolerante a "a pedido")
create or replace function air_all_in_per_kg(p_route uuid, p_weight int default 500)
returns numeric language sql stable as $$
  with r as (select * from air_routes where id = p_route),
  b as (select rate from air_rate_breaks where route_id = p_route and break_kg <= p_weight order by break_kg desc limit 1),
  o as (
    select coalesce(sum(case when c.unit = 'per_kg' then greatest(coalesce(c.minimum, 0), c.amount * p_weight) else c.amount end), 0) total
    from air_origin_charges c join r on c.version_id = r.version_id and c.airport_id = r.origin_port_id
    where not c.on_request
  )
  select (greatest(r.minimum_charge, (select rate from b) * p_weight)
          + (coalesce(r.fuel_per_kg, 0) + case when r.imo_on_request then 0 else coalesce(r.imo_per_kg, 0) end) * p_weight
          + (select total from o) + coalesce(r.dest_charges_usd, 0)) / p_weight
  from r
$$;

-- ---------------------------------------------------------------------
-- Seguridad: mismo patrón que marítimo
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['air_routes','air_rate_breaks','air_origin_charges'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('create policy %I on public.%I for all to authenticated using (is_bidcom()) with check (is_bidcom())', t || '_bidcom', t);
    execute format('create policy %I on public.%I for select to authenticated using (agent_id = app_agent_id())', t || '_agent_read', t);
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function audit_row()', 'trg_audit_' || t, t);
  end loop;
end $$;

create policy air_routes_agent_write on air_routes for all to authenticated
  using (agent_id = app_agent_id() and version_is_open_for_agent(version_id))
  with check (agent_id = app_agent_id() and version_is_open_for_agent(version_id));
create policy air_origin_agent_write on air_origin_charges for all to authenticated
  using (agent_id = app_agent_id() and version_is_open_for_agent(version_id))
  with check (agent_id = app_agent_id() and version_is_open_for_agent(version_id));
create policy air_breaks_agent_write on air_rate_breaks for all to authenticated
  using (agent_id = app_agent_id() and exists (select 1 from air_routes r where r.id = route_id and version_is_open_for_agent(r.version_id)))
  with check (agent_id = app_agent_id() and exists (select 1 from air_routes r where r.id = route_id and version_is_open_for_agent(r.version_id)));

-- La solicitud semanal la ven todos los usuarios (los agentes necesitan saber qué cotizar)
alter table rfq_round_routes enable row level security;
create policy rfq_round_routes_read on rfq_round_routes for select to authenticated using (true);
create policy rfq_round_routes_bidcom on rfq_round_routes for all to authenticated using (is_bidcom()) with check (is_bidcom());
create policy rfq_rounds_agent_read on rfq_rounds for select to authenticated using (true);

-- Histórico aéreo: solo BIDCOM
alter table air_historical_rates enable row level security;
alter table air_historical_rates force row level security;
create policy air_hist_bidcom on air_historical_rates for all to authenticated using (is_bidcom()) with check (is_bidcom_admin());
