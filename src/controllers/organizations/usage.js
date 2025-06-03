import { supabase } from '../../lib/supabase.js';
import Sentry from '../../lib/sentry.js';

//Registrar o uso de tokens
export const registerTokenUsage = async ({ organizationId, promptId, customerId, chatId, integrationId, tokenSource = 'system', modelName, inputTokens, outputTokens, costUsd, metadata }) => {
  if (!organizationId || !inputTokens || !outputTokens) {
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
    console.log('error', error);
    Sentry.captureException(error, {
      extra: { organizationId, promptId, customerId, chatId, integrationId }
    });
    return { error: error.message };
  }

  if (tokenSource === 'system') {
    //Buscar soma por função get_monthly_token_usage_report
    const { data: monthlyTokenUsageReport, error: monthlyTokenUsageReportError } = await supabase
      .rpc('get_monthly_token_usage_report', {
        p_organization_id: organizationId,
        p_year: new Date().getFullYear(),
        p_month: new Date().getMonth() + 1,
        p_token_source: tokenSource,
      });

    // console.log('monthlyTokenUsageReport', monthlyTokenUsageReport);
    // console.log('monthlyTokenUsageReportError', monthlyTokenUsageReportError);

    if (monthlyTokenUsageReportError) {
      Sentry.captureException(monthlyTokenUsageReportError, {
        extra: { organizationId, year: new Date().getFullYear(), month: new Date().getMonth() + 1 }
      });
      return { error: monthlyTokenUsageReportError.message };
    }

    // console.log('monthlyTokenUsageReport[0].total_tokens', monthlyTokenUsageReport[0].total_tokens);

    //Loop para somar os tokens usados
    let totalTokens = 0;
    monthlyTokenUsageReport.forEach(item => {
      totalTokens += item.total_tokens;
    });

    // console.log('totalTokens', totalTokens);

    if (totalTokens) {
      //Consultar dados da organization
      const organizationData = await getUsageOrganization(organizationId);

      if (organizationData.error) {
        // console.log('organizationData', organizationData);
        Sentry.captureMessage('Error getting organization usage data', 'error', {
          extra: { organizationId, error: organizationData.error }
        });
        return { error: organizationData.error };
      }

      const usage = {
        ...organizationData.usage,
        tokens: {
          used: totalTokens,
          limit: organizationData.usage.tokens.limit,
        },
      }

      // console.log('usage', usage);

      const result = await registerUsageOrganization(organizationId, usage);

      if (result.error) {
        Sentry.captureMessage('Error registering organization usage', 'error', {
          extra: { organizationId, usage, error: result.error }
        });
        return { error: result.error };
      }

    }


  }



  return { success: true };
};

/**
 * Registra o uso de tokens por canal
 * @param {string} organizationId - ID da organization
 * @returns {Object} - Objeto com o sucesso caso ocorra
 * @returns {Object} - Objeto com o erro caso ocorra
 */
export const registerUsageOrganizationByChannel = async (organizationId) => {
  if (!organizationId) {
    Sentry.captureMessage('Missing required fields in registerUsageOrganizationByChannel', 'warning', {
      extra: { organizationId }
    });
    console.log('Missing required fields in registerUsageOrganizationByChannel');
    return { error: 'Missing required fields' };
  }

  try {
    //Consultar organization
    const organizationData = await getUsageOrganization(organizationId);

    //Consultar quantidade de canais conectados
    const { data: channelData, error: channelError, count } = await supabase
      .from('chat_channels')
      .select('*', { count: 'exact' })
      .eq('organization_id', organizationId);

    if (channelError) {
      Sentry.captureException(channelError);
      return { error: channelError.message };
    }

    //Atualizar usage
    const usage = {
      ...organizationData.usage,
      channels: {
        used: count,
        limit: organizationData.usage.channels.limit,
      },
    }

    const result = await registerUsageOrganization(organizationId, usage);

    if (result.error) {
      Sentry.captureMessage('Error registering organization usage', 'error', {
        extra: { organizationId, usage, error: result.error }
      });
      return { error: result.error };
    }

    return { success: true, channels: count };
  } catch (error) {
    console.log('error', error);
    Sentry.captureException(error);
    return { error: error.message };
  }
}

