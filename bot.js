const TelegramBot = require('node-telegram-bot-api');
const mysql = require('mysql');
const cron = require('node-cron');
require('dotenv').config();

// Substitua pelo seu token do bot obtido do BotFather (NÃO compartilhe publicamente)
const token = process.env.TOKEN;

// Defina o ID do administrador
const adminId = 6276611317;

// Definição das variáveis globais
let defaultMessage = '🌟 A melhor lista do Telegram 🌟'; // Mensagem padrão inicial
let isWaitingForDeleteId = false; // Flag para saber se o bot está aguardando o ID para excluir
let isProcessingTotalLeads = false; // Controle de estado do processamento
let wasTotalLeadsCancelled = false; // Flag para saber se o processo de total de leads foi cancelado
let isWaitingForMessage = false; // Flag para saber se o bot está aguardando uma mensagem do admin
let isWaitingForFixTopId = false;
let isWaitingForFixBottomId = false;
let isWaitingForUnfixId = false;
const pendingRemovals = new Set();
const reportGenerationFlags = new Map(); // key: userId, value: boolean
const reportMessageIds = new Map(); // key: userId, value: messageId
const userStates = new Map(); // key: userId, value: { step: number, data: {} }






// Defina o ID do grupo de logs
const logsGroupId = -1002341744324; // Substitua pelo ID real do seu grupo de logs

// Função para formatar data e hora
const formatDateTime = (date) => {
    // Formata a data e hora no padrão brasileiro (dd/mm/aaaa hh:mm:ss)
    return date.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
};

// Conexão com o banco de dados MySQL
const db = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    charset: 'utf8mb4'
});

// Conectar ao MySQL
db.connect((err) => {
    if (err) {
        console.error('Erro ao conectar ao MySQL:', err);
        return;
    }
    console.log('Conectado ao banco de dados MySQL');
});

// Crie o bot
const bot = new TelegramBot(token, { polling: true });

// Variável global para armazenar o ID do bot
let botUserId;

// Obter o ID do bot
bot.getMe().then((botInfo) => {
    botUserId = botInfo.id;
    console.log(`Bot iniciado como @${botInfo.username} (ID: ${botUserId})`);
}).catch((err) => {
    console.error('Erro ao obter informações do bot:', err);
});

// Função para salvar informações do usuário apenas se não existir
const saveUser = (userId, userName) => {
    const checkQuery = 'SELECT COUNT(*) AS count FROM users WHERE id = ?';

    db.query(checkQuery, [userId], (err, results) => {
        if (err) {
            console.error('Erro ao verificar dados do usuário:', err);
            return;
        }

        const userExists = results[0].count > 0;

        if (!userExists) {
            const insertQuery = 'INSERT INTO users (id, name, created_at) VALUES (?, ?, NOW())';
            db.query(insertQuery, [userId, userName], (err) => {
                if (err) {
                    console.error('Erro ao salvar dados do usuário:', err);
                } else {
                    console.log(`Usuário ${userName} (${userId}) salvo com sucesso.`);
                }
            });
        } else {
            console.log(`Usuário ${userName} (${userId}) já existe no banco de dados.`);
        }
    });
};

// Variável global para armazenar o ID da última mensagem
let lastMessageId = null;

// Função para mostrar o menu principal
const showMainMenu = async (chatId, isAdmin) => {
    // Buscar o support_url do banco de dados
    const fetchSupportUrlQuery = 'SELECT setting_value FROM config WHERE setting_key = ?';
    db.query(fetchSupportUrlQuery, ['support_url'], async (err, results) => {
        if (err) {
            console.error('Erro ao buscar o URL de suporte:', err);
            var supportUrl = null;
        } else {
            var supportUrl = results.length > 0 ? results[0].setting_value : null;
        }

        let keyboard = [
            [{ text: '🔍 Explorar Grupos/Canais', callback_data: 'menu_explore' }],
            [
                { text: '📢 Meus Canais', callback_data: 'menu_my_channels' },
                { text: '👥 Meus Grupos', callback_data: 'menu_my_groups' }
            ],
            [{ text: '📝 Participar da Lista', callback_data: 'menu_join_list' }],
            [{ text: '💎 Participantes Exclusivos', callback_data: 'menu_exclusive_participants' }]
        ];

        // Adicionar o botão "Suporte" somente se o URL estiver definido
        if (supportUrl) {
            keyboard.push([{ text: '🆘 Suporte', url: supportUrl }]);
        }

        // Se o usuário for admin, adiciona o botão do painel admin no topo
        if (isAdmin) {
            keyboard.unshift([{ text: '⚙️ Painel Admin', callback_data: 'menu_admin_panel' }]);
        }

        const welcomeMessage = 'Olá! 👋 Bem-vindo ao nosso bot! 📋 *Menu Principal*';

        const messageOptions = {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: keyboard
            }
        };

        try {
            if (lastMessageId) {
                // Tente editar a última mensagem se existir
                await bot.editMessageText(welcomeMessage, {
                    chat_id: chatId,
                    message_id: lastMessageId,
                    ...messageOptions
                });
            } else {
                // Enviar uma nova mensagem se não existir
                const sentMessage = await bot.sendMessage(chatId, welcomeMessage, messageOptions);
                lastMessageId = sentMessage.message_id; // Atualiza o ID da última mensagem
            }
        } catch (error) {
            if (error.code === 'ETELEGRAM' && error.response.body.error_code === 400) {
                console.warn('Mensagem para editar não encontrada, redefinindo lastMessageId.');
                lastMessageId = null; // Redefina lastMessageId para evitar futuros erros
                // Enviar uma nova mensagem se necessário
                const sentMessage = await bot.sendMessage(chatId, welcomeMessage, messageOptions);
                lastMessageId = sentMessage.message_id; // Atualiza o ID da última mensagem
            } else {
                console.error('Erro ao mostrar o menu principal:', error);
            }
        }
    });
};

// Manipulador para o comando /start
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const chatType = msg.chat.type; // 'private', 'group', 'supergroup', 'channel'
    const userId = msg.from.id;
    const isAdmin = userId === adminId; // Verifique se é admin

    // Só executa se for uma conversa privada
    if (chatType === 'private') {
        saveUser(userId, msg.from.first_name); // Salvar usuário

        // Mostrar o menu principal
        showMainMenu(chatId, isAdmin);
    } else {
        // Não responde ao /start em grupos ou canais
        return;
    }
});

// Definição da função generateQuickReport como declaração de função
async function generateQuickReport(userId, chatId) {
    const messageId = reportMessageIds.get(userId);
    try {
        // Buscar todos os grupos/canais do banco de dados
        const fetchAllGroupsChannelsQuery = 'SELECT chat_id, name, type, user_id, is_fixed_top, is_fixed_bottom FROM groups_channels';
        db.query(fetchAllGroupsChannelsQuery, async (err, results) => {
            if (err) {
                console.error('Erro ao buscar grupos/canais:', err);
                await bot.editMessageText('⚠️ *Erro ao buscar grupos/canais.*', {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🔙 Voltar ao Painel Admin', callback_data: 'menu_admin_panel' }]
                        ]
                    }
                });
                reportGenerationFlags.set(userId, false);
                return;
            }

            if (results.length === 0) {
                await bot.editMessageText('📊 *Relatório Rápido*\nNão há grupos ou canais cadastrados.', {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🔙 Voltar ao Painel Admin', callback_data: 'menu_admin_panel' }]
                        ]
                    }
                });
                reportGenerationFlags.set(userId, false);
                return;
            }

            // Processar os resultados
            const chunkSize = 5;
            let reportChunk = [];
            let chunkCount = 0;
            const totalChunks = Math.ceil(results.length / chunkSize);

            for (let i = 0; i < results.length; i++) {
                // Verificar se o processo foi cancelado
                if (!reportGenerationFlags.get(userId)) {
                    // Editar a mensagem para indicar o cancelamento
                    await bot.editMessageText('❌ *Geração do Relatório Rápido foi cancelada.*', {
                        chat_id: chatId,
                        message_id: messageId,
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '⚙️ Voltar ao Painel Admin', callback_data: 'menu_admin_panel' }]
                            ]
                        }
                    });
                    reportMessageIds.delete(userId); // Remover o ID da mensagem do mapa
                    return;
                }

                const group = results[i];
                let exclusivo = (group.is_fixed_top || group.is_fixed_bottom) ? 'sim' : 'não';

                // Verificar se o bot é membro do grupo/canal
                let status = 'sim';
                try {
                    const chatMember = await bot.getChatMember(group.chat_id, botUserId);
                    const botStatus = chatMember.status;
                    if (botStatus === 'left' || botStatus === 'kicked') {
                        status = 'não';
                    }
                } catch (error) {
                    console.error(`Erro ao verificar status do bot no chat ${group.chat_id}:`, error.message);
                    status = 'não';
                }

                const reportLine = `*ID:* ${group.chat_id}\n*Nome:* ${group.name}\n*Tipo:* ${group.type}\n*ID do dono:* ${group.user_id}\n*Exclusivo:* ${exclusivo}\n*Status:* ${status}`;
                reportChunk.push(reportLine);

                // Adicionar ao chunk se atingir o tamanho ou for o último item
                if (reportChunk.length === chunkSize || i === results.length - 1) {
                    chunkCount++;
                    let messageText = `📊 *Relatório Rápido de Todos os Leads (${chunkCount}/${totalChunks}):*\n\n`;
                    messageText += reportChunk.join('\n\n');

                    // Determinar se é o último chunk
                    const isLastChunk = chunkCount === totalChunks;

                    // Definir as opções de teclado
                    let keyboardOptions = [];
                    if (isLastChunk) {
                        // Apenas no último chunk, adicionar o botão "🔙 Voltar ao Painel Admin"
                        keyboardOptions = [
                            [{ text: '🔙 Voltar ao Painel Admin', callback_data: 'menu_admin_panel' }]
                        ];
                    }

                    // Enviar a mensagem do chunk
                    if (keyboardOptions.length > 0) {
                        await bot.sendMessage(chatId, messageText, { 
                            parse_mode: 'Markdown',
                            reply_markup: {
                                inline_keyboard: keyboardOptions
                            }
                        });
                    } else {
                        await bot.sendMessage(chatId, messageText, { 
                            parse_mode: 'Markdown'
                        });
                    }

                    // Resetar o chunk
                    reportChunk = [];

                    // Delay para evitar rate limits (3 segundos entre mensagens)
                    await delay(3000);
                }

                // Delay entre as chamadas para evitar rate limits (200ms)
                await delay(200);
            }

            // Não enviar a mensagem de conclusão "✅ Relatório Rápido concluído com sucesso."
            // Como o botão "🔙 Voltar ao Painel Admin" já foi incluído no último chunk

            // Resetar a flag
            reportGenerationFlags.set(userId, false);
        });
    } catch (error) {
        console.error('⚠️ Erro durante a geração do Relatório Rápido:', error);
        await bot.editMessageText('⚠️ *Ocorreu um erro durante a geração do Relatório Rápido.*', {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🔙 Voltar ao Painel Admin', callback_data: 'menu_admin_panel' }]
                ]
            }
        });
        reportGenerationFlags.set(userId, false);
    }
};

