/**
 * Controlador para integração com WhatsApp Business API usando Cadastro Incorporado
 * 
 * Este módulo gerencia a integração com a API oficial do WhatsApp Business
 * através do fluxo de Cadastro Incorporado (Embedded Signup).
 * 
 * Funcionalidades:
 * - Troca de código de autorização por token de acesso
 * - Configuração de conta do WhatsApp Business
 * - Integração com a API na Nuvem do WhatsApp
 * 
 * @module whatsapp-embedded
 */

import axios from 'axios';
import * as Sentry from '@sentry/node';
import { supabase } from '../../lib/supabase.js';
import { encrypt, decrypt } from '../../utils/crypto.js';

/**
 * Extrai uma mensagem de erro amigável de um objeto de erro
 * 
 * @param {Error} error - Objeto de erro
 * @returns {string} - Mensagem de erro amigável
 */
function extractErrorMessage(error) {
  if (!error) {
    return 'Erro desconhecido';
  }

  // Se o erro for uma string, retorná-la diretamente
  if (typeof error === 'string') {
    return error;
  }

  // Verificar se é um erro de API com resposta
  if (error.response && error.response.data) {
    // Erro da API do Facebook/WhatsApp
    if (error.response.data.error) {
      const fbError = error.response.data.error;
      return fbError.message || fbError.error_description || JSON.stringify(fbError);
    }
    
    // Outros erros de API
    if (error.response.data.message) {
      return error.response.data.message;
    }
    
    // Tentar extrair qualquer mensagem disponível
    return JSON.stringify(error.response.data);
  }

  // Erro padrão do JavaScript
  return error.message || 'Erro desconhecido';
}

/**
 * Verifica se o token tem as permissões necessárias para a integração com o WhatsApp
 * @param {Array<string>} scopes - Lista de permissões do token
 * @returns {Object} - Objeto com o resultado da verificação
 */
function verificarPermissoesToken(scopes) {
  if (!scopes || !Array.isArray(scopes)) {
    return {
      valido: false,
      permissoesNecessarias: [
        'whatsapp_business_management',
        'whatsapp_business_messaging',
        'business_management'
      ],
      permissoesEncontradas: [],
      permissoesFaltantes: [
        'whatsapp_business_management',
        'whatsapp_business_messaging',
        'business_management'
      ]
    };
  }
  
  const permissoesNecessarias = [
    'whatsapp_business_management',
    'whatsapp_business_messaging',
    'business_management'
  ];
  
  const permissoesEncontradas = permissoesNecessarias.filter(p => scopes.includes(p));
  const permissoesFaltantes = permissoesNecessarias.filter(p => !scopes.includes(p));
  
  return {
    valido: permissoesFaltantes.length === 0,
    permissoesNecessarias,
    permissoesEncontradas,
    permissoesFaltantes
  };
}


/**
 * Processa uma etapa específica da integração com o WhatsApp
 * 
 * @param {Object} params - Parâmetros para o processamento da etapa
 * @param {string} params.step - Nome da etapa a ser processada
 * @param {string} params.channelId - ID do canal no Supabase
 * @param {string} params.organizationId - ID da organização no Supabase
 * @param {Object} params.data - Dados específicos para a etapa
 * @returns {Promise<Object>} - Resultado do processamento da etapa
 */
export async function processWhatsAppStep(req, res) {
  try {
    const { step, channelId, organizationId, sessionInfo } = req.body;

    // Verificar parâmetros obrigatórios
    if (!step || !channelId || !organizationId) {
      return res.status(400).json({
        success: false,
        error: 'Parâmetros obrigatórios ausentes: step, channelId, organizationId'
      });
    }

    if(step === 'exchange_code' && !sessionInfo && !sessionInfo.phone_number_id && !sessionInfo.waba_id) {
      return res.status(400).json({
        success: false,
        error: 'Parâmetros obrigatórios ausentes: phone_number_id, waba_id'
      });
    }

    console.log(`Iniciando processamento da etapa ${step} para o canal ${channelId}`);

    // Verificar se o canal existe
    const { data: channel, error: channelError } = await supabase
      .from('chat_channels')
      .select('*')
      .eq('id', channelId)
      .eq('organization_id', organizationId)
      .single();

    if (channelError || !channel) {
      console.error('Erro ao buscar canal:', channelError);
      return res.status(404).json({
        success: false,
        error: 'Canal não encontrado'
      });
    }

    console.log(`Canal encontrado: ${channel.name}`);

    // Obter credenciais atuais
    const currentCredentials = channel.credentials || {};
    console.log('Credenciais atuais:', JSON.stringify(currentCredentials));
    
    const newCredentials = { ...currentCredentials };
    
    // Atualizar etapa atual
    newCredentials.current_step = step;
    newCredentials.setup_status = `starting_${step}`;
    if(step === 'exchange_code') {
      newCredentials.phone_number_id = sessionInfo.phone_number_id;
      newCredentials.selected_waba_id = sessionInfo.waba_id;
      newCredentials.business_account_id = sessionInfo.waba_id;
    }
    
    // Atualizar credenciais no banco de dados
    await supabase
      .from('chat_channels')
      .update({
        credentials: newCredentials,
        ...(step === 'exchange_code' ? {external_id: sessionInfo.phone_number_id} : {})
      })
      .eq('id', channelId);
    
    // Retornar imediatamente para o cliente
    res.json({
      success: true,
      message: `Processamento da etapa ${step} iniciado`,
      step
    });

    let accessToken = currentCredentials.access_token ? decrypt(currentCredentials.access_token) : null;
    
    // Continuar o processamento em segundo plano
    processStepInBackground(accessToken, step, req.body, channelId, organizationId, newCredentials);
    
  } catch (error) {
    console.error('Erro ao iniciar processamento da etapa:', error);
    Sentry.captureException(error);
    return res.status(500).json({
      success: false,
      error: extractErrorMessage(error)
    });
  }
}

