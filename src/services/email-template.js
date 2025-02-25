export function createEmailTemplate(chatId, messages, newMessage) {
  const messageThread = messages
    .map(msg => {
      const isCustomer = msg.sender_type === 'customer';
      const style = isCustomer ? 
        'background-color: #e3f2fd; margin-left: auto; margin-right: 6px; border-left: 3px solid #2196f3;' : 
        'background-color: #f5f5f5; margin-right: auto; margin-left: 6px; border-left: 3px solid #e0e0e0;';
      
      const senderName = isCustomer ? 
        (msg.sender_customer?.name || '👤') : 
        (msg.sender_user?.full_name || '💬');
      
      const timeString = new Date(msg.created_at).toLocaleString() + 
        ` (GMT${new Date(msg.created_at).getTimezoneOffset() >= 0 ? '-' : '+'}${Math.abs(new Date(msg.created_at).getTimezoneOffset()/60).toString().padStart(2, '0')}:00)`;

      // Processar anexos do JSONB
      const attachmentsHtml = msg.attachments?.length ? `
        <div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid #eee;">
          ${msg.attachments.map(attachment => `
            <div style="margin: 4px 0;">
              <a href="${attachment.url}" style="color: #2196f3; text-decoration: none; font-size: 12px;">
                📎 ${attachment.name || attachment.filename}
              </a>
            </div>
          `).join('')}
        </div>
      ` : '';
      
      return `
        <div style="padding: 8px 10px; margin: 4px 0; border-radius: 4px; max-width: 85%; ${style}">
          <div style="margin-bottom: 4px;">
            <span style="font-weight: 500; font-size: 14px;">${senderName}:</span>
          </div>
          <p style="margin: 0 0 4px 0; line-height: 1.4;">${msg.content || ''}</p>
          ${attachmentsHtml}
          <div style="text-align: right;">
            <span style="color: #757575; font-size: 11px;">${timeString}</span>
          </div>
        </div>
      `;
    })
    .join('');

  // Determinar o estilo da nova mensagem
  const isNewMessageCustomer = newMessage.sender_type === 'customer';
  const newMessageStyle = isNewMessageCustomer ?
    'background-color: #e3f2fd; margin-left: auto; margin-right: 6px; border-left: 3px solid #2196f3;' :
    'background-color: #f5f5f5; margin-right: auto; margin-left: 6px; border-left: 3px solid #e0e0e0;';

  const newMessageSenderName = isNewMessageCustomer ? 
    (newMessage.sender_customer?.name || '👤') : 
    (newMessage.sender_user?.full_name || '💬');
  const newMessageTime = new Date(newMessage.created_at).toLocaleString() + 
    ` (GMT${new Date(newMessage.created_at).getTimezoneOffset() >= 0 ? '-' : '+'}${Math.abs(new Date(newMessage.created_at).getTimezoneOffset()/60).toString().padStart(2, '0')}:00)`;

  console.log('Nova mensagem dados:', { // Debug
    sender_type: newMessage.sender_type,
    sender_customer: newMessage.sender_customer,
    sender_user: newMessage.sender_user,
    created_at: newMessage.created_at,
    senderName: newMessageSenderName,
    time: newMessageTime
  });

  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background-color: #ffffff; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); overflow: hidden;">
        <!-- Nova mensagem -->
        <div style="background-color: #f8f9fa; padding: 6px;">
          <div style="padding: 8px 10px; border-radius: 6px; max-width: 85%; ${newMessageStyle}">
            <div style="margin-bottom: 4px;">
              <span style="font-weight: 500; font-size: 14px;">${newMessageSenderName}:</span>
            </div>
            <p style="margin: 0 0 4px 0; line-height: 1.4;">${newMessage.content || ''}</p>
            <div style="text-align: right;">
              <span style="color: #757575; font-size: 11px;">${newMessageTime}</span>
            </div>
          </div>
        </div>

        <!-- Separador -->
        <div style="padding: 4px; background-color: #f5f5f5; text-align: center;">
          📝 👇
        </div>

        <!-- Histórico -->
        <div style="padding: 0px;">
          ${messageThread}
        </div>
      </div>
    </div>
  `;
} 
//<span style="color: #9e9e9e; font-size: 11px;">⌚ ${chatId}</span>