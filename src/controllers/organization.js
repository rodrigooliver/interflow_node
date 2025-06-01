import { supabase } from '../lib/supabase.js';
import Sentry from '../lib/sentry.js';

/**
 * Busca as organizações onde o usuário é indicador, vendedor ou seller
 * @param {Object} req - Objeto de requisição do Express
 * @param {Object} res - Objeto de resposta do Express
 */
export async function getPartnerOrganization(req, res) {
  try {
    const { profileId } = req;
    
    if (!profileId) {
      return res.status(401).json({ error: 'Usuário não autenticado' });
    }

    // Buscar organizações onde o usuário é seller_id, indication_id ou support_id
    const { data: organizations, error } = await supabase
      .from('organizations')
      .select(`
        id,
        name,
        slug,
        logo_url,
        status,
        email,
        whatsapp,
        created_at,
        updated_at,
        usage,
        seller_id,
        indication_id,
        support_id
      `)
      .or(`seller_id.eq.${profileId},indication_id.eq.${profileId},support_id.eq.${profileId}`)
      .eq('status', 'active');

    if (error) {
      console.log('error', error);
      Sentry.captureException(error);
      return res.status(500).json({ error: 'Erro ao buscar organizações de parceiros' });
    }

    // Adicionar informações sobre o tipo de relação
    const organizationsWithRelationship = organizations.map(org => {
      const relationships = [];
      
      if (org.indication_id === profileId) relationships.push('indication');
      if (org.seller_id === profileId) relationships.push('seller');
      if (org.support_id === profileId) relationships.push('support');
      
      return {
        ...org,
        relationships
      };
    });

    return res.json({ organizations: organizationsWithRelationship });
  } catch (error) {
    Sentry.captureException(error);
    return res.status(500).json({ error: 'Erro interno do servidor' });
  }
} 