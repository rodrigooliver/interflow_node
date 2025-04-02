import * as Sentry from '@sentry/node';
import { 
  processOverdueTransactions, 
  generateRecurringTransactions,
  processDailyFinancialJobs 
} from '../cron/financial-jobs.js';
import { createClient } from '@supabase/supabase-js';

// Inicializar cliente Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Número mínimo de transações futuras a serem mantidas para cada série recorrente
const MIN_FUTURE_TRANSACTIONS = 20;

/**
 * Controlador para executar manualmente o processamento de transações vencidas
 * @param {Object} req - Objeto de requisição Express
 * @param {Object} res - Objeto de resposta Express
 */
export const runOverdueTransactions = async (req, res) => {
  try {
    // Verifica se o usuário tem permissão administrativa
    // TO-DO: Implementar verificação de permissões

    // Executa o processamento de transações vencidas
    const count = await processOverdueTransactions();
    
    return res.status(200).json({
      success: true,
      message: `Processamento concluído. ${count} transações atualizadas.`,
      data: { count }
    });
  } catch (error) {
    console.error('Erro ao executar processamento de transações vencidas:', error);
    Sentry.captureException(error);
    
    return res.status(500).json({
      success: false,
      message: 'Erro ao processar transações vencidas',
      error: error.message
    });
  }
};

/**
 * Controlador para executar manualmente a geração de transações recorrentes
 * @param {Object} req - Objeto de requisição Express
 * @param {Object} res - Objeto de resposta Express
 */
export const runRecurringTransactions = async (req, res) => {
  try {
    // Verifica se o usuário tem permissão administrativa
    // TO-DO: Implementar verificação de permissões

    // Executa a geração de transações recorrentes
    const count = await generateRecurringTransactions();
    
    return res.status(200).json({
      success: true,
      message: `Processamento concluído. ${count} transações geradas.`,
      data: { count }
    });
  } catch (error) {
    console.error('Erro ao executar geração de transações recorrentes:', error);
    Sentry.captureException(error);
    
    return res.status(500).json({
      success: false,
      message: 'Erro ao gerar transações recorrentes',
      error: error.message
    });
  }
};

/**
 * Controlador para executar manualmente todos os jobs financeiros diários
 * @param {Object} req - Objeto de requisição Express
 * @param {Object} res - Objeto de resposta Express
 */
export const runDailyFinancialJobs = async (req, res) => {
  try {
    // Verifica se o usuário tem permissão administrativa
    // TO-DO: Implementar verificação de permissões

    // Executa todos os jobs financeiros diários
    const result = await processDailyFinancialJobs();
    
    return res.status(200).json({
      success: true,
      message: `Processamento concluído. ${result.overdueCount} transações vencidas processadas, ${result.recurringCount} transações recorrentes geradas.`,
      data: result
    });
  } catch (error) {
    console.error('Erro ao executar jobs financeiros diários:', error);
    Sentry.captureException(error);
    
    return res.status(500).json({
      success: false,
      message: 'Erro ao processar jobs financeiros diários',
      error: error.message
    });
  }
};

/**
 * Categorias financeiras padrão com suporte a internacionalização
 */
const DEFAULT_INCOME_CATEGORIES = [
  { key: 'sales', translations: { pt: 'Vendas', en: 'Sales' } },
  { key: 'services', translations: { pt: 'Serviços', en: 'Services' } },
  { key: 'investments', translations: { pt: 'Investimentos', en: 'Investments' } },
  { key: 'loans', translations: { pt: 'Empréstimos', en: 'Loans' } },
  { key: 'donations', translations: { pt: 'Doações', en: 'Donations' } },
  { key: 'refunds', translations: { pt: 'Reembolsos', en: 'Refunds' } },
  { key: 'other_income', translations: { pt: 'Outros Recebimentos', en: 'Other Income' } }
];

/**
 * Categorias de despesas padrão com suporte a internacionalização
 */
