/**
 * Formata texto markdown para o formato de formatação do WhatsApp
 * 
 * Converte a sintaxe markdown padrão para a formatação específica do WhatsApp:
 * - **texto** ou __texto__ para *texto* (negrito)
 * - _texto_ para _texto_ (itálico)
 * - ~~texto~~ para ~texto~ (riscado)
 * - [texto](link) para link direto
 * 
 * @param {string} text - Texto em formato markdown
 * @returns {string} - Texto formatado para WhatsApp
 */
export const formatMarkdownForWhatsApp = (text) => {
    if (!text) return text;
    
    return text
      .replace(/\*\*(.*?)\*\*/g, '*$1*') // **negrito** -> *negrito*
      .replace(/__(.*?)__/g, '*$1*')     // __negrito__ -> *negrito*
      .replace(/_(.*?)_/g, '_$1_')       // _itálico_ -> _itálico_
      .replace(/~~(.*?)~~/g, '~$1~')     // ~~riscado~~ -> ~riscado~
      .replace(/\[.*?\]\((https?:\/\/[^\s)]+)\)/g, '$1'); // [texto](link) -> link direto
};

/**
 * Converte texto formatado do WhatsApp para Markdown
 * 
 * Converte a formatação específica do WhatsApp para a sintaxe markdown padrão:
 * - *texto* para **texto** (negrito)
 * - _texto_ para _texto_ (itálico)
 * - ~texto~ para ~~texto~~ (riscado)
 * - URLs diretas para [URL](url)
 * 
 * @param {string} text - Texto formatado do WhatsApp
 * @returns {string} - Texto em formato markdown
 */
export const formatWhatsAppToMarkdown = (text) => {
    if (!text) return text;
    
    return text
        .replace(/\*([^*\n]+)\*/g, '**$1**')     // *negrito* -> **negrito**
        .replace(/_([^_\n]+)_/g, '_$1_')         // _itálico_ -> _itálico_
        .replace(/~([^~\n]+)~/g, '~~$1~~')       // ~riscado~ -> ~~riscado~~
        .replace(/(https?:\/\/[^\s]+)/g, '[$1]($1)'); // URL direta -> [URL](URL)
};
  

/**
 * Formata texto markdown para HTML
 * 
 * Converte a sintaxe markdown padrão para HTML:
 * - **texto** ou __texto__ para <strong>texto</strong> (negrito)
 * - _texto_ para <em>texto</em> (itálico)
 * - ~~texto~~ para <del>texto</del> (riscado)
 * - [texto](link) para <a href="link">texto</a>
 * 
 * @param {string} text - Texto em formato markdown
 * @returns {string} - Texto formatado em HTML
 */
export const formatMarkdownForHtml = (text) => {
    if (!text) return text;
    
    return text
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')  // **negrito** -> <strong>negrito</strong>
        .replace(/__(.*?)__/g, '<strong>$1</strong>')      // __negrito__ -> <strong>negrito</strong>
        .replace(/_(.*?)_/g, '<em>$1</em>')                // _itálico_ -> <em>itálico</em>
        .replace(/~~(.*?)~~/g, '<del>$1</del>')           // ~~riscado~~ -> <del>riscado</del>
        .replace(/\[(.*?)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>'); // [texto](link) -> <a href="link">texto</a>
};

