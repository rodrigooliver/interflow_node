import * as Sentry from '@sentry/node';
import { supabase } from '../lib/supabase.js';

// Número mínimo de transações futuras a serem mantidas para cada série recorrente
const MIN_FUTURE_TRANSACTIONS = 20;

/**
 * Atualiza transações com status vencido
 * @returns {Promise<number>} Número de transações atualizadas
 */
export const processOverdueTransactions = async () => {
  try {
    console.log('Iniciando processamento de transações vencidas');
    
    // Obter a data atual
    const today = new Date().toISOString().split('T')[0]; // Formato YYYY-MM-DD
    
    // Buscar e atualizar transações pendentes com data de vencimento no passado
    const { data, error } = await supabase
      .from('financial_transactions')
      .update({ status: 'overdue' })
      .eq('status', 'pending')
      .lt('due_date', today)
      .select('id');
    
    if (error) throw error;
    
    const count = data ? data.length : 0;
    console.log(`Processadas ${count} transações vencidas`);
    
    // Registrar informações detalhadas sobre as transações atualizadas
    if (count > 0) {
      console.log(`IDs das transações atualizadas: ${data.map(tx => tx.id).join(', ')}`);
      
      // Se desejar, você pode implementar notificações para transações vencidas
      // await sendOverdueNotifications(data);
    }
    
    return count;
  } catch (error) {
    console.error('Erro ao processar transações vencidas:', error);
    Sentry.captureException(error);
    return 0;
  }
};

/**
 * Calcula a próxima data de vencimento com base na frequência
 * @param {Date} currentDate - Data atual de vencimento
 * @param {string} frequency - Frequência da transação
 * @returns {Date} Próxima data de vencimento
 */
const calculateNextDueDate = (currentDate, frequency) => {
  const date = new Date(currentDate);
  
  switch (frequency) {
    case 'daily':
      date.setDate(date.getDate() + 1);
      break;
    case 'weekly':
      date.setDate(date.getDate() + 7);
      break;
    case 'monthly':
      date.setMonth(date.getMonth() + 1);
      break;
    case 'quarterly':
      date.setMonth(date.getMonth() + 3);
      break;
    case 'semiannual':
      date.setMonth(date.getMonth() + 6);
      break;
    case 'annual':
      date.setFullYear(date.getFullYear() + 1);
      break;
    default:
      return null;
  }
  
  return date;
};

/**
 * Determina se uma transação é elegível para gerar a próxima na série
 * @param {Object} transaction - Transação a ser verificada
 * @returns {boolean} Verdadeiro se a transação deve gerar a próxima na série
 */
const shouldGenerateNext = (transaction) => {
  // Se não é recorrente, não gera próxima
  if (transaction.frequency === 'once') return false;
  
  // Somente gerar a partir de transações com status pago, recebido ou cancelado
  return ['paid', 'received', 'cancelled'].includes(transaction.status);
};

/**
 * Gera a próxima transação na série recorrente
 * @param {Object} transaction - Transação base para gerar a próxima
 * @returns {Promise<Object>} Nova transação gerada
 */
const generateNextTransaction = async (transaction) => {
  try {
    // Calcular próxima data de vencimento
    const nextDueDate = calculateNextDueDate(transaction.due_date, transaction.frequency);
    if (!nextDueDate) return null;
    
    // Determinar o ID da transação pai (original da série)
    const parentId = transaction.parent_transaction_id || transaction.id;
    
    // Preparar os dados da nova transação
    const newTransactionData = {
      organization_id: transaction.organization_id,
      transaction_code: transaction.transaction_code,
      description: transaction.description,
      amount: transaction.amount,
      transaction_type: transaction.transaction_type,
      category_id: transaction.category_id,
      payment_method_id: transaction.payment_method_id,
      due_date: nextDueDate.toISOString().split('T')[0], // Formato YYYY-MM-DD
      frequency: transaction.frequency,
      installment_number: transaction.installment_number ? transaction.installment_number + 1 : null,
      total_installments: transaction.total_installments,
      parent_transaction_id: parentId,
      status: 'pending',
      notes: transaction.notes,
      customer_id: transaction.customer_id,
      chat_id: transaction.chat_id,
      appointment_id: transaction.appointment_id,
      created_by: transaction.created_by
    };
    
    // Inserir a nova transação no banco
    const { data: newTransaction, error } = await supabase
      .from('financial_transactions')
      .insert(newTransactionData)
      .select()
      .single();
    
    if (error) throw error;
    
    return newTransaction;
  } catch (error) {
    console.error(`Erro ao gerar próxima transação para ID ${transaction.id}:`, error);
    throw error;
  }
};

/**
 * Busca todas as transações que precisam gerar a próxima na série
 * @returns {Promise<Array>} Lista de transações elegíveis
 */
