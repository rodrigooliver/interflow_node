import { supabase } from '../lib/supabase.js';
import Sentry from '../lib/sentry.js';
import crypto from 'crypto';
import { transferToTeam } from '../controllers/chat/transfer-handlers.js';
/**
 * @fileoverview Implementação das ações do sistema para o AgentIA.
 * 
 * Este módulo contém as implementações de ferramentas do sistema que podem ser usadas
 * pelo AgentIA, como agendamento, atualização de cliente, atualização de chat e início de fluxo.
 * 
 * Cada tipo de ferramenta tem duas partes principais:
 * 1. Uma função de geração que cria a definição da ferramenta para o modelo OpenAI
 * 2. Uma função de processamento que executa a ação quando chamada
 */

/**
 * Cache para mapeamentos de nome para ID
 * Estrutura:
 * {
 *   [organizationId]: {
 *     services: {
 *       [scheduleId]: {
 *         data: { [lowercaseName]: id, ... },
 *         timestamp: Date timestamp
 *       }
 *     },
 *     providers: {
 *       [scheduleId]: {
 *         data: { [lowercaseName]: id, ... },
 *         timestamp: Date timestamp
 *       }
 *     },
 *     teams: {
 *       data: { [lowercaseName]: id, ... },
 *       timestamp: Date timestamp
 *     },
 *     flows: {
 *       data: { [lowercaseName]: id, ... },
 *       timestamp: Date timestamp
 *     }
 *   }
 * }
 */
const nameToIdCache = {};

// Tempo de expiração do cache em ms (1 hora)
const CACHE_EXPIRATION = 60 * 60 * 1000;

/**
 * Verifica se o cache está válido (não expirado)
 * @param {number} timestamp - Timestamp do cache
 * @returns {boolean} - True se o cache estiver válido
 */
const isCacheValid = (timestamp) => {
  return timestamp && (Date.now() - timestamp) < CACHE_EXPIRATION;
};

/**
 * Obtém um mapeamento do cache
 * @param {string} organizationId - ID da organização
 * @param {string} type - Tipo de mapeamento (services, providers, teams, flows)
 * @param {string} [subKey] - Chave adicional para o cache (ex: scheduleId)
 * @returns {Object|null} - Mapeamento ou null se não estiver em cache
 */
const getCachedMap = (organizationId, type, subKey = null) => {
  if (!nameToIdCache[organizationId]) return null;
  
  // Para serviços e profissionais, precisamos de uma subKey (scheduleId)
  if ((type === 'services' || type === 'providers') && !subKey) return null;
  
  const cache = nameToIdCache[organizationId];
  
  // Serviços e profissionais são organizados por agenda
  if (type === 'services' || type === 'providers') {
    if (!cache[type] || !cache[type][subKey]) return null;
    
    const typeCache = cache[type][subKey];
    if (!isCacheValid(typeCache.timestamp)) return null;
    
    return typeCache.data;
  }
  
  // Equipes e fluxos são organizados apenas por organização
  if (!cache[type]) return null;
  
  const typeCache = cache[type];
  if (!isCacheValid(typeCache.timestamp)) return null;
  
  return typeCache.data;
};

/**
 * Armazena um mapeamento no cache
 * @param {string} organizationId - ID da organização
 * @param {string} type - Tipo de mapeamento (services, providers, teams, flows)
 * @param {Object} map - Mapeamento a ser armazenado
 * @param {string} [subKey] - Chave adicional para o cache (ex: scheduleId)
 */
const setCachedMap = (organizationId, type, map, subKey = null) => {
  if (!organizationId) return;
  
  // Inicializar o cache da organização se necessário
  if (!nameToIdCache[organizationId]) {
    nameToIdCache[organizationId] = {
      services: {},
      providers: {},
      teams: null,
      flows: null
    };
  }
  
  const timestamp = Date.now();
  
  // Serviços e profissionais são organizados por agenda
  if ((type === 'services' || type === 'providers') && subKey) {
    if (!nameToIdCache[organizationId][type]) {
      nameToIdCache[organizationId][type] = {};
    }
    
    nameToIdCache[organizationId][type][subKey] = {
      data: map,
      timestamp
    };
    return;
  }
  
  // Equipes e fluxos são organizados apenas por organização
  nameToIdCache[organizationId][type] = {
    data: map,
    timestamp
  };
};

/**
 * Transforma uma string para seguir o padrão ^[a-zA-Z0-9_-]+$
 * @param {string} name - Nome original
 * @returns {string} - Nome transformado
 */
const transformToolName = (name) => {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_') // Substitui caracteres não alfanuméricos por underscore
    .replace(/_+/g, '_') // Remove underscores duplicados
    .replace(/^_|_$/g, ''); // Remove underscores do início e fim
};

/**
 * Gera ferramentas do sistema com base nas ações configuradas
 * @param {string} organizationId - ID da organização
 * @param {Array<Object>} systemActions - Array de ações do sistema configuradas, incluindo nome, descrição e tipo
 * @returns {Promise<Array>} - Lista de ferramentas geradas
 */
export const generateSystemTools = async (organizationId, systemActions = [], customer = null) => {
  try {
    console.log(`[generateSystemTools] Gerando ferramentas do sistema para organização ${organizationId}`);
    const tools = [];
    
    // Para cada ação do sistema, gerar a ferramenta correspondente
    for (const action of systemActions) {
      if (!action || !action.type) continue;
      
      let tool = null;
      const actionType = action.type;
      
      switch (actionType) {
        case 'schedule':
          tool = await generateScheduleTool(organizationId, action);
          break;
        case 'updateCustomerCustomData':
          tool = await generateUpdateCustomerCustomDataTool(organizationId, action);
          break;
        case 'changeCustomerName':
          tool = generateChangeCustomerName(organizationId, action);
          break;
        case 'transferToTeam':
          tool = await generateTransferToTeamTool(organizationId, action);
          break;
        case 'changeFunnel':
          tool = await generateChangeFunnelTool(organizationId, action, customer);
          break;
        case 'unknownResponse':
          tool = generateUnknownResponseTool(organizationId, action);
          break;
        // case 'update_chat':
        //   tool = generateUpdateChatTool(action);
        //   break;
        // case 'start_flow':
        //   tool = await generateStartFlowTool(organizationId, action);
        //   break;
        default:
          console.log(`[generateSystemTools] Tipo de ação desconhecido: ${actionType}`);
          continue;
      }
      
      if (tool) {
        tools.push(tool);
      }
    }
    
    return tools;
  } catch (error) {
    console.error(`[generateSystemTools] Erro ao gerar ferramentas do sistema:`, error);
    Sentry.captureException(error);
    return [];
  }
};

/**
 * Gera a ferramenta para agendamento
 * @param {string} organizationId - ID da organização
 * @param {Object} action - Ação associada à ferramenta
 * @returns {Promise<Object>} - Ferramenta de agendamento
 */
const generateScheduleTool = async (organizationId, action) => {
    if (!action.config.schedule) {
        console.log(`[generateScheduleTool] Nenhuma agenda configurada para a ação ${action.name}`);
        return null;
    }
  try {
    // Verificar se há uma agenda configurada o tool
    const { data: schedules, error } = await supabase
      .from('schedules')
      .select('id, title')
      .eq('organization_id', organizationId)
      .eq('id', action.config.schedule)
      .eq('status', 'active');
    
    if (error) {
      throw error;
    }
    
    if (!schedules || schedules.length === 0) {
      console.log(`[generateScheduleTool] Nenhuma agenda encontrada para a organização ${organizationId}`);
      return null;
    }
    
    // Para simplificar, usar a primeira agenda encontrada
    const scheduleId = schedules[0].id;
    const scheduleName = schedules[0].title;
    
    // Buscar serviços da agenda
    const { data: services, error: servicesError } = await supabase
      .from('schedule_services')
      .select('id, title')
      .eq('schedule_id', scheduleId)
      .eq('status', 'active');
    
    if (servicesError) {
      throw servicesError;
    }
    
    // Buscar providers da agenda
    const { data: providers, error: providersError } = await supabase
      .from('schedule_providers')
      .select(`
        id, 
        profiles(
          id, 
          full_name
        )
      `)
      .eq('schedule_id', scheduleId)
      .eq('status', 'active');
    
    if (providersError) {
      throw providersError;
    }
    
    // Usar o nome e a descrição da ação configurada ou usar padrões
    const toolName = transformToolName(action.name || "schedule_appointment");
    const toolDescription = action.description || 
      `Agendar, consultar ou cancelar compromissos na agenda "${scheduleName}". Use esta ferramenta quando o cliente quiser agendar, verificar disponibilidade ou cancelar um agendamento existente.`;
    
    // Construir a ferramenta para agendamento
    return {
      name: toolName,
      description: toolDescription,
      parameters: {
        type: "object",
        properties: {
          operation: {
            type: "string",
            enum: ["checkAvailability", "createAppointment", "checkAppointment", "deleteAppointment"],
            description: "Operação a ser realizada no sistema de agendamento."
          },
          date: {
            type: "string",
            description: "Data para o agendamento no formato YYYY-MM-DD (ex: 2023-12-31)."
          },
          time: {
            type: "string",
            description: "Horário para o agendamento no formato HH:MM (ex: 14:30)."
          },
          ...(services && services.length > 0 ? {
            service_name: {
              type: "string",
              enum: services.map(service => service.title),
              description: "Nome do serviço a ser agendado."
            }
          } : {}),
          ...(providers && providers.length > 0 && providers.some(p => p.profiles?.full_name) ? {
            provider_name: {
              type: "string",
              enum: providers.map(provider => provider.profiles?.full_name).filter(name => name),
              description: "Nome do profissional que realizará o atendimento."
            }
          } : {}),
          notes: {
            type: "string",
            description: "Observações ou notas adicionais para o agendamento."
          },
          appointment_id: {
            type: "string",
            description: "ID do agendamento para operações de consulta ou cancelamento."
          }
        },
        required: ["operation"]
      }
    };
  } catch (error) {
    console.error(`[generateScheduleTool] Erro ao gerar ferramenta de agendamento:`, error);
    Sentry.captureException(error);
    return null;
  }
};