/**
 * Processa uma etapa em segundo plano
 * @param {string} step - Etapa a ser processada
 * @param {Object} requestBody - Corpo da requisição original
 * @param {string} channelId - ID do canal
 * @param {string} organizationId - ID da organização
 * @param {Object} newCredentials - Credenciais atualizadas
 */
async function processStepInBackground(accessToken, step, requestBody, channelId, organizationId, newCredentials) {
  let result = {};
  let nextStep = null;
  let error = null;

  try {
    // Processar etapa específica
    console.log(`Processando etapa ${step} em segundo plano`);
    
    switch (step) {
      case 'exchange_code': {
        const { code } = requestBody;
        if (!code) {
          const error = new Error('Código de autorização ausente');
          Sentry.captureException(error, {
            tags: {
              step,
              channelId,
              organizationId
            }
          });
          throw error;
        }
        
        const tokenResult = await exchangeCodeForToken({ code, channelId, newCredentials });
        
        accessToken = tokenResult.accessToken;
        // Salvar token no banco de dados
        newCredentials.access_token = encrypt(tokenResult.accessToken);
        newCredentials.token_type = tokenResult.tokenType;
        newCredentials.token_expires_in = tokenResult.expiresIn;
        newCredentials.token_obtained_at = new Date().toISOString();
        
        result = {
          success: true,
          tokenObtained: true
        };
        
        nextStep = 'fetch_waba_details';
        break;
      }
      
      case 'verify_token': {
        const { token } = requestBody;
        if (!token) {
          const error = new Error('Token de acesso ausente');
          Sentry.captureException(error, {
            tags: {
              step,
              channelId,
              organizationId
            }
          });
          throw error;
        }
        
        const tokenResult = await verifyToken({ 
          token, 
          channelId, 
          newCredentials 
        });

        accessToken = token;
        
        result = {
          success: true,
          tokenVerified: true,
          userId: tokenResult.userId,
          name: tokenResult.name,
          tokenData: tokenResult.tokenData
        };
        
        nextStep = 'fetch_accounts';
        break;
      }
      
      case 'fetch_accounts': {
        if (!newCredentials.access_token) {
          await tokenNotFound(newCredentials, channelId);
        }
        
        const accountsResult = await fetchWhatsAppAccounts({ 
          accessToken,
          channelId, 
          newCredentials 
        });
        
        result = {
          success: true,
          clientWabaAccounts: accountsResult.clientWabaAccounts,
          ownedWabaAccounts: accountsResult.ownedWabaAccounts,
          selectedWabaId: accountsResult.selectedWabaId
        };
        
        if (accountsResult.selectedWabaId) {
          newCredentials.selected_waba_id = accountsResult.selectedWabaId;
          nextStep = 'fetch_waba_details';
        } else {
          const error = new Error('Nenhuma conta do WhatsApp Business encontrada');
          Sentry.captureException(error, {
            tags: {
              step,
              channelId,
              organizationId
            }
          });
          throw error;
        }
        break;
      }
      
      case 'fetch_waba_details': {
        // Obter token de acesso e ID da conta WABA
        const wabaId = newCredentials.selected_waba_id || requestBody.wabaId;
        
        if (!newCredentials.access_token) {
          await tokenNotFound(newCredentials, channelId);
        }
        
        if (!wabaId) {
          const error = new Error('ID da conta do WhatsApp Business não encontrado');
          Sentry.captureException(error, {
            tags: {
              step,
              channelId,
              organizationId,
              wabaId
            }
          });
          throw error;
        }
        
        const wabaDetails = await fetchWabaDetails({ 
          accessToken, 
          wabaId,
          channelId, 
          newCredentials 
        });
        
        result = {
          success: true,
          wabaDetails
        };
        
        nextStep = 'fetch_phone_numbers';
        break;
      }
      
      case 'fetch_phone_numbers': {
        // Obter token de acesso e ID da conta WABA
        const wabaId = newCredentials.business_account_id || newCredentials.selected_waba_id;
        
        if (!newCredentials.access_token) {
          await tokenNotFound(newCredentials, channelId);
        }
        
        if (!wabaId) {
          const error = new Error('ID da conta do WhatsApp Business não encontrado');
          Sentry.captureException(error, {
            tags: {
              step,
              channelId,
              organizationId,
              wabaId
            }
          });
          throw error;
        }
        
        const phoneResult = await fetchPhoneNumbers({ 
          accessToken, 
          wabaId, 
          channelId, 
          newCredentials 
        });
        
        if (phoneResult.selectedPhoneNumberId) {
          if(!newCredentials.phone_number_id) {
            newCredentials.phone_number_id = phoneResult.selectedPhoneNumberId;
          }
          newCredentials.display_phone_number = phoneResult.displayPhoneNumber;
        }
        
        result = {
          success: true,
          phoneNumbers: phoneResult.phoneNumbers,
          selectedPhoneNumberId: phoneResult.selectedPhoneNumberId
        };
        
        if (phoneResult.phoneNumbers && phoneResult.phoneNumbers.length > 0) {
          nextStep = 'fetch_templates';
        } else {
          // Se não houver números de telefone, pular para a inscrição do aplicativo
          nextStep = 'subscribe_app';
        }
        break;
      }
      
      case 'fetch_templates': {
        // Obter token de acesso e ID da conta WABA
        const wabaId = newCredentials.business_account_id || newCredentials.selected_waba_id;
        
        if (!newCredentials.access_token) {
          await tokenNotFound(newCredentials, channelId);
        }
        
        if (!wabaId) {
          const error = new Error('ID da conta do WhatsApp Business não encontrado');
          Sentry.captureException(error, {
            tags: {
              step,
              channelId,
              organizationId,
              wabaId
            }
          });
          throw error;
        }
        
        const templatesResult = await fetchMessageTemplates({ 
          accessToken, 
          wabaId, 
          channelId, 
          newCredentials 
        });
        
        result = {
          success: true,
          messageTemplates: templatesResult.messageTemplates
        };
        
        nextStep = 'subscribe_app';
        break;
      }
      
      case 'subscribe_app': {
        // Obter token de acesso e ID da conta WABA
        const wabaId = newCredentials.business_account_id || newCredentials.selected_waba_id;
        
        if (!newCredentials.access_token) {
          await tokenNotFound(newCredentials, channelId);
        }
        
        if (!wabaId) {
          const error = new Error('ID da conta do WhatsApp Business não encontrado');
          Sentry.captureException(error, {
            tags: {
              step,
              channelId,
              organizationId,
              wabaId
            }
          });
          throw error;
        }
        
        const subscriptionResult = await subscribeApp({ 
          accessToken, 
          wabaId, 
          channelId, 
          newCredentials 
        });
        
        result = {
          success: true,
          subscription: subscriptionResult.subscription,
          subscribedApps: subscriptionResult.subscribedApps
        };
        
        // Se temos um número de telefone, configurar o webhook
        if (newCredentials.phone_number_id) {
          nextStep = 'register_phone';
        } else {
          nextStep = 'complete_setup';
        }
        break;
      }
      
      case 'register_phone': {
        // Obter token de acesso e ID do número de telefone
        const phoneNumberId = newCredentials.phone_number_id;
        
        if (!newCredentials.access_token) {
          await tokenNotFound(newCredentials, channelId);
        }
        
        if (!phoneNumberId) {
          const error = new Error('ID do número de telefone não encontrado');
          Sentry.captureException(error, {
            tags: {
              step,
              channelId,
              organizationId,
              phoneNumberId
            }
          });
          throw error;
        }
        
        const registerResult = await registerPhone({ 
          accessToken, 
          phoneNumberId, 
          channelId, 
          newCredentials 
        });
        
        result = {
          success: registerResult.success,
          registration: registerResult.registration
        };
        
        // Mesmo que o registro falhe, continuar com a configuração
        nextStep = 'complete_setup';
        break;
      }
      
      case 'complete_setup': {
        const setupResult = await completeSetup({ 
          channelId, 
          organizationId, 
          newCredentials 
        });
        
        result = {
          success: true,
          setupComplete: setupResult
        };
        
        // Configuração concluída
        nextStep = null;
        break;
      }
      
      default:
        const error = new Error(`Etapa desconhecida: ${step}`);
        Sentry.captureException(error, {
          tags: {
            step,
            channelId,
            organizationId
          }
        });
        throw error;
    }
    
    // Atualizar status de conclusão e próxima etapa
    newCredentials.setup_status = `completed_${step}`;
    newCredentials.current_step = step;
    newCredentials.next_step = nextStep;
    
    // Atualizar canal com as informações obtidas
    await supabase
      .from('chat_channels')
      .update({
        credentials: newCredentials
      })
      .eq('id', channelId);
    
    console.log(`Etapa ${step} processada com sucesso. Próxima etapa: ${nextStep || 'nenhuma'}`);
    
    // Se houver uma próxima etapa e for uma das etapas automáticas, processá-la
    if (nextStep && isAutomaticStep(nextStep)) {
      console.log(`Iniciando próxima etapa automática: ${nextStep}`);
      // Pequeno delay para evitar sobrecarga
      setTimeout(() => {
        processStepInBackground(accessToken, nextStep, requestBody, channelId, organizationId, newCredentials);
      }, 1000);
    }
    
  } catch (error) {
    console.error(`Erro ao processar etapa ${step} em segundo plano:`, error);
    Sentry.captureException(error, {
      tags: {
        step,
        channelId,
        organizationId,
        setupStatus: newCredentials.setup_status
      },
      extra: {
        credentials: newCredentials
      }
    });
    
    // Extrair mensagem de erro mais relevante
    const errorMessage = extractErrorMessage(error);
    
    // Atualizar status de erro
    newCredentials.setup_status = `error_${step}`;
    newCredentials.current_step = step;
    newCredentials.setup_error = errorMessage;
    newCredentials.last_error = errorMessage;
    newCredentials.setup_error_details = JSON.stringify({
      error: error.message,
      stack: error.stack,
      step
    });
    
    await supabase
      .from('chat_channels')
      .update({
        credentials: newCredentials
      })
      .eq('id', channelId);
    
    console.error(`Erro ao processar etapa ${step}: ${errorMessage}`);
  }
}

