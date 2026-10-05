-- =====================================================================
-- Tarifador BIDCOM · Motor de históricos + catálogos semilla
-- =====================================================================

-- ---------------------------------------------------------------------
-- Estadística histórica comparable, con caída por niveles (R3)
--   nivel 1: POL + POD + contenedor + naviera + servicio
--   nivel 2: POL + POD + contenedor
--   nivel 3: grupo de POL + POD + contenedor
-- Devuelve el primer nivel con >= min_obs observaciones.
-- charge_type nulo = flete.
-- ---------------------------------------------------------------------
create or replace function historical_stats(
  p_pol uuid, p_pol_group uuid, p_pod uuid, p_container varchar,
  p_line uuid default null, p_service service_type default null,
  p_charge_type uuid default null, p_unit varchar default null,
  p_ref_date date default current_date,
  p_window_months int default 12, p_min_obs int default 5,
  p_negotiated_only boolean default false
) returns table (
  level smallint, n_obs int, ref_min numeric, ref_p25 numeric, ref_median numeric,
  ref_p75 numeric, ref_max numeric, ref_avg numeric, last_value numeric,
  prev_month_median numeric, same_month_last_year_median numeric
)
language plpgsql stable security definer set search_path = public as $$
declare
  lvl smallint;
begin
  if not is_bidcom() then
    raise exception 'Solo BIDCOM puede consultar históricos';
  end if;

  for lvl in 1..3 loop
    return query
    with base as (
      select h.* from historical_rates h
      where h.pod_port_id = p_pod
        and coalesce(h.container_code, '') = coalesce(p_container, '')
        and h.charge_type_id is not distinct from p_charge_type
        and (p_unit is null or h.unit = p_unit)
        and (not p_negotiated_only or h.negotiated)
        and (
          (lvl = 1 and h.pol_port_id = p_pol and h.shipping_line_id = p_line and h.service = p_service)
          or (lvl = 2 and h.pol_port_id = p_pol)
          or (lvl = 3 and (
                h.pol_group_id = p_pol_group
                or h.pol_port_id in (select port_id from port_group_members where group_id = p_pol_group)
                or (p_pol is not null and h.pol_port_id in (
                      select m2.port_id from port_group_members m1
                      join port_group_members m2 on m2.group_id = m1.group_id
                      where m1.port_id = p_pol))))
        )
    ),
    win as (
      select * from base
      where period_date > (p_ref_date - make_interval(months => p_window_months)) and period_date <= p_ref_date
    ),
    agg as (
      select count(*)::int n,
             min(amount_base) mn,
             percentile_cont(0.25) within group (order by amount_base) p25,
             percentile_cont(0.5)  within group (order by amount_base) med,
             percentile_cont(0.75) within group (order by amount_base) p75,
             max(amount_base) mx,
             round(avg(amount_base), 2) av
      from win
    )
    select lvl::smallint, a.n, a.mn, a.p25::numeric, a.med::numeric, a.p75::numeric, a.mx, a.av,
      (select amount_base from win order by period_date desc, id desc limit 1),
      (select percentile_cont(0.5) within group (order by amount_base)::numeric from base
        where date_trunc('month', period_date) = date_trunc('month', p_ref_date - interval '1 month')),
      (select percentile_cont(0.5) within group (order by amount_base)::numeric from base
        where date_trunc('month', period_date) = date_trunc('month', p_ref_date - interval '1 year'))
    from agg a
    where a.n >= p_min_obs;

    if found then return; end if;
  end loop;
  -- sin referencia suficiente: no devuelve filas (R6)
end $$;

-- Semáforo (R5): tolerancias desde settings
create or replace function traffic_light_for(p_quoted numeric, p_target numeric)
returns traffic_light language plpgsql stable as $$
declare
  s jsonb := coalesce((select value from settings where key = 'traffic_light'),
                      '{"yellow_max_pct":5,"orange_max_pct":15}');
  gap_pct numeric;
