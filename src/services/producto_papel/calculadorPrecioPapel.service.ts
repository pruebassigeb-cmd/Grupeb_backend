import {
  obtenerContextoCalculoPrecioPapel,
  obtenerMatrizCalculoPrecioPapel,
} from "../../repositories/producto_papel/calculadorPrecioPapel.repository";
import type { QueryExecutor } from "../../repositories/producto_papel/calculadorPrecioPapel.repository";
import type {
  AdvertenciaPrecioPapel,
  CalcularPrecioPapelInput,
  CalcularPrecioPapelResponse,
  DesglosePrecioPapel,
  EscalaAplicadaPrecioPapel,
  ResultadoCantidadPrecioPapel,
  TarifaCalculoPrecioPapelDb,
} from "../../types/producto_papel/calculadorPrecioPapel.types";

const ACABADOS_BOOLEANOS = [
  ["hot_stamping", "Hot Stamping"],
  ["alto_relieve", "Alto relieve"],
  ["textura", "Textura"],
  ["uv", "UV"],
  ["asa", "Asa"],
] as const;

export class ErrorCalculoPrecioPapel extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400,
  ) {
    super(message);
    this.name = "ErrorCalculoPrecioPapel";
  }
}

const aNumeroNullable = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const numero = Number(value);
  return Number.isFinite(numero) ? numero : null;
};

const redondear2 = (value: number): number =>
  Math.round((value + Number.EPSILON) * 100) / 100;

const enteroNoNegativo = (value: unknown, nombre: string): number => {
  const numero = Number(value);
  if (!Number.isInteger(numero) || numero < 0) {
    throw new ErrorCalculoPrecioPapel(`${nombre} debe ser un entero mayor o igual a cero.`);
  }
  return numero;
};

function validarInput(input: CalcularPrecioPapelInput): CalcularPrecioPapelInput {
  if (!Number.isInteger(input?.idproducto_papel) || input.idproducto_papel <= 0) {
    throw new ErrorCalculoPrecioPapel("idproducto_papel es inválido.");
  }
  if (!Number.isInteger(input?.idgrupo_papel) || input.idgrupo_papel <= 0) {
    throw new ErrorCalculoPrecioPapel("idgrupo_papel es requerido y debe ser válido.");
  }
  if (!Array.isArray(input?.cantidades) || input.cantidades.length < 1 || input.cantidades.length > 3) {
    throw new ErrorCalculoPrecioPapel("Se requieren entre una y tres cantidades.");
  }

  const referencias = new Set<string>();
  const cantidades = input.cantidades.map((item) => {
    const referencia = String(item?.referencia || "").trim();
    const cantidad = Number(item?.cantidad);
    if (!referencia) throw new ErrorCalculoPrecioPapel("Cada cantidad necesita una referencia.");
    if (referencias.has(referencia)) {
      throw new ErrorCalculoPrecioPapel(`La referencia ${referencia} está repetida.`);
    }
    if (!Number.isInteger(cantidad) || cantidad <= 0) {
      throw new ErrorCalculoPrecioPapel("Las cantidades deben ser enteros mayores que cero.");
    }
    referencias.add(referencia);
    return { referencia, cantidad };
  });

  const acabados = input.acabados || ({} as CalcularPrecioPapelInput["acabados"]);
  const tintasFrente = enteroNoNegativo(acabados.tintas_frente ?? 0, "tintas_frente");
  const tintasDentro = enteroNoNegativo(acabados.tintas_dentro ?? 0, "tintas_dentro");

  if (tintasFrente > 6 || tintasDentro > 6) {
    throw new ErrorCalculoPrecioPapel("Las tintas de frente y dentro deben estar entre 0 y 6.");
  }

  return {
    idproducto_papel: input.idproducto_papel,
    idgrupo_papel: input.idgrupo_papel,
    cantidades,
    acabados: {
      tintas_frente: tintasFrente,
      tintas_dentro: tintasDentro,
      laminado: acabados.laminado === true,
      hot_stamping: acabados.hot_stamping === true,
      alto_relieve: acabados.alto_relieve === true,
      textura: acabados.textura === true,
      uv: acabados.uv === true,
      asa: acabados.asa === true,
    },
  };
}

