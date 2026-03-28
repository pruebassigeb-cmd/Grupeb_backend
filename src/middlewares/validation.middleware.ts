import { Request, Response, NextFunction } from "express";
import validator from "validator";

// ==========================
// VALIDACIÓN DE LOGIN
// ==========================
export const validateLogin = (req: Request, res: Response, next: NextFunction) => {
  const { codigo, correo } = req.body;
  
  if (!codigo || !correo) {
    return res.status(400).json({ error: "Correo y código son requeridos" });
  }
  
  if (typeof codigo !== "string" || typeof correo !== "string") {
    return res.status(400).json({ error: "Datos de entrada inválidos" });
  }
  
  const codigoLimpio = codigo.trim().replace(/\D/g, "");
  if (!/^\d{5}$/.test(codigoLimpio)) {
    return res.status(400).json({ error: "Formato de código inválido" });
  }
  
  const correoLimpio = correo.trim().toLowerCase();
  if (!validator.isEmail(correoLimpio)) {
    return res.status(400).json({ error: "Formato de correo inválido" });
  }
  
  if (correoLimpio.length > 255) {
    return res.status(400).json({ error: "Correo demasiado largo" });
  }
  
  req.body.codigo = codigoLimpio;
  req.body.correo = correoLimpio;
  
  next();
};

// ==========================
// VALIDACIÓN DE CREAR USUARIO
// ==========================
export const validateCreateUsuario = (req: Request, res: Response, next: NextFunction) => {
  let { nombre, apellido, correo, telefono, codigo, roles_idroles, privilegios } = req.body;

  if (!nombre || !apellido || !correo || !codigo) {
    return res.status(400).json({ 
      error: "Nombre, apellido, correo y código son requeridos" 
    });
  }

  if (typeof nombre !== "string" || typeof apellido !== "string" || typeof correo !== "string") {
    return res.status(400).json({ error: "Datos de entrada inválidos" });
  }

  nombre = validator.escape(nombre.trim());
  if (nombre.length < 2 || nombre.length > 50) {
    return res.status(400).json({ error: "El nombre debe tener entre 2 y 50 caracteres" });
  }
  if (!/^[a-zA-ZáéíóúÁÉÍÓÚñÑ\s]+$/.test(nombre)) {
    return res.status(400).json({ error: "El nombre solo puede contener letras" });
  }

  apellido = validator.escape(apellido.trim());
  if (apellido.length < 2 || apellido.length > 50) {
    return res.status(400).json({ error: "El apellido debe tener entre 2 y 50 caracteres" });
  }
  if (!/^[a-zA-ZáéíóúÁÉÍÓÚñÑ\s]+$/.test(apellido)) {
    return res.status(400).json({ error: "El apellido solo puede contener letras" });
  }

  correo = correo.trim().toLowerCase();
  if (!validator.isEmail(correo)) {
    return res.status(400).json({ error: "El formato del correo no es válido" });
  }
  correo = validator.normalizeEmail(correo) || correo;

  if (telefono) {
    telefono = telefono.toString().replace(/\D/g, "");
    if (!/^[0-9]{10}$/.test(telefono)) {
      return res.status(400).json({ error: "El teléfono debe tener 10 dígitos" });
    }
  }

  if (typeof codigo !== "string") {
    return res.status(400).json({ error: "Datos de entrada inválidos" });
  }
  codigo = codigo.trim().replace(/\D/g, "");
  if (!/^\d{5}$/.test(codigo)) {
    return res.status(400).json({ error: "Datos de entrada inválidos" });
  }

  if (!roles_idroles || !Number.isInteger(Number(roles_idroles)) || Number(roles_idroles) < 1) {
    return res.status(400).json({ error: "Debe seleccionar un rol válido" });
  }

  if (privilegios) {
    if (!Array.isArray(privilegios)) {
      return res.status(400).json({ error: "Los privilegios deben ser un arreglo" });
    }
    const privilegiosValidos = privilegios.every(
      (id: any) => Number.isInteger(Number(id)) && Number(id) > 0
    );
    if (!privilegiosValidos) {
      return res.status(400).json({ error: "Los privilegios deben ser números válidos" });
    }
  }

  req.body = {
    nombre,
    apellido,
    correo,
    telefono: telefono || null,
    codigo,
    roles_idroles: Number(roles_idroles),
    privilegios: privilegios || []
  };

  next();
};

