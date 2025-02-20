import crypto from 'crypto-js';

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY; // Deve ser o mesmo usado no frontend

export const encrypt = (text) => {
  // Gerar um IV aleatório
  const iv = crypto.lib.WordArray.random(16);
  
  // Criar a chave a partir da string
  const key = crypto.enc.Utf8.parse(ENCRYPTION_KEY);
  
  // Criptografar com IV
  const encrypted = crypto.AES.encrypt(text, key, {
    iv: iv,
    mode: crypto.mode.CBC,
    padding: crypto.pad.Pkcs7
  });

  // Combinar IV e texto criptografado
  const ivAndCiphertext = iv.concat(encrypted.ciphertext);
  
  // Retornar como string base64
  return crypto.enc.Base64.stringify(ivAndCiphertext);
};

export const decrypt = (ciphertext) => {
  try {
    // Converter de base64 para WordArray
    const ivAndCiphertext = crypto.enc.Base64.parse(ciphertext);
    
    // Extrair IV (primeiros 16 bytes)
    const iv = crypto.lib.WordArray.create(ivAndCiphertext.words.slice(0, 4));
    const ciphertextOnly = crypto.lib.WordArray.create(ivAndCiphertext.words.slice(4));
    
    // Criar a chave a partir da string
    const key = crypto.enc.Utf8.parse(ENCRYPTION_KEY);
    
    // Descriptografar
    const decrypted = crypto.AES.decrypt(
      { ciphertext: ciphertextOnly },
      key,
      {
        iv: iv,
        mode: crypto.mode.CBC,
        padding: crypto.pad.Pkcs7
      }
    );
    
    return decrypted.toString(crypto.enc.Utf8);
  } catch (error) {
    console.error('Erro ao descriptografar:', error);
    return null;
  }
};

// Função auxiliar para verificar se uma string está criptografada
export const isEncrypted = (text) => {
  try {
    const decoded = crypto.enc.Base64.parse(text);
    return decoded.words.length >= 4; // Pelo menos IV + algum conteúdo
  } catch {
    return false;
  }
};


// const { decrypt } = require('./utils/crypto');

// // Exemplo de uso em uma rota ou controller
// const getIntegrationCredentials = async (req, res) => {
//   // Recupera a integração do banco de dados
//   const integration = await Integration.findById(id);
  
//   // Descriptografa os campos sensíveis
//   if (integration.type === 'openai') {
//     integration.credentials.api_key = decrypt(integration.credentials.api_key);
//   } else if (integration.type === 'aws_s3') {
//     integration.credentials.access_key_id = decrypt(integration.credentials.access_key_id);
//     integration.credentials.secret_access_key = decrypt(integration.credentials.secret_access_key);
//   }
  
//   return integration;
// };