function seleccionarEscala(
  escalas: EscalaAplicadaPrecioPapel[],
  cantidad: number,
): EscalaAplicadaPrecioPapel | null {
  if (!escalas.length) return null;
  if (cantidad <= escalas[0].cantidad) return escalas[0];

  let seleccionada = escalas[0];
  for (const escala of escalas) {
    if (escala.cantidad > cantidad) break;
    seleccionada = escala;
  }
  return seleccionada;
}

function advertenciaTarifa(
  codigo: AdvertenciaPrecioPapel["codigo"],
  mensaje: string,
  cantidad: number,
  escala: EscalaAplicadaPrecioPapel | null,
  clave?: string,
  nombre?: string,
): AdvertenciaPrecioPapel {
  return {
    codigo,
    mensaje,
    acabado_clave: clave,
    acabado_nombre: nombre,
    cantidad,
    escala_aplicada: escala?.cantidad ?? null,
  };
}

export async function calcularPrecioPapel(
  inputSinValidar: CalcularPrecioPapelInput,
  db?: QueryExecutor,
): Promise<CalcularPrecioPapelResponse> {
  const input = validarInput(inputSinValidar);
  const contexto = await obtenerContextoCalculoPrecioPapel(
    input.idproducto_papel,
    input.idgrupo_papel,
    db,
  );

  if (!contexto) {
    throw new ErrorCalculoPrecioPapel("Producto de papel no encontrado.", 404);
  }
  if (!contexto.idgrupo_papel) {
    throw new ErrorCalculoPrecioPapel(
      "El grupo indicado no pertenece al producto de papel.",
      404,
    );
  }

  const totalTintas = input.acabados.tintas_frente + input.acabados.tintas_dentro;
  const clavesSolicitadas: string[] = [];
  if (totalTintas > 0) clavesSolicitadas.push("tintas");
  for (const [clave] of ACABADOS_BOOLEANOS) {
    if (input.acabados[clave] === true) clavesSolicitadas.push(clave);
  }

  const filasMatriz = await obtenerMatrizCalculoPrecioPapel(
    contexto.id_tamano_producto,
    clavesSolicitadas,
    db,
  );

  const escalasMap = new Map<number, EscalaAplicadaPrecioPapel>();
  const tarifaMap = new Map<string, TarifaCalculoPrecioPapelDb>();
  const acabadosEncontrados = new Set<string>();

  for (const fila of filasMatriz) {
    escalasMap.set(fila.id_escala, {
      id: fila.id_escala,
      cantidad: Number(fila.cantidad_escala),
    });
    if (fila.acabado_clave) {
      acabadosEncontrados.add(fila.acabado_clave);
      tarifaMap.set(`${fila.id_escala}:${fila.acabado_clave}`, fila);
    }
  }

  const escalas = Array.from(escalasMap.values()).sort((a, b) => a.cantidad - b.cantidad);
  const precioBaseDb = aNumeroNullable(contexto.precio_base);
  const costoLaminadoDb = aNumeroNullable(contexto.costo_laminado);

  const resultados: ResultadoCantidadPrecioPapel[] = input.cantidades.map((item) => {
    const escala = seleccionarEscala(escalas, item.cantidad);
    const advertencias: AdvertenciaPrecioPapel[] = [];
    const desglose: DesglosePrecioPapel[] = [];

    if (!contexto.producto_activo) {
      advertencias.push({
        codigo: "PRODUCTO_INACTIVO",
        mensaje: "El producto está inactivo. Verifica el precio antes de cotizar.",
        cantidad: item.cantidad,
      });
    }

    const precioBase = redondear2(precioBaseDb ?? 0);
    if (precioBaseDb === null) {
      advertencias.push({
        codigo: "PRECIO_BASE_NO_CONFIGURADO",
        mensaje: "El grupo no tiene precio base configurado. Captura el precio manualmente.",
        cantidad: item.cantidad,
      });
    }

    if (contexto.id_tamano_producto === null) {
      advertencias.push({
        codigo: "PRODUCTO_SIN_TAMANO",
        mensaje: "El producto no tiene tamaño de costos configurado. Los acabados de matriz se toman provisionalmente en $0.00.",
        cantidad: item.cantidad,
      });
    }

    if (!escala && clavesSolicitadas.length > 0) {
      advertencias.push({
        codigo: "SIN_ESCALAS_ACTIVAS",
        mensaje: "No existen escalas activas de costos. Ajusta el precio manualmente.",
        cantidad: item.cantidad,
      });
    }

    let incrementoAcabados = 0;

    const aplicarAcabado = (clave: string, nombreFallback: string, multiplicador: number) => {
      let incremento = 0;
      let tarifaNumero: number | null = null;
      let configurado = false;
      const fila = escala ? tarifaMap.get(`${escala.id}:${clave}`) : undefined;
      const nombre = fila?.acabado_nombre || nombreFallback;

      if (contexto.id_tamano_producto === null || !escala) {
        // Ya se agregó la advertencia general. El detalle se conserva en cero.
      } else if (!acabadosEncontrados.has(clave)) {
        advertencias.push(advertenciaTarifa(
          "ACABADO_NO_EXISTE",
          `El acabado ${nombreFallback} no existe en el catálogo de costos. Ajusta el precio manualmente.`,
          item.cantidad,
          escala,
          clave,
          nombreFallback,
        ));
      } else if (fila?.acabado_activo === false) {
        advertencias.push(advertenciaTarifa(
          "ACABADO_INACTIVO",
          `El acabado ${nombre} está inactivo. Ajusta el precio manualmente.`,
          item.cantidad,
          escala,
          clave,
          nombre,
        ));
      } else if (fila?.tarifa_activa === false) {
        advertencias.push(advertenciaTarifa(
          "TARIFA_INACTIVA",
          `La tarifa de ${nombre} está inactiva para la escala ${escala.cantidad.toLocaleString("es-MX")}. Ajusta el precio manualmente.`,
          item.cantidad,
          escala,
          clave,
          nombre,
        ));
      } else if (!fila || fila.precio_unitario === null || fila.precio_unitario === undefined) {
        advertencias.push(advertenciaTarifa(
          "TARIFA_NO_CONFIGURADA",
          `No hay tarifa configurada para ${nombre}, tamaño ${contexto.tamano_producto || "sin tamaño"}, escala ${escala.cantidad.toLocaleString("es-MX")}. Ajusta el precio manualmente.`,
          item.cantidad,
          escala,
          clave,
          nombre,
        ));
      } else {
        tarifaNumero = aNumeroNullable(fila.precio_unitario);
        if (tarifaNumero !== null) {
          incremento = redondear2(tarifaNumero * multiplicador);
          configurado = true;
          incrementoAcabados = redondear2(incrementoAcabados + incremento);
        }
      }

      desglose.push({
        clave,
        nombre,
        origen: "matriz",
        tarifa_unitaria: tarifaNumero === null ? null : redondear2(tarifaNumero),
        multiplicador,
        incremento,
        configurado,
      });
    };

    if (totalTintas > 0) aplicarAcabado("tintas", "Tintas", totalTintas);
    for (const [clave, nombre] of ACABADOS_BOOLEANOS) {
      if (input.acabados[clave] === true) aplicarAcabado(clave, nombre, 1);
    }

    let incrementoLaminado = 0;
    if (input.acabados.laminado) {
      if (costoLaminadoDb === null) {
        advertencias.push({
          codigo: "COSTO_LAMINADO_NO_CONFIGURADO",
          mensaje: "El producto lleva laminado, pero costo_laminado no está configurado. Ajusta el precio manualmente.",
          cantidad: item.cantidad,
        });
        desglose.push({
          clave: "laminado",
          nombre: "Laminado",
          origen: "producto",
          tarifa_unitaria: null,
          multiplicador: 1,
          incremento: 0,
          configurado: false,
        });
      } else {
        incrementoLaminado = redondear2(costoLaminadoDb);
        desglose.push({
          clave: "laminado",
          nombre: "Laminado",
          origen: "producto",
          tarifa_unitaria: incrementoLaminado,
          multiplicador: 1,
          incremento: incrementoLaminado,
          configurado: true,
        });
      }
    }

    const precioCalculado = redondear2(
      precioBase + incrementoAcabados + incrementoLaminado,
    );

    return {
      referencia: item.referencia,
      cantidad: item.cantidad,
      escala_aplicada: escala,
      precio_base: precioBase,
      incremento_acabados: incrementoAcabados,
      incremento_laminado: incrementoLaminado,
      precio_calculado: precioCalculado,
      desglose,
      advertencias,
    };
  });

  return {
    producto: {
      idproducto_papel: contexto.idproducto_papel,
      idgrupo_papel: contexto.idgrupo_papel,
      id_tamano_producto: contexto.id_tamano_producto,
      tamano_producto: contexto.tamano_producto,
    },
    resultados,
  };
}