// ==========================
// VALIDACIÓN DE ACTUALIZAR USUARIO
// ==========================
export const validateUsuario = (req: Request, res: Response, next: NextFunction) => {
  let { nombre, apellido, correo, telefono, codigo, roles_idroles, privilegios } = req.body;

  if (!nombre || !apellido || !correo) {
    return res.status(400).json({ 
      error: "Nombre, apellido y correo son requeridos" 
    });
  }

  if (typeof nombre !== "string" || typeof apellido !== "string" || typeof correo !== "string") {
    return res.status(400).json({ error: "Datos de entrada inválidos" });
  }

  nombre = validator.escape(nombre.trim());
  if (nombre.length < 2 || nombre.length > 50) {
    return res.status(400).json({ error: "El nombre debe tener entre 2 y 50 caracteres" });
  }
  if (!/^[a-zA-ZáéíóúÁÉÍÓÚñÑ\s]+$/.test(nombre)) {
    return res.status(400).json({ error: "El nombre solo puede contener letras" });
  }

  apellido = validator.escape(apellido.trim());
  if (apellido.length < 2 || apellido.length > 50) {
    return res.status(400).json({ error: "El apellido debe tener entre 2 y 50 caracteres" });
  }
  if (!/^[a-zA-ZáéíóúÁÉÍÓÚñÑ\s]+$/.test(apellido)) {
    return res.status(400).json({ error: "El apellido solo puede contener letras" });
  }

  correo = correo.trim().toLowerCase();
  if (!validator.isEmail(correo)) {
    return res.status(400).json({ error: "El formato del correo no es válido" });
  }
  correo = validator.normalizeEmail(correo) || correo;

  if (telefono) {
    telefono = telefono.toString().replace(/\D/g, "");
    if (!/^[0-9]{10}$/.test(telefono)) {
      return res.status(400).json({ error: "El teléfono debe tener 10 dígitos" });
    }
  }

  if (codigo && codigo.trim() !== "") {
    if (typeof codigo !== "string") {
      return res.status(400).json({ error: "Datos de entrada inválidos" });
    }
    codigo = codigo.trim().replace(/\D/g, "");
    if (!/^\d{5}$/.test(codigo)) {
      return res.status(400).json({ error: "Datos de entrada inválidos" });
    }
  }

  if (!roles_idroles || !Number.isInteger(Number(roles_idroles)) || Number(roles_idroles) < 1) {
    return res.status(400).json({ error: "Debe seleccionar un rol válido" });
  }

  if (privilegios) {
    if (!Array.isArray(privilegios)) {
      return res.status(400).json({ error: "Los privilegios deben ser un arreglo" });
    }
    const privilegiosValidos = privilegios.every(
      (id: any) => Number.isInteger(Number(id)) && Number(id) > 0
    );
    if (!privilegiosValidos) {
      return res.status(400).json({ error: "Los privilegios deben ser números válidos" });
    }
  }

  req.body = {
    nombre,
    apellido,
    correo,
    telefono: telefono || null,
    codigo: codigo || undefined,
    roles_idroles: Number(roles_idroles),
    privilegios: privilegios || []
  };

  next();
};

