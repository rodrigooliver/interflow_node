import express from 'express';
import { 
  runOverdueTransactions, 
  runRecurringTransactions, 
  runDailyFinancialJobs,
  addDefaultFinancialCategories,
  addDefaultPaymentMethods,
  addAllFinancialDefaults,
  regenerateRecurringSeries
} from '../controllers/financial.js';

const router = express.Router();

/**
 * @route POST /api/:organizationId/financial/run-overdue
 * @desc Executa manualmente o processamento de transações vencidas
 * @access Private (admin)
 */
router.post('/run-overdue', runOverdueTransactions);

/**
 * @route POST /api/:organizationId/financial/run-recurring
 * @desc Executa manualmente a geração de transações recorrentes
 * @access Private (admin)
 */
router.post('/run-recurring', runRecurringTransactions);

/**
 * @route POST /api/:organizationId/financial/run-daily-jobs
 * @desc Executa manualmente todos os jobs financeiros diários
 * @access Private (admin)
 */
router.post('/run-daily-jobs', runDailyFinancialJobs);

/**
 * @route POST /api/:organizationId/financial/defaults/categories
 * @desc Adiciona categorias financeiras padrão para a organização
 * @access Private (admin)
 */
router.post('/defaults/categories', addDefaultFinancialCategories);

/**
 * @route POST /api/:organizationId/financial/defaults/payment-methods
 * @desc Adiciona métodos de pagamento padrão para a organização
 * @access Private (admin)
 */
router.post('/defaults/payment-methods', addDefaultPaymentMethods);

/**
 * @route POST /api/:organizationId/financial/defaults/all
 * @desc Adiciona todas as configurações financeiras padrão para a organização
 * @access Private (admin)
 */
router.post('/defaults/all', addAllFinancialDefaults);

/**
 * @route POST /api/:organizationId/financial/transactions/:transactionId/regenerate-series
 * @desc Regenera transações futuras para uma série recorrente
 * @access Private
 */
router.post('/transactions/:transactionId/regenerate-series', regenerateRecurringSeries);

export default router; 