/**
 * Verifica se uma etapa deve ser processada automaticamente
 * @param {string} step - Etapa a ser verificada
 * @returns {boolean} - True se a etapa deve ser processada automaticamente
 */
function isAutomaticStep(step) {
  const automaticSteps = [
    // 'fetch_accounts',
    'fetch_waba_details',
    'fetch_phone_numbers',
    'fetch_templates',
    'subscribe_app',
    'register_phone',
    'complete_setup'
  ];
  
  return automaticSteps.includes(step);
}

async function tokenNotFound(newCredentials, channelId) {
  console.error('Token de acesso não encontrado nas credenciais:', JSON.stringify({
    hasToken: !!newCredentials.access_token,
    tokenLength: newCredentials.access_token ? newCredentials.access_token.length : 0
  }));
  
  const error = new Error('Token de acesso não encontrado');
  Sentry.captureException(error, {
    tags: {
      channelId,
      setupStatus: newCredentials.setup_status
    },
    extra: {
      credentials: newCredentials
    }
  });
  
  // Atualizar status de erro
  newCredentials.setup_status = 'erro_token_ausente';
  newCredentials.setup_error = 'Token de acesso não encontrado';
  newCredentials.setup_error_details = JSON.stringify({
    credentials: Object.keys(newCredentials),
    hasToken: !!newCredentials.access_token
  });
  
  await supabase
    .from('chat_channels')
    .update({
      credentials: newCredentials
    })
    .eq('id', channelId);
    
  throw error;
}

