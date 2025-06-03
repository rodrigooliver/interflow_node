import { supabase } from '../../lib/supabase.js';
import Sentry from '../../lib/sentry.js';
import { registerUsageOrganizationByCustomer } from '../organizations/usage.js';

/**
 * Formatar valor de contato baseado no tipo
 */
const formatContactValue = (contact) => {
  // O frontend já envia o número formatado completo (+5592949289492)
  // então apenas retornamos o valor como está
  return contact.value;
};

/**
 * Função para validar e formatar números de telefone/WhatsApp
 */
const formatPhoneNumber = (value, type) => {
  if (type !== 'whatsapp') {
    return value;
  }

  // Remover todos os caracteres não numéricos
  let cleaned = value.replace(/\D/g, '');
  
  // Se já tem o formato correto (começando com código do país), manter
  if (cleaned.length >= 10 && cleaned.length <= 15) {
    // Verificar se parece ser um número brasileiro (11 ou 13-14 dígitos)
    if (cleaned.length === 11 || cleaned.length === 10) {
      // Número brasileiro sem código do país, adicionar +55
      cleaned = '55' + cleaned;
    } else if (cleaned.length === 13 && cleaned.startsWith('55')) {
      // Já tem código do país brasileiro
      // Manter como está
    } else if (cleaned.length === 14 && cleaned.startsWith('55')) {
      // Número brasileiro com 9 dígitos + código do país
      // Manter como está
    }
    
    // Adicionar o + no início se não tiver
    return '+' + cleaned;
  }
  
  // Se for muito curto, assumir que é brasileiro e adicionar código
  if (cleaned.length >= 8 && cleaned.length <= 11) {
    // Assumir número brasileiro, adicionar código do país
    if (cleaned.length === 8 || cleaned.length === 9) {
      // Número sem DDD, assumir que está incompleto
      return '+55' + cleaned;
    } else if (cleaned.length === 10 || cleaned.length === 11) {
      // Número com DDD brasileiro
      return '+55' + cleaned;
    }
  }
  
  // Se não conseguiu formatar, retornar original
  return value;
};

/**
 * Função para validar se um número está no formato correto
 */
const validatePhoneNumber = (value, type) => {
  if (type !== 'whatsapp') {
    return { isValid: true, formatted: value };
  }

  const formatted = formatPhoneNumber(value, type);
  
  // Verificar se o número formatado tem o formato correto
  const phoneRegex = /^\+\d{10,15}$/;
  
  if (!phoneRegex.test(formatted)) {
    return {
      isValid: false,
      formatted: value,
      error: `Número inválido: ${value}. Use o formato +55XXXXXXXXXXXX (exemplo: +5511999999999)`
    };
  }
  
  return { isValid: true, formatted };
};

/**
 * Função para determinar o tipo de contato baseado no nome da coluna
 */
const getContactType = (columnName) => {
  const name = columnName.toLowerCase();
  if (name.includes('whatsapp')) return 'whatsapp';
  if (name.includes('email')) return 'email';
  return null;
};

/**
 * Cria um novo cliente com toda a lógica complexa
 * POST /api/:organizationId/customers
 */