// ==========================
// VALIDACIÓN DE CREAR CLIENTE
// — Todos los campos son opcionales —
// ==========================
export const validateCreateCliente = (req: Request, res: Response, next: NextFunction) => {
  let {
    empresa,
    correo,
    telefono,
    atencion,
    razon_social,
    impresion,
    celular,
    regimen_fiscal_idregimen_fiscal,
    metodo_pago_idmetodo_pago,
    forma_pago_idforma_pago,
    rfc,
    correo_facturacion,
    uso_cfdi,
    moneda,
    domicilio,
    numero,
    colonia,
    codigo_postal,
    poblacion,
    estado,
  } = req.body;

  // ── Empresa (opcional) ──
  if (empresa) {
    if (typeof empresa !== "string") {
      return res.status(400).json({ error: "Datos de entrada inválidos" });
    }
    empresa = validator.escape(empresa.trim());
    if (empresa.length > 128) {
      return res.status(400).json({ error: "La empresa no puede exceder 128 caracteres" });
    }
  }

  // ── Correo (opcional, pero si se da debe ser válido) ──
  if (correo) {
    if (typeof correo !== "string") {
      return res.status(400).json({ error: "Datos de entrada inválidos" });
    }
    correo = correo.trim().toLowerCase();
    if (!validator.isEmail(correo)) {
      return res.status(400).json({ error: "El formato del correo no es válido" });
    }
    correo = validator.normalizeEmail(correo) || correo;
  }

  // ── Teléfono (opcional) ──
  if (telefono) {
    telefono = telefono.toString().replace(/\D/g, "");
    if (telefono.length > 0 && (telefono.length < 10 || telefono.length > 15)) {
      return res.status(400).json({ error: "El teléfono debe tener entre 10 y 15 dígitos" });
    }
  }

  // ── Celular (opcional) ──
  if (celular) {
    celular = celular.toString().replace(/\D/g, "");
    if (celular.length > 0 && (celular.length < 10 || celular.length > 15)) {
      return res.status(400).json({ error: "El celular debe tener entre 10 y 15 dígitos" });
    }
  }

  // ── Atención (opcional) ──
  if (atencion) {
    atencion = validator.escape(atencion.trim());
    if (atencion.length > 128) {
      return res.status(400).json({ error: "El campo atención no puede exceder 128 caracteres" });
    }
  }

  // ── Razón social (opcional) ──
  if (razon_social) {
    razon_social = validator.escape(razon_social.trim());
    if (razon_social.length > 128) {
      return res.status(400).json({ error: "La razón social no puede exceder 128 caracteres" });
    }
  }

  // ── Impresión (opcional) ──
  if (impresion) {
    impresion = validator.escape(impresion.trim());
    if (impresion.length > 128) {
      return res.status(400).json({ error: "El campo impresión no puede exceder 128 caracteres" });
    }
  }

  // ── FK de catálogos: opcionales, se envían null si no se seleccionaron ──
  const regimenId =
    regimen_fiscal_idregimen_fiscal && Number(regimen_fiscal_idregimen_fiscal) > 0
      ? Number(regimen_fiscal_idregimen_fiscal)
      : null;

  const metodoPagoId =
    metodo_pago_idmetodo_pago && Number(metodo_pago_idmetodo_pago) > 0
      ? Number(metodo_pago_idmetodo_pago)
      : null;

  const formaPagoId =
    forma_pago_idforma_pago && Number(forma_pago_idforma_pago) > 0
      ? Number(forma_pago_idforma_pago)
      : null;

  // ── RFC (opcional) ──
  if (rfc) {
    rfc = validator.escape(rfc.trim().toUpperCase());
    if (!/^[A-Z&Ñ]{3,4}[0-9]{6}[A-Z0-9]{3}$/.test(rfc)) {
      return res.status(400).json({ error: "El formato del RFC no es válido" });
    }
  }

  // ── Correo de facturación (opcional) ──
  if (correo_facturacion) {
    correo_facturacion = correo_facturacion.trim().toLowerCase();
    if (!validator.isEmail(correo_facturacion)) {
      return res.status(400).json({ error: "El formato del correo de facturación no es válido" });
    }
    correo_facturacion = validator.normalizeEmail(correo_facturacion) || correo_facturacion;
  }

  // ── Uso CFDI (opcional) ──
  if (uso_cfdi) {
    uso_cfdi = validator.escape(uso_cfdi.trim());
    if (uso_cfdi.length > 128) {
      return res.status(400).json({ error: "El uso de CFDI no puede exceder 128 caracteres" });
    }
  }

  // ── Moneda (opcional) ──
  if (moneda) {
    moneda = validator.escape(moneda.trim().toUpperCase());
    if (moneda.length > 128) {
      return res.status(400).json({ error: "La moneda no puede exceder 128 caracteres" });
    }
  }

  // ── Domicilio (opcional) ──
  if (domicilio) {
    domicilio = validator.escape(domicilio.trim());
    if (domicilio.length > 128) {
      return res.status(400).json({ error: "El domicilio no puede exceder 128 caracteres" });
    }
  }

  if (numero) {
    numero = validator.escape(numero.trim());
    if (numero.length > 128) {
      return res.status(400).json({ error: "El número no puede exceder 128 caracteres" });
    }
  }

  if (colonia) {
    colonia = validator.escape(colonia.trim());
    if (colonia.length > 128) {
      return res.status(400).json({ error: "La colonia no puede exceder 128 caracteres" });
    }
  }

  if (codigo_postal) {
    codigo_postal = validator.escape(codigo_postal.trim());
    if (!/^\d{5}$/.test(codigo_postal)) {
      return res.status(400).json({ error: "El código postal debe tener 5 dígitos" });
    }
  }

  if (poblacion) {
    poblacion = validator.escape(poblacion.trim());
    if (poblacion.length > 128) {
      return res.status(400).json({ error: "La población no puede exceder 128 caracteres" });
    }
  }

  if (estado) {
    estado = validator.escape(estado.trim());
    if (estado.length > 128) {
      return res.status(400).json({ error: "El estado no puede exceder 128 caracteres" });
    }
  }

  // Actualizar body con datos sanitizados
  req.body = {
    empresa:                         empresa      || null,
    correo:                          correo       || null,
    telefono:                        telefono     || null,
    atencion:                        atencion     || null,
    razon_social:                    razon_social || null,
    impresion:                       impresion    || null,
    celular:                         celular      || null,
    regimen_fiscal_idregimen_fiscal: regimenId,
    metodo_pago_idmetodo_pago:       metodoPagoId,
    forma_pago_idforma_pago:         formaPagoId,
    rfc:                             rfc                  || null,
    correo_facturacion:              correo_facturacion   || null,
    uso_cfdi:                        uso_cfdi             || null,
    moneda:                          moneda               || null,
    domicilio:                       domicilio            || null,
    numero:                          numero               || null,
    colonia:                         colonia              || null,
    codigo_postal:                   codigo_postal        || null,
    poblacion:                       poblacion            || null,
    estado:                          estado               || null,
  };

  next();
};