/**
 * Gera a ferramenta para alterar o nome do cliente
 * @param {string} organizationId - ID da organização
 * @param {Object} action - Ação associada à ferramenta
 * @returns {Object} - Ferramenta de atualização de cliente
 */
const generateChangeCustomerName = (organizationId, action) => {
  // Usar o nome e a descrição da ação configurada ou usar padrões
  const toolName = transformToolName(action.title || "change_customer_name");
  const toolDescription = action.description || 
    "Alterar o nome do cliente.";
  
  return {
    name: toolName,
    description: toolDescription,
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Name of the customer to be changed."
        },
      }
    },
    required: ["name"]
  };
};

/**
 * Gera a ferramenta para atualizar dados do chat
 * @param {Object} action - Ação associada à ferramenta
 * @returns {Object} - Ferramenta de atualização de chat
 */
const generateUpdateChatTool = (action) => {
  // Usar o nome e a descrição da ação configurada ou usar padrões
  const toolName = transformToolName(action.name || "update_chat");
  const toolDescription = action.description || 
    "Atualizar informações do chat atual, como título, status ou equipe responsável.";
  
  return {
    name: toolName,
    description: toolDescription,
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Novo título para o chat."
        },
        status: {
          type: "string",
          enum: ["in_progress", "waiting", "closed", "transferred"],
          description: "Novo status para o chat."
        },
        team_name: {
          type: "string",
          description: "Nome da equipe que deve ser responsável pelo chat."
        }
      }
    }
  };
};

/**
 * Gera a ferramenta para iniciar um fluxo automatizado
 * @param {string} organizationId - ID da organização
 * @param {Object} action - Ação associada à ferramenta
 * @returns {Promise<Object>} - Ferramenta de início de fluxo
 */
const generateStartFlowTool = async (organizationId, action) => {
  try {
    // Buscar fluxos disponíveis para a organização
    const { data: flows, error } = await supabase
      .from('flows')
      .select('id, name')
      .eq('organization_id', organizationId)
      .eq('is_active', true);
    
    if (error) {
      throw error;
    }
    
    if (!flows || flows.length === 0) {
      console.log(`[generateStartFlowTool] Nenhum fluxo encontrado para a organização ${organizationId}`);
      return null;
    }
    
    // Usar o nome e a descrição da ação configurada ou usar padrões
    const toolName = transformToolName(action.name || "start_flow");
    const toolDescription = action.description || 
      "Iniciar um fluxo de automação para processar uma tarefa específica.";
    
    return {
      name: toolName,
      description: toolDescription,
      parameters: {
        type: "object",
        properties: {
          flow_name: {
            type: "string",
            enum: flows.map(flow => flow.name),
            description: "Nome do fluxo a ser iniciado."
          },
          variables: {
            type: "object",
            description: "Variáveis a serem passadas para o fluxo.",
            additionalProperties: true
          }
        },
        required: ["flow_name"]
      }
    };
  } catch (error) {
    console.error(`[generateStartFlowTool] Erro ao gerar ferramenta de início de fluxo:`, error);
    Sentry.captureException(error);
    return null;
  }
};

/**
 * Cria um mapa de nome para ID a partir de uma lista de itens
 * @param {Array} items - Lista de itens com nome e ID
 * @param {string} nameKey - Nome da propriedade que contém o nome
 * @param {string} idKey - Nome da propriedade que contém o ID
 * @returns {Object} - Mapa de nome para ID
 */
const createNameToIdMap = (items, nameKey = 'name', idKey = 'id') => {
  const map = {};
  if (!items || !Array.isArray(items)) return map;
  
  for (const item of items) {
    if (!item) continue; // Pular itens nulos ou undefined
    
    // Lidar com casos onde o nome está aninhado (como em profiles.full_name)
    let name = item[nameKey];
    if (!name && nameKey.includes('.')) {
      try {
        const keys = nameKey.split('.');
        let nested = item;
        for (const key of keys) {
          if (!nested) break;
          nested = nested[key];
        }
        name = nested;
      } catch (error) {
        console.warn(`[createNameToIdMap] Erro ao acessar propriedade aninhada '${nameKey}':`, error);
        continue; // Pular este item se houver erro
      }
    }
    
    // Lidar com casos onde o ID está aninhado
    let id = item[idKey];
    if (!id && idKey.includes('.')) {
      try {
        const keys = idKey.split('.');
        let nested = item;
        for (const key of keys) {
          if (!nested) break;
          nested = nested[key];
        }
        id = nested;
      } catch (error) {
        console.warn(`[createNameToIdMap] Erro ao acessar propriedade aninhada '${idKey}':`, error);
        continue; // Pular este item se houver erro
      }
    }
    
    if (name && id) {
      map[name.toLowerCase()] = id;
    }
  }
  
  return map;
};

/**
 * Processa chamadas para ferramentas do sistema
 * @param {string} tool - Ferramenta do sistema  a ser processada
 * @param {Object} args - Argumentos da chamada
 * @param {Object} actionsSystem - Ações disponíveis para a organização
 * @param {Object} session - Sessão atual
 * @returns {Object|Array} - Resultado(s) da operação
 */