async function generateCompleteReport(userId, chatId) {
    const reportKey = `${userId}_complete`;
    const messageId = reportMessageIds.get(reportKey);

    try {
        // Buscar todos os grupos/canais do banco de dados
        const fetchAllGroupsChannelsQuery = 'SELECT chat_id, name, type, user_id, is_fixed_top, is_fixed_bottom FROM groups_channels';
        db.query(fetchAllGroupsChannelsQuery, async (err, results) => {
            if (err) {
                console.error('Erro ao buscar grupos/canais:', err);
                await bot.editMessageText('⚠️ *Erro ao buscar grupos/canais.*', {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🔙 Voltar ao Painel Admin', callback_data: 'menu_admin_panel' }]
                        ]
                    }
                });
                reportGenerationFlags.set(reportKey, false);
                reportMessageIds.delete(reportKey);
                return;
            }

            if (results.length === 0) {
                await bot.editMessageText('📈 *Relatório Completo*\nNão há grupos ou canais cadastrados.', {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🔙 Voltar ao Painel Admin', callback_data: 'menu_admin_panel' }]
                        ]
                    }
                });
                reportGenerationFlags.set(reportKey, false);
                reportMessageIds.delete(reportKey);
                return;
            }

            // Processar os resultados
            const chunkSize = 5;
            let reportChunk = [];
            let chunkCount = 0;
            const totalChunks = Math.ceil(results.length / chunkSize);

            for (let i = 0; i < results.length; i++) {
                // Verificar se o processo foi cancelado
                if (!reportGenerationFlags.get(reportKey)) {
                    // Editar a mensagem para indicar o cancelamento
                    await bot.editMessageText('❌ *Geração do Relatório Completo foi cancelada.*', {
                        chat_id: chatId,
                        message_id: messageId,
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '⚙️ Voltar ao Painel Admin', callback_data: 'menu_admin_panel' }]
                            ]
                        }
                    });
                    reportGenerationFlags.set(reportKey, false);
                    reportMessageIds.delete(reportKey);
                    return;
                }

                const group = results[i];
                let exclusivo = (group.is_fixed_top || group.is_fixed_bottom) ? 'sim' : 'não';

                // Verificar se o bot é membro do grupo/canal e obter a contagem de membros atualizada
                let status = 'sim';
                let memberCount = 'N/A'; // Valor padrão caso não consiga obter a contagem
                try {
                    // Obter a contagem de membros atualizada
                    memberCount = await bot.getChatMemberCount(group.chat_id);

                    // Verificar o status do bot no chat
                    const chatMember = await bot.getChatMember(group.chat_id, botUserId);
                    const botStatus = chatMember.status;
                    if (botStatus === 'left' || botStatus === 'kicked') {
                        status = 'não';
                    }
                } catch (error) {
                    console.error(`Erro ao verificar status ou contagem de membros do chat ${group.chat_id}:`, error.message);
                    status = 'não';
                    memberCount = 'N/A';
                }

                const reportLine = `*ID:* ${group.chat_id}\n*Nome:* ${group.name}\n*Tipo:* ${group.type}\n*ID do dono:* ${group.user_id}\n*Exclusivo:* ${exclusivo}\n*Status:* ${status}\n*Total de Membros Atualizados:* ${memberCount}`;
                reportChunk.push(reportLine);

                // Adicionar ao chunk se atingir o tamanho ou for o último item
                if (reportChunk.length === chunkSize || i === results.length - 1) {
                    chunkCount++;
                    let messageText = `📈 *Relatório Completo de Todos os Leads (${chunkCount}/${totalChunks}):*\n\n`;
                    messageText += reportChunk.join('\n\n');

                    // Determinar se é o último chunk
                    const isLastChunk = chunkCount === totalChunks;

                    // Definir as opções de teclado
                    let keyboardOptions = [];
                    if (isLastChunk) {
                        // Apenas no último chunk, adicionar o botão "🔙 Voltar ao Painel Admin"
                        keyboardOptions = [
                            [{ text: '🔙 Voltar ao Painel Admin', callback_data: 'menu_admin_panel' }]
                        ];
                    }

                    // Enviar a mensagem do chunk
                    if (keyboardOptions.length > 0) {
                        await bot.sendMessage(chatId, messageText, { 
                            parse_mode: 'Markdown',
                            reply_markup: {
                                inline_keyboard: keyboardOptions
                            }
                        });
                    } else {
                        await bot.sendMessage(chatId, messageText, { 
                            parse_mode: 'Markdown'
                        });
                    }

                    // Resetar o chunk
                    reportChunk = [];

                    // Delay para evitar rate limits (3 segundos entre mensagens)
                    await delay(3000);
                }

                // Delay entre as chamadas para evitar rate limits (200ms)
                await delay(200);
            }

            // Remover o ID da mensagem do mapa após a conclusão
            reportGenerationFlags.set(reportKey, false);
            reportMessageIds.delete(reportKey);
        });
    } catch (error) {
        console.error('⚠️ Erro durante a geração do Relatório Completo:', error);
        await bot.editMessageText('⚠️ *Ocorreu um erro durante a geração do Relatório Completo.*', {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🔙 Voltar ao Painel Admin', callback_data: 'menu_admin_panel' }]
                ]
            }
        });
        reportGenerationFlags.set(reportKey, false);
        reportMessageIds.delete(reportKey);
    }
}
async function generateCompleteReport(userId, chatId) {
    const reportKey = `${userId}_complete`;
    const messageId = reportMessageIds.get(reportKey);

    try {
        // Buscar todos os grupos/canais do banco de dados
        const fetchAllGroupsChannelsQuery = 'SELECT chat_id, name, type, user_id, is_fixed_top, is_fixed_bottom FROM groups_channels';
        db.query(fetchAllGroupsChannelsQuery, async (err, results) => {
            if (err) {
                console.error('Erro ao buscar grupos/canais:', err);
                await bot.editMessageText('⚠️ *Erro ao buscar grupos/canais.*', {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🔙 Voltar ao Painel Admin', callback_data: 'menu_admin_panel' }]
                        ]
                    }
                });
                reportGenerationFlags.set(reportKey, false);
                reportMessageIds.delete(reportKey);
                return;
            }

            if (results.length === 0) {
                await bot.editMessageText('📈 *Relatório Completo*\nNão há grupos ou canais cadastrados.', {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🔙 Voltar ao Painel Admin', callback_data: 'menu_admin_panel' }]
                        ]
                    }
                });
                reportGenerationFlags.set(reportKey, false);
                reportMessageIds.delete(reportKey);
                return;
            }

            // Processar os resultados
            const chunkSize = 5;
            let reportChunk = [];
            let chunkCount = 0;
            const totalChunks = Math.ceil(results.length / chunkSize);

            for (let i = 0; i < results.length; i++) {
                // Verificar se o processo foi cancelado
                if (!reportGenerationFlags.get(reportKey)) {
                    // Editar a mensagem para indicar o cancelamento
                    await bot.editMessageText('❌ *Geração do Relatório Completo foi cancelada.*', {
                        chat_id: chatId,
                        message_id: messageId,
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '⚙️ Voltar ao Painel Admin', callback_data: 'menu_admin_panel' }]
                            ]
                        }
                    });
                    reportGenerationFlags.set(reportKey, false);
                    reportMessageIds.delete(reportKey);
                    return;
                }

                const group = results[i];
                let exclusivo = (group.is_fixed_top || group.is_fixed_bottom) ? 'sim' : 'não';

                // Verificar se o bot é membro do grupo/canal e obter a contagem de membros atualizada
                let status = 'sim';
                let memberCount = 'N/A'; // Valor padrão caso não consiga obter a contagem
                try {
                    // Obter a contagem de membros atualizada
                    memberCount = await bot.getChatMemberCount(group.chat_id);

                    // Verificar o status do bot no chat
                    const chatMember = await bot.getChatMember(group.chat_id, botUserId);
                    const botStatus = chatMember.status;
                    if (botStatus === 'left' || botStatus === 'kicked') {
                        status = 'não';
                    }
                } catch (error) {
                    console.error(`Erro ao verificar status ou contagem de membros do chat ${group.chat_id}:`, error.message);
                    status = 'não';
                    memberCount = 'N/A';
                }

                const reportLine = `*ID:* ${group.chat_id}\n*Nome:* ${group.name}\n*Tipo:* ${group.type}\n*ID do dono:* ${group.user_id}\n*Exclusivo:* ${exclusivo}\n*Status:* ${status}\n*Total de Membros Atualizados:* ${memberCount}`;
                reportChunk.push(reportLine);

                // Adicionar ao chunk se atingir o tamanho ou for o último item
                if (reportChunk.length === chunkSize || i === results.length - 1) {
                    chunkCount++;
                    let messageText = `📈 *Relatório Completo de Todos os Leads (${chunkCount}/${totalChunks}):*\n\n`;
                    messageText += reportChunk.join('\n\n');

                    // Determinar se é o último chunk
                    const isLastChunk = chunkCount === totalChunks;

                    // Definir as opções de teclado
                    let keyboardOptions = [];
                    if (isLastChunk) {
                        // Apenas no último chunk, adicionar o botão "🔙 Voltar ao Painel Admin"
                        keyboardOptions = [
                            [{ text: '🔙 Voltar ao Painel Admin', callback_data: 'menu_admin_panel' }]
                        ];
                    }

                    // Enviar a mensagem do chunk
                    if (keyboardOptions.length > 0) {
                        await bot.sendMessage(chatId, messageText, { 
                            parse_mode: 'Markdown',
                            reply_markup: {
                                inline_keyboard: keyboardOptions
                            }
                        });
                    } else {
                        await bot.sendMessage(chatId, messageText, { 
                            parse_mode: 'Markdown'
                        });
                    }

                    // Resetar o chunk
                    reportChunk = [];

                    // Delay para evitar rate limits (3 segundos entre mensagens)
                    await delay(3000);
                }

                // Delay entre as chamadas para evitar rate limits (200ms)
                await delay(200);
            }

            // Remover o ID da mensagem do mapa após a conclusão
            reportGenerationFlags.set(reportKey, false);
            reportMessageIds.delete(reportKey);
        });
    } catch (error) {
        console.error('⚠️ Erro durante a geração do Relatório Completo:', error);
        await bot.editMessageText('⚠️ *Ocorreu um erro durante a geração do Relatório Completo.*', {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🔙 Voltar ao Painel Admin', callback_data: 'menu_admin_panel' }]
                ]
            }
        });
        reportGenerationFlags.set(reportKey, false);
        reportMessageIds.delete(reportKey);
    }
}

// Manipulação dos botões e callbacks
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const firstName = query.from.first_name;
    const isAdmin = userId === adminId;

    saveUser(userId, firstName);

/**
 * Edita uma mensagem existente no Telegram.
 * @param {string} text - O novo texto da mensagem.
 * @param {Array} keyboard - O teclado inline a ser exibido.
 * @param {Object} options - Opções adicionais (ex.: parse_mode).
 * @param {number} [chatIdOverride] - Opcional: ID do chat para editar.
 * @param {number} [messageIdOverride] - Opcional: ID da mensagem para editar.
 */
const editMessage = async (text, keyboard, options = {}, chatIdOverride, messageIdOverride) => {
    try {
        await bot.editMessageText(text, {
            chat_id: chatIdOverride, // Use o ID do chat passado
            message_id: messageIdOverride, // Use o ID da mensagem passada
            parse_mode: options.parse_mode || 'Markdown',
            reply_markup: {
                inline_keyboard: keyboard
            }
        });
    } catch (error) {
        if (error.response && error.response.statusCode === 400) {
            console.warn('Mensagem para editar não encontrada ou já foi editada.');
            // Opcional: Envie uma nova mensagem se a edição falhar
            const sentMessage = await bot.sendMessage(chatIdOverride, text, {
                parse_mode: options.parse_mode || 'Markdown',
                reply_markup: {
                    inline_keyboard: keyboard
                }
            });
            // Atualize o ID da última mensagem se necessário
            // lastMessageId = sentMessage.message_id; // Se estiver usando
        } else {
            console.error('Erro ao editar mensagem:', error);
        }
    }
};                   
const callbackData = query.data;
    switch (callbackData) {
        case 'menu_links':
            if (isAdmin) {
                await editMessage(
                    '📎 *Links*\nGerencie seus links personalizados.',
                    [
                        [{ text: '➕ Adicionar', callback_data: 'links_adicionar' }],
                        [{ text: '⚙️ Gerenciar', callback_data: 'links_gerenciar' }],
                        [{ text: '🔙 Voltar ao Painel Admin', callback_data: 'menu_admin_panel' }]
                    ],
                    { parse_mode: 'Markdown' },
                    chatId,
                    query.message.message_id
                );
            } else {
                answerCallback('⚠️ Acesso negado.');
            }
            break;

            case 'links_adicionar':
                if (isAdmin) {
                    // Define o estado do usuário para aguardar as informações do link
                    userStates.set(userId, { stage: 'awaiting_link_info', data: {} });
                    
                    // Mensagem de instrução com botão de cancelar
                    const addLinkInstructions = `📎 *Adicionar Link Personalizado*\n\n` +
                        `Para adicionar um link personalizado siga os passos abaixo:\n\n` +
                        `1⃣ Digite o título do link\n\n` +
                        `2⃣ Adicione uma ,\n\n` +
                        `3⃣ Digite o link iniciando sempre com https://\n\n` +
                        `4⃣ Adicione novamente uma ,\n\n` +
                        `5⃣ E por fim, digite *top* para o link ser fixado no topo, ou digite *foo* para o link ser fixado no final da lista\n\n` +
                        `💡*Exemplo:* Fixar no topo da lista: título do link, https://site.com, top\n` +
                        `💡*Exemplo:* Fixar no final da lista: título do link, https://site.com, foo`;
            
                    // Teclado inline com botão de cancelar
                    const inlineKeyboard = [
                        [{ text: '❌ Cancelar', callback_data: 'cancel_add_link' }]
                    ];
            
                    // Edita a mensagem existente com as instruções e botão de cancelar
                    await editMessage(
                        addLinkInstructions,
                        inlineKeyboard,
                        { parse_mode: 'Markdown' },
                        chatId,
                        query.message.message_id
                    );
                } else {
                    bot.answerCallbackQuery(query.id, { text: '⚠️ Acesso negado.', show_alert: true });
                }
                break;            
                
                case 'cancel_add_link':
                    if (isAdmin) {
                        // Remove o estado do usuário
                        userStates.delete(userId);
                        
                        // Código do menu de Links para retornar
                        const linksMenuMessage = '📎 *Links*\n\nGerencie seus links personalizados.';
                        const linksMenuKeyboard = [
                            [{ text: '➕ Adicionar', callback_data: 'links_adicionar' }],
                            [{ text: '⚙️ Gerenciar', callback_data: 'links_gerenciar' }],
                            [{ text: '🔙 Voltar ao Painel Admin', callback_data: 'menu_admin_panel' }]
                        ];
                        
                        // Edita a mensagem existente para retornar ao menu de Links
                        await editMessage(
                            linksMenuMessage,
                            linksMenuKeyboard,
                            { parse_mode: 'Markdown' },
                            chatId,
                            query.message.message_id
                        );
                    } else {
                        bot.answerCallbackQuery(query.id, { text: '⚠️ Acesso negado.', show_alert: true });
                    }
                    break;                                

case 'links_gerenciar':
    if (isAdmin) {
        // Buscar todos os links do banco de dados
        const fetchLinksQuery = 'SELECT * FROM links ORDER BY FIELD(position, "top", "foo"), created_at DESC';
        db.query(fetchLinksQuery, async (err, results) => {
            if (err) {
                console.error('Erro ao buscar links do banco de dados:', err);
                await editMessage(
                    '⚠️ *Erro ao buscar links do banco de dados.* Por favor, tente novamente mais tarde.',
                    [
                        [{ text: '🔙 Voltar ao Painel Admin', callback_data: 'menu_admin_panel' }]
                    ],
                    { parse_mode: 'Markdown' },
                    chatId,
                    query.message.message_id
                );
                return;
            }

            if (results.length === 0) {
                await editMessage(
                    '📎 *Links*\n\nNenhum link personalizado foi adicionado ainda.',
                    [
                        [{ text: '🔙 Voltar ao Painel Admin', callback_data: 'menu_admin_panel' }]
                    ],
                    { parse_mode: 'Markdown' },
                    chatId,
                    query.message.message_id
                );
                return;
            }

            // Construir o teclado inline com os links e botões de excluir
            const inlineKeyboard = results.map(link => {
                // Adicionar o emoji correspondente baseado na posição
                const emoji = link.position === 'top' ? '⬆️' : '⬇️';
                const buttonText = `${emoji} ${link.title}`;

                return [
                    { text: buttonText, url: link.url },
                    { text: '❌', callback_data: `links_excluir_${link.id}` }
                ];
            });

            // Adicionar o botão de voltar ao final do teclado
            inlineKeyboard.push([{ text: '🔙 Voltar ao Painel Admin', callback_data: 'menu_admin_panel' }]);

            await editMessage(
                '📎 *Links Personalizados:*\n\nClique no botão ao lado para excluir um link.',
                inlineKeyboard,
                { parse_mode: 'Markdown' },
                chatId,
                query.message.message_id
            );
        });
    } else {
        bot.answerCallbackQuery(query.id, { text: '⚠️ Acesso negado.', show_alert: true });
    }
    break;

    default:
        if (isAdmin) {
            if (callbackData.startsWith('links_excluir_')) {
                // Extrair o ID do link
                const linkId = parseInt(callbackData.split('_').pop());
    
                if (isNaN(linkId)) {
                    bot.answerCallbackQuery(query.id, { text: '⚠️ ID de link inválido.', show_alert: true });
                    return;
                }
    
                // Excluir o link do banco de dados
                const deleteLinkQuery = 'DELETE FROM links WHERE id = ?';
                db.query(deleteLinkQuery, [linkId], async (err, result) => {
                    if (err) {
                        console.error('Erro ao excluir link:', err);
                        bot.answerCallbackQuery(query.id, { text: '⚠️ Erro ao excluir o link. Por favor, tente novamente mais tarde.', show_alert: true });
                        return;
                    }
    
                    if (result.affectedRows === 0) {
                        bot.answerCallbackQuery(query.id, { text: '⚠️ Link não encontrado ou já foi excluído.', show_alert: true });
                        return;
                    }
    
                    bot.answerCallbackQuery(query.id, { text: '✅ Link excluído com sucesso!', show_alert: true });
    
                    // Atualizar a lista de links
                    const fetchLinksQuery = 'SELECT * FROM links ORDER BY FIELD(position, "top", "foo"), created_at DESC';
                    db.query(fetchLinksQuery, async (err, results) => {
                        if (err) {
                            console.error('Erro ao buscar links após exclusão:', err);
                            return;
                        }
    
                        if (results.length === 0) {
                            await editMessage(
                                '📎 *Links*\n\nNenhum link personalizado foi adicionado ainda.',
                                [
                                    [{ text: '🔙 Voltar ao Painel Admin', callback_data: 'menu_admin_panel' }]
                                ],
                                { parse_mode: 'Markdown' },
                                chatId,
                                query.message.message_id
                            );
                            return;
                        }
    
                        // Construir o teclado inline atualizado com emojis
                        const inlineKeyboard = results.map(link => {
                            const emoji = link.position === 'top' ? '⬆️' : '⬇️';
                            const buttonText = `${emoji} ${link.title}`;
                            return [
                                { text: buttonText, url: link.url },
                                { text: '❌', callback_data: `links_excluir_${link.id}` }
                            ];
                        });
    
                        // Adicionar o botão de voltar ao final do teclado
                        inlineKeyboard.push([{ text: '🔙 Voltar ao Painel Admin', callback_data: 'menu_admin_panel' }]);
    
                        // Enviar uma nova mensagem atualizada com a lista de links
                        await editMessage(
                            '📎 *Links Personalizados:*\n\nClique no botão ao lado para excluir um link.',
                            inlineKeyboard,
                            { parse_mode: 'Markdown' },
                            chatId,
                            query.message.message_id
                        );
                    });
                });
            }
            else if (callbackData.startsWith('approve_')) {
                const chatIdToApprove = callbackData.split('_').pop();
                approveGroupOrChannel(chatIdToApprove, query);
            }
            else if (callbackData.startsWith('reject_')) {
                const chatIdToReject = callbackData.split('_').pop();
                rejectGroupOrChannel(chatIdToReject, query);
            }
            else {
                bot.answerCallbackQuery(query.id, { text: '⚠️ Opção inválida.', show_alert: true });
            }
        } else {
            bot.answerCallbackQuery(query.id, { text: 'Acesso negado.', show_alert: true });
        }
        break;       

        case 'menu_relatorio_completo':
            if (isAdmin) {
                // Chave composta para Relatório Completo
                const reportKey = `${userId}_complete`;

                // Verificar se já está gerando um relatório completo para evitar execuções paralelas
                if (reportGenerationFlags.get(reportKey)) {
                    bot.answerCallbackQuery(query.id, { text: '⚠️ Um relatório completo já está sendo gerado.', show_alert: true });
                    return;
                }

                // Definir a flag indicando que o relatório completo está sendo gerado
                reportGenerationFlags.set(reportKey, true);

                // Editar a mensagem existente com a mensagem inicial e botão de cancelamento
                const initialMessage = '📈 *Relatório Completo* está sendo gerado... Por favor, aguarde.';
                const initialOptions = {
                    chat_id: chatId,
                    message_id: query.message.message_id, // Editar a mensagem original
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '❌ Cancelar', callback_data: 'cancel_relatorio_completo' }]
                        ]
                    }
                };

                // Editar a mensagem existente
                await bot.editMessageText(initialMessage, initialOptions);

                // Armazenar o ID da mensagem específica do relatório completo
                reportMessageIds.set(reportKey, query.message.message_id);

                // Iniciar a geração do relatório completo de forma assíncrona
                generateCompleteReport(userId, chatId);
            } else {
                bot.answerCallbackQuery(query.id, { text: '⚠️ Acesso negado.', show_alert: true });
            }
            break;

        case 'cancel_relatorio_completo':
            if (isAdmin) {
                // Chave composta para Relatório Completo
                const reportKey = `${userId}_complete`;

                const isGenerating = reportGenerationFlags.get(reportKey);
                if (isGenerating) {
                    // Cancelar o processo
                    reportGenerationFlags.set(reportKey, false);

                    // Informar o usuário que o cancelamento está em andamento
                    bot.answerCallbackQuery(query.id, { text: 'O relatório completo está sendo cancelado...', show_alert: false });

                    // A função generateCompleteReport lidará com a edição da mensagem
                } else {
                    // Se não estiver gerando, apenas retornar ao painel
                    await editMessage('❌ *Nenhum relatório completo está sendo gerado.*', [
                        [{ text: '⚙️ Voltar ao Painel Admin', callback_data: 'menu_admin_panel' }]
                    ], { parse_mode: 'Markdown' }, chatId, query.message.message_id);
                }
            } else {
                bot.answerCallbackQuery(query.id, { text: '⚠️ Acesso negado.', show_alert: true });
            }
            break;

        case 'menu_relatorio_rapido':
    if (isAdmin) {
        // Verificar se já está gerando um relatório para evitar execuções paralelas
        if (reportGenerationFlags.get(userId)) {
            bot.answerCallbackQuery(query.id, { text: '⚠️ Um relatório já está sendo gerado.', show_alert: true });
            return;
        }

        // Definir a flag indicando que o relatório está sendo gerado
        reportGenerationFlags.set(userId, true);

        // Editar a mensagem existente com a mensagem inicial e botão de cancelamento
        const initialMessage = '📊 *Relatório Rápido* está sendo gerado... Por favor, aguarde.';
        const initialOptions = {
            chat_id: chatId,
            message_id: lastMessageId,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '❌ Cancelar', callback_data: 'cancel_relatorio_rapido' }]
                ]
            }
        };

        // Editar a mensagem existente
        await bot.editMessageText(initialMessage, initialOptions);

        // Armazenar o ID da mensagem específica do relatório
        reportMessageIds.set(userId, lastMessageId);

        // Iniciar a geração do relatório de forma assíncrona
        generateQuickReport(userId, chatId);

    } else {
        bot.answerCallbackQuery(query.id, { text: '⚠️ Acesso negado.', show_alert: true });
    }
    break;

    case 'cancel_relatorio_rapido':
    if (isAdmin) {
        const isGenerating = reportGenerationFlags.get(userId);
        if (isGenerating) {
            // Cancelar o processo
            reportGenerationFlags.set(userId, false);

            // Informar o usuário que o cancelamento está em andamento
            bot.answerCallbackQuery(query.id, { text: 'O relatório está sendo cancelado...', show_alert: false });

            // Não editar a mensagem aqui; a função generateQuickReport irá lidar com isso
        } else {
            // Se não estiver gerando, apenas retornar ao painel
            await editMessage('❌ *Nenhum relatório está sendo gerado.*', [
                [{ text: '⚙️ Voltar ao Painel Admin', callback_data: 'menu_admin_panel' }]
            ], { parse_mode: 'Markdown' });
        }
    } else {
        bot.answerCallbackQuery(query.id, { text: '⚠️ Acesso negado.', show_alert: true });
    }
    break;


        case 'menu_fixar_topo':
    if (isAdmin) {
        isWaitingForFixTopId = true; // Define que está aguardando o ID para fixar no topo
        await editMessage('📌 *Fixar Grupo/Canal no Topo*\nPor favor, envie o *ID* do grupo ou canal que deseja fixar no topo.', [
            [{ text: '❌ Cancelar', callback_data: 'cancel_fixar_topo' }]
        ]);
    } else {
        bot.answerCallbackQuery(query.id, { text: 'Acesso negado.', show_alert: true });
    }
    break;

