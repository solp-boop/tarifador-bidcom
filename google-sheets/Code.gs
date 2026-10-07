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
  REGISTRO: 'Registro',
  CONFIG: 'Configuración',
  NEGOCIACION: 'Negociación aérea',
  MAR_TARIFAS: 'Tarifas marítimas (envíos)',
  MAR_GASTOS: 'Gastos en origen marítimo (envíos)',
  MAR_NEGOCIACION: 'Negociación marítima',
  MAR_LISTAS: 'Listas marítimo'
};
var TIPOS = { INICIAL: 'Inicial', NEGOCIADA: 'Negociada' };
var MOTIVOS = { primero: 'Primer envío', correccion: 'Corrección', negociada: 'Mejora negociada' };

var BREAKS = [45, 100, 300, 500, 1000];
var CONCEPTOS = ['Pick up', 'Export customs', 'Handling', 'Documentation', 'Warehouse', 'Security'];
var UNIDADES = ['Fijo por embarque', 'Por kg'];

// Columnas de la pestaña de tarifas (1 = A)
var COLS_TARIFAS = ['ID envío', 'Recibido', 'Week ID', 'Agente', 'Versión', 'Vigente', 'Origen', 'Destino', 'Aerolínea',
  'Tránsito (días)', 'Moneda', 'Mínimo', '45 kg', '100 kg', '300 kg', '500 kg', '1000 kg', 'Fuel USD/kg', 'IMO USD/kg',
  'IMO a pedido', 'Gastos origen USD (al peso ref.)', 'Gastos destino USD', 'Vigencia hasta', 'All-in USD/kg', 'Observaciones',
  'Tipo de tarifa', 'Motivo del envío'];
var COLS_GASTOS = ['ID envío', 'Recibido', 'Week ID', 'Agente', 'Aeropuerto', 'Concepto', 'Moneda', 'Importe', 'Unidad',
  'Mínimo', 'A pedido', 'Descripción', 'Vigente', 'Importe al peso ref. USD', 'Tipo de tarifa'];

/* ------------------------------------------------------------------ */
/* Menú                                                                */
/* ------------------------------------------------------------------ */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Tarifador BIDCOM')
    .addItem('1. Preparar hojas (primera vez)', 'prepararHojas')
    .addItem('2. Generar links de agentes', 'generarLinks')
    .addItem('3. Verificar la base madre', 'verificarBaseMadre')
    .addSeparator()
    .addItem('Pasar la semana actual a la base madre', 'pasarSemanaABaseMadre')
    .addItem('Actualizar la pestaña Negociación aérea', 'actualizarNegociacionMenu')
    .addSeparator()
    .addItem('Marítimo: verificar la base madre', 'verificarBaseMaritima')
    .addItem('Marítimo: actualizar Negociación marítima', 'actualizarNegociacionMaritima')
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

  if (!ss.getSheetByName(HOJA.CONFIG)) {
    var k = ss.insertSheet(HOJA.CONFIG);
    k.getRange('A1').setValue('Configuración del pegado en la base madre').setFontWeight('bold').setFontSize(14);
    k.getRange('A2').setValue('Cada envío de un agente se pega solo en la pestaña de la base madre que indiques acá. No se cambian columnas ni formatos: se completa cada columna según su encabezado.');
    k.getRange(4, 1, 5, 3).setValues([
      ['Base madre: link de la planilla', '', 'Vacío = esta misma planilla. Si la base madre es otro archivo, pegá acá su link.'],
      ['Pestaña de destino (aéreo)', '', 'Nombre exacto de la pestaña donde hoy pegás los tarifarios de los agentes.'],
      ['Pegar automáticamente al recibir', 'SI', 'NO = solo se guarda en las pestañas de envíos; se pasa a mano con el menú.'],
      ['IMO a pedido se escribe como', 'Upon RQST', 'Texto que se pone en la columna de IMO cuando el agente lo marca a pedido.'],
      ['Si el agente corrige un envío', 'Reemplazar la fila anterior', 'Reemplazar = la corrección pisa la fila con error. Agregar = queda una fila por cada envío.']]);
    k.getRange('A4:A8').setFontWeight('bold');
    k.getRange('B4:B8').setBackground('#FFF2CC');
    k.getRange('B6').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['SI', 'NO'], true).build());
    k.getRange('B8').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['Reemplazar la fila anterior', 'Agregar una fila nueva'], true).build());
    k.getRange('A10').setValue('Después de completar, usá el menú Tarifador BIDCOM > 3. Verificar la base madre para ver qué columnas se van a completar.');
    k.setColumnWidth(1, 280); k.setColumnWidth(2, 360); k.setColumnWidth(3, 560);
    creadas.push(HOJA.CONFIG);
  }

  if (!ss.getSheetByName(HOJA.NEGOCIACION)) {
    ss.insertSheet(HOJA.NEGOCIACION); armarNegociacion();
    creadas.push(HOJA.NEGOCIACION);
  }
  asegurarEncabezados(ss.getSheetByName(HOJA.TARIFAS), COLS_TARIFAS);
  asegurarEncabezados(ss.getSheetByName(HOJA.GASTOS), COLS_GASTOS);
  var conf = ss.getSheetByName(HOJA.CONFIG);
  if (conf && !String(conf.getRange('A9').getValue()).trim()) {
    conf.getRange(9, 1, 1, 3).setValues([['Pestaña para tarifas negociadas (aéreo)', '', 'Vacío = la misma pestaña. Si tu base madre tiene una pestaña aparte para negociadas, escribí su nombre.']]);
    conf.getRange('A9').setFontWeight('bold'); conf.getRange('B9').setBackground('#FFF2CC');
    conf.getRange('A11').setValue('Si usás una sola pestaña, conviene que tenga una columna "Tipo de tarifa": ahí se escribe Inicial o Negociada y las dos filas quedan. Si no la tiene, la negociada se agrega como fila nueva y en Observaciones dice "Tarifa negociada".');
  }

  prepararMaritimo(ss, creadas);

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
  return t.evaluate().setTitle('Tarifas BIDCOM').addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function buscarAgente(clave) {
  if (!clave || clave.length < 8) return null;
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(HOJA.AGENTES);
  if (!sh) return null;
  var datos = sh.getDataRange().getValues();
  for (var i = 1; i < datos.length; i++) {
    if (String(datos[i][4]).trim() === clave && String(datos[i][3]).trim().toUpperCase() === 'SI') {
      return { codigo: String(datos[i][0]).trim(), nombre: String(datos[i][1]).trim(), contacto: String(datos[i][6] || '').trim() };
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
           envios: envios.map(function (e) { return { semana: e.semana, version: e.version, recibido: e.recibido, rutas: e.rutas.length, tipo: e.tipo, motivo: e.motivo }; }),
           ultimo: ultimo, mar: datosMaritimoParaAgente(agente) };
}

function enviosDelAgente(nombre) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var t = ss.getSheetByName(HOJA.TARIFAS).getDataRange().getValues();
  var g = ss.getSheetByName(HOJA.GASTOS).getDataRange().getValues();
  var porId = {};
  for (var i = 1; i < t.length; i++) {
    if (t[i][3] !== nombre) continue;
    var id = t[i][0];
    if (!porId[id]) porId[id] = { id: id, recibido: fechaHora(t[i][1]), semana: t[i][2], version: t[i][4], tipo: t[i][25] || TIPOS.INICIAL, motivo: t[i][26] || '', rutas: [], gastos: {} };
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
    // Tipo de tarifa: el primer envío de la semana es la inicial. Después, el agente indica si corrige o si manda una mejora negociada.
    var ultimoTipo = TIPOS.INICIAL;
    for (var u = datosT.length - 1; u >= 1; u--) { if (datosT[u][3] === agente.nombre && datosT[u][2] === sol.semana) { ultimoTipo = datosT[u][25] || TIPOS.INICIAL; break; } }
    var motivo = version === 1 ? 'primero' : envio.motivo;
    if (version > 1 && !MOTIVOS[motivo]) return { ok: false, errores: ['Indicá si este envío corrige un error o es una tarifa mejorada.'] };
    var tipo = motivo === 'negociada' ? TIPOS.NEGOCIADA : motivo === 'correccion' ? ultimoTipo : TIPOS.INICIAL;
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
        r.obs || '', tipo, MOTIVOS[motivo]];
    });
    t.getRange(filaT, 1, filasT.length, COLS_TARIFAS.length).setValues(filasT);

    var filaG = g.getLastRow() + 1, filasG = [];
    envio.rutas.forEach(function (r) {
      (envio.gastos[r.origen] || []).forEach(function (c) {
        if (!c.pedido && (c.importe === '' || c.importe === null || c.importe === undefined)) return;
        var f = filaG + filasG.length;
        filasG.push([id, ahora, sol.semana, agente.nombre, r.origen, c.concepto, 'USD', c.pedido ? '' : num(c.importe), c.pedido ? '' : c.unidad,
          c.unidad === 'Por kg' && !c.pedido ? num(c.minimo) : '', c.pedido ? 'SI' : 'NO', c.descripcion || '', 'SI',
          '=IF(K' + f + '="SI",0,IF(I' + f + '="Por kg",MAX(N(J' + f + '),H' + f + '*' + S + '),N(H' + f + ')))', tipo]);
      });
    });
    if (filasG.length) g.getRange(filaG, 1, filasG.length, COLS_GASTOS.length).setValues(filasG);

    registrar(agente.nombre, 'Envió tarifario ' + sol.semana + ' (versión ' + version + ', ' + tipo.toLowerCase() + (motivo === 'correccion' ? ', corrección' : '') + ')', envio.rutas.length + ' ruta(s), ' + filasG.length + ' gasto(s) en origen. ID ' + id);
    SpreadsheetApp.flush();
    // Pegado en la base madre: si falla, el envío igual queda guardado y el error va al Registro
    try {
      var cfg = leerConfig();
      if (cfg.auto) {
        pegarEnBaseMadre(envio.rutas.map(function (r) {
          return { semana: sol.semana, agente: agente.nombre, version: version, recibido: ahora, tipo: tipo, motivo: MOTIVOS[motivo], origen: r.origen, destino: r.destino, aerolinea: r.aerolinea,
            transito: num(r.transito), minimo: num(r.minimo), tarifas: r.tarifas, fuel: num(r.fuel), imo: r.imoPedido ? '' : num(r.imo), imoPedido: !!r.imoPedido,
            destino_usd: num(r.destino_usd), vigencia: aFecha(r.vigencia), obs: r.obs || '',
            gastos: (envio.gastos[r.origen] || []).map(function (c) { return { importe: num(c.importe), unidad: c.unidad, minimo: num(c.minimo), pedido: !!c.pedido }; }) };
        }), sol.peso, cfg);
      }
    } catch (err) {
      registrar('BIDCOM', 'Error al pegar en la base madre', String(err && err.message || err));
    }
    try { actualizarNegociacion(); } catch (err2) { registrar('BIDCOM', 'Error al actualizar Negociación aérea', String(err2 && err2.message || err2)); }
    return { ok: true, version: version, id: id, tipo: tipo, envios: datosParaAgente(agente).envios };
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

