# Tarifador BIDCOM

Portal de cotizaciones de logística internacional (marítimo y aéreo): cada agente carga sus tarifas en su link personal, el team de BIDCOM las compara (menor de la ronda e histórico), aprueba o pide mejoras, y todo se pega solo en la base madre.

> **Prototipo con datos ficticios.** Ningún agente, tarifa ni gasto de esta versión es real. No subir tarifas reales a este repositorio: es público.

## Qué hay acá

| Carpeta / archivo | Qué es |
| --- | --- |
| `index.html` | Prototipo navegable. Se abre directo en el navegador o publicado con GitHub Pages. |
| `supabase/migrations/` | Base de datos PostgreSQL/Supabase: tablas, catálogos, seguridad por agente, auditoría, motor de históricos y módulo aéreo. |
| `google-sheets/` | La herramienta real: formulario por link para agentes, aprobación del team con mails, aviso de vencimiento y pegado automático en la base madre (Apps Script). |
| `supabase/tests/` | Pruebas: aislamiento entre agentes, versiones inmutables, cálculo del all-in aéreo. |

## Dónde ver los cambios

Todo se ve en **https://solp-boop.github.io/tarifador-bidcom/**. Arriba a la izquierda está el número de versión y la sección **Novedades** lista qué cambió.

## Cómo usar el prototipo

1. Arriba elegí **Marítimo** o **Aéreo**.
2. En **Ver como** elegí un agente o **BIDCOM**.
3. Como agente: cargá una cotización en el formulario (es la única forma de carga).
4. Como BIDCOM: revisá la evaluación contra el histórico, pedí una mejora y volvé como agente para responderla.

Lo que se carga queda guardado solo en el navegador de cada persona. **Reiniciar demo** vuelve al estado inicial.

## Planilla de Google (versión 1.6)

- En la base madre solo se escribe en **Cotizaciones Maritimos SIN NEGOCIAR** (inicial) y **Cotizaciones Maritimos Negociado** (negociada), en las filas vacías debajo del histórico.
- Todo lo demás vive en dos pestañas: **TARIFADOR Ajustes** y **TARIFADOR Cotizaciones**.
- Flujo: el agente carga → mail al team → el team aprueba o pide mejora → mail al agente → responde → se pega en Negociado.
- Target sugerido: a quien cotizó la menor de la ronda se le pide −15% (configurable); al resto, igualar la menor. No se le revela al agente al cargar.
- Vigencia desde / hasta (1 semana, 15 días o 1 mes) y aviso al agente 5 días antes del vencimiento, con copia al team.

## Reglas principales (prototipo)

- Target = mediana histórica comparable × (1 − 15%), configurable para flete, gastos en origen y aéreo.
- Semáforo: verde ≤ target · amarillo hasta +5% · naranja hasta +15% · rojo más de +15%.
- Gastos en origen siempre desglosados por concepto, con moneda y unidad.
- Aéreo: comparación en USD/kg a 500 kg (flete + fuel + IMO + gastos en origen + gastos de destino).
- Sin histórico suficiente no se inventa un target: se usa uno manual de BIDCOM.

## Próximo paso

Versión con usuarios reales: Next.js en Vercel + Supabase (base de datos y logins), en un repositorio privado separado.
