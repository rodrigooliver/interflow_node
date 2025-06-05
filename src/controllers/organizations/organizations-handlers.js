import { supabase } from '../../lib/supabase.js';
import Sentry from '../../lib/sentry.js';
import { generateSlug } from '../../utils/string.js';
import { registerLimitsOrganizationByPlan } from './usage.js';
import { startSignupChatFlow } from '../chat/signup-flow.js';
import dotenv from 'dotenv';
import { getWapiChannelsV2025_1 } from '../channels/wapi/wapi-handlers-v2025_1.js';

// Carregar variáveis de ambiente
dotenv.config();

// Obter valores padrão das variáveis de ambiente ou usar fallbacks
const MAIN_ORGANIZATION_ID = process.env.MAIN_ORGANIZATION_ID || null;
const DEFAULT_SIGNUP_PLAN_ID = process.env.DEFAULT_SIGNUP_PLAN_ID || null;
const DEFAULT_SIGNUP_CHANNEL_ID = process.env.DEFAULT_SIGNUP_CHANNEL_ID || null;
const DEFAULT_SIGNUP_FLOW_ID = process.env.DEFAULT_SIGNUP_FLOW_ID || null;
const DEFAULT_SIGNUP_FUNNEL_STAGE_ID = process.env.DEFAULT_SIGNUP_FUNNEL_STAGE_ID || null;
const DEFAULT_SIGNUP_TEAM_ID = process.env.DEFAULT_SIGNUP_TEAM_ID || null;

