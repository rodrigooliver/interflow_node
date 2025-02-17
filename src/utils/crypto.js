const crypto = require('crypto-js');

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY; // Deve ser o mesmo usado no frontend

const decrypt = (ciphertext) => {
  const bytes = crypto.AES.decrypt(ciphertext, ENCRYPTION_KEY);
  return bytes.toString(crypto.enc.Utf8);
};

const encrypt = (text) => {
  return crypto.AES.encrypt(text, ENCRYPTION_KEY).toString();
};

module.exports = { encrypt, decrypt }; 


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