// ==========================
// VALIDACIÓN PARA CLIENTE LIGERO
// ==========================
export const validateCreateClienteLigero = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const { nombre, telefono, correo, empresa } = req.body;

  if (!nombre && !correo) {
    return res.status(400).json({
      error: "Se requiere al menos nombre o correo del cliente",
    });
  }

  if (correo && typeof correo === "string") {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(correo)) {
      return res.status(400).json({ error: "Formato de correo inválido" });
    }
  }

  if (nombre && typeof nombre === "string" && nombre.length > 255) {
    return res.status(400).json({ error: "El nombre es demasiado largo (máximo 255 caracteres)" });
  }

  if (empresa && typeof empresa === "string" && empresa.length > 255) {
    return res.status(400).json({ error: "El nombre de empresa es demasiado largo (máximo 255 caracteres)" });
  }

  if (telefono && typeof telefono === "string" && telefono.length > 20) {
    return res.status(400).json({ error: "El teléfono es demasiado largo (máximo 20 caracteres)" });
  }

  next();
};

// ==========================
// VALIDACIÓN DE ACTUALIZAR CLIENTE
// — Reutiliza la misma lógica (todos opcionales) —
// ==========================
export const validateUpdateCliente = (req: Request, res: Response, next: NextFunction) => {
  validateCreateCliente(req, res, next);
};

// ==========================
// VALIDACIÓN DE ID EN PARAMS
// ==========================
export const validateId = (req: Request, res: Response, next: NextFunction) => {
  const { id } = req.params;

  if (!id || !Number.isInteger(Number(id)) || Number(id) < 1) {
    return res.status(400).json({ error: "ID inválido" });
  }

  next();
};

