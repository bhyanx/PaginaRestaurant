// server.js - Servidor Express Proxy para Azure CLU + Twilio
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const twilio = require('twilio');

const app = express();
const PORT = process.env.PORT || 4000;

// Permitir CORS para el frontend
app.use(cors());
app.use(express.json());

// Servir archivos estáticos
app.use(express.static(path.join(__dirname, '../../')));

const AZURE_API_KEY = process.env.AZURE_API_KEY;
const AZURE_ENDPOINT = process.env.AZURE_ENDPOINT;
const AZURE_PROJECT = process.env.AZURE_PROJECT;
const AZURE_DEPLOYMENT = process.env.AZURE_DEPLOYMENT;
const AZURE_API_VERSION = process.env.AZURE_API_VERSION || '2024-11-15-preview';

// Credenciales de Twilio
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER;
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Almacenamiento temporal de sesiones (en producción usar base de datos)
const sessions = {};

// Endpoint para procesar mensajes con Azure CLU
app.post('/api/chat', async (req, res) => {
  const { message, sessionId, reservationData, currentIntent } = req.body;
  
  if (!message || !sessionId) {
    return res.status(400).json({ error: "Mensaje o sessionId faltante" });
  }

  try {
    // Inicializar sesión si no existe
    if (!sessions[sessionId]) {
      sessions[sessionId] = {
        reservationData: {},
        conversationHistory: [],
        currentIntent: null,
        slotFillingActive: false
      };
    }

    const session = sessions[sessionId];
    session.conversationHistory.push({ role: 'user', content: message });

    // Si estamos en Slot Filling, procesar el mensaje para extraer entidades
    if (session.slotFillingActive || currentIntent === 'ReservarMesa') {
      return handleSlotFilling(req, res, session, message, reservationData);
    }

    // Llamar a Azure Language Studio CLU para detectar intención y entidades
    const cluUrl = `${AZURE_ENDPOINT}language/:analyze-conversations?api-version=${AZURE_API_VERSION}`;
    
    const cluPayload = {
      kind: "Conversation",
      analysisInput: {
        conversationItem: {
          id: "1",
          participantId: "1",
          text: message
        }
      },
      parameters: {
        projectName: AZURE_PROJECT,
        deploymentName: AZURE_DEPLOYMENT,
        verbose: true,
        stringIndexType: 'TextElement_V8'
      }
    };

    const cluResponse = await axios.post(cluUrl, cluPayload, {
      headers: {
        'Ocp-Apim-Subscription-Key': AZURE_API_KEY,
        'Content-Type': 'application/json'
      }
    });

    // Extraer intención y entidades
    const result = cluResponse.data.result;
    const topIntent = result.prediction.topIntent;
    const entities = result.prediction.entities || [];
    const confidence = result.prediction.intents[0]?.confidenceScore || 0;

    // Procesar según la intención
    let botResponse = '';

    switch (topIntent) {
      case 'Saludo':
        botResponse = "¡Hola! Bienvenido a RicoMar. Puedo ayudarte con reservas, consultar menú, precios y horarios. ¿Qué deseas?";
        break;

      case 'Despedida':
        botResponse = "¡Hasta luego! Gracias por visitarnos. Esperamos verte pronto en RicoMar.";
        break;

      case 'SolicitarAyuda':
        botResponse = "Puedo ayudarte con:\n• Consultar menú y precios\n• Verificar disponibilidad\n• Hacer reservas\n• Modificar reservas\n\n¿Qué necesitas?";
        break;

      case 'ConsultarMenú':
        const menuQuery = "Cuéntame sobre los platos del menú";
        const menuInfo = await getAzureInfo(menuQuery);
        botResponse = menuInfo || "Nuestro menú incluye:\n\n• Ceviche Mixto\n• Papa a la Huancaína\n• Causa Rellena\n• Anticuchos\n• Ají de Gallina\n• Lomo Saltado\n• Arroz con Mariscos\n• Arroz con Pollo\n• Menú Criollo\n• Tallarines Rojos\n\n¿Deseas conocer el precio de alguno?";
        break;

      case 'ConsultarPrecio':
        const platoEntity = entities.find(e => e.category === 'Plato');
        if (platoEntity) {
          const priceQuery = `¿Cuál es el precio del ${platoEntity.text}?`;
          const priceInfo = await getAzureInfo(priceQuery);
          botResponse = priceInfo || `El ${platoEntity.text} cuesta entre S/12 y S/19. ¿Deseas hacer una reserva?`;
        } else {
          botResponse = "Los precios varían entre S/12 y S/19. ¿Cuál plato te interesa?";
        }
        break;

      case 'ConsultarDisponibilidad':
        botResponse = "Estamos abiertos de Lunes a Sábado de 10:00 AM a 11:00 PM. ¿Deseas hacer una reserva?";
        break;

      case 'ReservarMesa':
        // Iniciar Slot Filling
        session.slotFillingActive = true;
        session.currentIntent = 'ReservarMesa';
        
        // Extraer entidades iniciales
        entities.forEach(entity => {
          if (['CantidadPersonas', 'Fecha', 'Hora', 'NombreCliente', 'NúmeroContacto'].includes(entity.category)) {
            session.reservationData[entity.category] = entity.text;
          }
        });

        botResponse = getNextSlotFillingPrompt(session);
        break;

      case 'ModificarReserva':
        botResponse = "Para modificar tu reserva, necesito tu nombre. ¿A nombre de quién está la reserva?";
        break;

      case 'CancelarReserva':
        botResponse = "Entiendo que deseas cancelar tu reserva. ¿Puedes decirme a nombre de quién está la reserva para proceder con la cancelación?";
        break;

      default:
        botResponse = "Interesante pregunta. Puedo ayudarte con menú, precios, reservas, cancelaciones y disponibilidad. ¿Qué deseas saber?";
    }

    session.conversationHistory.push({ role: 'bot', content: botResponse });

    res.json({
      reply: botResponse,
      intent: topIntent,
      confidence: confidence,
      entities: entities,
      reservationData: session.reservationData,
      slotFillingActive: session.slotFillingActive,
      isComplete: false
    });

  } catch (error) {
    console.error('Error al consultar Azure CLU:', error?.response?.data || error.message);
    res.status(500).json({ error: "Error al procesar el mensaje" });
  }
});