/* ------------------------------------------------------------------ */
/* Pegado automático en la base madre                                  */
/* Se completa cada columna según su encabezado. No se agregan ni       */
/* mueven columnas, y las columnas con fórmula se respetan.             */
/* ------------------------------------------------------------------ */
var MAPA_AEREO = [
  ['semana', ['WEEK ID', 'WEEK', 'SEMANA', 'WEEK ID SEMANA']],
  ['agente', ['AGENT', 'AGENTE', 'FFWW', 'FORWARDER']],
  ['origen', ['ORIGIN AIRPORT', 'ORIGEN', 'AEROPUERTO ORIGEN', 'AEROPUERTO DE ORIGEN', 'ORIGIN']],
  ['destino', ['DESTINATION AIRPORT', 'DESTINO', 'AEROPUERTO DESTINO', 'AEROPUERTO DE DESTINO', 'DESTINATION']],
  ['aerolinea', ['AEROLINEA HABITUAL', 'AEROLINEA', 'AIRLINE', 'CARRIER']],
  ['transito', ['TRANSITO HABITUAL (DIAS)', 'TRANSITO HABITUAL', 'TRANSITO (DIAS)', 'TRANSITO', 'TT', 'TRANSIT TIME']],
  ['moneda', ['CURRENCY', 'MONEDA']],
  ['minimo', ['MINIMUM CHARGE', 'MINIMO', 'MIN', 'MINIMUM']],
  ['r45', ['RATE 45 KG', '45 KG', '+45', '+45 KG']],
  ['r100', ['RATE 100 KG', '100 KG', '+100', '+100 KG']],
  ['r300', ['RATE 300 KG', '300 KG', '+300', '+300 KG']],
  ['r500', ['RATE 500 KG', '500 KG', '+500', '+500 KG']],
  ['r1000', ['RATE 1000 KG', '1000 KG', '+1000', '+1000 KG']],
  ['fuel', ['FUEL SURCHARGE (USD/KG)', 'FUEL SURCHARGE', 'FUEL USD/KG', 'FUEL', 'FSC']],
  ['imo', ['RECARGO IMO (USD/KG)', 'RECARGO IMO', 'IMO USD/KG', 'IMO']],
  ['origenUsd', ['CARGOS DE ORIGEN', 'GASTOS EN ORIGEN', 'GASTOS ORIGEN', 'ORIGIN CHARGES'], true],
  ['destinoUsd', ['CARGOS DE DESTINO', 'GASTOS EN DESTINO', 'GASTOS DESTINO', 'DESTINATION CHARGES'], true],
  ['vigencia', ['VIGENCIA', 'VALIDEZ HASTA', 'VALIDITY', 'VALID UNTIL'], true],
  ['allin', ['ALL-IN', 'ALL IN', 'ALLIN'], true],
  ['obs', ['OBSERVACIONES', 'COMENTARIOS', 'REMARKS', 'OBS']],
  ['version', ['VERSION']],
  ['recibido', ['FECHA RECEPCION', 'FECHA DE RECEPCION', 'RECIBIDO', 'FECHA DE CARGA']],
  ['tipo', ['TIPO DE TARIFA', 'TIPO TARIFA', 'TIPO', 'INICIAL / NEGOCIADA', 'INICIAL O NEGOCIADA', 'ESTADO DE LA TARIFA']]
];
var NOMBRE_CAMPO = { semana: 'Semana', agente: 'Agente', origen: 'Origen', destino: 'Destino', aerolinea: 'Aerolínea', transito: 'Tránsito', moneda: 'Moneda',
  minimo: 'Mínimo', r45: '45 kg', r100: '100 kg', r300: '300 kg', r500: '500 kg', r1000: '1000 kg', fuel: 'Fuel', imo: 'IMO', origenUsd: 'Gastos en origen (total)',
  destinoUsd: 'Gastos destino', vigencia: 'Vigencia', allin: 'All-in USD/kg', obs: 'Observaciones', version: 'Versión', recibido: 'Fecha de recepción', tipo: 'Tipo de tarifa (Inicial / Negociada)' };

