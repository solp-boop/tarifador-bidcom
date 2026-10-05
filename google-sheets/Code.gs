/**
 * Tarifador BIDCOM · Tarifario aéreo semanal en Google Sheets
 *
 * Cada agente entra con su link personal, carga su tarifario y se guarda en esta planilla.
 * El agente nunca tiene acceso a la planilla: solo ve su formulario y sus propios envíos.
 * BIDCOM ve todo en las pestañas que crea este script.
 *
 * Instalación: ver la guía. Resumen: Extensiones > Apps Script, pegar Code.gs e Index.html,
 * menú Tarifador BIDCOM > Preparar hojas, Implementar como aplicación web, Generar links.
 */

var HOJA = {
  AGENTES: 'Agentes',
  SOLICITUD: 'Solicitud semanal',
  TARIFAS: 'Tarifas aéreas (envíos)',
  GASTOS: 'Gastos en origen aéreo (envíos)',
  COMPARATIVO: 'Comparativo aéreo',
  REGISTRO: 'Registro'
};

var BREAKS = [45, 100, 300, 500, 1000];
var CONCEPTOS = ['Pick up', 'Export customs', 'Handling', 'Documentation', 'Warehouse', 'Security'];
var UNIDADES = ['Fijo por embarque', 'Por kg'];

// Columnas de la pestaña de tarifas (1 = A)
var COLS_TARIFAS = ['ID envío', 'Recibido', 'Week ID', 'Agente', 'Versión', 'Vigente', 'Origen', 'Destino', 'Aerolínea',
  'Tránsito (días)', 'Moneda', 'Mínimo', '45 kg', '100 kg', '300 kg', '500 kg', '1000 kg', 'Fuel USD/kg', 'IMO USD/kg',
  'IMO a pedido', 'Gastos origen USD (al peso ref.)', 'Gastos destino USD', 'Vigencia hasta', 'All-in USD/kg', 'Observaciones'];
var COLS_GASTOS = ['ID envío', 'Recibido', 'Week ID', 'Agente', 'Aeropuerto', 'Concepto', 'Moneda', 'Importe', 'Unidad',
  'Mínimo', 'A pedido', 'Descripción', 'Vigente', 'Importe al peso ref. USD'];

/* ------------------------------------------------------------------ */
/* Menú                                                                */
/* ------------------------------------------------------------------ */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Tarifador BIDCOM')
    .addItem('1. Preparar hojas (primera vez)', 'prepararHojas')
    .addItem('2. Generar links de agentes', 'generarLinks')
    .addSeparator()
    .addItem('Ir al comparativo', 'irAlComparativo')
    .addToUi();
}

