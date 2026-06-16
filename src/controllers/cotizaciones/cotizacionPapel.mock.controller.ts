import { Request, Response } from "express";

// ═══════════════════════════════════════════════════════════════════════════
// MOCK — Recibe productos de papel en cotizaciones/pedidos
// Este controller es un placeholder mientras se implementa la BD.
// Por ahora solo valida la estructura y responde OK.
// ═══════════════════════════════════════════════════════════════════════════

export interface ProductoPapelCotizacionPayload {
  tipoCotizacion: "papel";
  idproducto_papel: number;
  nombre: string;
  descripcion_papel: string | null;
  medida: string | null;
  tipo_papel: string;
  calibre: string;
  precio_sugerido: number | null;
  cantidades: [number, number, number];
  precios: [number, number, number];
  tintas: number;
  caras: number;
  foil: boolean;
  asa_suaje: string;
  alto_relieve: boolean;
  laminado: string;
  uv: boolean;
  pantones: string;
  pigmento: string;
  perforado: boolean;
  texturizado: boolean;
  observacion: string;
  descripcion: string | null;
}

/**
 * POST /cotizaciones-papel/mock
 * Recibe una cotización/pedido con productos de papel.
 * Por ahora NO guarda en BD — solo valida y loguea.
 * Retorna estructura compatible con el flujo existente.
 */
export const crearCotizacionPapelMock = async (req: Request, res: Response) => {
  try {
    const {
      clienteId,
      tipo = "cotizacion",
      prioridad = false,
      sin_iva = false,
      productos = [],
    } = req.body;

    // ── Validaciones básicas ──────────────────────────────────────────────
    if (!clienteId) {
      return res.status(400).json({ error: "Se requiere clienteId" });
    }

    if (!productos || productos.length === 0) {
      return res.status(400).json({ error: "Se requiere al menos un producto de papel" });
    }

    // ── Validar cada producto ─────────────────────────────────────────────
    for (const prod of productos) {
      if (!prod.idproducto_papel) {
        return res.status(400).json({ error: "Cada producto de papel requiere idproducto_papel" });
      }
      if (prod.tipoCotizacion !== "papel") {
        return res.status(400).json({ error: `Producto ${prod.idproducto_papel}: tipoCotizacion debe ser "papel"` });
      }
      const tieneDetalle = prod.cantidades.some((c: number, i: number) => c > 0 && prod.precios[i] > 0);
      if (!tieneDetalle) {
        return res.status(400).json({
          error: `Producto "${prod.nombre}" no tiene cantidades o precios válidos`,
        });
      }
    }

    // ── Calcular total ────────────────────────────────────────────────────
    const total = productos.reduce((sum: number, prod: ProductoPapelCotizacionPayload) => {
      const subtotal = prod.cantidades.reduce((s: number, cant: number, i: number) => {
        if (cant <= 0 || prod.precios[i] <= 0) return s;
        return s + Math.round(cant * prod.precios[i] * 100) / 100;
      }, 0);
      return sum + subtotal;
    }, 0);

    // ── Log para desarrollo ───────────────────────────────────────────────
    console.log("📄 [MOCK] Cotización papel recibida:");
    console.log(`  Cliente: ${clienteId}`);
    console.log(`  Tipo: ${tipo} | Prioridad: ${prioridad} | Sin IVA: ${sin_iva}`);
    console.log(`  Productos: ${productos.length}`);
    console.log(`  Total: $${total.toFixed(2)}`);
    productos.forEach((p: ProductoPapelCotizacionPayload, i: number) => {
      console.log(`  [${i + 1}] ${p.nombre} | idproducto_papel=${p.idproducto_papel}`);
      p.cantidades.forEach((cant: number, j: number) => {
        if (cant > 0 && p.precios[j] > 0) {
          console.log(`       ${cant.toLocaleString()} pzs × $${p.precios[j].toFixed(4)} = $${(cant * p.precios[j]).toFixed(2)}`);
        }
      });
      if (p.foil)         console.log(`       ✨ Foil`);
      if (p.alto_relieve) console.log(`       🔳 Alto relieve`);
      if (p.uv)           console.log(`       🔆 UV`);
      if (p.perforado)    console.log(`       🔘 Perforado`);
      if (p.texturizado)  console.log(`       🪨 Texturizado`);
      if (p.asa_suaje)    console.log(`       Asa/Suaje: ${p.asa_suaje}`);
      if (p.laminado)     console.log(`       Laminado: ${p.laminado}`);
      if (p.pantones)     console.log(`       Pantones: ${p.pantones}`);
      if (p.pigmento)     console.log(`       Pigmento: ${p.pigmento}`);
    });

    // ── Respuesta mock ────────────────────────────────────────────────────
    const folioMock = tipo === "pedido"
      ? `P_PAPEL_MOCK_${Date.now()}`
      : `COT_PAPEL_MOCK_${Date.now()}`;

    if (tipo === "pedido") {
      return res.status(201).json({
        message: "[MOCK] Pedido de papel recibido correctamente (sin guardar en BD)",
        no_pedido: folioMock,
        tipo: "pedido",
        total,
        sin_iva,
        _mock: true,
        _nota: "Implementar BD cuando esté lista la estructura de tablas para papel en cotizaciones",
      });
    }

    return res.status(201).json({
      message: "[MOCK] Cotización de papel recibida correctamente (sin guardar en BD)",
      no_cotizacion: folioMock,
      tipo: "cotizacion",
      total,
      sin_iva,
      _mock: true,
      _nota: "Implementar BD cuando esté lista la estructura de tablas para papel en cotizaciones",
    });

  } catch (error: any) {
    console.error("❌ MOCK COTIZACION PAPEL ERROR:", error.message);
    return res.status(500).json({ error: "Error en el mock de cotización de papel" });
  }
};