// Função para criar recursos iniciais (funil, estágios e tipos de encerramento)
const createInitialResources = async (organizationId, language = 'pt', userId = null) => {
  if (!organizationId) return;
  
  try {
    // Obter as traduções corretas com base no idioma
    let translations = {
      resolvedClosureType: 'Resolvido',
      unresolvedClosureType: 'Não Resolvido',
      defaultFunnelName: 'Funil de Vendas',
      defaultFunnelDesc: 'Funil padrão para gerenciamento de leads e oportunidades',
      leadStage: 'Lead',
      leadStageDesc: 'Potenciais clientes que demonstraram interesse',
      contactStage: 'Contato Inicial',
      contactStageDesc: 'Primeiro contato realizado',
      proposalStage: 'Proposta',
      proposalStageDesc: 'Proposta enviada',
      negotiationStage: 'Negociação',
      negotiationStageDesc: 'Em processo de negociação',
      closedWonStage: 'Ganho',
      closedWonStageDesc: 'Negócio fechado com sucesso',
      closedLostStage: 'Perdido',
      closedLostStageDesc: 'Oportunidade perdida',
      defaultServiceTeamName: 'Atendimento',
      defaultServiceTeamDesc: 'Equipe padrão de atendimento ao cliente'
    };

    // Configurar traduções com base no idioma
    if (language === 'en') {
      translations = {
        resolvedClosureType: 'Resolved',
        unresolvedClosureType: 'Unresolved',
        defaultFunnelName: 'Sales Funnel',
        defaultFunnelDesc: 'Default funnel for lead and opportunity management',
        leadStage: 'Lead',
        leadStageDesc: 'Potential customers who have shown interest',
        contactStage: 'Initial Contact',
        contactStageDesc: 'First contact made',
        proposalStage: 'Proposal',
        proposalStageDesc: 'Proposal sent',
        negotiationStage: 'Negotiation',
        negotiationStageDesc: 'In negotiation process',
        closedWonStage: 'Closed Won',
        closedWonStageDesc: 'Deal successfully closed',
        closedLostStage: 'Closed Lost',
        closedLostStageDesc: 'Opportunity lost',
        defaultServiceTeamName: 'Support',
        defaultServiceTeamDesc: 'Default customer support team'
      };
    } else if (language === 'es') {
      translations = {
        resolvedClosureType: 'Resuelto',
        unresolvedClosureType: 'No Resuelto',
        defaultFunnelName: 'Embudo de Ventas',
        defaultFunnelDesc: 'Embudo predeterminado para gestión de leads y oportunidades',
        leadStage: 'Lead',
        leadStageDesc: 'Clientes potenciales que han mostrado interés',
        contactStage: 'Contacto Inicial',
        contactStageDesc: 'Primer contacto realizado',
        proposalStage: 'Propuesta',
        proposalStageDesc: 'Propuesta enviada',
        negotiationStage: 'Negociación',
        negotiationStageDesc: 'En proceso de negociación',
        closedWonStage: 'Ganado',
        closedWonStageDesc: 'Negocio cerrado con éxito',
        closedLostStage: 'Perdido',
        closedLostStageDesc: 'Oportunidad perdida',
        defaultServiceTeamName: 'Atención',
        defaultServiceTeamDesc: 'Equipo predeterminado de atención al cliente'
      };
    }

    // 1. Criar tipos de encerramento padrão
    const closureTypes = [
      {
        organization_id: organizationId,
        title: translations.resolvedClosureType,
        color: '#10B981'
      },
      {
        organization_id: organizationId,
        title: translations.unresolvedClosureType,
        color: '#EF4444'
      }
    ];

    const { error: closureError } = await supabase
      .from('closure_types')
      .insert(closureTypes);

    if (closureError) {
      console.error('Erro ao criar tipos de encerramento:', closureError);
      Sentry.captureException(closureError);
    }

    // 2. Criar funil padrão
    const { data: funnel, error: funnelError } = await supabase
      .from('crm_funnels')
      .insert({
        organization_id: organizationId,
        name: translations.defaultFunnelName,
        description: translations.defaultFunnelDesc,
        is_active: true
      })
      .select('id')
      .single();

    if (funnelError) {
      console.error('Erro ao criar funil padrão:', funnelError);
      Sentry.captureException(funnelError);
      return;
    }

    // 3. Criar estágios padrão para o funil
    if (funnel) {
      const stages = [
        {
          funnel_id: funnel.id,
          name: translations.leadStage,
          description: translations.leadStageDesc,
          color: '#3B82F6',
          position: 1
        },
        {
          funnel_id: funnel.id,
          name: translations.contactStage,
          description: translations.contactStageDesc,
          color: '#8B5CF6',
          position: 2
        },
        {
          funnel_id: funnel.id,
          name: translations.proposalStage,
          description: translations.proposalStageDesc,
          color: '#EC4899',
          position: 3
        },
        {
          funnel_id: funnel.id,
          name: translations.negotiationStage,
          description: translations.negotiationStageDesc,
          color: '#F59E0B',
          position: 4
        },
        {
          funnel_id: funnel.id,
          name: translations.closedWonStage,
          description: translations.closedWonStageDesc,
          color: '#10B981',
          position: 5
        },
        {
          funnel_id: funnel.id,
          name: translations.closedLostStage,
          description: translations.closedLostStageDesc,
          color: '#EF4444',
          position: 6
        }
      ];

      const { error: stagesError } = await supabase
        .from('crm_stages')
        .insert(stages);

      if (stagesError) {
        console.error('Erro ao criar estágios padrão:', stagesError);
        Sentry.captureException(stagesError);
      }
    }
    
    // 4. Criar time de serviço padrão
    const { data: serviceTeam, error: serviceTeamError } = await supabase
      .from('service_teams')
      .insert({
        organization_id: organizationId,
        name: translations.defaultServiceTeamName,
        description: translations.defaultServiceTeamDesc,
        is_default: true
      })
      .select('id')
      .single();

    if (serviceTeamError) {
      console.error('Erro ao criar time de serviço padrão:', serviceTeamError);
      Sentry.captureException(serviceTeamError);
    }

    // 5. Adicionar usuário como líder do time de serviço (se userId for fornecido)
    if (serviceTeam && userId) {
      const { error: teamMemberError } = await supabase
        .from('service_team_members')
        .insert({
          team_id: serviceTeam.id,
          user_id: userId,
          role: 'leader'
        });

      if (teamMemberError) {
        console.error('Erro ao adicionar líder ao time de serviço:', teamMemberError);
        Sentry.captureException(teamMemberError);
      }
    }
    
    return true;
  } catch (error) {
    console.error('Erro ao criar recursos iniciais:', error);
    Sentry.captureException(error);
    return false;
  }
};

export async function createOrganizationRoute(req, res) {
  const result = await createOrganization(req.body);
  
  if (result.error) {
    return res.status(result.status).json({ 
      error: result.error, 
      errorCode: result.errorCode 
    });
  }
  
  return res.status(result.status).json({ 
    success: result.success,
    data: result.data 
  });
}