/* ------------------------------------------------------------------ */
/* Preparar hojas: crea las pestañas que falten. No toca las existentes */
/* ------------------------------------------------------------------ */
function prepararHojas() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var creadas = [];

  if (!ss.getSheetByName(HOJA.AGENTES)) {
    var a = ss.insertSheet(HOJA.AGENTES);
    a.getRange(1, 1, 1, 6).setValues([['Código', 'Nombre del agente', 'Email de contacto', 'Activo (SI/NO)', 'Clave (automática)', 'Link personal (automático)']]);
    a.getRange(2, 1, 1, 4).setValues([['PRUEBA', 'Agente de prueba', '', 'SI']]);
    estiloEncabezado(a, 6);
    a.setColumnWidths(1, 1, 90); a.setColumnWidth(2, 220); a.setColumnWidth(3, 220); a.setColumnWidth(4, 110); a.setColumnWidth(5, 130); a.setColumnWidth(6, 520);
    a.getRange('A2:D').setBackground('#FFF2CC');
    a.getRange('D2:D').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['SI', 'NO'], true).build());
    creadas.push(HOJA.AGENTES);
  }

  if (!ss.getSheetByName(HOJA.SOLICITUD)) {
    var s = ss.insertSheet(HOJA.SOLICITUD);
    var hoy = new Date(), lunes = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() - ((hoy.getDay() + 6) % 7));
    var domingo = new Date(lunes.getFullYear(), lunes.getMonth(), lunes.getDate() + 6);
    var limite = new Date(lunes.getFullYear(), lunes.getMonth(), lunes.getDate() + 1);
    s.getRange('A1').setValue('Solicitud semanal de tarifas aéreas').setFontWeight('bold').setFontSize(14);
    s.getRange('A2').setValue('Las celdas amarillas las completa BIDCOM cada semana. Lo que pongas acá es lo que ven los agentes en su formulario.');
    s.getRange(3, 1, 6, 2).setValues([
      ['Week ID', semanaISO(lunes)],
      ['Período desde', lunes],
      ['Período hasta', domingo],
      ['Respuesta hasta', limite],
      ['Peso de referencia (kg)', 500],
      ['Reducción objetivo', 0.15]
    ]);
    s.getRange('B4:B6').setNumberFormat('dd/mm/yyyy');
    s.getRange('B8').setNumberFormat('0%');
    s.getRange('C7').setValue('No cambiarlo semana a semana: si cambia, los all-in dejan de ser comparables.');
    s.getRange('A10').setValue('Rutas a cotizar').setFontWeight('bold');
    s.getRange(11, 1, 1, 3).setValues([['Origen', 'Destino', 'Cotizar (SI/NO)']]).setFontWeight('bold');
    s.getRange(12, 1, 6, 3).setValues([
      ['Miami - MIA', 'Buenos Aires - EZE', 'SI'], ['Hong Kong - HKG', 'Buenos Aires - EZE', 'SI'], ['Shanghai - PVG', 'Buenos Aires - EZE', 'SI'],
      ['Shenzhen - SZX', 'Buenos Aires - EZE', 'SI'], ['Ningbo - NGB', 'Buenos Aires - EZE', 'SI'], ['Guangzhou - CAN', 'Buenos Aires - EZE', 'NO']]);
    s.getRange('C12:C21').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['SI', 'NO'], true).build());
    s.getRange('A23').setValue('Indicaciones para agentes (se muestran arriba del formulario; la primera se destaca)').setFontWeight('bold');
    s.getRange(24, 1, 5, 1).setValues([
      ['Completá los gastos en origen de cada aeropuerto, concepto por concepto. BIDCOM los va a usar como base para negociar gastos en origen en una etapa próxima.'],
      ['Si un gasto se cobra por kg, indicá la tarifa por kg y el mínimo (por ejemplo USD 0,15 por kg, mínimo USD 55).'],
      ['Completá el mínimo y los breaks de 100, 300, 500 y 1000 kg con valores propios de cada ruta, no calculados a partir de otra ruta.'],
      ['Fuel e IMO en USD por kg. Si el IMO es a pedido, marcalo como a pedido: no se suma al all-in.'],
      ['Enviá el tarifario cada semana aunque no cambie: así queda registrado que sigue vigente.']]);
    s.getRange('B3:B8').setBackground('#FFF2CC');
    s.getRange('A12:C21').setBackground('#FFF2CC');
    s.getRange('A24:A32').setBackground('#FFF2CC').setWrap(true);
    s.setColumnWidth(1, 640); s.setColumnWidth(2, 200); s.setColumnWidth(3, 140);
    creadas.push(HOJA.SOLICITUD);
  }

  if (!ss.getSheetByName(HOJA.TARIFAS)) {
    var t = ss.insertSheet(HOJA.TARIFAS);
    t.getRange(1, 1, 1, COLS_TARIFAS.length).setValues([COLS_TARIFAS]);
    estiloEncabezado(t, COLS_TARIFAS.length);
    t.setFrozenColumns(4);
    t.getRange('B:B').setNumberFormat('dd/mm/yyyy hh:mm');
    t.getRange('W:W').setNumberFormat('dd/mm/yyyy');
    t.getRange('M:S').setNumberFormat('0.00##');
    t.getRange('U:V').setNumberFormat('#,##0.00');
    t.getRange('X:X').setNumberFormat('0.00').setFontWeight('bold');
    t.getRange('A1').setNote('Esta pestaña la completa el formulario. No editar a mano: cada envío queda registrado con su versión. Vigente = SI es la última versión de cada agente en esa semana.');
    t.getRange('X1').setNote('All-in USD/kg al peso de referencia = (flete + fuel e IMO + gastos en origen + gastos destino) / peso. Lo marcado a pedido no se suma.');
    creadas.push(HOJA.TARIFAS);
  }

  if (!ss.getSheetByName(HOJA.GASTOS)) {
    var g = ss.insertSheet(HOJA.GASTOS);
    g.getRange(1, 1, 1, COLS_GASTOS.length).setValues([COLS_GASTOS]);
    estiloEncabezado(g, COLS_GASTOS.length);
    g.setFrozenColumns(4);
    g.getRange('B:B').setNumberFormat('dd/mm/yyyy hh:mm');
    g.getRange('H:H').setNumberFormat('0.00##');
    g.getRange('N:N').setNumberFormat('#,##0.00');
    g.getRange('A1').setNote('Esta pestaña la completa el formulario. Una fila por aeropuerto y concepto. Es la base para negociar gastos en origen.');
    creadas.push(HOJA.GASTOS);
  }

  if (!ss.getSheetByName(HOJA.COMPARATIVO)) {
    var c = ss.insertSheet(HOJA.COMPARATIVO);
    armarComparativo(c);
    creadas.push(HOJA.COMPARATIVO);
  }

  if (!ss.getSheetByName(HOJA.REGISTRO)) {
    var r = ss.insertSheet(HOJA.REGISTRO);
    r.getRange(1, 1, 1, 4).setValues([['Fecha y hora', 'Agente', 'Acción', 'Detalle']]);
    estiloEncabezado(r, 4);
    r.getRange('A:A').setNumberFormat('dd/mm/yyyy hh:mm');
    r.setColumnWidth(3, 220); r.setColumnWidth(4, 420);
    creadas.push(HOJA.REGISTRO);
  }

  SpreadsheetApp.getUi().alert(creadas.length
    ? 'Listo. Se crearon las pestañas: ' + creadas.join(', ') + '.\n\nPróximo paso: cargá tus agentes en la pestaña "Agentes" e implementá el formulario (ver guía).'
    : 'Las pestañas ya existían. No se modificó nada.');
}