// ==========================
// PROTECCIÓN CONTRA SQL INJECTION
// ==========================
export const preventSQLInjection = (req: Request, res: Response, next: NextFunction) => {
  const suspiciousPatterns = [
    /(\bselect\b|\binsert\b|\bupdate\b|\bdelete\b|\bdrop\b|\bunion\b|\bexec\b)/gi,
    /('|"|\b(or|and)\b.*=)/gi,
    /(--|;|\/\*|\*\/)/g,
  ];

  const checkValue = (value: any): boolean => {
    if (typeof value === "string") {
      return suspiciousPatterns.some((pattern) => pattern.test(value));
    }
    if (typeof value === "object" && value !== null) {
      return Object.values(value).some((v) => checkValue(v));
    }
    return false;
  };

  if (checkValue(req.body) || checkValue(req.query) || checkValue(req.params)) {
    return res.status(400).json({ error: "Entrada no permitida" });
  }

  next();
};

// ==========================
// SANITIZACIÓN GENERAL
// ==========================
export const sanitizeInput = (input: string): string => {
  if (typeof input !== "string") return "";
  let sanitized = validator.escape(input);
  sanitized = sanitized.replace(/\s+/g, " ").trim();
  return sanitized;
};

// ==========================
// VALIDACIÓN CREAR PRODUCTO PLÁSTICO
// ==========================
export const validateCreateProductoPlastico = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const { tipo_producto_plastico_id, material_plastico_id, calibre_id, altura, ancho, medida, por_kilo } = req.body;
  const errors: string[] = [];

  if (!tipo_producto_plastico_id || !Number.isInteger(tipo_producto_plastico_id))
    errors.push("El tipo de producto es requerido y debe ser un número entero");

  if (!material_plastico_id || !Number.isInteger(material_plastico_id))
    errors.push("El material es requerido y debe ser un número entero");

  if (!calibre_id || !Number.isInteger(calibre_id))
    errors.push("El calibre es requerido y debe ser un número entero");

  if (!altura || typeof altura !== "number" || altura <= 0)
    errors.push("La altura es requerida y debe ser mayor a 0");

  if (!ancho || typeof ancho !== "number" || ancho <= 0)
    errors.push("El ancho es requerido y debe ser mayor a 0");

  if (!medida || typeof medida !== "string" || medida.trim() === "")
    errors.push("La medida formateada es requerida");

  if (!por_kilo || typeof por_kilo !== "number" || por_kilo <= 0)
    errors.push("Las bolsas por kilo son requeridas y deben ser mayor a 0");

  if (errors.length > 0) {
    return res.status(400).json({ error: "Datos inválidos", details: errors });
  }

  next();
};

// ==========================
// VALIDACIÓN ACTUALIZAR PRODUCTO PLÁSTICO
// ==========================
export const validateUpdateProductoPlastico = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const { tipo_producto_plastico_id, material_plastico_id, calibre_id, altura, ancho, medida, por_kilo } = req.body;
  const errors: string[] = [];

  if (!tipo_producto_plastico_id || !Number.isInteger(tipo_producto_plastico_id))
    errors.push("El tipo de producto es requerido y debe ser un número entero");

  if (!material_plastico_id || !Number.isInteger(material_plastico_id))
    errors.push("El material es requerido y debe ser un número entero");

  if (!calibre_id || !Number.isInteger(calibre_id))
    errors.push("El calibre es requerido y debe ser un número entero");

  if (!altura || typeof altura !== "number" || altura <= 0)
    errors.push("La altura es requerida y debe ser mayor a 0");

  if (!ancho || typeof ancho !== "number" || ancho <= 0)
    errors.push("El ancho es requerido y debe ser mayor a 0");

  if (!medida || typeof medida !== "string" || medida.trim() === "")
    errors.push("La medida formateada es requerida");

  if (!por_kilo || typeof por_kilo !== "number" || por_kilo <= 0)
    errors.push("Las bolsas por kilo son requeridas y deben ser mayor a 0");

  if (errors.length > 0) {
    return res.status(400).json({ error: "Datos inválidos", details: errors });
  }

  next();
};