export const handleSystemToolCall = async (
  tool, 
  args, 
  actionsSystem,
  session
) => {
  try {
    // console.log(`[handleSystemToolCall] Processando chamada para ferramenta do sistema: ${tool.name}`);

    // console.log(`[handleSystemToolCall] Ferramentas disponíveis: ${JSON.stringify(actionsSystem)}`);

    const action = actionsSystem.find(action => action.name === tool.name);

    // console.log(`[handleSystemToolCall] Ferramenta encontrada: ${JSON.stringify(action)}`);
    // console.log(`[handleSystemToolCall] Ferramenta config: ${JSON.stringify(action.config)}`);

    if(!action.type) {
      return {
        status: "error",
        message: "No action type found for this tool."
      };
    }

    switch (action.type) {
      case 'schedule': {
        if (!action.config.schedule) {
          console.log(`[handleSystemToolCall] Agenda não existe`);
          return {
            status: "error",
            message: "Schedule ID is required."
          };
        }
        // Buscar a agenda configurada
        const { data: schedules, error: schedulesError } = await supabase
          .from('schedules')
          .select('id, title')
          .eq('organization_id', session.organization_id)
          .eq('id', action.config.schedule)
          .eq('status', 'active');

        console.log(`[handleSystemToolCall] Agenda: ${JSON.stringify(schedules)}`);
        
        if (schedulesError) {
          return {
            status: "error",
            message: "No active schedules found for this organization.",
          };
        }

        if (!schedules || schedules.length === 0) {
          return {
            status: "error",
            message: "No active schedules found for this organization.",
          };
        }
        
        // Usar a primeira agenda disponível
        const scheduleId = schedules[0].id;
        console.log(`[handleSystemToolCall] Usando agenda: ${scheduleId}`);
        
        // Processar mapeamento de nome para ID apenas se os argumentos correspondentes estiverem presentes
        
        // 1. Mapear service_name para service_id se fornecido
        if (args.service_name) {
          // Verificar se existe no cache
          let serviceMap = getCachedMap(session.organization_id, 'services', scheduleId);
          
          // Se não existir no cache, buscar e armazenar
          if (!serviceMap) {
            const { data: services } = await supabase
              .from('schedule_services')
              .select('id, title')
              .eq('schedule_id', scheduleId)
              .eq('status', 'active');
            
            if (!services || services.length === 0) {
              console.warn(`[handleSystemToolCall] Nenhum serviço encontrado para a agenda ${scheduleId}`);
              return {
                status: "error",
                message: "No services found for this schedule.",
              };
            }
            
            // Criar e armazenar o mapa no cache
            serviceMap = createNameToIdMap(services, 'title', 'id');
            setCachedMap(session.organization_id, 'services', serviceMap, scheduleId);
            console.log(`[handleSystemToolCall] Cache de serviços criado para organização ${session.organization_id}, agenda ${scheduleId}`);
          } else {
            console.log(`[handleSystemToolCall] Usando cache de serviços para organização ${session.organization_id}, agenda ${scheduleId}`);
          }
          
          const serviceName = args.service_name.toLowerCase();
          
          if (serviceMap[serviceName]) {
            args.service_id = serviceMap[serviceName];
            console.log(`[handleSystemToolCall] Mapeado nome do serviço "${args.service_name}" para ID: ${args.service_id}`);
          } else {
            console.warn(`[handleSystemToolCall] Serviço "${args.service_name}" não encontrado`);
            return {
              status: "error",
              message: `Service "${args.service_name}" not found. Please choose a valid service.`,
            };
          }
        }
        
        // 2. Mapear provider_name para provider_id se fornecido
        if (args.provider_name) {
          // Verificar se existe no cache
          let providerMap = getCachedMap(session.organization_id, 'providers', scheduleId);
          
          // Se não existir no cache, buscar e armazenar
          if (!providerMap) {
            const { data: providers } = await supabase
              .from('schedule_providers')
              .select(`
                id,
                profiles(id, full_name)
              `)
              .eq('schedule_id', scheduleId)
              .eq('status', 'active');
            
            if (!providers || providers.length === 0) {
              console.warn(`[handleSystemToolCall] Nenhum profissional encontrado para a agenda ${scheduleId}`);
              // Não retornar erro, pois é opcional
            } else {
              // Criar e armazenar o mapa no cache
              providerMap = createNameToIdMap(providers.map(p => p.profiles), 'full_name', 'id');
              setCachedMap(session.organization_id, 'providers', providerMap, scheduleId);
              console.log(`[handleSystemToolCall] Cache de profissionais criado para organização ${session.organization_id}, agenda ${scheduleId}`);
            }
          } else {
            console.log(`[handleSystemToolCall] Usando cache de profissionais para organização ${session.organization_id}, agenda ${scheduleId}`);
          }
          
          if (providerMap) {
            const providerName = args.provider_name.toLowerCase();
            
            if (providerMap[providerName]) {
              args.provider_id = providerMap[providerName];
              console.log(`[handleSystemToolCall] Mapeado nome do profissional "${args.provider_name}" para ID: ${args.provider_id}`);
            } else {
              console.warn(`[handleSystemToolCall] Profissional "${args.provider_name}" não encontrado`);
              // Não retornar erro se o profissional não for encontrado, pois ele é opcional
              // O sistema irá alocar um profissional automaticamente
            }
          }
        }
        
        // Criar uma ação para processamento pelo processCheckScheduleAction
        const actionReturn = {
          type: args.operation,
          config: {
            scheduleId: scheduleId,
            operation: args.operation,
            date: args.date,
            time: args.time,
            appointmentId: args.appointmentId,
            serviceId: args.serviceId,
            notes: args.notes
          }
        };

        console.log(`[handleSystemToolCall] Ação de agendamento retornada: ${JSON.stringify(actionReturn)}`);
        
        // Processar a ação
        return await processCheckScheduleAction(actionReturn, args, session);
      }
      
      case 'updateCustomerCustomData': {
        if (!action.config.customFields || action.config.customFields.length === 0) {
          return {
            status: "error",
            message: "No custom fields configured for this action."
          };
        }
        
        // Buscar os campos personalizados configurados
        const customFieldIds = action.config.customFields.map(field => field.id);
        
        const { data: customFields, error } = await supabase
          .from('custom_fields_definition')
          .select('id, name, type, options, mask_type, custom_mask, description, slug')
          .eq('organization_id', session.organization_id)
          .in('id', customFieldIds);
        
        if (error) {
          console.error(`[handleSystemToolCall] Erro ao buscar campos personalizados:`, error);
          return {
            status: "error",
            message: "Error fetching custom fields."
          };
        }
        
        if (!customFields || customFields.length === 0) {
          return {
            status: "error",
            message: "No custom fields found for this action."
          };
        }
        
        // Verificar se o cliente existe
        if (!session.customer_id) {
          return {
            status: "error",
            message: "No customer found in this session."
          };
        }
        
        // Criar um mapeamento de slug para id
        const slugToIdMap = {};
        for (const field of customFields) {
          const slug = field.slug || field.id;
          slugToIdMap[slug] = field.id;
        }

        // Preparar o objeto de atualização para inserção/atualização de valores
        const updateValues = [];
        const errors = [];
        
        // Validar e processar cada campo personalizado
        for (const field of customFields) {
          const fieldId = field.id;
          const fieldSlug = field.slug || field.id;
          
          // Se o campo estiver presente nos argumentos
          if (args[fieldSlug] !== undefined) {
            const value = args[fieldSlug];
            
            // Validar o valor com base no tipo
            let isValid = true;
            let processedValue = value;
            
            switch (field.type) {
              case 'number':
                // Verificar se é um número válido
                if (isNaN(Number(value))) {
                  errors.push(`Invalid number format for field "${field.name}"`);
                  isValid = false;
                }
                processedValue = Number(value);
                break;
              case 'date':
                // Verificar formato de data YYYY-MM-DD
                if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
                  errors.push(`Invalid date format for field "${field.name}". Expected format: YYYY-MM-DD`);
                  isValid = false;
                }
                break;
              case 'datetime':
                // Verificar formato de data e hora YYYY-MM-DD HH:MM
                if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value)) {
                  errors.push(`Invalid datetime format for field "${field.name}". Expected format: YYYY-MM-DD HH:MM`);
                  isValid = false;
                }
                break;
              case 'select':
                // Verificar se o valor está na lista de opções
                if (field.options && !field.options.includes(value)) {
                  errors.push(`Invalid option for field "${field.name}". Valid options: ${field.options.join(", ")}`);
                  isValid = false;
                }
                break;
              case 'text':
                // Verificar máscaras específicas
                if (field.mask_type) {
                  switch (field.mask_type) {
                    case 'cpf':
                      if (!/^\d{3}\.\d{3}\.\d{3}-\d{2}$/.test(value)) {
                        errors.push(`Invalid CPF format for field "${field.name}". Expected format: 123.456.789-01`);
                        isValid = false;
                      }
                      break;
                    case 'cnpj':
                      if (!/^\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}$/.test(value)) {
                        errors.push(`Invalid CNPJ format for field "${field.name}". Expected format: 12.345.678/0001-90`);
                        isValid = false;
                      }
                      break;
                    case 'phone':
                      if (!/^\(\d{2}\) \d{5}-\d{4}$/.test(value)) {
                        errors.push(`Invalid phone format for field "${field.name}". Expected format: (00) 00000-0000`);
                        isValid = false;
                      }
                      break;
                    case 'cep':
                      if (!/^\d{5}-\d{3}$/.test(value)) {
                        errors.push(`Invalid CEP format for field "${field.name}". Expected format: 00000-000`);
                        isValid = false;
                      }
                      break;
                    case 'rg':
                      if (!/^\d{2}\.\d{3}\.\d{3}-\d{1}$/.test(value)) {
                        errors.push(`Invalid RG format for field "${field.name}". Expected format: 00.000.000-0`);
                        isValid = false;
                      }
                      break;
                  }
                }
                break;
            }
            
            // Se o valor for válido, adicioná-lo aos valores de atualização
            if (isValid) {
              updateValues.push({
                customer_id: session.customer_id,
                field_definition_id: fieldId,
                value: String(processedValue)
              });
            }
          } else {
            errors.push(`Field "${field.name}" is required but was not provided`);
          }
        }
        
        // Se houver erros, retornar mensagem de erro
        if (errors.length > 0) {
          return {
            status: "error",
            message: `Validation errors: ${errors.join("; ")}`
          };
        }
        
        // Inserir/atualizar valores dos campos personalizados
        for (const value of updateValues) {
          // Verificar se já existe um valor para este campo
          const { data: existingValue, error: fetchError } = await supabase
            .from('customer_field_values')
            .select('id')
            .eq('customer_id', session.customer_id)
            .eq('field_definition_id', value.field_definition_id)
            .single();
          
          if (fetchError && fetchError.code !== 'PGRST116') { // PGRST116 = Not found
            console.error(`[handleSystemToolCall] Erro ao verificar valor existente:`, fetchError);
            continue;
          }
          
          let result;
          
          if (existingValue) {
            // Atualizar valor existente
            result = await supabase
              .from('customer_field_values')
              .update({ value: value.value, updated_at: new Date() })
              .eq('id', existingValue.id);
          } else {
            // Inserir novo valor
            result = await supabase
              .from('customer_field_values')
              .insert([{
                customer_id: value.customer_id,
                field_definition_id: value.field_definition_id,
                value: value.value
              }]);
          }
          
          if (result.error) {
            console.error(`[handleSystemToolCall] Erro ao salvar valor de campo personalizado:`, result.error);
            errors.push(`Error saving field ${value.field_definition_id}`);
          }
        }
        
        if (errors.length > 0) {
          return {
            status: "partial",
            message: `Some fields could not be updated: ${errors.join("; ")}`
          };
        }
        
        return {
          status: "success",
          message: `Customer fields updated successfully.`,
          fields_updated: updateValues.length
        };
      }
      

      case 'changeCustomerName': {
        if(!args.name){
          return {
            status: "error",
            message: "Name is required."
          };
        }

        //Atualizar o nome do cliente
        const { data: customer, error } = await supabase
          .from('customers')
          .update({ name: args.name })
          .eq('id', session.customer_id)
          .single();

        if(error){
          return {
            status: "error",
            message: "Error updating customer name."
          };
        }

        return {
          status: "success",
          message: "Customer name updated successfully.",
          customer: customer
        };
      }
      
      case 'transferToTeam': {
        // Verificar se team_name foi fornecido (obrigatório)
        if (!args.team_name) {
          return {
            status: "error",
            message: "Team name is required."
          };
        }
        
        // Mapear nome da equipe para ID
        // Verificar se existe no cache
        let teamMap = getCachedMap(session.organization_id, 'teams');
        
        // Se não existir no cache, buscar e armazenar
        if (!teamMap) {
          const { data: teams } = await supabase
            .from('service_teams')
            .select('id, name')
            .eq('organization_id', session.organization_id);
          
          if (!teams || teams.length === 0) {
            console.log(`[handleSystemToolCall] Nenhuma equipe encontrada, ignorando atribuição de equipe`);
            return {
              status: "error",
              message: "No active teams found for this organization.",
            };
            // Não impedir a ação se não houver equipes, apenas ignorar este campo
          } else {
            // Criar e armazenar o mapa no cache
            teamMap = createNameToIdMap(teams);
            setCachedMap(session.organization_id, 'teams', teamMap);
            // console.log(`[handleSystemToolCall] Cache de equipes criado para organização ${session.organization_id}`);
          }
        } else {
          console.log(`[handleSystemToolCall] Usando cache de equipes para organização ${session.organization_id}`);
        }
        
        if (teamMap) {
          const teamName = args.team_name.toLowerCase();
          
          if (teamMap[teamName]) {
            args.team_id = teamMap[teamName];
            // console.log(`[handleSystemToolCall] Mapeado nome da equipe "${args.team_name}" para ID: ${args.team_id}`);
          } else {
            console.warn(`[handleSystemToolCall] Equipe "${args.team_name}" não encontrada`);
            return {
              status: "error",
              message: `Team "${args.team_name}" not found. Please choose a valid team.`,
            };
          }
        }


        // console.log(`[handleSystemToolCall] Transferindo chat para equipe ${args.team_id}`);
        // console.log(`[handleSystemToolCall] Chat ID: ${session.chat_id}`);
        // console.log(`[handleSystemToolCall] Organization ID: ${session.organization_id}`);

        
        //Transferir o chat para a equipe
        const result = await transferToTeam({
          organizationId: session.organization_id,
          chatId: session.chat_id,
          newTeamId: args.team_id
        });

        if(result.success){
          return {
            status: "success",
            message: result.message
          };
        }

        return {
          status: "error",
          message: result.message ?? "Error transferring chat to team."
        };
      }
      
      case 'changeFunnel': {
        console.log(`[handleSystemToolCall] Iniciando ação changeFunnel`);
        if (!session.customer_id) {
          return {
            status: "error",
            message: "No customer found in this session."
          };
        }

        // Verificar se target_stage foi fornecido (obrigatório)
        if (!args.target_stage) {
          return {
            status: "error",
            message: "Target stage name is required."
          };
        }

        // Verificar se o nome do estágio de destino está entre os estágios configurados
        const targetStages = action.config.targetStages || [];
        const targetStageConfig = targetStages.find(stage => stage.name === args.target_stage);
        
        if (!targetStageConfig) {
          return {
            status: "error",
            message: `Invalid target stage name: ${args.target_stage}. Please choose one of the available options.`
          };
        }

        const targetStageId = targetStageConfig.id;

        // Verificar o estágio atual do cliente
        const { data: customer, error: customerError } = await supabase
          .from('customers')
          .select('stage_id')
          .eq('id', session.customer_id)
          .single();

        if (customerError) {
          console.error(`[handleSystemToolCall] Erro ao obter estágio atual do cliente:`, customerError);
          return {
            status: "error",
            message: "Error retrieving customer's current stage."
          };
        }

        // Verificar se o cliente tem um estágio atual
        if (!customer.stage_id) {
          return {
            status: "error",
            message: "Customer is not in any funnel stage."
          };
        }

        // Verificar se o estágio atual está entre os estágios de origem permitidos
        const sourceStages = action.config.sourceStages || [];
        const isValidSourceStage = sourceStages.some(stage => stage.id === customer.stage_id);
        
        if (!isValidSourceStage) {
          // Encontrar o nome do estágio atual para mensagem de erro
          // Primeiro, vamos obter o estágio atual do cliente
          const { data: currentStage } = await supabase
            .from('crm_stages')
            .select('name, funnel_id')
            .eq('id', customer.stage_id)
            .single();
          
          // Depois, obter o nome do funil atual
          let currentFunnelName = "";
          if (currentStage && currentStage.funnel_id) {
            const { data: currentFunnel } = await supabase
              .from('crm_funnels')
              .select('name')
              .eq('id', currentStage.funnel_id)
              .single();
            
            if (currentFunnel) {
              currentFunnelName = currentFunnel.name;
            }
          }
          
          const currentStageInfo = currentStage ? 
            `${currentStage.name}${currentFunnelName ? ` em ${currentFunnelName}` : ''}` : 
            'estágio desconhecido';
            
          return {
            status: "error",
            message: `This action cannot be performed because the customer is currently in ${currentStageInfo}, which is not in the list of allowed source stages.`
          };
        }

        // Obter informações do estágio de destino para resposta 
        // (já temos o nome a partir do targetStageConfig, mas precisamos do nome do funil)
        const { data: targetStage } = await supabase
          .from('crm_stages')
          .select('name, funnel_id')
          .eq('id', targetStageId)
          .single();
        
        let targetFunnelName = targetStageConfig.funnelName || "";
        if (!targetFunnelName && targetStage && targetStage.funnel_id) {
          const { data: targetFunnel } = await supabase
            .from('crm_funnels')
            .select('name')
            .eq('id', targetStage.funnel_id)
            .single();
          
          if (targetFunnel) {
            targetFunnelName = targetFunnel.name;
          }
        }

        // Atualizar o estágio do cliente
        const { error: updateError } = await supabase
          .from('customers')
          .update({ 
            stage_id: targetStageId
          })
          .eq('id', session.customer_id);

        console.log(`[handleSystemToolCall] Estágio do cliente atualizado para ${args.target_stage}`);

        if (updateError) {
          console.error(`[handleSystemToolCall] Erro ao atualizar estágio do cliente:`, updateError);
          return {
            status: "error",
            message: "Error updating customer's funnel stage."
          };
        }

        // Registrar a mudança no histórico do CRM (opcional)
        try {
          await supabase
            .from('customer_stage_history')
            .insert({
              customer_id: session.customer_id,
              organization_id: session.organization_id,
              stage_id: targetStageId,
              notes: `Customer's funnel stage updated to ${args.target_stage}${targetFunnelName ? ` in ${targetFunnelName}` : ''}.`,
              moved_at: new Date().toISOString(),
              created_at: new Date().toISOString()
            });
        } catch (historyError) {
          // Apenas logar o erro, não interromper o fluxo
          console.warn(`[handleSystemToolCall] Erro ao registrar mudança no histórico do CRM:`, historyError);
        }

        return {
          status: "success",
          message: `Customer's funnel stage successfully updated to ${args.target_stage}${targetFunnelName ? ` in ${targetFunnelName}` : ''}. Note: Not informing the customer.` 
        };
      }
      
      case 'unknownResponse': {
        // console.log(`[handleSystemToolCall] Processando ação unknownResponse`);
        
        // Verificar se existem informações necessárias
        if (!args.question || !args.content) {
          return {
            status: "error",
            message: "Question and content are required for unknownResponse action."
          };
        }
        
        // Verificar se temos uma sessão válida
        if (!session.organization_id || !session.chat_id) {
          return {
            status: "error",
            message: "Invalid session data for unknownResponse action."
          };
        }
        
        // Extrair as configurações da ação
        const config = action.config?.unknownResponse || {};
        const pauseAgent = config.pauseAgent || false;
        const saveQuestion = config.saveQuestion !== false; // Verdadeiro por padrão
        const tryToAnswer = config.tryToAnswer || false;
        
        // Gerar um ID único para essa entrada
        const entryId = crypto.randomUUID();
        
        // Se saveQuestion for true, salvar na tabela prompt_unknowns
        if (saveQuestion) {
          try {
            // Criar a entrada na tabela prompt_unknowns
            const { error: insertError } = await supabase
              .from('prompt_unknowns')
              .insert({
                id: entryId,
                prompt_id: session.prompt.id || null,
                chat_id: session.chat_id,
                question: args.question,
                content: args.content,
                category: args.category || null,
                priority: args.priority || 'medium',
                status: 'pending',
                notes: args.notes || null,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
              });
            
            if (insertError) {
              console.error(`[handleSystemToolCall] Erro ao salvar informação desconhecida:`, insertError);
              // Continuar o processamento mesmo com o erro
            } else {
              // console.log(`[handleSystemToolCall] Informação desconhecida salva com sucesso, ID: ${entryId}`);
            }
          } catch (dbError) {
            console.error(`[handleSystemToolCall] Exceção ao salvar informação desconhecida:`, dbError);
            // Continuar o processamento mesmo com o erro
          }
        }
        
        // Retornar a resposta apropriada
        return {
          status: "success",
          message: "Unknown response action processed.",
          entry_id: entryId,
          actions_taken: {
            pause_agent: pauseAgent,
            save_question: saveQuestion,
            try_to_answer: tryToAnswer,
            type: 'unknownResponse'
          },
          should_pause: pauseAgent
        };
      }
      
      default:
        console.warn(`[handleSystemToolCall] Ferramenta do sistema não reconhecida: ${tool.name}`);
        return {
          status: "error",
          message: `Unrecognized system tool: ${tool.name}`
        };
    }
  } catch (error) {
    console.error(`[handleSystemToolCall] Erro ao processar ferramenta do sistema ${tool.name}:`, error);
    Sentry.captureException(error);
    return {
      status: "error",
      message: `Error processing system tool ${tool.name}: ${error.message}`
    };
  }
};

