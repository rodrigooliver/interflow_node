import express from 'express';
import { verifyAuth } from '../middleware/auth.js';
import { 
  nameToIdCache, 
  clearCacheItem, 
  clearOrganizationCache, 
  clearAllCache,
  createNameToIdMap,
  getCachedMap,
  setCachedMap
} from '../services/agent-ia-actions.js';
import { supabase } from '../lib/supabase.js';

const router = express.Router({ mergeParams: true });

// Todas as rotas precisam de autenticação
router.use(verifyAuth);

/**
 * @route GET /api/:organizationId/agent-ia/cache
 * @desc Obter informações sobre o cache
 * @access Private
 */
router.get('/cache', (req, res) => {
  const { organizationId } = req.params;
  
  // Se organizationId for fornecido, retorna apenas o cache dessa organização
  if (organizationId && nameToIdCache[organizationId]) {
    return res.json({
      success: true,
      cache: {
        [organizationId]: nameToIdCache[organizationId]
      },
      stats: {
        services: countCacheItems(nameToIdCache[organizationId], 'services'),
        providers: countCacheItems(nameToIdCache[organizationId], 'providers'),
        teams: countCacheItems(nameToIdCache[organizationId], 'teams', true),
        flows: countCacheItems(nameToIdCache[organizationId], 'flows', true)
      }
    });
  }
  
  // Se organizationId não for fornecido ou não houver cache para essa organização,
  // retorna estatísticas gerais do cache
  const stats = {
    organizations: Object.keys(nameToIdCache).length,
    totalItems: countTotalCacheItems(nameToIdCache)
  };
  
  return res.json({
    success: true,
    stats
  });
});

/**
 * @route DELETE /api/:organizationId/agent-ia/cache
 * @desc Limpar todo o cache de uma organização
 * @access Private
 */
router.delete('/cache', (req, res) => {
  const { organizationId } = req.params;
  
  clearOrganizationCache(organizationId);
  
  return res.json({
    success: true,
    message: `Cache limpo para a organização ${organizationId}`
  });
});

/**
 * @route DELETE /api/:organizationId/agent-ia/cache/:type
 * @desc Limpar um tipo específico de cache de uma organização
 * @access Private
 */
router.delete('/cache/:type', (req, res) => {
  const { organizationId, type } = req.params;
  const { subKey } = req.query;
  
  if (!['services', 'providers', 'teams', 'flows'].includes(type)) {
    return res.status(400).json({
      success: false,
      message: `Tipo de cache inválido: ${type}`
    });
  }
  
  clearCacheItem(organizationId, type, subKey);
  
  return res.json({
    success: true,
    message: `Cache de ${type} limpo para a organização ${organizationId}${subKey ? ` e agenda ${subKey}` : ''}`
  });
});

/**
 * @route DELETE /api/agent-ia/cache/all
 * @desc Limpar todo o cache global (rota especial sem organizationId)
 * @access Private (admin only)
 */
router.delete('/all-cache', (req, res) => {
  clearAllCache();
  
  return res.json({
    success: true,
    message: 'Cache global limpo'
  });
});

/**
 * Conta o número de itens em um tipo de cache
 * @param {Object} organizationCache - Cache da organização
 * @param {string} type - Tipo de cache (services, providers, teams, flows)
 * @param {boolean} isFlat - Se o cache é plano (não tem subkeys)
 * @returns {number} - Número de itens
 */
function countCacheItems(organizationCache, type, isFlat = false) {
  if (!organizationCache || !organizationCache[type]) return 0;
  
  if (isFlat) {
    // Para teams e flows, que não têm subkeys
    const cache = organizationCache[type];
    return cache && cache.data ? Object.keys(cache.data).length : 0;
  } else {
    // Para services e providers, que têm subkeys (scheduleId)
    const typeCache = organizationCache[type];
    let count = 0;
    
    Object.keys(typeCache).forEach(scheduleId => {
      const scheduleCache = typeCache[scheduleId];
      if (scheduleCache && scheduleCache.data) {
        count += Object.keys(scheduleCache.data).length;
      }
    });
    
    return count;
  }
}

/**
 * Conta o número total de itens no cache
 * @param {Object} cache - Cache global
 * @returns {number} - Número total de itens
 */
function countTotalCacheItems(cache) {
  let total = 0;
  
  Object.keys(cache).forEach(organizationId => {
    const organizationCache = cache[organizationId];
    
    total += countCacheItems(organizationCache, 'services');
    total += countCacheItems(organizationCache, 'providers');
    total += countCacheItems(organizationCache, 'teams', true);
    total += countCacheItems(organizationCache, 'flows', true);
  });
  
  return total;
}

/**
 * @route POST /api/:organizationId/agent-ia/map/service
 * @desc Mapear nome do serviço para ID
 * @access Private
 */