/**
 * Troca um código de autorização por um token de acesso
 * 
 * @param {Object} params - Parâmetros para troca do código
 * @param {string} params.code - Código de autorização
 * @param {string} params.channelId - ID do canal no Supabase
 * @param {Object} params.newCredentials - Credenciais atuais do canal
 * @returns {Promise<Object>} - Resultado da troca
 */
export async function exchangeCodeForToken({ code, channelId, newCredentials }) {
  newCredentials.setup_status = 'starting_exchange_code';
  
  // Atualizar status para rastreamento
  await supabase
    .from('chat_channels')
    .update({
      credentials: newCredentials
    })
    .eq('id', channelId);
  
  console.log('Trocando código por token com os seguintes parâmetros:');
  console.log('client_id:', process.env.FACEBOOK_APP_ID);
  console.log('code length:', code.length);
  
  try {
    const tokenResponse = await axios({
      method: 'POST',
      url: 'https://graph.facebook.com/v22.0/oauth/access_token',
      headers: {
        'Content-Type': 'application/json'
      },
      data: {
        client_id: process.env.FACEBOOK_APP_ID,
        client_secret: process.env.FACEBOOK_APP_SECRET,
        grant_type: 'authorization_code',
        code
      }
    });

    console.log('Resposta da troca de código:', JSON.stringify(tokenResponse.data));
    
    const accessToken = tokenResponse.data.access_token;
    const tokenType = tokenResponse.data.token_type;
    const expiresIn = tokenResponse.data.expires_in;

    if (!accessToken) {
      const error = new Error('Falha ao obter token de acesso');
      Sentry.captureException(error, {
        tags: {
          channelId,
          setupStatus: newCredentials.setup_status
        }
      });
      throw error;
    }

    newCredentials.access_token = encrypt(accessToken);
    newCredentials.token_type = tokenType;
    newCredentials.expires_in = expiresIn;
    
    // Atualizar status para rastreamento
    await supabase
      .from('chat_channels')
      .update({
        credentials: newCredentials
      })
      .eq('id', channelId);
      
    return {
      accessToken,
      tokenType,
      expiresIn
    };
  } catch (error) {
    Sentry.captureException(error, {
      tags: {
        channelId,
        setupStatus: newCredentials.setup_status
      },
      extra: {
        codeLength: code.length
      }
    });
    throw error;
  }
}