/**
 * Limpa um item específico do cache
 * @param {string} organizationId - ID da organização
 * @param {string} type - Tipo de mapeamento (services, providers, teams, flows)
 * @param {string} [subKey] - Chave adicional para o cache (ex: scheduleId)
 */
const clearCacheItem = (organizationId, type, subKey = null) => {
  if (!organizationId || !nameToIdCache[organizationId]) return;
  
  if ((type === 'services' || type === 'providers') && subKey) {
    if (nameToIdCache[organizationId][type] && nameToIdCache[organizationId][type][subKey]) {
      delete nameToIdCache[organizationId][type][subKey];
      console.log(`[clearCacheItem] Cache de ${type} limpo para agenda ${subKey} na organização ${organizationId}`);
    }
    return;
  }
  
  if (nameToIdCache[organizationId][type]) {
    delete nameToIdCache[organizationId][type];
    console.log(`[clearCacheItem] Cache de ${type} limpo para organização ${organizationId}`);
  }
};

/**
 * Limpa todo o cache de uma organização
 * @param {string} organizationId - ID da organização
 */
const clearOrganizationCache = (organizationId) => {
  if (organizationId && nameToIdCache[organizationId]) {
    delete nameToIdCache[organizationId];
    console.log(`[clearOrganizationCache] Todo o cache limpo para organização ${organizationId}`);
  }
};