router.post('/map/service', async (req, res) => {
  try {
    const { organizationId } = req.params;
    const { serviceName, scheduleId, forceRefresh = false } = req.body;
    
    if (!serviceName) {
      return res.status(400).json({
        success: false,
        message: 'Nome do serviço não fornecido'
      });
    }
    
    if (!scheduleId) {
      return res.status(400).json({
        success: false,
        message: 'ID da agenda não fornecido'
      });
    }
    
    // Verificar se existe no cache e não foi solicitado refresh
    if (!forceRefresh) {
      const serviceMap = getCachedMap(organizationId, 'services', scheduleId);
      if (serviceMap) {
        const serviceId = serviceMap[serviceName.toLowerCase()];
        if (serviceId) {
          return res.json({
            success: true,
            source: 'cache',
            mapping: {
              name: serviceName,
              id: serviceId
            }
          });
        }
      }
    }
    
    // Se não estiver no cache ou foi solicitado refresh, buscar do banco
    const { data: services, error } = await supabase
      .from('schedule_services')
      .select('id, title')
      .eq('schedule_id', scheduleId)
      .eq('status', 'active');
    
    if (error) {
      console.error(`[mapService] Erro ao buscar serviços:`, error);
      return res.status(500).json({
        success: false,
        message: 'Erro ao buscar serviços',
        error: error.message
      });
    }
    
    if (!services || services.length === 0) {
      return res.status(404).json({
        success: false,
        message: `Nenhum serviço encontrado para a agenda ${scheduleId}`
      });
    }
    
    // Criar e armazenar o mapa no cache
    const serviceMap = createNameToIdMap(services, 'title', 'id');
    setCachedMap(organizationId, 'services', serviceMap, scheduleId);
    
    const serviceId = serviceMap[serviceName.toLowerCase()];
    if (!serviceId) {
      return res.status(404).json({
        success: false,
        message: `Serviço "${serviceName}" não encontrado`
      });
    }
    
    return res.json({
      success: true,
      source: 'database',
      mapping: {
        name: serviceName,
        id: serviceId
      },
      allServices: services.map(service => ({
        name: service.title,
        id: service.id
      }))
    });
  } catch (error) {
    console.error(`[mapService] Erro ao mapear serviço:`, error);
    return res.status(500).json({
      success: false,
      message: 'Erro interno ao mapear serviço',
      error: error.message
    });
  }
});

/**
 * @route POST /api/:organizationId/agent-ia/map/provider
 * @desc Mapear nome do profissional para ID
 * @access Private
 */
router.post('/map/provider', async (req, res) => {
  try {
    const { organizationId } = req.params;
    const { providerName, scheduleId, forceRefresh = false } = req.body;
    
    if (!providerName) {
      return res.status(400).json({
        success: false,
        message: 'Nome do profissional não fornecido'
      });
    }
    
    if (!scheduleId) {
      return res.status(400).json({
        success: false,
        message: 'ID da agenda não fornecido'
      });
    }
    
    // Verificar se existe no cache e não foi solicitado refresh
    if (!forceRefresh) {
      const providerMap = getCachedMap(organizationId, 'providers', scheduleId);
      if (providerMap) {
        const providerId = providerMap[providerName.toLowerCase()];
        if (providerId) {
          return res.json({
            success: true,
            source: 'cache',
            mapping: {
              name: providerName,
              id: providerId
            }
          });
        }
      }
    }
    
    // Se não estiver no cache ou foi solicitado refresh, buscar do banco
    const { data: providers, error } = await supabase
      .from('schedule_providers')
      .select(`
        id,
        profiles(id, full_name)
      `)
      .eq('schedule_id', scheduleId)
      .eq('status', 'active');
    
    if (error) {
      console.error(`[mapProvider] Erro ao buscar profissionais:`, error);
      return res.status(500).json({
        success: false,
        message: 'Erro ao buscar profissionais',
        error: error.message
      });
    }
    
    if (!providers || providers.length === 0) {
      return res.status(404).json({
        success: false,
        message: `Nenhum profissional encontrado para a agenda ${scheduleId}`
      });
    }
    
    // Criar e armazenar o mapa no cache
    const providerMap = createNameToIdMap(providers.map(p => p.profiles), 'full_name', 'id');
    setCachedMap(organizationId, 'providers', providerMap, scheduleId);
    
    const providerId = providerMap[providerName.toLowerCase()];
    if (!providerId) {
      return res.status(404).json({
        success: false,
        message: `Profissional "${providerName}" não encontrado`
      });
    }
    
    return res.json({
      success: true,
      source: 'database',
      mapping: {
        name: providerName,
        id: providerId
      },
      allProviders: providers
        .filter(provider => provider.profiles && provider.profiles.full_name)
        .map(provider => ({
          name: provider.profiles.full_name,
          id: provider.profiles.id
        }))
    });
  } catch (error) {
    console.error(`[mapProvider] Erro ao mapear profissional:`, error);
    return res.status(500).json({
      success: false,
      message: 'Erro interno ao mapear profissional',
      error: error.message
    });
  }
});