const DEFAULT_EXPENSE_CATEGORIES = [
  { key: 'rent', translations: { pt: 'Aluguel', en: 'Rent' } },
  { key: 'water', translations: { pt: 'Água', en: 'Water' } },
  { key: 'electricity', translations: { pt: 'Energia', en: 'Electricity' } },
  { key: 'internet', translations: { pt: 'Internet', en: 'Internet' } },
  { key: 'phone', translations: { pt: 'Telefone', en: 'Phone' } },
  { key: 'salaries', translations: { pt: 'Salários', en: 'Salaries' } },
  { key: 'taxes', translations: { pt: 'Impostos', en: 'Taxes' } },
  { key: 'office_supplies', translations: { pt: 'Material de Escritório', en: 'Office Supplies' } },
  { key: 'marketing', translations: { pt: 'Marketing', en: 'Marketing' } },
  { key: 'software', translations: { pt: 'Software', en: 'Software' } },
  { key: 'equipment', translations: { pt: 'Equipamentos', en: 'Equipment' } },
  { key: 'maintenance', translations: { pt: 'Manutenção', en: 'Maintenance' } },
  { key: 'fuel', translations: { pt: 'Combustível', en: 'Fuel' } },
  { key: 'food', translations: { pt: 'Alimentação', en: 'Food' } },
  { key: 'outsourced_services', translations: { pt: 'Serviços Terceirizados', en: 'Outsourced Services' } },
  { key: 'fees', translations: { pt: 'Taxas e Juros', en: 'Fees and Interest' } },
  { key: 'other_expenses', translations: { pt: 'Outras Despesas', en: 'Other Expenses' } }
];

/**
 * Métodos de pagamento padrão com suporte a internacionalização
 */
const DEFAULT_PAYMENT_METHODS = [
  { 
    key: 'cash',
    translations: {
      name: { pt: 'Dinheiro', en: 'Cash' },
      description: { pt: 'Pagamento em espécie', en: 'Cash payment' }
    },
    requires_confirmation: false,
    is_credit: false,
    installments_allowed: false
  },
  { 
    key: 'pix',
    translations: {
      name: { pt: 'Pix', en: 'Pix' },
      description: { pt: 'Pagamento via Pix', en: 'Pix payment' }
    },
    requires_confirmation: true,
    is_credit: false,
    installments_allowed: false
  },
  { 
    key: 'debit_card',
    translations: {
      name: { pt: 'Cartão de Débito', en: 'Debit Card' },
      description: { pt: 'Pagamento com cartão de débito', en: 'Debit card payment' }
    },
    requires_confirmation: false,
    is_credit: false,
    installments_allowed: false,
    fee_percentage: 1.5
  },
  { 
    key: 'credit_card',
    translations: {
      name: { pt: 'Cartão de Crédito', en: 'Credit Card' },
      description: { pt: 'Pagamento com cartão de crédito', en: 'Credit card payment' }
    },
    requires_confirmation: false,
    is_credit: true,
    installments_allowed: true,
    max_installments: 12,
    fee_percentage: 3.5
  },
  { 
    key: 'bank_slip',
    translations: {
      name: { pt: 'Boleto Bancário', en: 'Bank Slip' },
      description: { pt: 'Pagamento via boleto bancário', en: 'Bank slip payment' }
    },
    requires_confirmation: true,
    is_credit: false,
    installments_allowed: false,
    fee_percentage: 2.0
  },
  { 
    key: 'bank_transfer',
    translations: {
      name: { pt: 'Transferência Bancária', en: 'Bank Transfer' },
      description: { pt: 'Pagamento via transferência bancária', en: 'Bank transfer payment' }
    },
    requires_confirmation: true,
    is_credit: false,
    installments_allowed: false
  }
];

/**
 * Adiciona categorias financeiras padrão para uma organização
 * @param {string} organizationId - ID da organização
 * @param {string} locale - Localidade (ex: 'pt', 'en')
 * @returns {Promise<Object>} Resultado da operação
 */