/**
 * Limpa todo o cache
 */
const clearAllCache = () => {
  Object.keys(nameToIdCache).forEach(key => delete nameToIdCache[key]);
  console.log(`[clearAllCache] Cache global limpo`);
};

/**
 * Processa uma ação de verificação de agenda para ferramentas do sistema
 * @param {Object} action - Configuração da ação
 * @param {Object} args - Argumentos da ferramenta
 * @param {Object} session - Sessão atual
 * @returns {Promise<Object>} - Resultado da operação
 */
const processCheckScheduleAction = async (action, args, session) => {
  try {
    const config = action?.config || {};
    
    // Extrair os argumentos principais
    const operation = args.operation;
    const date = args.date;
    const time = args.time;
    const appointmentId = args.appointment_id;
    const serviceId = args.service_id;
    const providerId = args.provider_id;
    const notes = args.notes;
    
    // Verificar se a operação foi fornecida
    if (!operation) {
      return {
        status: "error",
        message: "Operation parameter is required for schedule actions."
      };
    }
    
    // Identificar o ID da agenda a ser usada
    const scheduleId = config.scheduleId;
    if (!scheduleId) {
      return {
        status: "error",
        message: "No schedule configured for this action."
      };
    }
    
    console.log(`[processCheckScheduleAction] Operação: ${operation}, Data: ${date}, Hora: ${time}, Serviço: ${serviceId}, Agenda: ${scheduleId}`);
    
    // Obter o timezone da agenda
    const { data: scheduleData } = await supabase
      .from('schedules')
      .select('timezone, title')
      .eq('id', scheduleId)
      .single();
    
    const timezone = scheduleData?.timezone || 'America/Sao_Paulo';
    const scheduleName = scheduleData?.title || 'Agenda';
    
    // Buscar informações do serviço se fornecido
    let serviceName = "Serviço não especificado";
    let serviceInfo = null;
    
    if (serviceId) {
      const { data: service } = await supabase
        .from('schedule_services')
        .select('title, by_arrival_time, capacity')
        .eq('id', serviceId)
        .single();
        
      if (service) {
        serviceName = service.title;
        serviceInfo = service;
      }
    }
    
    // Executar a operação apropriada
    let result;
    
    switch (operation) {
      case 'checkAvailability':
        // Verificar disponibilidade de horários
        result = await checkAvailability(scheduleId, date, time, serviceId, timezone);
        break;
        
      case 'createAppointment':
        // Validar parâmetros necessários
        if (!date || !serviceId) {
          const missingParams = [];
          if (!date) missingParams.push('date');
          if (!serviceId) missingParams.push('service_id');
          
          return {
            status: "error",
            message: `Missing required parameters: ${missingParams.join(', ')}`
          };
        }
        
        // Criar agendamento
        result = await createAppointment(scheduleId, session.customer_id, date, time, serviceId, notes, providerId, timezone, session);
        break;
        
      case 'checkAppointment':
        // Consultar agendamentos
        result = await checkAppointment(session.customer_id, appointmentId, scheduleId);
        break;
        
      case 'deleteAppointment':
        // Validar parâmetros necessários
        if (!appointmentId && !date) {
          return {
            status: "error",
            message: "Either appointment_id or date is required to cancel appointments."
          };
        }
        
        // Cancelar agendamento
        result = await deleteAppointment(appointmentId, session.customer_id, date, scheduleId);
        break;
        
      default:
        return {
          status: "error",
          message: `Unsupported operation: ${operation}`
        };
    }
    
    // Adicionar informações de contexto ao resultado
    const enrichedResult = {
      ...result,
      status: result.success ? "success" : "error",
      operation: operation,
      data: {
        ...result,
        service_name: serviceName,
        schedule_name: scheduleName,
        appointment_date: date,
        appointment_time: time,
        timezone: timezone
      }
    };
    
    return enrichedResult;
    
  } catch (error) {
    console.error('[processCheckScheduleAction] Error:', error);
    Sentry.captureException(error);
    return {
      status: "error",
      message: `Error processing schedule action: ${error.message}`
    };
  }
};

/**
 * Verifica disponibilidade de horários
 * @param {string} scheduleId - ID da agenda
 * @param {string} date - Data para verificação
 * @param {string} time - Horário específico (opcional)
 * @param {string} serviceId - ID do serviço
 * @param {string} timezone - Timezone da agenda
 * @returns {Promise<Object>} - Resultado da verificação
 */
