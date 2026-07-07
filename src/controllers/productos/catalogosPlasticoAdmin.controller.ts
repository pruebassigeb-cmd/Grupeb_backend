import { Request, Response } from "express";
import { pool } from "../../config/db";

// ═══════════════════════════════════════════════════════════════════════════
// ⚠️ AJUSTAR: id del registro en la tabla `productos` que representa la línea
// de "plástico". Corre `SELECT * FROM productos;` para confirmarlo (es una
// tabla chica) y actualiza esta constante antes de dar de alta un tipo de
// producto nuevo.
// ═══════════════════════════════════════════════════════════════════════════
const ID_PRODUCTO_LINEA_PLASTICO = 1;

// ═══════════════════════════════════════════════════════════════════════════
// TIPO DE PRODUCTO PLÁSTICO
// ═══════════════════════════════════════════════════════════════════════════
export const getTiposProductoAdmin = async (req: Request, res: Response) => {
  try {
    const { activo } = req.query;
    let where = "";
    const values: any[] = [];
    if (activo === "true" || activo === "false") {
      where = "WHERE activo = $1";
      values.push(activo === "true");
    }
    const { rows } = await pool.query(
      `SELECT idtipo_producto_plastico AS id, material_plastico_producto AS nombre, activo
       FROM tipo_producto_plastico
       ${where}
       ORDER BY material_plastico_producto ASC`,
      values
    );
    res.json(rows);
  } catch (error: any) {
    console.error("❌ GET TIPOS PRODUCTO PLASTICO ADMIN ERROR:", error.message);
    res.status(500).json({ error: "Error al obtener tipos de producto" });
  }
};

export const crearTipoProductoAdmin = async (req: Request, res: Response) => {
  try {
    const { nombre } = req.body;
    if (!nombre || !String(nombre).trim()) {
      return res.status(400).json({ error: "El nombre es requerido" });
    }
    const { rows } = await pool.query(
      `INSERT INTO tipo_producto_plastico (material_plastico_producto, productos_idproductos, activo)
       VALUES ($1, $2, true)
       RETURNING idtipo_producto_plastico AS id, material_plastico_producto AS nombre, activo`,
      [String(nombre).trim(), ID_PRODUCTO_LINEA_PLASTICO]
    );
    console.log("✅ Tipo de producto plástico creado:", rows[0].nombre);
    res.status(201).json(rows[0]);
  } catch (error: any) {
    if (error.code === "23505") {
      return res.status(409).json({ error: "Ya existe un tipo de producto con ese nombre" });
    }
    console.error("❌ CREAR TIPO PRODUCTO PLASTICO ERROR:", error.message);
    res.status(500).json({ error: "Error al crear el tipo de producto" });
  }
};

export const editarTipoProductoAdmin = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { nombre } = req.body;
    if (!nombre || !String(nombre).trim()) {
      return res.status(400).json({ error: "El nombre es requerido" });
    }
    const { rows } = await pool.query(
      `UPDATE tipo_producto_plastico SET material_plastico_producto = $1
       WHERE idtipo_producto_plastico = $2
       RETURNING idtipo_producto_plastico AS id, material_plastico_producto AS nombre, activo`,
      [String(nombre).trim(), id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "No encontrado" });
    res.json(rows[0]);
  } catch (error: any) {
    if (error.code === "23505") {
      return res.status(409).json({ error: "Ya existe un tipo de producto con ese nombre" });
    }
    console.error("❌ EDITAR TIPO PRODUCTO PLASTICO ERROR:", error.message);
    res.status(500).json({ error: "Error al editar el tipo de producto" });
  }
};

export const desactivarTipoProductoAdmin = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `UPDATE tipo_producto_plastico SET activo = false
       WHERE idtipo_producto_plastico = $1 RETURNING idtipo_producto_plastico`,
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "No encontrado" });
    res.json({ message: "Tipo de producto desactivado" });
  } catch (error: any) {
    console.error("❌ DESACTIVAR TIPO PRODUCTO PLASTICO ERROR:", error.message);
    res.status(500).json({ error: "Error al desactivar" });
  }
};