function armarComparativo(c) {
  var T = "'" + HOJA.TARIFAS + "'", S = "'" + HOJA.SOLICITUD + "'";
  c.getRange('A1').setValue('Comparativo aéreo semanal (USD por kg al peso de referencia)').setFontWeight('bold').setFontSize(14);
  c.getRange('A2').setValue('Semana');
  c.getRange('B2').setFormula('=' + S + '!B3').setBackground('#FFF2CC');
  c.getRange('C2').setValue('Por defecto muestra la semana de la solicitud. Escribí otro Week ID para ver una semana anterior.');
  c.getRange('A4').setValue('Resumen por ruta').setFontWeight('bold');
  c.getRange(5, 1, 1, 8).setValues([['Origen', 'Respuestas', 'Mejor all-in', 'Agente con mejor all-in', 'Mediana 12 semanas', 'Target', 'Mejor vs target', 'Agentes que faltan']]);
  estiloFila(c.getRange(5, 1, 1, 8));
  for (var i = 0; i < 10; i++) {
    var r = 6 + i, sr = 12 + i;
    c.getRange(r, 1, 1, 8).setFormulas([[
      '=IF(' + S + '!C' + sr + '="SI",' + S + '!A' + sr + ',"")',
      '=IF(A' + r + '="","",COUNTIFS(' + T + '!C:C,$B$2,' + T + '!G:G,A' + r + ',' + T + '!F:F,"SI"))',
      '=IF(OR(A' + r + '="",B' + r + '=0),"",MINIFS(' + T + '!X:X,' + T + '!C:C,$B$2,' + T + '!G:G,A' + r + ',' + T + '!F:F,"SI"))',
      '=IF(C' + r + '="","",INDEX(FILTER(' + T + '!D:D,' + T + '!C:C=$B$2,' + T + '!G:G=A' + r + ',' + T + '!F:F="SI",' + T + '!X:X=C' + r + '),1))',
      '=IF(A' + r + '="","",IFERROR(MEDIAN(FILTER(' + T + '!X:X,' + T + '!G:G=A' + r + ',' + T + '!F:F="SI",' + T + '!B:B>=TODAY()-84,ISNUMBER(' + T + '!X:X))),""))',
      '=IF(E' + r + '="","",E' + r + '*(1-' + S + '!$B$8))',
      '=IF(OR(C' + r + '="",F' + r + '=""),"",C' + r + '/F' + r + '-1)',
      '=IF(A' + r + '="","",IFERROR(TEXTJOIN(", ",TRUE,FILTER(Agentes!B2:B,Agentes!D2:D="SI",COUNTIFS(' + T + '!D:D,Agentes!B2:B,' + T + '!C:C,$B$2,' + T + '!G:G,A' + r + ')=0)),""))'
    ]]);
  }
  c.getRange('C6:C15').setNumberFormat('0.00');
  c.getRange('E6:F15').setNumberFormat('0.00');
  c.getRange('G6:G15').setNumberFormat('+0.0%;-0.0%;0.0%');
  c.getRange('E5').setNote('Mediana del all-in de las últimas 12 semanas para esa ruta (todos los agentes, última versión de cada envío). Se arma sola a medida que llegan las semanas.');
  c.getRange('F5').setNote('Target = mediana 12 semanas × (1 − reducción objetivo de la pestaña Solicitud semanal).');

  c.getRange('A18').setValue('Detalle de la semana, ordenado por ruta y all-in').setFontWeight('bold');
  c.getRange(19, 1, 1, 11).setValues([['Origen', 'Agente', 'Aerolínea', 'Tránsito (días)', 'Mínimo', '500 kg', 'Fuel USD/kg', 'IMO a pedido', 'Gastos origen USD', 'Gastos destino USD', 'All-in USD/kg']]);
  estiloFila(c.getRange(19, 1, 1, 11));
  c.getRange('A20').setFormula('=IFERROR(SORT(FILTER({' + T + '!G2:G,' + T + '!D2:D,' + T + '!I2:I,' + T + '!J2:J,' + T + '!L2:L,' + T + '!P2:P,' + T + '!R2:R,' + T + '!T2:T,' + T + '!U2:U,' + T + '!V2:V,' + T + '!X2:X},' + T + '!C2:C=$B$2,' + T + '!F2:F="SI"),1,TRUE,11,TRUE),"Todavía no hay envíos para esta semana")');
  c.getRange('K20:K').setNumberFormat('0.00').setFontWeight('bold');
  c.getRange('A6:H15').setBorder(true, true, true, true, true, true, '#D9D9D9', SpreadsheetApp.BorderStyle.SOLID);
  c.setColumnWidth(1, 160); c.setColumnWidth(4, 200); c.setColumnWidth(8, 320);
  c.setFrozenRows(2);
  // Semáforo sobre "Mejor vs target"
  var rango = c.getRange('G6:G15');
  c.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=AND(ISNUMBER($G6),$G6<=0)').setBackground('#D9EAD3').setRanges([rango]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=AND(ISNUMBER($G6),$G6>0,$G6<=0.05)').setBackground('#FFF2CC').setRanges([rango]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=AND(ISNUMBER($G6),$G6>0.05,$G6<=0.15)').setBackground('#FCE5CD').setRanges([rango]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=AND(ISNUMBER($G6),$G6>0.15)').setBackground('#F4CCCC').setRanges([rango]).build()
  ]);
}

