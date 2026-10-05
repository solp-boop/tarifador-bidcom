-- Test de aislamiento entre agentes. Correr sobre una base con stub + migraciones.
-- Falla (raise exception) si algún agente ve o modifica algo ajeno.
\set ON_ERROR_STOP 1
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage on all sequences in schema public to authenticated;

-- Datos de prueba (como superusuario)
insert into agents (id, code, name) values
  ('a0000000-0000-0000-0000-00000000000a', 'DEMOA', 'Agente Demo A'),
  ('b0000000-0000-0000-0000-00000000000b', 'AGB', 'Agente B');
insert into auth.users values
  ('11111111-1111-1111-1111-111111111111', 'demoa@test'),
  ('22222222-2222-2222-2222-222222222222', 'agb@test'),
  ('33333333-3333-3333-3333-333333333333', 'sol@bidcom');
insert into profiles (id, role, agent_id) values
  ('11111111-1111-1111-1111-111111111111', 'agent', 'a0000000-0000-0000-0000-00000000000a'),
  ('22222222-2222-2222-2222-222222222222', 'agent', 'b0000000-0000-0000-0000-00000000000b'),
  ('33333333-3333-3333-3333-333333333333', 'bidcom_admin', null);
insert into historical_rates (source, pod_port_id, container_code, period_date, amount_base)
  select 'legacy_excel', id, '40HQ', '2026-09-01', 4000 from ports where unlocode = 'ARBUE';

-- Agente B crea una cotización y la envía
set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
insert into quotes (id, agent_id, status) values
  ('99999999-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-00000000000b', 'draft');
insert into quote_versions (id, quote_id, agent_id, version_no, valid_from, valid_to) values
  ('99999999-0000-0000-0000-0000000000a1', '99999999-0000-0000-0000-000000000001',
   'b0000000-0000-0000-0000-00000000000b', 1, '2026-10-01', '2026-10-31');
insert into quote_routes (id, version_id, agent_id, pol_raw, pod_raw) values
  ('99999999-0000-0000-0000-0000000000b1', '99999999-0000-0000-0000-0000000000a1',
   'b0000000-0000-0000-0000-00000000000b', 'NINGBO', 'BUENOS AIRES');
insert into freight_rates (route_id, agent_id, container_code, currency, amount) values
  ('99999999-0000-0000-0000-0000000000b1', 'b0000000-0000-0000-0000-00000000000b', '40HQ', 'USD', 3700);
update quote_versions set locked = true, submitted_at = now() where id = '99999999-0000-0000-0000-0000000000a1';

-- Agente B NO puede crear cotizaciones a nombre de Demo A
do $$ begin
  begin
    insert into quotes (agent_id, status) values ('a0000000-0000-0000-0000-00000000000a', 'draft');
    raise exception 'FALLA: agente B creó cotización a nombre de Demo A';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Agente B NO puede editar una versión enviada
do $$
declare n int;
begin
  update freight_rates set amount = 1 where agent_id = 'b0000000-0000-0000-0000-00000000000b';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FALLA: se editó una versión enviada'; end if;
  raise notice 'OK versión enviada inmutable para el agente';
end $$;

-- Ni siquiera BIDCOM puede alterar líneas de una versión enviada (trigger)
reset role;
do $$ begin
  begin
    update freight_rates set amount = 1 where agent_id = 'b0000000-0000-0000-0000-00000000000b';
    raise exception 'FALLA: trigger no protegió la versión enviada';
  exception when raise_exception then
    if sqlerrm like 'FALLA%' then raise; end if;
    raise notice 'OK trigger: %', sqlerrm;
  end;
end $$;
set role authenticated;

-- Agente Demo A: no ve nada de B, ni históricos, ni settings
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
do $$
declare n int;
begin
  select count(*) into n from quotes;            if n <> 0 then raise exception 'FALLA quotes %', n; end if;
  select count(*) into n from quote_versions;    if n <> 0 then raise exception 'FALLA versions %', n; end if;
  select count(*) into n from freight_rates;     if n <> 0 then raise exception 'FALLA freight %', n; end if;
  select count(*) into n from agents;            if n <> 1 then raise exception 'FALLA agents visibles %', n; end if;
  select count(*) into n from historical_rates;  if n <> 0 then raise exception 'FALLA historicos %', n; end if;
  select count(*) into n from settings;          if n <> 0 then raise exception 'FALLA settings %', n; end if;
  select count(*) into n from target_rules;      if n <> 0 then raise exception 'FALLA targets %', n; end if;
  select count(*) into n from audit_log;         if n <> 0 then raise exception 'FALLA audit %', n; end if;
  select count(*) into n from ports;             if n = 0 then raise exception 'FALLA catálogos no visibles'; end if;
  -- Intento de modificar la tarifa ajena "por URL": 0 filas afectadas
  update freight_rates set amount = 1 where agent_id = 'b0000000-0000-0000-0000-00000000000b';
  get diagnostics n = row_count; if n <> 0 then raise exception 'FALLA update ajeno'; end if;
  -- El motor de históricos rechaza al agente
  begin
    perform * from historical_stats(null, null, null, '40HQ');
    raise exception 'FALLA: agente accedió a históricos';
  exception when raise_exception then
    if sqlerrm like 'FALLA%' then raise; end if;
  end;
  raise notice 'OK agente Demo A aislado';
end $$;

-- BIDCOM ve todo
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
do $$
declare n int;
begin
  select count(*) into n from quotes;           if n <> 1 then raise exception 'FALLA bidcom quotes %', n; end if;
  select count(*) into n from historical_rates; if n <> 1 then raise exception 'FALLA bidcom hist %', n; end if;
  select count(*) into n from audit_log;        if n = 0 then raise exception 'FALLA auditoría vacía'; end if;
  raise notice 'OK BIDCOM ve todo; auditoría con % registros', n;
end $$;

reset role;