export async function createOrganization(signupData) {
  const { 
    email, 
    password, 
    fullName, 
    organizationName, 
    whatsapp, 
    countryCode, 
    planId = DEFAULT_SIGNUP_PLAN_ID,
    billingPeriod = 'monthly',
    referral = null,
    language = 'pt',
    startFlow = false,
    indicationId = null
  } = signupData;

  try {
    // 1. Criar usuário no Auth
    const { data: authData, error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: fullName
        }
      }
    });

    if (signUpError) {
      Sentry.captureException(signUpError);
      
      if (signUpError.message.includes('email') || signUpError.message.includes('already registered')) {
        return { 
          status: 400, 
          error: 'Este e-mail já está em uso. Tente outro ou faça login.',
          errorCode: 'emailInUse'
        };
      } else if (signUpError.message.includes('password')) {
        return { 
          status: 400, 
          error: 'A senha não atende aos requisitos mínimos de segurança.',
          errorCode: 'weakPassword'
        };
      } else if (signUpError.message.includes('rate limit')) {
        return { 
          status: 429, 
          error: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.',
          errorCode: 'rateLimit'
        };
      } else {
        return { 
          status: 400, 
          error: 'Erro na autenticação: ' + signUpError.message,
          errorCode: 'authError'
        };
      }
    }
    
    if (!authData.user) {
      const noUserError = new Error('Não foi possível criar o usuário');
      Sentry.captureException(noUserError);
      
      return { 
        status: 400, 
        error: 'Não foi possível criar o usuário. Tente novamente.',
        errorCode: 'noUserData'
      };
    }

    // 2. Criar profile
    const { error: profileError } = await supabase
      .from('profiles')
      .insert({
        id: authData.user.id,
        email,
        full_name: fullName,
        nickname: fullName.split(' ')[0], // Pegar o primeiro nome do fullName
        role: 'admin',
        settings: { first_login: true },
        whatsapp: whatsapp ? `${countryCode}${whatsapp.replace(/\D/g, '')}` : null
      });

    if (profileError) {
      Sentry.captureException(profileError);
      
      // Tentar excluir o usuário criado para evitar inconsistências
      try {
        await supabase.auth.admin.deleteUser(authData.user.id);
      } catch (e) {
        Sentry.captureException(e);
        console.error('Erro ao limpar usuário após falha:', e);
      }
      return { 
        status: 400, 
        error: 'Erro ao criar perfil. Tente novamente.',
        errorCode: 'profileCreation'
      };
    }

    // 3. Criar organização
    const organizationSlug = generateSlug(organizationName);
    const { data: orgData, error: orgError } = await supabase
      .from('organizations')
      .insert({
        name: organizationName,
        slug: organizationSlug,
        email,
        whatsapp: whatsapp ? `${countryCode}${whatsapp.replace(/\D/g, '')}` : null,
        referrer_id: referral?.id || null,
        indication_id: indicationId || referral?.user_id || null,
        settings: {
          language: language
        }
      })
      .select()
      .single();

    if (orgError) {
      Sentry.captureException(orgError);
      
      // Tentar excluir o usuário criado para evitar inconsistências
      try {
        await supabase.auth.admin.deleteUser(authData.user.id);
      } catch (e) {
        Sentry.captureException(e);
        console.error('Erro ao limpar usuário após falha:', e);
      }
      return { 
        status: 400, 
        error: 'Erro ao criar organização. Tente novamente.',
        errorCode: 'organizationCreation'
      };
    }

    // 4. Adicionar usuário como membro da organização
    const { error: memberError } = await supabase
      .from('organization_members')
      .insert({
        organization_id: orgData.id,
        user_id: authData.user.id,
        profile_id: authData.user.id,
        role: 'owner'
      });

    if (memberError) {
      Sentry.captureException(memberError);
      
      // Tentar excluir a organização e o usuário criados para evitar inconsistências
      try {
        await supabase.from('organizations').delete().eq('id', orgData.id);
        await supabase.auth.admin.deleteUser(authData.user.id);
      } catch (e) {
        Sentry.captureException(e);
        console.error('Erro ao limpar dados após falha:', e);
      }
      return { 
        status: 400, 
        error: 'Erro ao adicionar usuário à organização. Tente novamente.',
        errorCode: 'memberCreation'
      };
    }

    // 5. Criar subscription trial
    const { error: subscriptionError } = await supabase
      .from('subscriptions')
      .insert({
        organization_id: orgData.id,
        plan_id: planId,
        status: 'trialing',
        current_period_start: new Date().toISOString(),
        current_period_end: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 dias de trial
        cancel_at_period_end: false,
        billing_period: billingPeriod
      });

    // Atualizar o usage da organização
    await registerLimitsOrganizationByPlan(orgData.id, planId);

    if (subscriptionError) {
      Sentry.captureException(subscriptionError);
      
      // Tentar limpar dados criados para evitar inconsistências
      try {
        await supabase.from('organization_members').delete().eq('organization_id', orgData.id);
        await supabase.from('organizations').delete().eq('id', orgData.id);
        await supabase.auth.admin.deleteUser(authData.user.id);
      } catch (e) {
        Sentry.captureException(e);
        console.error('Erro ao limpar dados após falha:', e);
      }
      return { 
        status: 400, 
        error: 'Erro ao criar assinatura. Tente novamente.',
        errorCode: 'subscriptionCreation'
      };
    }

    // 6. Criar recursos iniciais (funil, estágios e tipos de encerramento)
    await createInitialResources(orgData.id, language, authData.user.id);

    // 7. Criar customer na organização principal para iniciar chat (se configurado)
    if (MAIN_ORGANIZATION_ID) {
      let customerData = null;
      
      // Consultar organization principal
      const { data: organizationData, error: organizationError } = await supabase
        .from('organizations')
        .select('*')
        .eq('id', MAIN_ORGANIZATION_ID)
        .single();

      if (organizationError) {
        Sentry.captureException(organizationError);
        console.error('Erro ao buscar organização principal:', organizationError);
      }

      if (organizationData) {
        // Criar customer na organização principal
        const { data: customerDataCreate, error: customerError } = await supabase
          .from('customers')
          .insert({
            name: fullName,
            email,
            organization_id: referral?.organization_id || MAIN_ORGANIZATION_ID,
            referrer_id: referral?.id || null,
            indication_id: referral?.user_id || null,
            whatsapp: whatsapp ? `${countryCode}${whatsapp.replace(/\D/g, '')}` : null,
            stage_id: DEFAULT_SIGNUP_FUNNEL_STAGE_ID
          })
          .select()
          .single();

        if (customerError) {
          Sentry.captureException(customerError);
          console.error('Erro ao criar cliente na organização principal:', customerError);
          // Não impede o fluxo, apenas loga o erro
        }

        // Inserir contatos na tabela customer_contacts se o cliente foi criado
        if (customerDataCreate) {
          customerData = customerDataCreate;
          const whatsappNumber = whatsapp ? `${countryCode}${whatsapp.replace(/\D/g, '')}` : null;
          const { error: contactError } = await supabase
            .from('customer_contacts')
            .insert([
              {
                customer_id: customerData.id,
                type: 'email',
                value: email,
                label: 'Email',
                created_at: new Date().toISOString()
              },
              {
                customer_id: customerData.id,
                type: 'whatsapp',
                value: whatsappNumber,
                label: 'WhatsApp',
                created_at: new Date().toISOString()
              }
            ]);

          if (contactError) {
            Sentry.captureException(contactError);
            console.error('Erro ao criar contatos do cliente na organização principal:', contactError);
            // Não impede o fluxo, apenas loga o erro
          }

          // Iniciar chat com o cliente de forma assíncrona
          if (DEFAULT_SIGNUP_CHANNEL_ID && whatsapp && startFlow) {
            const whatsappNumber = `${countryCode}${whatsapp.replace(/\D/g, '')}`;
            
            // Iniciar fluxo de chat de forma assíncrona (não aguardar resposta)
            startSignupChatFlow({
              organizationId: MAIN_ORGANIZATION_ID,
              channelId: DEFAULT_SIGNUP_CHANNEL_ID,
              customerData,
              whatsappNumber,
              flowId: DEFAULT_SIGNUP_FLOW_ID,
              teamId: DEFAULT_SIGNUP_TEAM_ID
            }).catch(error => {
              Sentry.captureException(error);
              console.error('Erro ao iniciar fluxo de chat assíncrono:', error);
            });
          }
        }
      }
    }

    // Retornar sucesso com os dados do usuário e organização
    return { 
      status: 201, 
      success: true,
      data: {
        user: authData.user,
        organization: orgData
      }
    };

  } catch (error) {
    Sentry.captureException(error);
    return { 
      status: 500, 
      error: error instanceof Error ? error.message : 'Ocorreu um erro durante o cadastro. Tente novamente.',
      errorCode: 'generic'
    };
  }
}

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

    if (channel.length > 0) {
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

export async function getWapiChannelsRoute(req, res) {
  try {
    const { page } = req.query;
    const result = await getWapiChannelsV2025_1(page);
    return res.status(200).json({
      success: true,
      data: result.data,
      pagination: result.pagination
    });
  } catch (error) {
    console.error('Erro ao buscar canais WAPI:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Erro interno do servidor'
    });
  }
}