function estiloEncabezado(sh, n) {
  estiloFila(sh.getRange(1, 1, 1, n));
  sh.setFrozenRows(1);
}
function estiloFila(rango) {
  rango.setFontWeight('bold').setBackground('#0B5F8A').setFontColor('#FFFFFF').setWrap(true).setVerticalAlignment('middle');
}

/* ------------------------------------------------------------------ */
/* Links personales                                                    */
/* ------------------------------------------------------------------ */
function generarLinks() {
  var ui = SpreadsheetApp.getUi();
  var url = ScriptApp.getService().getUrl();
  if (!url) { ui.alert('Primero implementá el formulario como aplicación web (Implementar > Nueva implementación). Después volvé a usar esta opción.'); return; }
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(HOJA.AGENTES);
  var datos = sh.getDataRange().getValues(), nuevos = 0;
  for (var i = 1; i < datos.length; i++) {
    if (!String(datos[i][1]).trim()) continue;
    var clave = String(datos[i][4]).trim();
    if (!clave) { clave = Utilities.getUuid().replace(/-/g, '').slice(0, 16); sh.getRange(i + 1, 5).setValue(clave); nuevos++; }
    sh.getRange(i + 1, 6).setValue(url + '?k=' + clave);
  }
  registrar('BIDCOM', 'Generó links', nuevos + ' clave(s) nueva(s)');
  ui.alert('Listo. Cada agente tiene su link en la columna F de la pestaña "Agentes".\n\nMandale a cada uno SOLO su link. Para dar de baja a un agente, poné NO en la columna Activo.');
}