export const reactivarTipoProductoAdmin = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `UPDATE tipo_producto_plastico SET activo = true
       WHERE idtipo_producto_plastico = $1 RETURNING idtipo_producto_plastico`,
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "No encontrado" });
    res.json({ message: "Tipo de producto reactivado" });
  } catch (error: any) {
    console.error("❌ REACTIVAR TIPO PRODUCTO PLASTICO ERROR:", error.message);
    res.status(500).json({ error: "Error al reactivar" });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// MATERIAL PLÁSTICO
// ═══════════════════════════════════════════════════════════════════════════
export const getMaterialesAdmin = async (req: Request, res: Response) => {
  try {
    const { activo } = req.query;
    let where = "";
    const values: any[] = [];
    if (activo === "true" || activo === "false") {
      where = "WHERE activo = $1";
      values.push(activo === "true");
    }
    const { rows } = await pool.query(
      `SELECT idmaterial_plastico AS id, tipo_material AS nombre, valor, activo
       FROM material_plastico
       ${where}
       ORDER BY tipo_material ASC`,
      values
    );
    res.json(rows);
  } catch (error: any) {
    console.error("❌ GET MATERIALES ADMIN ERROR:", error.message);
    res.status(500).json({ error: "Error al obtener materiales" });
  }
};

export const crearMaterialAdmin = async (req: Request, res: Response) => {
  try {
    const { nombre, valor } = req.body;
    if (!nombre || !String(nombre).trim()) {
      return res.status(400).json({ error: "El nombre es requerido" });
    }
    if (valor === undefined || valor === null || isNaN(Number(valor))) {
      return res.status(400).json({ error: "El valor (factor de cálculo) es requerido y debe ser numérico" });
    }
    const { rows } = await pool.query(
      `INSERT INTO material_plastico (tipo_material, valor, activo)
       VALUES ($1, $2, true)
       RETURNING idmaterial_plastico AS id, tipo_material AS nombre, valor, activo`,
      [String(nombre).trim(), Number(valor)]
    );
    console.log("✅ Material plástico creado:", rows[0].nombre);
    res.status(201).json(rows[0]);
  } catch (error: any) {
    if (error.code === "23505") {
      return res.status(409).json({ error: "Ya existe un material con ese nombre" });
    }
    console.error("❌ CREAR MATERIAL ADMIN ERROR:", error.message);
    res.status(500).json({ error: "Error al crear el material" });
  }
};

export const editarMaterialAdmin = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { nombre, valor } = req.body;
    if (!nombre || !String(nombre).trim()) {
      return res.status(400).json({ error: "El nombre es requerido" });
    }
    if (valor === undefined || valor === null || isNaN(Number(valor))) {
      return res.status(400).json({ error: "El valor (factor de cálculo) es requerido y debe ser numérico" });
    }
    const { rows } = await pool.query(
      `UPDATE material_plastico SET tipo_material = $1, valor = $2
       WHERE idmaterial_plastico = $3
       RETURNING idmaterial_plastico AS id, tipo_material AS nombre, valor, activo`,
      [String(nombre).trim(), Number(valor), id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "No encontrado" });
    res.json(rows[0]);
  } catch (error: any) {
    if (error.code === "23505") {
      return res.status(409).json({ error: "Ya existe un material con ese nombre" });
    }
    console.error("❌ EDITAR MATERIAL ADMIN ERROR:", error.message);
    res.status(500).json({ error: "Error al editar el material" });
  }
};

export const desactivarMaterialAdmin = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `UPDATE material_plastico SET activo = false
       WHERE idmaterial_plastico = $1 RETURNING idmaterial_plastico`,
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "No encontrado" });
    res.json({ message: "Material desactivado" });
  } catch (error: any) {
    console.error("❌ DESACTIVAR MATERIAL ADMIN ERROR:", error.message);
    res.status(500).json({ error: "Error al desactivar" });
  }
};