const checkAvailability = async (scheduleId, date, time, serviceId, timezone) => {
  try {
    // Verificar se a agenda existe
    const { data: schedule, error: scheduleError } = await supabase
      .from('schedules')
      .select('*')
      .eq('id', scheduleId)
      .single();
      
    if (scheduleError || !schedule) {
      return {
        success: false,
        message: `Schedule not found with ID ${scheduleId}`
      };
    }
    
    // Buscar informações do serviço se fornecido
    let serviceName = "Service not specified";
    let serviceDuration = 30; // Duração padrão em minutos
    let isByArrivalTime = false;
    
    if (serviceId) {
      const { data: service } = await supabase
        .from('schedule_services')
        .select('title, duration, by_arrival_time')
        .eq('id', serviceId)
        .single();
        
      if (service) {
        serviceName = service.title;
        isByArrivalTime = service.by_arrival_time || false;
        
        // Converter duração para minutos
        try {
          const durationParts = service.duration.toString().split(':');
          serviceDuration = parseInt(durationParts[0]) * 60 + parseInt(durationParts[1]);
        } catch (e) {
          console.warn(`Erro ao converter duração: ${service.duration}`, e);
        }
      }
    }
    
    // Formatar data para exibição
    const formattedDate = new Date(date).toLocaleDateString('pt-BR');
    
    // Buscar horários disponíveis
    const availableSlots = await getAvailableSlots(scheduleId, date, serviceId, serviceDuration, isByArrivalTime);
    
    // Se não foi especificado um horário, retornar todos os slots disponíveis
    if (!time) {
      return {
        success: true,
        available: availableSlots.length > 0,
        date: date,
        formatted_date: formattedDate,
        available_times: availableSlots,
        message: availableSlots.length > 0
          ? `${availableSlots.length} time slots available on ${formattedDate}`
          : `No available slots on ${formattedDate}`
      };
    }
    
    // Verificar se o horário específico está disponível
    const isAvailable = availableSlots.includes(time);
    
    return {
      success: true,
      available: isAvailable,
      date: date,
      formatted_date: formattedDate,
      requested_time: time,
      available_times: availableSlots,
      message: isAvailable
        ? `Slot available on ${formattedDate} at ${time}`
        : `No availability on ${formattedDate} at ${time}`
    };
  } catch (error) {
    console.error('[checkAvailability] Error:', error);
    Sentry.captureException(error);
    return {
      success: false,
      message: `Error checking availability: ${error.message}`
    };
  }
};

/**
 * Função simplificada para obter slots disponíveis
 * @param {string} scheduleId - ID da agenda
 * @param {string} date - Data para verificação
 * @param {string} serviceId - ID do serviço
 * @param {number} duration - Duração do serviço em minutos
 * @param {boolean} isByArrivalTime - Se é por ordem de chegada
 * @returns {Promise<Array>} - Lista de horários disponíveis
 */
const getAvailableSlots = async (scheduleId, date, serviceId, duration = 30, isByArrivalTime = false) => {
  // Implementação simplificada que consulta agendamentos existentes e horários de disponibilidade
  try {
    // Obter todos os providers ativos para esta agenda
    const { data: providers } = await supabase
      .from('schedule_providers')
      .select('id, profile_id')
      .eq('schedule_id', scheduleId)
      .eq('status', 'active');
    
    if (!providers || providers.length === 0) {
      return [];
    }
    
    // Calcular o dia da semana (0-6, onde 0 é domingo)
    const dateObj = new Date(`${date}T12:00:00Z`);
    const dayOfWeek = dateObj.getDay();
    
    // Buscar disponibilidade para o dia da semana
    const { data: availabilities } = await supabase
      .from('schedule_availability')
      .select('provider_id, start_time, end_time')
      .in('provider_id', providers.map(p => p.id))
      .eq('day_of_week', dayOfWeek);
    
    if (!availabilities || availabilities.length === 0) {
      return [];
    }
    
    // Buscar agendamentos existentes para a data
    const { data: existingAppointments } = await supabase
      .from('appointments')
      .select('provider_id, start_time, end_time')
      .eq('schedule_id', scheduleId)
      .eq('date', date)
      .not('status', 'in', '(canceled)');
    
    // Horários de início e fim das disponibilidades
    const allSlots = [];
    
    // Para cada disponibilidade, gerar slots possíveis
    availabilities.forEach(availability => {
      const startMinutes = timeToMinutes(availability.start_time);
      const endMinutes = timeToMinutes(availability.end_time);
      
      // Define o intervalo de slot com base na configuração ou usa 30 minutos como padrão
      const slotInterval = 30;
      
      // Gerar todos os slots possíveis
      for (let slot = startMinutes; slot <= endMinutes - duration; slot += slotInterval) {
        const slotTime = minutesToTime(slot);
        
        // Verificar se o slot já está ocupado
        const isOccupied = existingAppointments?.some(apt => {
          const aptStart = timeToMinutes(apt.start_time);
          const aptEnd = timeToMinutes(apt.end_time);
          return aptStart <= slot && aptEnd > slot;
        });
        
        if (!isOccupied && !allSlots.includes(slotTime)) {
          allSlots.push(slotTime);
        }
      }
    });
    
    // Ordenar e retornar os slots disponíveis
    return allSlots.sort();
  } catch (error) {
    console.error('[getAvailableSlots] Error:', error);
    Sentry.captureException(error);
    return [];
  }
};

/**
 * Cria um novo agendamento
 * @param {string} scheduleId - ID da agenda
 * @param {string} customerId - ID do cliente
 * @param {string} date - Data do agendamento
 * @param {string} time - Hora do agendamento
 * @param {string} serviceId - ID do serviço
 * @param {string} notes - Observações
 * @param {string} providerId - ID do profissional (opcional)
 * @param {string} timezone - Timezone da agenda
 * @param {Object} session - Sessão atual
 * @returns {Promise<Object>} - Resultado da criação
 */
const createAppointment = async (scheduleId, customerId, date, time, serviceId, notes, providerId, timezone, session) => {
  try {
    // Verificar se o horário está disponível
    const availabilityCheck = await checkAvailability(scheduleId, date, time, serviceId, timezone);
    
    if (!availabilityCheck.available) {
      return {
        success: false,
        message: `The requested time slot is not available. Available times: ${availabilityCheck.available_times.join(', ')}`
      };
    }

    if(!time){
      return {
        success: false,
        message: `Appointment time is required`
      };
    }
    
    // Buscar informações do serviço
    const { data: serviceData } = await supabase
      .from('schedule_services')
      .select('title, duration, by_arrival_time')
      .eq('id', serviceId)
      .single();
    
    if (!serviceData) {
      return {
        success: false,
        message: `Service not found with ID ${serviceId}`
      };
    }
    
    // Calcular horário de término
    let endTime = time;
    try {
      const durationParts = serviceData.duration.toString().split(':');
      const durationMinutes = parseInt(durationParts[0]) * 60 + parseInt(durationParts[1]);
      
      const [hours, minutes] = time.split(':').map(Number);
      const startMinutes = hours * 60 + minutes;
      const endMinutes = startMinutes + durationMinutes;
      
      const endHours = Math.floor(endMinutes / 60);
      const endMins = endMinutes % 60;
      
      endTime = `${endHours.toString().padStart(2, '0')}:${endMins.toString().padStart(2, '0')}`;
    } catch (e) {
      console.warn(`Erro ao calcular horário de término`, e);
    }
    
    // Se não foi especificado um profissional, encontrar um disponível
    let selectedProviderId = providerId;
    if (!selectedProviderId) {
      const { data: availableProvider } = await supabase
        .from('schedule_providers')
        .select('profile_id')
        .eq('schedule_id', scheduleId)
        .eq('status', 'active')
        .limit(1)
        .single();
      
      if (availableProvider) {
        selectedProviderId = availableProvider.profile_id;
      }
    }
    
    // Criar o agendamento
    const { data: appointment, error } = await supabase
      .from('appointments')
      .insert({
        schedule_id: scheduleId,
        customer_id: customerId,
        provider_id: selectedProviderId,
        service_id: serviceId,
        date: date,
        start_time: time,
        end_time: endTime,
        status: 'scheduled',
        notes: notes || '',
        chat_id: session.chat_id,
        organization_id: session.organization_id,
        metadata: {
          created_via: 'agent_ia_action',
          creation_date: new Date().toISOString()
        }
      })
      .select()
      .single();
    
    if (error) {
      throw error;
    }
    
    // Formatar a data para exibição
    const formattedDate = new Date(date).toLocaleDateString('pt-BR');
    
    return {
      success: true,
      appointment_id: appointment.id,
      date: date,
      formatted_date: formattedDate,
      time: time,
      end_time: endTime,
      service_id: serviceId,
      service_name: serviceData.title,
      message: `Appointment successfully created for ${formattedDate} at ${time}`
    };
  } catch (error) {
    console.error('[createAppointment] Error:', error);
    Sentry.captureException(error);
    return {
      success: false,
      message: `Error creating appointment: ${error.message}`
    };
  }
};

