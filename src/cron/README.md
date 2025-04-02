# Jobs Financeiros - Documentação

Este módulo contém implementações de jobs automatizados para o sistema financeiro do Interflow.

## Visão Geral

Os jobs financeiros são executados automaticamente via cron em horários específicos para garantir que as transações sejam processadas corretamente. Também é possível executá-los manualmente através de endpoints da API.

## Jobs Implementados

1. **Processamento de Transações Vencidas** (`processOverdueTransactions`)
   - Executa diariamente às 00:30
   - Atualiza o status de transações pendentes que venceram para "overdue"
   - Endpoint manual: `POST /api/:organizationId/financial/run-overdue`

2. **Geração de Transações Recorrentes** (`generateRecurringTransactions`)
   - Executa diariamente às 01:00
   - Gera novas transações para séries recorrentes com base na frequência definida
   - Endpoint manual: `POST /api/:organizationId/financial/run-recurring`

3. **Jobs Financeiros Diários** (`processDailyFinancialJobs`)
   - Executa diariamente às 02:00
   - Agrupa todos os jobs financeiros em uma única execução
   - Endpoint manual: `POST /api/:organizationId/financial/run-daily-jobs`

## Arquitetura

A implementação segue uma arquitetura em camadas:

1. **Funções de Banco de Dados** (Supabase)
   - Implementadas como funções PostgreSQL
   - Responsáveis pela lógica de negócios relacionada diretamente aos dados
   - Chamadas via RPC pelo backend

2. **Serviços de Backend** (Node.js)
   - Orquestram a execução das funções do banco de dados
   - Controlam o agendamento dos jobs via cron
   - Fornecem logging e monitoramento

3. **API REST** (Express)
   - Permite a execução manual dos jobs
   - Requer autenticação e autorização adequadas

## Implementação vs. Bancos de Dados

Por que mover jobs do banco de dados para o backend?

- **Melhor monitoramento**: Logs mais detalhados e integração com ferramentas de observabilidade
- **Tratamento de erros**: Retry e notificações em caso de falhas
- **Flexibilidade**: Fácil ajuste de horários e frequências sem migrações de banco
- **Manutenção**: Código mais organizado e fácil de manter
- **Escalabilidade**: Possibilidade de distribuir jobs entre diferentes servidores

## Como Usar

### Desenvolvimento

Para testar os jobs durante o desenvolvimento:

```javascript
// Importar as funções
import { processOverdueTransactions } from '../cron/financial-jobs.js';

// Executar manualmente
await processOverdueTransactions();
```

### Produção

Em produção, os jobs são executados automaticamente pelos crons configurados.

Para forçar a execução manual (em caso de testes ou recuperação), use os endpoints da API:

```bash
# Processar transações vencidas
curl -X POST https://api.example.com/api/{organizationId}/financial/run-overdue

# Gerar transações recorrentes
curl -X POST https://api.example.com/api/{organizationId}/financial/run-recurring

# Executar todos os jobs financeiros
curl -X POST https://api.example.com/api/{organizationId}/financial/run-daily-jobs
```

### Notas Importantes

- Os jobs são executados em horários específicos para evitar conflitos e distribuir a carga
- Em ambientes de desenvolvimento, os crons não são inicializados automaticamente
- Sempre verifique os logs para confirmar a execução correta dos jobs 