// Función para manejar Slot Filling
async function handleSlotFilling(req, res, session, message, reservationData) {
  try {
    // Llamar a Azure Language Studio CLU para extraer entidades del mensaje actual
    const cluUrl = `${AZURE_ENDPOINT}language/:analyze-conversations?api-version=${AZURE_API_VERSION}`;
    
    const cluPayload = {
      kind: "Conversation",
      analysisInput: {
        conversationItem: {
          id: "1",
          participantId: "1",
          text: message
        }
      },
      parameters: {
        projectName: AZURE_PROJECT,
        deploymentName: AZURE_DEPLOYMENT,
        verbose: true,
        stringIndexType: 'TextElement_V8'
      }
    };

    const cluResponse = await axios.post(cluUrl, cluPayload, {
      headers: {
        'Ocp-Apim-Subscription-Key': AZURE_API_KEY,
        'Content-Type': 'application/json'
      }
    });

    const entities = cluResponse.data.result.prediction.entities || [];

    // Extraer entidades y actualizar reservationData
    entities.forEach(entity => {
      if (['CantidadPersonas', 'Fecha', 'Hora', 'NombreCliente', 'NúmeroContacto', 'Plato'].includes(entity.category)) {
        // Si es un plato, guardarlo como PlatoSeleccionado
        if (entity.category === 'Plato') {
          session.reservationData.PlatoSeleccionado = entity.text;
        } else {
          session.reservationData[entity.category] = entity.text;
        }
      }
    });

    // Si no se detectó el plato como entidad, verificar manualmente
    if (!session.reservationData.PlatoSeleccionado) {
      const platosDisponibles = [
        'ceviche mixto', 'papa a la huancaína', 'causa rellena', 'anticuchos', 
        'ají de gallina', 'lomo saltado', 'arroz con mariscos', 'arroz con pollo', 
        'menú criollo', 'tallarines rojos'
      ];
      
      const mensajeLower = message.toLowerCase();
      for (const plato of platosDisponibles) {
        if (mensajeLower.includes(plato)) {
          session.reservationData.PlatoSeleccionado = plato.charAt(0).toUpperCase() + plato.slice(1);
          break;
        }
      }
    }

    // Verificar si faltan datos
    const required = ['NombreCliente', 'NúmeroContacto', 'PlatoSeleccionado', 'CantidadPersonas', 'Fecha', 'Hora'];
    const missing = required.filter(field => !session.reservationData[field]);

    let botResponse = '';
    let isComplete = false;

    if (missing.length === 0) {
      // Reserva completa - confirmar
      isComplete = true;
      const reservationId = generateReservationId();
      
      botResponse = `¡Perfecto! Tu reserva está confirmada\n\n` +
        `Detalles de tu reserva:\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `Nombre: ${session.reservationData.NombreCliente}\n` +
        `Contacto: ${session.reservationData.NúmeroContacto}\n` +
        `Plato: ${session.reservationData.PlatoSeleccionado}\n` +
        `Personas: ${session.reservationData.CantidadPersonas}\n` +
        `Fecha: ${session.reservationData.Fecha}\n` +
        `Hora: ${session.reservationData.Hora}\n` +
        `ID Reserva: ${reservationId}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `¡Te esperamos en RicoMar!`;
      
      session.slotFillingActive = false;
      session.currentIntent = null;

      // Enviar confirmación por WhatsApp con mensaje personalizado
      if (session.reservationData.NúmeroContacto) {
        try {
          // Mensaje personalizado para WhatsApp
          const whatsappMessage = `*CONFIRMACIÓN DE RESERVA - RICOMAR*\n\n` +
            `Hola ${session.reservationData.NombreCliente},\n\n` +
            `¡Tu reserva ha sido confirmada exitosamente!\n\n` +
            `*Detalles de tu reserva:*\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `Nombre: ${session.reservationData.NombreCliente}\n` +
            `Personas: ${session.reservationData.CantidadPersonas}\n` +
            `Fecha: ${session.reservationData.Fecha}\n` +
            `Hora: ${session.reservationData.Hora}\n` +
            `Plato preseleccionado: ${session.reservationData.PlatoSeleccionado}\n` +
            `ID de Reserva: *${reservationId}*\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
            `*Ubicación:*\n` +
            `Parque 47 - 10, Talara Baja, Perú\n\n` +
            `*Contacto:*\n` +
            `Teléfono: +51 900 111 222\n` +
            `Email: ricomar@gmail.com\n\n` +
            `*Horario de atención:*\n` +
            `Lunes a Sábado: 10:00 AM - 11:00 PM\n\n` +
            `¡Te esperamos en RicoMar!\n\n` +
            `_Si necesitas modificar o cancelar tu reserva, contáctanos con tu ID de reserva._`;

          const whatsappResult = await sendWhatsAppMessage(
            session.reservationData.NúmeroContacto,
            whatsappMessage
          );
          if (whatsappResult.success) {
            console.log(`✅ WhatsApp enviado exitosamente. SID: ${whatsappResult.sid}`);
          } else {
            console.error(`❌ Error al enviar WhatsApp: ${whatsappResult.error}`);
          }
        } catch (whatsappError) {
          console.error('Error al enviar WhatsApp:', whatsappError.message);
        }
      }
    } else {
      // Pedir siguiente dato
      botResponse = getNextSlotFillingPrompt(session);
    }

    session.conversationHistory.push({ role: 'bot', content: botResponse });

    res.json({
      reply: botResponse,
      intent: 'ReservarMesa',
      confidence: 1.0,
      entities: entities,
      reservationData: session.reservationData,
      slotFillingActive: !isComplete,
      isComplete: isComplete
    });

  } catch (error) {
    console.error('Error en Slot Filling:', error?.response?.data || error.message);
    res.status(500).json({ error: "Error al procesar tu respuesta" });
  }
}