case 'menu_fixar_final':
    if (isAdmin) {
        isWaitingForFixBottomId = true; // Define que está aguardando o ID para fixar no final
        await editMessage('📌 *Fixar Grupo/Canal no Final*\nPor favor, envie o *ID* do grupo ou canal que deseja fixar no final.', [
            [{ text: '❌ Cancelar', callback_data: 'cancel_fixar_final' }]
        ]);
    } else {
        bot.answerCallbackQuery(query.id, { text: 'Acesso negado.', show_alert: true });
    }
    break;

case 'cancel_fixar_topo':
    if (isAdmin) {
        isWaitingForFixTopId = false; // Reseta a flag de espera
        await editMessage('❌ *Operação de fixação no topo cancelada.*', [
            [{ text: '⚙️ Voltar ao Painel Admin', callback_data: 'menu_admin_panel' }]
        ]);
    } else {
        bot.answerCallbackQuery(query.id, { text: 'Acesso negado.', show_alert: true });
    }
    break;

case 'cancel_fixar_final':
    if (isAdmin) {
        isWaitingForFixBottomId = false; // Reseta a flag de espera
        await editMessage('❌ *Operação de fixação no final cancelada.*', [
            [{ text: '⚙️ Voltar ao Painel Admin', callback_data: 'menu_admin_panel' }]
        ]);
    } else {
        bot.answerCallbackQuery(query.id, { text: 'Acesso negado.', show_alert: true });
    }
    break;

    case 'menu_desfixar':
    if (isAdmin) {
        isWaitingForUnfixId = true; // Define que está aguardando o ID para desfixar
        await editMessage('📌 *Desfixar Grupo/Canal*\nPor favor, envie o *ID* do grupo ou canal que deseja desfixar.', [
            [{ text: '❌ Cancelar', callback_data: 'cancel_desfixar' }]
        ]);
    } else {
        bot.answerCallbackQuery(query.id, { text: 'Acesso negado.', show_alert: true });
    }
    break;

case 'cancel_desfixar':
    if (isAdmin) {
        isWaitingForUnfixId = false; // Reseta a flag de espera
        await editMessage('❌ *Operação de desfixação cancelada.*', [
            [{ text: '⚙️ Voltar ao Painel Admin', callback_data: 'menu_admin_panel' }]
        ]);
    } else {
        bot.answerCallbackQuery(query.id, { text: 'Acesso negado.', show_alert: true });
    }
    break;

        case 'menu_explore':
    // Buscar grupos/canais de forma aleatória
    const fetchRandomGroupsChannelsQuery = `
        SELECT name, link FROM groups_channels 
        ORDER BY RAND() LIMIT 10`;
    
    db.query(fetchRandomGroupsChannelsQuery, async (err, results) => {
        if (err) {
            console.error('Erro ao buscar grupos/canais aleatórios:', err);
            await editMessage('⚠️ Ocorreu um erro ao buscar grupos/canais.', [
                [{ text: '🔙 Voltar ao Menu Principal', callback_data: 'main_menu' }],
            ]);
            return;
        }

        if (results.length === 0) {
            await editMessage('👥 Não há grupos ou canais disponíveis.', [
                [{ text: '🔙 Voltar ao Menu Principal', callback_data: 'main_menu' }],
            ]);
            return;
        }

        // Criar o teclado com os grupos/canais aleatórios
        const buttons = results.map(group => {
            return { text: group.name, url: group.link };
        });

        // Dividir os botões em linhas de dois botões
        const keyboard = chunkArray(buttons, 2);

        // Adicionar o botão de voltar
        keyboard.push([{ text: '🔙 Voltar ao Menu Principal', callback_data: 'main_menu' }]);

        await editMessage('📂 *Explorar Grupos/Canais*\nAqui estão alguns grupos e canais disponíveis:', keyboard);
    });
    break;

        case 'menu_my_channels':
            // Buscar canais do usuário no banco de dados
            const fetchUserChannelsQuery = 'SELECT name, link FROM groups_channels WHERE user_id = ? AND type = ?';
            db.query(fetchUserChannelsQuery, [userId, 'channel'], async (err, results) => {
                if (err) {
                    console.error('Erro ao buscar os canais do usuário:', err);
                    await bot.answerCallbackQuery(query.id, { text: 'Erro ao buscar seus canais.', show_alert: true });
                    return;
                }

                if (results.length === 0) {
                    await editMessage('📢 *Meus Canais*\nVocê não tem nenhum canal cadastrado.', [
                        [{ text: '🔙 Voltar ao Menu Principal', callback_data: 'main_menu' }],
                    ]);
                    return;
                }

                // Criar o teclado com os canais do usuário
                const buttons = results.map(channel => {
                    return { text: channel.name, url: channel.link };
                });

                // Dividir os botões em linhas de dois botões
                const keyboard = chunkArray(buttons, 2);

                // Adicionar o botão de voltar
                keyboard.push([{ text: '🔙 Voltar ao Menu Principal', callback_data: 'main_menu' }]);

                await editMessage('📢 *Meus Canais*\nAqui estão seus canais:', keyboard);
            });
            break;

        case 'menu_my_groups':
            // Buscar grupos do usuário no banco de dados
            const fetchUserGroupsQuery = 'SELECT name, link FROM groups_channels WHERE user_id = ? AND (type = ? OR type = ?)';
            db.query(fetchUserGroupsQuery, [userId, 'group', 'supergroup'], async (err, results) => {
                if (err) {
                    console.error('Erro ao buscar os grupos do usuário:', err);
                    await bot.answerCallbackQuery(query.id, { text: 'Erro ao buscar seus grupos.', show_alert: true });
                    return;
                }

                if (results.length === 0) {
                    await editMessage('👥 *Meus Grupos*\nVocê não tem nenhum grupo cadastrado.', [
                        [{ text: '🔙 Voltar ao Menu Principal', callback_data: 'main_menu' }],
                    ]);
                    return;
                }

                // Criar o teclado com os grupos do usuário
                const buttons = results.map(group => {
                    return { text: group.name, url: group.link };
                });

                // Dividir os botões em linhas de dois botões
                const keyboard = chunkArray(buttons, 2);

                // Adicionar o botão de voltar
                keyboard.push([{ text: '🔙 Voltar ao Menu Principal', callback_data: 'main_menu' }]);

                await editMessage('👥 *Meus Grupos*\nAqui estão seus grupos:', keyboard);
            });
            break;

        case 'menu_join_list':
            await editMessage('📝 *Participar da Lista*\nEscolha uma das opções abaixo para adicionar o bot:', [
                [{ text: '➕ Adicionar Grupo', url: 'https://t.me/EvoEliteBot/?startgroup=added_as_admin&admin=post_messages+delete_messages+edit_messages+invite_users+pin_messages' }],
                [{ text: '➕ Adicionar Canal', url: 'https://t.me/EvoEliteBot/?startchannel=added_as_admin&admin=post_messages+delete_messages+edit_messages+invite_users+pin_messages' }],
                [{ text: '🔙 Voltar ao Menu Principal', callback_data: 'main_menu' }]
            ]);
            break;

            case 'menu_exclusive_participants':
                try {
                    // Chama as funções auxiliares para obter grupos/canais fixados no topo e no final
                    const fixedTopGroups = await getFixedGroupsChannels('top');
                    const fixedBottomGroups = await getFixedGroupsChannels('bottom');
    
                    // Criar botões para grupos/canais fixados no topo
                    let topButtons = [];
                    if (fixedTopGroups.length > 0) {
                        fixedTopGroups.forEach(group => {
                            topButtons.push([{ text: group.name, url: group.link }]);
                        });
                    } else {
                        topButtons.push([{ text: '🔝 Nenhum grupo/canal fixado no topo', callback_data: 'no_fixed_top' }]);
                    }
    
                    // Criar botões para grupos/canais fixados no final
                    let bottomButtons = [];
                    if (fixedBottomGroups.length > 0) {
                        fixedBottomGroups.forEach(group => {
                            bottomButtons.push([{ text: group.name, url: group.link }]);
                        });
                    } else {
                        bottomButtons.push([{ text: '🔚 Nenhum grupo/canal fixado no final', callback_data: 'no_fixed_bottom' }]);
                    }
    
                    // Combinar os botões em um único teclado
                    const keyboard = [
                        ...topButtons,
                        ...bottomButtons,
                        [{ text: '🔙 Voltar ao Menu Principal', callback_data: 'main_menu' }]
                    ];
    
                    // Formatar a mensagem
                    let messageText = '💎 *Participantes Exclusivos*\n\n';
    
                    if (fixedTopGroups.length > 0) {
                        messageText += '🔝 *Grupos/Canais Fixados no Topo:*\n';
                    } else {
                        messageText += '🔝 *Nenhum grupo/canal fixado no topo.*\n';
                    }
    
                    if (fixedBottomGroups.length > 0) {
                        messageText += '🔚 *Grupos/Canais Fixados no Final:*\n';
                    } else {
                        messageText += '🔚 *Nenhum grupo/canal fixado no final.*\n';
                    }
    
                    // Envia ou edita a mensagem com os botões
                    await editMessage(messageText, keyboard, { parse_mode: 'Markdown' });
                } catch (error) {
                    console.error('Erro ao buscar participantes exclusivos:', error);
                    bot.sendMessage(chatId, '⚠️ Ocorreu um erro ao buscar os participantes exclusivos.', {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '🔙 Voltar ao Menu Principal', callback_data: 'main_menu' }]
                            ]
                        }
                    });
                }
                break;             

        case 'menu_support':
            await editMessage('🆘 *Suporte*\nEntre em contato com nosso suporte.', [
                [{ text: '🔙 Voltar ao Menu Principal', callback_data: 'main_menu' }],
            ]);
            break;

            case 'menu_admin_panel':
                if (isAdmin) {
                    await editMessage(
                        '⚙️ *Painel Admin*\nAcesso exclusivo do administrador.',
                        [
                            [
                                { text: '⚙️ Configurações', callback_data: 'menu_configuracoes' },
                                { text: '💬 Disparar Mensagens', callback_data: 'menu_send_messages' }
                            ],
                            [
                                { text: '📋 Leads Pendentes', callback_data: 'menu_leads_pendentes' },
                                { text: '🔢 Total de Leads', callback_data: 'menu_total_leads' }
                            ],
                            [
                                { text: '📌 Fixar no Topo', callback_data: 'menu_fixar_topo' },
                                { text: '📌 Fixar no Final', callback_data: 'menu_fixar_final' }
                            ],
                            [{ text: '📌 Desfixar', callback_data: 'menu_desfixar' }],
                            [
                                { text: '📊 Relatório Rápido', callback_data: 'menu_relatorio_rapido' },
                                { text: '📈 Relatório Completo', callback_data: 'menu_relatorio_completo' }
                            ],
                            [
                                { text: '📎 Links', callback_data: 'menu_links' },
                                { text: '🗑️ Excluir Grupo/Canal', callback_data: 'menu_excluir_grupo_canal' }
                            ],
                            [{ text: '🔙 Voltar ao Menu Principal', callback_data: 'main_menu' }]
                        ],
                        { parse_mode: 'Markdown' },
                        chatId,
                        query.message.message_id // Editar a mensagem onde o botão foi clicado
                    );
                } else {
                    bot.answerCallbackQuery(query.id, { text: 'Acesso negado: somente administradores podem acessar este painel.', show_alert: true });
                }
                break;                                                            

    case 'menu_excluir_grupo_canal':
    if (isAdmin) {
        isWaitingForDeleteId = true; // Define que está aguardando o ID para excluir
        await editMessage('🗑️ *Excluir Grupo/Canal*\nPor favor, envie o *ID* do grupo ou canal que deseja excluir.', [
            [{ text: '❌ Cancelar', callback_data: 'cancel_excluir_grupo_canal' }]
        ]);
    } else {
        bot.answerCallbackQuery(query.id, { text: 'Acesso negado: somente administradores podem executar esta ação.', show_alert: true });
    }
    break;

    case 'cancel_excluir_grupo_canal':
    if (isAdmin) {
        isWaitingForDeleteId = false; // Reseta a flag de espera
        await editMessage('❌ *Operação de exclusão cancelada.*', [
            [{ text: '⚙️ Voltar ao Painel Admin', callback_data: 'menu_admin_panel' }]
        ]);
    } else {
        bot.answerCallbackQuery(query.id, { text: 'Acesso negado.', show_alert: true });
    }
    break;     

