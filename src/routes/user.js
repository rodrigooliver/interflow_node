import express from 'express';
import { supabase } from '../lib/supabase.js';
import { generateSlug } from '../utils/string.js';
import dotenv from 'dotenv';
import Sentry from '../lib/sentry.js';
import rateLimit from 'express-rate-limit';

// Carregar variáveis de ambiente
dotenv.config();

// Obter valores padrão das variáveis de ambiente ou usar fallbacks
const DEFAULT_PLAN_ID = process.env.DEFAULT_PLAN_ID || null;
const MAIN_ORGANIZATION_ID = process.env.MAIN_ORGANIZATION_ID || null;

const router = express.Router({ mergeParams: true });

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

// Configurações do rate limit
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 10, // 10 tentativas
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  message: {
    error: 'Muitas tentativas de login. Aguarde alguns minutos e tente novamente.',
    errorCode: 'rateLimit'
  },
  handler: (req, res, next, options) => {
    Sentry.captureMessage(`Rate limit excedido para o IP ${req.ip} na rota ${req.originalUrl}`);
    res.status(429).json(options.message);
  },
  // Configuração explícita para confiar apenas no primeiro proxy
  trustProxy: 1
});

const signUpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hora
  max: 5, // 5 tentativas
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Muitas tentativas de cadastro. Aguarde alguns minutos e tente novamente.',
    errorCode: 'rateLimit'
  },
  handler: (req, res, next, options) => {
    Sentry.captureMessage(`Rate limit excedido para o IP ${req.ip} na rota ${req.originalUrl}`);
    res.status(429).json(options.message);
  },
  // Configuração explícita para confiar apenas no primeiro proxy
  trustProxy: 1
});

const passwordRecoveryLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hora
  max: 3, // 3 tentativas
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Muitas tentativas de recuperação de senha. Aguarde alguns minutos e tente novamente.',
    errorCode: 'rateLimit'
  },
  handler: (req, res, next, options) => {
    Sentry.captureMessage(`Rate limit excedido para o IP ${req.ip} na rota ${req.originalUrl}`);
    res.status(429).json(options.message);
  },
  // Configuração explícita para confiar apenas no primeiro proxy
  trustProxy: 1
});

// Configuração de rate limit para o formulário de contato
const contactFormLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 5, // 5 tentativas
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Muitas tentativas de envio. Aguarde alguns minutos e tente novamente.',
    errorCode: 'rateLimit'
  },
  handler: (req, res, next, options) => {
    Sentry.captureMessage(`Rate limit excedido para o IP ${req.ip} na rota ${req.originalUrl}`);
    res.status(429).json(options.message);
  },
  // Configuração explícita para confiar apenas no primeiro proxy
  trustProxy: 1
});

router.post('/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body;
  try {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password
    });
    
    if (error) {
      Sentry.captureException(error);
    }
    
    res.json({ data, error });
  } catch (err) {
    Sentry.captureException(err);
    res.status(500).json({ error: 'Erro ao fazer login', details: err.message });
  }
});

router.post('/signup', signUpLimiter, async (req, res) => {
  const { 
    email, 
    password, 
    fullName, 
    organizationName, 
    whatsapp, 
    countryCode, 
    planId = DEFAULT_PLAN_ID, 
    billingPeriod = 'monthly',
    referral = null,
    language = 'pt' // Valor padrão pt (português)
  } = req.body;

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
        return res.status(400).json({ 
          error: 'Este e-mail já está em uso. Tente outro ou faça login.',
          errorCode: 'emailInUse'
        });
      } else if (signUpError.message.includes('password')) {
        return res.status(400).json({ 
          error: 'A senha não atende aos requisitos mínimos de segurança.',
          errorCode: 'weakPassword'
        });
      } else if (signUpError.message.includes('rate limit')) {
        return res.status(429).json({ 
          error: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.',
          errorCode: 'rateLimit'
        });
      } else {
        return res.status(400).json({ 
          error: 'Erro na autenticação: ' + signUpError.message,
          errorCode: 'authError'
        });
      }
    }
    
    if (!authData.user) {
      const noUserError = new Error('Não foi possível criar o usuário');
      Sentry.captureException(noUserError);
      
      return res.status(400).json({ 
        error: 'Não foi possível criar o usuário. Tente novamente.',
        errorCode: 'noUserData'
      });
    }

    // 2. Criar profile
    const { error: profileError } = await supabase
      .from('profiles')
      .insert({
        id: authData.user.id,
        email,
        full_name: fullName,
        role: 'admin',
        whatsapp: whatsapp ? `+${countryCode}${whatsapp.replace(/\D/g, '')}` : null
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
      return res.status(400).json({ 
        error: 'Erro ao criar perfil. Tente novamente.',
        errorCode: 'profileCreation'
      });
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
        indication_id: referral?.user_id || null,
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
      return res.status(400).json({ 
        error: 'Erro ao criar organização. Tente novamente.',
        errorCode: 'organizationCreation'
      });
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
      return res.status(400).json({ 
        error: 'Erro ao adicionar usuário à organização. Tente novamente.',
        errorCode: 'memberCreation'
      });
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
      return res.status(400).json({ 
        error: 'Erro ao criar assinatura. Tente novamente.',
        errorCode: 'subscriptionCreation'
      });
    }

    // 5.1 Criar recursos iniciais (funil, estágios e tipos de encerramento)
    await createInitialResources(orgData.id, language, authData.user.id);

    // 6. Criar customer para iniciar chat
    if(MAIN_ORGANIZATION_ID) {
      const { data: customerData, error: customerError } = await supabase
        .from('customers')
        .insert({
          name: fullName,
          email,
          organization_id: referral?.organization_id || MAIN_ORGANIZATION_ID,
          referrer_id: referral?.id || null,
          indication_id: referral?.user_id || null,
          whatsapp: whatsapp ? `${countryCode}${whatsapp.replace(/\D/g, '')}` : null
        })
        .select()
        .single();

      if (customerError) {
        Sentry.captureException(customerError);
        console.error('Erro ao criar cliente:', customerError);
        // Não impede o fluxo, apenas loga o erro
      }

      // Inserir contatos na tabela customer_contacts se o cliente foi criado
      if (customerData) {
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
              value: whatsapp ? `${countryCode}${whatsapp.replace(/\D/g, '')}` : null,
              label: 'WhatsApp',
              created_at: new Date().toISOString()
            }
          ]);

        if (contactError) {
          Sentry.captureException(contactError);
          console.error('Erro ao criar contatos:', contactError);
          // Não impede o fluxo, apenas loga o erro
        }
      }
    }

    // Retornar sucesso com os dados do usuário e organização
    return res.status(201).json({ 
      success: true, 
      message: 'Cadastro realizado com sucesso!!', 
      errorCode: null,
      user: authData.user,
      organization: orgData
    });

  } catch (err) {
    Sentry.captureException(err);
    console.error('Erro no cadastro:', err);
    return res.status(500).json({ 
      error: err instanceof Error ? err.message : 'Ocorreu um erro durante o cadastro. Tente novamente.',
      errorCode: 'generic'
    });
  }
});

