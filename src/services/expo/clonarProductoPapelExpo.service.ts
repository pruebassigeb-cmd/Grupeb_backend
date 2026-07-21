interface ClonarProductoPapelExpoParams {
  idProductoSistema: number;
  idGrupoSistema: number;
  idUsuario: number | null;
  categoriaEsperada: "papel" | "carton";
  nombre?: string | null;
  ancho?: number | null;
  fuelle?: number | null;
  altura?: number | null;
  medida?: string | null;
  idTamanoProducto?: number | null;
  costoLaminado?: number | null;
  precioBase?: number | null;
  precioReferencia500?: number | null;
  precioReferencia1000?: number | null;
}

export interface ProductoPapelExpoClonado {
  idproductoPapel: number;
  idgrupoPapel: number;
}

const MAQUINARIA_PRODUCTO: ReadonlyArray<{
  tabla: string;
  columnaCatalogo: string;
}> = [
  { tabla: "maquinaria_alto_relieve", columnaCatalogo: "idcat_alto_relieve_maquina" },
  { tabla: "maquinaria_armado", columnaCatalogo: "idcat_armado" },
  { tabla: "maquinaria_asas_maquina", columnaCatalogo: "idcat_asas_maquina" },
  { tabla: "maquinaria_desbarbe", columnaCatalogo: "idcat_desbarbe" },
  { tabla: "maquinaria_empalme", columnaCatalogo: "idcat_empalme" },
  { tabla: "maquinaria_empaque", columnaCatalogo: "idcat_empaque_maquina" },
  { tabla: "maquinaria_hojeado_guillotina", columnaCatalogo: "idcat_hojeado_guillotina" },
  { tabla: "maquinaria_hs_ar", columnaCatalogo: "idcat_hs_ar" },
  { tabla: "maquinaria_impresora", columnaCatalogo: "idcat_impresora" },
  { tabla: "maquinaria_laminado", columnaCatalogo: "idcat_laminado_maquina" },
  { tabla: "maquinaria_suaje_maquina", columnaCatalogo: "idcat_suaje_maquina" },
  { tabla: "maquinaria_textura", columnaCatalogo: "idcat_textura" },
  { tabla: "maquinaria_texturizadora", columnaCatalogo: "idcat_texturizadora" },
  { tabla: "maquinaria_uv", columnaCatalogo: "idcat_uv" },
];

/**
 * Crea un producto Expo independiente tomando un producto normal como plantilla.
 *
 * Se copia:
 * - producto_papel completo;
 * - únicamente el grupo solicitado y todos sus detalle_material_papel;
 * - suaje;
 * - pegado, refuerzo, base, empaque, asas y laminados permitidos;
 * - producto_papel_tintas;
 * - toda la maquinaria relacionada.
 *
 * No se copia:
 * - archivos/imágenes;
 * - producto_acabado_default, porque los valores predeterminados los define el
 *   formulario Expo y se guardan después de clonar.
 */