/**
 * Verifica agendamentos de um cliente
 * @param {string} customerId - ID do cliente
 * @param {string} appointmentId - ID do agendamento específico (opcional)
 * @param {string} scheduleId - ID da agenda (opcional)
 * @returns {Promise<Object>} - Resultado da verificação
 */
const checkAppointment = async (customerId, appointmentId, scheduleId) => {
  try {
    // Construir a consulta base
    let query = supabase
      .from('appointments')
      .select(`
        id, 
        date, 
        start_time, 
        end_time, 
        status,
        schedule_id,
        service_id,
        schedules(title),
        schedule_services(title)
      `)
      .eq('customer_id', customerId)
      .in('status', ['scheduled', 'confirmed']);
    
    // Filtrar por agenda se especificado
    if (scheduleId) {
      query = query.eq('schedule_id', scheduleId);
    }
    
    // Filtrar por ID específico se fornecido
    if (appointmentId) {
      query = query.eq('id', appointmentId);
    }
    
    // Ordenar por data e hora
    query = query.order('date', { ascending: true })
                .order('start_time', { ascending: true });
    
    // Executar a consulta
    const { data, error } = await query;
    
    if (error) {
      throw error;
    }
    
    // Formatar os resultados
    const appointments = (data || []).map(apt => ({
      id: apt.id,
      date: apt.date,
      formatted_date: new Date(apt.date).toLocaleDateString('pt-BR'),
      time: apt.start_time,
      end_time: apt.end_time,
      status: apt.status,
      schedule_name: apt.schedules?.title || 'Agenda não especificada',
      service_name: apt.schedule_services?.title || 'Serviço não especificado'
    }));
    
    return {
      success: true,
      appointments: appointments,
      count: appointments.length,
      message: appointments.length > 0
        ? `Found ${appointments.length} appointment(s)`
        : "No appointments found"
    };
  } catch (error) {
    console.error('[checkAppointment] Error:', error);
    Sentry.captureException(error);
    return {
      success: false,
      message: `Error checking appointments: ${error.message}`
    };
  }
};

/**
 * Cancela um agendamento
 * @param {string} appointmentId - ID do agendamento
 * @param {string} customerId - ID do cliente
 * @param {string} date - Data para cancelar todos os agendamentos
 * @param {string} scheduleId - ID da agenda (opcional)
 * @returns {Promise<Object>} - Resultado do cancelamento
 */
const deleteAppointment = async (appointmentId, customerId, date, scheduleId) => {
  try {
    // Se temos um ID específico
    if (appointmentId) {
      // Verificar se o agendamento existe e pertence ao cliente
      const { data: appointment, error: fetchError } = await supabase
        .from('appointments')
        .select('*')
        .eq('id', appointmentId)
        .eq('customer_id', customerId)
        .in('status', ['scheduled', 'confirmed'])
        .single();
      
      if (fetchError) {
        return {
          success: false,
          message: `Appointment not found with ID ${appointmentId} or it doesn't belong to this customer`
        };
      }
      
      // Cancelar o agendamento
      const { error: updateError } = await supabase
        .from('appointments')
        .update({ 
          status: 'canceled',
          metadata: {
            ...appointment.metadata,
            canceled_at: new Date().toISOString(),
            canceled_via: 'agent_ia_action'
          }
        })
        .eq('id', appointmentId);
      
      if (updateError) {
        throw updateError;
      }
      
      // Formatar a data para exibição
      const formattedDate = new Date(appointment.date).toLocaleDateString('pt-BR');
      
      return {
        success: true,
        appointment_id: appointmentId,
        date: appointment.date,
        formatted_date: formattedDate,
        time: appointment.start_time,
        message: `Appointment successfully canceled for ${formattedDate} at ${appointment.start_time}`
      };
    }
    
    // Se temos uma data para cancelar todos os agendamentos
    if (date) {
      // Construir a consulta
      let query = supabase
        .from('appointments')
        .select('*')
        .eq('customer_id', customerId)
        .eq('date', date)
        .in('status', ['scheduled', 'confirmed']);
      
      // Filtrar por agenda se especificado
      if (scheduleId) {
        query = query.eq('schedule_id', scheduleId);
      }
      
      // Executar a consulta
      const { data: appointments, error: searchError } = await query;
      
      if (searchError) {
        throw searchError;
      }
      
      if (!appointments || appointments.length === 0) {
        return {
          success: false,
          message: `No appointments found for date ${date}`
        };
      }
      
      // Cancelar todos os agendamentos encontrados
      let canceledCount = 0;
      const canceledAppointments = [];
      
      for (const appointment of appointments) {
        const { error: updateError } = await supabase
          .from('appointments')
          .update({
            status: 'canceled',
            metadata: {
              ...appointment.metadata,
              canceled_at: new Date().toISOString(),
              canceled_via: 'agent_ia_action'
            }
          })
          .eq('id', appointment.id);
        
        if (!updateError) {
          canceledCount++;
          canceledAppointments.push({
            id: appointment.id,
            date: appointment.date,
            time: appointment.start_time
          });
        }
      }
      
      // Formatar a data para exibição
      const formattedDate = new Date(date).toLocaleDateString('pt-BR');
      
      return {
        success: true,
        canceled_count: canceledCount,
        canceled_appointments: canceledAppointments,
        date: date,
        formatted_date: formattedDate,
        message: `Successfully canceled ${canceledCount} appointment(s) for ${formattedDate}`
      };
    }
    
    return {
      success: false,
      message: "Either appointment_id or date is required to cancel appointments"
    };
  } catch (error) {
    console.error('[deleteAppointment] Error:', error);
    Sentry.captureException(error);
    return {
      success: false,
      message: `Error canceling appointment: ${error.message}`
    };
  }
};

/**
 * Helper para converter tempo HH:MM para minutos desde meia-noite
 * @param {string} timeStr - Horário no formato HH:MM
 * @returns {number} - Minutos desde meia-noite
 */
const timeToMinutes = (timeStr) => {
  if (!timeStr) return 0;
  const [hours, minutes] = timeStr.split(':').map(Number);
  return hours * 60 + minutes;
};

/**
 * Helper para converter minutos desde meia-noite para formato HH:MM
 * @param {number} minutes - Minutos desde meia-noite
 * @returns {string} - Horário no formato HH:MM
 */
const minutesToTime = (minutes) => {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
};

/**
 * Gera a ferramenta para atualizar campos personalizados do cliente
 * @param {string} organizationId - ID da organização
 * @param {Object} action - Ação associada à ferramenta
 * @returns {Promise<Object>} - Ferramenta de atualização de campos personalizados
 */
const generateUpdateCustomerCustomDataTool = async (organizationId, action) => {
  try {
    // Verificar se há campos personalizados configurados
    if (!action.config.customFields || action.config.customFields.length === 0) {
      console.log(`[generateUpdateCustomerCustomDataTool] Nenhum campo personalizado configurado para a ação ${action.name}`);
      return null;
    }

    // Buscar os campos personalizados selecionados
    const customFieldIds = action.config.customFields.map(field => field.id);
    
    const { data: customFields, error } = await supabase
      .from('custom_fields_definition')
      .select('id, name, type, options, mask_type, custom_mask, description, slug')
      .eq('organization_id', organizationId)
      .in('id', customFieldIds);
    
    if (error) {
      console.error(`[generateUpdateCustomerCustomDataTool] Erro ao buscar campos personalizados:`, error);
      return null;
    }
    
    if (!customFields || customFields.length === 0) {
      console.log(`[generateUpdateCustomerCustomDataTool] Nenhum campo personalizado encontrado para a organização ${organizationId}`);
      return null;
    }

    // Usar o nome e a descrição da ação configurada ou usar padrões
    const toolName = transformToolName(action.name || "update_customer_custom_data");
    const toolDescription = action.description || 
      "Update custom customer fields such as " + customFields.map(field => field.name).join(", ") + ".";
    
    // Construir propriedades para cada campo personalizado
    const properties = {};
    const required = [];

    // Criar um mapeamento de slug para id
    const slugToIdMap = {};

    for (const field of customFields) {
      // Verificar se o campo tem slug, caso contrário usar o ID
      const slug = field.slug || field.id;
      slugToIdMap[slug] = field.id;

      let description = field.description || `Value for field "${field.name}"`;
      
      // Propriedades básicas
      const property = {
        type: "string",
        description: description
      };
      
      // Personalizar com base no tipo do campo
      switch (field.type) {
        case 'text':
          // Adicionar instruções para máscaras se necessário
          if (field.mask_type) {
            switch (field.mask_type) {
              case 'cpf':
                property.description += ". Format: 123.456.789-01";
                break;
              case 'cnpj':
                property.description += ". Format: 12.345.678/0001-90";
                break;
              case 'phone':
                property.description += ". Format: (00) 00000-0000";
                break;
              case 'cep':
                property.description += ". Format: 00000-000";
                break;
              case 'rg':
                property.description += ". Format: 00.000.000-0";
                break;
              case 'custom':
                if (field.custom_mask) {
                  property.description += `. Custom format: ${field.custom_mask}`;
                }
                break;
            }
          }
          break;
        case 'number':
          property.type = "number";
          property.description += ". Must be a numeric value.";
          break;
        case 'date':
          property.description += ". Format: YYYY-MM-DD (e.g. 2023-12-31)";
          break;
        case 'datetime':
          property.description += ". Format: YYYY-MM-DD HH:MM (e.g. 2023-12-31 14:30)";
          break;
        case 'select':
          if (field.options && field.options.length > 0) {
            property.enum = field.options;
            property.description += `. Allowed values: ${field.options.join(", ")}`;
          }
          break;
      }
      
      // Adicionar à lista de propriedades
      properties[slug] = property;
      
      // Todos os campos são obrigatórios
      required.push(slug);
    }
    
    // Construir a ferramenta
    return {
      name: toolName,
      description: toolDescription,
      parameters: {
        type: "object",
        properties: properties,
        required: required
      },
      // Guardar o mapeamento de slugs para ids no objeto da ferramenta para uso posterior
      _metadata: {
        slugToIdMap: slugToIdMap
      }
    };
  } catch (error) {
    console.error(`[generateUpdateCustomerCustomDataTool] Erro ao gerar ferramenta de atualização de campos personalizados:`, error);
    Sentry.captureException(error);
    return null;
  }
};

