/**
 * Tarifador BIDCOM · Google Sheets + formulario por link (versión 1.6)
 *
 * - Cada agente entra con su link personal y carga sus tarifas (marítimo y aéreo).
 *   Nunca tiene acceso a la planilla: solo ve su formulario y sus propios envíos.
 * - En la base madre solo se escribe en las pestañas de cotizaciones que ya existen
 *   (marítimo: "Cotizaciones Maritimos SIN NEGOCIAR" y "Cotizaciones Maritimos Negociado"),
 *   en las filas vacías debajo del histórico. No se crean pestañas ni columnas ahí.
 * - Todo lo demás vive en DOS pestañas propias:
 *     TARIFADOR Ajustes       → ajustes, agentes, rutas aéreas, listas y registro
 *     TARIFADOR Cotizaciones  → cada tarifa recibida, comparación, decisión del team y ahorro
 * - Flujo: el agente carga → el team recibe un mail → el team aprueba o pide mejora
 *   → el agente recibe un mail con su link → responde → se pega en "Negociado".
 * - Aviso automático al agente N días antes de que venza su tarifa (con copia al team).
 *
 * Instalación: Extensiones > Apps Script, pegar Code.gs e Index.html, menú
 * Tarifador BIDCOM > 1. Preparar hojas, Implementar como aplicación web, 2. Generar links.
 */

var HOJA = { AJUSTES: 'TARIFADOR Ajustes', COTIZ: 'TARIFADOR Cotizaciones' };
var MODO = { MAR: 'Marítimo', AIR: 'Aéreo' };
var TIPOS = { INICIAL: 'Inicial', NEGOCIADA: 'Negociada' };
var MOTIVOS = { primero: 'Primer envío', correccion: 'Corrección', negociada: 'Mejora negociada', sinCambios: 'Sin cambios', nueva: 'Ruta nueva' };
var ESTADOS = { REVISAR: 'Para revisar', RESPUESTA: 'Respuesta para revisar', PEDIDA: 'Mejora pedida', RESPONDIDA: 'Respondida',
  APROBADA: 'Aprobada', DESCARTADA: 'Descartada', REEMPLAZADA: 'Reemplazada' };
var DECISIONES = ['Aprobar', 'Pedir mejora', 'Descartar'];

var BREAKS = [45, 100, 300, 500, 1000];
var CONCEPTOS = ['Pick up', 'Export customs', 'Handling', 'Documentation', 'Warehouse', 'Security'];
var UNIDADES = ['Fijo por embarque', 'Por kg'];
var CONTENEDORES = ['20ST', '40ST', '40HQ', '40NOR'];

/* ------------------------------------------------------------------ */
/* Pestaña TARIFADOR Ajustes: bloques uno al lado del otro              */
/* Encabezados en la fila 3, datos desde la fila 4.                     */
/* ------------------------------------------------------------------ */
var BLOQUE = { AJUSTES: 1, AGENTES: 5, RUTAS_AIR: 13, NOTAS_AIR: 17, LISTAS: 19, REGISTRO: 27 };
var FILA_DATOS = 4;
var AJ = [
  ['GENERAL'],
  ['teamMails', 'Mails del team (separados por coma)', '', 'Reciben un aviso cada vez que un agente carga o responde, y copia de los avisos de vencimiento.'],
  ['reduccion', 'Reducción a pedir a quien cotizó la menor', 0.15, 'Target sugerido: a quien cotizó la menor de la ronda se le pide esta reducción; al resto, igualar la menor.'],
  ['mostrarTarget', 'Decirle el valor objetivo al agente al pedir mejora', 'SI', 'SI = el mail y el formulario muestran el valor a alcanzar. NO = solo se pide mejorar. Nunca se dice que viene de otro agente.'],
  ['diasAviso', 'Aviso de vencimiento: días antes', 5, 'El agente recibe un mail para cargar la tarifa nueva (con copia al team). Se activa una vez desde el menú.'],
  ['baseUrl', 'Base madre: link de la planilla', '', 'Vacío = esta misma planilla.'],
  ['auto', 'Pegar automáticamente en la base madre', 'SI', 'NO = queda solo en TARIFADOR Cotizaciones.'],
  ['MARÍTIMO'],
  ['marIni', 'Pestaña tarifas iniciales', 'Cotizaciones Maritimos SIN NEGOCIAR', 'Primer envío de cada agente (y sus correcciones), en las filas vacías debajo del histórico.'],
  ['marNeg', 'Pestaña tarifas negociadas', 'Cotizaciones Maritimos Negociado', 'La tarifa que el agente manda después de un pedido de mejora.'],
  ['locales', 'Locales ARG aceptado (USD)', 800, 'Se le muestra al agente. Si cotiza más, se marca en el aviso al team.'],
  ['combinado', '40ST y 40HQ con el mismo valor se pegan como', '40ST/40HQ', 'Si el agente cotiza 40ST y 40HQ al mismo valor y días libres, va una sola fila.'],
  ['AÉREO'],
  ['airIni', 'Pestaña tarifas iniciales (aéreo)', '', 'Nombre exacto de la pestaña de la base madre. Vacío = el aéreo queda solo en TARIFADOR Cotizaciones.'],
  ['airNeg', 'Pestaña tarifas negociadas (aéreo)', '', 'Vacío = la misma pestaña.'],
  ['imoTexto', 'IMO a pedido se escribe como', 'Upon RQST', ''],
  ['peso', 'Peso de referencia (kg)', 500, 'Para calcular el all-in USD/kg. No cambiarlo seguido: deja de ser comparable.']
];
var COLS_AGENTES = ['Código', 'Nombre del agente (FFWW)', 'Email del agente', 'Activo (SI/NO)', 'Clave (automática)', 'Link personal (automático)', 'Contacto (columna Agente de la base)'];
var LISTAS_DEF = [
  ['POL', 'Shanghai', 'Ningbo', 'Shenzhen', 'Yantian', 'Shekou', 'Qingdao', 'Tianjin', 'Xiamen', 'Nansha', 'Guangzhou', 'Hong Kong', 'Busan', 'Singapore'],
  ['POD', 'BUENOS AIRES', 'MONTEVIDEO', 'SANTOS'],
  ['Naviera', 'MSC', 'MAERSK', 'CMA CGM', 'COSCO', 'EVERGREEN', 'HAPAG-LLOYD', 'ONE', 'OOCL', 'HMM', 'ZIM', 'PIL', 'YANG MING', 'WAN HAI', 'TBC'],
  ['Tipo de servicio', 'Regular', 'Spot'],
  ['Pagadero', 'COLLECT', 'PREPAID'],
  ['Conceptos gastos en origen', 'Handling fee', 'VGM / Pesada', 'EIR', 'Seal / Precinto', 'ORC / THC', 'Telex release fee', 'Documentation fee', 'DG fee', 'Pick up fee EXW', 'Warehouse fee', 'Customs clearance fee', 'Issue customs doc fee'],
  ['Unidades', 'Por BL', 'Por contenedor', 'Por embarque', 'Por CBM', 'Por tonelada']];
var CLAVES_LISTAS = { 'POL': 'pol', 'POD': 'pod', 'Naviera': 'naviera', 'Tipo de servicio': 'servicio', 'Pagadero': 'pagadero', 'Conceptos gastos en origen': 'conceptos', 'Unidades': 'unidades' };
var RUTAS_AIR_DEF = [['Miami - MIA', 'Buenos Aires - EZE', 'SI'], ['Hong Kong - HKG', 'Buenos Aires - EZE', 'SI'], ['Shanghai - PVG', 'Buenos Aires - EZE', 'SI'],
  ['Shenzhen - SZX', 'Buenos Aires - EZE', 'SI'], ['Ningbo - NGB', 'Buenos Aires - EZE', 'SI'], ['Guangzhou - CAN', 'Buenos Aires - EZE', 'NO']];
var NOTAS_AIR_DEF = [
  'Completá los gastos en origen de cada aeropuerto, concepto por concepto. BIDCOM los va a usar como base para negociar gastos en origen en una etapa próxima.',
  'Si un gasto se cobra por kg, indicá la tarifa por kg y el mínimo (por ejemplo USD 0,15 por kg, mínimo USD 55).',
  'Completá el mínimo y los breaks de 100, 300, 500 y 1000 kg con valores propios de cada ruta, no calculados a partir de otra ruta.',
  'Fuel e IMO en USD por kg. Si el IMO es a pedido, marcalo como a pedido: no se suma al all-in.',
  'Indicá desde y hasta cuándo vale tu tarifa (1 semana, 15 días o 1 mes). Unos días antes del vencimiento te avisamos por mail.'];

/* ------------------------------------------------------------------ */
/* Pestaña TARIFADOR Cotizaciones: una fila por tarifa recibida          */
/* (marítimo: ruta + contenedor; aéreo: ruta). Nunca se borra.          */
/* ------------------------------------------------------------------ */
var CZ = [['id', 'ID envío'], ['recibido', 'Recibido'], ['modo', 'Modo'], ['ffww', 'FFWW (agente)'], ['contacto', 'Contacto'], ['version', 'Versión'],
  ['vigente', 'Última versión'], ['tipo', 'Tipo de tarifa'], ['motivo', 'Motivo'], ['desde', 'Vigencia desde'], ['hasta', 'Vigencia hasta'],
  ['origen', 'Origen (POL / aeropuerto)'], ['destino', 'Destino (POD)'], ['carrier', 'Naviera / Aerolínea'], ['ctnr', 'Contenedor'],
  ['flete', 'Flete (USD/ctnr o USD/kg)'], ['total', 'Total comparable'], ['locales', 'Locales ARG / gastos destino USD'], ['gorigen', 'Gastos en origen USD'],
  ['menor', 'Menor de la ronda'], ['vsMenor', 'Vs la menor'], ['mediana', 'Mediana histórica'], ['target', 'Target sugerido'], ['semaforo', 'Vs histórico'],
  ['estado', 'Estado'], ['decision', 'Decisión del team'], ['targetPedir', 'Target a pedir'], ['mensaje', 'Mensaje al agente'], ['enviada', 'Decisión enviada'],
  ['ahorro', 'Ahorro vs inicial'], ['ahorroPct', 'Ahorro vs inicial %'], ['aviso', 'Aviso de vencimiento'], ['detalle', 'Detalle (no editar)'], ['historial', 'Historial']];
var K = {}; CZ.forEach(function (c, i) { K[c[0]] = i; });

/* Pestañas del formato anterior (v1.5). Solo se tocan si tienen la firma del Tarifador. */
var VIEJAS = [
  ['Agentes', 'E1', 'Clave (automática)'], ['Solicitud semanal', 'A1', 'Solicitud semanal de tarifas aéreas'],
  ['Tarifas aéreas (envíos)', 'C1', 'Week ID'], ['Gastos en origen aéreo (envíos)', 'E1', 'Aeropuerto'], ['Comparativo aéreo', 'A1', 'Comparativo aéreo semanal'],
  ['Registro', 'C1', 'Acción'], ['Configuración', 'A1', 'Configuración del pegado en la base madre'], ['Negociación aérea', 'A1', 'Negociación aérea'],
  ['Tarifas marítimas (envíos)', 'E1', 'FFWW'], ['Gastos en origen marítimo (envíos)', 'J1', 'Concepto'], ['Negociación marítima', 'A1', 'Negociación marítima'],
  ['Listas marítimo', 'F1', 'Conceptos gastos en origen']];

/* ------------------------------------------------------------------ */
/* Menú                                                                */
/* ------------------------------------------------------------------ */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Tarifador BIDCOM')
    .addItem('1. Preparar hojas', 'prepararHojas')
    .addItem('2. Generar links de agentes', 'generarLinks')
    .addItem('3. Verificar la base madre', 'verificarBaseMadre')
    .addItem('4. Activar aviso diario de vencimientos', 'activarAvisos')
    .addSeparator()
    .addItem('Enviar decisiones del team (aprobar / pedir mejora)', 'enviarDecisiones')
    .addItem('Recalcular comparación', 'recalcularMenu')
    .addItem('Revisar vencimientos ahora', 'avisarVencimientosMenu')
    .addItem('Ir a TARIFADOR Cotizaciones', 'irACotizaciones')
    .addToUi();
}