export const addDefaultFinancialCategories = async (req, res) => {
  try {
    const { organizationId } = req.params;
    const locale = req.query.locale || 'pt'; // Padrão para português
    
    if (!organizationId) {
      return res.status(400).json({
        success: false,
        message: 'ID da organização é obrigatório'
      });
    }
    
    // Verificar se a organização existe
    const { data: organization, error: orgError } = await supabase
      .from('organizations')
      .select('id')
      .eq('id', organizationId)
      .single();
    
    if (orgError || !organization) {
      return res.status(404).json({
        success: false,
        message: 'Organização não encontrada'
      });
    }
    
    // Inserir categorias de receita
    for (const category of DEFAULT_INCOME_CATEGORIES) {
      const { error } = await supabase
        .from('financial_categories')
        .insert({
          organization_id: organizationId,
          name: category.translations[locale] || category.translations.en,
          type: 'income',
          key: category.key
        })
        .match({ organization_id: organizationId, key: category.key, type: 'income' })
        .onConflict(['organization_id', 'key', 'type']);
        
      if (error && error.code !== '23505') { // Ignora erros de chave duplicada
        console.error(`Erro ao inserir categoria de receita ${category.key}:`, error);
      }
    }
    
    // Inserir categorias de despesa
    for (const category of DEFAULT_EXPENSE_CATEGORIES) {
      const { error } = await supabase
        .from('financial_categories')
        .insert({
          organization_id: organizationId,
          name: category.translations[locale] || category.translations.en,
          type: 'expense',
          key: category.key
        })
        .match({ organization_id: organizationId, key: category.key, type: 'expense' })
        .onConflict(['organization_id', 'key', 'type']);
        
      if (error && error.code !== '23505') {
        console.error(`Erro ao inserir categoria de despesa ${category.key}:`, error);
      }
    }
    
    return res.status(200).json({
      success: true,
      message: 'Categorias financeiras padrão adicionadas com sucesso',
      data: {
        income_categories: DEFAULT_INCOME_CATEGORIES.length,
        expense_categories: DEFAULT_EXPENSE_CATEGORIES.length
      }
    });
  } catch (error) {
    console.error('Erro ao adicionar categorias financeiras padrão:', error);
    Sentry.captureException(error);
    
    return res.status(500).json({
      success: false,
      message: 'Erro ao adicionar categorias financeiras padrão',
      error: error.message
    });
  }
};

/**
 * Adiciona métodos de pagamento padrão para uma organização
 * @param {string} organizationId - ID da organização
 * @param {string} locale - Localidade (ex: 'pt', 'en')
 * @returns {Promise<Object>} Resultado da operação
 */
export const addDefaultPaymentMethods = async (req, res) => {
  try {
    const { organizationId } = req.params;
    const locale = req.query.locale || 'pt'; // Padrão para português
    
    if (!organizationId) {
      return res.status(400).json({
        success: false,
        message: 'ID da organização é obrigatório'
      });
    }
    
    // Verificar se a organização existe
    const { data: organization, error: orgError } = await supabase
      .from('organizations')
      .select('id')
      .eq('id', organizationId)
      .single();
    
    if (orgError || !organization) {
      return res.status(404).json({
        success: false,
        message: 'Organização não encontrada'
      });
    }
    
    // Inserir métodos de pagamento
    for (const method of DEFAULT_PAYMENT_METHODS) {
      const { error } = await supabase
        .from('financial_payment_methods')
        .insert({
          organization_id: organizationId,
          name: method.translations.name[locale] || method.translations.name.en,
          description: method.translations.description[locale] || method.translations.description.en,
          requires_confirmation: method.requires_confirmation,
          is_credit: method.is_credit,
          installments_allowed: method.installments_allowed,
          max_installments: method.max_installments || null,
          fee_percentage: method.fee_percentage || null,
          key: method.key
        })
        .match({ organization_id: organizationId, key: method.key })
        .onConflict(['organization_id', 'key']);
        
      if (error && error.code !== '23505') {
        console.error(`Erro ao inserir método de pagamento ${method.key}:`, error);
      }
    }
    
    return res.status(200).json({
      success: true,
      message: 'Métodos de pagamento padrão adicionados com sucesso',
      data: {
        payment_methods: DEFAULT_PAYMENT_METHODS.length
      }
    });
  } catch (error) {
    console.error('Erro ao adicionar métodos de pagamento padrão:', error);
    Sentry.captureException(error);
    
    return res.status(500).json({
      success: false,
      message: 'Erro ao adicionar métodos de pagamento padrão',
      error: error.message
    });
  }
};