begin
  if p_target is null or p_target = 0 then return 'no_reference'; end if;
  gap_pct := (p_quoted - p_target) / p_target * 100;
  if gap_pct <= 0 then return 'green';
  elsif gap_pct <= (s->>'yellow_max_pct')::numeric then return 'yellow';
  elsif gap_pct <= (s->>'orange_max_pct')::numeric then return 'orange';
  else return 'red';
  end if;
end $$;

-- Vista para el ahorro por negociación (R10): versión 1 vs última
create or replace view negotiation_savings with (security_invoker = true) as
with totals as (
  select qv.quote_id, qv.version_no, fr.container_code,
         sum(fr.amount_base) freight,
         (select coalesce(sum(lc.amount_base), 0) from local_charges lc
           join quote_routes r2 on r2.id = lc.route_id where r2.version_id = qv.id) locals
  from quote_versions qv
  join quote_routes r on r.version_id = qv.id
  join freight_rates fr on fr.route_id = r.id
  where qv.locked
  group by qv.quote_id, qv.version_no, qv.id, fr.container_code
),
ends as (
  select quote_id, container_code, min(version_no) v_first, max(version_no) v_last
  from totals group by quote_id, container_code
)
select e.quote_id, e.container_code, e.v_first, e.v_last,
       f.freight freight_initial, l.freight freight_final, f.freight - l.freight freight_saving,
       f.locals locals_initial, l.locals locals_final, f.locals - l.locals locals_saving,
       f.freight + f.locals total_initial, l.freight + l.locals total_final,
       (f.freight + f.locals) - (l.freight + l.locals) total_saving,
       -- R8: traslado de costos
       (l.freight < f.freight and l.locals > f.locals
        and ((f.freight + f.locals) - (l.freight + l.locals)) < 0.5 * (f.freight - l.freight)) cost_shift_alert
from ends e
join totals f on f.quote_id = e.quote_id and f.container_code = e.container_code and f.version_no = e.v_first
join totals l on l.quote_id = e.quote_id and l.container_code = e.container_code and l.version_no = e.v_last;

-- =====================================================================
-- Catálogos semilla
-- =====================================================================
insert into countries values
  ('CN','China'),('AR','Argentina'),('UY','Uruguay'),('BR','Brasil'),('MX','México'),
  ('PA','Panamá'),('SG','Singapur'),('HK','Hong Kong'),('KR','Corea del Sur'),('VN','Vietnam');

insert into currencies values ('USD','Dólar estadounidense',true),('EUR','Euro',true),
  ('CNY','Yuan chino',true),('ARS','Peso argentino',true);
insert into exchange_rates values ('USD', '2000-01-01', 1);

insert into ports (unlocode, name, country_code) values
  ('CNSHA','SHANGHAI','CN'),('CNNGB','NINGBO','CN'),('CNSZX','SHENZHEN','CN'),
  ('CNYTN','YANTIAN','CN'),('CNSHK','SHEKOU','CN'),('CNTXG','TIANJIN (XINGANG)','CN'),
  ('CNJMN','JIANGMEN','CN'),('CNZSN','ZHONGSHAN','CN'),('CNNSA','NANSHA','CN'),
  ('CNCAN','GUANGZHOU','CN'),('CNQIN','QINGDAO','CN'),('CNXMN','XIAMEN','CN'),
  ('HKHKG','HONG KONG','HK'),('SGSIN','SINGAPUR','SG'),
  ('ARBUE','BUENOS AIRES','AR'),('ARLPG','LA PLATA (TECPLATA)','AR'),
  ('UYMVD','MONTEVIDEO','UY'),('BRSSZ','SANTOS','BR'),
  ('MXZLO','MANZANILLO (MX)','MX'),('PAMIT','MANZANILLO (PA)','PA'),('MXLZC','LAZARO CARDENAS','MX');