function claveTexto(v) {
  return String(v === null || v === undefined ? '' : v).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9+]/g, '');
}
function leerConfig() {
  var k = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(HOJA.CONFIG);
  if (!k) return { auto: false };
  var v = k.getRange('B4:B9').getValues();
  return { url: String(v[0][0]).trim(), pestana: String(v[1][0]).trim(), auto: String(v[2][0]).trim().toUpperCase() === 'SI' && !!String(v[1][0]).trim(),
           imoTexto: String(v[3][0]).trim() || 'Upon RQST', reemplazar: String(v[4][0]).indexOf('Agregar') !== 0,
           pestanaNeg: String((v[5] || [''])[0]).trim() };
}
function abrirDestino(cfg, nombre) {
  nombre = nombre || cfg.pestana;
  if (!nombre) throw new Error('Falta el nombre de la pestaña de destino en la pestaña Configuración.');
  var libro = cfg.url ? SpreadsheetApp.openByUrl(cfg.url) : SpreadsheetApp.getActiveSpreadsheet();
  var hoja = libro.getSheetByName(nombre);
  if (!hoja) throw new Error('No existe la pestaña "' + nombre + '" en la base madre. Revisá que el nombre sea exacto.');
  return hoja;
}
// Busca en las primeras 20 filas la que más encabezados reconocidos tiene
function mapearEncabezados(hoja, mapaDef) {
  mapaDef = mapaDef || MAPA_AEREO;
  var n = Math.min(20, Math.max(1, hoja.getLastRow())), ancho = Math.max(1, hoja.getLastColumn());
  var filas = hoja.getRange(1, 1, n, ancho).getValues(), mejor = { fila: 0, mapa: {}, n: 0, desconocidas: [] };
  filas.forEach(function (fila, i) {
    var mapa = {}, cuenta = 0, desconocidas = [];
    fila.forEach(function (h, j) {
      var k = claveTexto(h); if (!k) return;
      var campo = null;
      mapaDef.forEach(function (m) {
        if (campo) return;
        m[1].forEach(function (alias) { var a = claveTexto(alias); if (!campo && (k === a || (m[2] && k.indexOf(a) === 0))) campo = m[0]; });
      });
      if (campo && !mapa[campo]) { mapa[campo] = j + 1; cuenta++; } else if (!campo) desconocidas.push(String(h).trim());
    });
    if (cuenta > mejor.n) mejor = { fila: i + 1, mapa: mapa, n: cuenta, desconocidas: desconocidas };
  });
  return mejor.n >= 3 ? mejor : null;
}
function tarifaAlPeso(tarifas, W) {
  var b = [1000, 500, 300, 100, 45].filter(function (x) { return x <= W && num(tarifas[x]) > 0; })[0];
  return b ? num(tarifas[b]) : NaN;
}
function calcularAllIn(f, W) {
  var origen = (f.gastos || []).reduce(function (s, c) {
    if (c.pedido || c.importe === '' || isNaN(c.importe)) return s;
    return s + (c.unidad === 'Por kg' ? Math.max(Number(c.minimo) || 0, c.importe * W) : c.importe);
  }, 0);
  var rate = tarifaAlPeso(f.tarifas || {}, W);
  if (isNaN(rate) || f.minimo === '' || isNaN(f.minimo)) return { origen: origen, allin: '' };
  var imo = f.imoPedido ? 0 : (Number(f.imo) || 0);
  var allin = (Math.max(f.minimo, rate * W) + ((Number(f.fuel) || 0) + imo) * W + origen + (Number(f.destino_usd) || 0)) / W;
  return { origen: Math.round(origen * 100) / 100, allin: Math.round(allin * 10000) / 10000 };
}
function valorDe(campo, f, calc, cfg) {
  switch (campo) {
    case 'semana': return f.semana; case 'agente': return f.agente; case 'origen': return f.origen; case 'destino': return f.destino;
    case 'aerolinea': return f.aerolinea; case 'transito': return f.transito; case 'moneda': return 'USD'; case 'minimo': return f.minimo;
    case 'r45': return num(f.tarifas[45]); case 'r100': return num(f.tarifas[100]); case 'r300': return num(f.tarifas[300]);
    case 'r500': return num(f.tarifas[500]); case 'r1000': return num(f.tarifas[1000]);
    case 'fuel': return f.fuel; case 'imo': return f.imoPedido ? cfg.imoTexto : f.imo;
    case 'origenUsd': return calc.origen; case 'destinoUsd': return f.destino_usd; case 'vigencia': return f.vigencia;
    case 'allin': return calc.allin; case 'obs': return f.obs; case 'version': return f.version; case 'recibido': return f.recibido;
    case 'tipo': return f.tipo || TIPOS.INICIAL;
  }
  return '';
}
function pegarEnBaseMadre(filas, W, cfg) {
  cfg = cfg || leerConfig();
  // Las negociadas van a su propia pestaña si está configurada; si no, a la misma
  var separada = !!cfg.pestanaNeg && cfg.pestanaNeg !== cfg.pestana, grupos = {};
  filas.forEach(function (f) {
    var destino = separada && f.tipo === TIPOS.NEGOCIADA ? cfg.pestanaNeg : cfg.pestana;
    (grupos[destino] = grupos[destino] || []).push(f);
  });
  var total = { nuevas: 0, actualizadas: 0 };
  Object.keys(grupos).forEach(function (nombre) {
    var r = pegarEnPestana(abrirDestino(cfg, nombre), nombre, grupos[nombre], W, cfg, separada);
    total.nuevas += r.nuevas; total.actualizadas += r.actualizadas;
  });
  return total;
}