/**
 * @route POST /api/:organizationId/agent-ia/map/team
 * @desc Mapear nome da equipe para ID
 * @access Private
 */
router.post('/map/team', async (req, res) => {
  try {
    const { organizationId } = req.params;
    const { teamName, forceRefresh = false } = req.body;
    
    if (!teamName) {
      return res.status(400).json({
        success: false,
        message: 'Nome da equipe não fornecido'
      });
    }
    
    // Verificar se existe no cache e não foi solicitado refresh
    if (!forceRefresh) {
      const teamMap = getCachedMap(organizationId, 'teams');
      if (teamMap) {
        const teamId = teamMap[teamName.toLowerCase()];
        if (teamId) {
          return res.json({
            success: true,
            source: 'cache',
            mapping: {
              name: teamName,
              id: teamId
            }
          });
        }
      }
    }
    
    // Se não estiver no cache ou foi solicitado refresh, buscar do banco
    const { data: teams, error } = await supabase
      .from('teams')
      .select('id, name')
      .eq('organization_id', organizationId);
    
    if (error) {
      console.error(`[mapTeam] Erro ao buscar equipes:`, error);
      return res.status(500).json({
        success: false,
        message: 'Erro ao buscar equipes',
        error: error.message
      });
    }
    
    if (!teams || teams.length === 0) {
      return res.status(404).json({
        success: false,
        message: `Nenhuma equipe encontrada para a organização ${organizationId}`
      });
    }
    
    // Criar e armazenar o mapa no cache
    const teamMap = createNameToIdMap(teams);
    setCachedMap(organizationId, 'teams', teamMap);
    
    const teamId = teamMap[teamName.toLowerCase()];
    if (!teamId) {
      return res.status(404).json({
        success: false,
        message: `Equipe "${teamName}" não encontrada`
      });
    }
    
    return res.json({
      success: true,
      source: 'database',
      mapping: {
        name: teamName,
        id: teamId
      },
      allTeams: teams.map(team => ({
        name: team.name,
        id: team.id
      }))
    });
  } catch (error) {
    console.error(`[mapTeam] Erro ao mapear equipe:`, error);
    return res.status(500).json({
      success: false,
      message: 'Erro interno ao mapear equipe',
      error: error.message
    });
  }
});

/**
 * @route POST /api/:organizationId/agent-ia/map/flow
 * @desc Mapear nome do fluxo para ID
 * @access Private
 */
router.post('/map/flow', async (req, res) => {
  try {
    const { organizationId } = req.params;
    const { flowName, forceRefresh = false } = req.body;
    
    if (!flowName) {
      return res.status(400).json({
        success: false,
        message: 'Nome do fluxo não fornecido'
      });
    }
    
    // Verificar se existe no cache e não foi solicitado refresh
    if (!forceRefresh) {
      const flowMap = getCachedMap(organizationId, 'flows');
      if (flowMap) {
        const flowId = flowMap[flowName.toLowerCase()];
        if (flowId) {
          return res.json({
            success: true,
            source: 'cache',
            mapping: {
              name: flowName,
              id: flowId
            }
          });
        }
      }
    }
    
    // Se não estiver no cache ou foi solicitado refresh, buscar do banco
    const { data: flows, error } = await supabase
      .from('flows')
      .select('id, name')
      .eq('organization_id', organizationId)
      .eq('is_active', true);
    
    if (error) {
      console.error(`[mapFlow] Erro ao buscar fluxos:`, error);
      return res.status(500).json({
        success: false,
        message: 'Erro ao buscar fluxos',
        error: error.message
      });
    }
    
    if (!flows || flows.length === 0) {
      return res.status(404).json({
        success: false,
        message: `Nenhum fluxo encontrado para a organização ${organizationId}`
      });
    }
    
    // Criar e armazenar o mapa no cache
    const flowMap = createNameToIdMap(flows);
    setCachedMap(organizationId, 'flows', flowMap);
    
    const flowId = flowMap[flowName.toLowerCase()];
    if (!flowId) {
      return res.status(404).json({
        success: false,
        message: `Fluxo "${flowName}" não encontrado`
      });
    }
    
    return res.json({
      success: true,
      source: 'database',
      mapping: {
        name: flowName,
        id: flowId
      },
      allFlows: flows.map(flow => ({
        name: flow.name,
        id: flow.id
      }))
    });
  } catch (error) {
    console.error(`[mapFlow] Erro ao mapear fluxo:`, error);
    return res.status(500).json({
      success: false,
      message: 'Erro interno ao mapear fluxo',
      error: error.message
    });
  }
});

export default router; 