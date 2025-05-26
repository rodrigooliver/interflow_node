import { supabase } from '../../lib/supabase.js';
import Sentry from '../../lib/sentry.js';

//Registrar o uso de tokens
export const registerTokenUsage = async ({ organizationId, promptId, customerId, chatId, integrationId, tokenSource = 'system', modelName, inputTokens, outputTokens, costUsd, metadata }) => {
    if(!organizationId || !inputTokens || !outputTokens) {
        Sentry.captureMessage('Missing required fields in registerTokenUsage', 'warning', {
            extra: { organizationId, inputTokens, outputTokens }
        });
        return { error: 'Missing required fields' };
    }
    const { data, error } = await supabase
        .from('token_usage')
        .insert({
            prompt_id: promptId || null,
            customer_id: customerId || null,
            chat_id: chatId || null,
            organization_id: organizationId,
            integration_id: integrationId || null,
            token_source: tokenSource,
            model_name: modelName || null,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cost_usd: costUsd || null,
            metadata: metadata || null,
        });
    if (error) {
        Sentry.captureException(error, {
            extra: { organizationId, promptId, customerId, chatId, integrationId }
        });
        return { error: error.message };
    }

    //Buscar soma por função get_monthly_token_usage_report
    const { data: monthlyTokenUsageReport, error: monthlyTokenUsageReportError } = await supabase
        .rpc('get_monthly_token_usage_report', {
        p_organization_id: organizationId,
        p_year: new Date().getFullYear(),
        p_month: new Date().getMonth() + 1,
    });

    if (monthlyTokenUsageReportError) {
        Sentry.captureException(monthlyTokenUsageReportError, {
            extra: { organizationId, year: new Date().getFullYear(), month: new Date().getMonth() + 1 }
        });
        return { error: monthlyTokenUsageReportError.message };
    }

    //Consultar dados da organization
    const organizationData = await getUsageOrganization(organizationId);

    if(organizationData.error) {
        Sentry.captureMessage('Error getting organization usage data', 'error', {
            extra: { organizationId, error: organizationData.error }
        });
        return { error: organizationData.error };
    }

    const usage = {
        ...organizationData.usage,
        tokens: {
            used: monthlyTokenUsageReport.total_tokens_used,
            limit: organizationData.usage.tokens.limit,
        },
    }

    const result = await registerUsageOrganization(organizationId, usage);

    if(result.error) {
        Sentry.captureMessage('Error registering organization usage', 'error', {
            extra: { organizationId, usage, error: result.error }
        });
        return { error: result.error };
    }

    return { success: true };
};

/**
 * Busca o uso da organization
 * @param {string} organizationId - ID da organization
 * @returns {Object} - Objeto com o uso da organization
 * @returns {Object} - Objeto com o erro caso ocorra
 */
export const getUsageOrganization = async (organizationId) => {
    if(!organizationId) {
        Sentry.captureMessage('Organization ID is required in getUsageOrganization', 'warning');
        return { error: 'Organization ID is required' };
    }
    const { data, error } = await supabase
        .from('organizations')
        .select('usage')
        .eq('id', organizationId)
        .single();

    if (error) {
        Sentry.captureException(error, {
            extra: { organizationId }
        });
        return { error: error.message };
    }

    return data;
}

/**
 * Atualiza o uso da organization
 * @param {string} organizationId - ID da organization
 * @param {Object} usage - Objeto com o uso da organization
 * @returns {Object} - Objeto com o sucesso caso ocorra
 * @returns {Object} - Objeto com o erro caso ocorra
 */
export const registerUsageOrganization = async (organizationId, usage) => {
    if(!organizationId || !usage) {
        Sentry.captureMessage('Missing required fields in registerUsageOrganization', 'warning', {
            extra: { organizationId, usage }
        });
        return { error: 'Missing required fields' };
    }
    const { data, error } = await supabase
        .from('organizations')
        .update({ usage })
        .eq('id', organizationId);
    if (error) {
        Sentry.captureException(error, {
            extra: { organizationId, usage }
        });
        return { error: error.message };
    }

    return { success: true };
}

export const registerLimitsOrganization = async (organizationId, usage) => {
    if(!organizationId || !usage) {
        Sentry.captureMessage('Missing required fields in registerLimitsOrganization', 'warning', {
            extra: { organizationId, usage }
        });
        return { error: 'Missing required fields' };
    }
    const { data, error } = await supabase
        .from('organizations')
        .update({ usage })
        .eq('id', organizationId);
    if (error) {
        Sentry.captureException(error, {
            extra: { organizationId, usage }
        });
        return { error: error.message };
    }

    return { success: true };
}

export const registerLimitsOrganizationByPlan = async (organizationId, plan) => {
    if(!organizationId || !plan) {
        Sentry.captureMessage('Missing required fields in registerLimitsOrganizationByPlan', 'warning', {
            extra: { organizationId, plan }
        });
        return { error: 'Missing required fields' };
    }

    //Consultar organization
    const { data: organizationData, error: organizationError } = await supabase
        .from('organizations')
        .select('*')
        .eq('id', organizationId)
        .single();

    if (organizationError) {
        Sentry.captureException(organizationError, {
            extra: { organizationId, plan }
        });
        return { error: organizationError.message };
    }

    //Consultar plano
    const { data: planData, error: planError } = await supabase
        .from('subscription_plans')
        .select('*')
        .eq('id', plan)
        .single();

    if(planError) {
        Sentry.captureException(planError, {
            extra: { organizationId, plan }
        });
        return { error: planError.message };
    }

    //Fazer a comparação e prevalecer o maior valor
    const usage = {
        users: {
            used: organizationData.usage.users.used || 0,
            limit: planData.max_users > organizationData.usage.users?.limit ? planData.max_users : organizationData.usage.users?.limit,
        },
        customers: {
            used: organizationData.usage.customers.used || 0    ,
            limit: planData.max_customers > organizationData.usage.customers?.limit ? planData.max_customers : organizationData.usage.customers?.limit,
        },
        storage: {
            used: organizationData.usage.storage.used || 0,
            limit: planData.storage_limit > organizationData.usage.storage?.limit ? planData.storage_limit : organizationData.usage.storage?.limit,
        },
        channels: {
            used: organizationData.usage.channels.used || 0,
            limit: planData.max_channels > organizationData.usage.channels?.limit ? planData.max_channels : organizationData.usage.channels?.limit,
        },
        flows: {
            used: organizationData.usage.flows.used || 0,
            limit: planData.max_flows > organizationData.usage.flows?.limit ? planData.max_flows : organizationData.usage.flows?.limit,
        },
        teams: {
            used: organizationData.usage.teams.used || 0,
            limit: planData.max_teams > organizationData.usage.teams?.limit ? planData.max_teams : organizationData.usage.teams?.limit,
        },
        tokens: {
            used: organizationData.usage.tokens.used || 0,
            limit: planData.max_tokens > organizationData.usage.tokens?.limit ? planData.max_tokens : organizationData.usage.tokens?.limit,
        },
    }

    const { data, error } = await supabase
        .from('organizations')
        .update({ usage })
        .eq('id', organizationId);
    if (error) {
        Sentry.captureException(error, {
            extra: { organizationId, plan, usage }
        });
        return { error: error.message };
    }

    return { success: true };
}