/* ------------------------------------------------------------------ */
/* Preparar hojas: crea las dos pestañas del Tarifador y ordena las     */
/* del formato anterior. Nunca toca las pestañas de la base madre.       */
/* ------------------------------------------------------------------ */
function prepararHojas() {
  var ss = SpreadsheetApp.getActiveSpreadsheet(), ui = SpreadsheetApp.getUi(), hecho = [];
  var aj = ss.getSheetByName(HOJA.AJUSTES);
  if (!aj) {
    aj = ss.insertSheet(HOJA.AJUSTES); armarAjustes(aj); hecho.push('Se creó "' + HOJA.AJUSTES + '".');
    var m = migrarViejas(ss, aj); if (m.length) hecho.push('Se pasaron del formato anterior: ' + m.join(', ') + '. Los links de los agentes siguen funcionando.');
  }
  var cz = ss.getSheetByName(HOJA.COTIZ);
  if (!cz) { cz = ss.insertSheet(HOJA.COTIZ); armarCotizaciones(cz); hecho.push('Se creó "' + HOJA.COTIZ + '".'); }
  else asegurarEncabezados(cz, CZ.map(function (c) { return c[1]; }));
  _AJ = null;

  var viejas = VIEJAS.filter(function (v) { var h = ss.getSheetByName(v[0]); return h && String(h.getRange(v[1]).getValue()).indexOf(v[2]) === 0 && !h.isSheetHidden(); });
  if (viejas.length) {
    var filas = 0;
    viejas.forEach(function (v) { if (/envíos/.test(v[0])) filas += Math.max(0, ss.getSheetByName(v[0]).getLastRow() - 1); });
    var borrar = confirmar('Quedaron ' + viejas.length + ' pestañas del formato anterior del Tarifador:\n' + viejas.map(function (v) { return '• ' + v[0]; }).join('\n') +
      '\n\nSus agentes y ajustes ya están en "' + HOJA.AJUSTES + '".' + (filas ? ' Tienen ' + filas + ' fila(s) de envíos de prueba que no se pasan.' : '') +
      '\n\n¿Las borro?\nSí = se borran.  No = quedan ocultas (las podés borrar después).');
    viejas.forEach(function (v) { var h = ss.getSheetByName(v[0]); if (borrar) ss.deleteSheet(h); else h.hideSheet(); });
    hecho.push(viejas.length + ' pestaña(s) del formato anterior ' + (borrar ? 'borradas.' : 'ocultas.'));
  }
  ui.alert(hecho.length ? 'Listo.\n\n' + hecho.join('\n') + '\n\nPróximo paso: completá los mails del team y los agentes en "' + HOJA.AJUSTES + '".'
    : 'Las pestañas ya estaban listas. No se modificó nada.');
}

function armarAjustes(sh) {
  sh.getRange('A1').setValue('Tarifador BIDCOM · Ajustes').setFontWeight('bold').setFontSize(14);
  sh.getRange('A2').setValue('Las celdas amarillas las completa BIDCOM. Los agentes nunca ven esta planilla: solo su link. Bloques: A Ajustes · E Agentes · M Rutas aéreas · Q Indicaciones aéreo · S Listas marítimo · AA Registro.');
  // Ajustes
  sh.getRange(3, BLOQUE.AJUSTES, 1, 3).setValues([['Ajuste', 'Valor', 'Para qué sirve']]);
  estiloFila(sh.getRange(3, BLOQUE.AJUSTES, 1, 3));
  var filas = AJ.map(function (a) { return a.length === 1 ? [a[0], '', ''] : [a[1], a[2], a[3]]; });
  sh.getRange(FILA_DATOS, 1, filas.length, 3).setValues(filas);
  AJ.forEach(function (a, i) {
    var f = FILA_DATOS + i;
    if (a.length === 1) { sh.getRange(f, 1, 1, 3).setFontWeight('bold').setBackground('#E2EFDA'); return; }
    sh.getRange(f, 2).setBackground('#FFF2CC');
    if (a[0] === 'reduccion') sh.getRange(f, 2).setNumberFormat('0%');
    if (a[0] === 'mostrarTarget' || a[0] === 'auto') sh.getRange(f, 2).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['SI', 'NO'], true).build());
  });
  sh.getRange(FILA_DATOS, 3, filas.length, 1).setWrap(true).setFontColor('#5B6876');
  // Agentes
  sh.getRange(3, BLOQUE.AGENTES, 1, COLS_AGENTES.length).setValues([COLS_AGENTES]);
  estiloFila(sh.getRange(3, BLOQUE.AGENTES, 1, COLS_AGENTES.length));
  sh.getRange(FILA_DATOS, BLOQUE.AGENTES, 1, 4).setValues([['PRUEBA', 'Agente de prueba', '', 'SI']]);
  sh.getRange(FILA_DATOS, BLOQUE.AGENTES, 60, 4).setBackground('#FFF2CC');
  sh.getRange(FILA_DATOS, BLOQUE.AGENTES + 6, 60, 1).setBackground('#FFF2CC');
  sh.getRange(FILA_DATOS, BLOQUE.AGENTES + 3, 60, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['SI', 'NO'], true).build());
  // Rutas aéreas e indicaciones
  sh.getRange(3, BLOQUE.RUTAS_AIR, 1, 3).setValues([['Aéreo: origen', 'Aéreo: destino', 'Cotizar (SI/NO)']]);
  estiloFila(sh.getRange(3, BLOQUE.RUTAS_AIR, 1, 3));
  sh.getRange(FILA_DATOS, BLOQUE.RUTAS_AIR, RUTAS_AIR_DEF.length, 3).setValues(RUTAS_AIR_DEF);
  sh.getRange(FILA_DATOS, BLOQUE.RUTAS_AIR, 20, 3).setBackground('#FFF2CC');
  sh.getRange(3, BLOQUE.NOTAS_AIR).setValue('Indicaciones para agentes (aéreo)');
  estiloFila(sh.getRange(3, BLOQUE.NOTAS_AIR, 1, 1));
  sh.getRange(FILA_DATOS, BLOQUE.NOTAS_AIR, NOTAS_AIR_DEF.length, 1).setValues(NOTAS_AIR_DEF.map(function (x) { return [x]; }));
  sh.getRange(FILA_DATOS, BLOQUE.NOTAS_AIR, 10, 1).setBackground('#FFF2CC').setWrap(true);
  // Listas marítimo
  LISTAS_DEF.forEach(function (col, j) { sh.getRange(3, BLOQUE.LISTAS + j, col.length, 1).setValues(col.map(function (v) { return [v]; })); });
  estiloFila(sh.getRange(3, BLOQUE.LISTAS, 1, LISTAS_DEF.length));
  sh.getRange(FILA_DATOS, BLOQUE.LISTAS, 25, LISTAS_DEF.length).setBackground('#FFF2CC');
  // Registro
  sh.getRange(3, BLOQUE.REGISTRO, 1, 4).setValues([['Fecha y hora', 'Quién', 'Acción', 'Detalle']]);
  estiloFila(sh.getRange(3, BLOQUE.REGISTRO, 1, 4));
  sh.getRange(FILA_DATOS, BLOQUE.REGISTRO, 1, 1).setNote('Registro de auditoría: cada envío, decisión y mail queda anotado acá. No editar.');
  sh.setFrozenRows(3);
  sh.setColumnWidth(1, 300); sh.setColumnWidth(2, 260); sh.setColumnWidth(3, 380);
  sh.setColumnWidth(BLOQUE.AGENTES + 1, 200); sh.setColumnWidth(BLOQUE.AGENTES + 2, 220); sh.setColumnWidth(BLOQUE.AGENTES + 5, 360);
  sh.setColumnWidth(BLOQUE.RUTAS_AIR, 150); sh.setColumnWidth(BLOQUE.RUTAS_AIR + 1, 150); sh.setColumnWidth(BLOQUE.NOTAS_AIR, 420);
  sh.setColumnWidth(BLOQUE.REGISTRO, 140); sh.setColumnWidth(BLOQUE.REGISTRO + 2, 240); sh.setColumnWidth(BLOQUE.REGISTRO + 3, 420);
}

function armarCotizaciones(sh) {
  var n = CZ.length;
  sh.getRange(1, 1, 1, n).setValues([CZ.map(function (c) { return c[1]; })]);
  estiloEncabezado(sh, n);
  sh.setFrozenColumns(4);
  var col = function (k) { return colLetra(K[k] + 1); };
  sh.getRange(col('recibido') + '2:' + col('recibido')).setNumberFormat('dd/mm/yyyy hh:mm');
  sh.getRange(col('desde') + '2:' + col('hasta')).setNumberFormat('dd/mm/yyyy');
  sh.getRange(col('flete') + '2:' + col('gorigen')).setNumberFormat('#,##0.00');
  sh.getRange(col('vsMenor') + '2:' + col('vsMenor')).setNumberFormat('+0.0%;-0.0%;0.0%');
  sh.getRange(col('mediana') + '2:' + col('target')).setNumberFormat('#,##0.00');
  sh.getRange(col('targetPedir') + '2:' + col('targetPedir')).setNumberFormat('#,##0.00');
  sh.getRange(col('enviada') + '2:' + col('enviada')).setNumberFormat('dd/mm/yyyy hh:mm');
  sh.getRange(col('ahorro') + '2:' + col('ahorro')).setNumberFormat('#,##0.00');
  sh.getRange(col('ahorroPct') + '2:' + col('ahorroPct')).setNumberFormat('0.0%');
  sh.getRange(col('decision') + '2:' + col('mensaje')).setBackground('#FFF2CC');
  sh.getRange(col('decision') + '2:' + col('decision')).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(DECISIONES, true).build());
  sh.getRange(col('historial') + '2:' + col('historial')).setWrap(false);
  sh.hideColumns(K.detalle + 1);
  sh.getRange(1, K.id + 1).setNote('Una fila por tarifa recibida (marítimo: ruta y contenedor; aéreo: ruta). Nunca se borra: cada envío queda con su versión. Última versión = SI es lo que vale hoy para ese agente y esa vigencia.');
  sh.getRange(1, K.total + 1).setNote('Marítimo: USD por contenedor = flete + Recarga IMO + Fuel adjust + Adicional puertos internos (Locales ARG va aparte). Aéreo: all-in USD/kg al peso de referencia.');
  sh.getRange(1, K.menor + 1).setNote('Ronda = mismas rutas (y contenedor) con vigencias que se superponen. SI = cotizó la menor. "SI (única)" = es la única oferta.');
  sh.getRange(1, K.target + 1).setNote('Regla: a quien cotizó la menor se le pide la reducción de Ajustes (15%); al resto, igualar la menor. Podés escribir otro valor en "Target a pedir".');
  sh.getRange(1, K.semaforo + 1).setNote('Contra la mediana histórica × (1 − reducción). Verde ≤ objetivo · Amarillo hasta +5% · Naranja hasta +15% · Rojo más.');
  sh.getRange(1, K.decision + 1).setNote('Elegí Aprobar, Pedir mejora o Descartar y después usá el menú Tarifador BIDCOM > Enviar decisiones del team. Al agente no le llega nada hasta ese paso.');
  sh.getRange(1, K.targetPedir + 1).setNote('Opcional. Vacío = se usa el target sugerido.');
  var colTodo = function (k) { return sh.getRange(col(k) + '2:' + col(k)); };
  sh.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('SI').setBackground('#D9EAD3').setBold(true).setRanges([colTodo('menor')]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Verde').setBackground('#D9EAD3').setRanges([colTodo('semaforo')]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Amarillo').setBackground('#FFF2CC').setRanges([colTodo('semaforo')]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Naranja').setBackground('#FCE5CD').setRanges([colTodo('semaforo')]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Rojo').setBackground('#F4CCCC').setRanges([colTodo('semaforo')]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(ESTADOS.REVISAR).setBackground('#FFF2CC').setBold(true).setRanges([colTodo('estado')]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(ESTADOS.RESPUESTA).setBackground('#FFF2CC').setBold(true).setRanges([colTodo('estado')]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(ESTADOS.PEDIDA).setBackground('#CFE2F3').setRanges([colTodo('estado')]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(ESTADOS.APROBADA).setBackground('#D9EAD3').setRanges([colTodo('estado')]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThan(0).setFontColor('#1D7A46').setRanges([colTodo('ahorro'), colTodo('ahorroPct')]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=$' + col('vigente') + '2="NO"').setFontColor('#9AA5B1').setRanges([sh.getRange('A2:' + colLetra(n))]).build()
  ]);
  sh.setColumnWidth(K.ffww + 1, 150); sh.setColumnWidth(K.origen + 1, 140); sh.setColumnWidth(K.destino + 1, 140); sh.setColumnWidth(K.estado + 1, 160);
  sh.setColumnWidth(K.decision + 1, 130); sh.setColumnWidth(K.mensaje + 1, 240); sh.setColumnWidth(K.historial + 1, 420);
  try { sh.getRange(1, 1, Math.max(2, sh.getMaxRows()), n).createFilter(); } catch (e) { /* ya tenía filtro */ }
}