const findTransactionsForRecurringGeneration = async () => {
  try {
    // Buscar transações originais (sem parent_transaction_id) que precisam gerar próximas
    const { data: originalTransactions, error: originalError } = await supabase
      .from('financial_transactions')
      .select('*')
      .neq('frequency', 'once')
      .in('status', ['paid', 'received', 'cancelled'])
      .is('parent_transaction_id', null)
      .not('id', 'in', 
        supabase
          .from('financial_transactions')
          .select('parent_transaction_id')
          .not('parent_transaction_id', 'is', null)
      );
    
    if (originalError) throw originalError;
    
    // Buscar últimas transações de cada série que precisam gerar próximas
    const { data: lastTransactions, error: lastError } = await supabase
      .rpc('get_last_transactions_in_series');
    
    if (lastError) throw lastError;
    
    // Combinar os resultados
    return [...(originalTransactions || []), ...(lastTransactions || [])].filter(shouldGenerateNext);
  } catch (error) {
    console.error('Erro ao buscar transações para geração recorrente:', error);
    throw error;
  }
};

/**
 * Gera transações recorrentes para o próximo período e mantém um mínimo de transações futuras
 * @returns {Promise<number>} Número de transações geradas
 */
export const generateRecurringTransactions = async () => {
  try {
    console.log('Iniciando geração avançada de transações recorrentes');
    
    // Criar uma função RPC para buscar as últimas transações de cada série
    // Esta função é necessária apenas uma vez
    await createGetLastTransactionsFunction();
    
    // Buscar todas as transações que precisam gerar a próxima na série
    const transactionsToProcess = await findTransactionsForRecurringGeneration();
    console.log(`Encontradas ${transactionsToProcess.length} transações para geração da próxima na série`);
    
    // Contador de transações geradas
    let totalGenerated = 0;
    
    // Gerar a próxima transação para cada uma encontrada
    for (const transaction of transactionsToProcess) {
      try {
        const newTransaction = await generateNextTransaction(transaction);
        if (newTransaction) totalGenerated++;
      } catch (error) {
        console.error(`Erro ao processar transação ${transaction.id}:`, error);
        continue; // Continua com a próxima transação
      }
    }
    
    console.log(`Geradas ${totalGenerated} transações iniciais`);
    
    // Agora, buscar todas as séries de transações recorrentes para garantir o mínimo de transações futuras
    const { data: recurringSeries, error: seriesError } = await supabase
      .from('financial_transactions')
      .select(`
        id, 
        organization_id,
        transaction_code,
        description, 
        amount, 
        transaction_type,
        category_id,
        payment_method_id,
        frequency,
        due_date,
        installment_number,
        total_installments,
        notes,
        customer_id,
        chat_id,
        appointment_id,
        created_by
      `)
      .in('frequency', ['daily', 'weekly', 'monthly', 'quarterly', 'semiannual', 'annual'])
      .is('parent_transaction_id', null)  // Somente transações originais/parent
      .in('status', ['paid', 'received', 'pending']) // Somente séries ativas
      .order('due_date', { ascending: true });
    
    if (seriesError) throw seriesError;
    
    let additionalGenerated = 0;
    
    // Para cada série, verificar e garantir o mínimo de transações futuras
    for (const series of recurringSeries) {
      try {
        // Identificar o ID da transação principal (a primeira da série)
        const parentId = series.id;
        
        // Buscar todas as transações desta série (incluindo a original e as já geradas)
        const { data: seriesTransactions, error: transactionsError } = await supabase
          .from('financial_transactions')
          .select('id, due_date, frequency, status')
          .or(`id.eq.${parentId},parent_transaction_id.eq.${parentId}`)
          .order('due_date', { ascending: true });
        
        if (transactionsError) {
          console.error(`Erro ao buscar transações da série ${parentId}:`, transactionsError);
          continue; // Pular para a próxima série
        }
        
        // Filtrar apenas as transações pendentes futuras
        const futurePendingTransactions = seriesTransactions.filter(
          tx => tx.status === 'pending' && new Date(tx.due_date) > new Date()
        );
        
        // Se já temos o mínimo necessário, pular para a próxima série
        if (futurePendingTransactions.length >= MIN_FUTURE_TRANSACTIONS) {
          continue;
        }
        
        // Determinar quantas transações adicionais precisamos gerar
        const transactionsToGenerate = MIN_FUTURE_TRANSACTIONS - futurePendingTransactions.length;
        console.log(`Gerando ${transactionsToGenerate} transações adicionais para a série ${parentId}`);
        
        // Encontrar a última transação da série para usar como base
        const lastTransaction = seriesTransactions[seriesTransactions.length - 1];
        const frequency = lastTransaction.frequency;
        let lastDueDate = new Date(lastTransaction.due_date);
        
        // Gerar as transações adicionais
        for (let i = 0; i < transactionsToGenerate; i++) {
          // Calcular a próxima data de vencimento
          let nextDueDate = calculateNextDueDate(lastDueDate, frequency);
          
          if (!nextDueDate) break;
          
          // Criar a nova transação
          const newTransactionData = {
            organization_id: series.organization_id,
            transaction_code: series.transaction_code,
            description: series.description,
            amount: series.amount,
            transaction_type: series.transaction_type,
            category_id: series.category_id,
            payment_method_id: series.payment_method_id,
            due_date: nextDueDate.toISOString().split('T')[0], // Formato YYYY-MM-DD
            frequency: series.frequency,
            installment_number: series.installment_number ? seriesTransactions.length + i + 1 : null,
            total_installments: series.total_installments,
            parent_transaction_id: parentId,
            status: 'pending',
            notes: series.notes,
            customer_id: series.customer_id,
            chat_id: series.chat_id,
            appointment_id: series.appointment_id,
            created_by: series.created_by
          };
          
          const { data: newTransaction, error: createError } = await supabase
            .from('financial_transactions')
            .insert(newTransactionData)
            .select()
            .single();
          
          if (createError) {
            console.error(`Erro ao criar transação futura:`, createError);
            break; // Parar de gerar para esta série se houver erro
          }
          
          // Atualizar a última data de vencimento para a próxima iteração
          lastDueDate = nextDueDate;
          additionalGenerated++;
        }
      } catch (error) {
        console.error(`Erro ao processar série ${series.id}:`, error);
        continue;
      }
    }
    
    totalGenerated += additionalGenerated;
    
    console.log(`Geradas ${totalGenerated} transações recorrentes no total (${additionalGenerated} adicionais)`);
    return totalGenerated;
  } catch (error) {
    console.error('Erro ao gerar transações recorrentes:', error);
    Sentry.captureException(error);
    return 0;
  }
};

