/**
 * TABLAS CONSULTABLES DESDE LA UI
 *
 * La bitácora registra ~113 tablas, pero no todas se consultan desde una
 * pantalla. Este archivo es la lista blanca del endpoint /api/auditoria:
 * si una tabla no está aquí, no se puede pedir su historial.
 *
 * Es lista blanca por dos razones:
 *   1. El nombre de tabla entra a un identificador SQL para leer el sello de
 *      autoría. Validarlo contra este objeto es lo que evita la inyección.
 *   2. Hay tablas que no queremos exponer aunque estén auditadas.
 *
 * Agregar una tabla nueva es agregar una entrada. Las etiquetas de campo son
 * opcionales: lo que no esté aquí se muestra con un nombre derivado
 * automáticamente (precio_500 → "Precio 500").
 */

export type ModoAuditoria = "discreto" | "principal";

export interface TablaAuditable {
  /** Columna por la que se consulta el historial. Debe coincidir con el
   *  primer argumento del trigger trg_bitacora de esa tabla. */
  pk: string;

  /** Nombre legible, para el encabezado del panel. */
  etiqueta: string;

  /** Cómo lo pinta el frontend por omisión. "discreto" = botón ⓘ;
   *  "principal" = bloque visible. El componente puede sobrescribirlo. */
  modo: ModoAuditoria;

  /** Privilegio extra para ver el historial. Sin esto basta con estar
   *  autenticado — que es lo correcto para un catálogo, pero no para
   *  permisos de usuario ni para pagos. */
  permiso?: string;

  /** Etiquetas legibles por columna. */
  campos?: Record<string, string>;

  /** Columnas que NUNCA se devuelven, ni en el diff ni en el payload.
   *  Datos sensibles o ruido puro. */
  ocultar?: string[];
}

// Campos técnicos que no le dicen nada a nadie. Se filtran en todas las
// tablas, además de lo que cada una liste en `ocultar`.
export const CAMPOS_TECNICOS = [
  "created_at",
  "updated_at",
  "creado_por",
  "actualizado_por",
  "eliminado_at",
  "eliminado_por",
];

