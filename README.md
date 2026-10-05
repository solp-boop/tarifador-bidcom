# Tarifador BIDCOM

Portal de cotizaciones de logística internacional (marítimo y aéreo): los agentes cargan sus tarifas a mano o por Excel, y BIDCOM las compara contra su histórico, detecta qué concepto está caro y pide mejoras.

> **Prototipo con datos ficticios.** Ningún agente, tarifa ni gasto de esta versión es real. No subir tarifas reales a este repositorio: es público.

## Qué hay acá

| Carpeta / archivo | Qué es |
| --- | --- |
| `index.html` | Prototipo navegable. Se abre directo en el navegador o publicado con GitHub Pages. |
| `modelos/` | Modelo en blanco y ejemplo completo para agentes (marítimo y aéreo). |
| `supabase/migrations/` | Base de datos PostgreSQL/Supabase: tablas, catálogos, seguridad por agente, auditoría, motor de históricos y módulo aéreo. |
| `supabase/tests/` | Pruebas: aislamiento entre agentes, versiones inmutables, cálculo del all-in aéreo. |

## Cómo usar el prototipo

1. Arriba elegí **Marítimo** o **Aéreo**.
2. En **Ver como** elegí un agente o **BIDCOM**.
3. Como agente: cargá una cotización a mano o importá un Excel (hay un ejemplo en formato actual para probar).
4. Como BIDCOM: revisá la evaluación contra el histórico, pedí una mejora y volvé como agente para responderla.

Lo que se carga queda guardado solo en el navegador de cada persona. **Reiniciar demo** vuelve al estado inicial.

## Reglas principales

- Target = mediana histórica comparable × (1 − 15%), configurable para flete, gastos en origen y aéreo.
- Semáforo: verde ≤ target · amarillo hasta +5% · naranja hasta +15% · rojo más de +15%.
- Gastos en origen siempre desglosados por concepto, con moneda y unidad.
- Aéreo: comparación en USD/kg a 500 kg (flete + fuel + IMO + gastos en origen + gastos de destino).
- Sin histórico suficiente no se inventa un target: se usa uno manual de BIDCOM.

## Próximo paso

Versión con usuarios reales: Next.js en Vercel + Supabase (base de datos y logins), en un repositorio privado separado.
