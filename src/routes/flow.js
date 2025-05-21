import express from 'express';
import Sentry from '../lib/sentry.js';
import { verifyAuth } from '../middleware/auth.js';
import { createFileRoute, deleteFileRoute } from '../controllers/flow/file.js';
import axios from 'axios';
const router = express.Router({ mergeParams: true });

// Todas as rotas de canal precisam de autenticação
router.use(verifyAuth);

router.post('/:flowId/file', createFileRoute);
router.delete('/:flowId/file', deleteFileRoute);

/**
 * Rota para testar requisições HTTP a partir do backend
 * Evita problemas de CORS que ocorrem quando as requisições são feitas diretamente do frontend
 */
async function testNodeRequest(req, res) {
  try {
    // Extrair parâmetros da requisição
    const { method, url, headers, params, body, bodyType, timeout } = req.body;

    if (!url) {
      return res.status(400).json({
        success: false,
        error: 'URL é obrigatória'
      });
    }
    
    // Remover parâmetros da URL se existirem
    let cleanUrl = url;
    if (url.includes('?')) {
      cleanUrl = url.split('?')[0];
    }

    // Configurar a requisição para o axios
    const requestConfig = {
      method: method || 'GET',
      url: cleanUrl,
      headers: headers || {},
      timeout: timeout || 15000 // 15 segundos por padrão
    };

    // Adicionar parâmetros de query se fornecidos
    if (params && Array.isArray(params) && params.length > 0) {
      requestConfig.params = {};
      params.forEach(param => {
        if (param.key && param.value) {
          requestConfig.params[param.key] = param.value;
        }
      });
    }

    // Adicionar corpo da requisição para métodos não-GET
    if (method !== 'GET' && bodyType !== 'none' && body) {
      if (bodyType === 'json') {
        try {
          requestConfig.data = JSON.parse(body);
        } catch (error) {
          return res.status(400).json({
            success: false,
            error: 'JSON inválido no corpo da requisição'
          });
        }
      } else {
        // Para outros tipos de body (form, text, etc.)
        requestConfig.data = body;
      }

      // Configurar content-type baseado no bodyType
      if (bodyType === 'json') {
        requestConfig.headers['Content-Type'] = 'application/json';
      } else if (bodyType === 'form') {
        requestConfig.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      }
    }

    // console.log('Requisição sendo feita com a configuração:', requestConfig);

    // Fazer a requisição usando axios
    const response = await axios(requestConfig);

    // console.log('Resposta da requisição:', response.data);

    // Retornar a resposta para o frontend
    return res.json({
      success: true,
      data: response.data,
      status: response.status,
      headers: response.headers
    });
  } catch (error) {
    console.error('Erro na requisição:', error);
    
    // Tratamento detalhado de erro
    if (axios.isAxiosError(error)) {
      if (error.response) {
        // Servidor respondeu com status de erro
        return res.status(400).json({
          success: false,
          error: `Erro ${error.response.status}: ${error.response.statusText || 'Erro desconhecido'}`,
          data: error.response.data,
          status: error.response.status
        });
      } else if (error.request) {
        // Requisição foi feita mas não houve resposta
        return res.status(500).json({
          success: false,
          error: 'Não foi recebida resposta do servidor remoto'
        });
      } else {
        // Erro na configuração da requisição
        return res.status(500).json({
          success: false,
          error: `Erro na configuração da requisição: ${error.message}`
        });
      }
    }
    
    // Erro genérico
    return res.status(500).json({
      success: false,
      error: error.message || 'Erro ao processar a requisição'
    });
  }
}

router.post('/test-node-request', testNodeRequest);

export default router;