function pegarEnPestana(hoja, nombre, filas, W, cfg, separada) {
  var enc = mapearEncabezados(hoja);
  if (!enc) throw new Error('No encontré los encabezados en la pestaña "' + nombre + '" (busqué en las primeras 20 filas).');
  var M = enc.mapa, colClave = M.origen || M.agente;
  if (!colClave) throw new Error('La pestaña de destino no tiene columna de Origen ni de Agente.');
  var ancho = hoja.getLastColumn(), nuevas = 0, actualizadas = 0;
  // Última fila con datos según la columna de Origen (las filas de abajo pueden tener fórmulas preparadas)
  var ultima = enc.fila, totalFilas = hoja.getLastRow();
  var datos = totalFilas > enc.fila ? hoja.getRange(enc.fila + 1, 1, totalFilas - enc.fila, ancho).getValues() : [];
  var formulas = totalFilas > enc.fila ? hoja.getRange(enc.fila + 1, 1, totalFilas - enc.fila, ancho).getFormulas() : [];
  datos.forEach(function (r, i) { if (String(r[colClave - 1]).trim() !== '') ultima = enc.fila + 1 + i; });
  var mismaPestanaSinTipo = !separada && !M.tipo;

  filas.forEach(function (f) {
    var calc = calcularAllIn(f, W), fila = 0;
    if (M.semana && M.agente && M.origen) {
      var candidatas = [];
      for (var i = 0; i < datos.length; i++) {
        var r = datos[i] || [];
        if (claveTexto(r[M.semana - 1]) === claveTexto(f.semana) && claveTexto(r[M.agente - 1]) === claveTexto(f.agente) && claveTexto(r[M.origen - 1]) === claveTexto(f.origen) &&
            (!M.tipo || claveTexto(r[M.tipo - 1] || TIPOS.INICIAL) === claveTexto(f.tipo || TIPOS.INICIAL))) candidatas.push(enc.fila + 1 + i);
      }
      if (!cfg.reemplazar && f.motivo === MOTIVOS.correccion) fila = 0;                       // modo "agregar": cada envío es una fila
      else if (!mismaPestanaSinTipo) fila = candidatas.length ? candidatas[candidatas.length - 1] : 0;
      else if (f.tipo !== TIPOS.NEGOCIADA) fila = candidatas.length ? candidatas[0] : 0;      // la inicial es la primera fila de esa ruta
      else fila = f.motivo === MOTIVOS.correccion && candidatas.length > 1 ? candidatas[candidatas.length - 1] : 0;   // nueva negociación: fila nueva, la inicial queda
    }
    var esNueva = !fila;
    if (esNueva) {
      fila = ultima + 1; ultima = fila;
      if (fila - 1 > enc.fila) hoja.getRange(fila - 1, 1, 1, ancho).copyTo(hoja.getRange(fila, 1, 1, ancho), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
    }
    var idx = fila - enc.fila - 1;
    datos[idx] = datos[idx] || []; formulas[idx] = formulas[idx] || [];
    var filaFormulas = formulas[idx].slice();
    var filaArriba = idx > 0 ? (formulas[idx - 1] || []) : [];
    Object.keys(M).forEach(function (campo) {
      var c = M[campo];
      if (filaFormulas[c - 1]) return;                                     // la celda ya tiene fórmula: se respeta
      if (esNueva && filaArriba[c - 1]) {                                  // columna calculada en la base: se copia la fórmula de arriba
        hoja.getRange(fila - 1, c).copyTo(hoja.getRange(fila, c), SpreadsheetApp.CopyPasteType.PASTE_FORMULA, false);
        formulas[idx][c - 1] = filaArriba[c - 1];
        return;
      }
      var v = valorDe(campo, f, calc, cfg);
      if (campo === 'obs' && mismaPestanaSinTipo && f.tipo === TIPOS.NEGOCIADA) v = 'Tarifa negociada. ' + (v || '');
      hoja.getRange(fila, c).setValue(v === undefined || (typeof v === 'number' && isNaN(v)) ? '' : v);
    });
    if (esNueva) {
      // Columnas que no reconozco pero tienen fórmula en la fila de arriba: también se copian
      filaArriba.forEach(function (fx, j) {
        var usada = Object.keys(M).some(function (k) { return M[k] === j + 1; });
        if (fx && !usada && !formulas[idx][j]) { hoja.getRange(fila - 1, j + 1).copyTo(hoja.getRange(fila, j + 1), SpreadsheetApp.CopyPasteType.PASTE_FORMULA, false); formulas[idx][j] = fx; }
      });
      nuevas++;
    } else actualizadas++;
    if (M.semana) datos[idx][M.semana - 1] = f.semana;
    if (M.agente) datos[idx][M.agente - 1] = f.agente;
    if (M.origen) datos[idx][M.origen - 1] = f.origen;
    if (M.tipo) datos[idx][M.tipo - 1] = f.tipo;
  });
  registrar('BIDCOM', 'Pegó en la base madre', nuevas + ' fila(s) nueva(s) y ' + actualizadas + ' actualizada(s) en "' + nombre + '"');
  return { nuevas: nuevas, actualizadas: actualizadas };
}

function verificarBaseMadre() {
  var ui = SpreadsheetApp.getUi();
  try {
    var cfg = leerConfig(), hoja = abrirDestino(cfg), enc = mapearEncabezados(hoja);
    if (!enc) { ui.alert('No encontré los encabezados en "' + cfg.pestana + '". Revisá que la pestaña tenga una fila de títulos (por ejemplo Week ID, Agent, Origin Airport, Rate 500 KG).'); return; }
    var campos = Object.keys(enc.mapa).sort(function (a, b) { return enc.mapa[a] - enc.mapa[b]; })
      .map(function (k) { return '• ' + hoja.getRange(enc.fila, enc.mapa[k]).getValue() + '  ←  ' + NOMBRE_CAMPO[k]; });
    var faltan = Object.keys(NOMBRE_CAMPO).filter(function (k) { return !enc.mapa[k]; }).map(function (k) { return NOMBRE_CAMPO[k]; });
    ui.alert('Base madre encontrada: pestaña "' + cfg.pestana + '", encabezados en la fila ' + enc.fila + '.\n\n' +
      'Columnas que se van a completar solas:\n' + campos.join('\n') +
      (enc.desconocidas.length ? '\n\nColumnas que no toco (quedan como están, y si tienen fórmula se copia): ' + enc.desconocidas.join(', ') : '') +
      (faltan.length ? '\n\nDatos que la base madre no tiene como columna (quedan solo en las pestañas de envíos): ' + faltan.join(', ') : '') +
      '\n\nTarifas negociadas: ' + (cfg.pestanaNeg && cfg.pestanaNeg !== cfg.pestana ? 'van a la pestaña "' + cfg.pestanaNeg + '".'
        : enc.mapa.tipo ? 'van a esta misma pestaña, en otra fila, con "Negociada" en la columna ' + hoja.getRange(enc.fila, enc.mapa.tipo).getValue() + '. La inicial no se pisa.'
        : 'van a esta misma pestaña en una fila nueva, con "Tarifa negociada." en Observaciones. La inicial no se pisa. Si agregás una columna "Tipo de tarifa", queda más claro.') +
      '\n\nPegado automático: ' + (cfg.auto ? 'activado' : 'desactivado') + '.');
  } catch (e) { ui.alert(String(e.message || e)); }
}

function pasarSemanaABaseMadre() {
  var ui = SpreadsheetApp.getUi(), ss = SpreadsheetApp.getActiveSpreadsheet(), sol = leerSolicitud();
  var t = ss.getSheetByName(HOJA.TARIFAS).getDataRange().getValues(), g = ss.getSheetByName(HOJA.GASTOS).getDataRange().getValues();
  var filas = [];
  var ultimas = {};   // última fila de cada agente + ruta + tipo
  for (var x = 1; x < t.length; x++) { if (t[x][2] === sol.semana) ultimas[[t[x][3], t[x][6], t[x][25] || TIPOS.INICIAL].join('|')] = x; }
  var elegidas = {}; Object.keys(ultimas).forEach(function (k) { elegidas[ultimas[k]] = true; });
  for (var i = 1; i < t.length; i++) {
    if (!elegidas[i]) continue;
    var id = t[i][0], origen = t[i][6];
    filas.push({ semana: t[i][2], agente: t[i][3], version: t[i][4], recibido: t[i][1], tipo: t[i][25] || TIPOS.INICIAL, motivo: t[i][26] || '', origen: origen, destino: t[i][7], aerolinea: t[i][8], transito: t[i][9],
      minimo: num(t[i][11]), tarifas: { 45: t[i][12], 100: t[i][13], 300: t[i][14], 500: t[i][15], 1000: t[i][16] }, fuel: num(t[i][17]), imo: num(t[i][18]),
      imoPedido: t[i][19] === 'SI', destino_usd: num(t[i][21]), vigencia: t[i][22], obs: t[i][24],
      gastos: g.slice(1).filter(function (x) { return x[0] === id && x[4] === origen; })
        .map(function (x) { return { importe: num(x[7]), unidad: x[8], minimo: num(x[9]), pedido: x[10] === 'SI' }; }) });
  }
  if (!filas.length) { ui.alert('No hay envíos vigentes para la semana ' + sol.semana + '.'); return; }
  try {
    var cfg = leerConfig(); cfg.reemplazar = true;
    var r = pegarEnBaseMadre(filas, sol.peso, cfg);
    ui.alert('Listo: ' + r.nuevas + ' fila(s) nueva(s) y ' + r.actualizadas + ' actualizada(s) en "' + cfg.pestana + '".');
  } catch (e) { ui.alert(String(e.message || e)); }
}

/* ------------------------------------------------------------------ */
/* Encabezados nuevos en instalaciones existentes                       */
/* ------------------------------------------------------------------ */
function asegurarEncabezados(hoja, cols) {
  if (!hoja) return;
  var actual = hoja.getRange(1, 1, 1, cols.length).getValues()[0];
  cols.forEach(function (c, i) { if (!String(actual[i]).trim()) { hoja.getRange(1, i + 1).setValue(c); estiloFila(hoja.getRange(1, i + 1, 1, 1)); } });
}

/* ------------------------------------------------------------------ */
/* Negociación aérea: inicial contra negociada, ahorro                 */
/* Se rearma siempre desde el historial de envíos, que nunca se borra.  */
/* ------------------------------------------------------------------ */
var COLS_NEG = ['Semana', 'Agente', 'Origen', 'Estado', 'Rondas negociadas', 'Tarifa al peso ref. inicial', 'Tarifa al peso ref. negociada',
  'All-in inicial USD/kg', 'All-in negociado USD/kg', 'Ahorro USD/kg', 'Ahorro %', 'Gastos en origen inicial USD', 'Gastos en origen negociado USD',
  'Ahorro en gastos en origen USD', 'Enviada inicial', 'Enviada negociada'];

function armarNegociacion() {
  var h = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(HOJA.NEGOCIACION);
  h.getRange('A1').setValue('Negociación aérea: tarifa inicial contra tarifa negociada').setFontWeight('bold').setFontSize(14);
  h.getRange('A2').setValue('Se arma sola con cada envío a partir del historial (que nunca se borra). All-in al peso de referencia de la Solicitud semanal. No editar a mano.');
  h.getRange(3, 1, 1, 6).setValues([['Rutas cotizadas', 'Rutas negociadas', 'Ahorro promedio USD/kg', 'Ahorro promedio %', 'Mayor ahorro %', 'Ahorro en gastos en origen USD']]).setFontWeight('bold');
  h.getRange(4, 1, 1, 6).setFormulas([['=COUNTA(A7:A)', '=COUNTIF(D7:D,"Negociada")', '=IFERROR(AVERAGEIF(D7:D,"Negociada",J7:J),"")',
    '=IFERROR(AVERAGEIF(D7:D,"Negociada",K7:K),"")', '=IFERROR(MAX(K7:K),"")', '=SUM(N7:N)']]);
  h.getRange('C4').setNumberFormat('0.00'); h.getRange('D4:E4').setNumberFormat('0.0%'); h.getRange('F4').setNumberFormat('#,##0.00');
  h.getRange(4, 1, 1, 6).setFontSize(13).setBackground('#E2EFDA');
  h.getRange(6, 1, 1, COLS_NEG.length).setValues([COLS_NEG]);
  estiloFila(h.getRange(6, 1, 1, COLS_NEG.length));
  h.setFrozenRows(6); h.setFrozenColumns(3);
  h.getRange('F7:J').setNumberFormat('0.00'); h.getRange('K7:K').setNumberFormat('0.0%'); h.getRange('L7:N').setNumberFormat('#,##0.00');
  h.getRange('O7:P').setNumberFormat('dd/mm/yyyy hh:mm');
  h.setColumnWidth(2, 180); h.setColumnWidth(3, 150);
  h.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThan(0).setBackground('#D9EAD3').setRanges([h.getRange('J7:K')]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenNumberLessThan(0).setBackground('#F4CCCC').setRanges([h.getRange('J7:K')]).build()]);
}

