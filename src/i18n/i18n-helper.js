import { translations } from './translations.js';

export function createTranslator(language = 'pt') {
  // Verifica se o idioma é suportado, caso contrário usa o padrão
  const supportedLanguage = translations[language] ? language : 'pt';

  // Retorna a função de tradução
  return (key, customMessage = null) => {
    if (customMessage) return customMessage;
    
    const keys = key.split('.');
    let value = translations[supportedLanguage];
    
    for (const k of keys) {
      value = value?.[k];
      if (!value) return key;
    }
    
    return value;
  };
} 