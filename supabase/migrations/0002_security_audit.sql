-- =====================================================================
-- Tarifador BIDCOM · Seguridad (RLS), inmutabilidad y auditoría
-- Regla de oro: un agente solo ve filas con agent_id = su agent_id.
-- Las tablas internas (histórico, targets, evaluaciones, notas, auditoría)
-- no tienen ninguna política para el rol agente => invisibles.
-- =====================================================================

-- Helpers (security definer para no depender de RLS de profiles)
create or replace function app_role() returns user_role
language sql stable security definer set search_path = public as $$
  select role from profiles where id = auth.uid() and active
$$;

create or replace function app_agent_id() returns uuid
language sql stable security definer set search_path = public as $$
  select agent_id from profiles where id = auth.uid() and active
$$;

create or replace function is_bidcom() returns boolean
language sql stable as $$
  select coalesce(app_role() in ('bidcom_analyst', 'bidcom_admin'), false)
$$;

create or replace function is_bidcom_admin() returns boolean
language sql stable as $$
  select coalesce(app_role() = 'bidcom_admin', false)
$$;

-- ---------------------------------------------------------------------
-- Activar RLS en TODAS las tablas
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Catálogos: lectura para cualquier usuario autenticado, escritura BIDCOM admin
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'countries','currencies','ports','port_aliases','shipping_lines','shipping_line_aliases',
    'container_types','container_aliases','charge_units','charge_types','charge_aliases'
  ] loop
    execute format('create policy %I on public.%I for select to authenticated using (true)', t || '_read', t);
    execute format('create policy %I on public.%I for all to authenticated using (is_bidcom_admin()) with check (is_bidcom_admin())', t || '_admin', t);
  end loop;
end $$;

-- Grupos de puertos: BIDCOM todo; agente ve los globales y los propios
create policy port_groups_bidcom on port_groups for all to authenticated
  using (is_bidcom()) with check (is_bidcom());
create policy port_groups_agent on port_groups for select to authenticated
  using (agent_id is null or agent_id = app_agent_id());
create policy port_group_members_read on port_group_members for select to authenticated
  using (exists (select 1 from port_groups g where g.id = group_id
                 and (is_bidcom() or g.agent_id is null or g.agent_id = app_agent_id())));
create policy port_group_members_bidcom on port_group_members for all to authenticated
  using (is_bidcom()) with check (is_bidcom());

-- Tipos de cambio: solo BIDCOM (son internos)
create policy exchange_rates_bidcom on exchange_rates for all to authenticated
  using (is_bidcom()) with check (is_bidcom_admin());

-- ---------------------------------------------------------------------
-- Agentes y perfiles
-- ---------------------------------------------------------------------
create policy agents_bidcom on agents for all to authenticated
  using (is_bidcom()) with check (is_bidcom_admin());
create policy agents_self on agents for select to authenticated
  using (id = app_agent_id());                         -- solo su propio registro

create policy profiles_bidcom on profiles for all to authenticated
  using (is_bidcom_admin()) with check (is_bidcom_admin());
create policy profiles_self on profiles for select to authenticated
  using (id = auth.uid() or is_bidcom());

-- ---------------------------------------------------------------------
-- Datos comerciales del agente: patrón común
--   BIDCOM: lee todo, puede actualizar estados
--   Agente: lee/escribe SOLO su agent_id
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'quotes','quote_versions','quote_routes','freight_rates','freight_surcharges',
    'local_charges','quote_validation_issues','import_batches','import_rows',
    'negotiations','negotiation_items'
  ] loop
    execute format('create policy %I on public.%I for all to authenticated using (is_bidcom()) with check (is_bidcom())', t || '_bidcom', t);
    execute format('create policy %I on public.%I for select to authenticated using (agent_id = app_agent_id())', t || '_agent_read', t);
  end loop;
end $$;

-- Escritura del agente: solo sobre su agent_id y solo en versiones no bloqueadas
create policy quotes_agent_insert on quotes for insert to authenticated
  with check (agent_id = app_agent_id() and status = 'draft');
create policy quotes_agent_update on quotes for update to authenticated
  using (agent_id = app_agent_id())
  with check (agent_id = app_agent_id()
              and status in ('draft', 'submitted', 'renegotiated'));  -- el agente nunca se auto-aprueba

create policy versions_agent_insert on quote_versions for insert to authenticated
  with check (agent_id = app_agent_id()
              and exists (select 1 from quotes q where q.id = quote_id and q.agent_id = app_agent_id()));
create policy versions_agent_update on quote_versions for update to authenticated
  using (agent_id = app_agent_id() and not locked)
  with check (agent_id = app_agent_id());

-- Rutas y líneas: solo dentro de una versión propia y abierta
create or replace function version_is_open_for_agent(v uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from quote_versions qv
                 where qv.id = v and qv.agent_id = app_agent_id() and not qv.locked)
$$;
create or replace function route_is_open_for_agent(r uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from quote_routes qr
                 where qr.id = r and version_is_open_for_agent(qr.version_id))
$$;

create policy routes_agent_write on quote_routes for all to authenticated
  using (agent_id = app_agent_id() and version_is_open_for_agent(version_id))
  with check (agent_id = app_agent_id() and version_is_open_for_agent(version_id));
create policy freight_agent_write on freight_rates for all to authenticated
  using (agent_id = app_agent_id() and route_is_open_for_agent(route_id))
  with check (agent_id = app_agent_id() and route_is_open_for_agent(route_id));