function actualizarNegociacion() {
  var ss = SpreadsheetApp.getActiveSpreadsheet(), h = ss.getSheetByName(HOJA.NEGOCIACION);
  if (!h) return;
  var t = ss.getSheetByName(HOJA.TARIFAS).getDataRange().getValues(), g = ss.getSheetByName(HOJA.GASTOS).getDataRange().getValues();
  var W = leerSolicitud().peso, gastosPorId = {};
  for (var j = 1; j < g.length; j++) {
    var k = g[j][0] + '|' + g[j][4];
    (gastosPorId[k] = gastosPorId[k] || []).push({ importe: num(g[j][7]), unidad: g[j][8], minimo: num(g[j][9]), pedido: g[j][10] === 'SI' });
  }
  var rutas = {}, orden = [];
  for (var i = 1; i < t.length; i++) {
    if (!t[i][0]) continue;
    var key = [t[i][2], t[i][3], t[i][6]].join('|'), tipo = t[i][25] || TIPOS.INICIAL;
    if (!rutas[key]) { rutas[key] = { semana: t[i][2], agente: t[i][3], origen: t[i][6], ini: null, neg: null, rondas: 0 }; orden.push(key); }
    var f = { tarifas: { 45: t[i][12], 100: t[i][13], 300: t[i][14], 500: t[i][15], 1000: t[i][16] }, minimo: num(t[i][11]), fuel: num(t[i][17]), imo: num(t[i][18]),
      imoPedido: t[i][19] === 'SI', destino_usd: num(t[i][21]), gastos: gastosPorId[t[i][0] + '|' + t[i][6]] || [], recibido: t[i][1] };
    f.calc = calcularAllIn(f, W); f.rate = tarifaAlPeso(f.tarifas, W);
    if (tipo === TIPOS.NEGOCIADA) { if (t[i][26] !== MOTIVOS.correccion) rutas[key].rondas++; rutas[key].neg = f; }   // la última negociada (o su corrección) es la que vale
    else rutas[key].ini = f;                                                                                          // la última inicial (con correcciones) es la inicial
  }
  var filas = orden.map(function (k) {
    var r = rutas[k], a = r.ini, b = r.neg;
    var ahorro = a && b && a.calc.allin !== '' && b.calc.allin !== '' ? a.calc.allin - b.calc.allin : '';
    return [r.semana, r.agente, r.origen, b ? 'Negociada' : 'Sin negociar', r.rondas || '',
      a && !isNaN(a.rate) ? a.rate : '', b && !isNaN(b.rate) ? b.rate : '', a ? a.calc.allin : '', b ? b.calc.allin : '',
      ahorro === '' ? '' : Math.round(ahorro * 10000) / 10000, ahorro === '' || !a.calc.allin ? '' : ahorro / a.calc.allin,
      a ? a.calc.origen : '', b ? b.calc.origen : '', a && b ? Math.round((a.calc.origen - b.calc.origen) * 100) / 100 : '',
      a ? a.recibido : '', b ? b.recibido : ''];
  }).sort(function (x, y) { return x[0] < y[0] ? 1 : x[0] > y[0] ? -1 : (x[2] + x[1] < y[2] + y[1] ? -1 : 1); });
  var ultima = h.getLastRow();
  if (ultima >= 7) h.getRange(7, 1, ultima - 6, COLS_NEG.length).clearContent();
  if (filas.length) h.getRange(7, 1, filas.length, COLS_NEG.length).setValues(filas);
}
function actualizarNegociacionMenu() {
  actualizarNegociacion();
  SpreadsheetApp.getUi().alert('Listo. La pestaña "' + HOJA.NEGOCIACION + '" está actualizada con todo el historial.');
}

/* ================================================================== */
/* MARÍTIMO                                                            */
/* Mismo link del agente. Se guarda en pestañas de envíos y se pega en  */
/* "Cotizaciones Maritimos SIN NEGOCIAR" (inicial) y "Negociado".        */
/* ================================================================== */
var CONTENEDORES = ['20ST', '40ST', '40HQ', '40NOR'];
var COLS_MAR = ['ID envío', 'Recibido', 'Quincena desde', 'Quincena hasta', 'FFWW', 'Contacto', 'Versión', 'Vigente', 'Tipo de tarifa', 'Motivo del envío',
  'Ruta', 'POL', 'POD', 'Naviera', 'Tipo de servicio', 'Directo / Transbordo', 'Puerto transbordo', 'TT (días)', 'Pagadero', 'Contenedor',
  'Valor flete USD', 'Días libres', 'Locales ARG USD', 'Recarga IMO USD', 'Fuel adjust USD', 'Adicional puertos internos USD', 'Gastos en origen USD (por contenedor)', 'Comentarios'];
var COLS_MAR_GASTOS = ['ID envío', 'Recibido', 'Quincena desde', 'FFWW', 'Versión', 'Tipo de tarifa', 'Vigente', 'Ruta', 'POL', 'Concepto', 'Importe USD', 'Unidad', 'Descripción'];
var COLS_MAR_NEG = ['Quincena desde', 'FFWW', 'POL', 'POD', 'Naviera', 'Contenedor', 'Estado', 'Rondas negociadas', 'Flete inicial', 'Flete negociado', 'Ahorro flete USD', 'Ahorro flete %',
  'Locales ARG inicial', 'Locales ARG negociado', 'Total inicial', 'Total negociado', 'Ahorro total USD', 'Ahorro total %', 'Gastos en origen inicial', 'Gastos en origen negociado'];

var MAPA_MARITIMO = [
  ['transporte', ['TIPO DE TRANSPORTE', 'TRANSPORTE']],
  ['ffww', ['FFWW', 'FORWARDER']],
  ['contacto', ['AGENTE', 'CONTACTO']],
  ['flete', ['VALOR FLETE', 'FLETE', 'OCEAN FREIGHT']],
  ['pol', ['POL', 'PUERTO DE CARGA']],
  ['tt', ['TT', 'TRANSIT TIME', 'TRANSITO']],
  ['servicio', ['TIPO DE SERVICIO']],
  ['linea', ['LINEA', 'NAVIERA', 'SHIPPING LINE']],
  ['pod', ['POD', 'PUERTO DE DESTINO']],
  ['transbordo', ['TRANSBORDO']],
  ['desde', ['VALIDEZ QUINCENA DESDE', 'VALIDEZ DESDE'], true],
  ['hasta', ['VALIDEZ QUINCENA HASTA', 'VALIDEZ HASTA'], true],
  ['dias', ['DIAS LIBRES']],
  ['pagadero', ['PAGADERO']],
  ['locales', ['LOCALES ARG', 'LOCALES'], true],
  ['ctnr', ['TIPO CTNR', 'TIPO DE CONTENEDOR', 'CONTENEDOR']],
  ['coment', ['COMENTARIOS', 'OBSERVACIONES']],
  ['imo', ['RECARGA IMO', 'RECARGO IMO'], true],
  ['fuel', ['FUEL ADJUST'], true],
  ['puertos', ['ADICIONAL PUERTOS INTERNOS'], true]
];
var NOMBRE_CAMPO_MAR = { transporte: 'Tipo de transporte (Maritimo)', ffww: 'Empresa del agente', contacto: 'Contacto del agente', flete: 'Valor flete', pol: 'POL', tt: 'Transit time',
  servicio: 'Tipo de servicio (Regular / Spot)', linea: 'Naviera', pod: 'POD', transbordo: 'Directo o puerto de transbordo', desde: 'Quincena desde', hasta: 'Quincena hasta',
  dias: 'Días libres', pagadero: 'Pagadero', locales: 'Locales ARG', ctnr: 'Contenedor', coment: 'Comentarios', imo: 'Recarga IMO', fuel: 'Fuel adjust', puertos: 'Adicional puertos internos' };