insert into port_aliases (alias, port_id)
select norm_text(a), p.id from (values
  ('NINGBO','CNNGB'),('NINGBO PORT','CNNGB'),('SHANGHAI','CNSHA'),('SHENZHEN','CNSZX'),
  ('YANTIAN','CNYTN'),('SHEKOU','CNSHK'),('TIANJIN','CNTXG'),('XINGANG','CNTXG'),
  ('TIANJIN XINGANG','CNTXG'),('JIANGMEN','CNJMN'),('ZHONGSHAN','CNZSN'),('ZHOGNSHANG','CNZSN'),
  ('ZHONGSHANG','CNZSN'),('NANSHA','CNNSA'),('GUANGZHOU','CNCAN'),('QINGDAO','CNQIN'),
  ('XIAMEN','CNXMN'),('HONG KONG','HKHKG'),('SINGAPUR','SGSIN'),('SINGAPORE','SGSIN'),
  ('BUENOS AIRES','ARBUE'),('BS AS','ARBUE'),('LA PLATA','ARLPG'),('TECPLATA','ARLPG'),
  ('MONTEVIDEO','UYMVD'),('SANTOS','BRSSZ'),('LAZARO CARDENAS','MXLZC'),('MANZANILLO','MXZLO')
) v(a, code) join ports p on p.unlocode = v.code;

insert into shipping_lines (scac, name, is_carrier) values
  ('MAEU','MAERSK',true),('MSCU','MSC',true),('CMDU','CMA CGM',true),('COSU','COSCO',true),
  ('EGLV','EVERGREEN',true),('HLCU','HAPAG-LLOYD',true),('ONEY','ONE',true),('OOLU','OOCL',true),
  ('HDMU','HMM',true),('ZIMU','ZIM',true),('PABV','PIL',true),('YMLU','YANG MING',true),
  ('WHLC','WAN HAI',true),('SUDU','HAMBURG SUD',true),
  (null,'BLUE ANCHOR LINE (NVOCC)',false),(null,'VARIAS LINEAS',false),(null,'SPOT / A CONFIRMAR',false);

insert into shipping_line_aliases (alias, shipping_line_id)
select norm_text(a), s.id from (values
  ('MAERSK','MAERSK'),('MSK','MAERSK'),('MSC','MSC'),('MSC DIAMON','MSC'),('CMA','CMA CGM'),
  ('CMA CGM','CMA CGM'),('CMA-CGM','CMA CGM'),('COSCO','COSCO'),('EVERGREEN','EVERGREEN'),
  ('EMC','EVERGREEN'),('HAPAG','HAPAG-LLOYD'),('HL','HAPAG-LLOYD'),('HLCU','HAPAG-LLOYD'),
  ('HAPAG LLOYD','HAPAG-LLOYD'),('ONE','ONE'),('OOCL','OOCL'),('OCCL','OOCL'),('OOLU','OOCL'),
  ('HMM','HMM'),('HHM','HMM'),('ZIM','ZIM'),('PIL','PIL'),('PILL','PIL'),('YML','YANG MING'),
  ('WHL','WAN HAI'),('HAMBURG SUD','HAMBURG SUD'),('BLUE ANCHOR','BLUE ANCHOR LINE (NVOCC)'),
  ('VARIAS LINEAS','VARIAS LINEAS'),('SPOT','SPOT / A CONFIRMAR'),('SPOT RATE','SPOT / A CONFIRMAR'),
  ('TBC','SPOT / A CONFIRMAR')
) v(a, n) join shipping_lines s on s.name = v.n;

insert into container_types (code, iso_code, teu, description) values
  ('20ST','22G1',1,'20'' estándar'),('40ST','42G1',2,'40'' estándar'),
  ('40HQ','45G1',2,'40'' high cube'),('40NOR','45R1',2,'40'' reefer no operativo'),
  ('40RF','45R1',2,'40'' reefer'),('20RF','22R1',1,'20'' reefer');

insert into container_aliases (alias, container_code) values
  ('20ST','20ST'),('20','20ST'),('20DV','20ST'),('20GP','20ST'),('20 ST','20ST'),
  ('40ST','40ST'),('40','40ST'),('40DV','40ST'),('40GP','40ST'),('40 ST','40ST'),
  ('40HQ','40HQ'),('40HC','40HQ'),('40 HQ','40HQ'),('40NOR','40NOR'),('40 NOR','40NOR'),
  ('40RF','40RF'),('40RH','40RF'),('20RF','20RF');