function estiloEncabezado(sh, n) { estiloFila(sh.getRange(1, 1, 1, n)); sh.setFrozenRows(1); }
function estiloFila(rango) { rango.setFontWeight('bold').setBackground('#0B5F8A').setFontColor('#FFFFFF').setWrap(true).setVerticalAlignment('middle'); }
function colLetra(n) { var s = ''; while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
function asegurarEncabezados(hoja, cols) {
  if (!hoja) return;
  var actual = hoja.getRange(1, 1, 1, cols.length).getValues()[0];
  cols.forEach(function (c, i) { if (!String(actual[i]).trim()) { hoja.getRange(1, i + 1).setValue(c); estiloFila(hoja.getRange(1, i + 1, 1, 1)); } });
}
function confirmar(msg) {
  var ui = SpreadsheetApp.getUi();
  return ui.alert('Tarifador BIDCOM', msg, ui.ButtonSet.YES_NO) === ui.Button.YES;
}

// Pasa agentes, ajustes, rutas aéreas y listas del formato anterior (si existen) a TARIFADOR Ajustes
function migrarViejas(ss, aj) {
  var hecho = [], firma = function (nombre) {
    var v = VIEJAS.filter(function (x) { return x[0] === nombre; })[0], h = ss.getSheetByName(nombre);
    return h && String(h.getRange(v[1]).getValue()).indexOf(v[2]) === 0 ? h : null;
  };
  var a = firma('Agentes');
  if (a && a.getLastRow() > 1) {
    var filas = a.getRange(2, 1, a.getLastRow() - 1, 7).getValues().filter(function (r) { return String(r[1]).trim(); });
    if (filas.length) { aj.getRange(FILA_DATOS, BLOQUE.AGENTES, filas.length, 7).setValues(filas); hecho.push(filas.length + ' agente(s) con sus claves'); }
  }
  var k = firma('Configuración');
  if (k) {
    var v = k.getRange('B4:B18').getValues().map(function (r) { return r[0]; });
    var pares = { baseUrl: v[0], airIni: v[1], auto: v[2], imoTexto: v[3], airNeg: v[5], marIni: v[10], marNeg: v[11], locales: v[12], combinado: v[14] };
    Object.keys(pares).forEach(function (key) { if (String(pares[key]).trim()) escribirAjuste(aj, key, pares[key]); });
    hecho.push('ajustes de la base madre');
  }
  var s = firma('Solicitud semanal');
  if (s) {
    var rutas = s.getRange('A12:C21').getValues().filter(function (r) { return String(r[0]).trim(); });
    if (rutas.length) { aj.getRange(FILA_DATOS, BLOQUE.RUTAS_AIR, 20, 3).clearContent(); aj.getRange(FILA_DATOS, BLOQUE.RUTAS_AIR, rutas.length, 3).setValues(rutas); }
    var peso = s.getRange('B7').getValue(), red = s.getRange('B8').getValue();
    if (Number(peso) > 0) escribirAjuste(aj, 'peso', peso);
    if (Number(red) > 0) escribirAjuste(aj, 'reduccion', red);
    hecho.push('rutas aéreas');
  }
  var l = firma('Listas marítimo');
  if (l) {
    var d = l.getDataRange().getValues();
    (d[0] || []).forEach(function (h, j) {
      var pos = LISTAS_DEF.map(function (x) { return x[0]; }).indexOf(String(h).trim()); if (pos < 0) return;
      var vals = d.slice(1).map(function (r) { return [r[j]]; }).filter(function (r) { return String(r[0]).trim(); });
      if (!vals.length) return;
      aj.getRange(FILA_DATOS, BLOQUE.LISTAS + pos, 25, 1).clearContent();
      aj.getRange(FILA_DATOS, BLOQUE.LISTAS + pos, vals.length, 1).setValues(vals);
    });
    hecho.push('listas marítimo');
  }
  return hecho;
}
function escribirAjuste(sh, clave, valor) {
  var i = AJ.map(function (a) { return a[0]; }).indexOf(clave);
  if (i >= 0) sh.getRange(FILA_DATOS + i, 2).setValue(valor);
}

/* ------------------------------------------------------------------ */
/* Lectura de TARIFADOR Ajustes (una sola lectura por ejecución)        */
/* ------------------------------------------------------------------ */
var _AJ = null;
function leerAjustes() {
  if (_AJ) return _AJ;
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(HOJA.AJUSTES);
  if (!sh) throw new Error('Falta preparar las hojas: menú Tarifador BIDCOM > 1. Preparar hojas.');
  var ultima = Math.max(FILA_DATOS, sh.getLastRow());
  var d = sh.getRange(FILA_DATOS, 1, ultima - FILA_DATOS + 1, BLOQUE.LISTAS + LISTAS_DEF.length - 1).getValues();
  var enc = sh.getRange(3, 1, 1, BLOQUE.LISTAS + LISTAS_DEF.length - 1).getValues()[0];
  var porEtiqueta = {};
  d.forEach(function (r) { if (String(r[0]).trim()) porEtiqueta[claveTexto(r[0])] = r[1]; });
  var v = {};
  AJ.forEach(function (a) { if (a.length > 1) { var x = porEtiqueta[claveTexto(a[1])]; v[a[0]] = x === undefined ? a[2] : x; } });
  var red = num(v.reduccion); red = isNaN(red) || red === '' ? 0.15 : red > 1 ? red / 100 : red;
  var cfg = {
    teamMails: String(v.teamMails || '').split(/[,;\s]+/).map(function (x) { return x.trim(); }).filter(function (x) { return /@/.test(x); }),
    reduccion: red, mostrarTarget: String(v.mostrarTarget).trim().toUpperCase() !== 'NO', diasAviso: num(v.diasAviso) >= 0 && v.diasAviso !== '' ? num(v.diasAviso) : 5,
    baseUrl: String(v.baseUrl || '').trim(), auto: String(v.auto).trim().toUpperCase() !== 'NO',
    marIni: String(v.marIni || '').trim(), marNeg: String(v.marNeg || '').trim(), locales: num(v.locales) || 800, combinado: String(v.combinado || '').trim() || '40ST/40HQ',
    airIni: String(v.airIni || '').trim(), airNeg: String(v.airNeg || '').trim(), imoTexto: String(v.imoTexto || '').trim() || 'Upon RQST', peso: num(v.peso) || 500
  };
  var A = BLOQUE.AGENTES - 1;
  cfg.agentes = [];
  d.forEach(function (r, i) {
    if (!String(r[A + 1]).trim()) return;
    cfg.agentes.push({ fila: FILA_DATOS + i, codigo: String(r[A]).trim(), nombre: String(r[A + 1]).trim(), email: String(r[A + 2]).trim(), activo: String(r[A + 3]).trim().toUpperCase() === 'SI',
      clave: String(r[A + 4]).trim(), link: String(r[A + 5]).trim(), contacto: String(r[A + 6] || '').trim() });
  });
  var R = BLOQUE.RUTAS_AIR - 1;
  cfg.rutasAir = d.filter(function (r) { return String(r[R]).trim() && String(r[R + 2]).trim().toUpperCase() === 'SI'; })
    .map(function (r) { return { origen: String(r[R]).trim(), destino: String(r[R + 1]).trim() }; });
  cfg.notasAir = d.map(function (r) { return String(r[BLOQUE.NOTAS_AIR - 1]).trim(); }).filter(String);
  cfg.listas = {};
  for (var j = BLOQUE.LISTAS - 1; j < enc.length; j++) {
    var key = CLAVES_LISTAS[String(enc[j]).trim()]; if (!key) continue;
    cfg.listas[key] = d.map(function (r) { return String(r[j]).trim(); }).filter(String);
  }
  _AJ = cfg;
  return cfg;
}

function registrar(quien, accion, detalle) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(HOJA.AJUSTES);
  if (!sh) return;
  var ultima = sh.getLastRow(), fila = FILA_DATOS;
  if (ultima >= FILA_DATOS) {
    var col = sh.getRange(FILA_DATOS, BLOQUE.REGISTRO, ultima - FILA_DATOS + 1, 1).getValues();
    for (var i = col.length - 1; i >= 0; i--) { if (String(col[i][0]).trim() !== '') { fila = FILA_DATOS + i + 1; break; } }
  }
  sh.getRange(fila, BLOQUE.REGISTRO, 1, 4).setValues([[new Date(), quien, accion, detalle || '']]);
}

/* ------------------------------------------------------------------ */
/* Links personales                                                    */
/* ------------------------------------------------------------------ */
function generarLinks() {
  var ui = SpreadsheetApp.getUi(), url = ScriptApp.getService().getUrl();
  if (!url) { ui.alert('Primero implementá el formulario como aplicación web (Implementar > Nueva implementación). Después volvé a usar esta opción.'); return; }
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(HOJA.AJUSTES), cfg = leerAjustes(), nuevos = 0;
  cfg.agentes.forEach(function (a) {
    var clave = a.clave;
    if (!clave) { clave = Utilities.getUuid().replace(/-/g, '').slice(0, 16); sh.getRange(a.fila, BLOQUE.AGENTES + 4).setValue(clave); nuevos++; }
    sh.getRange(a.fila, BLOQUE.AGENTES + 5).setValue(url + '?k=' + clave);
  });
  _AJ = null;
  registrar('BIDCOM', 'Generó links', nuevos + ' clave(s) nueva(s)');
  ui.alert('Listo. Cada agente tiene su link en la columna "Link personal" de "' + HOJA.AJUSTES + '".\n\nMandale a cada uno SOLO su link. Para dar de baja a un agente, poné NO en Activo.');
}
function linkDe(a) { return a.link || (ScriptApp.getService().getUrl() + '?k=' + a.clave); }
function irACotizaciones() { var ss = SpreadsheetApp.getActiveSpreadsheet(), c = ss.getSheetByName(HOJA.COTIZ); if (c) ss.setActiveSheet(c); }

/* ------------------------------------------------------------------ */
/* Formulario web del agente                                           */
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
  t.datos = JSON.stringify(datosParaAgente(agente)).replace(/</g, '\\u003c');
  return t.evaluate().setTitle('Tarifas BIDCOM').addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function buscarAgente(clave) {
  if (!clave || clave.length < 8) return null;
  return leerAjustes().agentes.filter(function (a) { return a.clave === clave && a.activo; })[0] || null;
}
function agentesPorNombre() { var m = {}; leerAjustes().agentes.forEach(function (a) { m[a.nombre] = a; }); return m; }

function hojaCotiz() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(HOJA.COTIZ);
  if (!sh) throw new Error('Falta preparar las hojas: menú Tarifador BIDCOM > 1. Preparar hojas.');
  return sh;
}
function valoresCotiz(sh) {
  var ultima = sh.getLastRow();
  return ultima < 2 ? [] : sh.getRange(2, 1, ultima - 1, CZ.length).getValues();
}
function leerDetalle(v) { try { return JSON.parse(v); } catch (e) { return {}; } }