function prepararMaritimo(ss, creadas) {
  if (!ss.getSheetByName(HOJA.MAR_TARIFAS)) {
    var t = ss.insertSheet(HOJA.MAR_TARIFAS);
    t.getRange(1, 1, 1, COLS_MAR.length).setValues([COLS_MAR]); estiloEncabezado(t, COLS_MAR.length); t.setFrozenColumns(6);
    t.getRange('B:B').setNumberFormat('dd/mm/yyyy hh:mm'); t.getRange('C:D').setNumberFormat('dd/mm/yyyy'); t.getRange('U:AA').setNumberFormat('#,##0.00');
    t.getRange('A1').setNote('La completa el formulario. Una fila por ruta y contenedor. Nunca se borra: cada envío queda con su versión y su tipo de tarifa.');
    creadas.push(HOJA.MAR_TARIFAS);
  }
  if (!ss.getSheetByName(HOJA.MAR_GASTOS)) {
    var g = ss.insertSheet(HOJA.MAR_GASTOS);
    g.getRange(1, 1, 1, COLS_MAR_GASTOS.length).setValues([COLS_MAR_GASTOS]); estiloEncabezado(g, COLS_MAR_GASTOS.length);
    g.getRange('B:B').setNumberFormat('dd/mm/yyyy hh:mm'); g.getRange('C:C').setNumberFormat('dd/mm/yyyy'); g.getRange('K:K').setNumberFormat('#,##0.00');
    g.getRange('A1').setNote('Gastos en origen concepto por concepto. Es la base para negociar gastos en origen.');
    creadas.push(HOJA.MAR_GASTOS);
  }
  if (!ss.getSheetByName(HOJA.MAR_NEGOCIACION)) {
    var n = ss.insertSheet(HOJA.MAR_NEGOCIACION);
    n.getRange('A1').setValue('Negociación marítima: tarifa inicial contra tarifa negociada').setFontWeight('bold').setFontSize(14);
    n.getRange('A2').setValue('Se arma sola con cada envío a partir del historial (que nunca se borra). Total = flete + Locales ARG + recargos. No editar a mano.');
    n.getRange(3, 1, 1, 5).setValues([['Rutas cotizadas', 'Rutas negociadas', 'Ahorro total USD', 'Ahorro promedio %', 'Mayor ahorro %']]).setFontWeight('bold');
    n.getRange(4, 1, 1, 5).setFormulas([['=COUNTA(A7:A)', '=COUNTIF(G7:G,"Negociada")', '=SUM(Q7:Q)', '=IFERROR(AVERAGEIF(G7:G,"Negociada",R7:R),"")', '=IFERROR(MAX(R7:R),"")']]);
    n.getRange('C4').setNumberFormat('#,##0'); n.getRange('D4:E4').setNumberFormat('0.0%'); n.getRange(4, 1, 1, 5).setFontSize(13).setBackground('#E2EFDA');
    n.getRange(6, 1, 1, COLS_MAR_NEG.length).setValues([COLS_MAR_NEG]); estiloFila(n.getRange(6, 1, 1, COLS_MAR_NEG.length));
    n.setFrozenRows(6); n.getRange('A7:A').setNumberFormat('dd/mm/yyyy'); n.getRange('I7:Q').setNumberFormat('#,##0.00'); n.getRange('L7:L').setNumberFormat('0.0%'); n.getRange('R7:R').setNumberFormat('0.0%'); n.getRange('S7:T').setNumberFormat('#,##0.00');
    creadas.push(HOJA.MAR_NEGOCIACION);
  }
  if (!ss.getSheetByName(HOJA.MAR_LISTAS)) {
    var l = ss.insertSheet(HOJA.MAR_LISTAS);
    var listas = [
      ['POL', 'Shanghai', 'Ningbo', 'Shenzhen', 'Yantian', 'Shekou', 'Qingdao', 'Tianjin', 'Xiamen', 'Nansha', 'Guangzhou', 'Hong Kong', 'Busan', 'Singapore'],
      ['POD', 'BUENOS AIRES', 'MONTEVIDEO', 'SANTOS'],
      ['Naviera', 'MSC', 'MAERSK', 'CMA CGM', 'COSCO', 'EVERGREEN', 'HAPAG-LLOYD', 'ONE', 'OOCL', 'HMM', 'ZIM', 'PIL', 'YANG MING', 'WAN HAI', 'TBC'],
      ['Tipo de servicio', 'Regular', 'Spot'],
      ['Pagadero', 'COLLECT', 'PREPAID'],
      ['Conceptos gastos en origen', 'Handling fee', 'VGM / Pesada', 'EIR', 'Seal / Precinto', 'ORC / THC', 'Telex release fee', 'Documentation fee', 'DG fee', 'Pick up fee EXW', 'Warehouse fee', 'Customs clearance fee', 'Issue customs doc fee'],
      ['Unidades', 'Por BL', 'Por contenedor', 'Por embarque', 'Por CBM', 'Por tonelada']];
    listas.forEach(function (col, j) { l.getRange(1, j + 1, col.length, 1).setValues(col.map(function (v) { return [v]; })); });
    estiloEncabezado(l, listas.length); l.getRange(2, 1, 20, listas.length).setBackground('#FFF2CC');
    l.getRange('A1').setNote('Lo que escribas en cada columna aparece en las listas del formulario marítimo del agente. Podés agregar o quitar valores.');
    creadas.push(HOJA.MAR_LISTAS);
  }
  asegurarEncabezados(ss.getSheetByName(HOJA.AGENTES), ['Código', 'Nombre del agente', 'Email de contacto', 'Activo (SI/NO)', 'Clave (automática)', 'Link personal (automático)', 'Contacto (columna Agente de la base)']);
  var k = ss.getSheetByName(HOJA.CONFIG);
  if (k && !String(k.getRange('A13').getValue()).trim()) {
    k.getRange('A13').setValue('MARÍTIMO').setFontWeight('bold');
    k.getRange(14, 1, 5, 3).setValues([
      ['Pestaña tarifas iniciales (marítimo)', 'Cotizaciones Maritimos SIN NEGOCIAR', 'Ahí se pega el primer envío de cada agente (y sus correcciones).'],
      ['Pestaña tarifas negociadas (marítimo)', 'Cotizaciones Maritimos Negociado', 'Ahí se pega la tarifa mejorada después de negociar. La inicial no se toca.'],
      ['Locales ARG aceptado (USD)', 800, 'Se le muestra al agente como referencia. Si cotiza más, se le avisa (no se bloquea el envío).'],
      ['Pegar automáticamente marítimo', 'SI', 'NO = solo se guarda en las pestañas de envíos marítimos.'],
      ['40ST y 40HQ con el mismo valor se pegan como', '40ST/40HQ', 'Si el agente cotiza 40ST y 40HQ al mismo valor y días libres, va una sola fila con este texto.']]);
    k.getRange('A14:A18').setFontWeight('bold'); k.getRange('B14:B18').setBackground('#FFF2CC');
    k.getRange('B17').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['SI', 'NO'], true).build());
  }
}

function leerConfigMar() {
  var k = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(HOJA.CONFIG);
  var base = leerConfig();
  if (!k) return { auto: false };
  var v = k.getRange('B14:B18').getValues();
  return { url: base.url, ini: String(v[0][0]).trim(), neg: String(v[1][0]).trim(), localesAceptado: num(v[2][0]) || 800,
           auto: String(v[3][0]).trim().toUpperCase() === 'SI' && !!String(v[0][0]).trim(), combinado: String(v[4][0]).trim() || '40ST/40HQ' };
}
function leerListasMar() {
  var l = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(HOJA.MAR_LISTAS), out = {};
  if (!l) return out;
  var d = l.getDataRange().getValues(), claves = { 'POL': 'pol', 'POD': 'pod', 'Naviera': 'naviera', 'Tipo de servicio': 'servicio', 'Pagadero': 'pagadero', 'Conceptos gastos en origen': 'conceptos', 'Unidades': 'unidades' };
  (d[0] || []).forEach(function (h, j) {
    var k = claves[String(h).trim()]; if (!k) return;
    out[k] = d.slice(1).map(function (r) { return String(r[j]).trim(); }).filter(String);
  });
  return out;
}
// Quincena actual y la siguiente
function quincenas() {
  var hoy = new Date(), y = hoy.getFullYear(), m = hoy.getMonth(), out = [];
  var q = function (y, m, primera) { return primera ? [new Date(y, m, 1), new Date(y, m, 15)] : [new Date(y, m, 16), new Date(y, m + 1, 0)]; };
  var actual = hoy.getDate() <= 15 ? q(y, m, true) : q(y, m, false);
  var siguiente = hoy.getDate() <= 15 ? q(y, m, false) : q(y, m + 1, true);
  [actual, siguiente].forEach(function (p) { out.push({ desde: fecha(p[0]), hasta: fecha(p[1]) }); });
  return out;
}

function enviosMarDelAgente(nombre) {
  var ss = SpreadsheetApp.getActiveSpreadsheet(), t = ss.getSheetByName(HOJA.MAR_TARIFAS), g = ss.getSheetByName(HOJA.MAR_GASTOS);
  if (!t) return [];
  var dt = t.getDataRange().getValues(), dg = g ? g.getDataRange().getValues() : [], porId = {};
  for (var i = 1; i < dt.length; i++) {
    var r = dt[i]; if (r[4] !== nombre || !r[0]) continue;
    var e = porId[r[0]] = porId[r[0]] || { id: r[0], recibido: fechaHora(r[1]), desde: fecha(r[2]), hasta: fecha(r[3]), version: r[6], tipo: r[8] || TIPOS.INICIAL, motivo: r[9] || '', rutas: {} };
    var ru = e.rutas[r[10]] = e.rutas[r[10]] || { pol: r[11], pod: r[12], naviera: r[13], servicio: r[14], directo: r[15] !== 'Transbordo', transbordo: r[16], tt: r[17], pagadero: r[18],
      contenedores: {}, localesArg: r[22], imo: r[23], fuel: r[24], puertos: r[25], comentarios: r[27], gastos: [] };
    ru.contenedores[r[19]] = { flete: r[20], dias: r[21] };
  }
  for (var j = 1; j < dg.length; j++) {
    var e2 = porId[dg[j][0]]; if (!e2 || !e2.rutas[dg[j][7]]) continue;
    e2.rutas[dg[j][7]].gastos.push({ concepto: dg[j][9], importe: dg[j][10], unidad: dg[j][11], descripcion: dg[j][12] });
  }
  return Object.keys(porId).map(function (k) { var e = porId[k]; e.rutas = Object.keys(e.rutas).sort().map(function (n) { return e.rutas[n]; }); return e; })
    .sort(function (a, b) { return b.recibido < a.recibido ? -1 : 1; });
}
function datosMaritimoParaAgente(agente) {
  var cfg = leerConfigMar(), envios = enviosMarDelAgente(agente.nombre), ultimos = {};
  envios.forEach(function (e) { if (!ultimos[e.desde]) ultimos[e.desde] = e; });
  return { quincenas: quincenas(), localesAceptado: cfg.localesAceptado || 800, listas: leerListasMar(), contenedores: CONTENEDORES, ultimos: ultimos,
           envios: envios.map(function (e) { return { desde: e.desde, hasta: e.hasta, version: e.version, recibido: e.recibido, rutas: e.rutas.length, tipo: e.tipo, motivo: e.motivo }; }) };
}