/**
 * Adiciona todas as configurações financeiras padrão para uma organização
 * @param {string} organizationId - ID da organização
 * @param {string} locale - Localidade (ex: 'pt', 'en')
 * @returns {Promise<Object>} Resultado da operação
 */
export const addAllFinancialDefaults = async (req, res) => {
  try {
    const { organizationId } = req.params;
    const locale = req.query.locale || 'pt'; // Padrão para português
    
    // Adicionar categorias financeiras
    await addDefaultFinancialCategories({
      params: { organizationId },
      query: { locale }
    }, { status: () => ({ json: () => {} }) });
    
    // Adicionar métodos de pagamento
    await addDefaultPaymentMethods({
      params: { organizationId },
      query: { locale }
    }, { status: () => ({ json: () => {} }) });
    
    return res.status(200).json({
      success: true,
      message: 'Configurações financeiras padrão adicionadas com sucesso',
      data: {
        income_categories: DEFAULT_INCOME_CATEGORIES.length,
        expense_categories: DEFAULT_EXPENSE_CATEGORIES.length,
        payment_methods: DEFAULT_PAYMENT_METHODS.length
      }
    });
  } catch (error) {
    console.error('Erro ao adicionar configurações financeiras padrão:', error);
    Sentry.captureException(error);
    
    return res.status(500).json({
      success: false,
      message: 'Erro ao adicionar configurações financeiras padrão',
      error: error.message
    });
  }
};