create policy local_agent_write on local_charges for all to authenticated
  using (agent_id = app_agent_id() and route_is_open_for_agent(route_id))
  with check (agent_id = app_agent_id() and route_is_open_for_agent(route_id));
create policy surcharges_agent_write on freight_surcharges for all to authenticated
  using (agent_id = app_agent_id()) with check (agent_id = app_agent_id());

create policy import_batches_agent_write on import_batches for insert to authenticated
  with check (agent_id = app_agent_id() and kind <> 'bidcom_history');
create policy import_rows_agent_write on import_rows for insert to authenticated
  with check (agent_id = app_agent_id());

-- El agente responde una renegociación (marca answered), nada más
create policy negotiations_agent_answer on negotiations for update to authenticated
  using (agent_id = app_agent_id() and status = 'requested')
  with check (agent_id = app_agent_id() and status = 'answered');

-- ---------------------------------------------------------------------
-- Tablas internas: SOLO BIDCOM (sin política para agentes = invisibles)
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'rfq_rounds','settings','target_rules','historical_rates','manual_benchmarks',
    'rate_evaluations','agent_performance','internal_notes'
  ] loop
    execute format('create policy %I on public.%I for select to authenticated using (is_bidcom())', t || '_bidcom_read', t);
    execute format('create policy %I on public.%I for all to authenticated using (is_bidcom_admin() or (is_bidcom() and %L <> ''settings'')) with check (is_bidcom_admin() or (is_bidcom() and %L <> ''settings''))', t || '_bidcom_write', t, t, t);
  end loop;
end $$;

-- Auditoría: lectura BIDCOM, nadie modifica ni borra
create policy audit_read on audit_log for select to authenticated using (is_bidcom());

-- ---------------------------------------------------------------------
-- Inmutabilidad: una versión enviada no se edita ni se borra
-- ---------------------------------------------------------------------
create or replace function guard_locked_version() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.locked then raise exception 'La versión % está enviada y no puede eliminarse', old.version_no; end if;
    return old;
  end if;
  if old.locked and (new.valid_from, new.valid_to, new.quote_date, new.remarks, new.version_no)
                is distinct from (old.valid_from, old.valid_to, old.quote_date, old.remarks, old.version_no) then
    raise exception 'La versión % está enviada: cree una nueva versión', old.version_no;
  end if;
  if old.locked and not new.locked then
    raise exception 'Una versión enviada no puede reabrirse';
  end if;
  return new;
end $$;
create trigger trg_guard_locked_version before update or delete on quote_versions
  for each row execute function guard_locked_version();

create or replace function guard_lines_of_locked_version() returns trigger
language plpgsql as $$
declare v uuid; is_locked boolean;
begin
  if tg_table_name = 'quote_routes' then
    v := coalesce(new.version_id, old.version_id);
  else
    select version_id into v from quote_routes where id = coalesce(new.route_id, old.route_id);
  end if;
  select locked into is_locked from quote_versions where id = v;
  if coalesce(is_locked, false) then
    raise exception 'La versión está enviada: sus líneas no pueden modificarse';
  end if;
  return coalesce(new, old);
end $$;
create trigger trg_guard_routes before insert or update or delete on quote_routes
  for each row execute function guard_lines_of_locked_version();
create trigger trg_guard_freight before insert or update or delete on freight_rates
  for each row execute function guard_lines_of_locked_version();
create trigger trg_guard_locals before insert or update or delete on local_charges
  for each row execute function guard_lines_of_locked_version();

-- No se borran cotizaciones: se rechazan o vencen
create or replace function forbid_delete() returns trigger
language plpgsql as $$
begin raise exception 'No se permite eliminar registros de %', tg_table_name; end $$;
create trigger trg_no_delete_quotes before delete on quotes
  for each row execute function forbid_delete();
create trigger trg_no_delete_audit before update or delete on audit_log
  for each row execute function forbid_delete();

-- ---------------------------------------------------------------------
-- Auditoría automática por trigger
-- ---------------------------------------------------------------------
create or replace function audit_row() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  rec jsonb := to_jsonb(coalesce(new, old));
  q uuid; v uuid;
begin
  q := case tg_table_name
         when 'quotes' then (rec->>'id')::uuid
         when 'quote_versions' then (rec->>'quote_id')::uuid
         else null end;
  v := case tg_table_name
         when 'quote_versions' then (rec->>'id')::uuid
         when 'quote_routes' then (rec->>'version_id')::uuid
         else null end;
  if v is not null and q is null then select quote_id into q from quote_versions where id = v; end if;

  insert into audit_log (user_id, action, entity, entity_id, quote_id, version_id, old_value, new_value)
  values (auth.uid(), tg_op, tg_table_name, rec->>'id', q, v,
          case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
          case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end);
  return coalesce(new, old);
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'quotes','quote_versions','quote_routes','freight_rates','freight_surcharges','local_charges',
    'negotiations','negotiation_items','settings','target_rules','manual_benchmarks',
    'agents','profiles','charge_types','ports','shipping_lines','container_types'
  ] loop
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function audit_row()', 'trg_audit_' || t, t);
  end loop;
end $$;

-- updated_at de quotes
create or replace function touch_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at := now(); return new; end $$;
create trigger trg_quotes_touch before update on quotes
  for each row execute function touch_updated_at();