-- "40ST/40HQ" NO tiene alias a propósito: se rechaza y se pide cotizar por separado.

insert into charge_units values
  ('per_bl','Por BL'),('per_container','Por contenedor'),('per_operation','Por operación'),
  ('per_shipment','Por embarque'),('per_cbm','Por CBM'),('per_ton','Por tonelada');

insert into charge_types (code, name, category, default_unit, is_standard, requires_description, sort_order) values
  ('HANDLING','Handling fee','fixed','per_bl',true,false,10),
  ('VGM','VGM / Pesada','fixed','per_container',true,false,20),
  ('EIR','EIR','fixed','per_container',true,false,30),
  ('SEAL','Seal / Precinto','fixed','per_container',true,false,40),
  ('THC','ORC / THC','fixed','per_container',true,false,50),
  ('TELEX','Telex release fee','fixed','per_bl',true,false,60),
  ('DOC','Documentation fee','fixed','per_bl',true,false,70),
  ('DG','DG fee','fixed','per_container',true,false,80),
  ('PICKUP','Pick up fee EXW','variable','per_shipment',true,false,110),
  ('WAREHOUSE','Warehouse fee','variable','per_cbm',true,false,120),
  ('CUSTOMS','Customs clearance fee','variable','per_shipment',true,false,130),
  ('CUSTOMS_DOC','Issue customs doc fee','variable','per_shipment',true,false,140),
  ('OTHER','Otros','variable',null,false,true,900);

insert into charge_aliases (alias, charge_type_id)
select norm_text(a), c.id from (values
  ('HANDLING','HANDLING'),('HANDLING FEE','HANDLING'),('VGM','VGM'),('VGM - PESADA','VGM'),('PESADA','VGM'),
  ('EIR','EIR'),('EIR - DOC CONF ENTREGA RECP CONT','EIR'),('SEAL','SEAL'),('SEAL - SELLOS SEG/PREC','SEAL'),
  ('PRECINTO','SEAL'),('ORC','THC'),('THC','THC'),('ORC (THC)','THC'),('ORC (THC) - MANIP/RECP MERC','THC'),
  ('TELEX','TELEX'),('TELEX RELEASE FEE','TELEX'),('DOC','DOC'),('DOCUMENTATION FEE','DOC'),('DOC FEE','DOC'),
  ('DG','DG'),('DG FEE','DG'),('PICK UP FEE EXW','PICKUP'),('PICK UP','PICKUP'),('WAREHOUSE FEE','WAREHOUSE'),
  ('WAREHOUSE','WAREHOUSE'),('CUSTOMS CLEARANCE FEE','CUSTOMS'),('CUSTOM CLEARANCE','CUSTOMS'),
  ('ISSUE CUSTOMS DOC FEE','CUSTOMS_DOC'),('ISSUE CUSTOMS DOCS','CUSTOMS_DOC')
) v(a, code) join charge_types c on c.code = v.code;

insert into settings (key, value) values
  ('base_currency', '"USD"'),
  ('target_reduction', '{"freight_pct":15,"local_pct":15}'),
  ('traffic_light', '{"yellow_max_pct":5,"orange_max_pct":15}'),
  ('score_weights', '{"cost":50,"transit_time":15,"free_days":15,"direct_service":10,"agent_compliance":10}'),
  ('history', '{"min_observations":5,"window_months":12,"use_negotiated_final":true}'),
  ('cost_shift_alert', '{"min_real_saving_ratio":0.5}'),
  ('standard_shipment', '{"bl":1,"containers":1,"operations":1,"cbm":{"20ST":28,"40ST":58,"40HQ":68,"40NOR":58},"tons":{"20ST":10,"40ST":12,"40HQ":12,"40NOR":12}}'),
  ('allowed_containers', '["20ST","40ST","40HQ","40NOR"]');

insert into target_rules (scope, freight_reduction_pct, local_reduction_pct, min_observations, window_months, valid_from)
values ('global', 15, 15, 5, 12, '2020-01-01');