// Registrar quantidade de customer por organization
export const registerUsageOrganizationByCustomer = async (organizationId) => {
  if (!organizationId) {
    Sentry.captureMessage('Missing required fields in registerUsageOrganizationByCustomer', 'warning', {
      extra: { organizationId }
    });
    return { error: 'Missing required fields' };
  }

  //Consultar organization
  const organizationData = await getUsageOrganization(organizationId);

  if (organizationData.error) {
    Sentry.captureMessage('Error getting organization usage data', 'error', {
      extra: { organizationId, error: organizationData.error }
    });
    return { error: organizationData.error };
  }

  //Consultar quantidade de customers
  const { data: customerData, error: customerError, count } = await supabase
    .from('customers')
    .select('*', { count: 'exact' })
    .eq('organization_id', organizationId);

  if (customerError) {
    Sentry.captureException(customerError);
    return { error: customerError.message };
  }

  //Atualizar usage
  const usage = {
    ...organizationData.usage,
    customers: {
      used: count,
      limit: organizationData.usage.customers.limit,
    },
  }

  const result = await registerUsageOrganization(organizationId, usage);

  if (result.error) {
    Sentry.captureMessage('Error registering organization usage', 'error', {
      extra: { organizationId, usage, error: result.error }
    });
    return { error: result.error };
  }

  return { success: true, customers: count };
}

/**
 * Busca o uso da organization
 * @param {string} organizationId - ID da organization
 * @returns {Object} - Objeto com o uso da organization
 * @returns {Object} - Objeto com o erro caso ocorra
 */
export const getUsageOrganization = async (organizationId) => {
  if (!organizationId) {
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
  if (!organizationId || !usage) {
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
  if (!organizationId || !usage) {
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
  if (!organizationId || !plan) {
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

  if (planError) {
    Sentry.captureException(planError, {
      extra: { organizationId, plan }
    });
    return { error: planError.message };
  }

  organizationData.usage = organizationData.usage || {
    users: {
      used: 0,
      limit: 0,
    },
    customers: {
      used: 0,
      limit: 0,
    },
    storage: {
      used: 0,
      limit: 0,
    },
    channels: {
      used: 0,
      limit: 0,
    },
    flows: {
      used: 0,
      limit: 0,
    },
    teams: {
      used: 0,
      limit: 0,
    },
    tokens: {
      used: 0,
      limit: 0,
    },
  };

  //Fazer a comparação e prevalecer o maior valor
  const currentUsersLimit = organizationData.usage.users?.limit || 0;
  const currentCustomersLimit = organizationData.usage.customers?.limit || 0;
  const currentStorageLimit = organizationData.usage.storage?.limit || 0;
  const currentChannelsLimit = organizationData.usage.channels?.limit || 0;
  const currentFlowsLimit = organizationData.usage.flows?.limit || 0;
  const currentTeamsLimit = organizationData.usage.teams?.limit || 0;
  const currentTokensLimit = organizationData.usage.tokens?.limit || 0;

  const planUsersLimit = parseInt(planData.max_users) || 0;
  const planCustomersLimit = parseInt(planData.max_customers) || 0;
  const planStorageLimit = parseInt(planData.storage_limit) || 0;
  const planChannelsLimit = parseInt(planData.max_channels) || 0;
  const planFlowsLimit = parseInt(planData.max_flows) || 0;
  const planTeamsLimit = parseInt(planData.max_teams) || 0;
  const planTokensLimit = parseInt(planData.max_tokens) || 0;



  const usage = {
    users: {
      used: organizationData.usage.users?.used || 1,
      limit: Math.max(planUsersLimit, currentUsersLimit),
    },
    customers: {
      used: organizationData.usage.customers?.used || 0,
      limit: Math.max(planCustomersLimit, currentCustomersLimit),
    },
    storage: {
      used: organizationData.usage.storage?.used || 0,
      limit: Math.max(planStorageLimit, currentStorageLimit),
    },
    channels: {
      used: organizationData.usage.channels?.used || 0,
      limit: Math.max(planChannelsLimit, currentChannelsLimit),
    },
    flows: {
      used: organizationData.usage.flows?.used || 0,
      limit: Math.max(planFlowsLimit, currentFlowsLimit),
    },
    teams: {
      used: organizationData.usage.teams?.used || 1,
      limit: Math.max(planTeamsLimit, currentTeamsLimit),
    },
    tokens: {
      used: organizationData.usage.tokens?.used || 0,
      limit: Math.max(planTokensLimit, currentTokensLimit),
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