function irAlComparativo() {
  var ss = SpreadsheetApp.getActiveSpreadsheet(), c = ss.getSheetByName(HOJA.COMPARATIVO);
  if (c) ss.setActiveSheet(c);
}

/* ------------------------------------------------------------------ */
/* Formulario web                                                      */
/* ------------------------------------------------------------------ */
function doGet(e) {
  var clave = e && e.parameter ? String(e.parameter.k || '') : '';
  var agente = buscarAgente(clave);
  if (!agente) {
    return HtmlService.createHtmlOutput('<div style="font-family:Arial,sans-serif;max-width:480px;margin:60px auto;padding:0 16px"><h2>Link no válido</h2><p>Este link no corresponde a ningún agente activo. Pedile a BIDCOM tu link personal.</p></div>')
      .setTitle('Tarifador BIDCOM');
  }
  var t = HtmlService.createTemplateFromFile('Index');
  t.clave = clave.replace(/[^A-Za-z0-9]/g, '');
  t.datos =JSON.stringify(datosParaAgente(agente)).replace(/</g, '\\u003c');
  return t.evaluate().setTitle('Tarifario aéreo BIDCOM').addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function buscarAgente(clave) {
  if (!clave || clave.length < 8) return null;
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(HOJA.AGENTES);
  if (!sh) return null;
  var datos = sh.getDataRange().getValues();
  for (var i = 1; i < datos.length; i++) {
    if (String(datos[i][4]).trim() === clave && String(datos[i][3]).trim().toUpperCase() === 'SI') {
      return { codigo: String(datos[i][0]).trim(), nombre: String(datos[i][1]).trim() };
    }
  }
  return null;
}

function leerSolicitud() {
  var s = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(HOJA.SOLICITUD);
  var v = s.getRange('B3:B8').getValues();
  var rutas = s.getRange('A12:C21').getValues()
    .filter(function (r) { return String(r[0]).trim() && String(r[2]).trim().toUpperCase() === 'SI'; })
    .map(function (r) { return { origen: String(r[0]).trim(), destino: String(r[1]).trim() }; });
  var notas = s.getRange('A24:A32').getValues().map(function (r) { return String(r[0]).trim(); }).filter(String);
  return { semana: String(v[0][0]).trim(), desde: fecha(v[1][0]), hasta: fecha(v[2][0]), limite: fecha(v[3][0]),
           peso: Number(v[4][0]) || 500, rutas: rutas, notas: notas };
}

// Lo único que recibe el navegador del agente: su nombre, la solicitud y SUS envíos
function datosParaAgente(agente) {
  var sol = leerSolicitud();
  var envios = enviosDelAgente(agente.nombre);
  var ultimo = envios.filter(function (e) { return e.semana === sol.semana; })[0] || null;
  return { agente: agente.nombre, solicitud: sol, breaks: BREAKS, conceptos: CONCEPTOS, unidades: UNIDADES,
           envios: envios.map(function (e) { return { semana: e.semana, version: e.version, recibido: e.recibido, rutas: e.rutas.length }; }),
           ultimo: ultimo };
}

function enviosDelAgente(nombre) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var t = ss.getSheetByName(HOJA.TARIFAS).getDataRange().getValues();
  var g = ss.getSheetByName(HOJA.GASTOS).getDataRange().getValues();
  var porId = {};
  for (var i = 1; i < t.length; i++) {
    if (t[i][3] !== nombre) continue;
    var id = t[i][0];
    if (!porId[id]) porId[id] = { id: id, recibido: fechaHora(t[i][1]), semana: t[i][2], version: t[i][4], rutas: [], gastos: {} };
    porId[id].rutas.push({ origen: t[i][6], destino: t[i][7], aerolinea: t[i][8], transito: t[i][9], minimo: t[i][11],
      tarifas: { 45: t[i][12], 100: t[i][13], 300: t[i][14], 500: t[i][15], 1000: t[i][16] }, fuel: t[i][17], imo: t[i][18],
      imoPedido: t[i][19] === 'SI', destino_usd: t[i][21], vigencia: fecha(t[i][22]), obs: t[i][24] });
  }
  for (var j = 1; j < g.length; j++) {
    var e = porId[g[j][0]]; if (!e) continue;
    (e.gastos[g[j][4]] = e.gastos[g[j][4]] || []).push({ concepto: g[j][5], importe: g[j][7], unidad: g[j][8], minimo: g[j][9], pedido: g[j][10] === 'SI', descripcion: g[j][11] });
  }
  return Object.keys(porId).map(function (k) { return porId[k]; }).sort(function (a, b) { return b.recibido < a.recibido ? -1 : 1; });
}

