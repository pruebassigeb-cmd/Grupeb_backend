type TipoDocumento = "cotizacion" | "pedido" | "agradecimiento";

interface DatosDocumentoEmail {
  tipo: TipoDocumento;
  folio: string;
  cliente: string;
  empresa?: string | null;
}

export function armarAsuntoDocumento({ tipo }: DatosDocumentoEmail): string {
  if (tipo === "pedido") return "Pedido para autorización de fabricación – Grupo EB";
  if (tipo === "agradecimiento") return "Gracias por visitar Grupo EB en Intermoda";
  return "Cotización solicitada – Grupo EB";
}

function wrapper(contenido: string): string {
  return `
  <div style="font-family: Arial, sans-serif; color: #1a1a1a; max-width: 560px; margin: 0 auto;">
    <div style="background:#0D0D0D; padding: 20px 24px; border-radius: 8px 8px 0 0;">
      <span style="color:#C9922A; font-size: 20px; font-weight: bold; font-family: Georgia, serif;">GRUPO EB</span>
    </div>
    <div style="border: 1px solid #e5e5e5; border-top: none; padding: 24px; border-radius: 0 0 8px 8px; font-size: 14.5px; line-height: 1.6;">
      ${contenido}
      <p style="font-size: 13px; color: #666; margin-top: 24px;">
        Grupo EB<br/>
        Rogelio Ledesma # 102, Col. Cruz Vieja, Tlajomulco de Zúñiga, Jalisco<br/>
        Tel: (33) 3180-3373, 3125-9595, 3180-1460<br/>
        www.grupoeb.com.mx
      </p>
    </div>
  </div>`;
}

export function armarHtmlDocumento({ tipo, cliente }: DatosDocumentoEmail): string {
  const nombre = cliente?.trim() || "cliente";

  if (tipo === "pedido") {
    return wrapper(`
      <p>Estimado(a) ${nombre}:</p>
      <p>¡Esperamos que te encuentres muy bien! 😊</p>
      <p>Adjunto encontrarás el pedido de fabricación en formato PDF con las especificaciones finales de tu proyecto.</p>
      <p>Te invitamos a revisar cuidadosamente la siguiente información antes de autorizar la producción:</p>
      <ul style="margin: 8px 0 16px 20px; padding: 0;">
        <li>Cantidades.</li>
        <li>Medidas.</li>
        <li>Materiales.</li>
        <li>Acabados.</li>
        <li>Colores.</li>
        <li>Información impresa.</li>
        <li>Observaciones generales.</li>
      </ul>
      <p>Una vez que recibamos tu autorización por escrito, junto con el diseño aprobado y el anticipo correspondiente, estaremos encantados de iniciar la producción de tu pedido conforme a la información validada.</p>
      <p>Si detectas algún detalle que deba ajustarse, por favor háznoslo saber antes de autorizar el pedido para realizar las correcciones necesarias.</p>
      <p>Agradecemos mucho tu confianza y quedamos atentos para apoyarte en todo momento.</p>
      <p>¡Será un gusto trabajar en tu proyecto!</p>
      <p>Saludos cordiales,<br/>Equipo Comercial<br/>Grupo EB</p>
    `);
  }

  if (tipo === "agradecimiento") {
    return wrapper(`
      <p>Estimado(a) ${nombre}:</p>
      <p>Fue un gusto recibirte en nuestro stand durante Intermoda.</p>
      <p>Agradecemos el tiempo que nos brindaste para conocer las soluciones de empaque que fabricamos en Grupo EB. Nos especializamos en el desarrollo y fabricación de bolsas de papel, bolsas de plástico, cajas plegadizas, cajas corrugadas, empaques especiales e impresos comerciales, siempre adaptándonos a las necesidades de cada marca.</p>
      <p>Adjunto encontrarás información sobre nuestra empresa y algunos de nuestros productos para que puedas conocer mejor nuestras capacidades de fabricación.</p>
      <p>Si tienes algún proyecto en desarrollo o requieres una cotización, con gusto podemos ayudarte. Nuestro equipo está listo para asesorarte desde el diseño hasta la fabricación.</p>
      <p>Quedamos atentos a tus comentarios y esperamos tener la oportunidad de colaborar contigo muy pronto.</p>
      <p>Muchas gracias por tu interés.</p>
      <p>Saludos cordiales,<br/>Equipo Comercial<br/>Grupo EB</p>
    `);
  }

  return wrapper(`
    <p>Estimado(a) ${nombre}:</p>
    <p>Con mucho gusto te hacemos llegar la cotización correspondiente.</p>
    <p>El archivo adjunto incluye las especificaciones, materiales, acabados, cantidades y precios de acuerdo con la información proporcionada.</p>
    <p>Si requieres realizar algún cambio en medidas, materiales, acabados o cantidades, con gusto prepararemos una nueva propuesta sin compromiso.</p>
    <p>Nuestro objetivo es ofrecerte la mejor solución de empaque para tu marca, con la calidad, atención y tiempos de entrega que distinguen a Grupo EB.</p>
    <p>Quedamos atentos a tus comentarios y esperamos poder participar en este proyecto.</p>
    <p>Agradecemos la oportunidad de servirte.</p>
    <p>Saludos cordiales,<br/>Equipo Comercial<br/>Grupo EB</p>
  `);
}