// Novo case para o botão "Total de Leads"
case 'menu_total_leads':
    if (userId === adminId) {
        isProcessingTotalLeads = true; // Inicia o processamento
        wasTotalLeadsCancelled = false; // Reseta a flag de cancelamento

        await editMessage('Aguarde enquanto processamos a contagem dos membros, isso pode demorar um pouco...', [
            [{ text: '❌ Cancelar', callback_data: 'cancel_total_leads' }],
        ]);

        const fetchGroupsChannelsQuery = 'SELECT chat_id, type FROM groups_channels';

        db.query(fetchGroupsChannelsQuery, async (err, results) => {
            if (err) {
                console.error('Erro ao buscar grupos/canais:', err);
                await editMessage('⚠️ Ocorreu um erro ao buscar grupos/canais.', [
                    [{ text: '🔙 Voltar ao Painel Admin', callback_data: 'menu_admin_panel' }],
                ]);
                isProcessingTotalLeads = false; // Reseta o estado de processamento
                return;
            }

            const totalLeads = results.length; // Total de grupos/canais
            let totalMembersGroups = 0; // Total de membros dos grupos
            let totalMembersChannels = 0; // Total de membros dos canais
            let totalGroups = 0; // Total de grupos
            let totalChannels = 0; // Total de canais

            // Atualizar a contagem de membros
            for (const group of results) {
                if (!isProcessingTotalLeads) break; // Interrompe o processamento se cancelado

                try {
                    const memberCount = await bot.getChatMemberCount(group.chat_id);
                    console.log(`Grupo/Canal ${group.chat_id} tem ${memberCount} membros.`);

                    // Contabiliza grupos e canais
                    if (group.type === 'group' || group.type === 'supergroup') {
                        totalGroups++;
                        totalMembersGroups += memberCount; // Adiciona aos grupos
                    } else if (group.type === 'channel') {
                        totalChannels++;
                        totalMembersChannels += memberCount; // Adiciona aos canais
                    }
                } catch (error) {
                    // Se ocorrer um erro ao obter a contagem de membros, logue e continue
                    console.error(`Erro ao obter contagem de membros para ${group.chat_id}:`, error.message);
                }
                await new Promise(resolve => setTimeout(resolve, 1000)); // Delay de 1 segundo entre as consultas
            }

            // Verifique se o processo foi cancelado antes de enviar o resumo
            if (!wasTotalLeadsCancelled) {
                // Enviar mensagem com o total de leads e membros
                await editMessage(`Aqui está o total de grupos/canais aprovados, total de leads e a soma total de ambos:\n\n` +
                    `🗣 Grupos Aprovados: ${totalGroups}\n` +
                    `👁 Leads dos grupos: ${totalMembersGroups}\n\n` +
                    `🔊 Canais Aprovados: ${totalChannels}\n` +
                    `👁 Leads dos canais: ${totalMembersChannels}\n\n` +
                    `📊 Total de Aprovados: ${totalGroups + totalChannels}\n` +
                    `👁 Total de Leads: ${totalMembersGroups + totalMembersChannels}`, [
                        [{ text: '🔙 Voltar ao Painel Admin', callback_data: 'menu_admin_panel' }],
                    ]);
            }

            isProcessingTotalLeads = false; // Reseta o estado de processamento após finalizar
        });
    } else {
        bot.answerCallbackQuery(query.id, { text: 'Acesso negado: somente administradores podem acessar esta opção.', show_alert: true });
    }
    break;

    case 'cancel_total_leads':
        if (userId === adminId) {
            isProcessingTotalLeads = false; // Define a flag para parar o processamento
            wasTotalLeadsCancelled = true; // Indica que o processo foi cancelado
    
            // Editar a mensagem de processamento para indicar cancelamento
            await editMessage('❌ *Processo de contagem de membros cancelado.*', [
                [{ text: '⚙️ Voltar ao Painel Admin', callback_data: 'menu_admin_panel' }]
            ]);
    
            // Opcional: Você pode também remover a mensagem de processamento anterior
            // ou enviar uma nova mensagem para o painel admin
            // await showMainMenu(chatId, true); // Se preferir retornar imediatamente
        } else {
            bot.answerCallbackQuery(query.id, { text: 'Acesso negado.', show_alert: true });
        }
        break;    

            case 'cancel_send':
                if (isAdmin) {
                    isWaitingForMessage = false; // Reseta a flag de espera
                    await editMessage('🔙 *Envio cancelado. Retornando ao Painel Admin...*', [
                        [{ text: '⚙️ Voltar ao Painel Admin', callback_data: 'menu_admin_panel' }]
                    ]);
                } else {
                    bot.answerCallbackQuery(query.id, { text: 'Acesso negado.', show_alert: true });
                }
                break;
    
                case 'menu_configuracoes':
                    // Verifica se o usuário é o administrador
                    if (isAdmin) {
                        try {
                            // Obter os valores de configuração do banco de dados
                            const { limit, minMembers } = await getConfigValues();
                            
                            // Compor a mensagem com os valores atuais
                            const configuracoesMessage = `Aqui estão alguns comandos que você pode utilizar:\n\n` +
                                `/limit 10 irá exibir no máximo 10 grupos, você pode definir o número que quiser.\n` +
                                `Limite Atual: *${limit}*\n\n` +
                                `/min 100 irá definir o número mínimo de usuários que o grupo precisa ter para participar da lista.\n` +
                                `Mínimo Atual: *${minMembers}*\n\n` +
                                `/support https:// irá definir qual a url de suporte.\n\n` +
                                `Para garantir uma produtividade maior você pode combinar comandos por exemplo: /limit 10 /min 100 /support url`;
                            
                            // Enviar a mensagem com o teclado inline
                            await editMessage(configuracoesMessage, [
                                [{ text: '🔙 Voltar ao Menu Principal', callback_data: 'menu_admin_panel' }],
                            ], { parse_mode: 'Markdown' });
                        } catch (error) {
                            console.error('Erro ao obter configurações:', error);
                            await editMessage('⚠️ *Ocorreu um erro ao obter as configurações.*', [
                                [{ text: '🔙 Voltar ao Menu Principal', callback_data: 'menu_admin_panel' }],
                            ], { parse_mode: 'Markdown' });
                        }
                    } else {
                        bot.answerCallbackQuery(query.id, { text: 'Acesso negado.', show_alert: true });
                    }
                    break;
                               
                    case 'menu_send_messages':
                    if (isAdmin) {
                        isWaitingForMessage = true; // Define que está aguardando uma mensagem do admin
                        await editMessage('📝 *Por favor, escreva a mensagem que deseja disparar para os usuários.*', [
                            [{ text: '❌ Cancelar', callback_data: 'cancel_send' }]
                        ]);
                    } else {
                        bot.answerCallbackQuery(query.id, { text: 'Acesso negado: somente administradores podem enviar mensagens.', show_alert: true });
                    }
                    break;
                
                            case 'cancel_send':
                                if (isAdmin) {
                                    isWaitingForMessage = false; // Reseta a flag de espera
                                    await editMessage('🔙 *Envio cancelado. Retornando ao Painel Admin...*', [
                                        [{ text: '⚙️ Voltar ao Painel Admin', callback_data: 'menu_admin_panel' }]
                                    ]);
                                } else {
                                    bot.answerCallbackQuery(query.id, { text: 'Acesso negado.', show_alert: true });
                                }
                                break;
                    
            case 'menu_leads_pendentes':
                if (isAdmin) {
                    const fetchPendingQuery = 'SELECT * FROM groups_channels_pending';
                    db.query(fetchPendingQuery, async (err, results) => {
                        if (err) {
                            console.error('Erro ao buscar grupos/canais pendentes:', err);
                            await bot.answerCallbackQuery(query.id, { text: 'Erro ao buscar grupos/canais pendentes.', show_alert: true });
                            return;
                        }
    
                        if (results.length === 0) {
                            await editMessage('📋 *Leads Pendentes*\nNão há grupos ou canais pendentes no momento.', [
                                [{ text: '🔙 Voltar ao Painel Admin', callback_data: 'menu_admin_panel' }]
                            ]);
                            return;
                        }
    
                        // Limitar o número de itens exibidos (opcional)
                        const MAX_ITEMS = 10;
                        const totalItems = results.length;
                        const itemsToShow = results.slice(0, MAX_ITEMS);
    
                        // Cria um teclado inline com os grupos/canais pendentes
                        const keyboard = [];
    
                        itemsToShow.forEach((group) => {
                            keyboard.push([
                                {
                                    text: group.name,
                                    url: group.link
                                },
                                {
                                    text: '✅',
                                    callback_data: `approve_${group.chat_id}`
                                },
                                {
                                    text: '❌',
                                    callback_data: `reject_${group.chat_id}`
                                }
                            ]);
                        });
    
                        // Adiciona o botão de voltar
                        keyboard.push([{ text: '🔙 Voltar ao Painel Admin', callback_data: 'menu_admin_panel' }]);
    
                        let messageText = '📋 *Leads Pendentes*\nSelecione um grupo ou canal para aprovar ou rejeitar:';
                        if (totalItems > MAX_ITEMS) {
                            messageText += `\n\nMostrando os primeiros ${MAX_ITEMS} de ${totalItems} itens pendentes.`;
                        }
    
                        await editMessage(messageText, keyboard);
                    });
                } else {
                    bot.answerCallbackQuery(query.id, { text: 'Acesso negado.', show_alert: true });
                }
                break;

                case 'main_menu':
            await showMainMenu(query.message.chat.id, isAdmin);
            break;
    }
});

// Função para aprovar um grupo/canal
const approveGroupOrChannel = (chatId, query) => {
    const selectQuery = 'SELECT * FROM groups_channels_pending WHERE chat_id = ?';
    db.query(selectQuery, [chatId], (err, results) => {
        if (err) {
            console.error('Erro ao selecionar grupo/canal pendente:', err);
            return;
        }

        if (results.length === 0) return;

        const groupData = results[0];

        // Atualizar o member_count antes de aprovar
        bot.getChatMemberCount(chatId).then(memberCount => {
            const insertQuery = `
                INSERT INTO groups_channels (chat_id, name, type, user_id, member_count, link, display_count, created_at, updated_at) 
                VALUES (?, ?, ?, ?, ?, ?, 0, NOW(), NOW()) 
                ON DUPLICATE KEY UPDATE 
                    name = VALUES(name), 
                    type = VALUES(type), 
                    user_id = VALUES(user_id), 
                    member_count = VALUES(member_count), 
                    link = VALUES(link), 
                    updated_at = VALUES(updated_at)
            `;
            db.query(insertQuery, [
                groupData.chat_id,
                groupData.name,
                groupData.type,
                groupData.user_id,
                memberCount,
                groupData.link
            ], (err) => {
                if (err) {
                    console.error('Erro ao inserir grupo/canal aprovado:', err);
                    return;
                }

                // Remover da tabela pendente
                const deleteQuery = 'DELETE FROM groups_channels_pending WHERE chat_id = ?';
                db.query(deleteQuery, [chatId], (err) => {
                    if (err) console.error('Erro ao remover grupo/canal pendente:', err);

                    // Atualizar a lista de pendências sem mensagem adicional
                    query.data = 'menu_leads_pendentes';
                    bot.emit('callback_query', query);
                });
            });
        }).catch(err => {
            console.error('Erro ao obter a contagem de membros do grupo/canal:', err);
        });
    });
};

// Função para rejeitar um grupo/canal
const rejectGroupOrChannel = (chatId, query) => {
    const deleteQuery = 'DELETE FROM groups_channels_pending WHERE chat_id = ?';
    db.query(deleteQuery, [chatId], (err) => {
        if (err) {
            console.error('Erro ao rejeitar grupo/canal:', err);
            return;
        }

        // Atualizar a lista de pendências sem mensagem adicional
        query.data = 'menu_leads_pendentes';
        bot.emit('callback_query', query);
    });
};

