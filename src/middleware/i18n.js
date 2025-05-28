import { translations } from '../i18n/translations.js';

export const i18nMiddleware = (req, res, next) => {
  // console.log(req);
  
  // Tenta obter a linguagem da requisição, incluindo req.lang que pode ser definido após autenticação
  const language = req.query?.lang || req.body?.lang || req.headers['accept-language']?.split(',')[0]?.split('-')[0] || 'pt';
  
  // Verifica se o idioma é suportado, caso contrário usa o padrão
  if (!translations[language]) {
    req.language = 'pt';
  } else {
    req.language = language;
  }

  // Adiciona a função de tradução ao objeto de requisição
  req.t = (key, variables = null) => {
    // Se variables for uma string, trata como customMessage (comportamento antigo)
    if (typeof variables === 'string') {
      return variables;
    }
    
    const keys = key.split('.');
    let value = translations[req.language];
    
    for (const k of keys) {
      value = value?.[k];
      if (!value) return key;
    }
    
    // Se não há variáveis para substituir, retorna o valor como está
    if (!variables || typeof variables !== 'object') {
      return value;
    }
    
    // Substitui as variáveis no formato {{variableName}}
    let result = value;
    for (const [varName, varValue] of Object.entries(variables)) {
      const regex = new RegExp(`{{${varName}}}`, 'g');
      result = result.replace(regex, varValue);
    }
    
    return result;
  };
  

  next();
}; 