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
 * Instalación: en el proyecto de Apps Script de la planilla, agregar este archivo (Tarifador.gs) y
 * TarifadorForm.html, ejecutar una vez tarifadorInstalar(), recargar la planilla y usar el menú
 * Tarifador BIDCOM. Todo vive dentro del bloque Tarifador para no chocar con otros scripts del
 * proyecto (por ejemplo su onOpen): afuera solo hay funciones con prefijo tarifador.
 */

var Tarifador = (function () {
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
  var CONTENEDORES = ['20ST', '40ST/40HQ', '40NOR'];       // los tipos que usa la base madre
  var SERVICIOS = ['DIRECTO', 'TRASBORDO'];
  // Normaliza cualquier forma de escribir el contenedor a los tipos de la base madre
  function tipoCtnr(v) {
    var t = String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (/NOR/.test(t)) return '40NOR';
    if (/^20/.test(t)) return '20ST';
    if (/^40/.test(t)) return '40ST/40HQ';
    return '';
  }

  /* ------------------------------------------------------------------ */
  /* Pestaña TARIFADOR Ajustes: bloques uno al lado del otro              */
  /* Encabezados en la fila 3, datos desde la fila 4.                     */
  /* ------------------------------------------------------------------ */
  var BLOQUE = { AJUSTES: 1, AGENTES: 5, RUTAS_AIR: 13, NOTAS_AIR: 17, LISTAS: 19, REGISTRO: 27 };
  var FILA_DATOS = 4;
  var AJ = [
    ['GENERAL'],
    ['teamMails', 'Mails del team (separados por coma)', '', 'Reciben un aviso cada vez que un agente carga o responde, y copia de los avisos de vencimiento.'],
    ['reduccion', 'Meta de ahorro vs histórico', 0.15, 'Semáforo "Vs histórico": la tarifa ideal es la mediana histórica menos este %. No define el target que se le pide al agente.'],
    ['reduccionMenor', 'Mejora a pedir a quien cotizó la menor', 0.05, 'Target sugerido: a quien cotizó el menor flete se le pide este % menos; al resto, igualar la menor. El target nunca supera la menor tarifa recibida.'],
    ['mostrarTarget', 'Decirle el valor objetivo al agente al pedir mejora', 'SI', 'SI = el mail y el formulario muestran el valor a alcanzar. NO = solo se pide mejorar. Nunca se dice que viene de otro agente.'],
    ['diasAviso', 'Aviso de vencimiento: días antes', 5, 'El agente recibe un mail para cargar la tarifa nueva (con copia al team). Se activa una vez desde el menú.'],
    ['baseUrl', 'Base madre: link de la planilla', '', 'Vacío = esta misma planilla.'],
    ['auto', 'Pegar automáticamente en la base madre', 'SI', 'NO = queda solo en TARIFADOR Cotizaciones.'],
    ['MARÍTIMO'],
    ['marIni', 'Pestaña tarifas iniciales', 'Cotizaciones Maritimos SIN NEGOCIAR', 'Primer envío de cada agente (y sus correcciones), en las filas vacías debajo del histórico.'],
    ['marNeg', 'Pestaña tarifas negociadas', 'Cotizaciones Maritimos Negociado', 'La tarifa que el agente manda después de un pedido de mejora.'],
    ['locales', 'Locales ARG aceptado (USD)', 800, 'Se le muestra al agente. Si cotiza más, se marca en el aviso al team.'],
    ['AÉREO'],
    ['airIni', 'Pestaña tarifas iniciales (aéreo)', 'Cotizaciones Aereos SIN NEGOCIAR', 'Nombre exacto de la pestaña de la base madre. Vacío = el aéreo queda solo en TARIFADOR Cotizaciones.'],
    ['airNeg', 'Pestaña tarifas negociadas (aéreo)', 'Cotizaciones Aereos Negociado', 'La tarifa aérea que el agente manda después de un pedido de mejora.'],
    ['imoTexto', 'IMO a pedido se escribe como', 'Upon RQST', ''],
    ['peso', 'Peso de referencia (kg)', 500, 'Para calcular el all-in USD/kg. No cambiarlo seguido: deja de ser comparable.'],
    ['GASTOS EN ORIGEN'],
    ['gastosUrl', 'Base de gastos en origen: link de la planilla', 'https://docs.google.com/spreadsheets/d/1mNQlFxmFs4SjVlhDPuoxCafoF68qMECQFYNUgISOYrc/edit', 'Los gastos en origen marítimos se pegan acá, concepto por concepto. Vacío = no se pegan.'],
    ['gastosHoja', 'Pestaña de gastos en origen', 'Concatenado de GS (ffww)', 'Una fila por agente, puerto, contenedor y concepto. Si la fila ya existe se actualiza; si no, se agrega abajo.'],
    ['gastosMeses', 'Validez de los gastos en origen (meses)', 1, 'Se escribe en la columna de validez. Unos días antes, el agente recibe un aviso para volver a cotizarlos.'],
    ['PEDIDOS DE TARIFAS'],
    ['recordatorioDiario', 'Recordatorio diario a quien no envió (SI/NO)', 'SI', 'SI = desde el día siguiente al pedido y hasta la fecha límite, el agente que no envió recibe un recordatorio por día (con copia al team). Al pasar la fecha límite, el team recibe el resumen de quién cotizó y quién no.'],
    ['LINK'],
    ['formUrl', 'Link del formulario (aplicación web)', '', 'La URL /exec de Implementar > Gestionar implementaciones. Vacío = la que informa Google. Con esta se arman los links de los agentes.']
  ];
  var COLS_AGENTES = ['Código', 'Nombre del agente (FFWW)', 'Email del agente', 'Activo (SI/NO)', 'Clave (automática)', 'Link personal (automático)', 'Agente en origen (va a la columna Agente de la base; los mails van al FFWW)'];
  var LISTAS_DEF = [
    ['POL', 'Shanghai', 'Ningbo', 'Shenzhen', 'Yantian', 'Shekou', 'Qingdao', 'Tianjin', 'Xiamen', 'Nansha', 'Guangzhou', 'Hong Kong', 'Busan', 'Singapore'],
    ['POD', 'BUENOS AIRES', 'MONTEVIDEO', 'SANTOS'],
    ['Naviera', 'MSC', 'MAERSK', 'CMA CGM', 'COSCO', 'EVERGREEN', 'HAPAG-LLOYD', 'ONE', 'OOCL', 'HMM', 'ZIM', 'PIL', 'YANG MING', 'WAN HAI', 'TBC'],
    ['Tipo de servicio', 'DIRECTO', 'TRASBORDO'],
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
    ['menor', 'Menor de la ronda'], ['vsMenor', 'Vs la menor'], ['mediana', 'Mediana histórica'], ['target', 'Target sugerido'], ['motivoTarget', 'Por qué este target'], ['semaforo', 'Vs histórico'],
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
  function menu() {
    SpreadsheetApp.getUi().createMenu('Tarifador BIDCOM')
      .addItem('1. Preparar hojas', 'tarifador_prepararHojas')
      .addItem('2. Generar links de agentes', 'tarifador_generarLinks')
      .addItem('3. Verificar la base madre', 'tarifador_verificarBaseMadre')
      .addItem('4. Activar aviso diario de vencimientos', 'tarifador_activarAvisos')
      .addSeparator()
      .addItem('Panel de tarifas (KPIs, agentes, rutas)', 'tarifador_panel')
      .addItem('Enviar decisiones del team (aprobar / pedir mejora)', 'tarifador_enviarDecisiones')
      .addItem('Recalcular comparación', 'tarifador_recalcular')
      .addItem('Pedir tarifas a agentes activos', 'tarifador_pedirTarifas')
      .addItem('Revisar vencimientos y pedidos ahora', 'tarifador_avisarVencimientos')
      .addItem('Volver a pegar un envío en la base madre', 'tarifador_repegarEnvio')
      .addItem('Ir a TARIFADOR Cotizaciones', 'tarifador_irACotizaciones')
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
      if (a[0] === 'reduccion' || a[0] === 'reduccionMenor') sh.getRange(f, 2).setNumberFormat('0%');
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
    if (sh.getMaxColumns() < n) sh.insertColumnsAfter(sh.getMaxColumns(), n - sh.getMaxColumns());
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
    sh.getRange(1, K.total + 1).setNote('Marítimo: USD por contenedor = flete + Recarga IMO (Locales ARG va aparte). Aéreo: all-in USD/kg al peso de referencia.');
    sh.getRange(1, K.menor + 1).setNote('Se compara solo el flete (sin IMO, locales ni gastos). Ronda = mismas rutas (y contenedor) con vigencias que se superponen. SI = cotizó el menor flete. "SI (única)" = es la única oferta.');
    notasComparacion(sh, leerAjustes());
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
      var pares = { baseUrl: v[0], airIni: v[1], auto: v[2], imoTexto: v[3], airNeg: v[5], marIni: v[10], marNeg: v[11], locales: v[12] };
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
    var pct = function (x, def) { var n = num(String(x === undefined ? '' : x).replace('%', '').trim()); return isNaN(n) || n === '' ? def : n >= 1 ? n / 100 : n; };
    var red = pct(v.reduccion, 0.15), redM = pct(v.reduccionMenor, 0.05);
    var cfg = {
      teamMails: String(v.teamMails || '').split(/[,;\s]+/).map(function (x) { return x.trim(); }).filter(function (x) { return /@/.test(x); }),
      reduccion: red, reduccionMenor: redM, mostrarTarget: String(v.mostrarTarget).trim().toUpperCase() !== 'NO', diasAviso: num(v.diasAviso) >= 0 && v.diasAviso !== '' ? num(v.diasAviso) : 5, recordatorioDiario: String(v.recordatorioDiario === undefined ? 'SI' : v.recordatorioDiario).trim().toUpperCase() !== 'NO',
      baseUrl: String(v.baseUrl || '').trim(), auto: String(v.auto).trim().toUpperCase() !== 'NO',
      marIni: String(v.marIni || '').trim(), marNeg: String(v.marNeg || '').trim(), locales: num(v.locales) || 800,
      formUrl: String(v.formUrl || '').trim(), gastosUrl: String(v.gastosUrl || '').trim(), gastosHoja: String(v.gastosHoja || '').trim() || 'Concatenado de GS (ffww)', gastosMeses: num(v.gastosMeses) > 0 ? num(v.gastosMeses) : 1, airIni: String(v.airIni || '').trim(), airNeg: String(v.airNeg || '').trim(), imoTexto: String(v.imoTexto || '').trim() || 'Upon RQST', peso: num(v.peso) || 500
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
    var ui = SpreadsheetApp.getUi(), url = urlFormulario();
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
  function linkDe(a) { return a.link || (urlFormulario() + '?k=' + a.clave); }
  // URL pública del formulario: la de Ajustes, o la que informa Google sin el tramo del dominio (/a/<dominio>/), que a los agentes externos les pide iniciar sesión
  function urlFormulario() { var u = leerAjustes().formUrl || ScriptApp.getService().getUrl() || ''; return u.replace(/\/a\/(macros\/)?[^\/]+\/(macros\/)?s\//, '/macros/s/').replace(/\?.*$/, ''); }
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
    var t = HtmlService.createTemplateFromFile('TarifadorForm');
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
          actual: num(x[K.flete]), objetivo: cfg.mostrarTarget && num(x[K.targetPedir]) > 0 ? num(x[K.targetPedir]) : '', mensaje: String(x[K.mensaje] || '') });
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
      try { if (cfg.auto) { pegarEnvioEnBase(cfg, modo, agente, lineas, desde, hasta, version, ahora); SpreadsheetApp.flush(); } }
      catch (e2) { registrar('Sistema', 'Error al pegar en la base madre', String(e2 && e2.message || e2)); }
      try { if (cfg.auto && modo === MODO.MAR) { pegarGastosOrigen(cfg, agente, lineas, id, ahora); SpreadsheetApp.flush(); } }
      catch (e4) { registrar('Sistema', 'Error al pegar los gastos en origen', String(e4 && e4.message || e4)); }
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
      if (!r.directo && !String(r.transbordo || '').trim()) err.push(p + 'falta el puerto de transbordo.');
      if (!(num(r.tt) > 0)) err.push(p + 'falta el transit time.');
      if (['COLLECT', 'PREPAID'].indexOf(r.pagadero) < 0) err.push(p + 'falta pagadero.');
      var conts = CONTENEDORES.filter(function (c) { return r.contenedores && r.contenedores[c] && num(r.contenedores[c].flete) > 0; });
      if (!conts.length) err.push(p + 'falta el flete de al menos un contenedor.');
      conts.forEach(function (c) { var d = r.contenedores[c].dias; if (d === '' || d === null || d === undefined || isNaN(num(d))) err.push(p + 'faltan los días libres de ' + c + '.'); });
      if (r.localesArg === '' || r.localesArg === null || r.localesArg === undefined || isNaN(num(r.localesArg))) err.push(p + 'faltan los Locales ARG.');
      ['imo'].forEach(function (k) { if (r[k] !== '' && r[k] !== null && r[k] !== undefined && isNaN(num(r[k]))) err.push(p + 'valor inválido en ' + { imo: 'Recarga IMO' }[k] + '.'); });
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
  var CBM_STD = { '20ST': 28, '40ST/40HQ': 63, '40NOR': 58 }, TON_STD = { '20ST': 10, '40ST/40HQ': 12, '40NOR': 12 };
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
      var rr = JSON.parse(JSON.stringify(r)); rr.gastos = gastos; rr.servicio = r.directo ? 'DIRECTO' : 'TRASBORDO';
      var recargos = num(r.imo) || 0;
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
  /* Regla: a quien cotizó la menor se le pide −5% (configurable);        */
  /* al resto, igualar la menor. La mediana es el control del semáforo.   */
  /* ------------------------------------------------------------------ */
  // Notas de Target y semáforo con los % actuales de Ajustes (se reescriben en cada recálculo)
  function notasComparacion(sh, cfg) {
    var p = function (x) { return Math.round(x * 1000) / 10 + '%'; };
    sh.getRange(1, K.target + 1).setNote('Sobre el flete solamente. Regla: a quien cotizó el menor flete se le pide ' + p(cfg.reduccionMenor) + ' menos ("Mejora a pedir a quien cotizó la menor" en Ajustes); al resto, igualar la menor. ' +
      'La ronda incluye lo cargado a mano en la base madre (misma ruta y contenedor, vigencias que se superponen). Nunca supera la menor tarifa recibida. Podés escribir otro valor en "Target a pedir".');
    sh.getRange(1, K.motivoTarget + 1).setNote('Contra qué oferta se calculó el target: agente, naviera, valor, puertos, vigencia y fuente (cotizador o base madre). Solo para el team: nunca se le dice al agente de quién es.');
    sh.getRange(1, K.semaforo + 1).setNote('Flete contra la mediana histórica del flete menos la meta de ahorro (' + p(cfg.reduccion) + ', "Meta de ahorro vs histórico" en Ajustes). Verde ≤ objetivo · Amarillo hasta +5% · Naranja hasta +15% · Rojo más. No define el target.');
  }
  function recalcular(cfg, sh, datos) {
    cfg = cfg || leerAjustes(); sh = sh || hojaCotiz(); datos = datos || valoresCotiz(sh);
    try { notasComparacion(sh, cfg); } catch (eN) { }
    if (!datos.length) return datos;
    var red = cfg.reduccion, redM = cfg.reduccionMenor, hist = null, base = null, vig = [];
    datos.forEach(function (x, i) { if (x[K.vigente] === 'SI' && x[K.id] && num(x[K.flete]) > 0) vig.push(i); });
    var bloque = datos.map(function (x) { return [x[K.menor], x[K.vsMenor], x[K.mediana], x[K.target], x[K.motivoTarget], x[K.semaforo]]; });
    var ahorros = datos.map(function (x) { return [x[K.ahorro], x[K.ahorroPct]]; });
    vig.forEach(function (i) {
      var x = datos[i], tot = num(x[K.flete]), d0 = aDia(x[K.desde]), h0 = aDia(x[K.hasta]), mar = x[K.modo] === MODO.MAR;
      var ronda = vig.filter(function (j) {
        var y = datos[j];
        return y[K.modo] === x[K.modo] && claveTexto(y[K.origen]) === claveTexto(x[K.origen]) && claveTexto(y[K.destino]) === claveTexto(x[K.destino]) &&
          (!mar || claveTexto(y[K.ctnr]) === claveTexto(x[K.ctnr])) && aDia(y[K.desde]) <= h0 && aDia(y[K.hasta]) >= d0;
      }).map(function (j) { var y = datos[j]; return { valor: num(y[K.flete]), agente: String(y[K.ffww]), linea: String(y[K.carrier] || ''), polTxt: String(y[K.origen]), podTxt: String(y[K.destino]),
        desde: aDia(y[K.desde]), hasta: aDia(y[K.hasta]), fuente: 'cotizador', propia: j === i }; });
      if (mar) {                                                        // suma lo cargado en la base madre (también a mano) para esa ruta, contenedor y vigencia
        if (base === null) base = baseRondaMar(cfg);
        var pol = claveTexto(x[K.origen]), pod = claveTexto(x[K.destino]);
        base.forEach(function (b) { if (b.pol === pol && (!b.pod || b.pod === pod) && b.ctnr === x[K.ctnr] && b.desde <= h0 && b.hasta >= d0) ronda.push(b); });
      }
      var L = Math.min.apply(null, ronda.map(function (o) { return o.valor; })), esMenor = tot <= L + 1e-9;
      // A quien cotizó la menor: mejora chica (Ajustes, 5%). Al resto: igualar la menor. Nunca por encima de la menor recibida.
      var target = redondear(Math.min(esMenor ? tot * (1 - redM) : L, L), mar);
      var med = '';
      if (mar) { if (hist === null) hist = historicoMar(cfg); med = medianaMar(hist, x); }
      else med = medianaAir(datos, vig, x);
      var sem = med ? semaforo(tot, med * (1 - red)) : 'Sin histórico';
      var otros = ronda.filter(function (o) { return !o.propia && claveTexto(o.agente) !== claveTexto(x[K.ffww]); });
      var motivo = motivoTarget(x, mar, esMenor, otros, L, redM);
      bloque[i] = [esMenor ? (otros.length ? 'SI' : 'SI (única)') : '', esMenor ? 0 : Math.round((tot / L - 1) * 10000) / 10000, med === '' ? '' : redondear(med, mar), target, motivo, sem];
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
    sh.getRange(2, K.menor + 1, datos.length, 6).setValues(bloque);
    sh.getRange(2, K.ahorro + 1, datos.length, 2).setValues(ahorros);
    datos.forEach(function (x, i) { for (var c = 0; c < 6; c++) x[K.menor + c] = bloque[i][c]; x[K.ahorro] = ahorros[i][0]; x[K.ahorroPct] = ahorros[i][1]; });
    return datos;
  }
  // Explica de dónde sale el target: contra qué oferta (agente, puerto, naviera, valor, vigencia, fuente). Solo para el team.
  function motivoTarget(x, mar, esMenor, otros, L, redM) {
    var ruta = x[K.origen] + ' → ' + x[K.destino] + (mar && x[K.ctnr] ? ' ' + x[K.ctnr] : '');
    var desc = function (o) { var f = function (t) { return fechaCorta(new Date(t)); };
      return (o.agente || 'Sin agente') + (o.linea ? ' · ' + o.linea : '') + ' · ' + valorTxt(o.valor, mar) + ' · ' + (o.polTxt || '') + ' → ' + (o.podTxt || '') + ' · vig. ' + f(o.desde) + '–' + f(o.hasta) + ' (' + o.fuente + ')'; };
    var pct = Math.round(redM * 1000) / 10 + '%';
    if (esMenor) {
      if (!otros.length) return 'Única oferta para ' + ruta + ' en esa vigencia: se pide −' + pct + ' sobre su flete.';
      var seg = otros.slice().sort(function (a, b) { return a.valor - b.valor; })[0];
      return 'Cotizó la menor de ' + ruta + ': se pide −' + pct + '. 2ª mejor: ' + desc(seg) + ' (' + otros.length + ' oferta' + (otros.length === 1 ? '' : 's') + ' más).';
    }
    var m = otros.filter(function (o) { return Math.abs(o.valor - L) < 1e-9; }).sort(function (a, b) { return a.fuente === 'cotizador' ? -1 : 1; })[0];
    if (!m) return 'Igualar la menor de ' + ruta + ': ' + valorTxt(L, mar) + ' (otra versión de este mismo agente para esa vigencia).';
    return 'Igualar la menor de ' + ruta + ': ' + desc(m) + '. Ofertas en la ronda: ' + (otros.length + 1) + '.';
  }
  // Vuelve a pegar en la base madre (y en la base de gastos) un envío ya guardado en TARIFADOR Cotizaciones, por su ID.
  // Reemplaza las filas que ya estén pegadas (no duplica).
  function repegarEnvioMenu() {
    var ui = SpreadsheetApp.getUi(), r = ui.prompt('Volver a pegar un envío', 'ID del envío (columna "ID envío" de ' + HOJA.COTIZ + ', por ejemplo M204BAE1):', ui.ButtonSet.OK_CANCEL);
    if (r.getSelectedButton() !== ui.Button.OK) return;
    ui.alert(repegarEnvio(String(r.getResponseText() || '').trim().toUpperCase()));
  }
  function repegarEnvio(id) {
    var cfg = leerAjustes(), sh = hojaCotiz(), datos = valoresCotiz(sh), filas = datos.filter(function (x) { return String(x[K.id]).toUpperCase() === id; });
    if (!filas.length) return 'No encontré el envío ' + id + '.';
    var x0 = filas[0], modo = x0[K.modo], agente = agentesPorNombre()[x0[K.ffww]];
    if (!agente) return 'El agente ' + x0[K.ffww] + ' no está en ' + HOJA.AJUSTES + '.';
    if (modo !== MODO.MAR) return 'Por ahora esta opción es para envíos marítimos.';
    var lineas = filas.map(function (x) {
      var det = leerDetalle(x[K.detalle]), r = det.r || {}, c = (r.contenedores || {})[x[K.ctnr]] || {};
      return { pegar: true, correccion: true, tipo: x[K.tipo], ruta: det.ruta, r: r, ctnr: x[K.ctnr], flete: num(x[K.flete]), dias: num(c.dias) };
    }).filter(function (l) { return l.r && l.r.pol; });
    var ahora = new Date(), msg = [];
    try { pegarEnvioEnBase(cfg, modo, agente, lineas, aFecha(x0[K.desde]), aFecha(x0[K.hasta]), x0[K.version], ahora); SpreadsheetApp.flush(); msg.push('Base madre: listo.'); }
    catch (e) { msg.push('Base madre: ' + (e && e.message || e)); registrar('Sistema', 'Error al volver a pegar en la base madre', id + ': ' + (e && e.message || e)); }
    try { var n = pegarGastosOrigen(cfg, agente, lineas, id, ahora); SpreadsheetApp.flush(); msg.push('Gastos en origen: ' + n + ' fila(s).'); }
    catch (e2) { msg.push('Gastos en origen: ' + (e2 && e2.message || e2)); registrar('Sistema', 'Error al volver a pegar los gastos en origen', id + ': ' + (e2 && e2.message || e2)); }
    registrar('BIDCOM', 'Volvió a pegar un envío', id + ' · ' + agente.nombre + ' · ' + lineas.length + ' tarifa(s)');
    return 'Envío ' + id + ' (' + agente.nombre + ', ' + lineas.length + ' tarifas):\n' + msg.join('\n') + '\n\nEl detalle (filas ajustadas o sin pegar) queda en el registro de ' + HOJA.AJUSTES + '.';
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
        return { pol: claveTexto(v('pol')), pod: claveTexto(v('pod')), ctnr: tipoCtnr(v('ctnr')), desde: aDia(v('desde')),
          valor: flete };
      }).filter(Boolean);
    } catch (e) { return []; }
  }
  // Tarifas marítimas de la base madre (SIN NEGOCIAR y Negociado), también las cargadas a mano, para la menor de la ronda
  function baseRondaMar(cfg) {
    var out = [];
    [cfg.marIni, cfg.marNeg].forEach(function (nombre) {
      if (!nombre) return;
      try {
        var hoja = abrirDestino({ url: cfg.baseUrl }, nombre), enc = mapearEncabezados(hoja, MAPA_MARITIMO);
        if (!enc || !enc.mapa.flete || !enc.mapa.pol || !enc.mapa.desde) return;
        var M = enc.mapa, ultima = hoja.getLastRow(), inicio = Math.max(enc.fila + 1, ultima - 3999);
        if (ultima < inicio) return;
        hoja.getRange(inicio, 1, ultima - inicio + 1, hoja.getLastColumn()).getValues().forEach(function (r) {
          var v = function (c) { return M[c] ? r[M[c] - 1] : ''; }, flete = num(v('flete'));
          if (!(flete > 0) || !(v('desde') instanceof Date)) return;
          var d = aDia(v('desde')), h = v('hasta') instanceof Date ? aDia(v('hasta')) : d + 14 * 86400000;
          out.push({ pol: claveTexto(v('pol')), pod: claveTexto(v('pod')), ctnr: tipoCtnr(v('ctnr')), desde: d, hasta: h, valor: flete,
            agente: String(v('ffww') || '').trim(), linea: String(v('linea') || '').trim(), polTxt: String(v('pol') || '').trim(), podTxt: String(v('pod') || '').trim(), fuente: 'base madre · ' + nombre });
        });
      } catch (e) { }
    });
    return out;
  }
  function medianaMar(hist, x) {
    var d0 = aDia(x[K.desde]), min = d0 - 180 * 86400000, pol = claveTexto(x[K.origen]), pod = claveTexto(x[K.destino]);
    return mediana(hist.filter(function (h) { return h.pol === pol && (!h.pod || h.pod === pod) && h.ctnr === x[K.ctnr] && h.desde < d0 && h.desde >= min; })
      .map(function (h) { return h.valor; }));
  }
  function medianaAir(datos, vig, x) {
    var d0 = aDia(x[K.desde]), min = d0 - 84 * 86400000;
    return mediana(vig.map(function (j) { return datos[j]; }).filter(function (y) {
      return y[K.modo] === MODO.AIR && claveTexto(y[K.origen]) === claveTexto(x[K.origen]) && claveTexto(y[K.destino]) === claveTexto(x[K.destino]) &&
        aDia(y[K.hasta]) < d0 && aDia(y[K.desde]) >= min;
    }).map(function (y) { return num(y[K.flete]); }));
  }


  /* ------------------------------------------------------------------ */
  /* Panel de tarifas: un solo lugar con KPIs, mejores tarifas, ranking   */
  /* de agentes, evolución y pendientes. Lee la base madre y el Tarifador. */
  /* ------------------------------------------------------------------ */
  function abrirPanel() {
    var html = HtmlService.createHtmlOutputFromFile('TarifadorPanel').setWidth(1320).setHeight(860);
    SpreadsheetApp.getUi().showModalDialog(html, 'Panel de tarifas BIDCOM');
  }
  // Números de la planilla: pueden venir como número o como texto "USD3.395,00"
  function numBase(v) {
    if (typeof v === 'number') return v;
    var t = String(v === null || v === undefined ? '' : v).replace(/[^0-9,.\-]/g, '');
    if (!t) return NaN;
    if (t.indexOf(',') >= 0) t = t.replace(/\./g, '').replace(',', '.');
    else if (/^-?\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');
    var n = Number(t); return isNaN(n) ? NaN : n;
  }
  var FILAS_PANEL = 6000;
  function leerBasePanel(cfg, nombre, tipo, mapaDef, desdeMin, aereo) {
    if (!nombre) return { filas: [] };
    try {
      var hoja = abrirDestino({ url: cfg.baseUrl }, nombre), enc = mapearEncabezados(hoja, mapaDef);
      if (!enc) return { filas: [], error: 'No encontré los encabezados en "' + nombre + '".' };
      var M = enc.mapa, ultima = hoja.getLastRow(), inicio = Math.max(enc.fila + 1, ultima - FILAS_PANEL + 1);
      if (ultima < inicio) return { filas: [] };
      var datos = hoja.getRange(inicio, 1, ultima - inicio + 1, hoja.getLastColumn()).getValues(), filas = [];
      datos.forEach(function (r, i) {
        var v = function (c) { return M[c] ? r[M[c] - 1] : ''; };
        var desde = aereo ? v('vigDesde') : v('desde'), hasta = aereo ? v('vigencia') : v('hasta');
        if (!(desde instanceof Date) || desde.getTime() < desdeMin) return;
        var precio, extra = '';
        if (aereo) {
          precio = numBase(v('allin'));
          if (!(precio > 0)) { var base = numBase(v('r100')) || numBase(v('r300')) || numBase(v('r500')); precio = base > 0 ? base + (numBase(v('fuel')) || 0) : NaN; }
          extra = numBase(v('destinoUsd'));
        } else {
          var flete = numBase(v('flete'));
          precio = flete > 0 ? flete + (numBase(v('imo')) || 0) : NaN;
          extra = numBase(v('locales'));
        }
        if (!(precio > 0)) return;
        var agente = String(aereo ? v('agente') : v('ffww')).trim();
        if (!agente) return;
        filas.push([tipo, agente, String(aereo ? v('origen') : v('pol')).trim(), String(aereo ? v('destino') : v('pod')).trim(),
          String(aereo ? v('aerolinea') : v('linea')).trim(), aereo ? '' : tipoCtnr(v('ctnr')), fecha(desde), hasta instanceof Date ? fecha(hasta) : '',
          Math.round(precio * 100) / 100, isNaN(extra) ? '' : extra, inicio + i]);
      });
      return { filas: filas };
    } catch (e) { return { filas: [], error: nombre + ': ' + (e && e.message || e) }; }
  }
  // El panel solo lo usan editores de la planilla. Como el formulario de agentes vive en el mismo proyecto,
  // se corta cualquier llamada que no venga de un editor identificado (por ejemplo, desde el link de un agente).
  function exigirEditor() {
    var mail = String(Session.getActiveUser().getEmail() || '').toLowerCase();
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var editores = ss.getEditors().map(function (u) { return String(u.getEmail() || '').toLowerCase(); });
    try { editores.push(String(ss.getOwner().getEmail() || '').toLowerCase()); } catch (e) { }
    if (!mail || editores.indexOf(mail) < 0) throw new Error('Sin permiso: el panel es solo para el team de BIDCOM.');
  }
  function datosPanel() {
    exigirEditor();
    var cfg = leerAjustes(), hoy = new Date(), desdeMin = hoy.getTime() - 400 * 86400000, errores = [];
    var junta = function (lista) { var out = []; lista.forEach(function (x) { if (x.error) errores.push(x.error); out = out.concat(x.filas); }); return out; };
    var mar = junta([leerBasePanel(cfg, cfg.marIni, 'Inicial', MAPA_MARITIMO, desdeMin, false), leerBasePanel(cfg, cfg.marNeg, 'Negociada', MAPA_MARITIMO, desdeMin, false)]);
    var air = junta([leerBasePanel(cfg, cfg.airIni, 'Inicial', MAPA_AEREO, desdeMin, true), leerBasePanel(cfg, cfg.airNeg, 'Negociada', MAPA_AEREO, desdeMin, true)]);
    var pend = [], estados = {};
    try {
      var sh = hojaCotiz();
      valoresCotiz(sh).forEach(function (x, i) {
        if (!x[K.id]) return;
        if (x[K.vigente] === 'SI') estados[x[K.estado]] = (estados[x[K.estado]] || 0) + 1;
        if (x[K.vigente] !== 'SI' || (x[K.estado] !== ESTADOS.REVISAR && x[K.estado] !== ESTADOS.RESPUESTA)) return;
        pend.push([i + 2, String(x[K.id]), x[K.recibido] instanceof Date ? fechaHora(x[K.recibido]) : String(x[K.recibido]), x[K.modo] === MODO.AIR ? 'air' : 'mar',
          String(x[K.ffww]), String(x[K.origen]), String(x[K.destino]), String(x[K.carrier]), String(x[K.ctnr] || ''), numBase(x[K.flete]) || '',
          numBase(x[K.vsMenor]), String(x[K.semaforo] || ''), String(x[K.estado]), String(x[K.tipo] || ''), String(x[K.decision] || '')]);
      });
    } catch (e) { errores.push(String(e && e.message || e)); }
    return {
      hoy: fecha(hoy), mar: mar, air: air, pend: pend, estados: estados, errores: errores,
      agentes: cfg.agentes.filter(function (a) { return a.activo; }).map(function (a) { return a.nombre; }),
      hojas: { marIni: cfg.marIni, marNeg: cfg.marNeg, airIni: cfg.airIni, airNeg: cfg.airNeg, cotiz: HOJA.COTIZ }, diasAviso: cfg.diasAviso
    };
  }
  function irAFila(nombre, fila) {
    exigirEditor();
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var hoja = ss.getSheetByName(nombre);
    if (!hoja) return false;
    ss.setActiveSheet(hoja); hoja.setActiveRange(hoja.getRange(fila, 1, 1, Math.max(1, hoja.getLastColumn())));
    return true;
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
    var enc = ['Ruta', mar ? 'Naviera' : 'Aerolínea'].concat(mar ? ['Contenedor'] : []).concat([mar ? 'Flete USD/ctnr' : 'Flete USD/kg', 'Menor de la ronda', 'Vs la menor', 'Vs histórico', 'Target sugerido']).concat(neg ? ['Ahorro vs inicial'] : []);
    var tabla = filas.map(function (f) {
      var sem = f[K.semaforo];
      return [f[K.origen] + ' → ' + f[K.destino], f[K.carrier]].concat(mar ? [f[K.ctnr]] : [])
        .concat([valorTxt(f[K.flete], mar), f[K.menor] || '—', f[K.menor] ? '—' : pctTxt(f[K.vsMenor]),
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
      agentesMejora[x[K.ffww]] = true;
    });
    if (!pend.length) { ui.alert('No hay decisiones nuevas.\n\nEn "' + HOJA.COTIZ + '" elegí Aprobar, Pedir mejora o Descartar en la columna "Decisión del team" de las filas que quieras resolver.'); return; }
    var nAg = Object.keys(agentesMejora).length;
    if (!confirmar('Vas a registrar:\n• ' + cuenta.Aprobar + ' aprobada(s)\n• ' + cuenta['Pedir mejora'] + ' pedido(s) de mejora\n• ' + cuenta.Descartar + ' descartada(s)\n\nSe manda un mail a ' + nAg + ' agente(s) con su devolución' + (cfg.teamMails.length ? ', con copia a ' + cfg.teamMails.join(', ') : '') + '.\n\n¿Seguimos?')) return;
    var lock = LockService.getScriptLock(); lock.waitLock(20000);
    var porAgente = {}, ahora = new Date();
    try {
      pend.forEach(function (p) {
        var x = datos[p.i], fila = p.i + 2, est = p.d === 'Aprobar' ? ESTADOS.APROBADA : p.d === 'Pedir mejora' ? ESTADOS.PEDIDA : ESTADOS.DESCARTADA, txt = 'Team: ' + p.d.toLowerCase();
        if (p.d === 'Pedir mejora') {
          if (!(num(x[K.targetPedir]) > 0) && num(x[K.target]) > 0) { x[K.targetPedir] = x[K.target]; sh.getRange(fila, K.targetPedir + 1).setValue(x[K.target]); }
          txt += num(x[K.targetPedir]) > 0 ? ' (objetivo ' + valorTxt(x[K.targetPedir], x[K.modo] === MODO.MAR) + ')' : '';
        }
        (porAgente[x[K.ffww]] = porAgente[x[K.ffww]] || []).push({ x: x, d: p.d });
        sh.getRange(fila, K.estado + 1).setValue(est); sh.getRange(fila, K.enviada + 1).setValue(ahora);
        x[K.estado] = est; x[K.enviada] = ahora;
        x[K.historial] = agregarHistorial(sh, fila, x[K.historial], txt + (x[K.mensaje] ? ' · "' + x[K.mensaje] + '"' : ''));
      });
    } finally { lock.releaseLock(); }
    var ag = agentesPorNombre(), sinMail = [], enviados = 0;
    Object.keys(porAgente).forEach(function (nombre) {
      var a = ag[nombre];
      if (!a || !a.email) { sinMail.push(nombre); return; }
      mailDecisiones(cfg, a, porAgente[nombre]); enviados++;
    });
    registrar('BIDCOM', 'Envió decisiones', cuenta.Aprobar + ' aprobada(s), ' + cuenta['Pedir mejora'] + ' pedido(s) de mejora, ' + cuenta.Descartar + ' descartada(s). Mails: ' + enviados);
    ui.alert('Listo. ' + (enviados ? 'Se mandó la devolución a ' + enviados + ' agente(s), con copia al team. ' : '') +
      (sinMail.length ? '\n\nSin email cargado (mandales el pedido a mano o completá su email): ' + sinMail.join(', ') + '. Igual van a ver el pedido al entrar con su link.' : ''));
  }

  // Devolución al agente: un solo mail con lo aprobado, la mejora pedida y lo no seleccionado. Copia al team.
  function mailDecisiones(cfg, agente, items) {
    var grupos = { 'Pedir mejora': [], Aprobar: [], Descartar: [] };
    items.forEach(function (it) { grupos[it.d].push(it.x); });
    var tabla = function (fs, objetivo) {
      var porModo = {}, out = '';
      fs.forEach(function (f) { (porModo[f[K.modo]] = porModo[f[K.modo]] || []).push(f); });
      Object.keys(porModo).forEach(function (m) {
        var mar = m === MODO.MAR, enc = ['Ruta', mar ? 'Naviera' : 'Aerolínea'].concat(mar ? ['Contenedor'] : []).concat(['Vigencia', objetivo ? 'Tu flete actual' : 'Flete'])
          .concat(objetivo && cfg.mostrarTarget ? ['Flete objetivo'] : []).concat(['Comentario']);
        out += '<p style="margin:10px 0 0"><b>' + esc(m) + '</b></p>' + htmlTabla(enc, porModo[m].map(function (f) {
          return [f[K.origen] + ' → ' + f[K.destino], f[K.carrier]].concat(mar ? [f[K.ctnr]] : []).concat([fechaCorta(f[K.desde]) + ' al ' + fechaCorta(f[K.hasta]), valorTxt(f[K.flete], mar)])
            .concat(objetivo && cfg.mostrarTarget ? [valorTxt(f[K.targetPedir], mar)] : []).concat([f[K.mensaje] || '']);
        })) + '<p style="font-size:12px;color:#5b6876">' + (mar ? 'Flete por contenedor, sin Recarga IMO, Locales ARG ni gastos en origen.' : 'Flete USD/kg a ' + cfg.peso + ' kg, sin fuel, IMO ni gastos.') + '</p>';
      });
      return out;
    };
    var cuerpo = '<p>Hola ' + esc(agente.nombre) + ':</p><p>Gracias por tu cotización. Te compartimos la devolución del team de BIDCOM.</p>';
    if (grupos.Aprobar.length) cuerpo += '<h3 style="margin:18px 0 0;color:#1e7a3c">Tarifas aprobadas</h3><p style="margin:4px 0">Quedan aprobadas para la vigencia indicada.</p>' + tabla(grupos.Aprobar, false);
    if (grupos['Pedir mejora'].length) cuerpo += '<h3 style="margin:18px 0 0;color:#0B5F8A">Te pedimos mejorar</h3>' + tabla(grupos['Pedir mejora'], true) +
      '<p>Cargá la tarifa mejorada desde tu link personal (el de siempre). Tu cotización aparece precargada: cambiá lo que mejores y enviá.</p>' + htmlBoton(linkDe(agente), 'Cargar tarifa mejorada');
    if (grupos.Descartar.length) cuerpo += '<h3 style="margin:18px 0 0;color:#5b6876">No seleccionadas en esta ronda</h3><p style="margin:4px 0">En esta oportunidad no avanzamos con estas tarifas. Te vamos a seguir pidiendo cotización en las próximas vigencias.</p>' + tabla(grupos.Descartar, false);
    cuerpo += '<p>Cualquier duda, respondé este mail.</p><p>¡Gracias!<br>Equipo de Logística Internacional – BIDCOM</p>';
    var asunto = grupos['Pedir mejora'].length ? 'BIDCOM · Pedido de mejora de tarifas' + (grupos.Aprobar.length || grupos.Descartar.length ? ' y devolución de tu cotización' : '') :
      grupos.Aprobar.length && !grupos.Descartar.length ? 'BIDCOM · Tarifas aprobadas' : 'BIDCOM · Devolución de tu cotización';
    mandarMail({ to: agente.email, cc: cfg.teamMails.join(','), replyTo: cfg.teamMails[0] || '', subject: asunto, html: htmlEnvolver(cuerpo) });
  }
  function mailPedidoMejora(cfg, agente, filas) { mailDecisiones(cfg, agente, filas.map(function (x) { return { x: x, d: 'Pedir mejora' }; })); }

  /* ------------------------------------------------------------------ */
  /* Aviso de vencimiento: N días antes, al agente y con copia al team    */
  /* ------------------------------------------------------------------ */
  function activarAvisos() {
    ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'tarifadorAvisarVencimientos') ScriptApp.deleteTrigger(t); });
    ScriptApp.newTrigger('tarifadorAvisarVencimientos').timeBased().everyDays(1).atHour(8).create();
    var cfg = leerAjustes();
    registrar('BIDCOM', 'Activó el aviso diario de vencimientos', cfg.diasAviso + ' días antes');
    SpreadsheetApp.getUi().alert('Listo. Todos los días a las 8 se revisan las vigencias. A los agentes cuya tarifa vence en ' + cfg.diasAviso +
      ' días o menos (y no cargaron una nueva) les llega un mail con su link' + (cfg.teamMails.length ? ', con copia a ' + cfg.teamMails.join(', ') : '') + '.');
  }
  function avisarVencimientosMenu() {
    var n = avisarVencimientos();
    SpreadsheetApp.getUi().alert(n ? 'Se mandaron ' + n + ' mail(s): pedidos por vencimiento, recordatorios o resúmenes de cierre.' : 'No hay pedidos, recordatorios ni cierres pendientes.');
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
      var abiertos = leerPedidos().filter(function (p) { return !p.cerrado && !p.respondio && p.agente === a.nombre && p.modo === g.modo && aDia(new Date(p.limite)) >= hoy; });
      if (abiertos.length) return;                                         // ya hay un pedido en curso (por ejemplo, lanzado a mano)
      var hasta = datos[filas[0]][K.hasta], dHasta = aFecha(hasta);
      var desde = new Date(dHasta.getFullYear(), dHasta.getMonth(), dHasta.getDate() + 1);
      var limite = new Date(Math.max(aDia(new Date()), new Date(dHasta.getFullYear(), dHasta.getMonth(), dHasta.getDate() - 1).getTime()));
      if (!a.email && !cfg.teamMails.length) { registrar('Sistema', 'No se pudo pedir tarifas', g.ffww + ': sin email del agente ni del team'); return; }
      mailPedido(cfg, a, g.modo, desde, limite, hasta, false);
      guardarPedidos(leerPedidos().concat([{ lote: 'V' + fecha(new Date()), origen: 'Vencimiento', creado: Date.now(), modo: g.modo, agente: a.nombre, desde: desde.getTime(), limite: limite.getTime() }]));
      var marca = 'Avisado ' + fechaHora(new Date()) + (a.email ? '' : ' (al team, sin email del agente)');
      filas.forEach(function (i) { sh.getRange(i + 2, K.aviso + 1).setValue(marca); datos[i][K.aviso] = marca; });
      registrar('Sistema', 'Pedido de tarifas (vencimiento)', g.ffww + ' · ' + g.modo + ' · vence ' + fechaCorta(hasta) + ' · límite ' + fechaCorta(limite));
      enviados++;
    });
    try { enviados += procesarPedidos(cfg); } catch (eP) { registrar('Sistema', 'Error en los pedidos de tarifas', String(eP && eP.message || eP)); }
    try { enviados += avisarVencimientoGastos(cfg); } catch (eG) { registrar('Sistema', 'Error en el aviso de gastos en origen', String(eG && eG.message || eG)); }
    return enviados;
  }

  /* ------------------------------------------------------------------ */
  /* Pedidos de tarifas: automático (N días antes del vencimiento) o     */
  /* manual desde el menú. Recordatorio antes de la fecha límite y       */
  /* resumen al team al cerrar. Se guardan en las propiedades del script. */
  /* ------------------------------------------------------------------ */
  var PROP_PEDIDOS = 'TARIFADOR_PEDIDOS';
  function leerPedidos() { try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(PROP_PEDIDOS) || '[]'); } catch (e) { return []; } }
  function guardarPedidos(l) {
    var corte = Date.now() - 60 * 86400000;
    l = l.filter(function (p) { return !p.cerrado || p.limite > corte; });
    PropertiesService.getScriptProperties().setProperty(PROP_PEDIDOS, JSON.stringify(l));
  }
  function modoTxt(m) { return m === MODO.MAR ? 'marítimas' : 'aéreas'; }
  // El mail del pedido. recordatorio = versión corta. vence = fecha en que vence la tarifa actual (solo pedidos automáticos)
  function mailPedido(cfg, a, modo, desde, limite, vence, recordatorio) {
    var mar = modo === MODO.MAR, desdeTxt = desde ? fechaLarga(desde) : '', limTxt = fechaLarga(limite), html;
    if (recordatorio) {
      html = '<p>Hola ' + esc(a.nombre) + ':</p><p>Todavía no recibimos tus tarifas <b>' + modoTxt(modo) + '</b>' + (desdeTxt ? ' desde el <b>' + esc(desdeTxt) + '</b>' : '') +
        '. Te recordamos que la fecha límite es el <b>' + esc(limTxt) + '</b>.</p>' + htmlBoton(linkDe(a), 'Cargar tarifas') +
        '<p>Si no tenés tarifa para alguna ruta, dejala sin cargar. Cualquier duda respondé este mail.</p><p>¡Gracias!<br>Equipo de Logística Internacional – BIDCOM</p>';
    } else {
      html = '<p>Hola ' + esc(a.nombre) + ':</p>' +
        (vence ? '<p>Las tarifas ' + modoTxt(modo) + ' que tenemos cargadas de ' + esc(a.nombre) + ' vencen el <b>' + esc(fechaLarga(vence)) + '</b>. ' : '<p>') +
        'Te pedimos que nos envíes tus tarifas ' + modoTxt(modo) + (desdeTxt ? ' con vigencia desde el <b>' + esc(desdeTxt) + '</b>' : '') + '.</p>' +
        '<p style="font-size:15px"><b>Fecha límite para enviarlas: ' + esc(limTxt) + '.</b></p>' +
        '<p>Cargalas en tu cotizador, a mano o subiendo el template de Excel:</p>' + htmlBoton(linkDe(a), 'Ir a mi cotizador') +
        '<p>Para tener en cuenta:</p><ul><li>Completá todos los campos obligatorios: si falta alguno, el cotizador no te deja enviar.</li>' +
        '<li>Incluí tus gastos en origen.' + (mar ? ' Los gastos en origen negociados tienen una validez de 1 mes.' : '') + '</li>' +
        '<li>Si no tenés tarifa para alguna ruta, dejala sin cargar.</li></ul>' +
        '<p>Cualquier duda, respondé este mail.</p><p>¡Gracias!<br>Equipo de Logística Internacional – BIDCOM</p>';
    }
    if (!a.email) html += '<p style="color:#b3261e"><b>Para el team:</b> este agente no tiene email cargado en ' + esc(HOJA.AJUSTES) + '. Reenviale este mail.</p>';
    var asunto = 'BIDCOM | ' + (recordatorio ? 'Recordatorio: pedido' : 'Pedido') + ' de tarifas ' + modoTxt(modo) + (desdeTxt ? ' – vigencia desde el ' + desdeTxt : '') + (recordatorio ? ' (límite ' + fechaCorta(limite) + ')' : '');
    mandarMail({ to: a.email || cfg.teamMails.join(','), cc: a.email ? cfg.teamMails.join(',') : '', replyTo: cfg.teamMails[0] || '', subject: asunto, html: htmlEnvolver(html) });
  }
  // ¿El agente mandó algo de ese modo después de recibir el pedido?
  function respondioPedido(datos, p) {
    return datos.some(function (x) { return x[K.ffww] === p.agente && x[K.modo] === p.modo && x[K.recibido] instanceof Date && x[K.recibido].getTime() >= p.creado; });
  }
  function procesarPedidos(cfg) {
    var lista = leerPedidos(); if (!lista.length) return 0;
    var datos = valoresCotiz(hojaCotiz()), hoy = aDia(new Date()), ag = agentesPorNombre(), enviados = 0, cerrar = {};
    lista.forEach(function (p) {
      if (p.cerrado) return;
      if (!p.respondio && respondioPedido(datos, p)) p.respondio = fechaHora(new Date());
      var dias = Math.round((aDia(new Date(p.limite)) - hoy) / 86400000), a = ag[p.agente];
      var hoyTxt = fecha(new Date());
      if (cfg.recordatorioDiario && !p.respondio && dias >= 0 && aDia(new Date(p.creado)) < hoy && String(p.recordado || '').slice(0, 10) !== hoyTxt && a && a.activo && (a.email || cfg.teamMails.length)) {
        mailPedido(cfg, a, p.modo, p.desde ? new Date(p.desde) : null, new Date(p.limite), null, true);
        p.recordado = fechaHora(new Date()); p.recordatorios = (p.recordatorios || 0) + 1; enviados++;
        registrar('Sistema', 'Recordatorio de pedido de tarifas', p.agente + ' · ' + p.modo + ' · límite ' + fechaCorta(new Date(p.limite)));
      }
      if (dias < 0) (cerrar[p.lote + '|' + p.limite] = cerrar[p.lote + '|' + p.limite] || []).push(p);
    });
    Object.keys(cerrar).forEach(function (k) {
      var ps = cerrar[k], si = ps.filter(function (p) { return p.respondio; }), no = ps.filter(function (p) { return !p.respondio; });
      if (cfg.teamMails.length) {
        var fila = function (p) { return [p.agente, p.modo, p.respondio || (p.recordatorios ? 'No (' + p.recordatorios + ' recordatorio' + (p.recordatorios === 1 ? '' : 's') + ')' : 'No')]; };
        mandarMail({ to: cfg.teamMails.join(','), subject: 'BIDCOM | Cierre del pedido de tarifas (límite ' + fechaCorta(new Date(ps[0].limite)) + '): ' + si.length + ' cotizaron, ' + no.length + ' no',
          html: htmlEnvolver('<p>Cerró el pedido de tarifas' + (ps[0].origen === 'Manual' ? ' lanzado el ' + fechaLarga(new Date(ps[0].creado)) : ' por vencimiento') + ' con fecha límite ' + esc(fechaLarga(new Date(ps[0].limite))) + '.</p>' +
            (no.length ? '<p><b>No cotizaron (' + no.length + '):</b></p>' + htmlTabla(['Agente', 'Modo', 'Cotizó'], no.map(fila)) : '<p><b>Cotizaron todos.</b></p>') +
            (si.length ? '<p><b>Cotizaron (' + si.length + '):</b></p>' + htmlTabla(['Agente', 'Modo', 'Recibido'], si.map(fila)) : '') +
            '<p style="font-size:12px;color:#5b6876">Para volver a pedirle a quien no cotizó: menú Tarifador BIDCOM > Pedir tarifas a agentes activos.</p>') });
        enviados++;
      }
      ps.forEach(function (p) { p.cerrado = fechaHora(new Date()); });
      registrar('Sistema', 'Cierre de pedido de tarifas', si.length + ' cotizaron · no: ' + (no.map(function (p) { return p.agente + ' (' + p.modo + ')'; }).join(', ') || 'ninguno'));
    });
    guardarPedidos(lista);
    return enviados;
  }
  // Hasta cuándo tiene tarifa cargada cada agente, por modo: base madre (iniciales y negociadas) + TARIFADOR Cotizaciones
  function coberturaAgentes(cfg) {
    var cob = {}, desdeMin = Date.now() - 180 * 86400000;
    var anotar = function (agente, modo, hasta) {
      var k = claveTexto(agente); if (!k || !hasta) return;
      var c = cob[k] = cob[k] || {}; if (!c[modo] || hasta > c[modo]) c[modo] = hasta;
    };
    [[cfg.marIni, MAPA_MARITIMO, false], [cfg.marNeg, MAPA_MARITIMO, false], [cfg.airIni, MAPA_AEREO, true], [cfg.airNeg, MAPA_AEREO, true]].forEach(function (t) {
      leerBasePanel(cfg, t[0], '', t[1], desdeMin, t[2]).filas.forEach(function (f) { anotar(f[1], t[2] ? MODO.AIR : MODO.MAR, f[7]); });
    });
    try { valoresCotiz(hojaCotiz()).forEach(function (x) { if (x[K.vigente] === 'SI' && x[K.hasta] instanceof Date) anotar(x[K.ffww], x[K.modo], fecha(x[K.hasta])); }); } catch (e) { }
    return cob;
  }
  function abrirPedido() {
    var cfg = leerAjustes(), act = cfg.agentes.filter(function (a) { return a.activo; }), cob = coberturaAgentes(cfg);
    var hoy = new Date(), lim = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() + 3), desde = new Date(lim.getFullYear(), lim.getMonth(), lim.getDate() + 1);
    var iso = function (d) { return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd'); };
    var ags = act.map(function (a) { var c = cob[claveTexto(a.nombre)] || {}; return { n: a.nombre, e: a.email, mar: c[MODO.MAR] || '', air: c[MODO.AIR] || '' }; });
    var html = '<div style="font:14px Arial,sans-serif;color:#15212e;box-sizing:border-box">' +
      '<style>*{box-sizing:border-box}input,select{font:inherit}.ok{color:#1e7a3c}.no{color:#b3261e;font-weight:bold}.s{color:#5b6876;font-size:12px}</style>' +
      '<p style="margin:0 0 10px">Quedan tildados solo los agentes activos <b>sin tarifa cargada</b> para esa vigencia (base madre y Tarifador). Les llega un mail con su link y la fecha límite, con copia al team.</p>' +
      '<label><b>Modo</b><br><select id="m" style="width:100%;padding:6px;margin:4px 0 10px"><option>Marítimo</option><option>Aéreo</option><option value="Ambos">Marítimo y aéreo</option></select></label>' +
      '<div style="display:flex;gap:10px"><label style="flex:1"><b>Vigencia desde</b><br><input type="date" id="d" value="' + iso(desde) + '" style="width:100%;padding:5px;margin:4px 0 10px"></label>' +
      '<label style="flex:1"><b>Fecha límite</b><br><input type="date" id="l" value="' + iso(lim) + '" style="width:100%;padding:5px;margin:4px 0 10px"></label></div>' +
      '<b>Agentes activos</b> <span class="s" id="cuenta"></span><div id="lista" style="max-height:210px;overflow:auto;border:1px solid #ddd;border-radius:6px;padding:6px;margin:4px 0 12px"></div>' +
      '<button id="b" style="background:#0B5F8A;color:#fff;border:0;border-radius:6px;padding:9px 16px;font-weight:bold;cursor:pointer">Enviar pedido</button> <span id="r" style="margin-left:8px"></span></div>' +
      '<script>var HOY="' + iso(hoy) + '",AG=' + JSON.stringify(ags).replace(/</g, '\\u003c') + ';' +
      'function fc(s){var x=s.split("-");return x[2]+"/"+x[1];}function esc(t){return String(t).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c];});}' +
      'function pinta(){var m=document.getElementById("m").value,d=document.getElementById("d").value,ms=m==="Ambos"?["mar","air"]:[m==="Aéreo"?"air":"mar"],falt=0;' +
      'document.getElementById("lista").innerHTML=AG.map(function(a,i){var fal=ms.filter(function(k){return !a[k]||a[k]<d;});if(fal.length)falt++;' +
      'var est=ms.map(function(k){var nom=k==="mar"?"Marítimo":"Aéreo";return a[k]&&a[k]>=d?"<span class=ok>"+nom+": vigente hasta "+fc(a[k])+"</span>":"<span class=no>"+nom+": "+(a[k]?(a[k]<HOY?"venció el ":"vence el ")+fc(a[k]):"sin tarifa cargada")+"</span>";}).join(" · ");' +
      'return "<label style=\\"display:block;padding:4px 0;border-bottom:1px solid #f0f0f0\\"><input type=checkbox class=ag data-i="+i+" data-m=\\""+fal.join(",")+"\\""+(fal.length?" checked":"")+"> <b>"+esc(a.n)+"</b> <span class=s>"+(a.e?esc(a.e):"sin email: va al team")+"</span><br><span style=\\"margin-left:22px;font-size:12px\\">"+est+"</span></label>";}).join("");' +
      'document.getElementById("cuenta").textContent="("+falt+" de "+AG.length+" sin tarifa)";}' +
      'document.getElementById("m").onchange=pinta;document.getElementById("d").onchange=pinta;pinta();' +
      'document.getElementById("b").onclick=function(){var m=document.getElementById("m").value,todos=m==="Ambos"?["mar","air"]:[m==="Aéreo"?"air":"mar"];' +
      'var ags=[].slice.call(document.querySelectorAll(".ag:checked")).map(function(x){var f=x.getAttribute("data-m");return {nombre:AG[+x.getAttribute("data-i")].n,modos:(f?f.split(","):todos).map(function(k){return k==="air"?"Aéreo":"Marítimo";})};});' +
      'var d={modo:m,desde:document.getElementById("d").value,limite:document.getElementById("l").value,agentes:ags};' +
      'if(!ags.length){document.getElementById("r").textContent="Marcá al menos un agente.";return;}if(!d.limite){document.getElementById("r").textContent="Falta la fecha límite.";return;}' +
      'this.disabled=true;document.getElementById("r").textContent="Enviando…";google.script.run.withSuccessHandler(function(n){document.getElementById("r").textContent="Listo: "+n+" mail(s) enviados.";setTimeout(function(){google.script.host.close();},2500);})' +
      '.withFailureHandler(function(e){document.getElementById("b").disabled=false;document.getElementById("r").textContent="Error: "+e.message;}).tarifadorPedirTarifas(d);};</script>';
    SpreadsheetApp.getUi().showModalDialog(HtmlService.createHtmlOutput(html).setWidth(560).setHeight(560), 'Pedir tarifas a agentes activos');
  }
  function pedirTarifas(d) {
    exigirEditor();
    var cfg = leerAjustes(), ag = agentesPorNombre(), p = function (s) { var x = String(s || '').split('-'); return x.length === 3 ? new Date(+x[0], +x[1] - 1, +x[2]) : null; };
    var desde = p(d.desde), limite = p(d.limite); if (!limite) throw new Error('Falta la fecha límite.');
    if (aDia(limite) < aDia(new Date())) throw new Error('La fecha límite ya pasó.');
    var modos = d.modo === 'Ambos' ? [MODO.MAR, MODO.AIR] : [d.modo === MODO.AIR ? MODO.AIR : MODO.MAR], lote = 'M' + Date.now(), nuevos = [], n = 0;
    (d.agentes || []).forEach(function (x) {
      var a = ag[typeof x === 'string' ? x : x.nombre]; if (!a || !a.activo || (!a.email && !cfg.teamMails.length)) return;
      var ms = x && x.modos && x.modos.length ? x.modos.filter(function (m) { return modos.indexOf(m) >= 0; }) : modos;
      ms.forEach(function (m) {
        mailPedido(cfg, a, m, desde, limite, null, false); n++;
        nuevos.push({ lote: lote, origen: 'Manual', creado: Date.now(), modo: m, agente: a.nombre, desde: desde ? desde.getTime() : null, limite: limite.getTime() });
      });
    });
    guardarPedidos(leerPedidos().concat(nuevos));
    registrar(Session.getActiveUser().getEmail() || 'BIDCOM', 'Pedido de tarifas (manual)', d.modo + ' · desde ' + (desde ? fechaCorta(desde) : '-') + ' · límite ' + fechaCorta(limite) + ' · ' + (d.agentes || []).map(function (x) { return typeof x === 'string' ? x : x.nombre + ' (' + x.modos.join('/') + ')'; }).join(', '));
    return n;
  }

  /* ------------------------------------------------------------------ */
  /* Gastos en origen marítimos → base de gastos (Concatenado de GS)      */
  /* Una fila por agente, puerto, contenedor y concepto. Si existe una    */
  /* sola fila igual se actualiza (valor, tipo y validez); si no, se agrega. */
  /* ------------------------------------------------------------------ */
  var CONCEPTO_BASE = { 'HANDLINGFEE': 'Handling fee', 'VGMPESADA': 'VGM - Pesada', 'EIR': 'EIR - Doc conf entrega recp cont', 'SEALPRECINTO': 'SEAL - Sellos Seg/Prec',
    'ORCTHC': 'ORC - Manip/Recp Merc', 'TELEXRELEASEFEE': 'Telex release Fee', 'DOCUMENTATIONFEE': 'Gestion y emision de doc de la operacion', 'DGFEE': 'DG fee',
    'PICKUPFEEEXW': 'Pick up Fee EXW', 'WAREHOUSEFEE': 'Warehouse Fee', 'CUSTOMSCLEARANCEFEE': 'Customs clearance Fee', 'ISSUECUSTOMSDOCFEE': 'Issue Customs Doc Fee' };
  var UNIDAD_BASE = { 'PORBL': 'POR CANTIDAD DE PROVEEDORES', 'PORCONTENEDOR': 'POR CONTENEDOR', 'POREMBARQUE': 'POR OPERACION', 'PORCBM': 'POR VOLUMEN', 'PORTONELADA': 'POR TONELADA' };
  var MAPA_GASTOS = [['agente', ['AGENTE']], ['puerto', ['PUERTO DE SALIDA', 'PUERTO']], ['tipoCtnr', ['TIPODECONTENEDOR', 'TIPO DE CONTENEDOR']], ['unif', ['CONTENEDOR UNIFICADO']],
    ['concepto', ['CONCEPTO']], ['tipo', ['TIPO']], ['valor', ['VALOR']], ['fijo', ['COSTO FIJO'], true], ['obs', ['OBSERVACIONES']], ['validez', ['VALIDEZ', 'VALDIEZ'], true]];
  function columnasGastos(hoja) {
    var enc = hoja.getRange(1, 1, 1, Math.max(10, hoja.getLastColumn())).getValues()[0], M = {};
    enc.forEach(function (h, j) {
      var k = claveTexto(h); if (!k) return;
      MAPA_GASTOS.forEach(function (m) { if (M[m[0]]) return; m[1].forEach(function (a) { var ka = claveTexto(a); if (!M[m[0]] && (k === ka || (m[2] && k.indexOf(ka) === 0))) M[m[0]] = j + 1; }); });
    });
    if (!M.validez) M.validez = 10;                                    // columna J
    return M;
  }
  function ctnrsGastos(ctnrs) {
    var out = [];
    if (ctnrs.indexOf('20ST') >= 0) out.push(['20ST', '20']);
    if (ctnrs.indexOf('40ST/40HQ') >= 0 || ctnrs.indexOf('40NOR') >= 0) out.push(['40GP/HQ/NOR', '40']);
    return out;
  }
  // Listas desplegables (validación) de cada columna, leídas de una fila con datos. Devuelve {col: [valores]}
  function listasValidacion(hoja, fila, ancho) {
    var out = {};
    try {
      var reglas = hoja.getRange(fila, 1, 1, ancho).getDataValidations()[0] || [], T = SpreadsheetApp.DataValidationCriteria;
      for (var j = 0; j < ancho; j++) {
        var r = reglas[j]; if (!r || typeof r.getCriteriaType !== 'function' || r.getAllowInvalid()) continue;
        var t = r.getCriteriaType(), a = r.getCriteriaValues(), lista = null;
        if (t === T.VALUE_IN_LIST) lista = a[0];
        else if (t === T.VALUE_IN_RANGE) lista = [].concat.apply([], a[0].getValues());
        if (lista) out[j + 1] = lista.map(String).filter(function (x) { return x.trim(); });
      }
    } catch (e) { }
    return out;
  }
  // Ajusta el valor a como está escrito en la lista (mayúsculas, espacios). null = no está en la lista.
  function enLista(listas, col, valor) {
    var l = listas[col]; if (!l || valor === '' || valor === null || valor === undefined) return valor;
    var k = claveTexto(valor); for (var i = 0; i < l.length; i++) if (claveTexto(l[i]) === k) return l[i];
    return null;
  }
  // Valor ajustado a una lista desplegable: igual (sin importar mayúsculas/espacios), alias conocido o abreviatura de la lista. null = no hay equivalente.
  var ALIAS_LISTA = { 'HAPAGLLOYD': 'HAPAG', 'HAPAGLLOYDAG': 'HAPAG', 'YANGMING': 'YML', 'WANHAI': 'WHL', 'HAMBURGSUD': 'HAMBURG SUD', 'CMA': 'CMA CGM', 'MAERSKLINE': 'MAERSK', 'MSK': 'MAERSK',
    'SINGAPORE': 'Singapur', 'HONGKONG': 'Hong Kong', 'BSAS': 'BUENOS AIRES', 'BUENOSAIRESARGENTINA': 'BUENOS AIRES' };
  function ajustarALista(listas, col, valor) {
    var l = listas[col]; if (!l) return valor;
    var r = enLista(listas, col, valor); if (r !== null) return r;
    var k = claveTexto(valor), al = ALIAS_LISTA[k];
    if (al) { r = enLista(listas, col, al); if (r !== null) return r; }
    var mejor = null;
    l.forEach(function (x) { var kx = claveTexto(x); if (kx.length >= 3 && k.indexOf(kx) === 0 && (!mejor || kx.length > claveTexto(mejor).length)) mejor = x; });
    return mejor;
  }
  function sumarMeses(d, m) { return new Date(d.getFullYear(), d.getMonth() + m, d.getDate()); }
  function pegarGastosOrigen(cfg, agente, lineas, id, ahora) {
    if (!cfg.gastosUrl) return 0;
    var rutas = {};
    lineas.forEach(function (l) { if (!l.pegar) return; var r = rutas[l.ruta] = rutas[l.ruta] || { r: l.r, ctnrs: [] }; if (r.ctnrs.indexOf(l.ctnr) < 0) r.ctnrs.push(l.ctnr); });
    if (!Object.keys(rutas).length) return 0;
    var hoja = SpreadsheetApp.openByUrl(cfg.gastosUrl).getSheetByName(cfg.gastosHoja);
    if (!hoja) throw new Error('No existe la pestaña "' + cfg.gastosHoja + '" en la base de gastos en origen.');
    var M = columnasGastos(hoja);
    ['agente', 'puerto', 'tipoCtnr', 'concepto', 'valor'].forEach(function (c) { if (!M[c]) throw new Error('La base de gastos no tiene la columna "' + c + '".'); });
    var ancho = Math.max.apply(null, Object.keys(M).map(function (k) { return M[k]; }));
    var max = hoja.getMaxRows(), datos = max > 1 ? hoja.getRange(2, 1, max - 1, ancho).getValues() : [], ultima = 1;
    datos.forEach(function (r, i) { if (String(r[M.agente - 1]).trim()) ultima = i + 2; });
    datos = datos.slice(0, Math.max(0, ultima - 1));
    var nomAg = agente.nombre;
    datos.some(function (r) { if (claveTexto(r[M.agente - 1]) === claveTexto(agente.nombre)) { nomAg = String(r[M.agente - 1]).trim(); return true; } return false; });
    var fijoDe = {};                                                    // Fijo / Variable más usado para cada concepto
    if (M.fijo) datos.forEach(function (r) {
      var c = claveTexto(r[M.concepto - 1]), f = String(r[M.fijo - 1]).trim(); if (!c || !f) return;
      var o = fijoDe[c] = fijoDe[c] || {}; f = f.charAt(0).toUpperCase() + f.slice(1).toLowerCase(); o[f] = (o[f] || 0) + 1;
    });
    var validez = sumarMeses(ahora, cfg.gastosMeses), nota = 'Tarifador ' + id + ' · enviado ' + fechaLarga(ahora), nuevas = [], actualizadas = 0, rechazos = {};
    var listas = ultima > 1 ? listasValidacion(hoja, ultima, ancho) : {};
    // La columna Agente puede tener una lista: si el agente no está, no se pega nada y se avisa (si no, Google rechaza la fila)
    var agLista = enLista(listas, M.agente, nomAg);
    if (agLista === null) {
      registrar('Sistema', 'No se pegaron los gastos en origen', agente.nombre + ' no está en la lista de la columna Agente de "' + cfg.gastosHoja + '". Agregalo a esa lista y pedile que vuelva a enviar, o cargalos a mano.');
      return 0;
    }
    nomAg = agLista;
    Object.keys(rutas).forEach(function (k) {
      var r = rutas[k].r, puerto = String(r.pol || '').trim().toUpperCase(), tipos = ctnrsGastos(rutas[k].ctnrs);
      (r.gastos || []).forEach(function (g) {
        var valor = num(g.importe); if (valor === '' || isNaN(valor)) return;
        var desc = String(g.descripcion || '').trim(), concepto = CONCEPTO_BASE[claveTexto(g.concepto)] || desc || String(g.concepto).replace(/^Otro:\s*/, '');
        var tipo = UNIDAD_BASE[claveTexto(g.unidad)] || String(g.unidad || '').toUpperCase();
        var fo = fijoDe[claveTexto(concepto)] || {}, fijo = Object.keys(fo).sort(function (a, b) { return fo[b] - fo[a]; })[0] || '';
        tipos.forEach(function (t) {
          var iguales = [];
          datos.forEach(function (x, i) {
            if (claveTexto(x[M.agente - 1]) === claveTexto(agente.nombre) && claveTexto(x[M.puerto - 1]) === claveTexto(puerto) &&
                claveTexto(x[M.tipoCtnr - 1]) === claveTexto(t[0]) && claveTexto(x[M.concepto - 1]) === claveTexto(concepto)) iguales.push(i);
          });
          var pto = enLista(listas, M.puerto, puerto), cpt = enLista(listas, M.concepto, concepto), tp = M.tipo ? enLista(listas, M.tipo, tipo) : tipo, tc = enLista(listas, M.tipoCtnr, t[0]);
          if (pto === null || cpt === null || tp === null || tc === null) {
            rechazos[(pto === null ? 'puerto ' + puerto : '') + (cpt === null ? ' concepto ' + concepto : '') + (tp === null ? ' tipo ' + tipo : '') + (tc === null ? ' contenedor ' + t[0] : '')] = true;
            return;
          }
          if (iguales.length === 1) {
            var fila = iguales[0] + 2, x = datos[iguales[0]];
            hoja.getRange(fila, M.valor).setValue(valor);
            if (M.tipo) hoja.getRange(fila, M.tipo).setValue(tp);
            hoja.getRange(fila, M.validez).setValue(validez).setNumberFormat('dd/MM/yyyy');
            if (M.obs && (!String(x[M.obs - 1]).trim() || /^Tarifador/.test(String(x[M.obs - 1])))) hoja.getRange(fila, M.obs).setValue(nota);
            actualizadas++;
            return;
          }
          var f = []; for (var c = 0; c < ancho; c++) f.push('');
          f[M.agente - 1] = nomAg; f[M.puerto - 1] = pto; f[M.tipoCtnr - 1] = tc; if (M.unif) f[M.unif - 1] = t[1]; f[M.concepto - 1] = cpt;
          if (M.tipo) f[M.tipo - 1] = tp; f[M.valor - 1] = valor; if (M.fijo) f[M.fijo - 1] = fijo; if (M.obs) f[M.obs - 1] = nota; f[M.validez - 1] = validez;
          nuevas.push(f);
        });
      });
    });
    if (nuevas.length) {
      asegurarFila(hoja, ultima + nuevas.length);
      // Si la base tiene un filtro aplicado, Google no deja copiar formato sobre filas filtradas: se sigue sin formato
      try { if (ultima > 1) hoja.getRange(ultima, 1, 1, ancho).copyTo(hoja.getRange(ultima + 1, 1, nuevas.length, ancho), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false); } catch (eFmt) { }
      try { hoja.getRange(ultima + 1, 1, nuevas.length, ancho).setValues(nuevas); }
      catch (eVal) { nuevas.forEach(function (f, j) { hoja.getRange(ultima + 1 + j, 1, 1, ancho).setValues([f]); }); }
      try { hoja.getRange(ultima + 1, M.validez, nuevas.length, 1).setNumberFormat('dd/MM/yyyy'); } catch (eNf) { }
    }
    SpreadsheetApp.flush();                                             // si Google rechaza algo, que falle acá y no al final del envío
    if (Object.keys(rechazos).length) registrar('Sistema', 'Gastos en origen sin pegar', 'No están en las listas de "' + cfg.gastosHoja + '": ' + Object.keys(rechazos).join(', '));
    registrar('Sistema', 'Pegó gastos en origen', nuevas.length + ' fila(s) nueva(s) y ' + actualizadas + ' actualizada(s) en "' + cfg.gastosHoja + '" · válidos hasta ' + fechaLarga(validez));
    return nuevas.length + actualizadas;
  }
  // Aviso de vencimiento de los gastos en origen que cargó el Tarifador (una vez por agente y fecha)
  function avisarVencimientoGastos(cfg) {
    if (!cfg.gastosUrl) return 0;
    var hoja = SpreadsheetApp.openByUrl(cfg.gastosUrl).getSheetByName(cfg.gastosHoja); if (!hoja) return 0;
    var M = columnasGastos(hoja); if (!M.obs || !M.agente) return 0;
    var ultima = hoja.getLastRow(); if (ultima < 2) return 0;
    var ancho = Math.max(M.validez, M.obs, M.agente, M.puerto || 1), datos = hoja.getRange(2, 1, ultima - 1, ancho).getValues(), hoy = aDia(new Date()), porAg = {};
    datos.forEach(function (r) {
      if (!/^Tarifador/.test(String(r[M.obs - 1])) || !(r[M.validez - 1] instanceof Date)) return;
      var k = claveTexto(r[M.agente - 1]), d = aDia(r[M.validez - 1]), a = porAg[k] = porAg[k] || { max: 0, puertos: {} };
      a.max = Math.max(a.max, d); if (M.puerto) a.puertos[String(r[M.puerto - 1]).trim()] = true;
    });
    var ag = {}; cfg.agentes.forEach(function (a) { ag[claveTexto(a.nombre)] = a; });
    var props = PropertiesService.getScriptProperties(), enviados = 0;
    Object.keys(porAg).forEach(function (k) {
      var x = porAg[k], dias = Math.round((x.max - hoy) / 86400000), a = ag[k];
      if (!a || !a.activo || dias < 0 || dias > cfg.diasAviso) return;
      var marca = 'gastosAviso|' + k + '|' + x.max; if (props.getProperty(marca)) return;
      var hasta = new Date(x.max), para = a.email || cfg.teamMails.join(',');
      if (!para) return;
      mandarMail({ to: para, cc: a.email ? cfg.teamMails.join(',') : '', replyTo: cfg.teamMails[0] || '', subject: 'BIDCOM · Tus gastos en origen vencen el ' + fechaCorta(hasta) + ': volvé a cotizarlos',
        html: htmlEnvolver('<p>Hola ' + esc(a.nombre) + ':</p><p>Los <b>gastos en origen</b> que nos cotizaste vencen el <b>' + esc(fechaLarga(hasta)) + '</b>' +
          (dias === 0 ? ' (hoy)' : ' (faltan ' + dias + ' día' + (dias === 1 ? '' : 's') + ')') + '. Los gastos en origen negociados tienen una validez de un mes: volvé a cotizarlos desde tu link.</p>' +
          '<p>Puertos: ' + esc(Object.keys(x.puertos).join(', ')) + '</p>' + htmlBoton(linkDe(a), 'Cotizar gastos en origen')) });
      props.setProperty(marca, fechaHora(new Date()));
      registrar('Sistema', 'Aviso de vencimiento de gastos en origen', a.nombre + ' · vencen ' + fechaCorta(hasta));
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
  // La hoja puede estar llena hasta su última fila: se agregan filas al final antes de pegar
  function asegurarFila(hoja, fila) {
    var max = hoja.getMaxRows();
    if (fila > max) hoja.insertRowsAfter(max, fila - max + 200);
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
        porRuta[k].forEach(function (l) {
          var r = l.r;
          // Como en el histórico: Tipo de Servicio = DIRECTO o TRASBORDO; Transbordo = el puerto (vacío si es directo)
          filas.push({ tipo: l.tipo, reemplazar: l.correccion || l.tipo === TIPOS.NEGOCIADA, transporte: 'Maritimo', ffww: agente.nombre, contacto: agente.contacto || agente.nombre,
            flete: l.flete, pol: r.pol, tt: num(r.tt), servicio: r.directo ? 'DIRECTO' : 'TRASBORDO', linea: r.naviera, pod: r.pod, transbordo: r.directo ? '' : r.transbordo, desde: desde, hasta: hasta,
            dias: l.dias, pagadero: r.pagadero, locales: num(r.localesArg), ctnr: l.ctnr, coment: r.comentarios || '', imo: num(r.imo) });
        });
      });
      pegarMaritimo(filas, cfg);
    } else {
      if (!cfg.airIni) return;
      pegarEnBaseMadre(aPegar.map(function (l) {
        var r = l.r;
        return { semana: semanaISO(desde), agente: agente.nombre, contacto: agente.contacto || agente.nombre, version: version, recibido: ahora, tipo: l.tipo, motivo: l.correccion ? MOTIVOS.correccion : l.motivo,
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
    ['imo', ['RECARGA IMO', 'RECARGO IMO'], true]
  ];
  var NOMBRE_CAMPO_MAR = { transporte: 'Tipo de transporte (Maritimo)', ffww: 'Empresa del agente', contacto: 'Contacto del agente', flete: 'Valor flete', pol: 'POL', tt: 'Transit time',
    servicio: 'Tipo de servicio (DIRECTO / TRASBORDO)', linea: 'Naviera', pod: 'POD', transbordo: 'Puerto de transbordo (vacío si es directo)', desde: 'Vigencia desde', hasta: 'Vigencia hasta',
    dias: 'Días libres', pagadero: 'Pagadero', locales: 'Locales ARG', ctnr: 'Contenedor', coment: 'Comentarios', imo: 'Recarga IMO' };

  function valorMar(campo, f) {
    var v = f[campo];
    if (campo === 'imo' && (v === '' || v === 0)) return '';
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
      // Listas desplegables de la base: se ajusta cada valor a como está escrito en la lista (si no, Google rechaza la fila)
      var listas = ultima > enc.fila ? listasValidacion(hoja, ultima, ancho) : {}, saltadas = [], ajustes = {}, pegadas = 0;
      grupos[nombre].forEach(function (f0) {
       try {
        var f = {}; Object.keys(f0).forEach(function (k) { f[k] = f0[k]; });
        var faltaClave = [], notas = [];
        Object.keys(M).forEach(function (campo) {
          var v = valorMar(campo, f), c = M[campo]; if (!listas[c] || v === '' || v === undefined || v === null || typeof v === 'number' || v instanceof Date) return;
          var a = ajustarALista(listas, c, v);
          if (a === null) { if (['ffww', 'pol', 'pod', 'ctnr', 'transporte'].indexOf(campo) >= 0) faltaClave.push(campo + ' "' + v + '"'); else { notas.push(campo + ': ' + v); f['_vacio_' + campo] = true; } ajustes[campo + ' "' + v + '" (no está en la lista)'] = true; }
          else if (a !== v) { f['_lista_' + campo] = a; ajustes[campo + ' "' + v + '" → "' + a + '"'] = true; }
        });
        if (faltaClave.length) { saltadas.push((f.pol || '') + ' ' + (f.ctnr || '') + ': ' + faltaClave.join(', ')); return; }
        if (notas.length) f.coment = (f.coment ? f.coment + ' · ' : '') + 'Fuera de lista: ' + notas.join(', ');
        var fila = 0;
        if (f.reemplazar) {
          for (var i = datos.length - 1; i >= 0 && !fila; i--) {
            var r = datos[i] || [];
            if (claves.every(function (c) { return clavePegado(r[M[c] - 1]) === clavePegado(f['_lista_' + c] !== undefined ? f['_lista_' + c] : f[c]); })) fila = inicio + i;
          }
        }
        var esNueva = !fila;
        if (esNueva) { fila = ultima + 1; ultima = fila; asegurarFila(hoja, fila); if (fila - 1 > enc.fila) hoja.getRange(fila - 1, 1, 1, ancho).copyTo(hoja.getRange(fila, 1, 1, ancho), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false); }
        var idx = fila - inicio, arriba = idx > 0 ? (formulas[idx - 1] || []) : [], propias = (formulas[idx] || []).slice();
        datos[idx] = datos[idx] || []; formulas[idx] = formulas[idx] || [];
        var ocupadas = {};
        Object.keys(M).forEach(function (campo) {
          var c = M[campo]; ocupadas[c - 1] = true;
          if (propias[c - 1]) return;
          if (esNueva && arriba[c - 1]) { hoja.getRange(fila - 1, c).copyTo(hoja.getRange(fila, c), SpreadsheetApp.CopyPasteType.PASTE_FORMULA, false); formulas[idx][c - 1] = arriba[c - 1]; return; }
          var v = f['_vacio_' + campo] ? '' : f['_lista_' + campo] !== undefined ? f['_lista_' + campo] : valorMar(campo, f);
          hoja.getRange(fila, c).setValue(v === undefined || (typeof v === 'number' && isNaN(v)) ? '' : v);
          datos[idx][c - 1] = v;
        });
        if (esNueva) { copiarFormulasDeArriba(hoja, fila, arriba, ocupadas, formulas[idx]); total.nuevas++; } else total.actualizadas++;
        pegadas++;
       } catch (eF) { saltadas.push((f0.pol || '') + ' ' + (f0.linea || '') + ' ' + (f0.ctnr || '') + ': ' + String(eF && eF.message || eF).slice(0, 160)); }
      });
      registrar('Sistema', 'Pegó marítimo en la base madre', pegadas + ' de ' + grupos[nombre].length + ' fila(s) en "' + nombre + '"' + (Object.keys(ajustes).length ? ' · ajustado a las listas: ' + Object.keys(ajustes).join(', ') : ''));
      if (saltadas.length) registrar('Sistema', 'Filas sin pegar en la base madre', saltadas.length + ' fila(s) en "' + nombre + '": ' + saltadas.slice(0, 15).join(' | ') + (saltadas.length > 15 ? ' …' : ''));
    });
    return total;
  }

  /* ---------- Aéreo ---------- */
  var MAPA_AEREO = [
    ['semana', ['WEEK ID', 'WEEK', 'SEMANA', 'WEEK ID SEMANA']],
    ['transporte', ['TIPO DE TRANSPORTE', 'TRANSPORTE']],
    ['contacto', ['AGENTE', 'CONTACTO']],
    ['agente', ['FFWW', 'AGENT', 'FORWARDER']],
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
  var NOMBRE_CAMPO = { transporte: 'Tipo de transporte (Aereo)', contacto: 'Contacto del agente', semana: 'Semana (de la vigencia desde)', agente: 'Empresa del agente', origen: 'Origen', destino: 'Destino', aerolinea: 'Aerolínea', transito: 'Tránsito', moneda: 'Moneda',
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
      case 'transporte': return 'Aereo'; case 'contacto': return f.contacto || f.agente;
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
      if (esNueva) { fila = ultima + 1; ultima = fila; asegurarFila(hoja, fila); if (fila - 1 > enc.fila) hoja.getRange(fila - 1, 1, 1, ancho).copyTo(hoja.getRange(fila, 1, 1, ancho), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false); }
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

  return {
    abrirPanel: abrirPanel,
    pegarGastosOrigen: pegarGastosOrigen,
    avisarVencimientoGastos: avisarVencimientoGastos,
    datosPanel: datosPanel,
    irAFila: irAFila,
    numBase: numBase,
    tipoCtnr: tipoCtnr,
    menu: menu,
    prepararHojas: prepararHojas,
    armarAjustes: armarAjustes,
    armarCotizaciones: armarCotizaciones,
    estiloEncabezado: estiloEncabezado,
    estiloFila: estiloFila,
    colLetra: colLetra,
    asegurarEncabezados: asegurarEncabezados,
    confirmar: confirmar,
    migrarViejas: migrarViejas,
    escribirAjuste: escribirAjuste,
    leerAjustes: leerAjustes,
    registrar: registrar,
    generarLinks: generarLinks,
    linkDe: linkDe,
    irACotizaciones: irACotizaciones,
    doGet: doGet,
    buscarAgente: buscarAgente,
    agentesPorNombre: agentesPorNombre,
    hojaCotiz: hojaCotiz,
    valoresCotiz: valoresCotiz,
    leerDetalle: leerDetalle,
    datosParaAgente: datosParaAgente,
    estadoParaAgente: estadoParaAgente,
    enviarMaritimo: enviarMaritimo,
    enviarTarifario: enviarTarifario,
    recibirEnvio: recibirEnvio,
    claveLinea: claveLinea,
    agregarHistorial: agregarHistorial,
    validarVigencia: validarVigencia,
    validarEnvioMar: validarEnvioMar,
    validarEnvioAir: validarEnvioAir,
    gastosPorContenedor: gastosPorContenedor,
    lineasMar: lineasMar,
    lineasAir: lineasAir,
    recalcular: recalcular,
    recalcularMenu: recalcularMenu,
    redondear: redondear,
    semaforo: semaforo,
    mediana: mediana,
    historicoMar: historicoMar,
    medianaMar: medianaMar,
    medianaAir: medianaAir,
    mandarMail: mandarMail,
    htmlTabla: htmlTabla,
    htmlBoton: htmlBoton,
    htmlEnvolver: htmlEnvolver,
    valorTxt: valorTxt,
    pctTxt: pctTxt,
    avisarAlTeam: avisarAlTeam,
    enviarDecisiones: enviarDecisiones,
    mailPedidoMejora: mailPedidoMejora,
    activarAvisos: activarAvisos,
    avisarVencimientosMenu: avisarVencimientosMenu,
    avisarVencimientos: avisarVencimientos,
    abrirPedido: abrirPedido,
    repegarEnvioMenu: repegarEnvioMenu,
    repegarEnvio: repegarEnvio,
    pedirTarifas: pedirTarifas,
    procesarPedidos: procesarPedidos,
    num: num,
    aFecha: aFecha,
    aDia: aDia,
    fecha: fecha,
    fechaHora: fechaHora,
    fechaCorta: fechaCorta,
    fechaLarga: fechaLarga,
    esc: esc,
    semanaISO: semanaISO,
    claveTexto: claveTexto,
    abrirDestino: abrirDestino,
    mapearEncabezados: mapearEncabezados,
    copiarFormulasDeArriba: copiarFormulasDeArriba,
    pegarEnvioEnBase: pegarEnvioEnBase,
    valorMar: valorMar,
    clavePegado: clavePegado,
    pegarMaritimo: pegarMaritimo,
    tarifaAlPeso: tarifaAlPeso,
    calcularAllIn: calcularAllIn,
    valorDe: valorDe,
    pegarEnBaseMadre: pegarEnBaseMadre,
    pegarEnPestana: pegarEnPestana,
    verificarBaseMadre: verificarBaseMadre,
    K: K,
    CZ: CZ,
    HOJA: HOJA,
    MODO: MODO,
    TIPOS: TIPOS,
    MOTIVOS: MOTIVOS,
    ESTADOS: ESTADOS,
    CONTENEDORES: CONTENEDORES,
    _reset: function () { _AJ = null; }
  };
})();

/* ------------------------------------------------------------------ */
/* Funciones globales del Tarifador (con prefijo, para no chocar con   */
/* los otros scripts del proyecto)                                      */
/* ------------------------------------------------------------------ */
// Ejecutar UNA vez desde el editor: agrega el menú Tarifador BIDCOM al abrir la planilla, sin tocar el onOpen existente
function tarifadorInstalar() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'tarifadorMenu') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('tarifadorMenu').forSpreadsheet(ss).onOpen().create();
  // Pide de una vez los permisos de mails y aviso diario
  MailApp.getRemainingDailyQuota();
  Logger.log('Listo: recargá la planilla y vas a ver el menú Tarifador BIDCOM.');
}
function tarifadorMenu() { Tarifador.menu(); }
function doGet(e) { return Tarifador.doGet(e); }
function tarifadorEnviarMaritimo(clave, envio) { return Tarifador.enviarMaritimo(clave, envio); }
function tarifadorEnviarAereo(clave, envio) { return Tarifador.enviarTarifario(clave, envio); }
function tarifadorAvisarVencimientos() { return Tarifador.avisarVencimientos(); }
function tarifador_prepararHojas() { Tarifador.prepararHojas(); }
function tarifador_generarLinks() { Tarifador.generarLinks(); }
function tarifador_verificarBaseMadre() { Tarifador.verificarBaseMadre(); }
function tarifador_activarAvisos() { Tarifador.activarAvisos(); }
function tarifador_enviarDecisiones() { Tarifador.enviarDecisiones(); }
function tarifador_recalcular() { Tarifador.recalcularMenu(); }
function tarifador_avisarVencimientos() { Tarifador.avisarVencimientosMenu(); }
function tarifador_irACotizaciones() { Tarifador.irACotizaciones(); }
function tarifador_pedirTarifas() { Tarifador.abrirPedido(); }
function tarifadorPedirTarifas(d) { return Tarifador.pedirTarifas(d); }
function tarifador_repegarEnvio() { Tarifador.repegarEnvioMenu(); }
function tarifador_panel() { Tarifador.abrirPanel(); }
function tarifadorDatosPanel() { return Tarifador.datosPanel(); }
function tarifadorIrAFila(nombre, fila) { return Tarifador.irAFila(nombre, fila); }