export const createCustomerRoute = async (req, res) => {
  try {
    const { organization } = req;
    const { organizationId } = req.params;
    const { 
      name, 
      stageId, 
      salePrice,
      contacts = [],
      selectedTags = [],
      customFields = []
    } = req.body;

    if(organization.usage.customers.used >= organization.usage.customers.limit) {
      return res.status(400).json({ 
        success: false, 
        error: 'Limite de clientes atingido' 
      });
    }

    // Validações básicas
    if (!name || !name.trim()) {
      return res.status(400).json({ 
        success: false, 
        error: 'Nome do cliente é obrigatório' 
      });
    }

    // Validar se pelo menos um contato tem valor
    const hasValidContact = contacts.some(contact => contact.value && contact.value.trim() !== '');
    if (!hasValidContact) {
      return res.status(400).json({ 
        success: false, 
        error: 'Pelo menos um contato é obrigatório' 
      });
    }

    // Validar se organizationId existe
    const { data: orgExists } = await supabase
      .from('organizations')
      .select('id')
      .eq('id', organizationId)
      .single();

    if (!orgExists) {
      return res.status(404).json({ 
        success: false, 
        error: 'Organização não encontrada' 
      });
    }

    // Se stageId foi fornecido, validar se existe
    if (stageId) {
      const { data: stageExists, error: stageError } = await supabase
        .from('crm_stages')
        .select('id')
        .eq('id', stageId)
        .single();
    if(stageError) {
        console.error('Erro ao buscar estágio do funil:', stageError);
        return res.status(400).json({ 
          success: false, 
          error: 'Erro ao buscar estágio do funil' 
        });
    }

      if (!stageExists) {
        console.error('Estágio do funil não encontrado:', stageId);
        return res.status(400).json({ 
          success: false, 
          error: 'Estágio do funil não encontrado' 
        });
      }
    }

    // Iniciar transação manual
    const { data: customer, error: customerError } = await supabase
      .from('customers')
      .insert([{
        name: name.trim(),
        organization_id: organizationId,
        stage_id: stageId || null,
        sale_price: salePrice || null
      }])
      .select()
      .single();

    if (customerError) {
      throw customerError;
    }
    
    // Adicionar contatos do cliente
    const validContacts = contacts.filter(contact => contact.value && contact.value.trim() !== '');
    
    if (validContacts.length > 0) {
      const contactsToInsert = validContacts.map(contact => ({
        customer_id: customer.id,
        type: contact.type,
        value: formatContactValue(contact),
        label: contact.label || null
      }));

      const { error: contactsError } = await supabase
        .from('customer_contacts')
        .insert(contactsToInsert);

      if (contactsError) {
        // Rollback - deletar customer criado
        await supabase.from('customers').delete().eq('id', customer.id);
        throw contactsError;
      }
    }

    // Adicionar tags selecionadas
    if (selectedTags && selectedTags.length > 0) {
      const tagsToInsert = selectedTags.map(tagId => ({
        customer_id: customer.id,
        tag_id: tagId,
        organization_id: organizationId,
        created_at: new Date().toISOString()
      }));

      const { error: tagsError } = await supabase
        .from('customer_tags')
        .insert(tagsToInsert);

      if (tagsError) {
        // Rollback - deletar customer e contatos criados
        await supabase.from('customer_contacts').delete().eq('customer_id', customer.id);
        await supabase.from('customers').delete().eq('id', customer.id);
        throw tagsError;
      }
    }

    // Salvar campos personalizados
    const validCustomFields = customFields.filter(field => field.value && field.value.trim() !== '');
    if (validCustomFields.length > 0) {
      const customFieldsToInsert = validCustomFields.map(field => ({
        customer_id: customer.id,
        field_definition_id: field.field_id,
        value: field.value || '',
        updated_at: new Date().toISOString()
      }));

      const { error: customFieldsError } = await supabase
        .from('customer_field_values')
        .insert(customFieldsToInsert);

      if (customFieldsError) {
        // Rollback - deletar tudo criado
        await supabase.from('customer_tags').delete().eq('customer_id', customer.id);
        await supabase.from('customer_contacts').delete().eq('customer_id', customer.id);
        await supabase.from('customers').delete().eq('id', customer.id);
        throw customFieldsError;
      }
    }

    // Se estágio foi selecionado, registrar no histórico
    if (stageId) {
      const { error: historyError } = await supabase
        .from('customer_stage_history')
        .insert({
          customer_id: customer.id,
          stage_id: stageId,
          organization_id: organizationId
        });
        
      if (historyError) {
        // Rollback - deletar tudo criado
        await supabase.from('customer_field_values').delete().eq('customer_id', customer.id);
        await supabase.from('customer_tags').delete().eq('customer_id', customer.id);
        await supabase.from('customer_contacts').delete().eq('customer_id', customer.id);
        await supabase.from('customers').delete().eq('id', customer.id);
        throw historyError;
      }
    }

    // Buscar dados completos do cliente criado para retornar
    const { data: customerComplete, error: fetchError } = await supabase
      .from('customers')
      .select(`
        *,
        customer_contacts(*),
        customer_tags(*, tags(*)),
        customer_field_values(*, custom_fields_definition(*))
      `)
      .eq('id', customer.id)
      .single();

    if (fetchError) {
      console.error('Erro ao buscar cliente completo:', fetchError);
      // Não faz rollback aqui pois o cliente foi criado com sucesso
    }

    //Contabilizar uso de customer mas não aguardar a resposta
    await registerUsageOrganizationByCustomer(organizationId);

    res.status(201).json({
      success: true,
      data: customerComplete || customer,
      message: 'Cliente criado com sucesso'
    });

  } catch (error) {
    console.error('Erro ao criar cliente:', error);
    Sentry.captureException(error);
    
    // Determinar tipo de erro para resposta mais específica
    if (error.code === '23505') { // Unique constraint violation
      return res.status(409).json({ 
        success: false, 
        error: 'Cliente com essas informações já existe' 
      });
    }
    
    if (error.code === '23503') { // Foreign key constraint violation
      return res.status(400).json({ 
        success: false, 
        error: 'Referência inválida nos dados fornecidos' 
      });
    }

    res.status(500).json({ 
      success: false, 
      error: 'Erro interno do servidor' 
    });
  }
};

