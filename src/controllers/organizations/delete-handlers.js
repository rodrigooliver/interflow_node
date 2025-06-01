import { supabase } from '../../lib/supabase.js';
import Sentry from '../../lib/sentry.js';

export async function deleteOrganizationRoute(req, res) {
    const { organizationId } = req.params;
    const result = await deleteOrganization(organizationId);
    return res.status(result.status).json(result.error ? { error: result.error } : { message: result.message });
}

export async function deleteOrganization(organizationId) {
    try {
        //Excluir os arquivos de upload do storage

        //Verificar se possui channel ativo e desconectar no api

        const { data: channel, error: channelError } = await supabase
            .from('chat_channels')
            .select('*')
            .eq('organization_id', organizationId)
            .eq('is_connected', true);

        if( channel.length > 0 ) {
            Sentry.captureException(channelError);
            return { status: 500, error: 'Organização possui canais conectados' };
        }

        // Chamar a função RPC do Supabase em vez da API direta
        const { data, error } = await supabase.rpc('delete_organization', {
            organization_id_param: organizationId
        });

        if (error) {
            Sentry.captureException(error);
            return { status: 500, error: error.message };
        }

        return { status: 200, message: 'Organização excluída com sucesso' };
    } catch (error) {
        Sentry.captureException(error);
        return { status: 500, error: error.message };
    }
}

export async function updateOrganizationRoute(req, res) {
    const { organizationId } = req.params;
    const result = await updateOrganization(organizationId, req.body);
    return res.status(result.status).json(result.error ? { error: result.error } : { success: true, data: result.data });
}

export async function updateOrganization(organizationId, updateData) {
    try {
        // Validar dados de entrada
        const allowedFields = ['name', 'slug', 'email', 'whatsapp', 'logo_url', 'status', 'usage'];
        const filteredData = {};
        
        for (const [key, value] of Object.entries(updateData)) {
            if (allowedFields.includes(key)) {
                filteredData[key] = value;
            }
        }

        // Adicionar timestamp de atualização
        filteredData.updated_at = new Date().toISOString();

        // Atualizar organização no banco
        const { data, error } = await supabase
            .from('organizations')
            .update(filteredData)
            .eq('id', organizationId)
            .select()
            .single();

        if (error) {
            Sentry.captureException(error);
            return { status: 500, error: error.message };
        }

        return { status: 200, data };
    } catch (error) {
        Sentry.captureException(error);
        return { status: 500, error: error.message };
    }
}