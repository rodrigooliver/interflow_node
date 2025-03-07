# Cron Jobs do Interflow

Este diretório contém os cron jobs utilizados pela aplicação Interflow.

## Cron Jobs Disponíveis

### 1. Verificação de Timeouts (`timeout-checker.js`)
- **Frequência**: A cada minuto (`* * * * *`)
- **Função**: Verifica sessões de fluxo que ultrapassaram o tempo limite de espera por resposta do cliente
- **Comportamento**: 
  - Busca sessões ativas com `timeout_at` no passado
  - Para cada sessão, busca uma edge do tipo "timeout" que sai do nó atual
  - Se encontrar, segue para o nó de destino e continua o fluxo
  - Se não encontrar, apenas zera o `timeout_at`

### 2. Atualização de Tokens do Instagram (`instagram-token-refresh.js`)
- **Frequência**: Todos os dias à meia-noite (`0 0 * * *`)
- **Função**: Atualiza tokens de acesso do Instagram que estão próximos de expirar
- **Comportamento**:
  - Busca canais do Instagram com tokens que expiram nos próximos 30 dias
  - Para cada canal, solicita um novo token de acesso
  - Atualiza o token no banco de dados

## Como Adicionar um Novo Cron Job

1. Crie um novo arquivo `.js` neste diretório com a lógica do cron job
2. Exporte a função principal que será executada pelo cron
3. Importe a função no arquivo `index.js`
4. Adicione um novo agendamento no método `setupCronJobs()`
5. Atualize este README com a documentação do novo cron job

## Formato de Agendamento (Crontab)

Os cron jobs utilizam o formato padrão crontab:

```
* * * * *
│ │ │ │ │
│ │ │ │ └─── dia da semana (0-7) (0 ou 7 é domingo)
│ │ │ └───── mês (1-12)
│ │ └─────── dia do mês (1-31)
│ └───────── hora (0-23)
└─────────── minuto (0-59)
```

Exemplos:
- `* * * * *`: A cada minuto
- `0 * * * *`: No início de cada hora
- `0 0 * * *`: À meia-noite todos os dias
- `0 0 * * 0`: À meia-noite de domingo
- `0 0 1 * *`: À meia-noite do primeiro dia de cada mês 