/* ------------------------------------------------------------------ */
/* Guardar un envío                                                    */
/* ------------------------------------------------------------------ */
function enviarTarifario(clave, envio) {
  var agente = buscarAgente(clave);                 // la identidad sale de la clave, nunca del navegador
  if (!agente) throw new Error('Tu link ya no es válido. Pedile a BIDCOM uno nuevo.');
  var sol = leerSolicitud();
  var errores = validarEnvio(envio, sol);
  if (errores.length) return { ok: false, errores: errores };

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var t = ss.getSheetByName(HOJA.TARIFAS), g = ss.getSheetByName(HOJA.GASTOS);
    var ahora = new Date(), id = Utilities.getUuid().slice(0, 8).toUpperCase();

    // Versión: cuántos envíos tuvo este agente en esta semana; los anteriores dejan de estar vigentes
    var datosT = t.getDataRange().getValues(), ids = {};
    for (var i = 1; i < datosT.length; i++) {
      if (datosT[i][3] === agente.nombre && datosT[i][2] === sol.semana) { ids[datosT[i][0]] = true; if (datosT[i][5] === 'SI') t.getRange(i + 1, 6).setValue('NO'); }
    }
    var version = Object.keys(ids).length + 1;
    var datosG = g.getDataRange().getValues();
    for (var j = 1; j < datosG.length; j++) {
      if (datosG[j][3] === agente.nombre && datosG[j][2] === sol.semana && datosG[j][12] === 'SI') g.getRange(j + 1, 13).setValue('NO');
    }

    var S = "'" + HOJA.SOLICITUD + "'!$B$7", G = "'" + HOJA.GASTOS + "'";
    var filaT = t.getLastRow() + 1;
    var filasT = envio.rutas.map(function (r, k) {
      var f = filaT + k;
      var tarifaPeso = 'IF(' + S + '>=1000,Q' + f + ',IF(' + S + '>=500,P' + f + ',IF(' + S + '>=300,O' + f + ',IF(' + S + '>=100,N' + f + ',M' + f + '))))';
      return [id, ahora, sol.semana, agente.nombre, version, 'SI', r.origen, r.destino, r.aerolinea, num(r.transito), 'USD', num(r.minimo),
        num(r.tarifas[45]), num(r.tarifas[100]), num(r.tarifas[300]), num(r.tarifas[500]), num(r.tarifas[1000]), num(r.fuel),
        r.imoPedido ? '' : num(r.imo), r.imoPedido ? 'SI' : 'NO',
        '=SUMIFS(' + G + '!N:N,' + G + '!A:A,A' + f + ',' + G + '!E:E,G' + f + ')',
        num(r.destino_usd), aFecha(r.vigencia),
        '=IF(P' + f + '="","",(MAX(L' + f + ',' + tarifaPeso + '*' + S + ')+(R' + f + '+IF(T' + f + '="SI",0,N(S' + f + ')))*' + S + '+U' + f + '+V' + f + ')/' + S + ')',
        r.obs || ''];
    });
    t.getRange(filaT, 1, filasT.length, COLS_TARIFAS.length).setValues(filasT);

    var filaG = g.getLastRow() + 1, filasG = [];
    envio.rutas.forEach(function (r) {
      (envio.gastos[r.origen] || []).forEach(function (c) {
        if (!c.pedido && (c.importe === '' || c.importe === null || c.importe === undefined)) return;
        var f = filaG + filasG.length;
        filasG.push([id, ahora, sol.semana, agente.nombre, r.origen, c.concepto, 'USD', c.pedido ? '' : num(c.importe), c.pedido ? '' : c.unidad,
          c.unidad === 'Por kg' && !c.pedido ? num(c.minimo) : '', c.pedido ? 'SI' : 'NO', c.descripcion || '', 'SI',
          '=IF(K' + f + '="SI",0,IF(I' + f + '="Por kg",MAX(N(J' + f + '),H' + f + '*' + S + '),N(H' + f + ')))']);
      });
    });
    if (filasG.length) g.getRange(filaG, 1, filasG.length, COLS_GASTOS.length).setValues(filasG);

    registrar(agente.nombre, 'Envió tarifario ' + sol.semana + ' (versión ' + version + ')', envio.rutas.length + ' ruta(s), ' + filasG.length + ' gasto(s) en origen. ID ' + id);
    SpreadsheetApp.flush();
    return { ok: true, version: version, id: id, envios: datosParaAgente(agente).envios };
  } finally {
    lock.releaseLock();
  }
}