// Lo único que recibe el navegador del agente: SUS envíos y SUS pedidos de mejora.
// Nunca: otros agentes, la menor de la ronda, la mediana ni el target sugerido.
function datosParaAgente(agente) {
  var cfg = leerAjustes(), datos = valoresCotiz(hojaCotiz()), porModo = {}, pedidos = [];
  porModo[MODO.MAR] = {}; porModo[MODO.AIR] = {};
  datos.forEach(function (x) {
    if (x[K.ffww] !== agente.nombre || !x[K.id] || !porModo[x[K.modo]]) return;
    var m = x[K.modo], e = porModo[m][x[K.id]];
    if (!e) e = porModo[m][x[K.id]] = { id: x[K.id], ts: x[K.recibido] instanceof Date ? x[K.recibido].getTime() : 0, recibido: fechaHora(x[K.recibido]), desde: fecha(x[K.desde]), hasta: fecha(x[K.hasta]),
      version: x[K.version], tipo: TIPOS.INICIAL, motivo: x[K.motivo], ultima: x[K.vigente] === 'SI', estados: [], rutas: {}, orden: [] };
    if (x[K.tipo] === TIPOS.NEGOCIADA) e.tipo = TIPOS.NEGOCIADA;
    e.estados.push(x[K.estado]);
    var det = leerDetalle(x[K.detalle]), clave = m === MODO.MAR ? det.ruta : x[K.origen];
    if (clave && !e.rutas[clave]) { e.rutas[clave] = m === MODO.MAR ? det.r : { r: det.r, g: det.g }; e.orden.push(clave); }
    if (x[K.vigente] === 'SI' && x[K.estado] === ESTADOS.PEDIDA) {
      pedidos.push({ modo: m === MODO.MAR ? 'mar' : 'air', desde: fecha(x[K.desde]), hasta: fecha(x[K.hasta]), origen: x[K.origen], destino: x[K.destino], carrier: x[K.carrier], ctnr: x[K.ctnr],
        actual: num(x[K.total]), objetivo: cfg.mostrarTarget && num(x[K.targetPedir]) > 0 ? num(x[K.targetPedir]) : '', mensaje: String(x[K.mensaje] || '') });
    }
  });
  function armar(m) {
    var lista = Object.keys(porModo[m]).map(function (k) { return porModo[m][k]; }).sort(function (a, b) { return b.ts - a.ts; });
    var ultimos = {};
    lista.forEach(function (e) {
      if (ultimos[e.desde] || Object.keys(ultimos).length >= 12) return;
      var rutas = e.orden.map(function (k) { return e.rutas[k]; }).filter(Boolean);
      ultimos[e.desde] = m === MODO.MAR ? { desde: e.desde, hasta: e.hasta, version: e.version, tipo: e.tipo, rutas: rutas }
        : { desde: e.desde, hasta: e.hasta, version: e.version, tipo: e.tipo, rutas: rutas.map(function (x) { return x.r; }),
            gastos: rutas.reduce(function (o, x) { if (x.r) o[x.r.origen] = x.g || []; return o; }, {}) };
    });
    return { ultimos: ultimos, envios: lista.slice(0, 40).map(function (e) {
      return { desde: e.desde, hasta: e.hasta, version: e.version, recibido: e.recibido, tipo: e.tipo, motivo: e.motivo, rutas: e.orden.length, estado: estadoParaAgente(e) }; }) };
  }
  var mar = armar(MODO.MAR), air = armar(MODO.AIR);
  return { agente: agente.nombre, hoy: fecha(new Date()), pedidos: pedidos,
    mar: { localesAceptado: cfg.locales, listas: cfg.listas, contenedores: CONTENEDORES, ultimos: mar.ultimos, envios: mar.envios },
    air: { rutas: cfg.rutasAir, notas: cfg.notasAir, peso: cfg.peso, breaks: BREAKS, conceptos: CONCEPTOS, unidades: UNIDADES, ultimos: air.ultimos, envios: air.envios } };
}
function estadoParaAgente(e) {
  if (!e.ultima) return 'Reemplazada por una versión nueva';
  if (e.estados.indexOf(ESTADOS.PEDIDA) >= 0) return 'Te pedimos una mejora';
  if (e.estados.length && e.estados.every(function (s) { return s === ESTADOS.APROBADA; })) return 'Aprobada';
  return 'Recibida, en revisión';
}

/* ------------------------------------------------------------------ */
/* Recepción de un envío (marítimo o aéreo)                            */
/* ------------------------------------------------------------------ */
function enviarMaritimo(clave, envio) { return recibirEnvio(clave, MODO.MAR, envio); }
function enviarTarifario(clave, envio) { return recibirEnvio(clave, MODO.AIR, envio); }

