// Chatbot RicoMar - Integración con Azure CLU
document.addEventListener('DOMContentLoaded', function() {
  const toggleBtn = document.getElementById('chat-toggle-btn');
  const closeBtn = document.getElementById('chat-close-btn');
  const chatWindow = document.getElementById('chat-window');
  const sendBtn = document.getElementById('chat-send-btn');
  const input = document.getElementById('chat-input');
  const messagesContainer = document.getElementById('chat-messages');

  // Generar ID único de sesión
  const sessionId = 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  
  // Estado del chatbot
  let chatState = {
    slotFillingActive: false,
    currentIntent: null,
    reservationData: {}
  };

  // Agregar mensaje al chat
  function addMessage(text, isUser = false) {
    const messageDiv = document.createElement('div');
    messageDiv.style.display = 'flex';
    messageDiv.style.justifyContent = isUser ? 'flex-end' : 'flex-start';
    messageDiv.style.marginBottom = '8px';

    const bubble = document.createElement('div');
    
    if (isUser) {
      bubble.style.maxWidth = '75%';
      bubble.style.padding = '10px 14px';
      bubble.style.borderRadius = '12px';
      bubble.style.borderBottomRightRadius = '4px';
      bubble.style.fontSize = '14px';
      bubble.style.lineHeight = '1.5';
      bubble.style.wordWrap = 'break-word';
      bubble.style.whiteSpace = 'pre-wrap';
      bubble.style.background = 'linear-gradient(135deg, #cda45e 0%, #b8934f 100%)';
      bubble.style.color = 'white';
      bubble.style.boxShadow = '0 2px 8px rgba(205, 164, 94, 0.3)';
      bubble.style.fontWeight = '500';
      bubble.textContent = text;
    } else {
      bubble.style.cssText = 'background: #29261f; padding: 14px 16px; border-radius: 12px; max-width: 85%; box-shadow: 0 2px 8px rgba(0,0,0,0.3); border-left: 4px solid #cda45e; font-family: \'Roboto\', sans-serif;';
      bubble.style.whiteSpace = 'pre-wrap';
      bubble.innerHTML = `<p style="margin: 0; color: rgba(255, 255, 255, 0.9); font-size: 14px; line-height: 1.6; font-weight: 500; font-family: 'Roboto', sans-serif;">${text.replace(/\n/g, '<br>')}</p>`;
    }

    messageDiv.appendChild(bubble);
    messagesContainer.appendChild(messageDiv);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  // Mostrar indicador de escritura
  function showTyping() {
    const messageDiv = document.createElement('div');
    messageDiv.style.display = 'flex';
    messageDiv.style.justifyContent = 'flex-start';
    messageDiv.style.marginBottom = '8px';
    messageDiv.id = 'typing-indicator';

    const bubble = document.createElement('div');
    bubble.style.cssText = 'background: #29261f; padding: 14px 16px; border-radius: 12px; max-width: 85%; box-shadow: 0 2px 8px rgba(0,0,0,0.3); border-left: 4px solid #cda45e; font-family: \'Roboto\', sans-serif;';
    bubble.innerHTML = '<p style="margin: 0; color: rgba(255, 255, 255, 0.9); font-size: 14px; line-height: 1.5; font-weight: 500; font-family: \'Roboto\', sans-serif;"><em>Escribiendo...</em></p>';

    messageDiv.appendChild(bubble);
    messagesContainer.appendChild(messageDiv);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  // Remover indicador de escritura
  function removeTyping() {
    const typing = document.getElementById('typing-indicator');
    if (typing) typing.remove();
  }

  // Toggle chat window
  toggleBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    if (chatWindow.style.display === 'none' || chatWindow.style.display === '') {
      chatWindow.style.display = 'flex';
      input.focus();
    } else {
      chatWindow.style.display = 'none';
    }
  });

  // Close chat
  closeBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    chatWindow.style.display = 'none';
  });

  // Send message
  async function sendMessage() {
    const message = input.value.trim();
    if (!message) return;

    // Agregar mensaje del usuario
    addMessage(message, true);
    input.value = '';
    input.focus();

    // Mostrar indicador de escritura
    showTyping();

    try {
      // Enviar mensaje al backend
      const response = await fetch('/chatbot', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          message: message,
          sessionId: sessionId,
          reservationData: chatState.reservationData,
          currentIntent: chatState.currentIntent
        })
      });

      const data = await response.json();
      removeTyping();

      if (response.ok) {
        // Actualizar estado del chatbot
        chatState.slotFillingActive = data.slotFillingActive || false;
        chatState.currentIntent = data.intent;
        chatState.reservationData = data.reservationData || {};

        // Mostrar respuesta del bot
        addMessage(data.reply, false);
        
        // Log de debug (opcional)
        console.log('Intent:', data.intent, 'Confidence:', data.confidence, 'SlotFilling:', data.slotFillingActive);
      } else {
        removeTyping();
        addMessage('Disculpa, hubo un error al procesar tu mensaje. Intenta de nuevo.', false);
      }
    } catch (error) {
      removeTyping();
      console.error('Error:', error);
      addMessage('Disculpa, no puedo conectar con el servidor. Intenta más tarde.', false);
    }
  }

  // Event listeners
  sendBtn.addEventListener('click', sendMessage);
  input.addEventListener('keypress', function(e) {
    if (e.key === 'Enter') {
      sendMessage();
    }
  });

  // Cerrar chat al hacer clic fuera
  const chatbotContainer = document.getElementById('chatbot-container');
  
  document.addEventListener('click', function(e) {
    // Verificar si el chat está abierto
    const isOpen = chatWindow.style.display === 'flex' || 
                   (chatWindow.style.display !== 'none' && window.getComputedStyle(chatWindow).display === 'flex');
    
    if (isOpen) {
      // Verificar si el clic fue fuera del contenedor del chatbot
      if (chatbotContainer && !chatbotContainer.contains(e.target)) {
        chatWindow.style.display = 'none';
      }
    }
  });
});