// Mismas reglas que en pantalla, verificadas otra vez en el servidor
function validarEnvio(envio, sol) {
  var err = [];
  if (!envio || !envio.rutas || !envio.rutas.length) return ['No hay rutas cargadas.'];
  var permitidas = sol.rutas.map(function (r) { return r.origen; });
  envio.rutas.forEach(function (r) {
    var p = r.origen + ': ';
    if (permitidas.indexOf(r.origen) < 0) err.push(p + 'esta ruta no está en la solicitud de la semana.');
    if (!String(r.aerolinea || '').trim()) err.push(p + 'falta la aerolínea.');
    if (!(num(r.transito) > 0)) err.push(p + 'falta el tránsito en días.');
    if (!(num(r.minimo) > 0)) err.push(p + 'falta el mínimo.');
    [100, 300, 500, 1000].forEach(function (b) { if (!(num(r.tarifas[b]) > 0)) err.push(p + 'falta la tarifa de ' + b + ' kg.'); });
    if (r.fuel === '' || r.fuel === null || isNaN(num(r.fuel))) err.push(p + 'falta el fuel (USD/kg).');
    if (!r.imoPedido && (r.imo === '' || r.imo === null || isNaN(num(r.imo)))) err.push(p + 'falta el IMO (o marcalo a pedido).');
    if (r.destino_usd === '' || r.destino_usd === null || isNaN(num(r.destino_usd))) err.push(p + 'faltan los gastos de destino.');
    if (!r.vigencia) err.push(p + 'falta la vigencia.');
    var gastos = (envio.gastos || {})[r.origen] || [];
    var cargados = gastos.filter(function (c) { return c.pedido || (c.importe !== '' && c.importe !== null && c.importe !== undefined); });
    if (!cargados.length) err.push(p + 'faltan los gastos en origen desglosados.');
    cargados.forEach(function (c) {
      if (c.pedido) return;
      if (isNaN(num(c.importe)) || num(c.importe) < 0) err.push(p + c.concepto + ': importe inválido.');
      if (UNIDADES.indexOf(c.unidad) < 0) err.push(p + c.concepto + ': falta la unidad.');
      if (c.unidad === 'Por kg' && !(num(c.minimo) >= 0 && String(c.minimo) !== '')) err.push(p + c.concepto + ': cobro por kg sin mínimo.');
      if (CONCEPTOS.indexOf(c.concepto) < 0 && !String(c.descripcion || '').trim()) err.push(p + 'concepto adicional sin descripción.');
    });
  });
  return err;
}

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */
function registrar(quien, accion, detalle) {
  var r = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(HOJA.REGISTRO);
  if (r) r.appendRow([new Date(), quien, accion, detalle || '']);
}
function num(v) { if (v === '' || v === null || v === undefined) return ''; var n = Number(String(v).replace(',', '.')); return isNaN(n) ? NaN : n; }
function aFecha(s) { if (!s) return ''; var p = String(s).split('-'); return p.length === 3 ? new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])) : s; }
function fecha(d) { return d instanceof Date ? Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd') : String(d || ''); }
function fechaHora(d) { return d instanceof Date ? Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm') : String(d || ''); }
function semanaISO(d) {
  var x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  var dia = (x.getUTCDay() + 6) % 7; x.setUTCDate(x.getUTCDate() - dia + 3);
  var primero = new Date(Date.UTC(x.getUTCFullYear(), 0, 4));
  var sem = 1 + Math.round(((x - primero) / 86400000 - 3 + ((primero.getUTCDay() + 6) % 7)) / 7);
  return 'WK-' + x.getUTCFullYear() + '-W' + (sem < 10 ? '0' : '') + sem;
}