export const reactivarMaterialAdmin = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `UPDATE material_plastico SET activo = true
       WHERE idmaterial_plastico = $1 RETURNING idmaterial_plastico`,
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "No encontrado" });
    res.json({ message: "Material reactivado" });
  } catch (error: any) {
    console.error("❌ REACTIVAR MATERIAL ADMIN ERROR:", error.message);
    res.status(500).json({ error: "Error al reactivar" });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// CALIBRE
// ═══════════════════════════════════════════════════════════════════════════
export const getCalibresAdmin = async (req: Request, res: Response) => {
  try {
    const { activo } = req.query;
    let where = "";
    const values: any[] = [];
    if (activo === "true" || activo === "false") {
      where = "WHERE activo = $1";
      values.push(activo === "true");
    }
    const { rows } = await pool.query(
      `SELECT idcalibre AS id, calibre, calibre_bopp, gramos, activo
       FROM calibre
       ${where}
       ORDER BY calibre ASC`,
      values
    );
    res.json(rows);
  } catch (error: any) {
    console.error("❌ GET CALIBRES ADMIN ERROR:", error.message);
    res.status(500).json({ error: "Error al obtener calibres" });
  }
};

export const crearCalibreAdmin = async (req: Request, res: Response) => {
  try {
    const { calibre, calibre_bopp, gramos } = req.body;
    if (calibre === undefined || calibre === null || isNaN(Number(calibre))) {
      return res.status(400).json({ error: "El calibre es requerido y debe ser numérico" });
    }
    const { rows } = await pool.query(
      `INSERT INTO calibre (calibre, calibre_bopp, gramos, activo)
       VALUES ($1, $2, $3, true)
       RETURNING idcalibre AS id, calibre, calibre_bopp, gramos, activo`,
      [
        Number(calibre),
        calibre_bopp !== undefined && calibre_bopp !== null && calibre_bopp !== "" ? Number(calibre_bopp) : null,
        gramos !== undefined && gramos !== null && gramos !== "" ? Number(gramos) : null,
      ]
    );
    console.log("✅ Calibre creado:", rows[0].calibre);
    res.status(201).json(rows[0]);
  } catch (error: any) {
    if (error.code === "23505") {
      return res.status(409).json({ error: "Ya existe ese calibre" });
    }
    console.error("❌ CREAR CALIBRE ADMIN ERROR:", error.message);
    res.status(500).json({ error: "Error al crear el calibre" });
  }
};

export const editarCalibreAdmin = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { calibre, calibre_bopp, gramos } = req.body;
    if (calibre === undefined || calibre === null || isNaN(Number(calibre))) {
      return res.status(400).json({ error: "El calibre es requerido y debe ser numérico" });
    }
    const { rows } = await pool.query(
      `UPDATE calibre SET calibre = $1, calibre_bopp = $2, gramos = $3
       WHERE idcalibre = $4
       RETURNING idcalibre AS id, calibre, calibre_bopp, gramos, activo`,
      [
        Number(calibre),
        calibre_bopp !== undefined && calibre_bopp !== null && calibre_bopp !== "" ? Number(calibre_bopp) : null,
        gramos !== undefined && gramos !== null && gramos !== "" ? Number(gramos) : null,
        id,
      ]
    );
    if (rows.length === 0) return res.status(404).json({ error: "No encontrado" });
    res.json(rows[0]);
  } catch (error: any) {
    if (error.code === "23505") {
      return res.status(409).json({ error: "Ya existe ese calibre" });
    }
    console.error("❌ EDITAR CALIBRE ADMIN ERROR:", error.message);
    res.status(500).json({ error: "Error al editar el calibre" });
  }
};

export const desactivarCalibreAdmin = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `UPDATE calibre SET activo = false WHERE idcalibre = $1 RETURNING idcalibre`,
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "No encontrado" });
    res.json({ message: "Calibre desactivado" });
  } catch (error: any) {
    console.error("❌ DESACTIVAR CALIBRE ADMIN ERROR:", error.message);
    res.status(500).json({ error: "Error al desactivar" });
  }
};

export const reactivarCalibreAdmin = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `UPDATE calibre SET activo = true WHERE idcalibre = $1 RETURNING idcalibre`,
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "No encontrado" });
    res.json({ message: "Calibre reactivado" });
  } catch (error: any) {
    console.error("❌ REACTIVAR CALIBRE ADMIN ERROR:", error.message);
    res.status(500).json({ error: "Error al reactivar" });
  }
};