function validarEnvioMar(envio, listas) {
  var err = [];
  if (!envio || !envio.desde || !envio.hasta) err.push('Falta la quincena.');
  if (!envio || !envio.rutas || !envio.rutas.length) return err.concat(['No hay rutas cargadas.']);
  envio.rutas.forEach(function (r, i) {
    var p = 'Ruta ' + (i + 1) + (r.pol ? ' (' + r.pol + ')' : '') + ': ';
    if (!String(r.pol || '').trim()) err.push(p + 'falta el POL.');
    if (!String(r.pod || '').trim()) err.push(p + 'falta el POD.');
    if (!String(r.naviera || '').trim()) err.push(p + 'falta la naviera.');
    if (!String(r.servicio || '').trim()) err.push(p + 'falta el tipo de servicio (Regular o Spot).');
    if (!r.directo && !String(r.transbordo || '').trim()) err.push(p + 'falta el puerto de transbordo.');
    if (!(num(r.tt) > 0)) err.push(p + 'falta el transit time.');
    if (['COLLECT', 'PREPAID'].indexOf(r.pagadero) < 0) err.push(p + 'falta pagadero.');
    var conts = Object.keys(r.contenedores || {}).filter(function (c) { return CONTENEDORES.indexOf(c) >= 0 && num(r.contenedores[c].flete) > 0; });
    if (!conts.length) err.push(p + 'falta el flete de al menos un contenedor.');
    conts.forEach(function (c) { var d = r.contenedores[c].dias; if (d === '' || d === null || d === undefined || isNaN(num(d))) err.push(p + 'faltan los días libres de ' + c + '.'); });
    if (r.localesArg === '' || r.localesArg === null || r.localesArg === undefined || isNaN(num(r.localesArg))) err.push(p + 'faltan los Locales ARG.');
    ['imo', 'fuel', 'puertos'].forEach(function (k) { if (r[k] !== '' && r[k] !== null && r[k] !== undefined && isNaN(num(r[k]))) err.push(p + 'valor inválido en ' + { imo: 'Recarga IMO', fuel: 'Fuel adjust', puertos: 'Adicional puertos internos' }[k] + '.'); });
    var gastos = (r.gastos || []).filter(function (c) { return c.importe !== '' && c.importe !== null && c.importe !== undefined; });
    if (!gastos.length) err.push(p + 'faltan los gastos en origen desglosados.');
    gastos.forEach(function (c) {
      if (isNaN(num(c.importe)) || num(c.importe) < 0) err.push(p + c.concepto + ': importe inválido.');
      if (!String(c.unidad || '').trim()) err.push(p + c.concepto + ': falta la unidad.');
      if ((listas.conceptos || []).indexOf(c.concepto) < 0 && !String(c.descripcion || '').trim()) err.push(p + 'concepto adicional sin descripción.');
    });
  });
  return err;
}
// Gastos en origen llevados a 1 contenedor (BL, embarque y contenedor completos; CBM y toneladas con un volumen estándar)
var CBM_STD = { '20ST': 28, '40ST': 58, '40HQ': 68, '40NOR': 58 }, TON_STD = { '20ST': 10, '40ST': 12, '40HQ': 12, '40NOR': 12 };
function gastosPorContenedor(gastos, c) {
  return Math.round((gastos || []).reduce(function (s, g) {
    var a = num(g.importe); if (g.importe === '' || isNaN(a)) return s;
    return s + (g.unidad === 'Por CBM' ? a * (CBM_STD[c] || 0) : g.unidad === 'Por tonelada' ? a * (TON_STD[c] || 0) : a);
  }, 0) * 100) / 100;
}

function enviarMaritimo(clave, envio) {
  var agente = buscarAgente(clave);
  if (!agente) throw new Error('Tu link ya no es válido. Pedile a BIDCOM uno nuevo.');
  var listas = leerListasMar(), errores = validarEnvioMar(envio, listas);
  if (errores.length) return { ok: false, errores: errores };
  var desde = aFecha(envio.desde), hasta = aFecha(envio.hasta);
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet(), t = ss.getSheetByName(HOJA.MAR_TARIFAS), g = ss.getSheetByName(HOJA.MAR_GASTOS);
    var ahora = new Date(), id = 'M' + Utilities.getUuid().slice(0, 7).toUpperCase();
    var dt = t.getDataRange().getValues(), ids = {}, ultimoTipo = TIPOS.INICIAL;
    for (var i = 1; i < dt.length; i++) {
      if (dt[i][4] === agente.nombre && fecha(dt[i][2]) === envio.desde) { ids[dt[i][0]] = true; ultimoTipo = dt[i][8] || TIPOS.INICIAL; if (dt[i][7] === 'SI') t.getRange(i + 1, 8).setValue('NO'); }
    }
    var version = Object.keys(ids).length + 1;
    var motivo = version === 1 ? 'primero' : envio.motivo;
    if (version > 1 && !MOTIVOS[motivo]) return { ok: false, errores: ['Indicá si este envío corrige un error o es una tarifa mejorada.'] };
    var tipo = motivo === 'negociada' ? TIPOS.NEGOCIADA : motivo === 'correccion' ? ultimoTipo : TIPOS.INICIAL;
    var dg = g.getDataRange().getValues();
    for (var j = 1; j < dg.length; j++) { if (dg[j][3] === agente.nombre && fecha(dg[j][2]) === envio.desde && dg[j][6] === 'SI') g.getRange(j + 1, 7).setValue('NO'); }

    var filas = [], filasG = [], paraBase = [], cfg = leerConfigMar();
    envio.rutas.forEach(function (r, k) {
      var ruta = 'R' + (k + 1);
      var gastos = (r.gastos || []).filter(function (c) { return c.importe !== '' && c.importe !== null && c.importe !== undefined; });
      gastos.forEach(function (c) { filasG.push([id, ahora, desde, agente.nombre, version, tipo, 'SI', ruta, r.pol, c.concepto, num(c.importe), c.unidad, c.descripcion || '']); });
      var conts = CONTENEDORES.filter(function (c) { return r.contenedores[c] && num(r.contenedores[c].flete) > 0; });
      conts.forEach(function (c) {
        filas.push([id, ahora, desde, hasta, agente.nombre, agente.contacto || '', version, 'SI', tipo, MOTIVOS[motivo], ruta, r.pol, r.pod, r.naviera, r.servicio,
          r.directo ? 'Directo' : 'Transbordo', r.directo ? '' : r.transbordo, num(r.tt), r.pagadero, c, num(r.contenedores[c].flete), num(r.contenedores[c].dias),
          num(r.localesArg), num(r.imo), num(r.fuel), num(r.puertos), gastosPorContenedor(gastos, c), r.comentarios || '']);
      });
      // Para la base madre: 40ST y 40HQ con el mismo valor y días libres van en una sola fila
      var c40 = r.contenedores['40ST'], c4h = r.contenedores['40HQ'];
      var juntar = conts.indexOf('40ST') >= 0 && conts.indexOf('40HQ') >= 0 && num(c40.flete) === num(c4h.flete) && num(c40.dias) === num(c4h.dias);
      conts.forEach(function (c) {
        if (juntar && c === '40HQ') return;
        paraBase.push({ tipo: tipo, motivo: MOTIVOS[motivo], transporte: 'Maritimo', ffww: agente.nombre, contacto: agente.contacto || agente.nombre,
          flete: num(r.contenedores[c].flete), pol: r.pol, tt: num(r.tt), servicio: r.servicio, linea: r.naviera, pod: r.pod,
          transbordo: r.directo ? 'Directo' : r.transbordo, desde: desde, hasta: hasta, dias: num(r.contenedores[c].dias), pagadero: r.pagadero,
          locales: num(r.localesArg), ctnr: juntar && c === '40ST' ? cfg.combinado : c, coment: r.comentarios || '', imo: num(r.imo), fuel: num(r.fuel), puertos: num(r.puertos) });
      });
    });
    t.getRange(t.getLastRow() + 1, 1, filas.length, COLS_MAR.length).setValues(filas);
    if (filasG.length) g.getRange(g.getLastRow() + 1, 1, filasG.length, COLS_MAR_GASTOS.length).setValues(filasG);
    registrar(agente.nombre, 'Envió tarifas marítimas quincena ' + envio.desde + ' (versión ' + version + ', ' + tipo.toLowerCase() + (motivo === 'correccion' ? ', corrección' : '') + ')',
      envio.rutas.length + ' ruta(s), ' + filas.length + ' contenedor(es). ID ' + id);
    SpreadsheetApp.flush();
    try { if (cfg.auto) pegarMaritimo(paraBase, cfg); } catch (err) { registrar('BIDCOM', 'Error al pegar marítimo en la base madre', String(err && err.message || err)); }
    try { actualizarNegociacionMaritima(); } catch (err2) { registrar('BIDCOM', 'Error al actualizar Negociación marítima', String(err2 && err2.message || err2)); }
    return { ok: true, version: version, id: id, tipo: tipo, mar: datosMaritimoParaAgente(agente) };
  } finally { lock.releaseLock(); }
}