export async function clonarProductoPapelSistemaAExpo(
  client: any,
  params: ClonarProductoPapelExpoParams,
): Promise<ProductoPapelExpoClonado> {
  const { rows: origenRows } = await client.query(
    `SELECT idproducto_papel, idproductos
       FROM producto_papel
      WHERE idproducto_papel = $1
        AND activo = TRUE
        AND COALESCE(origen_expo, FALSE) = FALSE
      FOR SHARE`,
    [params.idProductoSistema],
  );

  if (!origenRows.length) {
    throw new Error("El producto seleccionado del sistema no existe o ya no está activo.");
  }

  const categoriaOrigen = Number(origenRows[0].idproductos) === 3 ? "carton" : "papel";
  if (categoriaOrigen !== params.categoriaEsperada) {
    throw new Error("La categoría del producto seleccionado no coincide con el registro Expo.");
  }

  const { rows: grupoOrigenRows } = await client.query(
    `SELECT idgrupo_papel
       FROM grupo_papel
      WHERE idgrupo_papel = $1
        AND idproducto_papel = $2
      FOR SHARE`,
    [params.idGrupoSistema, params.idProductoSistema],
  );

  if (!grupoOrigenRows.length) {
    throw new Error("El grupo seleccionado no pertenece al producto del sistema.");
  }

  const { rows: productoNuevoRows } = await client.query(
    `INSERT INTO producto_papel (
       idproductos,
       idcat_tipo_producto_papel,
       ancho,
       fuelle,
       altura,
       medida,
       activo,
       creado_por,
       actualizado_por,
       descripcion_papel,
       tamano_asa_default,
       origen_expo,
       precio_500,
       precio_1000,
       precio_3000,
       tamano_prod,
       costo_laminado
     )
     SELECT
       pp.idproductos,
       pp.idcat_tipo_producto_papel,
       COALESCE($3, pp.ancho),
       COALESCE($4, pp.fuelle),
       COALESCE($5, pp.altura),
       COALESCE(NULLIF(BTRIM($6), ''), pp.medida),
       TRUE,
       $7,
       $7,
       COALESCE(NULLIF(BTRIM($8), ''), pp.descripcion_papel),
       pp.tamano_asa_default,
       TRUE,
       pp.precio_500,
       COALESCE($9, pp.precio_1000),
       COALESCE($10, pp.precio_3000),
       COALESCE($11, pp.tamano_prod),
       COALESCE($12, pp.costo_laminado)
     FROM producto_papel pp
     WHERE pp.idproducto_papel = $1
       AND pp.idproductos = $2
     RETURNING idproducto_papel`,
    [
      params.idProductoSistema,
      categoriaOrigen === "carton" ? 3 : 2,
      params.ancho ?? null,
      params.fuelle ?? null,
      params.altura ?? null,
      params.medida ?? null,
      params.idUsuario,
      params.nombre ?? null,
      params.precioReferencia500 ?? null,
      params.precioReferencia1000 ?? null,
      params.idTamanoProducto ?? null,
      params.costoLaminado ?? null,
    ],
  );

  if (!productoNuevoRows.length) {
    throw new Error("No fue posible crear la copia del producto del sistema.");
  }

  const idproductoPapel = Number(productoNuevoRows[0].idproducto_papel);

  const { rows: grupoNuevoRows } = await client.query(
    `INSERT INTO grupo_papel (
       idproducto_papel,
       precio_sugerido,
       orden,
       creado_por,
       actualizado_por
     )
     SELECT
       $1,
       COALESCE($2, gp.precio_sugerido),
       1,
       $3,
       $3
     FROM grupo_papel gp
     WHERE gp.idgrupo_papel = $4
       AND gp.idproducto_papel = $5
     RETURNING idgrupo_papel`,
    [
      idproductoPapel,
      params.precioBase ?? null,
      params.idUsuario,
      params.idGrupoSistema,
      params.idProductoSistema,
    ],
  );

  if (!grupoNuevoRows.length) {
    throw new Error("No fue posible copiar el grupo seleccionado.");
  }

  const idgrupoPapel = Number(grupoNuevoRows[0].idgrupo_papel);

  await client.query(
    `INSERT INTO detalle_material_papel (
       idgrupo_papel,
       idcat_tipo_papel,
       idcat_calibre,
       pliego,
       rendimiento,
       corte,
       hoj_bobina,
       hoj_corte,
       hoj_rendimiento,
       hoj_guillotina,
       hoj_hilo,
       orden,
       creado_por,
       actualizado_por,
       hoj_bobina_extra
     )
     SELECT
       $1,
       dmp.idcat_tipo_papel,
       dmp.idcat_calibre,
       dmp.pliego,
       dmp.rendimiento,
       dmp.corte,
       dmp.hoj_bobina,
       dmp.hoj_corte,
       dmp.hoj_rendimiento,
       dmp.hoj_guillotina,
       dmp.hoj_hilo,
       dmp.orden,
       $2,
       $2,
       dmp.hoj_bobina_extra
     FROM detalle_material_papel dmp
     WHERE dmp.idgrupo_papel = $3
     ORDER BY dmp.orden, dmp.iddetalle_material`,
    [idgrupoPapel, params.idUsuario, params.idGrupoSistema],
  );

  await client.query(
    `INSERT INTO suaje_papel (
       idproducto_papel,
       numero,
       pzs,
       tamano,
       corte1_tipo,
       corte1_medida,
       dobles1_tipo,
       dobles1_medida,
       metros,
       matrix,
       tiempo_arreglo,
       idcat_sacabocados,
       cantidad_sacabocado,
       idcat_perforado,
       cantidad_perforado,
       idcat_matrix,
       idcat_corte,
       idcat_doble,
       herramental_desbarbe,
       no_desbarbe,
       idcat_punto_corte,
       idcat_punto_doble
     )
     SELECT
       $1,
       sp.numero,
       sp.pzs,
       sp.tamano,
       sp.corte1_tipo,
       sp.corte1_medida,
       sp.dobles1_tipo,
       sp.dobles1_medida,
       sp.metros,
       sp.matrix,
       sp.tiempo_arreglo,
       sp.idcat_sacabocados,
       sp.cantidad_sacabocado,
       sp.idcat_perforado,
       sp.cantidad_perforado,
       sp.idcat_matrix,
       sp.idcat_corte,
       sp.idcat_doble,
       sp.herramental_desbarbe,
       sp.no_desbarbe,
       sp.idcat_punto_corte,
       sp.idcat_punto_doble
     FROM suaje_papel sp
     WHERE sp.idproducto_papel = $2
     ORDER BY sp.idsuaje_papel`,
    [idproductoPapel, params.idProductoSistema],
  );

  const { rows: acabadosOrigen } = await client.query(
    `SELECT
       idacabados_papel,
       idcat_tipo_pegado,
       idcat_pegamento,
       idcat_refuerzo_material,
       idcat_refuerzo_medidas,
       idcat_base_material,
       base_medida,
       idcat_empaque,
       pzs_caja,
       idrollo_lam,
       desarrollo_laminado
     FROM acabados_papel
     WHERE idproducto_papel = $1
     ORDER BY idacabados_papel`,
    [params.idProductoSistema],
  );

  for (const acabado of acabadosOrigen) {
    const { rows: acabadoNuevoRows } = await client.query(
      `INSERT INTO acabados_papel (
         idproducto_papel,
         idcat_tipo_pegado,
         idcat_pegamento,
         idcat_refuerzo_material,
         idcat_refuerzo_medidas,
         idcat_base_material,
         base_medida,
         idcat_empaque,
         pzs_caja,
         idrollo_lam,
         desarrollo_laminado
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING idacabados_papel`,
      [
        idproductoPapel,
        acabado.idcat_tipo_pegado,
        acabado.idcat_pegamento,
        acabado.idcat_refuerzo_material,
        acabado.idcat_refuerzo_medidas,
        acabado.idcat_base_material,
        acabado.base_medida,
        acabado.idcat_empaque,
        acabado.pzs_caja,
        acabado.idrollo_lam,
        acabado.desarrollo_laminado,
      ],
    );

    const idacabadosPapelNuevo = Number(acabadoNuevoRows[0].idacabados_papel);

    await client.query(
      `INSERT INTO acabados_asas (idacabados_papel, idcat_tipo_asa)
       SELECT $1, aa.idcat_tipo_asa
       FROM acabados_asas aa
       WHERE aa.idacabados_papel = $2
       ON CONFLICT DO NOTHING`,
      [idacabadosPapelNuevo, acabado.idacabados_papel],
    );

    await client.query(
      `INSERT INTO acabados_laminado (idacabados_papel, idcat_laminado)
       SELECT $1, al.idcat_laminado
       FROM acabados_laminado al
       WHERE al.idacabados_papel = $2
       ON CONFLICT DO NOTHING`,
      [idacabadosPapelNuevo, acabado.idacabados_papel],
    );
  }

  await client.query(
    `INSERT INTO producto_papel_tintas (idproducto_papel, idtintas, cara)
     SELECT $1, ppt.idtintas, ppt.cara
     FROM producto_papel_tintas ppt
     WHERE ppt.idproducto_papel = $2`,
    [idproductoPapel, params.idProductoSistema],
  );

  for (const relacion of MAQUINARIA_PRODUCTO) {
    await client.query(
      `INSERT INTO ${relacion.tabla} (idproducto_papel, ${relacion.columnaCatalogo})
       SELECT $1, origen.${relacion.columnaCatalogo}
       FROM ${relacion.tabla} origen
       WHERE origen.idproducto_papel = $2
       ON CONFLICT DO NOTHING`,
      [idproductoPapel, params.idProductoSistema],
    );
  }

  return { idproductoPapel, idgrupoPapel };
}