/**
 * Verifica um token fornecido manualmente
 * 
 * @param {Object} params - Parâmetros para verificação do token
 * @param {string} params.token - Token de acesso a ser verificado
 * @param {string} params.channelId - ID do canal no Supabase
 * @param {Object} params.newCredentials - Credenciais atuais do canal
 * @returns {Promise<Object>} - Resultado da verificação
 */
export async function verifyToken({ token, channelId, newCredentials }) {
  newCredentials.setup_status = 'starting_verify_token';
  
  // Atualizar status para rastreamento
  await supabase
    .from('chat_channels')
    .update({
      credentials: newCredentials
    })
    .eq('id', channelId);
  
  try {
    // Verificar o token usando o endpoint debug_token
    const response = await axios({
      method: 'GET',
      url: 'https://graph.facebook.com/debug_token',
      params: {
        input_token: token,
        access_token: token // Usando o mesmo token como access_token
      }
    });

    console.log('Resposta da verificação de token:', JSON.stringify(response.data));

    // Verificar se o token é válido
    if (!response.data || !response.data.data) {
      const error = new Error('Resposta inválida do debug_token');
      Sentry.captureException(error, {
        tags: {
          channelId,
          setupStatus: newCredentials.setup_status
        },
        extra: {
          response: response.data
        }
      });
      throw error;
    }
    
    if (!response.data.data.is_valid) {
      const error = new Error(response.data.data.error?.message || 'Token inválido ou expirado');
      Sentry.captureException(error, {
        tags: {
          channelId,
          setupStatus: newCredentials.setup_status
        },
        extra: {
          tokenData: response.data.data
        }
      });
      throw error;
    }
    
    // Verificar permissões do token
    const verificacaoPermissoes = verificarPermissoesToken(response.data.data.scopes);
    if (!verificacaoPermissoes.valido) {
      console.warn('Token não possui todas as permissões necessárias:', verificacaoPermissoes);
      Sentry.captureMessage('Token com permissões insuficientes', {
        level: 'warning',
        tags: {
          channelId,
          setupStatus: newCredentials.setup_status
        },
        extra: {
          verificacaoPermissoes
        }
      });
    }

    // Obter informações adicionais do usuário
    const userResponse = await axios({
      method: 'GET',
      url: 'https://graph.facebook.com/v22.0/me',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    // Token é válido, salvar no banco de dados
    newCredentials.access_token = encrypt(token);
    newCredentials.last_error = null;
    newCredentials.token_verified_at = new Date().toISOString();
    newCredentials.token_data = {
      app_id: response.data.data.app_id,
      user_id: response.data.data.user_id,
      scopes: response.data.data.scopes,
      expires_at: response.data.data.expires_at ? new Date(response.data.data.expires_at * 1000).toISOString() : null,
      data_access_expires_at: response.data.data.data_access_expires_at ? new Date(response.data.data.data_access_expires_at * 1000).toISOString() : null,
      verificacao_permissoes: verificacaoPermissoes
    };
    
    // Atualizar canal com o token verificado
    await supabase
      .from('chat_channels')
      .update({
        credentials: newCredentials
      })
      .eq('id', channelId);
    
    return {
      userId: response.data.data.user_id,
      name: userResponse.data.name || 'Usuário WhatsApp',
      access_token: token,
      tokenData: newCredentials.token_data,
      permissoesValidas: verificacaoPermissoes.valido,
      permissoesFaltantes: verificacaoPermissoes.permissoesFaltantes
    };
  } catch (error) {
    Sentry.captureException(error, {
      tags: {
        channelId,
        setupStatus: newCredentials.setup_status
      }
    });
    
    // Verificar se é um erro da API do Facebook
    if (error.response && error.response.data && error.response.data.error) {
      const fbError = error.response.data.error;
      throw new Error(`${fbError.message || fbError.type || 'Error not found'}`);
    }
    
    // Repassar o erro original se não for um erro específico da API
    throw error;
  }
}

/**
 * Obtém contas do WhatsApp Business (próprias e de clientes)
 */
export async function fetchWhatsAppAccounts({ accessToken, channelId, newCredentials }) {
  newCredentials.setup_status = 'starting_fetch_accounts';
  
  // Atualizar status para rastreamento
  await supabase
    .from('chat_channels')
    .update({
      credentials: newCredentials
    })
    .eq('id', channelId);
  
  // Obter contas do WhatsApp Business de clientes
  let clientWabaAccounts = [];
  try {
    const clientWabaResponse = await axios({
      method: 'GET',
      url: `https://graph.facebook.com/v22.0/${process.env.FACEBOOK_BUSINESS_ID}/client_whatsapp_business_accounts`,
      params: {
        fields: 'id,name,currency,owner_business_info',
        limit: 20
      },
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });

    clientWabaAccounts = clientWabaResponse.data.data || [];
    console.log('Contas do WhatsApp Business de clientes:', JSON.stringify(clientWabaAccounts));
  } catch (error) {
    Sentry.captureException(error, {
      tags: {
        channelId,
        setupStatus: newCredentials.setup_status,
        step: 'fetch_accounts'
      }
    });
    console.error('Erro ao obter contas do WhatsApp Business de clientes:', error);
    // Não falhar o processo, apenas registrar o erro
  }

  // // Obter contas do WhatsApp Business próprias
  // let ownedWabaAccounts = [];
  // try {
  //   const ownedWabaResponse = await axios({
  //     method: 'GET',
  //     url: `https://graph.facebook.com/v22.0/${process.env.FACEBOOK_BUSINESS_ID}/owned_whatsapp_business_accounts`,
  //     params: {
  //       fields: 'id,name,currency,owner_business_info',
  //       limit: 20
  //     },
  //     headers: {
  //       'Authorization': `Bearer ${accessToken}`
  //     }
  //   });

  //   ownedWabaAccounts = ownedWabaResponse.data.data || [];
  //   console.log('Contas do WhatsApp Business próprias:', JSON.stringify(ownedWabaAccounts));
  // } catch (error) {
  //   console.error('Erro ao obter contas do WhatsApp Business próprias:', error);
  //   // Não falhar o processo, apenas registrar o erro
  // }
  
  // Salvar as contas no banco de dados
  newCredentials.last_error = null;
  newCredentials.client_waba_accounts = clientWabaAccounts;
  // newCredentials.owned_waba_accounts = ownedWabaAccounts;
  
  // Atualizar status para rastreamento
    await supabase
      .from('chat_channels')
      .update({
        credentials: newCredentials
      })
      .eq('id', channelId);
      
  // Determinar a conta WABA a ser usada
  let selectedWabaId = null;
  
  // Se temos contas próprias, usar a primeira
  if (ownedWabaAccounts.length > 0) {
    selectedWabaId = ownedWabaAccounts[0].id;
  } 
  // Senão, se temos contas de clientes, usar a primeira
  else if (clientWabaAccounts.length > 0) {
    selectedWabaId = clientWabaAccounts[0].id;
  }
  
  return {
    clientWabaAccounts,
    ownedWabaAccounts,
    selectedWabaId
  };
}

/**
 * Obtém detalhes da conta WABA
 */
export async function fetchWabaDetails({ accessToken, wabaId, channelId, newCredentials }) {
  newCredentials.setup_status = 'starting_fetch_waba';
  
  // Atualizar status para rastreamento
  await supabase
    .from('chat_channels')
    .update({
      credentials: newCredentials
    })
    .eq('id', channelId);
  
  try {
    const wabaDetailsResponse = await axios({
      method: 'GET',
      url: `https://graph.facebook.com/v22.0/${wabaId}`,
      params: {
        fields: 'id,name,currency,owner_business_info'
      },
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });

    const wabaDetails = wabaDetailsResponse.data;
    console.log('Detalhes da conta do WhatsApp Business:', JSON.stringify(wabaDetails));
    
    // Salvar os detalhes no banco de dados
    newCredentials.last_error = null;
    newCredentials.waba_details = wabaDetails;
    newCredentials.business_account_id = wabaId;
    newCredentials.business_name = wabaDetails.name || 'WhatsApp Business';
    
    // Atualizar status para rastreamento
    await supabase
      .from('chat_channels')
      .update({
        credentials: newCredentials
      })
      .eq('id', channelId);
    
    return wabaDetails;
  } catch (error) {
    Sentry.captureException(error, {
      tags: {
        channelId,
        setupStatus: newCredentials.setup_status,
        step: 'fetch_waba_details',
        wabaId
      }
    });
    throw error;
  }
}

/**
 * Obtém números de telefone da conta WABA
 */
export async function fetchPhoneNumbers({ accessToken, wabaId, channelId, newCredentials }) {
  newCredentials.setup_status = 'starting_fetch_phone_numbers';
  
  // Atualizar status para rastreamento
  await supabase
    .from('chat_channels')
    .update({
      credentials: newCredentials
    })
    .eq('id', channelId);
  
  try {
    const phoneNumbersResponse = await axios({
      method: 'GET',
      url: `https://graph.facebook.com/v22.0/${wabaId}/phone_numbers`,
      params: {
        fields: 'id,cc,country_dial_code,display_phone_number,verified_name,status,quality_rating,search_visibility,platform_type,code_verification_status'
      },
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });

    const phoneNumbers = phoneNumbersResponse.data.data || [];
    console.log('Números de telefone:', JSON.stringify(phoneNumbers));
    
    // Salvar os números no banco de dados
    newCredentials.phone_numbers = phoneNumbers;
    newCredentials.last_error = null;
    
    // Atualizar status para rastreamento
    await supabase
      .from('chat_channels')
      .update({
        credentials: newCredentials
      })
      .eq('id', channelId);
    
    // Determinar o número de telefone a ser usado
    let selectedPhoneNumberId = null;
    let displayPhoneNumber = null;
    
    if (phoneNumbers.length > 0) {
      selectedPhoneNumberId = phoneNumbers[0].id;
      displayPhoneNumber = phoneNumbers[0].display_phone_number || phoneNumbers[0].verified_name || 'WhatsApp Business';
      
      // Obter informações detalhadas do número de telefone
      try {
        const phoneInfoResponse = await axios({
          method: 'GET',
          url: `https://graph.facebook.com/v22.0/${selectedPhoneNumberId}`,
          headers: {
            'Authorization': `Bearer ${accessToken}`
          }
        });

        const phoneInfo = phoneInfoResponse.data;
        console.log('Informações do telefone:', JSON.stringify(phoneInfo));
        
        newCredentials.phone_info = phoneInfo;
        newCredentials.display_phone_number = phoneInfo.display_phone_number || phoneInfo.verified_name || displayPhoneNumber;
        
        // Atualizar status para rastreamento
        await supabase
          .from('chat_channels')
          .update({
            credentials: newCredentials,
            ...(!newCredentials.phone_number_id ? {external_id: selectedPhoneNumberId} : {})
          })
          .eq('id', channelId);
      } catch (error) {
        Sentry.captureException(error, {
          tags: {
            channelId,
            setupStatus: newCredentials.setup_status,
            step: 'fetch_phone_info',
            phoneNumberId: selectedPhoneNumberId
          }
        });
        console.error('Erro ao obter informações detalhadas do telefone:', error);
        // Não falhar o processo, apenas registrar o erro
      }
    }
    
    return {
      phoneNumbers,
      selectedPhoneNumberId,
      displayPhoneNumber
    };
  } catch (error) {
    Sentry.captureException(error, {
      tags: {
        channelId,
        setupStatus: newCredentials.setup_status,
        step: 'fetch_phone_numbers',
        wabaId
      }
    });
    throw error;
  }
}

/**
 * Obtém modelos de mensagem da conta WABA
 */
export async function fetchMessageTemplates({ accessToken, wabaId, channelId, newCredentials }) {
  newCredentials.setup_status = 'starting_fetch_templates';
  
  // Atualizar status para rastreamento
  await supabase
    .from('chat_channels')
    .update({
      credentials: newCredentials
    })
    .eq('id', channelId);
  
  try {
    const messageTemplatesResponse = await axios({
      method: 'GET',
      url: `https://graph.facebook.com/v22.0/${wabaId}/message_templates`,
      params: {
        fields: 'language,name,rejected_reason,status,category,sub_category,last_updated_time,components,quality_score',
        limit: 50
      },
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });

    const messageTemplates = messageTemplatesResponse.data.data || [];
    console.log('Modelos de mensagem:', JSON.stringify(messageTemplates));
    
    // Salvar os modelos no banco de dados
    newCredentials.message_templates = messageTemplates;
    newCredentials.last_error = null;
    
    // Atualizar status para rastreamento
    await supabase
      .from('chat_channels')
      .update({
        credentials: newCredentials
      })
      .eq('id', channelId);
    
    return {
      messageTemplates
    };
  } catch (error) {
    Sentry.captureException(error, {
      tags: {
        channelId,
        setupStatus: newCredentials.setup_status,
        step: 'fetch_templates',
        wabaId
      }
    });
    throw error;
  }
}

/**
 * Inscreve o aplicativo na conta WABA
 */
export async function subscribeApp({ accessToken, wabaId, channelId, newCredentials }) {
  newCredentials.setup_status = 'starting_subscribe_app';
  
  // Atualizar status para rastreamento
  await supabase
    .from('chat_channels')
    .update({
      credentials: newCredentials
    })
    .eq('id', channelId);
  
  try {
    const subscribeAppResponse = await axios({
      method: 'POST',
      url: `https://graph.facebook.com/v22.0/${wabaId}/subscribed_apps`,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      }
    });

    console.log('Resposta da inscrição do aplicativo:', JSON.stringify(subscribeAppResponse.data));
    
    // Verificar aplicativos inscritos
    const subscribedAppsResponse = await axios({
      method: 'GET',
      url: `https://graph.facebook.com/v22.0/${wabaId}/subscribed_apps`,
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });

    const subscribedApps = subscribedAppsResponse.data.data || [];
    console.log('Aplicativos inscritos:', JSON.stringify(subscribedApps));
    
    // Salvar a inscrição no banco de dados
    newCredentials.app_subscription = subscribeAppResponse.data;
    newCredentials.subscribed_apps = subscribedApps;
    newCredentials.last_error = null;
    
    // Atualizar status para rastreamento
    await supabase
      .from('chat_channels')
      .update({
        credentials: newCredentials
      })
      .eq('id', channelId);
    
    return {
      subscription: subscribeAppResponse.data,
      subscribedApps
    };
  } catch (error) {
    Sentry.captureException(error, {
      tags: {
        channelId,
        setupStatus: newCredentials.setup_status,
        step: 'subscribe_app',
        wabaId
      }
    });
    throw error;
  }
}

/**
 * Registra o telefone na API na Nuvem do WhatsApp
 */
export async function registerPhone({ accessToken, phoneNumberId, channelId, newCredentials }) {
  newCredentials.setup_status = 'starting_register_phone';
  
  // Atualizar status para rastreamento
  await supabase
    .from('chat_channels')
    .update({
      credentials: newCredentials
    })
    .eq('id', channelId);
  
  try {
    const registerPhoneResponse = await axios({
      method: 'POST',
      url: `https://graph.facebook.com/v22.0/${phoneNumberId}/register`,
      data: {
        messaging_product: 'whatsapp',
        pin: '000000', // PIN padrão para registro automático
        // tier: 'prod',
        access_token: accessToken
      },
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      }
    });

    console.log('Resposta do registro do telefone:', JSON.stringify(registerPhoneResponse.data));
    
    // Salvar o registro no banco de dados
    newCredentials.phone_registration = registerPhoneResponse.data;
    newCredentials.last_error = null;
    
    // Atualizar status para rastreamento
    await supabase
      .from('chat_channels')
      .update({
        credentials: newCredentials
      })
      .eq('id', channelId);
    
    return {
      success: true,
      registration: registerPhoneResponse.data
    };
  } catch (error) {
    Sentry.captureException(error, {
      tags: {
        channelId,
        setupStatus: newCredentials.setup_status,
        step: 'register_phone',
        phoneNumberId
      }
    });
    
    // Verificar se é um erro da API do Facebook
    if (error.response && error.response.data && error.response.data.error) {
      const fbError = error.response.data.error;
      throw new Error(`${fbError.message || fbError.type || 'Error not found'}`);
    }
    console.error('Erro ao registrar telefone na API na Nuvem do WhatsApp:', error);
    throw new Error('Erro ao registrar telefone na API na Nuvem do WhatsApp');
  }
}

/**
 * Finaliza a configuração do canal
 */
export async function completeSetup({ channelId, organizationId, newCredentials }) {
  newCredentials.setup_status = 'completed_complete_setup';
  newCredentials.last_error = null;
  
  try {
    // Atualizar status para rastreamento
    await supabase
      .from('chat_channels')
      .update({
        credentials: newCredentials
      })
      .eq('id', channelId);
    
    // Atualizar o canal com as credenciais do WhatsApp
    await supabase
      .from('chat_channels')
      .update({
        credentials: newCredentials,
        status: 'active',
        is_connected: true,
        is_tested: true,
        settings: {
          autoReply: true,
          notifyNewTickets: true
        },
        updated_at: new Date().toISOString()
      })
      .eq('id', channelId)
      .eq('organization_id', organizationId);
    
    return {
      success: true,
      channelId,
      status: 'active',
      is_connected: true
    };
  } catch (error) {
    Sentry.captureException(error, {
      tags: {
        channelId,
        organizationId,
        setupStatus: newCredentials.setup_status,
        step: 'complete_setup'
      }
    });
    throw error;
  }
} 