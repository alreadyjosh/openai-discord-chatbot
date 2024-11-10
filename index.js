const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
require('dotenv').config();

// MongoDB
const mongoclient_main = require('./db/mongo');
const { ObjectId } = require('mongodb');

// OpenAI
const OpenAI = require ('openai');
const openai = new OpenAI({
    "apiKey": process.env.OPENAI_APIKEY
});

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ],
    allowedMentions: {
        parse: ['users'],
        repliedUser: true,
    }
});

client.once('ready', () => {
    console.log(`Connected to Discord as ${client.user.username}`);
});

/* AI Chatbot Admin */
const contextscope = mongoclient_main.db("chatbot").collection("context_scope");

client.on('messageCreate', async (message) => {
    if(message.author.bot) return;

    // List context scope
    if(message.content.toLowerCase().startsWith(`${process.env.PREFIX}list`)) {
        if(message.author.id !== process.env.OWNER_ID) return message.reply("Missing permissions");

        try {
            const scopes = await contextscope.find({}).toArray();
            if(scopes.length === 0) return message.reply("No context scopes found.");

            const embedFields = scopes.map((scope, index) => ({
                name: `Scope #${index + 1}`,
                value: `${scope.context}\n\`${process.env.PREFIX}remove ${scope._id.toString()}\``,
                inline: false
            }));

            const embed = new EmbedBuilder()
                .setTitle("Context Scopes")
                .setDescription("List of all context scopes available.")
                .addFields(embedFields)
                .setColor("#000000")

            let response = await message.reply({ embeds: [embed] });

            setTimeout(async () => {
                await response.delete();
            }, 1000 * 30);
        } catch (error) {
            console.error('Error fetching context scopes:', error);
            await message.reply('An error occurred while fetching the context scopes.');
        }
    }

    // Add context to scope
    if(message.content.toLowerCase().startsWith(`${process.env.PREFIX}add`)) {
        if(message.author.id !== process.env.OWNER_ID) return message.reply("Missing permissions");

        const contextToAdd = message.content.slice(`${process.env.PREFIX}add`.length).trim();
        if(!contextToAdd) return message.reply("Please provide a context to add.");

        if(contextToAdd.includes(".")) return message.reply("Remove any dots from the argument.");

        try {
            await contextscope.insertOne({ "context": contextToAdd, "addedBy": { "id": message.author.id, "username": message.author.username }, "addedAt": new Date() });
            await message.reply(`Context added successfully: "${contextToAdd}"`);
        } catch (error) {
            console.error('Error adding context:', error);
            await message.reply('An error occurred while adding the context.');
        }
    }

    // Remove context from scope
    if(message.content.toLowerCase().startsWith(`${process.env.PREFIX}remove`)) {
        if(message.author.id !== process.env.OWNER_ID) return message.reply("Missing permissions");

        const contextId = message.content.slice(`${process.env.PREFIX}remove`.length).trim();
        if(!contextId) return message.reply("Please the context ID.");

        try {
            await contextscope.deleteOne({ "_id": new ObjectId(contextId.toString()) });
            await message.reply(`Context deleted successfully`);
        } catch (error) {
            console.error('Error deleting context:', error);
            await message.reply('An error occurred while deleting the context.');
        }
    }
});

/* AI Chatbot Interactions */
const conversations = mongoclient_main.db("chatbot").collection("conversations");

// Functions
function isWithinWordLimit(text, wordLimit = 50) {
    const wordCount = text.trim().split(/\s+/).filter(word => word.length > 0).length;
    return wordCount <= wordLimit;
}

async function getAllContexts() {
    try {
        const contexts = await contextscope.find({}).toArray();
        if (contexts.length === 0) return '';

        const formattedContexts = contexts.map((scope) => {
            let context = scope.context.trim();
            if (!context.endsWith('.')) {
                context += '.';
            }
            return context;
        });

        return formattedContexts.join(' ');
    } catch (error) {
        console.error('Error fetching contexts:', error);
        return '';
    }
}