// Función para obtener información adicional de Azure CLU
async function getAzureInfo(query) {
  try {
    const cluUrl = `${AZURE_ENDPOINT}language/:analyze-conversations?api-version=${AZURE_API_VERSION}`;
    
    const cluPayload = {
      kind: "Conversation",
      analysisInput: {
        conversationItem: {
          id: "1",
          participantId: "1",
          text: query
        }
      },
      parameters: {
        projectName: AZURE_PROJECT,
        deploymentName: AZURE_DEPLOYMENT,
        verbose: true,
        stringIndexType: 'TextElement_V8'
      }
    };

    const cluResponse = await axios.post(cluUrl, cluPayload, {
      headers: {
        'Ocp-Apim-Subscription-Key': AZURE_API_KEY,
        'Content-Type': 'application/json'
      }
    });

    // Extraer la respuesta de Azure
    const result = cluResponse.data.result;
    const topIntent = result.prediction.topIntent;
    const entities = result.prediction.entities || [];

    // Construir respuesta basada en entidades
    let response = '';
    
    if (entities.length > 0) {
      entities.forEach(entity => {
        if (entity.category === 'Plato') {
          response += `📍 ${entity.text}\n`;
        }
      });
    }

    return response || null;
  } catch (error) {
    console.error('Error en getAzureInfo:', error?.response?.data || error.message);
    return null;
  }
}

