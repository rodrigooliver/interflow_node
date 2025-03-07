import { setupCronJobs } from './index.js';

/**
 * Inicia os cron jobs da aplicação
 * Este arquivo pode ser importado no arquivo principal da aplicação
 * ou executado separadamente como um processo independente
 */
export const startCronJobs = () => {
  console.log('Iniciando cron jobs...');
  setupCronJobs();
  console.log('Cron jobs iniciados com sucesso');
};

// Executa a função se o arquivo for executado diretamente
if (process.argv[1] === import.meta.url) {
  startCronJobs();
} 