// Processa mensagens de texto
bot.on('text', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    // Caso para fixar grupo/canal no topo
    if (isWaitingForFixTopId && userId === adminId) {
        const groupId = msg.text.trim();

        // Validação: verificar se é um número (positivo ou negativo)
        if (!/^-\d+$|^\d+$/.test(groupId)) {
            await bot.sendMessage(chatId, '⚠️ *ID inválido.* Por favor, envie um ID numérico válido ou use o botão de cancelar.', {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '❌ Cancelar', callback_data: 'cancel_fixar_topo' }]
                    ]
                }
            });
            return;
        }

        // Verificar se o grupo/canal existe no banco de dados
        const checkQuery = 'SELECT * FROM groups_channels WHERE chat_id = ?';
        db.query(checkQuery, [groupId], async (err, results) => {
            if (err) {
                console.error('Erro ao verificar o grupo/canal:', err);
                await bot.sendMessage(chatId, '⚠️ Ocorreu um erro ao verificar o grupo/canal.');
                isWaitingForFixTopId = false;
                return;
            }

            if (results.length === 0) {
                await bot.sendMessage(chatId, `❌ Nenhum grupo ou canal encontrado com o ID *${groupId}*.`, {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '⚙️ Voltar ao Painel Admin', callback_data: 'menu_admin_panel' }]
                        ]
                    }
                });
                isWaitingForFixTopId = false;
                return;
            }

            // Atualizar o grupo/canal para ser fixado no topo
            const updateQuery = 'UPDATE groups_channels SET is_fixed_top = 1, is_fixed_bottom = 0 WHERE chat_id = ?';
            db.query(updateQuery, [groupId], async (err) => {
                if (err) {
                    console.error('Erro ao fixar o grupo/canal no topo:', err);
                    await bot.sendMessage(chatId, '⚠️ Ocorreu um erro ao fixar o grupo/canal no topo.');
                    isWaitingForFixTopId = false;
                    return;
                }

                await bot.sendMessage(chatId, `✅ Grupo/Canal com ID *${groupId}* foi fixado no topo com sucesso.`, {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '⚙️ Voltar ao Painel Admin', callback_data: 'menu_admin_panel' }]
                        ]
                    }
                });
                isWaitingForFixTopId = false;
            });
        });
    }

    // Caso para fixar grupo/canal no final
    if (isWaitingForFixBottomId && userId === adminId) {
        const groupId = msg.text.trim();

        // Validação: verificar se é um número (positivo ou negativo)
        if (!/^-\d+$|^\d+$/.test(groupId)) {
            await bot.sendMessage(chatId, '⚠️ *ID inválido.* Por favor, envie um ID numérico válido ou use o botão de cancelar.', {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '❌ Cancelar', callback_data: 'cancel_fixar_final' }]
                    ]
                }
            });
            return;
        }

        // Verificar se o grupo/canal existe no banco de dados
        const checkQuery = 'SELECT * FROM groups_channels WHERE chat_id = ?';
        db.query(checkQuery, [groupId], async (err, results) => {
            if (err) {
                console.error('Erro ao verificar o grupo/canal:', err);
                await bot.sendMessage(chatId, '⚠️ Ocorreu um erro ao verificar o grupo/canal.');
                isWaitingForFixBottomId = false;
                return;
            }

            if (results.length === 0) {
                await bot.sendMessage(chatId, `❌ Nenhum grupo ou canal encontrado com o ID *${groupId}*.`, {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '⚙️ Voltar ao Painel Admin', callback_data: 'menu_admin_panel' }]
                        ]
                    }
                });
                isWaitingForFixBottomId = false;
                return;
            }

            // Atualizar o grupo/canal para ser fixado no final
            const updateQuery = 'UPDATE groups_channels SET is_fixed_top = 0, is_fixed_bottom = 1 WHERE chat_id = ?';
            db.query(updateQuery, [groupId], async (err) => {
                if (err) {
                    console.error('Erro ao fixar o grupo/canal no final:', err);
                    await bot.sendMessage(chatId, '⚠️ Ocorreu um erro ao fixar o grupo/canal no final.');
                    isWaitingForFixBottomId = false;
                    return;
                }

                await bot.sendMessage(chatId, `✅ Grupo/Canal com ID *${groupId}* foi fixado no final com sucesso.`, {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '⚙️ Voltar ao Painel Admin', callback_data: 'menu_admin_panel' }]
                        ]
                    }
                });
                isWaitingForFixBottomId = false;
            });
        });
    }

    // Caso para desfixar grupo/canal
    if (isWaitingForUnfixId && userId === adminId) {
        const groupId = msg.text.trim();

        // Validação: verificar se é um número (positivo ou negativo)
        if (!/^-\d+$|^\d+$/.test(groupId)) {
            await bot.sendMessage(chatId, '⚠️ *ID inválido.* Por favor, envie um ID numérico válido ou use o botão de cancelar.', {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '❌ Cancelar', callback_data: 'cancel_desfixar' }]
                    ]
                }
            });
            return;
        }

        // Verificar se o grupo/canal existe no banco de dados
        const checkQuery = 'SELECT * FROM groups_channels WHERE chat_id = ?';
        db.query(checkQuery, [groupId], async (err, results) => {
            if (err) {
                console.error('Erro ao verificar o grupo/canal:', err);
                await bot.sendMessage(chatId, '⚠️ Ocorreu um erro ao verificar o grupo/canal.');
                isWaitingForUnfixId = false;
                return;
            }

            if (results.length === 0) {
                await bot.sendMessage(chatId, `❌ Nenhum grupo ou canal encontrado com o ID *${groupId}*.`, {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '⚙️ Voltar ao Painel Admin', callback_data: 'menu_admin_panel' }]
                        ]
                    }
                });
                isWaitingForUnfixId = false;
                return;
            }

            const group = results[0];

            // Verificar se o grupo/canal está fixado
            if (group.is_fixed_top === 0 && group.is_fixed_bottom === 0) {
                await bot.sendMessage(chatId, `❌ O grupo/canal *${group.name}* (ID: ${groupId}) não está fixado.`, {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '⚙️ Voltar ao Painel Admin', callback_data: 'menu_admin_panel' }]
                        ]
                    }
                });
                isWaitingForUnfixId = false;
                return;
            }

            // Atualizar o grupo/canal para remover a fixação
            const updateQuery = 'UPDATE groups_channels SET is_fixed_top = 0, is_fixed_bottom = 0 WHERE chat_id = ?';
            db.query(updateQuery, [groupId], async (err) => {
                if (err) {
                    console.error('Erro ao desfixar o grupo/canal:', err);
                    await bot.sendMessage(chatId, '⚠️ Ocorreu um erro ao desfixar o grupo/canal.');
                    isWaitingForUnfixId = false;
                    return;
                }

                await bot.sendMessage(chatId, `✅ Grupo/Canal *${group.name}* (ID: ${groupId}) foi desfixado com sucesso.`, {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '⚙️ Voltar ao Painel Admin', callback_data: 'menu_admin_panel' }]
                        ]
                    }
                });
                isWaitingForUnfixId = false;
            });
        });
    }

    // Caso para envio de mensagens pelo admin
    if (isWaitingForMessage && userId === adminId) {
        const messageToSend = msg.text;
        isWaitingForMessage = false; // Reseta a flag de espera

        try {
            // Editar a mensagem original para a mensagem de recebida
            await bot.editMessageText('📝 Mensagem recebida! O envio está sendo feito para todos os usuários...', {
                chat_id: chatId,
                message_id: lastMessageId, // ID da última mensagem
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔙 Voltar ao Painel Admin', callback_data: 'menu_admin_panel' }]
                    ]
                }
            });

            // Buscar os usuários no banco de dados e enviar a mensagem
            const fetchUsersQuery = 'SELECT id FROM users';
            db.query(fetchUsersQuery, async (err, results) => {
                if (err) {
                    console.error('Erro ao buscar usuários do banco de dados:', err);
                    await bot.editMessageText('⚠️ *Ocorreu um erro ao buscar os usuários.*', {
                        chat_id: chatId,
                        message_id: lastMessageId,
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '🔙 Voltar ao Painel Admin', callback_data: 'menu_admin_panel' }]
                            ]
                        }
                    });
                    return;
                }

                // Enviar mensagens com delay de 1 segundo entre cada envio
                for (const row of results) {
                    await sendMessageToUser(row.id, messageToSend);
                    await new Promise(resolve => setTimeout(resolve, 1000)); // Delay de 1 segundo
                }

                // Mensagem de finalização do envio
                await bot.editMessageText('✅ *Todas as mensagens foram enviadas com sucesso!*', {
                    chat_id: chatId,
                    message_id: lastMessageId, // Usar o mesmo ID da mensagem editada
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🔙 Voltar ao Painel Admin', callback_data: 'menu_admin_panel' }]
                        ]
                    }
                });
            });
        } catch (error) {
            console.error('Erro ao processar envio de mensagens:', error);
            await bot.editMessageText('⚠️ *Ocorreu um erro ao processar o envio.*', {
                chat_id: chatId,
                message_id: lastMessageId,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔙 Voltar ao Painel Admin', callback_data: 'menu_admin_panel' }]
                    ]
                }
            });
        }
    }

    // Caso para exclusão de grupo/canal pelo admin
    if (isWaitingForDeleteId && userId === adminId) {
        const groupId = msg.text.trim();

        // Validação: verificar se é um número (positivo ou negativo)
        if (!/^-\d+$|^\d+$/.test(groupId)) {
            await bot.editMessageText('⚠️ *ID inválido.* Por favor, envie um ID numérico válido ou use o botão de cancelar.', {
                chat_id: chatId,
                message_id: lastMessageId,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '❌ Cancelar', callback_data: 'cancel_excluir_grupo_canal' }]
                    ]
                }
            });
            return;
        }

        // Verificar se o grupo/canal existe no banco de dados
        const checkQuery = 'SELECT * FROM groups_channels WHERE chat_id = ?';
        db.query(checkQuery, [groupId], async (err, results) => {
            if (err) {
                console.error('Erro ao verificar o grupo/canal:', err);
                await bot.editMessageText('⚠️ Ocorreu um erro ao verificar o grupo/canal.', {
                    chat_id: chatId,
                    message_id: lastMessageId,
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '⚙️ Voltar ao Painel Admin', callback_data: 'menu_admin_panel' }]
                        ]
                    }
                });
                isWaitingForDeleteId = false;
                return;
            }

            if (results.length === 0) {
                await bot.editMessageText(`❌ Nenhum grupo ou canal encontrado com o ID *${groupId}*.`, {
                    chat_id: chatId,
                    message_id: lastMessageId,
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '⚙️ Voltar ao Painel Admin', callback_data: 'menu_admin_panel' }]
                        ]
                    }
                });
                isWaitingForDeleteId = false;
                return;
            }

            const groupName = results[0].name;

            // Executar a exclusão no banco de dados
            const deleteQuery = 'DELETE FROM groups_channels WHERE chat_id = ?';
            db.query(deleteQuery, [groupId], async (err) => {
                if (err) {
                    console.error('Erro ao excluir o grupo/canal:', err);
                    await bot.editMessageText('⚠️ Ocorreu um erro ao excluir o grupo/canal.', {
                        chat_id: chatId,
                        message_id: lastMessageId,
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '⚙️ Voltar ao Painel Admin', callback_data: 'menu_admin_panel' }]
                            ]
                        }
                    });
                    isWaitingForDeleteId = false;
                    return;
                }

                // Tentar sair do grupo/canal após a exclusão
                try {
                    await bot.leaveChat(groupId);
                    console.log(`Bot saiu do grupo/canal ${groupName} (${groupId}).`);
                } catch (leaveError) {
                    console.error(`Erro ao sair do grupo/canal ${groupName} (${groupId}):`, leaveError);
                    // Notificar o administrador sobre a falha ao sair
                    await bot.editMessageText(`✅ Grupo/Canal *${groupName}* (ID: ${groupId}) foi excluído com sucesso.\n⚠️ *O bot não conseguiu sair do grupo/canal. Verifique as permissões do bot nesse grupo/canal.*`, {
                        chat_id: chatId,
                        message_id: lastMessageId,
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '⚙️ Voltar ao Painel Admin', callback_data: 'menu_admin_panel' }]
                            ]
                        }
                    });
                    isWaitingForDeleteId = false;

                    // Opcional: Notificar o grupo de logs sobre a exclusão
                    const notifyMessage = `🗑️ *Grupo/Canal Excluído:*\nNome: ${groupName}\nID: ${groupId}\n⚠️ *O bot não conseguiu sair do grupo/canal.*`;
                    bot.sendMessage(logsGroupId, notifyMessage, { parse_mode: 'Markdown' });
                    return;
                }

                // Editar a mensagem original para confirmar a exclusão e saída do bot
                await bot.editMessageText(`✅ Grupo/Canal *${groupName}* (ID: ${groupId}) foi excluído com sucesso e o bot saiu do grupo/canal.`, {
                    chat_id: chatId,
                    message_id: lastMessageId,
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '⚙️ Voltar ao Painel Admin', callback_data: 'menu_admin_panel' }]
                        ]
                    }
                });
                isWaitingForDeleteId = false;

                // Opcional: Notificar o grupo de logs sobre a exclusão
                const notifyMessageSuccess = `🗑️ *Grupo/Canal Excluído:*\nNome: ${groupName}\nID: ${groupId}`;
                bot.sendMessage(logsGroupId, notifyMessageSuccess, { parse_mode: 'Markdown' });
            });
        });
    }
});

// Função para enviar mensagem para usuários com retries
const sendMessageToUser = async (userId, message) => {
    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
        try {
            await bot.sendMessage(userId, message);
            console.log(`Mensagem "${message}" enviada para ${userId}`);
            return; // Mensagem enviada com sucesso
        } catch (err) {
            if (err.code === 'ETELEGRAM' && err.response.body.error_code === 403) {
                console.log(`Usuário ${userId} bloqueou o bot.`);

                // Remove o usuário do banco de dados ao bloquear o bot
                const deleteUserQuery = 'DELETE FROM users WHERE id = ?';
                db.query(deleteUserQuery, [userId], (err) => {
                    if (err) {
                        console.error('Erro ao remover usuário do banco de dados:', err);
                    } else {
                        console.log(`Usuário ${userId} removido do banco de dados por bloqueio.`);
                    }
                });
                return; // Para evitar novas tentativas
            } else {
                console.error(`Erro ao enviar mensagem para ${userId}:`, err);
            }
        }
        attempts++;
        await new Promise(resolve => setTimeout(resolve, 1000)); // Espera 1 segundo antes de tentar novamente
    }
};

// Evento para quando o bot é adicionado ou removido de um grupo ou canal
bot.on('my_chat_member', (msg) => {
    const chat = msg.chat;
    const chatId = chat.id;
    const newStatus = msg.new_chat_member.status;

    console.log('Evento my_chat_member acionado:');
    console.log('chatId:', chatId);
    console.log('logsGroupId:', logsGroupId);
    console.log('Comparação chatId === logsGroupId:', chatId === logsGroupId);

    // Verifica se é o grupo de logs
    if (chatId === logsGroupId) {
        console.log('O grupo de logs foi identificado. Ignorando...');
        return;
    }

    const isGroupChat = chat.type === 'group' || chat.type === 'supergroup';
    const isChannelChat = chat.type === 'channel';

    if (newStatus === 'member' || newStatus === 'administrator') {
        if (isGroupChat || isChannelChat) {
            // Obter o valor de min_members do banco de dados antes de prosseguir
            const fetchMinMembersQuery = 'SELECT setting_value FROM config WHERE setting_key = ?';
            db.query(fetchMinMembersQuery, ['min_members'], (err, configResults) => {
                if (err) {
                    console.error('Erro ao buscar min_members do banco de dados:', err);
                    bot.sendMessage(chatId, '⚠️ Erro ao verificar o número mínimo de membros.');
                    return;
                }

                // Certifique-se de que minMembers é obtido corretamente
                const minMembers = parseInt(configResults[0]?.setting_value) || 0; // Valor padrão de 0 se não definido

                setTimeout(() => {
                    // Obter informações do bot no chat
                    bot.getChatMember(chatId, botUserId).then((chatMember) => {
                        const botStatus = chatMember.status;
                        console.log(`Status do bot no chat ${chat.title}: ${botStatus}`);

                        if (isChannelChat && botStatus !== 'administrator' && botStatus !== 'creator') {
                            console.error('O bot não é administrador no canal. Não pode obter informações.');
                            bot.sendMessage(chatId, '⚠️ O bot precisa ser administrador no canal para funcionar corretamente.');
                            return;
                        }

                        // Obter a contagem atual de membros
                        bot.getChatMemberCount(chatId).then((memberCount) => {
                            proceedAfterMemberCount(memberCount, minMembers, chatId, chat, msg);
                        }).catch((err) => {
                            console.error('Erro ao obter a quantidade de membros do grupo:', err);
                            proceedAfterMemberCount(null, minMembers, chatId, chat, msg);
                        });
                    }).catch((err) => {
                        console.error('Erro ao obter informações do bot no chat:', err);
                        bot.sendMessage(chatId, '⚠️ Erro ao verificar as permissões do bot no chat.');
                    });
                }, 2000); // Atraso de 2 segundos
            });
        }
    } else if (newStatus === 'left' || newStatus === 'kicked') {
        // Verifica se a remoção está pendente (causada pelo bot)
        if (pendingRemovals.has(chatId)) {
            // Remove o chatId do Set, pois a remoção foi causada pelo bot
            pendingRemovals.delete(chatId);
            console.log(`Remoção do chat ${chat.title} (${chatId}) está pendente e foi tratada anteriormente.`);
            // Não envia a segunda notificação
            return;
        }

        console.log(`⚠️ O bot foi removido do chat ${chat.title} (${chatId}). Removendo do banco de dados.`);

        // Remover do banco de dados
        const deleteQuery = 'DELETE FROM groups_channels WHERE chat_id = ?';
        db.query(deleteQuery, [chatId], (err) => {
            if (err) {
                console.error(`❌ Erro ao remover o chat ${chatId} do banco de dados:`, err);
            } else {
                console.log(`✅ Chat ${chatId} removido do banco de dados com sucesso.`);

                // Opcional: Notificar o administrador via grupo de logs
                const notifyMessage = `🚫 *Bot Removido*\n\nO bot foi removido do chat *${chat.title}* (ID: ${chatId}) e as informações foram deletadas do banco de dados.`;
                bot.sendMessage(logsGroupId, notifyMessage, { parse_mode: 'Markdown' })
                    .then(() => {
                        console.log(`📢 Notificação enviada ao grupo de logs sobre a remoção do chat ${chat.title} (${chatId}).`);
                    })
                    .catch(err => {
                        console.error('❌ Erro ao enviar mensagem de remoção para o grupo de logs:', err);
                    });
            }
        });
    }
});