// Função para regenerar transações futuras para uma série específica
export const regenerateRecurringSeries = async (req, res) => {
  try {
    const { organizationId, transactionId } = req.params;
    const { count = MIN_FUTURE_TRANSACTIONS } = req.query;
    
    // Verificar se a transação existe e pertence à organização correta
    const { data: transaction, error: txError } = await supabase
      .from('financial_transactions')
      .select('id, organization_id, frequency, due_date, parent_transaction_id')
      .eq('id', transactionId)
      .single();
    
    if (txError || !transaction) {
      return res.status(404).json({
        success: false,
        message: 'Transação não encontrada'
      });
    }
    
    // Verificar se a transação pertence à organização
    if (transaction.organization_id !== organizationId) {
      return res.status(403).json({
        success: false,
        message: 'Transação não pertence a esta organização'
      });
    }
    
    // Verificar se a transação é recorrente
    if (transaction.frequency === 'once') {
      return res.status(400).json({
        success: false,
        message: 'Esta transação não é recorrente'
      });
    }
    
    // Identificar o ID da transação principal (a primeira da série)
    const parentId = transaction.parent_transaction_id || transaction.id;
    
    // Buscar todas as transações desta série
    const { data: seriesTransactions, error: seriesError } = await supabase
      .from('financial_transactions')
      .select('*')
      .or(`id.eq.${parentId},parent_transaction_id.eq.${parentId}`)
      .order('due_date', { ascending: true });
      
    if (seriesError) {
      return res.status(500).json({
        success: false,
        message: 'Erro ao buscar transações da série',
        error: seriesError.message
      });
    }
    
    // Filtrar apenas as transações pendentes futuras
    const futurePendingTransactions = seriesTransactions.filter(
      tx => tx.status === 'pending' && new Date(tx.due_date) > new Date()
    );
    
    // Se já temos o número necessário, retornar sem criar novas
    if (futurePendingTransactions.length >= count) {
      return res.status(200).json({
        success: true,
        message: `Já existem ${futurePendingTransactions.length} transações futuras para esta série`,
        data: {
          existing: futurePendingTransactions.length,
          generated: 0,
          total: futurePendingTransactions.length
        }
      });
    }
    
    // Determinar quantas transações adicionais precisamos gerar
    const transactionsToGenerate = count - futurePendingTransactions.length;
    
    // Encontrar a última transação da série para usar como base
    const lastTransaction = seriesTransactions[seriesTransactions.length - 1];
    const frequency = lastTransaction.frequency;
    let lastDueDate = new Date(lastTransaction.due_date);
    
    // Array para armazenar as novas transações
    const newTransactions = [];
    
    // Gerar as transações adicionais
    for (let i = 0; i < transactionsToGenerate; i++) {
      // Calcular a próxima data de vencimento
      let nextDueDate = new Date(lastDueDate);
      
      switch (frequency) {
        case 'daily':
          nextDueDate.setDate(nextDueDate.getDate() + 1);
          break;
        case 'weekly':
          nextDueDate.setDate(nextDueDate.getDate() + 7);
          break;
        case 'monthly':
          nextDueDate.setMonth(nextDueDate.getMonth() + 1);
          break;
        case 'quarterly':
          nextDueDate.setMonth(nextDueDate.getMonth() + 3);
          break;
        case 'semiannual':
          nextDueDate.setMonth(nextDueDate.getMonth() + 6);
          break;
        case 'annual':
          nextDueDate.setFullYear(nextDueDate.getFullYear() + 1);
          break;
      }
      
      // Preparar dados da nova transação
      const newTransactionData = {
        organization_id: lastTransaction.organization_id,
        transaction_code: lastTransaction.transaction_code,
        description: lastTransaction.description,
        amount: lastTransaction.amount,
        transaction_type: lastTransaction.transaction_type,
        category_id: lastTransaction.category_id,
        payment_method_id: lastTransaction.payment_method_id,
        due_date: nextDueDate.toISOString().split('T')[0], // Formato YYYY-MM-DD
        frequency: lastTransaction.frequency,
        installment_number: lastTransaction.installment_number ? seriesTransactions.length + newTransactions.length + 1 : null,
        total_installments: lastTransaction.total_installments,
        parent_transaction_id: parentId,
        status: 'pending',
        notes: lastTransaction.notes,
        customer_id: lastTransaction.customer_id,
        chat_id: lastTransaction.chat_id,
        appointment_id: lastTransaction.appointment_id,
        created_by: lastTransaction.created_by
      };
      
      // Criar a nova transação
      const { data: newTransaction, error: createError } = await supabase
        .from('financial_transactions')
        .insert(newTransactionData)
        .select()
        .single();
      
      if (createError) {
        return res.status(500).json({
          success: false,
          message: 'Erro ao criar transação futura',
          error: createError.message,
          data: {
            existing: futurePendingTransactions.length,
            generated: newTransactions.length,
            total: futurePendingTransactions.length + newTransactions.length
          }
        });
      }
      
      // Adicionar à lista de novas transações
      newTransactions.push(newTransaction);
      
      // Atualizar a última data de vencimento para a próxima iteração
      lastDueDate = nextDueDate;
    }
    
    return res.status(200).json({
      success: true,
      message: `Geradas ${newTransactions.length} novas transações futuras`,
      data: {
        existing: futurePendingTransactions.length,
        generated: newTransactions.length,
        total: futurePendingTransactions.length + newTransactions.length,
        transactions: newTransactions
      }
    });
  } catch (error) {
    console.error('Erro ao regenerar série recorrente:', error);
    Sentry.captureException(error);
    
    return res.status(500).json({
      success: false,
      message: 'Erro ao regenerar série recorrente',
      error: error.message
    });
  }
}; 