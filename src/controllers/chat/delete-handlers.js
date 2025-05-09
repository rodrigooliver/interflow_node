import { supabase } from '../../lib/supabase.js';
import Sentry from '../../lib/sentry.js';

/**
 * Exclui um chat e suas mensagens associadas
 * @param {string} chatId - ID do chat a ser excluído
 * @param {string} organizationId - ID da organização do chat
 * @returns {Object} - Objeto com status e mensagem/erro
 */
export async function deleteChat(chatId, organizationId) {
    try {
        if (!chatId || !organizationId) {
            return { status: 400, error: 'chatId e organizationId são obrigatórios' };
        }
        
        //Atualizar last_message_id do chat para null
        const { error: updateLastMessageIdError } = await supabase
            .from('chats')
            .update({ last_message_id: null, flow_session_id: null })
            .eq('id', chatId);  

        if (updateLastMessageIdError) {
            Sentry.captureException(updateLastMessageIdError);
            return { status: 500, error: updateLastMessageIdError.message };
        }

        //Excluir mensagens do chat
        const { error: deleteMessagesError } = await supabase
            .from('messages')
            .delete()
            .eq('chat_id', chatId);

        if (deleteMessagesError) {
            Sentry.captureException(deleteMessagesError);
            return { status: 500, error: deleteMessagesError.message };
        }

        //Excluir flow_sessions do chat
        const { error: deleteFlowSessionsError } = await supabase
            .from('flow_sessions')
            .delete()
            .eq('chat_id', chatId);
            
        if (deleteFlowSessionsError) {
            Sentry.captureException(deleteFlowSessionsError);
            return { status: 500, error: deleteFlowSessionsError.message };
        }

        //Excluir chat
        const { data, error } = await supabase
            .from('chats')
            .delete()
            .eq('id', chatId)
            .eq('organization_id', organizationId);

        if (error) {
            Sentry.captureException(error);
            return { status: 500, error: error.message };
        }

        return { status: 200, message: 'Chat deletado com sucesso' };
    } catch (error) {
        Sentry.captureException(error);
        return { status: 500, error: error.message };
    }
}

export async function deleteChatRoute(req, res) {
    const { chatId, organizationId } = req.params;
    
    const result = await deleteChat(chatId, organizationId);
    
    return res.status(result.status).json(result.error ? { error: result.error } : { message: result.message });
}