// Função para processar após obter a contagem de membros
function proceedAfterMemberCount(memberCount, minMembers, chatId, chat, msg) {
    if (memberCount !== null && memberCount < minMembers) {
        // Enviar mensagem ao grupo/canal informando sobre o mínimo de membros
        bot.sendMessage(chatId, `⚠️ Este grupo/canal não atende ao número mínimo de ${minMembers} membros para participar.`)
            .then(() => {
                // Adiciona o chatId ao Set de remoções pendentes
                pendingRemovals.add(chatId);

                // O bot sai do chat
                bot.leaveChat(chatId)
                    .then(() => {
                        console.log(`Bot saiu do grupo/canal ${chat.title} (${chatId}) por não atender ao mínimo de membros.`);
                    })
                    .catch(err => {
                        console.error('Erro ao sair do grupo/canal:', err);
                    });
            })
            .catch(err => {
                console.error('Erro ao enviar mensagem de mínimo de membros:', err);
                // Mesmo em caso de erro ao enviar a mensagem, o bot tenta sair
                pendingRemovals.add(chatId);
                bot.leaveChat(chatId)
                    .then(() => {
                        console.log(`Bot saiu do grupo/canal ${chat.title} (${chatId}) por não atender ao mínimo de membros.`);
                    })
                    .catch(err => {
                        console.error('Erro ao sair do grupo/canal:', err);
                    });
            });

        // Notificar o grupo de logs apenas uma vez
        const notifyMessage = `🚫 O grupo/canal *${chat.title}* (ID: ${chatId}) não foi adicionado por não atender ao mínimo de membros (${memberCount}/${minMembers}). O bot saiu do grupo/canal.`;
        bot.sendMessage(logsGroupId, notifyMessage, { parse_mode: 'Markdown' })
            .catch(err => {
                console.error('Erro ao notificar o grupo de logs:', err);
            });

        return;
    } else {
        const welcomeMessage = '✅ O bot foi adicionado ao grupo/canal!';
        bot.sendMessage(chatId, welcomeMessage);

        createInviteLink(chatId, 86400, 9999)
            .then(link => {
                saveGroupOrChannelInfoPending(chatId, chat.title, chat.type, msg.from.id, memberCount || 0, link);

                const adminMessage = `🔔 Novo grupo/canal pendente de aprovação:\n\n` +
                    `*Nome:* ${chat.title}\n` +
                    `*Tipo:* ${chat.type}\n` +
                    `*ID:* ${chatId}\n` +
                    `*Adicionado por:* [${msg.from.first_name}](tg://user?id=${msg.from.id})\n` +
                    `*Membros:* ${memberCount !== null ? memberCount : 'Desconhecido'}`;
                bot.sendMessage(logsGroupId, adminMessage, { parse_mode: 'Markdown' });
            });
    }
}

// Função para salvar informações pendentes do grupo ou canal
const saveGroupOrChannelInfoPending = (chatId, chatName, chatType, userId, memberCount, inviteLink) => {
    // Verifica se é o grupo de logs
    if (String(chatId) === String(logsGroupId)) {
        console.log('Tentativa de salvar o grupo de logs. Ignorando...');
        // Não salva o grupo de logs
        return;
    }

    const upsertQuery = `
        INSERT INTO groups_channels_pending (chat_id, name, type, user_id, member_count, link, created_at, updated_at) 
        VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW()) 
        ON DUPLICATE KEY UPDATE 
            name = ?, 
            type = ?, 
            user_id = ?, 
            member_count = ?, 
            link = ?, 
            updated_at = NOW()
    `;
    db.query(upsertQuery, [chatId, chatName, chatType, userId, memberCount, inviteLink, chatName, chatType, userId, memberCount, inviteLink], (err) => {
        if (err) {
            console.error('Erro ao salvar ou atualizar informações pendentes do grupo/canal:', err);
        } else {
            console.log(`Informações pendentes do ${chatType} ${chatName} (${chatId}) salvas ou atualizadas com sucesso.`);
        }
    });
};

// Função para criar um link de convite
const createInviteLink = async (chatId, expireDate, memberLimit) => {
    try {
        const inviteLink = await bot.createChatInviteLink(chatId, {
            name: 'Link Temporário',
            expire_date: Math.floor(Date.now() / 1000) + expireDate, // Data de expiração em timestamp UNIX
            member_limit: memberLimit,
        });
        console.log(`Link de convite criado: ${inviteLink.invite_link}`);
        return inviteLink.invite_link; // Retorna o link de convite
    } catch (error) {
        console.error('Erro ao criar link de convite:', error);
    }
};

// Função para salvar ou atualizar informações do grupo ou canal
const saveGroupOrChannelInfo = (chatId, chatName, chatType, userId, inviteLink) => {
    // Obtenha a contagem de membros
    bot.getChatMemberCount(chatId)
        .then(memberCount => {
            // Verifica se a contagem de membros é válida
            if (memberCount > 0) {
                // Insere ou atualiza as informações no banco de dados
                const upsertQuery = `
                    INSERT INTO groups_channels (chat_id, name, type, user_id, member_count, link, created_at, updated_at) 
                    VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW()) 
                    ON DUPLICATE KEY UPDATE 
                        name = VALUES(name), 
                        type = VALUES(type), 
                        user_id = VALUES(user_id), 
                        member_count = VALUES(member_count), 
                        link = VALUES(link), 
                        updated_at = NOW()
                `;
                db.query(upsertQuery, [chatId, chatName, chatType, userId, memberCount, inviteLink], (err) => {
                    if (err) {
                        console.error(`Erro ao salvar informações do ${chatType}:`, err);
                    } else {
                        console.log(`Informações do ${chatType} ${chatName} (${chatId}) salvas com sucesso.`);
                    }
                });
            } else {
                console.error(`Erro: Contagem de membros inválida (${memberCount}) para ${chatName} (${chatId}).`);
            }
        })
        .catch(err => {
            // Trata erros ao tentar obter a contagem de membros
            console.error(`Erro ao obter a contagem de membros para ${chatType} ${chatName} (${chatId}):`, err);
            // Tente obter informações básicas mesmo sem a contagem de membros
            saveWithoutMemberCount(chatId, chatName, chatType, userId, inviteLink);
        });
};

// Função para salvar dados sem a contagem de membros caso o `getChatMemberCount` falhe
const saveWithoutMemberCount = (chatId, chatName, chatType, userId, inviteLink) => {
    const upsertQuery = `
        INSERT INTO groups_channels (chat_id, name, type, user_id, member_count, link, created_at, updated_at) 
        VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW()) 
        ON DUPLICATE KEY UPDATE 
            name = VALUES(name), 
            type = VALUES(type), 
            user_id = VALUES(user_id), 
            link = VALUES(link), 
            updated_at = NOW()
    `;
    db.query(upsertQuery, [chatId, chatName, chatType, userId, 0, inviteLink], (err) => { // `member_count` = 0
        if (err) {
            console.error(`Erro ao salvar informações do ${chatType}:`, err);
        } else {
            console.log(`Informações básicas do ${chatType} ${chatName} (${chatId}) salvas sem contagem de membros.`);
        }
    });
};

// Função para dividir um array em sub-arrays de tamanho específico
function chunkArray(arr, size) {
    const result = [];
    for (let i = 0; i < arr.length; i += size) {
        result.push(arr.slice(i, i + size));
    }
    return result;
}

// Função para resetar o display_count
const resetDisplayCount = () => {
    const resetQuery = 'UPDATE groups_channels SET display_count = 0';
    db.query(resetQuery, (err) => {
        if (err) {
            console.error('Erro ao resetar display_count:', err);
            bot.sendMessage(logsGroupId, '⚠️ *Erro ao resetar display_count.*', { parse_mode: 'Markdown' });
        } else {
            console.log('✅ display_count resetado para todos os grupos/canais.');
            bot.sendMessage(logsGroupId, `✅ *display_count* resetado para todos os grupos/canais em ${formatDateTime(new Date())}.`, { parse_mode: 'Markdown' });
        }
    });
};

// Agendar o reset semanalmente (Domingo às 23:59)
cron.schedule('59 23 * * 0', () => {
    console.log('📅 Executando reset semanal do display_count...');
    resetDisplayCount();
}, {
    timezone: "America/Sao_Paulo"
});

// Função para iniciar o disparo (automático ou manual)
const lastSentMessageIds = {}; // Objeto para armazenar o ID da última mensagem enviada por grupo/canal

// Função auxiliar para criar delays
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Função para remover grupo/canal do banco de dados
const removeGroupFromDatabase = async (chatId) => {
    const deleteQuery = 'DELETE FROM groups_channels WHERE chat_id = ?';
    return new Promise((resolve, reject) => {
        db.query(deleteQuery, [chatId], (err) => {
            if (err) return reject(err);
            resolve();
        });
    });
};

// Função para incrementar o display_count
const incrementDisplayCount = async (chatId) => {
    try {
        await new Promise((resolve, reject) => {
            const updateQuery = 'UPDATE groups_channels SET display_count = display_count + 1 WHERE chat_id = ?';
            db.query(updateQuery, [chatId], (err) => {
                if (err) return reject(err);
                resolve();
            });
        });
        console.log(`🔼 display_count incrementado para ${chatId}.`);
    } catch (err) {
        console.error(`❌ Erro ao incrementar display_count para ${chatId}:`, err);
    }
};

// Função para selecionar botões com base no display_count
const selectButtonsForDisparo = async (minMembers, limit) => {
    try {
        // 1. Buscar grupos/canais fixados no topo
        const fixedTopGroups = await new Promise((resolve, reject) => {
            const query = `
                SELECT chat_id, name, link, is_fixed_top, is_fixed_bottom
                FROM groups_channels
                WHERE is_fixed_top = 1 AND member_count >= ?
            `;
            db.query(query, [minMembers], (err, results) => {
                if (err) return reject(err);
                resolve(results);
            });
        });

        // 2. Buscar grupos/canais fixados no final
        const fixedBottomGroups = await new Promise((resolve, reject) => {
            const query = `
                SELECT chat_id, name, link, is_fixed_top, is_fixed_bottom
                FROM groups_channels
                WHERE is_fixed_bottom = 1 AND member_count >= ?
            `;
            db.query(query, [minMembers], (err, results) => {
                if (err) return reject(err);
                resolve(results);
            });
        });

        // 3. Calcular o número de grupos/canais não fixados necessários para atingir o limite
        const nonFixedLimit = limit;

        // 4. Buscar grupos/canais não fixados ordenados por display_count
        const dynamicGroups = await new Promise((resolve, reject) => {
            const query = `
                SELECT chat_id, name, link, is_fixed_top, is_fixed_bottom
                FROM groups_channels
                WHERE is_fixed_top = 0 AND is_fixed_bottom = 0 AND member_count >= ?
                ORDER BY display_count ASC, member_count DESC
                LIMIT ?
            `;
            db.query(query, [minMembers, nonFixedLimit], (err, results) => {
                if (err) return reject(err);
                resolve(results);
            });
        });

        // 5. Combinar os grupos/canais fixados no topo, dinâmicos e fixados no final
        const allGroups = [...fixedTopGroups, ...dynamicGroups, ...fixedBottomGroups];

        // 6. Formatar os botões, adicionando a estrela nos fixados
        const buttons = allGroups.map(group => [{
            text: (group.is_fixed_top || group.is_fixed_bottom) ? '⭐ ' + group.name : group.name,
            url: group.link
        }]);

        // 7. Extrair os chat_ids dos grupos/canais dinâmicos para incrementar o display_count posteriormente
        const selectedChatIds = dynamicGroups.map(group => group.chat_id);

        return { buttons, selectedChatIds };

    } catch (err) {
        console.error('❌ Erro ao selecionar grupos/canais para botões:', err);
        return { buttons: [], selectedChatIds: [] };
    }
};

// Função para verificar se deve editar a mensagem (mantida para grupos)
const shouldEditMessage = (newText, newReplyMarkup, existingText, existingReplyMarkup) => {
    return newText !== existingText || JSON.stringify(newReplyMarkup) !== JSON.stringify(existingReplyMarkup);
};