/**
 * Cria uma função no banco de dados para buscar as últimas transações de cada série
 */
const createGetLastTransactionsFunction = async () => {
  try {
    // Verificar se a função já existe
    const { data: functionExists, error: checkError } = await supabase
      .rpc('function_exists', { function_name: 'get_last_transactions_in_series' });
    
    if (checkError) {
      console.error('Erro ao verificar se a função existe:', checkError);
      return;
    }
    
    // Se a função já existe, não precisa criar novamente
    if (functionExists) return;
    
    // Criar a função para buscar as últimas transações de cada série
    const { error } = await supabase.rpc('create_function', {
      function_definition: `
      CREATE OR REPLACE FUNCTION public.get_last_transactions_in_series()
      RETURNS SETOF public.financial_transactions AS $$
      BEGIN
        RETURN QUERY
        WITH series_last_transactions AS (
          SELECT 
            ft.*,
            ROW_NUMBER() OVER(PARTITION BY COALESCE(ft.parent_transaction_id, ft.id) ORDER BY ft.due_date DESC) as rn
          FROM 
            public.financial_transactions ft
          WHERE 
            ft.frequency != 'once'
            AND (ft.status = 'paid' OR ft.status = 'received' OR ft.status = 'cancelled')
            AND (ft.parent_transaction_id IS NOT NULL OR EXISTS (
              SELECT 1 FROM public.financial_transactions 
              WHERE parent_transaction_id = ft.id
            ))
        )
        SELECT
          slt.id,
          slt.organization_id,
          slt.transaction_code,
          slt.description,
          slt.amount,
          slt.transaction_type,
          slt.category_id,
          slt.payment_method_id,
          slt.cashier_id,
          slt.cashier_operation_id,
          slt.due_date,
          slt.payment_date,
          slt.frequency,
          slt.installment_number,
          slt.total_installments,
          slt.parent_transaction_id,
          slt.status,
          slt.notes,
          slt.customer_id,
          slt.chat_id,
          slt.appointment_id,
          slt.created_by,
          slt.created_at,
          slt.updated_at
        FROM 
          series_last_transactions slt
        WHERE 
          slt.rn = 1;
      END;
      $$ LANGUAGE plpgsql;
      `
    });
    
    if (error) {
      console.error('Erro ao criar função get_last_transactions_in_series:', error);
    } else {
      console.log('Função get_last_transactions_in_series criada com sucesso');
    }
  } catch (error) {
    console.error('Erro ao criar função de banco de dados:', error);
  }
};

/**
 * Processa todos os jobs financeiros diários
 * Esta função combina todos os jobs relacionados a finanças em uma única chamada
 */
export const processDailyFinancialJobs = async () => {
  try {
    console.log('Iniciando processamento de jobs financeiros diários');
    
    // Executar jobs em paralelo
    const [overdueCount, recurringCount] = await Promise.all([
      processOverdueTransactions(),
      generateRecurringTransactions()
    ]);

    console.log(`Jobs financeiros diários concluídos: ${overdueCount} transações vencidas processadas, ${recurringCount} transações recorrentes geradas`);
    return { overdueCount, recurringCount };
  } catch (error) {
    console.error('Erro ao processar jobs financeiros diários:', error);
    Sentry.captureException(error);
    return { overdueCount: 0, recurringCount: 0 };
  }
}; 