function recibirEnvio(clave, modo, envio) {
  var agente = buscarAgente(clave);                 // la identidad sale de la clave, nunca del navegador
  if (!agente) throw new Error('Tu link ya no es válido. Pedile a BIDCOM uno nuevo.');
  var cfg = leerAjustes();
  var errores = validarVigencia(envio).concat(modo === MODO.MAR ? validarEnvioMar(envio, cfg.listas) : validarEnvioAir(envio, cfg));
  if (errores.length) return { ok: false, errores: errores };

  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var sh = hojaCotiz(), datos = valoresCotiz(sh), ids = {}, previas = [];
    datos.forEach(function (r, i) {
      if (r[K.ffww] === agente.nombre && r[K.modo] === modo && fecha(r[K.desde]) === envio.desde) { ids[r[K.id]] = true; if (r[K.vigente] === 'SI') previas.push(i); }
    });
    var version = Object.keys(ids).length + 1;
    var motivo = version === 1 ? 'primero' : envio.motivo;
    if (version > 1 && motivo !== 'correccion' && motivo !== 'negociada') return { ok: false, errores: ['Ya enviaste tarifas para esta vigencia. Indicá si este envío corrige un error o es una tarifa mejorada.'] };

    var previo = {};
    previas.forEach(function (i) { var r = datos[i]; previo[claveLinea(r[K.origen], r[K.destino], r[K.carrier], r[K.ctnr])] = { tipo: r[K.tipo] || TIPOS.INICIAL, estado: r[K.estado], total: num(r[K.total]), flete: num(r[K.flete]) }; });

    var lineas = modo === MODO.MAR ? lineasMar(envio) : lineasAir(envio, cfg.peso);
    lineas.forEach(function (l) {
      var p = previo[claveLinea(l.origen, l.destino, l.carrier, l.ctnr)];
      l.correccion = false;
      if (motivo === 'primero' || !p) { l.tipo = TIPOS.INICIAL; l.motivo = motivo === 'primero' ? MOTIVOS.primero : MOTIVOS.nueva; l.pegar = true; l.estado = ESTADOS.REVISAR; return; }
      if (motivo === 'correccion') { l.tipo = p.tipo; l.motivo = MOTIVOS.correccion; l.pegar = true; l.correccion = true; l.estado = p.tipo === TIPOS.NEGOCIADA ? ESTADOS.RESPUESTA : ESTADOS.REVISAR; return; }
      var pedida = p.estado === ESTADOS.PEDIDA, cambio = Math.abs((l.total || 0) - (p.total || 0)) > 1e-6 || Math.abs((l.flete || 0) - (p.flete || 0)) > 1e-6;
      l.antes = p.total;
      if (pedida || cambio) { l.tipo = TIPOS.NEGOCIADA; l.motivo = MOTIVOS.negociada + (cambio ? '' : ' (sin cambios)'); l.pegar = true; l.estado = ESTADOS.RESPUESTA; }
      else { l.tipo = p.tipo; l.motivo = MOTIVOS.sinCambios; l.pegar = false; l.estado = p.estado; }
    });

    // Las filas del envío anterior dejan de ser la última versión (quedan guardadas)
    var ahora = new Date(), id = (modo === MODO.MAR ? 'M' : 'A') + Utilities.getUuid().replace(/-/g, '').slice(0, 7).toUpperCase();
    previas.forEach(function (i) {
      var r = datos[i], est = r[K.estado] === ESTADOS.PEDIDA ? ESTADOS.RESPONDIDA : ESTADOS.REEMPLAZADA;
      sh.getRange(i + 2, K.vigente + 1).setValue('NO'); sh.getRange(i + 2, K.estado + 1).setValue(est);
      r[K.vigente] = 'NO'; r[K.estado] = est;
      r[K.historial] = agregarHistorial(sh, i + 2, r[K.historial], (est === ESTADOS.RESPONDIDA ? 'Respondida' : 'Reemplazada') + ' por v' + version + ' (' + id + ')');
    });

    var desde = aFecha(envio.desde), hasta = aFecha(envio.hasta), stamp = fechaHora(ahora);
    var deArchivo = envio.archivo ? ' · cargada desde Excel "' + String(envio.archivo).replace(/[\r\n"]/g, ' ').slice(0, 80) + '"' : '';
    var filas = lineas.map(function (l) {
      var f = []; for (var c = 0; c < CZ.length; c++) f.push('');
      f[K.id] = id; f[K.recibido] = ahora; f[K.modo] = modo; f[K.ffww] = agente.nombre; f[K.contacto] = agente.contacto || ''; f[K.version] = version; f[K.vigente] = 'SI';
      f[K.tipo] = l.tipo; f[K.motivo] = l.motivo; f[K.desde] = desde; f[K.hasta] = hasta; f[K.origen] = l.origen; f[K.destino] = l.destino; f[K.carrier] = l.carrier; f[K.ctnr] = l.ctnr;
      f[K.flete] = l.flete; f[K.total] = l.total; f[K.locales] = l.locales; f[K.gorigen] = l.gorigen; f[K.estado] = l.estado;
      f[K.detalle] = JSON.stringify(modo === MODO.MAR ? { ruta: l.ruta, r: l.r } : { r: l.r, g: l.g });
      var alerta = modo === MODO.MAR && l.locales > cfg.locales ? ' · Locales ARG USD ' + l.locales + ' (aceptado ' + cfg.locales + ')' : '';
      f[K.historial] = stamp + ' · Recibida v' + version + ', ' + l.tipo.toLowerCase() + ' (' + l.motivo + ')' + deArchivo + alerta;
      return f;
    });
    var primera = sh.getLastRow() + 1;
    sh.getRange(primera, 1, filas.length, CZ.length).setValues(filas);
    datos = datos.concat(filas);
    var tipoEnvio = lineas.some(function (l) { return l.tipo === TIPOS.NEGOCIADA; }) ? TIPOS.NEGOCIADA : TIPOS.INICIAL;
    registrar(agente.nombre, 'Envió tarifas ' + modo.toLowerCase() + ' ' + fechaCorta(desde) + '–' + fechaCorta(hasta) + ' (v' + version + ', ' + MOTIVOS[motivo].toLowerCase() + ')',
      lineas.length + ' tarifa(s). ID ' + id + deArchivo);
    SpreadsheetApp.flush();

    try { datos = recalcular(cfg, sh, datos); } catch (e1) { registrar('Sistema', 'Error al recalcular la comparación', String(e1 && e1.message || e1)); }
    // Pegado en la base madre: si falla, el envío igual queda guardado y el error va al registro
    try { if (cfg.auto) pegarEnvioEnBase(cfg, modo, agente, lineas, desde, hasta, version, ahora); }
    catch (e2) { registrar('Sistema', 'Error al pegar en la base madre', String(e2 && e2.message || e2)); }
    try { avisarAlTeam(cfg, agente, modo, datos.slice(primera - 2), version, MOTIVOS[motivo], sh); }
    catch (e3) { registrar('Sistema', 'Error al avisar al team', String(e3 && e3.message || e3)); }
    return { ok: true, version: version, id: id, tipo: tipoEnvio, datos: datosParaAgente(agente) };
  } finally { lock.releaseLock(); }
}

function claveLinea(origen, destino, carrier, ctnr) { return [origen, destino, carrier, ctnr].map(claveTexto).join('|'); }
function agregarHistorial(sh, fila, actual, texto) {
  var v = (actual ? String(actual) + '\n' : '') + fechaHora(new Date()) + ' · ' + texto;
  sh.getRange(fila, K.historial + 1).setValue(v);
  return v;
}

function validarVigencia(envio) {
  if (!envio || !envio.desde || !envio.hasta) return ['Falta la vigencia (desde y hasta).'];
  var d = aFecha(envio.desde), h = aFecha(envio.hasta);
  if (!(d instanceof Date) || !(h instanceof Date) || isNaN(d) || isNaN(h)) return ['La vigencia no es una fecha válida.'];
  if (h < d) return ['La vigencia "hasta" es anterior a "desde".'];
  if ((h - d) / 86400000 > 92) return ['La vigencia no puede superar los 3 meses.'];
  return [];
}

function validarEnvioMar(envio, listas) {
  var err = [];
  if (!envio || !envio.rutas || !envio.rutas.length) return ['No hay rutas cargadas.'];
  envio.rutas.forEach(function (r, i) {
    var p = 'Ruta ' + (i + 1) + (r.pol ? ' (' + r.pol + ')' : '') + ': ';
    if (!String(r.pol || '').trim()) err.push(p + 'falta el POL.');
    if (!String(r.pod || '').trim()) err.push(p + 'falta el POD.');
    if (!String(r.naviera || '').trim()) err.push(p + 'falta la naviera.');
    if (!String(r.servicio || '').trim()) err.push(p + 'falta el tipo de servicio (Regular o Spot).');
    if (!r.directo && !String(r.transbordo || '').trim()) err.push(p + 'falta el puerto de transbordo.');
    if (!(num(r.tt) > 0)) err.push(p + 'falta el transit time.');
    if (['COLLECT', 'PREPAID'].indexOf(r.pagadero) < 0) err.push(p + 'falta pagadero.');
    var conts = CONTENEDORES.filter(function (c) { return r.contenedores && r.contenedores[c] && num(r.contenedores[c].flete) > 0; });
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

function validarEnvioAir(envio, cfg) {
  var err = [];
  if (!envio || !envio.rutas || !envio.rutas.length) return ['No hay rutas cargadas.'];
  var permitidas = cfg.rutasAir.map(function (r) { return r.origen; });
  envio.rutas.forEach(function (r) {
    var p = r.origen + ': ';
    if (permitidas.indexOf(r.origen) < 0) err.push(p + 'esta ruta no está en la lista de BIDCOM.');
    if (!String(r.aerolinea || '').trim()) err.push(p + 'falta la aerolínea.');
    if (!(num(r.transito) > 0)) err.push(p + 'falta el tránsito en días.');
    if (!(num(r.minimo) > 0)) err.push(p + 'falta el mínimo.');
    [100, 300, 500, 1000].forEach(function (b) { if (!(num((r.tarifas || {})[b]) > 0)) err.push(p + 'falta la tarifa de ' + b + ' kg.'); });
    if (r.fuel === '' || r.fuel === null || isNaN(num(r.fuel))) err.push(p + 'falta el fuel (USD/kg).');
    if (!r.imoPedido && (r.imo === '' || r.imo === null || isNaN(num(r.imo)))) err.push(p + 'falta el IMO (o marcalo a pedido).');
    if (r.destino_usd === '' || r.destino_usd === null || isNaN(num(r.destino_usd))) err.push(p + 'faltan los gastos de destino.');
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

// Gastos en origen llevados a 1 contenedor (BL, embarque y contenedor completos; CBM y toneladas con un volumen estándar)
var CBM_STD = { '20ST': 28, '40ST': 58, '40HQ': 68, '40NOR': 58 }, TON_STD = { '20ST': 10, '40ST': 12, '40HQ': 12, '40NOR': 12 };
function gastosPorContenedor(gastos, c) {
  return Math.round((gastos || []).reduce(function (s, g) {
    var a = num(g.importe); if (g.importe === '' || isNaN(a)) return s;
    return s + (g.unidad === 'Por CBM' ? a * (CBM_STD[c] || 0) : g.unidad === 'Por tonelada' ? a * (TON_STD[c] || 0) : a);
  }, 0) * 100) / 100;
}

function lineasMar(envio) {
  var out = [];
  envio.rutas.forEach(function (r, k) {
    var gastos = (r.gastos || []).filter(function (c) { return c.importe !== '' && c.importe !== null && c.importe !== undefined; })
      .map(function (c) { return { concepto: c.concepto, importe: num(c.importe), unidad: c.unidad, descripcion: c.descripcion || '' }; });
    var rr = JSON.parse(JSON.stringify(r)); rr.gastos = gastos;
    var recargos = (num(r.imo) || 0) + (num(r.fuel) || 0) + (num(r.puertos) || 0);
    CONTENEDORES.forEach(function (c) {
      var x = (r.contenedores || {})[c]; if (!x || !(num(x.flete) > 0)) return;
      out.push({ ruta: 'R' + (k + 1), r: rr, origen: r.pol, destino: r.pod, carrier: r.naviera, ctnr: c, flete: num(x.flete), dias: num(x.dias),
        total: Math.round((num(x.flete) + recargos) * 100) / 100, locales: num(r.localesArg), gorigen: gastosPorContenedor(gastos, c) });
    });
  });
  return out;
}
function lineasAir(envio, W) {
  return envio.rutas.map(function (r) {
    var g = ((envio.gastos || {})[r.origen] || []).filter(function (c) { return c.pedido || (c.importe !== '' && c.importe !== null && c.importe !== undefined); });
    var f = { minimo: num(r.minimo), tarifas: r.tarifas, fuel: num(r.fuel), imo: r.imoPedido ? '' : num(r.imo), imoPedido: !!r.imoPedido, destino_usd: num(r.destino_usd),
      gastos: g.map(function (c) { return { importe: num(c.importe), unidad: c.unidad, minimo: num(c.minimo), pedido: !!c.pedido }; }) };
    var calc = calcularAllIn(f, W), rate = tarifaAlPeso(r.tarifas || {}, W);
    return { r: r, g: g, origen: r.origen, destino: r.destino, carrier: r.aerolinea, ctnr: '', flete: isNaN(rate) ? '' : rate, total: calc.allin, locales: num(r.destino_usd), gorigen: calc.origen };
  });
}

/* ------------------------------------------------------------------ */
/* Comparación: la menor de la ronda, mediana histórica y target        */
/* Regla: a quien cotizó la menor se le pide −15% (configurable);       */
/* al resto, igualar la menor. La mediana es el control del semáforo.   */
/* ------------------------------------------------------------------ */
function recalcular(cfg, sh, datos) {
  cfg = cfg || leerAjustes(); sh = sh || hojaCotiz(); datos = datos || valoresCotiz(sh);
  if (!datos.length) return datos;
  var red = cfg.reduccion, hist = null, vig = [];
  datos.forEach(function (x, i) { if (x[K.vigente] === 'SI' && x[K.id] && num(x[K.total]) > 0) vig.push(i); });
  var bloque = datos.map(function (x) { return [x[K.menor], x[K.vsMenor], x[K.mediana], x[K.target], x[K.semaforo]]; });
  var ahorros = datos.map(function (x) { return [x[K.ahorro], x[K.ahorroPct]]; });
  vig.forEach(function (i) {
    var x = datos[i], tot = num(x[K.total]), d0 = aDia(x[K.desde]), h0 = aDia(x[K.hasta]), mar = x[K.modo] === MODO.MAR;
    var ronda = vig.filter(function (j) {
      var y = datos[j];
      return y[K.modo] === x[K.modo] && claveTexto(y[K.origen]) === claveTexto(x[K.origen]) && claveTexto(y[K.destino]) === claveTexto(x[K.destino]) &&
        (!mar || claveTexto(y[K.ctnr]) === claveTexto(x[K.ctnr])) && aDia(y[K.desde]) <= h0 && aDia(y[K.hasta]) >= d0;
    }).map(function (j) { return num(datos[j][K.total]); });
    var L = Math.min.apply(null, ronda), esMenor = tot <= L + 1e-9;
    var target = redondear(esMenor ? L * (1 - red) : L, mar);
    var med = '';
    if (mar) { if (hist === null) hist = historicoMar(cfg); med = medianaMar(hist, x); }
    else med = medianaAir(datos, vig, x);
    var sem = med ? semaforo(tot, med * (1 - red)) : 'Sin histórico';
    bloque[i] = [esMenor ? (ronda.length > 1 ? 'SI' : 'SI (única)') : '', esMenor ? 0 : Math.round((tot / L - 1) * 10000) / 10000, med === '' ? '' : redondear(med, mar), target, sem];
  });
  // Ahorro de cada tarifa negociada contra la inicial del mismo agente, vigencia y línea
  datos.forEach(function (x, i) {
    if (x[K.tipo] !== TIPOS.NEGOCIADA || !x[K.id]) return;
    var ini = null, k = claveLinea(x[K.origen], x[K.destino], x[K.carrier], x[K.ctnr]);
    for (var j = 0; j < datos.length; j++) {
      var y = datos[j];
      if (y[K.tipo] === TIPOS.INICIAL && y[K.ffww] === x[K.ffww] && y[K.modo] === x[K.modo] && fecha(y[K.desde]) === fecha(x[K.desde]) &&
          claveLinea(y[K.origen], y[K.destino], y[K.carrier], y[K.ctnr]) === k) ini = y;
    }
    if (!ini || !(num(ini[K.total]) > 0)) return;
    var a = num(ini[K.total]) - num(x[K.total]);
    ahorros[i] = [redondear(a, x[K.modo] === MODO.MAR), Math.round(a / num(ini[K.total]) * 10000) / 10000];
  });
  sh.getRange(2, K.menor + 1, datos.length, 5).setValues(bloque);
  sh.getRange(2, K.ahorro + 1, datos.length, 2).setValues(ahorros);
  datos.forEach(function (x, i) { for (var c = 0; c < 5; c++) x[K.menor + c] = bloque[i][c]; x[K.ahorro] = ahorros[i][0]; x[K.ahorroPct] = ahorros[i][1]; });
  return datos;
}
function recalcularMenu() { recalcular(); SpreadsheetApp.getUi().alert('Listo. Se recalculó la comparación de todas las tarifas vigentes.'); }
function redondear(v, mar) { return mar ? Math.round(v) : Math.round(v * 100) / 100; }
function semaforo(valor, objetivo) {
  var r = valor / objetivo;
  return r <= 1 ? 'Verde' : r <= 1.05 ? 'Amarillo' : r <= 1.15 ? 'Naranja' : 'Rojo';
}
function mediana(xs) {
  if (!xs.length) return '';
  var s = xs.slice().sort(function (a, b) { return a - b; }), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
// Histórico marítimo: últimas 4.000 filas de "SIN NEGOCIAR" (flete + recargos por contenedor)
function historicoMar(cfg) {
  try {
    var hoja = abrirDestino({ url: cfg.baseUrl }, cfg.marIni), enc = mapearEncabezados(hoja, MAPA_MARITIMO);
    if (!enc || !enc.mapa.flete || !enc.mapa.pol || !enc.mapa.desde) return [];
    var M = enc.mapa, ultima = hoja.getLastRow(), inicio = Math.max(enc.fila + 1, ultima - 3999);
    if (ultima < inicio) return [];
    return hoja.getRange(inicio, 1, ultima - inicio + 1, hoja.getLastColumn()).getValues().map(function (r) {
      var v = function (c) { return M[c] ? r[M[c] - 1] : ''; }, flete = num(v('flete'));
      if (!(flete > 0) || !(v('desde') instanceof Date)) return null;
      return { pol: claveTexto(v('pol')), pod: claveTexto(v('pod')), ctnrs: String(v('ctnr')).split('/').map(claveTexto), desde: aDia(v('desde')),
        valor: flete + (num(v('imo')) || 0) + (num(v('fuel')) || 0) + (num(v('puertos')) || 0) };
    }).filter(Boolean);
  } catch (e) { return []; }
}
function medianaMar(hist, x) {
  var d0 = aDia(x[K.desde]), min = d0 - 180 * 86400000, pol = claveTexto(x[K.origen]), pod = claveTexto(x[K.destino]), c = claveTexto(x[K.ctnr]);
  return mediana(hist.filter(function (h) { return h.pol === pol && (!h.pod || h.pod === pod) && h.ctnrs.indexOf(c) >= 0 && h.desde < d0 && h.desde >= min; })
    .map(function (h) { return h.valor; }));
}
function medianaAir(datos, vig, x) {
  var d0 = aDia(x[K.desde]), min = d0 - 84 * 86400000;
  return mediana(vig.map(function (j) { return datos[j]; }).filter(function (y) {
    return y[K.modo] === MODO.AIR && claveTexto(y[K.origen]) === claveTexto(x[K.origen]) && claveTexto(y[K.destino]) === claveTexto(x[K.destino]) &&
      aDia(y[K.hasta]) < d0 && aDia(y[K.desde]) >= min;
  }).map(function (y) { return num(y[K.total]); }));
}

/* ------------------------------------------------------------------ */
/* Mails                                                               */
/* ------------------------------------------------------------------ */
function mandarMail(opciones) {
  MailApp.sendEmail({ to: opciones.to, cc: opciones.cc || '', replyTo: opciones.replyTo || '', name: 'BIDCOM Tarifas', subject: opciones.subject, htmlBody: opciones.html });
}
function htmlTabla(encabezados, filas) {
  return '<table style="border-collapse:collapse;font:13px Arial,sans-serif;margin:8px 0">' +
    '<tr>' + encabezados.map(function (h) { return '<th style="text-align:left;background:#0B5F8A;color:#fff;padding:6px 8px">' + esc(h) + '</th>'; }).join('') + '</tr>' +
    filas.map(function (f) { return '<tr>' + f.map(function (c) { return '<td style="border-bottom:1px solid #ddd;padding:6px 8px">' + (c && c.html ? c.html : esc(c)) + '</td>'; }).join('') + '</tr>'; }).join('') + '</table>';
}
function htmlBoton(url, texto) {
  return '<p style="margin:18px 0"><a href="' + esc(url) + '" style="background:#0B5F8A;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:bold;font-family:Arial,sans-serif">' + esc(texto) + '</a></p>';
}
function htmlEnvolver(cuerpo) { return '<div style="font:14px/1.5 Arial,sans-serif;color:#15212e;max-width:720px">' + cuerpo + '</div>'; }
function valorTxt(v, mar) { var n = num(v); return n === '' || isNaN(n) ? '—' : 'USD ' + (mar ? Math.round(n).toLocaleString('es-AR') : n.toFixed(2)) + (mar ? '' : '/kg'); }
function pctTxt(v) { var n = num(v); return n === '' || isNaN(n) ? '—' : (n > 0 ? '+' : '') + (n * 100).toFixed(1) + '%'; }
var COLOR_SEM = { Verde: '#D9EAD3', Amarillo: '#FFF2CC', Naranja: '#FCE5CD', Rojo: '#F4CCCC' };

// Aviso al team: cada vez que un agente carga o responde
function avisarAlTeam(cfg, agente, modo, filas, version, motivo, sh) {
  if (!cfg.teamMails.length) { registrar('Sistema', 'No se avisó al team', 'Completá "Mails del team" en ' + HOJA.AJUSTES + '.'); return; }
  var mar = modo === MODO.MAR, neg = filas.some(function (f) { return f[K.tipo] === TIPOS.NEGOCIADA && f[K.motivo] !== MOTIVOS.sinCambios; });
  var url = SpreadsheetApp.getActiveSpreadsheet().getUrl() + '#gid=' + sh.getSheetId();
  var enc = ['Ruta', mar ? 'Naviera' : 'Aerolínea'].concat(mar ? ['Contenedor'] : []).concat([mar ? 'Total USD/ctnr' : 'All-in USD/kg', 'Menor de la ronda', 'Vs la menor', 'Vs histórico', 'Target sugerido']).concat(neg ? ['Ahorro vs inicial'] : []);
  var tabla = filas.map(function (f) {
    var sem = f[K.semaforo];
    return [f[K.origen] + ' → ' + f[K.destino], f[K.carrier]].concat(mar ? [f[K.ctnr]] : [])
      .concat([valorTxt(f[K.total], mar), f[K.menor] || '—', f[K.menor] ? '—' : pctTxt(f[K.vsMenor]),
        { html: '<span style="background:' + (COLOR_SEM[sem] || 'transparent') + ';padding:2px 6px;border-radius:4px">' + esc(sem || '—') + '</span>' }, valorTxt(f[K.target], mar)])
      .concat(neg ? [f[K.ahorro] === '' ? '—' : valorTxt(f[K.ahorro], mar) + ' (' + pctTxt(f[K.ahorroPct]) + ')'] : []);
  });
  var altos = mar ? filas.filter(function (f) { return num(f[K.locales]) > cfg.locales; }) : [];
  var titulo = neg ? agente.nombre + ' respondió con tarifas mejoradas' : motivo === MOTIVOS.correccion ? agente.nombre + ' corrigió su envío' : agente.nombre + ' cargó tarifas';
  var html = htmlEnvolver('<h2 style="margin:0 0 6px">' + esc(titulo) + '</h2>' +
    '<p>' + esc(modo) + ' · vigencia ' + esc(fechaCorta(filas[0][K.desde])) + ' al ' + esc(fechaCorta(filas[0][K.hasta])) + ' · versión ' + version + ' (' + esc(motivo.toLowerCase()) + ').</p>' +
    htmlTabla(enc, tabla) +
    (altos.length ? '<p style="color:#9a6b00"><b>Locales ARG por encima de lo aceptado (USD ' + cfg.locales + '):</b> ' + altos.map(function (f) { return esc(f[K.origen] + ' ' + f[K.ctnr] + ' USD ' + f[K.locales]); }).join(', ') + '</p>' : '') +
    '<p><b>Qué hacer:</b> en la pestaña <b>' + esc(HOJA.COTIZ) + '</b> elegí en "Decisión del team" <i>Aprobar</i>, <i>Pedir mejora</i> o <i>Descartar</i> y después usá el menú <b>Tarifador BIDCOM &gt; Enviar decisiones del team</b>. Al agente no le llega nada hasta ese paso.</p>' +
    htmlBoton(url, 'Abrir las cotizaciones'));
  mandarMail({ to: cfg.teamMails.join(','), subject: '[Tarifador] ' + titulo + ' · ' + modo + ' · ' + fechaCorta(filas[0][K.desde]) + '–' + fechaCorta(filas[0][K.hasta]), html: html });
  registrar('Sistema', 'Avisó al team', titulo + ' (' + filas.length + ' tarifa(s))');
}

/* ------------------------------------------------------------------ */
/* Decisiones del team: Aprobar / Pedir mejora / Descartar              */
/* ------------------------------------------------------------------ */
function enviarDecisiones() {
  var ui = SpreadsheetApp.getUi(), cfg = leerAjustes(), sh = hojaCotiz(), datos = valoresCotiz(sh), pend = [], cuenta = { Aprobar: 0, 'Pedir mejora': 0, Descartar: 0 }, agentesMejora = {};
  datos.forEach(function (x, i) {
    var d = DECISIONES.filter(function (k) { return claveTexto(k) === claveTexto(x[K.decision]); })[0];
    if (!d || x[K.enviada] || x[K.vigente] !== 'SI') return;
    pend.push({ i: i, d: d }); cuenta[d]++;
    if (d === 'Pedir mejora') agentesMejora[x[K.ffww]] = true;
  });
  if (!pend.length) { ui.alert('No hay decisiones nuevas.\n\nEn "' + HOJA.COTIZ + '" elegí Aprobar, Pedir mejora o Descartar en la columna "Decisión del team" de las filas que quieras resolver.'); return; }
  var nAg = Object.keys(agentesMejora).length;
  if (!confirmar('Vas a registrar:\n• ' + cuenta.Aprobar + ' aprobada(s)\n• ' + cuenta['Pedir mejora'] + ' pedido(s) de mejora' + (nAg ? ' (se manda un mail a ' + nAg + ' agente(s))' : '') + '\n• ' + cuenta.Descartar + ' descartada(s)\n\n¿Seguimos?')) return;
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  var porAgente = {}, ahora = new Date();
  try {
    pend.forEach(function (p) {
      var x = datos[p.i], fila = p.i + 2, est = p.d === 'Aprobar' ? ESTADOS.APROBADA : p.d === 'Pedir mejora' ? ESTADOS.PEDIDA : ESTADOS.DESCARTADA, txt = 'Team: ' + p.d.toLowerCase();
      if (p.d === 'Pedir mejora') {
        if (!(num(x[K.targetPedir]) > 0) && num(x[K.target]) > 0) { x[K.targetPedir] = x[K.target]; sh.getRange(fila, K.targetPedir + 1).setValue(x[K.target]); }
        txt += num(x[K.targetPedir]) > 0 ? ' (objetivo ' + valorTxt(x[K.targetPedir], x[K.modo] === MODO.MAR) + ')' : '';
        (porAgente[x[K.ffww]] = porAgente[x[K.ffww]] || []).push(x);
      }
      sh.getRange(fila, K.estado + 1).setValue(est); sh.getRange(fila, K.enviada + 1).setValue(ahora);
      x[K.estado] = est; x[K.enviada] = ahora;
      x[K.historial] = agregarHistorial(sh, fila, x[K.historial], txt + (x[K.mensaje] ? ' · "' + x[K.mensaje] + '"' : ''));
    });
  } finally { lock.releaseLock(); }
  var ag = agentesPorNombre(), sinMail = [], enviados = 0;
  Object.keys(porAgente).forEach(function (nombre) {
    var a = ag[nombre];
    if (!a || !a.email) { sinMail.push(nombre); return; }
    mailPedidoMejora(cfg, a, porAgente[nombre]); enviados++;
  });
  registrar('BIDCOM', 'Envió decisiones', cuenta.Aprobar + ' aprobada(s), ' + cuenta['Pedir mejora'] + ' pedido(s) de mejora, ' + cuenta.Descartar + ' descartada(s). Mails: ' + enviados);
  ui.alert('Listo. ' + (enviados ? 'Se mandó el pedido de mejora a ' + enviados + ' agente(s). ' : '') +
    (sinMail.length ? '\n\nSin email cargado (mandales el pedido a mano o completá su email): ' + sinMail.join(', ') + '. Igual van a ver el pedido al entrar con su link.' : ''));
}

function mailPedidoMejora(cfg, agente, filas) {
  var porModo = {};
  filas.forEach(function (f) { (porModo[f[K.modo]] = porModo[f[K.modo]] || []).push(f); });
  var cuerpo = '<p>Hola ' + esc(agente.contacto || agente.nombre) + ':</p><p>Gracias por tu cotización. La revisamos y te pedimos mejorar las siguientes tarifas.</p>';
  Object.keys(porModo).forEach(function (m) {
    var mar = m === MODO.MAR, fs = porModo[m];
    var enc = ['Ruta', mar ? 'Naviera' : 'Aerolínea'].concat(mar ? ['Contenedor'] : []).concat(['Vigencia', 'Tu valor actual']).concat(cfg.mostrarTarget ? ['Valor objetivo'] : []).concat(['Comentario']);
    cuerpo += '<h3 style="margin:16px 0 0">' + esc(m) + '</h3>' + htmlTabla(enc, fs.map(function (f) {
      return [f[K.origen] + ' → ' + f[K.destino], f[K.carrier]].concat(mar ? [f[K.ctnr]] : [])
        .concat([fechaCorta(f[K.desde]) + ' al ' + fechaCorta(f[K.hasta]), valorTxt(f[K.total], mar)])
        .concat(cfg.mostrarTarget ? [valorTxt(f[K.targetPedir], mar)] : []).concat([f[K.mensaje] || '']);
    })) + '<p style="font-size:12px;color:#5b6876">' + (mar ? 'Valor por contenedor = flete + Recarga IMO + Fuel adjust + Adicional puertos internos.' : 'All-in USD/kg a ' + cfg.peso + ' kg = flete + fuel + IMO + gastos en origen + gastos de destino.') + '</p>';
  });
  cuerpo += '<p>Cargá la tarifa mejorada desde tu link personal (el de siempre). Tu cotización aparece precargada: cambiá lo que mejores y enviá.</p>' + htmlBoton(linkDe(agente), 'Cargar tarifa mejorada');
  mandarMail({ to: agente.email, replyTo: cfg.teamMails[0] || '', subject: 'BIDCOM · Pedido de mejora de tarifas', html: htmlEnvolver(cuerpo) });
}

/* ------------------------------------------------------------------ */
/* Aviso de vencimiento: N días antes, al agente y con copia al team    */
/* ------------------------------------------------------------------ */
function activarAvisos() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'avisarVencimientos') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('avisarVencimientos').timeBased().everyDays(1).atHour(8).create();
  var cfg = leerAjustes();
  registrar('BIDCOM', 'Activó el aviso diario de vencimientos', cfg.diasAviso + ' días antes');
  SpreadsheetApp.getUi().alert('Listo. Todos los días a las 8 se revisan las vigencias. A los agentes cuya tarifa vence en ' + cfg.diasAviso +
    ' días o menos (y no cargaron una nueva) les llega un mail con su link' + (cfg.teamMails.length ? ', con copia a ' + cfg.teamMails.join(', ') : '') + '.');
}
function avisarVencimientosMenu() {
  var n = avisarVencimientos();
  SpreadsheetApp.getUi().alert(n ? 'Se mandaron ' + n + ' aviso(s) de vencimiento.' : 'No hay tarifas por vencer que necesiten aviso.');
}
function avisarVencimientos() {
  var cfg = leerAjustes(), sh = hojaCotiz(), datos = valoresCotiz(sh), hoy = aDia(new Date()), grupos = {}, ag = agentesPorNombre(), enviados = 0;
  datos.forEach(function (x, i) {
    if (x[K.vigente] !== 'SI' || !x[K.id] || !(x[K.hasta] instanceof Date)) return;
    var k = x[K.ffww] + '|' + x[K.modo], g = grupos[k] = grupos[k] || { ffww: x[K.ffww], modo: x[K.modo], max: 0, filas: [] };
    g.max = Math.max(g.max, aDia(x[K.hasta])); g.filas.push(i);
  });
  Object.keys(grupos).forEach(function (k) {
    var g = grupos[k], dias = Math.round((g.max - hoy) / 86400000);
    if (dias < 0 || dias > cfg.diasAviso) return;
    var filas = g.filas.filter(function (i) { return aDia(datos[i][K.hasta]) === g.max; });
    if (filas.some(function (i) { return datos[i][K.aviso]; })) return;           // ya se avisó esta vigencia
    var a = ag[g.ffww]; if (!a || !a.activo) return;
    var mar = g.modo === MODO.MAR, hasta = datos[filas[0]][K.hasta], rutas = {};
    filas.forEach(function (i) { var x = datos[i]; rutas[x[K.origen] + ' → ' + x[K.destino] + (x[K.carrier] ? ' (' + x[K.carrier] + ')' : '')] = true; });
    var html = htmlEnvolver('<p>Hola ' + esc(a.contacto || a.nombre) + ':</p><p>Tu tarifa <b>' + esc(g.modo.toLowerCase()) + '</b> para BIDCOM vence el <b>' + esc(fechaLarga(hasta)) + '</b>' +
      (dias === 0 ? ' (hoy)' : ' (faltan ' + dias + ' día' + (dias === 1 ? '' : 's') + ')') + '. Cargala para la próxima vigencia así seguimos cotizando con vos.</p>' +
      '<ul>' + Object.keys(rutas).map(function (r) { return '<li>' + esc(r) + '</li>'; }).join('') + '</ul>' +
      htmlBoton(linkDe(a), 'Cargar tarifa nueva') + '<p style="font-size:12px;color:#5b6876">Es tu link personal de siempre. Tu última cotización aparece precargada.</p>' +
      (a.email ? '' : '<p style="color:#b3261e"><b>Para el team:</b> este agente no tiene email cargado en ' + esc(HOJA.AJUSTES) + '. Reenviale este aviso.</p>'));
    var para = a.email || cfg.teamMails.join(',');
    if (!para) { registrar('Sistema', 'No se pudo avisar vencimiento', g.ffww + ': sin email del agente ni del team'); return; }
    mandarMail({ to: para, cc: a.email ? cfg.teamMails.join(',') : '', replyTo: cfg.teamMails[0] || '', subject: 'BIDCOM · Tu tarifa ' + (mar ? 'marítima' : 'aérea') + ' vence el ' + fechaCorta(hasta) + ': cargá la nueva', html: html });
    var marca = 'Avisado ' + fechaHora(new Date()) + (a.email ? '' : ' (al team, sin email del agente)');
    filas.forEach(function (i) { sh.getRange(i + 2, K.aviso + 1).setValue(marca); datos[i][K.aviso] = marca; });
    registrar('Sistema', 'Aviso de vencimiento', g.ffww + ' · ' + g.modo + ' · vence ' + fechaCorta(hasta));
    enviados++;
  });
  return enviados;
}

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */
function num(v) { if (v === '' || v === null || v === undefined) return ''; var n = Number(String(v).replace(',', '.')); return isNaN(n) ? NaN : n; }
function aFecha(s) { if (!s) return ''; if (s instanceof Date) return s; var p = String(s).split('-'); return p.length === 3 ? new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])) : s; }
function aDia(v) { var d = aFecha(v); return d instanceof Date ? new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() : NaN; }
function fecha(d) { return d instanceof Date ? Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd') : String(d || ''); }
function fechaHora(d) { return d instanceof Date ? Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm') : String(d || ''); }
function fechaCorta(d) { var s = fecha(aFecha(d)).split('-'); return s.length === 3 ? s[2] + '/' + s[1] : String(d || ''); }
function fechaLarga(d) { var s = fecha(aFecha(d)).split('-'); return s.length === 3 ? s[2] + '/' + s[1] + '/' + s[0] : String(d || ''); }
function esc(s) { return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function semanaISO(d) {
  var x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  var dia = (x.getUTCDay() + 6) % 7; x.setUTCDate(x.getUTCDate() - dia + 3);
  var primero = new Date(Date.UTC(x.getUTCFullYear(), 0, 4));
  var sem = 1 + Math.round(((x - primero) / 86400000 - 3 + ((primero.getUTCDay() + 6) % 7)) / 7);
  return 'WK-' + x.getUTCFullYear() + '-W' + (sem < 10 ? '0' : '') + sem;
}
function claveTexto(v) {
  return String(v === null || v === undefined ? '' : v).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9+]/g, '');
}

/* ================================================================== */
/* PEGADO EN LA BASE MADRE                                             */
/* Se completa cada columna según su encabezado, en la primera fila     */
/* vacía debajo del histórico. No se agregan ni mueven columnas, y las  */
/* columnas con fórmula se respetan (se copia la fórmula de arriba).    */
/* ================================================================== */
function abrirDestino(cfg, nombre) {
  if (!nombre) throw new Error('Falta el nombre de la pestaña de destino en ' + HOJA.AJUSTES + '.');
  var libro = cfg.url ? SpreadsheetApp.openByUrl(cfg.url) : SpreadsheetApp.getActiveSpreadsheet();
  var hoja = libro.getSheetByName(nombre);
  if (!hoja) throw new Error('No existe la pestaña "' + nombre + '" en la base madre. Revisá que el nombre sea exacto.');
  return hoja;
}
// Busca en las primeras 20 filas la que más encabezados reconocidos tiene
function mapearEncabezados(hoja, mapaDef) {
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
function copiarFormulasDeArriba(hoja, fila, arriba, ocupadas, propias) {
  arriba.forEach(function (fx, j) {
    if (fx && !ocupadas[j] && !propias[j]) { hoja.getRange(fila - 1, j + 1).copyTo(hoja.getRange(fila, j + 1), SpreadsheetApp.CopyPasteType.PASTE_FORMULA, false); propias[j] = fx; }
  });
}

function pegarEnvioEnBase(cfg, modo, agente, lineas, desde, hasta, version, ahora) {
  var aPegar = lineas.filter(function (l) { return l.pegar; });
  if (!aPegar.length) return;
  if (modo === MODO.MAR) {
    var porRuta = {}, filas = [];
    aPegar.forEach(function (l) { (porRuta[l.ruta] = porRuta[l.ruta] || []).push(l); });
    Object.keys(porRuta).forEach(function (k) {
      var ls = porRuta[k], a = ls.filter(function (l) { return l.ctnr === '40ST'; })[0], b = ls.filter(function (l) { return l.ctnr === '40HQ'; })[0];
      var juntar = a && b && a.tipo === b.tipo && a.correccion === b.correccion && a.flete === b.flete && a.dias === b.dias;
      ls.forEach(function (l) {
        if (juntar && l === b) return;
        var r = l.r;
        filas.push({ tipo: l.tipo, reemplazar: l.correccion || l.tipo === TIPOS.NEGOCIADA, transporte: 'Maritimo', ffww: agente.nombre, contacto: agente.contacto || agente.nombre,
          flete: l.flete, pol: r.pol, tt: num(r.tt), servicio: r.servicio, linea: r.naviera, pod: r.pod, transbordo: r.directo ? 'Directo' : r.transbordo, desde: desde, hasta: hasta,
          dias: l.dias, pagadero: r.pagadero, locales: num(r.localesArg), ctnr: juntar && l === a ? cfg.combinado : l.ctnr, coment: r.comentarios || '', imo: num(r.imo), fuel: num(r.fuel), puertos: num(r.puertos) });
      });
    });
    pegarMaritimo(filas, cfg);
  } else {
    if (!cfg.airIni) return;
    pegarEnBaseMadre(aPegar.map(function (l) {
      var r = l.r;
      return { semana: semanaISO(desde), agente: agente.nombre, version: version, recibido: ahora, tipo: l.tipo, motivo: l.correccion ? MOTIVOS.correccion : l.motivo,
        origen: r.origen, destino: r.destino, aerolinea: r.aerolinea, transito: num(r.transito), minimo: num(r.minimo), tarifas: r.tarifas, fuel: num(r.fuel),
        imo: r.imoPedido ? '' : num(r.imo), imoPedido: !!r.imoPedido, destino_usd: num(r.destino_usd), vigencia: hasta, vigDesde: desde, obs: r.obs || '',
        gastos: l.g.map(function (c) { return { importe: num(c.importe), unidad: c.unidad, minimo: num(c.minimo), pedido: !!c.pedido }; }) };
    }), cfg.peso, { url: cfg.baseUrl, pestana: cfg.airIni, pestanaNeg: cfg.airNeg, imoTexto: cfg.imoTexto });
  }
}

/* ---------- Marítimo ---------- */
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
  ['desde', ['VIGENCIA DESDE', 'VALIDEZ QUINCENA DESDE', 'VALIDEZ DESDE'], true],
  ['hasta', ['VIGENCIA HASTA', 'VALIDEZ QUINCENA HASTA', 'VALIDEZ HASTA'], true],
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
  servicio: 'Tipo de servicio (Regular / Spot)', linea: 'Naviera', pod: 'POD', transbordo: 'Directo o puerto de transbordo', desde: 'Vigencia desde', hasta: 'Vigencia hasta',
  dias: 'Días libres', pagadero: 'Pagadero', locales: 'Locales ARG', ctnr: 'Contenedor', coment: 'Comentarios', imo: 'Recarga IMO', fuel: 'Fuel adjust', puertos: 'Adicional puertos internos' };

function valorMar(campo, f) {
  var v = f[campo];
  if (['imo', 'fuel', 'puertos'].indexOf(campo) >= 0 && (v === '' || v === 0)) return '';
  return v;
}
function clavePegado(v) { return v instanceof Date ? fecha(v) : claveTexto(v); }

// Inicial → SIN NEGOCIAR, negociada → Negociado. Una corrección (o una nueva ronda negociada) pisa su propia fila.
function pegarMaritimo(filas, cfg) {
  var grupos = {};
  filas.forEach(function (f) { var dest = f.tipo === TIPOS.NEGOCIADA ? cfg.marNeg : cfg.marIni; (grupos[dest] = grupos[dest] || []).push(f); });
  var total = { nuevas: 0, actualizadas: 0 };
  Object.keys(grupos).forEach(function (nombre) {
    var hoja = abrirDestino({ url: cfg.baseUrl }, nombre), enc = mapearEncabezados(hoja, MAPA_MARITIMO);
    if (!enc) throw new Error('No encontré los encabezados en "' + nombre + '".');
    var M = enc.mapa, ancho = hoja.getLastColumn(), ultimaHoja = hoja.getLastRow(), colPol = M.pol || M.ffww;
    // Para no leer 17.000 filas en cada envío, se buscan coincidencias en las últimas 4.000
    var inicio = Math.max(enc.fila + 1, ultimaHoja - 3999), n = Math.max(0, ultimaHoja - inicio + 1);
    var datos = n ? hoja.getRange(inicio, 1, n, ancho).getValues() : [], formulas = n ? hoja.getRange(inicio, 1, n, ancho).getFormulas() : [];
    var ultima = enc.fila; datos.forEach(function (r, i) { if (String(r[colPol - 1]).trim() !== '') ultima = inicio + i; });
    var claves = ['ffww', 'pol', 'pod', 'linea', 'ctnr', 'desde'].filter(function (c) { return M[c]; });
    grupos[nombre].forEach(function (f) {
      var fila = 0;
      if (f.reemplazar) {
        for (var i = datos.length - 1; i >= 0 && !fila; i--) {
          var r = datos[i] || [];
          if (claves.every(function (c) { return clavePegado(r[M[c] - 1]) === clavePegado(f[c]); })) fila = inicio + i;
        }
      }
      var esNueva = !fila;
      if (esNueva) { fila = ultima + 1; ultima = fila; if (fila - 1 > enc.fila) hoja.getRange(fila - 1, 1, 1, ancho).copyTo(hoja.getRange(fila, 1, 1, ancho), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false); }
      var idx = fila - inicio, arriba = idx > 0 ? (formulas[idx - 1] || []) : [], propias = (formulas[idx] || []).slice();
      datos[idx] = datos[idx] || []; formulas[idx] = formulas[idx] || [];
      var ocupadas = {};
      Object.keys(M).forEach(function (campo) {
        var c = M[campo]; ocupadas[c - 1] = true;
        if (propias[c - 1]) return;
        if (esNueva && arriba[c - 1]) { hoja.getRange(fila - 1, c).copyTo(hoja.getRange(fila, c), SpreadsheetApp.CopyPasteType.PASTE_FORMULA, false); formulas[idx][c - 1] = arriba[c - 1]; return; }
        var v = valorMar(campo, f); hoja.getRange(fila, c).setValue(v === undefined || (typeof v === 'number' && isNaN(v)) ? '' : v);
        datos[idx][c - 1] = v;
      });
      if (esNueva) { copiarFormulasDeArriba(hoja, fila, arriba, ocupadas, formulas[idx]); total.nuevas++; } else total.actualizadas++;
    });
    registrar('Sistema', 'Pegó marítimo en la base madre', grupos[nombre].length + ' fila(s) en "' + nombre + '"');
  });
  return total;
}

/* ---------- Aéreo ---------- */
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
  ['vigDesde', ['VIGENCIA DESDE', 'VALIDEZ DESDE', 'VALID FROM'], true],
  ['vigencia', ['VIGENCIA', 'VALIDEZ HASTA', 'VALIDITY', 'VALID UNTIL'], true],
  ['allin', ['ALL-IN', 'ALL IN', 'ALLIN'], true],
  ['obs', ['OBSERVACIONES', 'COMENTARIOS', 'REMARKS', 'OBS']],
  ['version', ['VERSION']],
  ['recibido', ['FECHA RECEPCION', 'FECHA DE RECEPCION', 'RECIBIDO', 'FECHA DE CARGA']],
  ['tipo', ['TIPO DE TARIFA', 'TIPO TARIFA', 'TIPO', 'INICIAL / NEGOCIADA', 'INICIAL O NEGOCIADA', 'ESTADO DE LA TARIFA']]
];
var NOMBRE_CAMPO = { semana: 'Semana (de la vigencia desde)', agente: 'Agente', origen: 'Origen', destino: 'Destino', aerolinea: 'Aerolínea', transito: 'Tránsito', moneda: 'Moneda',
  minimo: 'Mínimo', r45: '45 kg', r100: '100 kg', r300: '300 kg', r500: '500 kg', r1000: '1000 kg', fuel: 'Fuel', imo: 'IMO', origenUsd: 'Gastos en origen (total)',
  destinoUsd: 'Gastos destino', vigDesde: 'Vigencia desde', vigencia: 'Vigencia hasta', allin: 'All-in USD/kg', obs: 'Observaciones', version: 'Versión', recibido: 'Fecha de recepción', tipo: 'Tipo de tarifa (Inicial / Negociada)' };

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
  if (isNaN(rate) || f.minimo === '' || isNaN(f.minimo)) return { origen: Math.round(origen * 100) / 100, allin: '' };
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
    case 'origenUsd': return calc.origen; case 'destinoUsd': return f.destino_usd; case 'vigDesde': return f.vigDesde; case 'vigencia': return f.vigencia;
    case 'allin': return calc.allin; case 'obs': return f.obs; case 'version': return f.version; case 'recibido': return f.recibido;
    case 'tipo': return f.tipo || TIPOS.INICIAL;
  }
  return '';
}
function pegarEnBaseMadre(filas, W, cfg) {
  var separada = !!cfg.pestanaNeg && cfg.pestanaNeg !== cfg.pestana, grupos = {};
  filas.forEach(function (f) { var d = separada && f.tipo === TIPOS.NEGOCIADA ? cfg.pestanaNeg : cfg.pestana; (grupos[d] = grupos[d] || []).push(f); });
  var total = { nuevas: 0, actualizadas: 0 };
  Object.keys(grupos).forEach(function (nombre) {
    var r = pegarEnPestana(abrirDestino(cfg, nombre), nombre, grupos[nombre], W, cfg, separada);
    total.nuevas += r.nuevas; total.actualizadas += r.actualizadas;
  });
  return total;
}
function pegarEnPestana(hoja, nombre, filas, W, cfg, separada) {
  var enc = mapearEncabezados(hoja, MAPA_AEREO);
  if (!enc) throw new Error('No encontré los encabezados en la pestaña "' + nombre + '" (busqué en las primeras 20 filas).');
  var M = enc.mapa, colClave = M.origen || M.agente;
  if (!colClave) throw new Error('La pestaña de destino no tiene columna de Origen ni de Agente.');
  var ancho = hoja.getLastColumn(), nuevas = 0, actualizadas = 0, totalFilas = hoja.getLastRow();
  var inicio = Math.max(enc.fila + 1, totalFilas - 3999), n = Math.max(0, totalFilas - inicio + 1);
  var datos = n ? hoja.getRange(inicio, 1, n, ancho).getValues() : [], formulas = n ? hoja.getRange(inicio, 1, n, ancho).getFormulas() : [];
  var ultima = enc.fila; datos.forEach(function (r, i) { if (String(r[colClave - 1]).trim() !== '') ultima = inicio + i; });
  var mismaPestanaSinTipo = !separada && !M.tipo;
  filas.forEach(function (f) {
    var calc = calcularAllIn(f, W), fila = 0;
    if (M.semana && M.agente && M.origen) {
      var candidatas = [];
      for (var i = 0; i < datos.length; i++) {
        var r = datos[i] || [];
        if (claveTexto(r[M.semana - 1]) === claveTexto(f.semana) && claveTexto(r[M.agente - 1]) === claveTexto(f.agente) && claveTexto(r[M.origen - 1]) === claveTexto(f.origen) &&
            (!M.tipo || claveTexto(r[M.tipo - 1] || TIPOS.INICIAL) === claveTexto(f.tipo || TIPOS.INICIAL))) candidatas.push(inicio + i);
      }
      if (f.motivo === MOTIVOS.correccion) fila = mismaPestanaSinTipo && f.tipo !== TIPOS.NEGOCIADA ? (candidatas[0] || 0) : (candidatas[candidatas.length - 1] || 0);
      else if (f.tipo === TIPOS.NEGOCIADA && !mismaPestanaSinTipo) fila = candidatas[candidatas.length - 1] || 0;
    }
    var esNueva = !fila;
    if (esNueva) { fila = ultima + 1; ultima = fila; if (fila - 1 > enc.fila) hoja.getRange(fila - 1, 1, 1, ancho).copyTo(hoja.getRange(fila, 1, 1, ancho), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false); }
    var idx = fila - inicio;
    datos[idx] = datos[idx] || []; formulas[idx] = formulas[idx] || [];
    var propias = formulas[idx].slice(), arriba = idx > 0 ? (formulas[idx - 1] || []) : [], ocupadas = {};
    Object.keys(M).forEach(function (campo) {
      var c = M[campo]; ocupadas[c - 1] = true;
      if (propias[c - 1]) return;
      if (esNueva && arriba[c - 1]) { hoja.getRange(fila - 1, c).copyTo(hoja.getRange(fila, c), SpreadsheetApp.CopyPasteType.PASTE_FORMULA, false); formulas[idx][c - 1] = arriba[c - 1]; return; }
      var v = valorDe(campo, f, calc, cfg);
      if (campo === 'obs' && mismaPestanaSinTipo && f.tipo === TIPOS.NEGOCIADA) v = 'Tarifa negociada. ' + (v || '');
      hoja.getRange(fila, c).setValue(v === undefined || (typeof v === 'number' && isNaN(v)) ? '' : v);
    });
    if (esNueva) { copiarFormulasDeArriba(hoja, fila, arriba, ocupadas, formulas[idx]); nuevas++; } else actualizadas++;
    if (M.semana) datos[idx][M.semana - 1] = f.semana;
    if (M.agente) datos[idx][M.agente - 1] = f.agente;
    if (M.origen) datos[idx][M.origen - 1] = f.origen;
    if (M.tipo) datos[idx][M.tipo - 1] = f.tipo;
  });
  registrar('Sistema', 'Pegó aéreo en la base madre', nuevas + ' fila(s) nueva(s) y ' + actualizadas + ' actualizada(s) en "' + nombre + '"');
  return { nuevas: nuevas, actualizadas: actualizadas };
}

/* ---------- Verificar qué columnas se completan ---------- */
function verificarBaseMadre() {
  var ui = SpreadsheetApp.getUi(), cfg = leerAjustes(), msg = [];
  var revisar = function (titulo, nombre, mapaDef, nombres) {
    if (!nombre) { msg.push(titulo + ': sin pestaña configurada (queda solo en ' + HOJA.COTIZ + ').'); return; }
    try {
      var hoja = abrirDestino({ url: cfg.baseUrl }, nombre), enc = mapearEncabezados(hoja, mapaDef);
      if (!enc) { msg.push(titulo + ' → "' + nombre + '": no encontré los encabezados.'); return; }
      msg.push(titulo + ' → "' + nombre + '" (encabezados en la fila ' + enc.fila + ', se pega desde la fila ' + (Math.max(enc.fila, hoja.getLastRow()) + 1) + ' aprox.)\n' +
        Object.keys(enc.mapa).sort(function (a, b) { return enc.mapa[a] - enc.mapa[b]; }).map(function (k) { return '• ' + hoja.getRange(enc.fila, enc.mapa[k]).getValue() + '  ←  ' + nombres[k]; }).join('\n') +
        (enc.desconocidas.length ? '\nNo se tocan (si tienen fórmula, se copia la de arriba): ' + enc.desconocidas.join(', ') : ''));
    } catch (e) { msg.push(titulo + ': ' + String(e.message || e)); }
  };
  revisar('MARÍTIMO INICIALES', cfg.marIni, MAPA_MARITIMO, NOMBRE_CAMPO_MAR);
  revisar('MARÍTIMO NEGOCIADAS', cfg.marNeg, MAPA_MARITIMO, NOMBRE_CAMPO_MAR);
  revisar('AÉREO INICIALES', cfg.airIni, MAPA_AEREO, NOMBRE_CAMPO);
  if (cfg.airNeg && cfg.airNeg !== cfg.airIni) revisar('AÉREO NEGOCIADAS', cfg.airNeg, MAPA_AEREO, NOMBRE_CAMPO);
  ui.alert(msg.join('\n\n') + '\n\nPegado automático: ' + (cfg.auto ? 'activado' : 'desactivado') + '.\nMails del team: ' + (cfg.teamMails.length ? cfg.teamMails.join(', ') : 'FALTAN (completalos en ' + HOJA.AJUSTES + ')') + '.');
}