// Função para executar o disparo das mensagens
const executeDisparo = async (messageToSend, adminChatId) => {
    // Evita execuções paralelas da função
    if (executeDisparo.isRunning) {
        console.log('🔄 Disparo já está em andamento. Abortando nova execução.');
        return;
    }
    executeDisparo.isRunning = true;

    try {
        // 1. Buscar configurações 'min_members' e 'limit'
        const configResults = await new Promise((resolve, reject) => {
            const fetchConfigQuery = 'SELECT setting_key, setting_value FROM config WHERE setting_key IN (?, ?)';
            db.query(fetchConfigQuery, ['min_members', 'limit'], (err, results) => {
                if (err) return reject(err);
                resolve(results);
            });
        });

        let minMembers = 0;
        let limit = 5; // Valor padrão caso não esteja definido

        configResults.forEach(config => {
            if (config.setting_key === 'min_members') {
                minMembers = parseInt(config.setting_value) || 0;
            }
            if (config.setting_key === 'limit') {
                limit = parseInt(config.setting_value) || 5;
            }
        });

        console.log(`📋 Configurações: min_members = ${minMembers}, limit = ${limit}`);

        // 2. Buscar todos os grupos/canais que atendem ao mínimo de membros, ordenados por display_count ascendente
        const groupsChannels = await new Promise((resolve, reject) => {
            const fetchGroupsChannelsQuery = `
                SELECT chat_id, name, link, display_count, type, user_id, last_message_id, warning_count, last_message_text, last_reply_markup
                FROM groups_channels 
                WHERE chat_id != ? AND member_count >= ?
                ORDER BY display_count ASC, member_count DESC
            `;
            db.query(fetchGroupsChannelsQuery, [logsGroupId, minMembers], (err, results) => {
                if (err) return reject(err);
                resolve(results);
            });
        });

        if (groupsChannels.length === 0) {
            console.log('🔍 Nenhum grupo ou canal encontrado para disparo.');
            await bot.sendMessage(adminChatId, '🔍 Nenhum grupo ou canal encontrado para disparo.', { parse_mode: 'Markdown' });
            return;
        }

        console.log(`🔄 Contagem de grupos/canais para disparo: ${groupsChannels.length}`);

        // 3. Espera 2 segundos antes de iniciar o disparo
        await delay(2000);
        console.log('⏳ Iniciando o disparo...');

        // 4. Iterar sobre cada grupo/canal para enviar mensagens
        for (const group of groupsChannels) {
            try {
                // 4.1. Verificar se o bot ainda está presente no grupo/canal
                const chatMember = await bot.getChatMember(group.chat_id, botUserId);
                const status = chatMember.status;

                if (status === 'left' || status === 'kicked') {
                    console.log(`🚫 Bot removido de ${group.name} (${group.chat_id}). Removendo do banco de dados.`);
                    await removeGroupFromDatabase(group.chat_id);
                    continue; // Pular para o próximo grupo/canal
                }

                // 4.2. Verificar novamente o número de membros
                const memberCount = await bot.getChatMemberCount(group.chat_id);
                console.log(`📊 ${group.name} tem ${memberCount} membros.`);

                if (memberCount < minMembers) {
                    try {
                        await bot.sendMessage(group.chat_id, `⚠️ Este grupo/canal não atende ao número mínimo de ${minMembers} membros.`);
                        console.log(`⚠️ Mensagem de aviso enviada para ${group.name} (${group.chat_id}).`);
                    } catch (err) {
                        console.error(`❌ Erro ao enviar mensagem para ${group.chat_id}:`, err);
                    }
                    await removeGroupFromDatabase(group.chat_id);
                    console.log(`🗑️ Canal ${group.name} (${group.chat_id}) removido do banco de dados devido a poucos membros.`);
                    continue; // Pular para o próximo grupo/canal
                }

                // 4.3. Selecionar os grupos/canais com menor display_count para incluir como botões
                const { buttons, selectedChatIds } = await selectButtonsForDisparo(minMembers, limit);

                if (buttons.length === 0) {
                    console.log(`⚠️ Nenhum botão disponível para incluir na mensagem para ${group.name} (${group.chat_id}).`);
                    continue; // Pular para o próximo grupo/canal
                }

                // 4.4. Verificar se é um canal ou grupo e agir de acordo
                if (group.type === 'channel') {
                    // Para canais, verificar se a mensagem anterior existe
                    const previousMessageId = group.last_message_id;
                    console.log(`🔍 Verificando mensagem anterior no canal ${group.name} (${group.chat_id}): Message ID = ${previousMessageId}`);

                    if (previousMessageId && previousMessageId > 0) {
                        // Tentar editar a mensagem anterior com conteúdo diferente para verificar existência
                        const uniqueSuffix = ' 🔍'; // Adicione um sufixo único para modificar o conteúdo
                        try {
                            const newText = group.last_message_text + uniqueSuffix;
                            await bot.editMessageText(newText, {
                                chat_id: group.chat_id,
                                message_id: previousMessageId,
                                parse_mode: 'Markdown',
                                reply_markup: {
                                    inline_keyboard: JSON.parse(group.last_reply_markup || '[]')
                                }
                            });
                            console.log(`📝 Mensagem anterior ${previousMessageId} verificada e editada em ${group.name} (${group.chat_id}).`);

                            // Após confirmar que a mensagem existe, deletá-la
                            await bot.deleteMessage(group.chat_id, previousMessageId);
                            console.log(`🗑️ Mensagem anterior ${previousMessageId} apagada de ${group.name} (${group.chat_id}).`);
                        } catch (editError) {
                            // Logar o erro de forma apropriada
                            logError(`Erro ao editar a mensagem anterior em ${group.chat_id}: ${editError.message}`, editError);

                            // Verificar se o erro indica que a mensagem não foi encontrada
                            if (
                                editError.response &&
                                editError.response.body &&
                                editError.response.body.error_code === 400
                            ) {
                                if (
                                    editError.response.body.description.includes('message to edit not found') ||
                                    editError.response.body.description.includes('MESSAGE_ID_INVALID')
                                ) {
                                    console.log(`⚠️ A mensagem anterior em ${group.name} (${group.chat_id}) já foi apagada.`);
                                    // Aplicar punição e resetar last_message_id
                                    await handleChannelMessageDeletionPunishment(group);
                                } else if (editError.response.body.description.includes('message is not modified')) {
                                    console.log(`⚠️ A mensagem anterior em ${group.name} (${group.chat_id}) já está com o conteúdo modificado.`);
                                    // Considerar a mensagem como existente e seguir o fluxo
                                } else {
                                    console.error(`❌ Erro inesperado ao editar a mensagem em ${group.chat_id}:`, editError.message);
                                }
                            } else {
                                console.error(`❌ Erro inesperado ao editar a mensagem em ${group.chat_id}:`, editError.message);
                            }
                        }
                    } else {
                        console.log(`⚠️ Não há mensagem anterior para ${group.name} (${group.chat_id}).`);
                    }
                } else if (group.type === 'group' || group.type === 'supergroup') {
                    // Para grupos, verificar se a mensagem anterior existe
                    const previousMessageId = group.last_message_id; // Agora armazenado no banco de dados
                    console.log(`🔍 Verificando mensagem anterior no grupo ${group.name} (${group.chat_id}): Message ID = ${previousMessageId}`);

                    if (previousMessageId && previousMessageId > 0) {
                        // Tentar editar a mensagem anterior com conteúdo diferente para verificar existência
                        const uniqueSuffix = ' 🔍'; // Adicione um sufixo único para modificar o conteúdo
                        try {
                            const newText = group.last_message_text + uniqueSuffix;
                            await bot.editMessageText(newText, {
                                chat_id: group.chat_id,
                                message_id: previousMessageId,
                                parse_mode: 'Markdown',
                                reply_markup: {
                                    inline_keyboard: JSON.parse(group.last_reply_markup || '[]')
                                }
                            });
                            console.log(`📝 Mensagem anterior ${previousMessageId} verificada e editada em ${group.name} (${group.chat_id}).`);

                            // Após confirmar que a mensagem existe, deletá-la
                            await bot.deleteMessage(group.chat_id, previousMessageId);
                            console.log(`🗑️ Mensagem anterior ${previousMessageId} apagada de ${group.name} (${group.chat_id}).`);
                        } catch (editError) {
                            // Logar o erro de forma apropriada
                            logError(`Erro ao editar a mensagem anterior em ${group.chat_id}: ${editError.message}`, editError);

                            // Verificar se o erro indica que a mensagem não foi encontrada
                            if (
                                editError.response &&
                                editError.response.body &&
                                editError.response.body.error_code === 400
                            ) {
                                if (
                                    editError.response.body.description.includes('message to edit not found') ||
                                    editError.response.body.description.includes('MESSAGE_ID_INVALID')
                                ) {
                                    console.log(`⚠️ A mensagem anterior em ${group.name} (${group.chat_id}) já foi apagada.`);
                                    // Aplicar punição e resetar last_message_id
                                    await handleMessageDeletionPunishment(group);
                                } else if (editError.response.body.description.includes('message is not modified')) {
                                    console.log(`⚠️ A mensagem anterior em ${group.name} (${group.chat_id}) já está com o conteúdo modificado.`);
                                    // Considerar a mensagem como existente e seguir o fluxo
                                } else {
                                    console.error(`❌ Erro inesperado ao editar a mensagem em ${group.chat_id}:`, editError.message);
                                }
                            } else {
                                console.error(`❌ Erro inesperado ao editar a mensagem em ${group.chat_id}:`, editError.message);
                            }
                        }
                    } else {
                        console.log(`⚠️ Não há mensagem anterior para ${group.name} (${group.chat_id}).`);
                    }
                } else {
                    console.log(`⚠️ Tipo de grupo/canal não suportado: ${group.type} em ${group.name} (${group.chat_id}).`);
                }

                // 4.5. Enviar a nova mensagem com os botões selecionados
                const sentMessage = await bot.sendMessage(group.chat_id, messageToSend, {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: buttons
                    }
                });

                // 4.6. Armazenar o ID da nova mensagem para futuras deleções
                if (sentMessage && sentMessage.message_id) {
                    if (group.type === 'channel') {
                        // Atualizar o last_message_id, last_message_text e last_reply_markup no banco de dados para canais
                        await new Promise((resolve, reject) => {
                            const updateQuery = 'UPDATE groups_channels SET last_message_id = ?, last_message_text = ?, last_reply_markup = ? WHERE chat_id = ?';
                            db.query(updateQuery, [sentMessage.message_id, messageToSend, JSON.stringify(buttons), group.chat_id], (err) => {
                                if (err) return reject(err);
                                resolve();
                            });
                        });
                        console.log(`✅ Mensagem enviada para ${group.name} (${group.chat_id}). ID: ${sentMessage.message_id} armazenado como last_message_id.`);
                    } else if (group.type === 'group' || group.type === 'supergroup') {
                        // Atualizar o last_message_id, last_message_text e last_reply_markup no banco de dados para grupos
                        await new Promise((resolve, reject) => {
                            const updateQuery = 'UPDATE groups_channels SET last_message_id = ?, last_message_text = ?, last_reply_markup = ? WHERE chat_id = ?';
                            db.query(updateQuery, [sentMessage.message_id, messageToSend, JSON.stringify(buttons), group.chat_id], (err) => {
                                if (err) return reject(err);
                                resolve();
                            });
                        });
                        console.log(`✅ Mensagem enviada para ${group.name} (${group.chat_id}). ID: ${sentMessage.message_id} armazenado como last_message_id.`);
                    }

                    // 4.7. Incrementar o display_count para cada grupo/canal incluído como botão
                    for (const chatId of selectedChatIds) {
                        await incrementDisplayCount(chatId);
                    }
                } else {
                    console.log(`⚠️ Mensagem não foi enviada para ${group.name} (${group.chat_id}).`);
                }

                // 4.8. Opcional: Fixar a mensagem enviada
                if (sentMessage && sentMessage.message_id) {
                    try {
                        await bot.pinChatMessage(group.chat_id, sentMessage.message_id);
                        console.log(`📌 Mensagem fixada em ${group.name} com sucesso!`);
                    } catch (pinErr) {
                        console.error(`❌ Erro ao fixar mensagem em ${group.name}:`, pinErr.message);
                    }
                }

            } catch (err) {
                console.error(`❌ Erro ao processar grupo/canal ${group.chat_id}:`, err);
                // Se o erro for devido a permissões, remover o grupo/canal
                if (err.response && err.response.statusCode === 403) {
                    console.log(`🚫 Bot não tem permissão para enviar mensagem em ${group.name} (${group.chat_id}). Removendo do banco de dados.`);
                    await removeGroupFromDatabase(group.chat_id);
                }
            }

            // 5. Espera 1,5 segundos antes de enviar para o próximo grupo/canal
            await delay(1500);
        }

        console.log('✅ Disparo concluído.');
        await bot.sendMessage(adminChatId, `✅ Disparo concluído em ${formatDateTime(new Date())}.`, { parse_mode: 'Markdown' });

    } catch (error) {
        console.error('⚠️ Erro durante o disparo:', error);
        await bot.sendMessage(adminChatId, '⚠️ Ocorreu um erro durante o disparo das mensagens.', { parse_mode: 'Markdown' });
    } finally {
        executeDisparo.isRunning = false;
    }
};

// Inicializa a flag de controle
executeDisparo.isRunning = false;

// Função para aplicar punição quando a mensagem anterior no canal foi deletada
const handleChannelMessageDeletionPunishment = async (channel) => {
    console.log(`🔔 Iniciando punição para o canal ${channel.chat_id}`);
    const chatId = channel.chat_id;
    const channelName = channel.name || 'Canal sem Nome';
    const userId = channel.user_id;
    
    // Obter o warning_count e user_id do canal
    const getWarningCountQuery = 'SELECT warning_count, user_id FROM groups_channels WHERE chat_id = ?';
    db.query(getWarningCountQuery, [chatId], async (err, results) => {
        if (err) {
            console.error('Erro ao obter warning_count do banco de dados:', err);
            return;
        }

        if (results.length === 0) {
            console.error('Canal não encontrado no banco de dados.');
            return;
        }

        let warningCount = results[0].warning_count || 0;
        const userId = results[0].user_id;
        warningCount += 1;

        // Atualizar o warning_count e resetar last_message_id no banco de dados
        const updateWarningCountQuery = 'UPDATE groups_channels SET warning_count = ?, last_message_id = NULL WHERE chat_id = ?';
        db.query(updateWarningCountQuery, [warningCount, chatId], async (err) => {
            if (err) {
                console.error('Erro ao atualizar warning_count:', err);
                return;
            }

            if (warningCount < 3) {
                // Enviar aviso ao usuário
                try {
                    await bot.sendMessage(userId, `⚠️ Atenção! A mensagem enviada pelo bot em seu canal *${channelName}* foi apagada. Esta é a sua *${warningCount}ª* advertência. Após 3 advertências, o canal será removido da lista.`, { parse_mode: 'Markdown' });
                    console.log(`⚠️ Enviado aviso de advertência ${warningCount} para o usuário ${userId} sobre o canal ${channelName} (${chatId}).`);

                    // Notificar no grupo de logs
                    await bot.sendMessage(logsGroupId, `⚠️ **Advertência Aplicada**\nCanal: *${channelName}* (ID: ${chatId})\nUsuário: \`${userId}\`\nContagem de Advertências: ${warningCount}`, { parse_mode: 'Markdown' });
                    console.log(`📢 Notificação enviada ao grupo de logs sobre a advertência no canal ${channelName} (${chatId}).`);
                } catch (sendErr) {
                    console.error(`❌ Erro ao enviar aviso para o usuário ${userId}:`, sendErr.message);
                }
            } else {
                // Remover o canal do banco de dados
                const deleteChannelQuery = 'DELETE FROM groups_channels WHERE chat_id = ?';
                db.query(deleteChannelQuery, [chatId], async (err) => {
                    if (err) {
                        console.error('Erro ao remover o canal do banco de dados:', err);
                        return;
                    }

                    // O bot sai do canal
                    try {
                        await bot.leaveChat(chatId);
                        console.log(`Bot removido do canal ${channelName} (${chatId}) após 3 advertências.`);

                        // Notificar no grupo de logs
                        await bot.sendMessage(logsGroupId, `❌ **Canal Removido**\nCanal: *${channelName}* (ID: ${chatId}) foi removido após atingir 3 advertências.`, { parse_mode: 'Markdown' });
                        console.log(`📢 Notificação enviada ao grupo de logs sobre a remoção do canal ${channelName} (${chatId}).`);
                    } catch (leaveErr) {
                        console.error('Erro ao sair do canal:', leaveErr.message);
                    }

                    // Notificar o usuário
                    try {
                        await bot.sendMessage(userId, `❌ Seu canal *${channelName}* foi removido da lista e o bot saiu do canal devido a 3 advertências.`, { parse_mode: 'Markdown' });
                        console.log(`❌ Canal ${channelName} (${chatId}) removido e bot saiu após 3 advertências.`);
                    } catch (sendErr) {
                        console.error(`❌ Erro ao enviar notificação para o usuário ${userId}:`, sendErr.message);
                    }
                });
            }
        });
    });
};

// Função para aplicar punição quando a mensagem anterior no grupo foi deletada
const handleMessageDeletionPunishment = async (group) => {
    console.log(`🔔 Iniciando punição para o grupo ${group.chat_id}`);
    const chatId = group.chat_id;
    const groupName = group.name || 'Grupo sem Nome';
    const userId = group.user_id;

    // Obter o warning_count e user_id do grupo
    const getWarningCountQuery = 'SELECT warning_count, user_id FROM groups_channels WHERE chat_id = ?';
    db.query(getWarningCountQuery, [chatId], async (err, results) => {
        if (err) {
            console.error('Erro ao obter warning_count do banco de dados:', err);
            return;
        }

        if (results.length === 0) {
            console.error('Grupo não encontrado no banco de dados.');
            return;
        }

        let warningCount = results[0].warning_count || 0;
        const userId = results[0].user_id;
        warningCount += 1;

        // Atualizar o warning_count no banco de dados
        const updateWarningCountQuery = 'UPDATE groups_channels SET warning_count = ? WHERE chat_id = ?';
        db.query(updateWarningCountQuery, [warningCount, chatId], async (err) => {
            if (err) {
                console.error('Erro ao atualizar warning_count:', err);
                return;
            }

            if (warningCount < 3) {
                // Enviar aviso ao usuário
                try {
                    await bot.sendMessage(userId, `⚠️ Atenção! A mensagem enviada pelo bot em seu grupo *${groupName}* foi apagada. Esta é a sua *${warningCount}ª* advertência. Após 3 advertências, o grupo será removido da lista.`, { parse_mode: 'Markdown' });
                    console.log(`⚠️ Enviado aviso de advertência ${warningCount} para o usuário ${userId} sobre o grupo ${groupName} (${chatId}).`);

                    // Notificar no grupo de logs
                    await bot.sendMessage(logsGroupId, `⚠️ **Advertência Aplicada**\nGrupo: *${groupName}* (ID: ${chatId})\nUsuário: \`${userId}\`\nContagem de Advertências: ${warningCount}`, { parse_mode: 'Markdown' });
                    console.log(`📢 Notificação enviada ao grupo de logs sobre a advertência no grupo ${groupName} (${chatId}).`);
                } catch (sendErr) {
                    console.error(`❌ Erro ao enviar aviso para o usuário ${userId}:`, sendErr.message);
                }
            } else {
                // Remover o grupo do banco de dados
                const deleteGroupQuery = 'DELETE FROM groups_channels WHERE chat_id = ?';
                db.query(deleteGroupQuery, [chatId], async (err) => {
                    if (err) {
                        console.error('Erro ao remover o grupo do banco de dados:', err);
                        return;
                    }

                    // O bot sai do grupo
                    try {
                        await bot.leaveChat(chatId);
                        console.log(`Bot removido do grupo ${groupName} (${chatId}) após 3 advertências.`);

                        // Notificar no grupo de logs
                        await bot.sendMessage(logsGroupId, `❌ **Grupo Removido**\nGrupo: *${groupName}* (ID: ${chatId}) foi removido após atingir 3 advertências.`, { parse_mode: 'Markdown' });
                        console.log(`📢 Notificação enviada ao grupo de logs sobre a remoção do grupo ${groupName} (${chatId}).`);
                    } catch (leaveErr) {
                        console.error('Erro ao sair do grupo:', leaveErr.message);
                    }

                    // Notificar o usuário
                    try {
                        await bot.sendMessage(userId, `❌ Seu grupo *${groupName}* foi removido da lista e o bot saiu do grupo devido a 3 advertências.`, { parse_mode: 'Markdown' });
                        console.log(`❌ Grupo ${groupName} (${chatId}) removido e bot saiu após 3 advertências.`);
                    } catch (sendErr) {
                        console.error(`❌ Erro ao enviar notificação para o usuário ${userId}:`, sendErr.message);
                    }
                });
            }
        });
    });
};