router.post('/contact', contactFormLimiter, async (req, res) => {
  const { name, email, company, phone, subject, message } = req.body;
  
  try {
    // Validar dados recebidos
    if (!name || !email || !subject || !message) {
      return res.status(400).json({
        error: 'Dados incompletos. Por favor, preencha todos os campos obrigatórios.',
        errorCode: 'invalidData'
      });
    }
    
    // Criar entrada na tabela de contatos
    const { data, error } = await supabase
      .from('contact_messages')
      .insert({
        name,
        email,
        company,
        phone,
        subject,
        message,
        status: 'new',
        organization_id: MAIN_ORGANIZATION_ID
      })
      .select()
      .single();
    
    if (error) {
      Sentry.captureException(error);
      console.error('Erro ao salvar mensagem de contato:', error);
      return res.status(500).json({
        error: 'Erro ao processar sua mensagem. Por favor, tente novamente mais tarde.',
        errorCode: 'databaseError'
      });
    }

    //Iniciar um chat com o cliente para MAIN_ORGANIZATION_ID, com channel email, se houver, e whatsapp, se houver
    
    // // Criar ou atualizar cliente na tabela de customers
    // if (MAIN_ORGANIZATION_ID) {
    //   // Verificar se o cliente já existe pelo email
    //   const { data: existingCustomer, error: customerQueryError } = await supabase
    //     .from('customer_contacts')
    //     .select('id')
    //     .eq('email', email)
    //     .eq('organization_id', MAIN_ORGANIZATION_ID)
    //     .maybeSingle();
      
    //   if (customerQueryError) {
    //     Sentry.captureException(customerQueryError);
    //     console.error('Erro ao verificar cliente existente:', customerQueryError);
    //     // Não interrompe o fluxo, apenas loga o erro
    //   }
      
    //   // Se não existir, criar novo cliente
    //   if (!existingCustomer) {
    //     const { data: customerData, error: customerError } = await supabase
    //       .from('customers')
    //       .insert({
    //         name,
    //         organization_id: MAIN_ORGANIZATION_ID,
    //       })
    //       .select('id')
    //       .single();
          
    //     if (customerError) {
    //       Sentry.captureException(customerError);
    //       console.error('Erro ao criar cliente:', customerError);
    //       // Não interrompe o fluxo, apenas loga o erro
    //     } else if (customerData) {
    //       // Adicionar contatos para o cliente
    //       const contacts = [];
          
    //       contacts.push({
    //         customer_id: customerData.id,
    //         type: 'email',
    //         value: email,
    //         label: 'Email',
    //         created_at: new Date().toISOString()
    //       });
          
    //       if (phone) {
    //         contacts.push({
    //           customer_id: customerData.id,
    //           type: 'phone',
    //           value: phone,
    //           label: 'Telefone',
    //           created_at: new Date().toISOString()
    //         });
    //       }
          
    //       if (contacts.length > 0) {
    //         const { error: contactsError } = await supabase
    //           .from('customer_contacts')
    //           .insert(contacts);
              
    //         if (contactsError) {
    //           Sentry.captureException(contactsError);
    //           console.error('Erro ao criar contatos:', contactsError);
    //           // Não interrompe o fluxo, apenas loga o erro
    //         }
    //       }
    //     }
    //   }
    // }
    
    return res.status(201).json({
      success: true,
      message: 'Mensagem enviada com sucesso! Entraremos em contato em breve.',
      data: { id: data.id }
    });
    
  } catch (err) {
    Sentry.captureException(err);
    console.error('Erro ao processar formulário de contato:', err);
    return res.status(500).json({
      error: 'Ocorreu um erro durante o envio da mensagem. Por favor, tente novamente.',
      errorCode: 'generic'
    });
  }
});

router.post('/recover-password', passwordRecoveryLimiter, async (req, res) => {
  const { email } = req.body;
  try {
    const { data, error } = await supabase.auth.resetPasswordForEmail(email);
    
    if (error) {
      Sentry.captureException(error);
    }
    
    res.json({ data, error });
  } catch (err) {
    Sentry.captureException(err);
    res.status(500).json({ error: 'Erro ao recuperar senha', details: err.message });
  }
});

export default router;