function valorMar(campo, f) {
  var v = f[campo];
  if (['imo', 'fuel', 'puertos'].indexOf(campo) >= 0 && (v === '' || v === 0)) return '';
  return v;
}
function clavePegado(v) { return v instanceof Date ? fecha(v) : claveTexto(v); }

// Pega en la base madre marítima: inicial en SIN NEGOCIAR, negociada en Negociado. Una corrección pisa su propia fila.
function pegarMaritimo(filas, cfg) {
  var grupos = {};
  filas.forEach(function (f) { var dest = f.tipo === TIPOS.NEGOCIADA ? cfg.neg : cfg.ini; (grupos[dest] = grupos[dest] || []).push(f); });
  var total = { nuevas: 0, actualizadas: 0 };
  Object.keys(grupos).forEach(function (nombre) {
    if (!nombre) throw new Error('Falta el nombre de la pestaña marítima en Configuración.');
    var hoja = abrirDestino({ url: cfg.url }, nombre), enc = mapearEncabezados(hoja, MAPA_MARITIMO);
    if (!enc) throw new Error('No encontré los encabezados en "' + nombre + '".');
    var M = enc.mapa, ancho = hoja.getLastColumn(), ultimaHoja = hoja.getLastRow(), colPol = M.pol || M.ffww;
    // Para no leer 17.000 filas en cada envío, se buscan coincidencias en las últimas 4.000
    var inicio = Math.max(enc.fila + 1, ultimaHoja - 3999), n = Math.max(0, ultimaHoja - inicio + 1);
    var datos = n ? hoja.getRange(inicio, 1, n, ancho).getValues() : [], formulas = n ? hoja.getRange(inicio, 1, n, ancho).getFormulas() : [];
    var ultima = enc.fila; datos.forEach(function (r, i) { if (String(r[colPol - 1]).trim() !== '') ultima = inicio + i; });
    var claves = ['ffww', 'pol', 'pod', 'linea', 'ctnr', 'desde'].filter(function (c) { return M[c]; });
    grupos[nombre].forEach(function (f) {
      var fila = 0;
      if (f.motivo === MOTIVOS.correccion || f.tipo === TIPOS.NEGOCIADA) {
        for (var i = datos.length - 1; i >= 0 && !fila; i--) {
          var r = datos[i] || [];
          if (claves.every(function (c) { return clavePegado(r[M[c] - 1]) === clavePegado(f[c]); })) fila = inicio + i;
        }
      }
      var esNueva = !fila;
      if (esNueva) { fila = ultima + 1; ultima = fila; if (fila - 1 > enc.fila) hoja.getRange(fila - 1, 1, 1, ancho).copyTo(hoja.getRange(fila, 1, 1, ancho), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false); }
      var idx = fila - inicio, arriba = idx > 0 ? (formulas[idx - 1] || []) : [], propias = (formulas[idx] || []).slice();
      datos[idx] = datos[idx] || []; formulas[idx] = formulas[idx] || [];
      Object.keys(M).forEach(function (campo) {
        var c = M[campo];
        if (propias[c - 1]) return;
        if (esNueva && arriba[c - 1]) { hoja.getRange(fila - 1, c).copyTo(hoja.getRange(fila, c), SpreadsheetApp.CopyPasteType.PASTE_FORMULA, false); formulas[idx][c - 1] = arriba[c - 1]; return; }
        var v = valorMar(campo, f); hoja.getRange(fila, c).setValue(v === undefined || (typeof v === 'number' && isNaN(v)) ? '' : v);
        datos[idx][c - 1] = v;
      });
      if (esNueva) {
        arriba.forEach(function (fx, j) {
          var usada = Object.keys(M).some(function (k) { return M[k] === j + 1; });
          if (fx && !usada && !formulas[idx][j]) { hoja.getRange(fila - 1, j + 1).copyTo(hoja.getRange(fila, j + 1), SpreadsheetApp.CopyPasteType.PASTE_FORMULA, false); formulas[idx][j] = fx; }
        });
        total.nuevas++;
      } else total.actualizadas++;
    });
    registrar('BIDCOM', 'Pegó marítimo en la base madre', grupos[nombre].length + ' fila(s) en "' + nombre + '"');
  });
  return total;
}

function verificarBaseMaritima() {
  var ui = SpreadsheetApp.getUi(), cfg = leerConfigMar(), msg = [];
  [cfg.ini, cfg.neg].forEach(function (nombre, i) {
    try {
      var hoja = abrirDestino({ url: cfg.url }, nombre), enc = mapearEncabezados(hoja, MAPA_MARITIMO);
      if (!enc) { msg.push('"' + nombre + '": no encontré los encabezados.'); return; }
      msg.push((i ? 'NEGOCIADAS' : 'INICIALES') + ' → "' + nombre + '" (encabezados en fila ' + enc.fila + ')\n' +
        Object.keys(enc.mapa).sort(function (a, b) { return enc.mapa[a] - enc.mapa[b]; }).map(function (k) { return '• ' + hoja.getRange(enc.fila, enc.mapa[k]).getValue() + '  ←  ' + NOMBRE_CAMPO_MAR[k]; }).join('\n') +
        (enc.desconocidas.length ? '\nNo se tocan (si tienen fórmula se copia): ' + enc.desconocidas.join(', ') : ''));
    } catch (e) { msg.push(String(e.message || e)); }
  });
  ui.alert(msg.join('\n\n') + '\n\nPegado automático marítimo: ' + (cfg.auto ? 'activado' : 'desactivado') + '.');
}

function actualizarNegociacionMaritima() {
  var ss = SpreadsheetApp.getActiveSpreadsheet(), h = ss.getSheetByName(HOJA.MAR_NEGOCIACION), t = ss.getSheetByName(HOJA.MAR_TARIFAS);
  if (!h || !t) return;
  var d = t.getDataRange().getValues(), rutas = {}, orden = [], rondas = {};
  for (var i = 1; i < d.length; i++) {
    var r = d[i]; if (!r[0]) continue;
    var key = [fecha(r[2]), r[4], r[11], r[12], r[13], r[19]].join('|'), tipo = r[8] || TIPOS.INICIAL;
    if (!rutas[key]) { rutas[key] = { desde: r[2], ffww: r[4], pol: r[11], pod: r[12], naviera: r[13], ctnr: r[19], ini: null, neg: null, rondas: 0 }; orden.push(key); }
    var x = { flete: num(r[20]) || 0, locales: num(r[22]) || 0, recargos: (num(r[23]) || 0) + (num(r[24]) || 0) + (num(r[25]) || 0), origen: num(r[26]) || 0 };
    x.total = x.flete + x.locales + x.recargos;
    if (tipo === TIPOS.NEGOCIADA) { if (r[9] !== MOTIVOS.correccion) rutas[key].rondas++; rutas[key].neg = x; } else rutas[key].ini = x;
  }
  var filas = orden.map(function (k) {
    var r = rutas[k], a = r.ini, b = r.neg;
    return [r.desde, r.ffww, r.pol, r.pod, r.naviera, r.ctnr, b ? 'Negociada' : 'Sin negociar', r.rondas || '',
      a ? a.flete : '', b ? b.flete : '', a && b ? a.flete - b.flete : '', a && b && a.flete ? (a.flete - b.flete) / a.flete : '',
      a ? a.locales : '', b ? b.locales : '', a ? a.total : '', b ? b.total : '', a && b ? a.total - b.total : '', a && b && a.total ? (a.total - b.total) / a.total : '',
      a ? a.origen : '', b ? b.origen : ''];
  }).sort(function (x, y) { return y[0] - x[0] || (String(x[2]) + x[1] < String(y[2]) + y[1] ? -1 : 1); });
  var ultima = h.getLastRow();
  if (ultima >= 7) h.getRange(7, 1, ultima - 6, COLS_MAR_NEG.length).clearContent();
  if (filas.length) h.getRange(7, 1, filas.length, COLS_MAR_NEG.length).setValues(filas);
}
