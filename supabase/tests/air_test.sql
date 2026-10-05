-- Test aéreo: all-in igual al de la plataforma (Agente Demo E, Miami: 4,24 USD/kg) y aislamiento entre agentes
\set ON_ERROR_STOP 1
grant select, insert, update, delete on all tables in schema public to authenticated;
insert into agents (id, code, name) values ('c0000000-0000-0000-0000-00000000000c', 'DEMOE', 'Agente Demo E');
insert into auth.users values ('44444444-4444-4444-4444-444444444444', 'demoe@test');
insert into profiles (id, role, agent_id) values ('44444444-4444-4444-4444-444444444444', 'agent', 'c0000000-0000-0000-0000-00000000000c');

set role authenticated;
set request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';
insert into quotes (id, agent_id, mode, status) values ('a1000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-00000000000c', 'air', 'draft');
insert into quote_versions (id, quote_id, agent_id, version_no, valid_to) values ('a1000000-0000-0000-0000-0000000000a1', 'a1000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-00000000000c', 1, '2026-10-11');
insert into air_routes (id, version_id, agent_id, origin_port_id, dest_port_id, airline, transit_days, currency, minimum_charge, fuel_per_kg, imo_on_request, dest_charges_usd)
select 'a1000000-0000-0000-0000-0000000000b1', 'a1000000-0000-0000-0000-0000000000a1', 'c0000000-0000-0000-0000-00000000000c',
  (select id from ports where iata = 'MIA' and mode = 'air'), (select id from ports where iata = 'EZE' and mode = 'air'), 'Aerolínea Demo 1', 2, 'USD', 160, 0.16, true, 340;
insert into air_rate_breaks values ('a1000000-0000-0000-0000-0000000000b1','c0000000-0000-0000-0000-00000000000c',45,3.7),('a1000000-0000-0000-0000-0000000000b1','c0000000-0000-0000-0000-00000000000c',100,3.4),
  ('a1000000-0000-0000-0000-0000000000b1','c0000000-0000-0000-0000-00000000000c',300,3.15),('a1000000-0000-0000-0000-0000000000b1','c0000000-0000-0000-0000-00000000000c',500,2.9),('a1000000-0000-0000-0000-0000000000b1','c0000000-0000-0000-0000-00000000000c',1000,2.65);
insert into air_origin_charges (version_id, agent_id, airport_id, charge_type_id, currency, amount, unit, minimum, on_request)
select 'a1000000-0000-0000-0000-0000000000a1', 'c0000000-0000-0000-0000-00000000000c', (select id from ports where iata = 'MIA' and mode = 'air'), (select id from charge_types where code = c), 'USD', a, u, m, rq
from (values ('AIR_PICKUP', null::numeric, null, null::numeric, true), ('AIR_EXPORT_CUSTOMS', 50, 'per_shipment', null, false), ('AIR_HANDLING', 50, 'per_shipment', null, false),
             ('AIR_DOC', 60, 'per_shipment', null, false), ('AIR_WAREHOUSE', 50, 'per_shipment', null, false), ('AIR_SECURITY', 40, 'per_shipment', null, false)) v(c, a, u, m, rq);
do $$ declare x numeric; begin
  select round(air_all_in_per_kg('a1000000-0000-0000-0000-0000000000b1', 500), 4) into x;
  if x <> 4.24 then raise exception 'FALLA all-in % (esperado 4,24)', x; end if;
  raise notice 'OK all-in Miami Agente Demo E = % USD/kg (IMO y pick up a pedido no suman)', x;
end $$;
-- Un cargo por kg sin mínimo se rechaza
do $$ begin
  begin
    insert into air_origin_charges (version_id, agent_id, airport_id, currency, amount, unit, on_request)
    values ('a1000000-0000-0000-0000-0000000000a1', 'c0000000-0000-0000-0000-00000000000c', (select id from ports where iata = 'MIA' and mode = 'air'), 'USD', 0.15, 'per_kg', false);
    raise exception 'FALLA: aceptó cargo por kg sin mínimo';
  exception when check_violation then raise notice 'OK cargo por kg exige mínimo';
  end;
end $$;
-- Demo A no ve nada del tarifario de Demo E
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
do $$ declare n int; begin
  select count(*) into n from air_routes; if n <> 0 then raise exception 'FALLA Demo A ve rutas aéreas ajenas'; end if;
  select count(*) into n from air_origin_charges; if n <> 0 then raise exception 'FALLA Demo A ve gastos ajenos'; end if;
  select count(*) into n from air_historical_rates; if n <> 0 then raise exception 'FALLA Demo A ve histórico aéreo'; end if;
  raise notice 'OK aislamiento aéreo';
end $$;
reset role;