// Función para obtener el siguiente prompt de Slot Filling
function getNextSlotFillingPrompt(session) {
  const required = ['NombreCliente', 'NúmeroContacto', 'PlatoSeleccionado', 'CantidadPersonas', 'Fecha', 'Hora'];
  const missing = required.filter(field => !session.reservationData[field]);

  if (missing.length === 0) {
    return "Reserva completada";
  }

  const nextField = missing[0];
  const prompts = {
    'NombreCliente': '¿A nombre de quién será la reserva?',
    'NúmeroContacto': '¿Cuál es tu número de contacto? (ej: 987654321)',
    'PlatoSeleccionado': '¿Qué plato te gustaría probar?\n\n• Ceviche Mixto\n• Papa a la Huancaína\n• Causa Rellena\n• Anticuchos\n• Ají de Gallina\n• Lomo Saltado\n• Arroz con Mariscos\n• Arroz con Pollo\n• Menú Criollo\n• Tallarines Rojos',
    'CantidadPersonas': '¿Para cuántas personas deseas la reserva?',
    'Fecha': '¿Para qué fecha? (ej: mañana, el sábado, 25 de noviembre)',
    'Hora': '¿Para qué hora? (ej: 8 pm, 20:00, las 8 de la noche)'
  };

  return prompts[nextField] || 'Por favor, completa tu reserva.';
}

// Función para procesar reservas con Slot Filling
function procesarReserva(session, entities) {
  const required = ['NombreCliente', 'NúmeroContacto', 'PlatoSeleccionado', 'CantidadPersonas', 'Fecha', 'Hora'];
  
  // Extraer entidades y guardar en sesión
  entities.forEach(entity => {
    if (required.includes(entity.category)) {
      if (entity.category === 'Plato') {
        session.reservationData.PlatoSeleccionado = entity.text;
      } else {
        session.reservationData[entity.category] = entity.text;
      }
    }
  });

  // Verificar qué falta
  const missing = required.filter(field => !session.reservationData[field]);

  if (missing.length === 0) {
    return `¡Perfecto! Tu reserva está confirmada:\n• Personas: ${session.reservationData.CantidadPersonas}\n• Fecha: ${session.reservationData.Fecha}\n• Hora: ${session.reservationData.Hora}\n• Nombre: ${session.reservationData.NombreCliente}\n• Contacto: ${session.reservationData.NúmeroContacto}\n• Plato preseleccionado: ${session.reservationData.PlatoSeleccionado}\n\n¡Te esperamos!`;
  }

  // Pedir el siguiente dato faltante
  const nextField = missing[0];
  const prompts = {
    'NombreCliente': '¿A nombre de quién?',
    'NúmeroContacto': '¿Cuál es tu número de contacto?',
    'PlatoSeleccionado': '¿Qué plato te gustaría probar?',
    'CantidadPersonas': '¿Para cuántas personas?',
    'Fecha': '¿Para qué fecha?',
    'Hora': '¿Para qué hora?'
  };

  return prompts[nextField] || 'Completa tu reserva por favor.';
}

// Función para enviar mensaje por WhatsApp
async function sendWhatsAppMessage(phoneNumber, message) {
  try {
    // Formatear número: si no comienza con 'whatsapp:', agregarlo
    // Para Perú, asegurar que tenga el código +51
    let formattedNumber = phoneNumber.replace(/\D/g, ''); // Eliminar todo excepto dígitos
    
    // Si es un número peruano sin código de país, agregar +51
    if (formattedNumber.length === 9 && formattedNumber.startsWith('9')) {
      formattedNumber = '51' + formattedNumber;
    }
    
    formattedNumber = `whatsapp:+${formattedNumber}`;

    // Usar el número de WhatsApp configurado en .env
    // Para Sandbox: 'whatsapp:+14155238886'
    // Para Producción: 'whatsapp:+51987654321' (tu número real)
    const fromNumber = TWILIO_WHATSAPP_NUMBER || 'whatsapp:+14155238886';
    
    const response = await twilioClient.messages.create({
      body: message,
      from: fromNumber,
      to: formattedNumber
    });

    console.log(`WhatsApp enviado a ${formattedNumber}. SID: ${response.sid}`);
    return { success: true, sid: response.sid };
  } catch (error) {
    console.error('Error al enviar WhatsApp:', error.message);
    return { success: false, error: error.message };
  }
}

// Función para generar ID de reserva
function generateReservationId() {
  return 'RES' + Date.now().toString().slice(-8);
}

app.listen(PORT, () => {
  console.log(`Servidor proxy funcionando en http://localhost:${PORT}`);
});