export const importCustomersRoute = async (req, res) => {
    console.log('Importando clientes');
  try {
    const { organization } = req;
    const { organizationId } = req.params;
    const { customers } = req.body;

    // Validações básicas
    if (!customers || !Array.isArray(customers) || customers.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'Lista de clientes é obrigatória' 
      });
    }

    // Verificar se não ultrapassará o limite
    const customersToImport = customers.length;
    const currentUsage = organization.usage.customers.used;
    const limit = organization.usage.customers.limit;
    
    if (currentUsage + customersToImport > limit) {
      const availableSlots = limit - currentUsage;
      return res.status(400).json({ 
        success: false, 
        error: `Limite de clientes seria ultrapassado. Você pode importar no máximo ${availableSlots} cliente(s). Tentando importar ${customersToImport} cliente(s).` 
      });
    }

    // Validar estrutura básica dos dados
    const invalidCustomers = customers.filter((customer, index) => {
      if (!customer.name || typeof customer.name !== 'string' || !customer.name.trim()) {
        return true;
      }
      return false;
    });

    if (invalidCustomers.length > 0) {
      return res.status(400).json({ 
        success: false, 
        error: `${invalidCustomers.length} cliente(s) com nome inválido ou ausente` 
      });
    }

    // Validar se pelo menos um cliente tem contato válido
    const customersWithoutContact = customers.filter(customer => {
      return !customer.contacts || 
             !Array.isArray(customer.contacts) || 
             customer.contacts.length === 0 ||
             !customer.contacts.some(contact => contact.value && contact.value.trim() !== '');
    });

    if (customersWithoutContact.length > 0) {
      return res.status(400).json({ 
        success: false, 
        error: `${customersWithoutContact.length} cliente(s) sem contato válido. Pelo menos um contato é obrigatório para cada cliente.` 
      });
    }

    console.log(`Iniciando importação de ${customersToImport} clientes para organização ${organizationId}`);

    // Processar e validar contatos dos clientes
    const validationErrors = [];
    const processedCustomers = customers.map((customer, customerIndex) => {
      const processedCustomer = { ...customer };
      
      if (customer.contacts && Array.isArray(customer.contacts)) {
        const processedContacts = [];
        
        customer.contacts.forEach((contact, contactIndex) => {
          if (contact.value && contact.value.trim()) {
            const contactType = contact.type || getContactType('whatsapp'); // Assumir WhatsApp se não especificado
            const validation = validatePhoneNumber(contact.value, contactType);
            
            if (validation.isValid) {
              processedContacts.push({
                ...contact,
                value: validation.formatted,
                type: contactType
              });
            } else {
              validationErrors.push({
                customerIndex: customerIndex + 1,
                customerName: customer.name,
                contactIndex: contactIndex + 1,
                error: validation.error
              });
            }
          }
        });
        
        processedCustomer.contacts = processedContacts;
      }
      
      return processedCustomer;
    });

    // Se houver erros de validação de números, retornar erro detalhado
    if (validationErrors.length > 0) {
      const errorMessages = validationErrors.slice(0, 5).map(err => 
        `Cliente ${err.customerIndex} (${err.customerName}), Contato ${err.contactIndex}: ${err.error}`
      );
      
      const errorSummary = validationErrors.length > 5 
        ? `${errorMessages.join('\n')}\n\n... e mais ${validationErrors.length - 5} erro(s) de validação`
        : errorMessages.join('\n');
        
      return res.status(400).json({ 
        success: false, 
        error: `Encontrados ${validationErrors.length} erro(s) de validação de contatos:\n\n${errorSummary}` 
      });
    }

    // Chamar função do Supabase para importação em lote
    const { data, error } = await supabase.rpc('import_customers_batch', {
      p_organization_id: organizationId,
      p_customers: processedCustomers
    });

    if (error) {
      console.error('Erro na função batch do Supabase:', error);
      throw error;
    }

    // Contar sucessos e erros
    const results = data || [];
    const successCount = results.filter(r => r.success).length;
    const errorCount = results.filter(r => !r.success).length;

    console.log(`Importação concluída: ${successCount} sucessos, ${errorCount} erros`);

    // Se houve sucessos, contabilizar uso (mas não aguardar a resposta)
    if (successCount > 0) {
      await registerUsageOrganizationByCustomer(organizationId);
    }

    res.status(200).json({
      success: true,
      data: results,
      summary: {
        total: customersToImport,
        success: successCount,
        errors: errorCount
      },
      message: `Importação processada: ${successCount} cliente(s) importado(s) com sucesso, ${errorCount} erro(s)`
    });

  } catch (error) {
    console.error('Erro ao importar clientes:', error);
    Sentry.captureException(error);
    
    // Determinar tipo de erro para resposta mais específica
    if (error.message && error.message.includes('limit')) {
      return res.status(400).json({ 
        success: false, 
        error: 'Limite de clientes foi atingido durante a importação' 
      });
    }
    
    if (error.code === '23505') { // Unique constraint violation
      return res.status(409).json({ 
        success: false, 
        error: 'Alguns clientes já existem no sistema' 
      });
    }
    
    if (error.code === '23503') { // Foreign key constraint violation
      return res.status(400).json({ 
        success: false, 
        error: 'Referências inválidas nos dados fornecidos' 
      });
    }

    res.status(500).json({ 
      success: false, 
      error: 'Erro interno do servidor durante a importação' 
    });
  }
};