export const TABLAS_AUDITABLES: Record<string, TablaAuditable> = {
  // ══════════════════════════════════════════════════════════
  // DINERO — información principal, con privilegio
  // ══════════════════════════════════════════════════════════
  venta_pago: {
    pk: "idventa_pago",
    etiqueta: "Pago",
    modo: "principal",
    permiso: "Editar Anticipo y Liquidación",
    campos: {
      monto: "Monto",
      moneda: "Moneda",
      tipo_cambio_aplicado: "Tipo de cambio aplicado",
      monto_moneda_venta: "Monto en moneda de la venta",
      es_anticipo: "Es anticipo",
      es_credito_anticipo: "Anticipo por crédito",
      observacion: "Observación",
      fecha: "Fecha del pago",
      metodo_pago_idmetodo_pago: "Método de pago",
    },
  },

  ventas: {
    pk: "idventas",
    etiqueta: "Venta",
    modo: "principal",
    permiso: "Editar Anticipo y Liquidación",
    campos: {
      subtotal: "Subtotal",
      iva: "IVA",
      total: "Total",
      anticipo: "Anticipo",
      abono: "Abono",
      saldo: "Saldo",
      moneda: "Moneda",
      tipo_cambio: "Tipo de cambio",
      subtotal_real: "Subtotal real",
      iva_real: "IVA real",
      total_real: "Total real",
      diferencia_total: "Diferencia",
      fecha_liquidacion: "Fecha de liquidación",
    },
  },

  // ══════════════════════════════════════════════════════════
  // COTIZACIÓN / PEDIDO — información principal
  // ══════════════════════════════════════════════════════════
  solicitud: {
    pk: "idsolicitud",
    etiqueta: "Cotización / Pedido",
    modo: "principal",
    campos: {
      no_cotizacion: "No. de cotización",
      no_pedido: "No. de pedido",
      estado: "Estado",
      prioridad: "Prioridad",
      sin_iva: "Sin IVA",
      moneda: "Moneda",
      tipo_cambio: "Tipo de cambio",
      fecha_aprobacion: "Fecha de aprobación",
      visible_hasta: "Visible hasta",
      clientes_idclientes: "Cliente",
    },
  },

  solicitud_detalle: {
    pk: "idsolicitud_detalle",
    etiqueta: "Partida de la cotización",
    modo: "principal",
    campos: {
      cantidad: "Cantidad",
      precio_unitario: "Precio unitario",
      precio_total: "Precio total",
      kilogramos: "Kilogramos",
      modo_cantidad: "Modo de cantidad",
      aprobado: "Aprobado",
    },
  },

  herramental: {
    pk: "id_herramental",
    etiqueta: "Herramental",
    modo: "principal",
  },

  // ══════════════════════════════════════════════════════════
  // DISEÑO — información principal (ya se refleja en el chat)
  // ══════════════════════════════════════════════════════════
  orden_diseno: {
    pk: "idorden_diseno",
    etiqueta: "Orden de diseño",
    modo: "principal",
    campos: {
      estado: "Estado",
      version_actual: "Versión actual",
      autorizado_at: "Fecha de autorización",
      no_orden_diseno: "No. de orden",
    },
  },

  orden_diseno_ficha: {
    pk: "idficha",
    etiqueta: "Ficha de diseño",
    modo: "principal",
    campos: {
      especificacion: "Especificación",
      compromiso_entrega: "Compromiso de entrega",
      fecha_conclusion: "Fecha de conclusión",
      comentarios: "Comentarios",
      version: "Versión",
      estado: "Estado",
    },
  },

  ficha_detalle: {
    pk: "idficha_detalle",
    etiqueta: "Detalle de la ficha",
    modo: "principal",
    campos: {
      tipo_elemento: "Tipo",
      nombre: "Nombre",
      detalle: "Detalle",
      url: "Enlace",
    },
  },

  ficha_pantone: {
    pk: "idficha_pantone",
    etiqueta: "Pantone de la ficha",
    modo: "principal",
    campos: { codigo: "Código", hex_referencia: "Referencia", cara: "Cara" },
  },

  mensaje_diseno: {
    pk: "idmensaje",
    etiqueta: "Mensaje del chat",
    modo: "principal",
    campos: { contenido: "Contenido", tipo: "Tipo" },
  },

  revision_diseno: {
    pk: "idrevision",
    etiqueta: "Revisión de diseño",
    modo: "principal",
    campos: {
      numero_version: "Versión",
      tipo: "Tipo",
      observaciones: "Observaciones",
      es_version_final: "Versión final",
      ficha_version: "Versión de la ficha",
    },
  },

  orden_diseno_participante: {
    pk: "idparticipante",
    etiqueta: "Participante de la orden",
    modo: "principal",
    campos: { usuario_id: "Usuario", rol_en_orden: "Rol" },
  },

  // ══════════════════════════════════════════════════════════
  // PRODUCCIÓN Y ENVÍOS — información principal
  // ══════════════════════════════════════════════════════════
  orden_produccion: {
    pk: "idproduccion",
    etiqueta: "Orden de producción",
    modo: "principal",
    campos: {
      no_produccion: "No. de producción",
      fecha_entrega: "Fecha de entrega",
      proceso_actual: "Proceso actual",
      kilos: "Kilos",
      metros: "Metros",
      kilos_merma: "Kilos de merma",
      pzas_merma: "Piezas de merma",
    },
  },

  envio: {
    pk: "idenvio",
    etiqueta: "Envío",
    modo: "principal",
  },

  nota_remision: {
    pk: "idnota",
    etiqueta: "Nota de remisión",
    modo: "principal",
  },

  bitacora_reparto: {
    pk: "idbitacora",
    etiqueta: "Bitácora de reparto",
    modo: "principal",
  },

  // ══════════════════════════════════════════════════════════
  // PERSONAS Y PERMISOS — principal, con privilegio
  // ══════════════════════════════════════════════════════════
  usuarios: {
    pk: "idusuario",
    etiqueta: "Usuario",
    modo: "principal",
    permiso: "Crear/Editar/Eliminar Usuarios",
    campos: {
      correo: "Correo",
      nombre: "Nombre",
      apellido: "Apellido",
      roles_idroles: "Rol",
      telefono: "Teléfono",
      activo: "Activo",
    },
    // El código de acceso nunca sale del backend, ni en un diff.
    ocultar: ["codigo"],
  },

  privilegios_has_usuarios: {
    pk: "usuarios_idusuario",
    etiqueta: "Permisos del usuario",
    modo: "principal",
    permiso: "Crear/Editar/Eliminar Usuarios",
    campos: { privilegios_idprivilegios: "Privilegio" },
  },

  clientes: {
    pk: "idclientes",
    etiqueta: "Cliente",
    modo: "discreto",
    campos: {
      empresa: "Empresa",
      razon_social: "Razón social",
      correo: "Correo",
      telefono: "Teléfono",
      celular: "Celular",
      atencion: "Atención a",
      rfc_rs: "RFC",
      cp_rs: "Código postal",
      identificar: "Identificador",
      clasificacion_expo: "Clasificación expo",
      observaciones_expo: "Observaciones expo",
    },
  },

  // ══════════════════════════════════════════════════════════
  // PROVEEDORES E INSUMOS — discreto (botón ⓘ)
  // ══════════════════════════════════════════════════════════
  proveedor: {
    pk: "idproveedor",
    etiqueta: "Proveedor",
    modo: "discreto",
    campos: {
      nombre: "Nombre",
      contacto: "Contacto",
      telefono: "Teléfono",
      correo: "Correo",
      direccion: "Dirección",
      notas: "Notas",
      activo: "Activo",
      rfc_proveedor: "RFC",
    },
  },

  proveedor_facturacion: {
    pk: "idproveedor_facturacion",
    etiqueta: "Datos bancarios del proveedor",
    modo: "discreto",
    permiso: "Crear/Editar/Eliminar Proveedores",
    campos: {
      banco: "Banco",
      nombre_cuenta: "Nombre de la cuenta",
      condicion_compra: "Condición de compra",
      dias_credito: "Días de crédito",
      activo: "Activo",
    },
    // Números de cuenta y CLABE no viajan al frontend en un historial.
    ocultar: ["cuenta", "clabe", "convenio"],
  },

  insumo: {
    pk: "idinsumo",
    etiqueta: "Insumo",
    modo: "discreto",
    campos: {
      nombre: "Nombre",
      clave_producto: "Clave",
      unidad: "Unidad",
      activo: "Activo",
      tipo_insumo_id: "Tipo de insumo",
    },
  },

  insumo_proveedor: {
    pk: "idinsumo_proveedor",
    etiqueta: "Insumo por proveedor",
    modo: "discreto",
    campos: {
      codigo: "Código",
      precio: "Precio",
      minimo_compra: "Mínimo de compra",
      notas: "Notas",
      activo: "Activo",
    },
  },

  // ══════════════════════════════════════════════════════════
  // CATÁLOGOS DE PRODUCTO Y PRECIO — discreto (botón ⓘ)
  // ══════════════════════════════════════════════════════════
  producto_papel: {
    pk: "idproducto_papel",
    etiqueta: "Producto de papel",
    modo: "discreto",
    campos: {
      medida: "Medida",
      ancho: "Ancho",
      altura: "Altura",
      fuelle: "Fuelle",
      descripcion_papel: "Descripción",
      precio_500: "Precio 500 pzs",
      precio_1000: "Precio 1000 pzs",
      precio_3000: "Precio 3000 pzs",
      costo_laminado: "Costo de laminado",
      tamano_prod: "Tamaño de producto",
      activo: "Activo",
    },
  },

  configuracion_plastico: {
    pk: "idconfiguracion_plastico",
    etiqueta: "Producto de plástico",
    modo: "discreto",
    campos: {
      identificador: "Identificador",
      medida: "Medida",
      ancho: "Ancho",
      altura: "Altura",
      fuelle_fondo: "Fuelle de fondo",
      fuelle_latiz: "Fuelle lateral izq.",
      fuelle_latde: "Fuelle lateral der.",
      refuerzo: "Refuerzo",
      por_kilo: "Piezas por kilo",
      precio_500: "Precio 500 pzs",
      precio_1000: "Precio 1000 pzs",
      precio_3000: "Precio 3000 pzs",
      descripcion: "Descripción",
      activo: "Activo",
    },
  },

  catalogo_expo: {
    pk: "idcatalogo_expo",
    etiqueta: "Producto de catálogo expo",
    modo: "discreto",
    campos: {
      nombre: "Nombre",
      categoria: "Categoría",
      medida: "Medida",
      material: "Material",
      calibre: "Calibre",
      tintas: "Tintas",
      precio_500: "Precio 500 pzs",
      precio_1000: "Precio 1000 pzs",
      precio_3000: "Precio 3000 pzs",
      activo: "Activo",
    },
  },

  acabado_costo: {
    pk: "idacabado_costo",
    etiqueta: "Costo de acabado",
    modo: "discreto",
    permiso: "Modificar Catalogo de precios",
    campos: { precio_unitario: "Precio unitario", activo: "Activo" },
  },

  tarifas_produccion: {
    pk: "idtarifas_produccion",
    etiqueta: "Tarifa de producción",
    modo: "discreto",
    permiso: "Modificar Catalogo de precios",
    campos: { precio: "Precio", merma_porcentaje: "Merma %" },
  },

  tipo_cambio: {
    pk: "idtipo_cambio",
    etiqueta: "Tipo de cambio",
    modo: "discreto",
  },


ticket: {
  pk: "idticket",
  etiqueta: "Ticket",
  modo: "principal",
  campos: {
    titulo: "Título", estado: "Estado", prioridad: "Prioridad",
    ubicacion: "Ubicación", asignado_a: "Asignado a",
    archivado: "Archivado", fecha_cierre: "Fecha de cierre",
  },
},
ticket_comentario: {
  pk: "idticket_comentario",
  etiqueta: "Comentario de ticket",
  modo: "discreto",
  campos: { comentario: "Comentario", es_interno: "Nota interna" },
},

};

/** Nombre legible de una columna que no tiene etiqueta explícita.
 *  precio_500 → "Precio 500";  no_pedido → "No pedido" */
export const humanizarCampo = (campo: string): string => {
  const limpio = campo.replace(/_/g, " ").trim();
  return limpio.charAt(0).toUpperCase() + limpio.slice(1);
};
