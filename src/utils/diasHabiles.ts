// src/utils/diasHabiles.ts
//
// Réplica exacta de `contarDiasHabiles` en Seguimiento.tsx (frontend), para
// que el número que sale en los correos del reporte semanal coincida con lo
// que el usuario ve en pantalla. Solo excluye sábado/domingo — no maneja
// festivos (igual que el original).

export function contarDiasHabiles(desde: Date, hasta: Date): number {
  // Normaliza a medianoche para no arrastrar horas/minutos
  const inicio = new Date(desde.getFullYear(), desde.getMonth(), desde.getDate());
  const fin = new Date(hasta.getFullYear(), hasta.getMonth(), hasta.getDate());
  if (fin <= inicio) return 0;

  let dias = 0;
  const cursor = new Date(inicio);
  while (cursor < fin) {
    cursor.setDate(cursor.getDate() + 1);
    const diaSemana = cursor.getDay(); // 0 = domingo, 6 = sábado
    if (diaSemana !== 0 && diaSemana !== 6) dias++;
  }
  return dias;
}