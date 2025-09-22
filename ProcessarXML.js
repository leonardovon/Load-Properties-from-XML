/**
 * dividir_e_enviar_confirmado.js
 *
 * Uso:
 *   - Ajuste API_URL e/ou defina via ENV: API_URL, XML_URL
 *   - (opcional) export BATCH_SIZE=150
 *   - (opcional) export PROCESSING_BATCH_SIZE=5
 *   - (opcional) export API_KEY="seu_token"
 *   - npm install axios
 *   - ProcessarXML.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const readline = require('readline');

// Altere aqui se quiser hardcodear
const XML_URL = process.env.XML_URL;
const API_URL = process.env.API_URL;
const API_KEY = process.env.API_KEY;

// Quantidade de Listing por arquivo/lote (padrão 150). Pode definir via ENV BATCH_SIZE
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE, 100) || 130;

// batchSize que você quer que a edge function use internamente para processar (opcional)
const PROCESSING_BATCH_SIZE = process.env.PROCESSING_BATCH_SIZE ? parseInt(process.env.PROCESSING_BATCH_SIZE, 10) : undefined;

const OUTPUT_DIR = path.join(process.cwd(), 'lotes');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

function askQuestion(rl, question) {
    return new Promise((resolve) => {
        rl.question(question, (ans) => resolve((ans || '').trim().toLowerCase()));
    });
}

async function fetchXmlText(urlOrPath) {
    // Se for caminho local válido, leia o arquivo
    if (fs.existsSync(urlOrPath) && fs.statSync(urlOrPath).isFile()) {
        return fs.readFileSync(urlOrPath, 'utf8');
    }
    // Senão, faz download HTTP
    console.log(`🌐 Fazendo download de: ${urlOrPath}`);
    const res = await axios.get(urlOrPath, { responseType: 'text', headers: { 'User-Agent': 'PropertyBatcher/1.0' } });
    return res.data;
}

(async function main() {
    try {
       
        console.log(`🔄 Obtendo XML (download ou arquivo local)...${XML_URL}`);
        const xmlText = await fetchXmlText(XML_URL);
        if (!xmlText || typeof xmlText !== 'string') throw new Error('XML vazio ou inválido.');

        // Encontra todos os blocos <Listing>...</Listing> como strings (preserva conteúdo exatamente)
        const listingRegex = /<Listing\b[^>]*>[\s\S]*?<\/Listing>/gi;
        const listingMatches = xmlText.match(listingRegex) || [];

        if (listingMatches.length === 0) {
            console.error('❌ Nenhum <Listing> encontrado no XML com a regex padrão.');
            // mostrar um trecho para debug
            console.log('--- Início do XML (500 chars) ---\n', xmlText.substring(0, 500));
            return;
        }

        console.log(`📦 Encontrados ${listingMatches.length} listings no feed.`);

        // Tenta localizar seção <Listings> ... </Listings> para manter header/footer intactos
        const openListingsMatch = xmlText.match(/<Listings\b[^>]*>/i);
        const closeListingsMatch = xmlText.match(/<\/Listings>/i);

        let headerSection = '';
        let footerSection = '';

        if (openListingsMatch && closeListingsMatch) {
            const openIdx = xmlText.search(/<Listings\b[^>]*>/i);
            const openEndIdx = xmlText.indexOf('>', openIdx) + 1; // posição logo após '>'
            const closeIdx = xmlText.search(/<\/Listings>/i);

            headerSection = xmlText.slice(0, openEndIdx); // inclui tag de abertura <Listings ...>
            footerSection = xmlText.slice(closeIdx); // inclui </Listings> e o que vem depois (fechamento do feed)
        } else {
            // fallback: cria envoltório básico (pouco provável de ser necessário)
            console.warn('⚠️ Não foi possível encontrar tag <Listings>...</Listings>. Usando fallback para montar lotes.');
            const firstListingIdx = xmlText.indexOf(listingMatches[0]);
            const lastListingIdx = xmlText.indexOf(listingMatches[listingMatches.length - 1]) + listingMatches[listingMatches.length - 1].length;
            const before = xmlText.slice(0, firstListingIdx);
            const after = xmlText.slice(lastListingIdx);
            headerSection = before + '<Listings>';
            footerSection = '</Listings>' + after;
        }

        // Preparar pasta de saída
        if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

        // Loop de geração de lotes
        const total = listingMatches.length;
        let loteIndex = 1;

        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

        for (let i = 0; i < total; i += BATCH_SIZE) {
            const batchMatches = listingMatches.slice(i, i + BATCH_SIZE);
            const batchCount = batchMatches.length;
            const startIdx = i + 1;
            const endIdx = i + batchCount;

            // Monta XML do lote preservando header/footer originais
            const batchXml = headerSection + '\n' + batchMatches.join('\n') + '\n' + footerSection;

            // Salva local
            const fileName = path.join(OUTPUT_DIR, `lote_${String(loteIndex).padStart(3, '0')}.xml`);
            fs.writeFileSync(fileName, batchXml, 'utf8');
            console.log(`💾 Lote ${loteIndex} salvo em ${fileName} (${batchCount} listings — índices ${startIdx}-${endIdx})`);

            // Pergunta confirmação
            const answer = await askQuestion(rl, `➡️ Deseja enviar o lote ${loteIndex} (${batchCount} listings, índices ${startIdx}-${endIdx}) para ${API_URL}? (s/n): `);

            if (answer === 's' || answer === 'sim') {
                console.log(`🚀 Enviando lote ${loteIndex}...`);
                try {
                    const payload = { xmlData: batchXml };
                    if (typeof PROCESSING_BATCH_SIZE === 'number') payload.batchSize = PROCESSING_BATCH_SIZE;

                    const headers = { 'Content-Type': 'application/json' };
                    if (API_KEY) headers['Authorization'] = `Bearer ${API_KEY}`;

                    const res = await axios.post(API_URL, payload, { headers, maxBodyLength: Infinity, maxContentLength: Infinity, timeout: 120000 });
                    console.log(`✅ Lote ${loteIndex} enviado — resposta:`, typeof res.data === 'object' ? JSON.stringify(res.data) : String(res.data));
                } catch (err) {
                    console.error(`❌ Erro ao enviar lote ${loteIndex}:`, err.response?.data || err.message || err);
                }
            } else {
                console.log(`⏭️ Lote ${loteIndex} pulado por usuário.`);
            }

            loteIndex++;
        }

        rl.close();
        console.log('🏁 Todos os lotes foram gerados. Processo finalizado.');
    } catch (err) {
        console.error('❌ Erro fatal:', err.message || err);
        console.error(err.stack || '');
    }
})();