// Interaction & Execution
client.on('messageCreate', async (message) => {
    if(message.author.bot) return;
    if(!message.guild) return;
    if(message.mentions.everyone) return;

    const isReplyToBot = message.reference && (await message.channel.messages.fetch(message.reference.messageId)).author.id === client.user.id;
    const isBotMentioned = message.mentions.has(client.user);

    if(isReplyToBot || isBotMentioned) {
        let conversationKey;
        let conversationData;

        await message.channel.sendTyping();

        const globalUsername = message.author.username;
        const serverUsername = message.member ? message.member.displayName : "none";

        const visibleRoles = message.member.roles.cache.filter(role => role.hoist).sort((a, b) => b.position - a.position);
        const highestVisibleRole = visibleRoles.first();

        let userMessage = message.content.replace(`<@${client.user.id}>`, '').trim();

        const userMentions = message.mentions.users.filter(user => user.id !== client.user.id);

        if(userMentions.size > 0) {
            userMentions.forEach(user => {
                userMessage = userMessage.replace(new RegExp(`<@${user.id}>`, 'g'), user.username);
            });
        }

        const userPrompt = `${globalUsername} (with nickname: ${serverUsername}, role in the community: ${highestVisibleRole.name}) says: ${userMessage}`;

        if(isReplyToBot) {
            conversationKey = message.reference.messageId;

            await conversations.updateOne(
                { "latestConversationKey": conversationKey },
                {
                    "$push": { "messages": { role: "user", content: [{ "type": "text", "text": userPrompt }] } }
                }
            );

            conversationData = await conversations.findOne({ "latestConversationKey": conversationKey });
            if(!conversationData) return;

            try {
                const completion = await openai.chat.completions.create({
                    model: 'gpt-4o-mini',
                    messages: conversationData.messages,
                });
                const replyContent = completion.choices[0].message.content;

                let isReplyWithinLimits = isWithinWordLimit(replyContent, 80);
                if(!isReplyWithinLimits) return await message.reply("Response exceeded the 80 words limit. Sorry!");

                let sanitizedContent = replyContent.replace(/@(everyone|here)/g, '[mention removed]');

                let botResponse = await message.reply(sanitizedContent);

                await conversations.updateOne(
                    { "latestConversationKey": conversationKey },
                    {
                        "$set": { "latestConversationKey": botResponse.id },
                        "$push": { "messages": { role: "assistant", content: [{ "type": "text", "text": replyContent }] } }
                    }
                );
            } catch (error) {
                console.error('Error fetching OpenAI response:', error);
                await message.reply('Sorry, something went wrong while processing your request.');
            }
        } else {
            conversationKey = message.id;

            const additionalContext = await getAllContexts();

            const systemPrompt = {
                role: "system",
                content: [{ "type": "text", "text": `Your name is INSERT_NAME_HERE, an assistant for COMMUNITY_NAME_HERE. ${additionalContext}` }]
            };

            await conversations.insertOne({ "latestConversationKey": conversationKey, "messages": [systemPrompt, { role: "user", content: [{ "type": "text", "text": userPrompt }] }], "createdAt": new Date() });

            conversationData = await conversations.findOne({ "latestConversationKey": conversationKey });
            if(!conversationData) return;

            try {
                const completion = await openai.chat.completions.create({
                    model: 'gpt-4o-mini',
                    messages: conversationData.messages,
                });
                var replyContent = completion.choices[0].message.content;

                let isReplyWithinLimits = isWithinWordLimit(replyContent, 80);
                if(!isReplyWithinLimits) return await message.reply("Response exceeded the 80 words limit. Sorry!");

                let sanitizedContent = replyContent.replace(/@(everyone|here)/g, '[mention removed]');
                
                let botResponse = await message.reply(sanitizedContent);

                await conversations.updateOne(
                    { "latestConversationKey": conversationKey },
                    {
                        "$set": { "latestConversationKey": botResponse.id },
                        "$push": { "messages": { role: "assistant", content: [{ "type": "text", "text": replyContent }] } }
                    }
                );
            } catch (error) {
                console.error('Error fetching OpenAI response:', error);
                await message.reply('Sorry, something went wrong while processing your request.');
            }
        }
    }
});

client.login(process.env.DISCORD_TOKEN);