import express from 'express';
import { supabase } from '../lib/supabase.js';
import dotenv from 'dotenv';
import Sentry from '../lib/sentry.js';
import rateLimit from 'express-rate-limit';
import { updateFirstLoginStatus } from '../controllers/member.js';
import { createOrganization } from '../controllers/organizations/organizations-handlers.js';

// Carregar variáveis de ambiente
dotenv.config();

const router = express.Router({ mergeParams: true });

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
    planId,
    billingPeriod = 'monthly',
    referral = null,
    language = 'pt' // Valor padrão pt (português)
  } = req.body;

  try {
    // Usar a função createOrganization para todo o processo de signup
    const result = await createOrganization({
      email, 
      password, 
      fullName, 
      organizationName, 
      whatsapp, 
      countryCode, 
      planId, 
      billingPeriod,
      referral,
      language,
      startFlow: true
    });

    // Se houve erro no processo de criação da organização
    if (result.error) {
      return res.status(result.status).json({ 
        error: result.error,
        errorCode: result.errorCode || 'generic'
      });
    }

    // Retornar sucesso com os dados do usuário e organização
    return res.status(201).json({ 
      success: true, 
      message: 'Cadastro realizado com sucesso!!', 
      errorCode: null,
      user: result.data.user,
      organization: result.data.organization
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


router.put('/:userId/first-login', updateFirstLoginStatus);

export default router;


