import { supabase } from '../../lib/supabase.js';
import Sentry from '../../lib/sentry.js';

export async function deleteOrganizationRoute(req, res) {
    const { organizationId } = req.params;
    const result = await deleteOrganization(organizationId);
    return res.status(result.status).json(result.error ? { error: result.error } : { message: result.message });
}

export async function deleteOrganization(organizationId) {
    try {
        //Verificar se possui channel ativo e desconectar no api
        // const { data: channel, error: channelError } = await supabase
        //     .from('chat_channels')
        //     .select('*')
        //     .eq('organization_id', organizationId)
        //     .eq('is_connected', true)
        //     .single();

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