// Função para adicionar novos grupos/canais com display_count inicializado como 0
const addNewGroupOrChannel = (chatId, chatName, chatType, userId, memberCount, inviteLink) => {
    // Verifica se é o grupo de logs
    if (String(chatId) === String(logsGroupId)) {
        console.log('Tentativa de salvar o grupo de logs. Ignorando...');
        return;
    }

    // Usando uma conexão separada para não interferir na transação principal
    mysql.createConnection(dbConfig).then(async (connection) => {
        try {
            await connection.execute(`
                INSERT INTO groups_channels (chat_id, name, type, user_id, member_count, link, display_count, created_at, updated_at) 
                VALUES (?, ?, ?, ?, ?, ?, 0, NOW(), NOW()) 
                ON DUPLICATE KEY UPDATE 
                    name = VALUES(name), 
                    type = VALUES(type), 
                    user_id = VALUES(user_id), 
                    member_count = VALUES(member_count), 
                    link = VALUES(link), 
                    display_count = 0, 
                    updated_at = NOW()
            `, [chatId, chatName, chatType, userId, memberCount, inviteLink]);

            console.log(`✅ Grupo/canal ${chatName} (${chatId}) adicionado com display_count = 0.`);
        } catch (err) {
            console.error('❌ Erro ao adicionar/atualizar grupo/canal:', err);
        } finally {
            await connection.end();
        }
    }).catch(err => {
        console.error('❌ Erro ao conectar ao banco de dados para adicionar grupo/canal:', err);
    });
};

// Comando /send para disparo manual de mensagens
bot.onText(/\/send(?:\s+([\s\S]+))?/, (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const customMessage = match[1] ? match[1].trim() : null; // Mensagem personalizada

    // Verifica se o usuário é o administrador
    if (userId === adminId) {
        const messageToSend = customMessage || defaultMessage;

        bot.sendMessage(chatId, '🔄 *Iniciando o disparo manual das mensagens...*', { parse_mode: 'Markdown' })
            .then(() => {
                // Chama a função refatorada executeDisparo
                executeDisparo(messageToSend, chatId);
            })
            .catch(err => {
                console.error('❌ Erro ao enviar mensagem de confirmação de disparo:', err);
            });
    } else {
        bot.sendMessage(chatId, '⚠️ Você não tem permissão para usar este comando.');
    }
});

// Disparo automático usando a mesma lógica de disparo (a cada dia às 16:48 e 22:48)
cron.schedule('44 13,22 * * *', () => {
    console.log('📅 Executando disparo automático...');
    executeDisparo(defaultMessage, logsGroupId);
}, {
    timezone: "America/Sao_Paulo"
});

// Manipulador para o comando /limit
bot.onText(/\/limit (\d+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const limitValue = parseInt(match[1]);

    // Verifica se o usuário é o administrador
    if (userId === adminId) {
        // Atualiza o valor de 'limit' no banco de dados
        const upsertQuery = `
            INSERT INTO config (setting_key, setting_value)
            VALUES ('limit', ?)
            ON DUPLICATE KEY UPDATE
            setting_value = ?
        `;
        db.query(upsertQuery, [limitValue, limitValue], (err) => {
            if (err) {
                console.error('Erro ao atualizar o limite:', err);
                bot.sendMessage(chatId, '⚠️ Erro ao atualizar o limite.');
            } else {
                bot.sendMessage(chatId, `✅ Limite atualizado para ${limitValue} grupos/canais.`);
            }
        });
    } else {
        bot.sendMessage(chatId, '⚠️ Você não tem permissão para usar este comando.');
    }
});

// Manipulador para o comando /min
bot.onText(/\/min (\d+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const minMembersValue = parseInt(match[1]);

    // Verifica se o usuário é o administrador
    if (userId === adminId) {
        // Atualiza o valor de 'min_members' no banco de dados
        const upsertQuery = `
            INSERT INTO config (setting_key, setting_value)
            VALUES ('min_members', ?)
            ON DUPLICATE KEY UPDATE
            setting_value = ?
        `;
        db.query(upsertQuery, [minMembersValue, minMembersValue], (err) => {
            if (err) {
                console.error('Erro ao atualizar o mínimo de membros:', err);
                bot.sendMessage(chatId, '⚠️ Erro ao atualizar o mínimo de membros.');
            } else {
                bot.sendMessage(chatId, `✅ Mínimo de membros atualizado para ${minMembersValue}.`);
            }
        });
    } else {
        bot.sendMessage(chatId, '⚠️ Você não tem permissão para usar este comando.');
    }
});

// Manipulador para o comando /support
bot.onText(/\/support (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const supportUrl = match[1].trim();

    // Verifica se o usuário é o administrador
    if (userId === adminId) {
        // Atualiza o valor de 'support_url' no banco de dados
        const upsertQuery = `
            INSERT INTO config (setting_key, setting_value)
            VALUES ('support_url', ?)
            ON DUPLICATE KEY UPDATE
            setting_value = ?
        `;
        db.query(upsertQuery, [supportUrl, supportUrl], (err) => {
            if (err) {
                console.error('Erro ao atualizar o URL de suporte:', err);
                bot.sendMessage(chatId, '⚠️ Erro ao atualizar o URL de suporte.');
            } else {
                bot.sendMessage(chatId, `✅ URL de suporte atualizado para: ${supportUrl}`);
            }
        });
    } else {
        bot.sendMessage(chatId, '⚠️ Você não tem permissão para usar este comando.');
    }
});

// Comando /test_send <chat_id>
bot.onText(/\/test_send (\-?\d+)/, (msg, match) => {
    const chatId = parseInt(match[1]);
    const userId = msg.from.id;

    if (userId === adminId) {
        bot.sendMessage(chatId, 'Mensagem de teste do bot.').then(() => {
            bot.sendMessage(msg.chat.id, `✅ Mensagem enviada com sucesso para o chat ${chatId}.`);
        }).catch(err => {
            bot.sendMessage(msg.chat.id, `⚠️ Erro ao enviar mensagem para o chat ${chatId}: ${err.message}`);
            console.error(`Erro ao enviar mensagem para o chat ${chatId}:`, err);
        });
    } else {
        bot.sendMessage(msg.chat.id, '⚠️ Você não tem permissão para usar este comando.');
    }
});

// Comando /reset_display_count para o administrador
bot.onText(/\/reset_display_count/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    // Verifica se o usuário é o administrador
    if (userId === adminId) {
        // Consulta SQL para resetar o display_count de todos os grupos e canais
        const resetQuery = 'UPDATE groups_channels SET display_count = 0';

        db.query(resetQuery, (err) => {
            if (err) {
                console.error('Erro ao resetar display_count:', err);
                bot.sendMessage(chatId, '⚠️ Ocorreu um erro ao tentar resetar o display_count.');
            } else {
                console.log('✅ display_count resetado com sucesso.');
                bot.sendMessage(chatId, '✅ O campo *display_count* foi resetado com sucesso para todos os grupos/canais.', { parse_mode: 'Markdown' });

                // Opcional: Notificar o grupo de logs
                bot.sendMessage(logsGroupId, `🔄 *display_count* foi manualmente resetado por [${msg.from.first_name}](tg://user?id=${userId}).`, { parse_mode: 'Markdown' });
            }
        });
    } else {
        // Se o usuário não for o administrador, enviar uma mensagem de aviso
        bot.sendMessage(chatId, '⚠️ Você não tem permissão para executar este comando.');
    }
});

// Função para obter os valores de 'limit' e 'min_members' da tabela config
const getConfigValues = () => {
    return new Promise((resolve, reject) => {
        const query = `
            SELECT setting_key, setting_value 
            FROM config 
            WHERE setting_key IN ('limit', 'min_members')
        `;
        db.query(query, (err, results) => {
            if (err) {
                return reject(err);
            }
            
            // Inicializar valores padrão
            let limit = 10; // Valor padrão para limit
            let minMembers = 100; // Valor padrão para min_members
            
            // Iterar sobre os resultados e atribuir os valores
            results.forEach(row => {
                if (row.setting_key === 'limit') {
                    limit = parseInt(row.setting_value) || limit;
                }
                if (row.setting_key === 'min_members') {
                    minMembers = parseInt(row.setting_value) || minMembers;
                }
            });
            
            resolve({ limit, minMembers });
        });
    });
};

// Atualização dos links de convite uma hora antes do disparo automático (às 12:00 e 21:00)
cron.schedule('0 12,21 * * *', async () => {
    console.log('📅 Iniciando a atualização dos links de convite uma hora antes do disparo automático...');
    try {
        // 1. Buscar todos os grupos/canais da tabela 'groups_channels'
        const fetchGroupsChannelsQuery = 'SELECT chat_id FROM groups_channels';
        const groupsChannels = await new Promise((resolve, reject) => {
            db.query(fetchGroupsChannelsQuery, (err, results) => {
                if (err) {
                    console.error('❌ Erro ao buscar grupos/canais:', err);
                    return reject(err);
                }
                resolve(results);
            });
        });

        if (groupsChannels.length === 0) {
            console.log('🔍 Nenhum grupo/canal encontrado para atualizar os links.');
            return;
        }

        // 2. Iterar sobre cada grupo/canal para criar um novo link e atualizar no banco de dados
        for (const group of groupsChannels) {
            const chatId = group.chat_id;
            try {
                // Definir parâmetros para o novo link
                const expireDate = 86400; // 1 dia em segundos
                const memberLimit = 9999; // Limite de membros

                // Criar um novo link de convite temporário
                const newInviteLink = await createInviteLink(chatId, expireDate, memberLimit);

                if (newInviteLink) {
                    // Atualizar o campo 'link' na tabela 'groups_channels' com o novo link
                    const updateLinkQuery = 'UPDATE groups_channels SET link = ? WHERE chat_id = ?';
                    await new Promise((resolve, reject) => {
                        db.query(updateLinkQuery, [newInviteLink, chatId], (err) => {
                            if (err) {
                                console.error(`❌ Erro ao atualizar link para o grupo/canal ${chatId}:`, err);
                                return reject(err);
                            }
                            resolve();
                        });
                    });
                    console.log(`✅ Link atualizado para o grupo/canal ${chatId}`);
                } else {
                    console.warn(`⚠️ Não foi possível criar um novo link para o grupo/canal ${chatId}`);
                }
            } catch (err) {
                console.error(`❌ Erro ao atualizar link para o grupo/canal ${chatId}:`, err);
            }

            // 3. Inserir um delay de 1,5 segundos antes de processar o próximo grupo/canal
            await delay(1500); // 1500 milissegundos = 1,5 segundos
        }

        console.log('✅ Atualização dos links de convite concluída.');
    } catch (err) {
        console.error('❌ Erro ao executar a atualização dos links de convite:', err);
    }
}, {
    timezone: "America/Sao_Paulo"
});

// Função de log personalizada para diferenciar erros esperados e inesperados
const logError = (message, error) => {
    if (
        error.response &&
        error.response.body &&
        error.response.body.error_code === 400 &&
        (
            error.response.body.description.includes('message to edit not found') ||
            error.response.body.description.includes('MESSAGE_ID_INVALID')
        )
    ) {
        console.log(`⚠️ ${message}`);
    } else {
        console.error(`❌ ${message}`, error);
    }
};

// Função para obter grupos/canais fixados no topo ou no final
const getFixedGroupsChannels = (position) => {
    return new Promise((resolve, reject) => {
        let query;
        if (position === 'top') {
            query = `
                SELECT name, link 
                FROM groups_channels 
                WHERE is_fixed_top = 1 
                ORDER BY updated_at DESC
            `;
        } else if (position === 'bottom') {
            query = `
                SELECT name, link 
                FROM groups_channels 
                WHERE is_fixed_bottom = 1 
                ORDER BY updated_at DESC
            `;
        } else {
            return reject(new Error('Posição inválida para buscar grupos/canais fixados.'));
        }

        db.query(query, (err, results) => {
            if (err) {
                console.error(`Erro ao buscar grupos/canais fixados na posição ${position}:`, err);
                return reject(err);
            }
            resolve(results);
        });
    });
};

// Links
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    // Verifica se o usuário está no processo de adicionar link
    if (userStates.has(userId)) {
        const userState = userStates.get(userId);
        const text = msg.text.trim();

        if (userState.stage === 'awaiting_link_info') {
            // Processar a entrada do administrador
            // Espera o formato: título do link, https://site.com, top/foo
            const parts = text.split(',').map(part => part.trim());

            if (parts.length !== 3) {
                await bot.sendMessage(chatId, '❌ *Formato inválido.* Por favor, siga o formato: *título do link, https://site.com, top/foo*', { parse_mode: 'Markdown' });
                return;
            }

            const [title, url, position] = parts;

            // Validação do URL
            if (!/^https?:\/\/.+/.test(url)) {
                await bot.sendMessage(chatId, '❌ *URL inválida.* Certifique-se de que o link inicia com https://', { parse_mode: 'Markdown' });
                return;
            }

            // Validação da posição
            if (!['top', 'foo'].includes(position.toLowerCase())) {
                await bot.sendMessage(chatId, '❌ *Posição inválida.* Use *top* para fixar no topo ou *foo* para fixar no final.', { parse_mode: 'Markdown' });
                return;
            }

            // Inserir o link no banco de dados
            const insertLinkQuery = 'INSERT INTO links (title, url, position) VALUES (?, ?, ?)';
            db.query(insertLinkQuery, [title, url, position.toLowerCase()], async (err, result) => {
                if (err) {
                    console.error('Erro ao inserir link no banco de dados:', err);
                    await bot.sendMessage(chatId, '⚠️ *Erro ao salvar o link no banco de dados.* Por favor, tente novamente mais tarde.', { parse_mode: 'Markdown' });
                    userStates.delete(userId);
                    return;
                }

                // Remover o estado do usuário após a inserção bem-sucedida
                userStates.delete(userId);

                // Confirmar a adição do link
                const confirmationMessage = `✅ *Link adicionado com sucesso!*\n\n` +
                    `*Título:* ${title}\n` +
                    `*URL:* ${url}\n` +
                    `*Posição:* ${position.toLowerCase() === 'top' ? '⬆️ Topo' : '⬇️ Final'}`;

                // Teclado com botão de voltar
                const backButton = [
                    [{ text: '🔙 Voltar ao Menu Links', callback_data: 'menu_links' }]
                ];

                // Edita a mensagem existente com a confirmação
                await editMessage(
                    confirmationMessage,
                    backButton,
                    { parse_mode: 'Markdown' },
                    chatId,
                    msg.message_id
                );
            });
        }
    }
});

// Capturar erros de polling e mostrá-los no terminal
bot.on('polling_error', (error) => {
    console.error('[Polling Error]', error);
});

console.log('Bot iniciado e aguardando mensagens...');