/**
 * Gera a ferramenta para transferir para equipe
 * @param {string} organizationId - ID da organização
 * @param {Object} action - Ação associada à ferramenta
 * @returns {Promise<Object>} - Ferramenta de transferência para equipe
 */
const generateTransferToTeamTool = async (organizationId, action) => {
  try {
    // Buscar todas as equipes de serviço ativas da organização
    const { data: serviceTeams, error } = await supabase
      .from('service_teams')
      .select('id, name')
      .eq('organization_id', organizationId);
    
    if (error) {
      console.error(`[generateTransferToTeamTool] Erro ao buscar equipes:`, error);
      return null;
    }
    
    if (!serviceTeams || serviceTeams.length === 0) {
      console.log(`[generateTransferToTeamTool] Nenhuma equipe encontrada para a organização ${organizationId}`);
      return null;
    }
    
    // Usar o nome e a descrição da ação configurada ou usar padrões
    const toolName = transformToolName(action.name || "transfer_to_team");
    const toolDescription = action.description || 
      "Transfer the chat to a specific team for better support.";

    console.log(`[generateTransferToTeamTool] Equipes encontradas:`, serviceTeams);
    
    // Construir a ferramenta
    return {
      name: toolName,
      description: toolDescription,
      parameters: {
        type: "object",
        properties: {
          team_name: {
            type: "string",
            enum: serviceTeams.map(team => team.name),
            description: "Name of the team to transfer the chat to."
          }
        },
        required: ["team_name"]
      }
    };
  } catch (error) {
    console.error(`[generateTransferToTeamTool] Erro ao gerar ferramenta de transferência para equipe:`, error);
    Sentry.captureException(error);
    return null;
  }
};

/**
 * Gera a ferramenta para alterar o funil do cliente
 * @param {string} organizationId - ID da organização
 * @param {Object} action - Ação associada à ferramenta
 * @param {Object} customer - Cliente atual da sessão
 * @returns {Promise<Object>} - Ferramenta de alteração de funil
 */
const generateChangeFunnelTool = async (organizationId, action, customer = null) => {
  try {
    // Verificar se há estágios de destino configurados
    if (!action.config.targetStages || action.config.targetStages.length === 0) {
      console.log(`[generateChangeFunnelTool] Nenhum estágio de destino configurado para a ação ${action.name}`);
      return null;
    }

    // Verificar se há estágios de origem configurados
    if (!action.config.sourceStages || action.config.sourceStages.length === 0) {
      console.log(`[generateChangeFunnelTool] Nenhum estágio de origem configurado para a ação ${action.name}`);
      return null;
    }

    //Verificar se o cliente está em algum estágio de origem configurado, se não estiver, retornar null
    if (customer && customer.stage_id) {
      const isInSourceStage = action.config.sourceStages.some(stage => stage.id === customer.stage_id);
      if (!isInSourceStage) {
        console.log(`[generateChangeFunnelTool] O cliente não está em um estágio de origem configurado para a ação ${action.name}`);
        return null;
      }
    } else {
      console.log(`[generateChangeFunnelTool] Não foi possível verificar se o cliente está em um estágio de origem configurado para a ação ${action.name}`);
      return null;
    }

    // Buscar o cliente atual da sessão (se existir)
    const targetStages = action.config.targetStages;
    
    // Usar o nome e a descrição da ação configurada ou usar padrões
    const toolName = action.name || "change_funnel";
    const toolDescription = action.description || 
      "Change the customer's funnel to a specific stage.";
    
    // Criar enum com os nomes dos estágios de destino disponíveis
    const stageEnum = [];
    
    // Criar descrição detalhada dos estágios disponíveis
    let stageDescriptionText = "Available stages:\n";
    
    for (const stage of targetStages) {
      if (stage.id && stage.name) {
        const stageName = stage.name;
        stageEnum.push(stageName);
        
        // Adicionar estágio à descrição
        stageDescriptionText += `- ${stageName}`;
        if (stage.description) {
          stageDescriptionText += `: ${stage.description}`;
        }
        if (stage.funnelName) {
          stageDescriptionText += ` (${stage.funnelName})`;
        }
        stageDescriptionText += "\n";
      }
    }
    
    // Se não houver estágios disponíveis, não criar a ferramenta
    if (stageEnum.length === 0) {
      console.log(`[generateChangeFunnelTool] Nenhum estágio de destino válido encontrado para a ação ${action.name}`);
      return null;
    }
    
    // Construir a ferramenta para alteração de funil
    const tool = {
      name: toolName,
      description: toolDescription,
      parameters: {
        type: "object",
        properties: {
          target_stage: {
            type: "string",
            enum: stageEnum,
            description: `Name of the destination stage to where the customer will be moved. ${stageDescriptionText}`
          }
        },
        required: ["target_stage"]
      }
    };
    
    return tool;
  } catch (error) {
    console.error(`[generateChangeFunnelTool] Erro ao gerar ferramenta de alteração de funil:`, error);
    Sentry.captureException(error);
    return null;
  }
};

/**
 * Gera a ferramenta para processar respostas para perguntas desconhecidas pelo agente IA
 * @param {string} organizationId - ID da organização
 * @param {Object} action - Ação associada à ferramenta
 * @returns {Object} - Ferramenta de resposta desconhecida
 */
const generateUnknownResponseTool = (organizationId, action) => {
  try {
    // Usar o nome e a descrição da ação configurada ou usar padrões
    const toolName = transformToolName(action.name || "unknown_response");
    const toolDescription = action.description || 
      "Use this tool when the information requested by the user is not available in the provided context or knowledge base. This will record the question for review and possible addition to the knowledge base.";
    
    // Extrair configurações da ação se existirem
    const config = action.config?.unknownResponse || {};
    
    // Construir a ferramenta para resposta desconhecida
    return {
      name: toolName,
      description: toolDescription,
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "The original question that cannot be answered with the information available in the current context."
          },
          content: {
            type: "string",
            description: "The information that is missing from the context or needs to be added to the knowledge base."
          },
          category: {
            type: "string",
            description: "Optional category for the missing information (e.g., 'product', 'technical', 'process')."
          },
          priority: {
            type: "string",
            enum: ["high", "medium", "low"],
            description: "Priority of this knowledge gap (default: medium)."
          },
          notes: {
            type: "string",
            description: "Optional notes or additional context about why this information is needed or is missing."
          }
        },
        required: ["question", "content"]
      },
      // Passar as configurações do usuário para o objeto da ferramenta
      _config: config
    };
  } catch (error) {
    console.error(`[generateUnknownResponseTool] Erro ao gerar ferramenta de resposta desconhecida:`, error);
    Sentry.captureException(error);
    return null;
  }
};

/**
 * Exporta funções para uso em outros módulos
 */
export {
  clearCacheItem,
  clearOrganizationCache,
  clearAllCache,
  nameToIdCache,
  getCachedMap,
  setCachedMap,
  createNameToIdMap,
  processCheckScheduleAction
};