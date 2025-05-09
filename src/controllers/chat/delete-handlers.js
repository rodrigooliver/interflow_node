import { supabase } from '../../lib/supabase.js';
import Sentry from '../../lib/sentry.js';


export async function deleteChatRoute(req, res) {
  const { chatId, organizationId} = req.params;

    if (!chatId || !organizationId) {
        return res.status(400).json({ error: 'chatId e organizationId são obrigatórios' });
    }
    //Atualizar last_message_id do chat para null
    const { error: updateLastMessageIdError } = await supabase
        .from('chats')
        .update({ last_message_id: null, flow_session_id: null })
        .eq('id', chatId);  

    if (updateLastMessageIdError) {
        Sentry.captureException(updateLastMessageIdError);
        return res.status(500).json({ error: updateLastMessageIdError.message });
    }

    //Excluir mensagens do chat
    const { error: deleteMessagesError } = await supabase
        .from('messages')
        .delete()
        .eq('chat_id', chatId);

    if (deleteMessagesError) {
        Sentry.captureException(deleteMessagesError);
        return res.status(500).json({ error: deleteMessagesError.message });
    }

    //Excluir flow_sessions do chat
    const { error: deleteFlowSessionsError } = await supabase
        .from('flow_sessions')
        .delete()
        .eq('chat_id', chatId);
        
    if (deleteFlowSessionsError) {
        Sentry.captureException(deleteFlowSessionsError);
        return res.status(500).json({ error: deleteFlowSessionsError.message });
    }

    //Excluir chat
    const { data, error } = await supabase
        .from('chats')
        .delete()
        .eq('id', chatId)
        .eq('organization_id', organizationId);

    if (error) {
        Sentry.captureException(error);
        return res.status(500).json({ error: error.message });
    } 

    return res.status(200).json({ message: 'Chat deletado com sucesso' });
}