//Rota para deletar cliente
//DELETE /api/:organizationId/customers/:id
export const deleteCustomerRoute = async (req, res) => {
  try {
    const { organization } = req;
    const { organizationId, id } = req.params;

    // Validações básicas
    if (!id) {
      return res.status(400).json({ 
        success: false, 
        error: 'ID do cliente é obrigatório' 
      });
    }

    // Verificar se o cliente existe e pertence à organização
    const { data: customer, error: customerError } = await supabase
      .from('customers')
      .select('id, name')
      .eq('id', id)
      .eq('organization_id', organizationId)
      .single();

    if (customerError || !customer) {
      return res.status(404).json({ 
        success: false, 
        error: 'Cliente não encontrado' 
      });
    }

    // Verificar se o cliente tem chats ativos
    const { count: chatsCount, error: chatsError } = await supabase
      .from('chats')
      .select('*', { count: 'exact', head: true })
      .eq('customer_id', id);

    if (chatsError) {
      console.error('Erro ao verificar chats do cliente:', chatsError);
      throw chatsError;
    }

    if (chatsCount && chatsCount > 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'Não é possível excluir o cliente pois existem atendimentos em andamento.',
        hasChats: true
      });
    }

    // Iniciar processo de exclusão (ordem importante para evitar problemas de foreign key)
    
    // 1. Excluir histórico de estágios do cliente
    const { error: historyError } = await supabase
      .from('customer_stage_history')
      .delete()
      .eq('customer_id', id);

    if (historyError) {
      console.error('Erro ao excluir histórico de estágios:', historyError);
      throw historyError;
    }

    // 2. Excluir valores de campos personalizados
    const { error: customFieldsError } = await supabase
      .from('customer_field_values')
      .delete()
      .eq('customer_id', id);

    if (customFieldsError) {
      console.error('Erro ao excluir campos personalizados:', customFieldsError);
      throw customFieldsError;
    }

    // 3. Excluir tags do cliente
    const { error: tagsError } = await supabase
      .from('customer_tags')
      .delete()
      .eq('customer_id', id);

    if (tagsError) {
      console.error('Erro ao excluir tags do cliente:', tagsError);
      throw tagsError;
    }

    // 4. Excluir contatos do cliente
    const { error: contactsError } = await supabase
      .from('customer_contacts')
      .delete()
      .eq('customer_id', id);

    if (contactsError) {
      console.error('Erro ao excluir contatos do cliente:', contactsError);
      throw contactsError;
    }

    // 5. Excluir sessões de fluxo do cliente
    const { error: flowSessionsError } = await supabase
      .from('flow_sessions')
      .delete()
      .eq('customer_id', id);

    if (flowSessionsError) {
      console.error('Erro ao excluir sessões de fluxo:', flowSessionsError);
      throw flowSessionsError;
    }

    // 6. Finalmente, excluir o cliente
    const { error: deleteError } = await supabase
      .from('customers')
      .delete()
      .eq('id', id)
      .eq('organization_id', organizationId);

    if (deleteError) {
      console.error('Erro ao excluir cliente:', deleteError);
      throw deleteError;
    }

    // console.log(`Cliente ${customer.name} (ID: ${id}) excluído com sucesso da organização ${organizationId}`);
    await registerUsageOrganizationByCustomer(organizationId);

    res.status(200).json({
      success: true,
      message: 'Cliente excluído com sucesso'
    });

  } catch (error) {
    console.error('Erro ao deletar cliente:', error);
    Sentry.captureException(error);
    
    // Determinar tipo de erro para resposta mais específica
    if (error.code === '23503') { // Foreign key constraint violation
      return res.status(400).json({ 
        success: false, 
        error: 'Não é possível excluir o cliente devido a dependências no sistema' 
      });
    }

    res.status(500).json({ 
      success: false, 
      error: 'Erro interno do servidor ao excluir cliente' 
    });
  }
};