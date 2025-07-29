const { createClient } = require('redis');
const { ChatOpenAI, OpenAIEmbeddings } = require('@langchain/openai');
const { RedisChatMessageHistory } = require('@langchain/community/stores/message/redis');
const { ConversationSummaryBufferMemory } = require('langchain/memory');
const { DynamicTool } = require('@langchain/core/tools');
const { QdrantVectorStore } = require('@langchain/qdrant');
const { QdrantClient } = require('@qdrant/js-client-rest');
const axios = require('axios');

// =============================================
// SHARED GLOBAL CACHE OBJECTS
// =============================================
let globalRedisClient = null;
let globalAIModel = null;
let globalHttpGetTool = null;
let globalQdrantRAGTool = null;
let agentExecutorCache = new Map();
const MAX_CACHE_SIZE = 100;

// Initialize Redis client (shared across all workflows)
const getRedisClient = async () => {
  if (!globalRedisClient) {
    console.log(`🔌 Initializing shared Redis client...`);
    globalRedisClient = createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379',
    });
    
    globalRedisClient.on('error', (err) => console.log('Redis Client Error', err));
    await globalRedisClient.connect();
    console.log(`✅ Shared Redis client connected`);
  }
  return globalRedisClient;
};

// AI Model Configuration (shared)
const getAIModel = () => {
  if (!globalAIModel) {
    console.log(`🚀 Initializing cached AI model...`);
    const modelName = process.env.AI_MODEL || 'gpt-4-1106-preview';
    
    switch (process.env.AI_PROVIDER || 'openai') {
      case 'openai':
        globalAIModel = new ChatOpenAI({
          openAIApiKey: process.env.OPENAI_API_KEY,
          modelName: modelName,
          temperature: parseFloat(process.env.AI_TEMPERATURE || '0.7'),
          maxTokens: parseInt(process.env.AI_MAX_TOKENS || '800'),
          timeout: 30000,
          maxRetries: 2,
          streaming: false,
        });
        break;
      default:
        globalAIModel = new ChatOpenAI({
          openAIApiKey: process.env.OPENAI_API_KEY,
          modelName: modelName,
          temperature: 0.7,
          maxTokens: 800,
          timeout: 30000,
          maxRetries: 2,
          streaming: false,
        });
    }
    console.log(`✅ AI model cached: ${modelName}`);
  }
  return globalAIModel;
};

// HTTP GET Tool (shared)
const createHttpGetTool = () => {
  if (!globalHttpGetTool) {
    console.log(`🚀 Initializing cached HTTP GET tool...`);
    globalHttpGetTool = new DynamicTool({
      name: "http_get",
      description: "Use this tool to run an HTTP GET request to a URL. Provide the URL as input.",
      func: async (url) => {
        try {
          console.log(`🔧 [${new Date().toISOString()}] HTTP GET Tool called with URL: ${url}`);
          
          if (!url || typeof url !== 'string') {
            throw new Error('URL is required and must be a string');
          }
          
          try {
            new URL(url);
          } catch (urlError) {
            throw new Error(`Invalid URL format: ${url}`);
          }
          
          console.log(`🌐 Making HTTP GET request to: ${url}`);
          const startTime = Date.now();
          
          const response = await axios.get(url, {
            timeout: 8000,
            headers: {
              'User-Agent': 'N8N-to-NodeJS-Chatbot/1.0',
            },
            maxRedirects: 5,
          });
          
          const responseTime = Date.now() - startTime;
          console.log(`✅ HTTP GET successful (${response.status}) in ${responseTime}ms`);
          
          const result = {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
            data: response.data,
            url: url,
            responseTime: responseTime
          };
          
          return JSON.stringify(result, null, 2);
          
        } catch (error) {
          console.error(`❌ HTTP GET Tool error:`, error);
          const errorResult = {
            error: true,
            message: error.message,
            url: url,
            type: error.code || error.constructor.name
          };
          return JSON.stringify(errorResult, null, 2);
        }
      },
    });
    console.log(`✅ HTTP GET tool cached and ready`);
  }
  return globalHttpGetTool;
};

// Qdrant RAG Tool (shared)
const createQdrantRAGTool = async (collectionName = null) => {
  if (!globalQdrantRAGTool || collectionName) {
    console.log(`🚀 Initializing Qdrant RAG tool${collectionName ? ' for collection: ' + collectionName : ''}...`);
    
    try {
      const qdrantUrl = process.env.QDRANT_URL || 'http://localhost:6333';
      let clientConfig;
      
      if (qdrantUrl.startsWith('https://')) {
        const url = new URL(qdrantUrl);
        clientConfig = {
          host: url.hostname,
          port: url.port || 443,
          https: true,
          apiKey: process.env.QDRANT_API_KEY,
          timeout: 30000,
        };
      } else {
        clientConfig = {
          url: qdrantUrl,
          apiKey: process.env.QDRANT_API_KEY,
          timeout: 30000,
        };
      }
      
      const qdrantClient = new QdrantClient(clientConfig);
      const embeddings = new OpenAIEmbeddings({
        openAIApiKey: process.env.OPENAI_API_KEY,
        modelName: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
      });
      
      const targetCollection = collectionName || process.env.QDRANT_COLLECTION || 'knowledge_base';
      
      const tool = new DynamicTool({
        name: "knowledge_retrieval", 
        description: "MANDATORY TOOL: You MUST use this tool for EVERY user question to search the knowledge base before responding. No exceptions. Always call this first with the user's query as input.",
        func: async (query) => {
          try {
            console.log(`\n🔍 ===== KNOWLEDGE RETRIEVAL TOOL CALLED =====`);
            console.log(`📝 Query: "${query}"`);
            console.log(`📂 Collection: "${targetCollection}"`);
            console.log(`⏰ Starting knowledge search...`);
            const startTime = Date.now();
            
            // Create vector store only when actually needed
            const vectorStore = await QdrantVectorStore.fromExistingCollection(embeddings, {
              client: qdrantClient,
              collectionName: targetCollection,
              collectionConfig: {
                vectors: {
                  size: 1536,
                  distance: 'Cosine',
                },
              },
            });
            
            const results = await vectorStore.similaritySearch(query, parseInt(process.env.RAG_TOP_K || '5'));
            const searchTime = Date.now() - startTime;
            
            console.log(`⚡ Knowledge search completed in ${searchTime}ms`);
            console.log(`📊 Found ${results.length} results`);
            
            if (results.length === 0) {
              console.log(`❌ No knowledge found for query: "${query}"`);
              console.log(`===== END KNOWLEDGE RETRIEVAL =====\n`);
              return JSON.stringify({
                query: query,
                results: [],
                message: "No relevant knowledge found in the knowledge base for this query.",
                searchTime: searchTime
              }, null, 2);
            }
            
            const formattedResults = results.map((doc, index) => ({
              rank: index + 1,
              content: doc.pageContent,
              metadata: doc.metadata,
              relevanceScore: doc.score || 'N/A'
            }));
            
            console.log(`✅ Knowledge Results:`);
            formattedResults.forEach((result, index) => {
              console.log(`   ${index + 1}. ${result.content.substring(0, 100)}...`);
            });
            console.log(`===== END KNOWLEDGE RETRIEVAL =====\n`);
            
            return JSON.stringify({
              query: query,
              results: formattedResults,
              totalResults: results.length,
              searchTime: searchTime
            }, null, 2);
            
          } catch (error) {
            console.log(`\n❌ ===== KNOWLEDGE RETRIEVAL ERROR =====`);
            console.error(`💥 Error for collection "${targetCollection}":`, error.message);
            console.log(`📝 Query was: "${query}"`);
            
            // Provide helpful error message to AI
            if (error.message && error.message.includes("doesn't exist")) {
              console.log(`🚫 Collection "${targetCollection}" doesn't exist in Qdrant`);
              console.log(`===== END KNOWLEDGE RETRIEVAL ERROR =====\n`);
              return JSON.stringify({
                error: true,
                message: `Knowledge base collection '${targetCollection}' doesn't exist. I don't have access to a knowledge base for this query.`,
                query: query,
                suggestion: "I can still help you with questions based on my training data and system information."
              }, null, 2);
            } else {
              console.log(`⚠️  Other error: ${error.constructor.name}`);
              console.log(`===== END KNOWLEDGE RETRIEVAL ERROR =====\n`);
              return JSON.stringify({
                error: true,
                message: `Knowledge base temporarily unavailable: ${error.message}`,
                query: query,
                type: error.constructor.name
              }, null, 2);
            }
          }
        },
      });
      
      if (!collectionName) {
        globalQdrantRAGTool = tool;
      }
      
      console.log(`✅ Qdrant RAG tool ready for collection: ${targetCollection}`);
      return tool;
      
    } catch (error) {
      console.error(`❌ Failed to initialize Qdrant RAG Tool:`, error);
      return new DynamicTool({
        name: "knowledge_retrieval",
        description: "Knowledge retrieval tool (currently unavailable)",
        func: async (query) => {
          return JSON.stringify({
            error: true,
            message: "Qdrant RAG tool is not available. Please check your Qdrant configuration.",
            query: query,
            details: error.message
          }, null, 2);
        },
      });
    }
  }
  return globalQdrantRAGTool;
};

// Create Redis Memory (shared utility)
const createRedisMemory = async (sessionId, ttl = 604800) => {
  try {
    const redisClient = await getRedisClient();
    
    // Redis key format: "chat_history:" + sessionId
    const redisKey = `chat_history:${sessionId}`;
    
    console.log(`\n💾 ===== REDIS CHAT MEMORY SETUP =====`);
    console.log(`🔑 Redis Key: "${redisKey}"`);
    console.log(`⏰ TTL (Time To Live): ${ttl} seconds (${Math.round(ttl/86400)} days)`);
    console.log(`🆔 Session ID: "${sessionId}"`);
    
    const messageHistory = new RedisChatMessageHistory({
      sessionId: redisKey,
      sessionTTL: ttl,
      client: redisClient,
    });

    // Check if there's existing conversation history
    try {
      const existingMessages = await messageHistory.getMessages();
      console.log(`📚 Existing conversation messages: ${existingMessages.length}`);
      if (existingMessages.length > 0) {
        console.log(`   📝 Last message: "${existingMessages[existingMessages.length - 1].content.substring(0, 50)}..."`);
      }
    } catch (error) {
      console.log(`⚠️  Could not retrieve existing messages: ${error.message}`);
    }
    
    console.log(`===== END REDIS MEMORY SETUP =====\n`);

    const memory = new ConversationSummaryBufferMemory({
      llm: getAIModel(),
      chatHistory: messageHistory,
      returnMessages: true,
      memoryKey: "chat_history",
      maxTokenLimit: 2000,
    });

    return memory;
  } catch (error) {
    console.error('Error creating Redis memory:', error);
    throw error;
  }
};

// Utility function to log requests
const logRequest = (req, workflowName) => {
  const requestId = Math.random().toString(36).substr(2, 9);
  console.log(`\n🌐 [${new Date().toISOString()}] ===== ${workflowName.toUpperCase()} WORKFLOW REQUEST =====`);
  console.log(`🆔 Request ID: ${requestId}`);
  console.log(`📍 Endpoint: ${req.path}`);
  console.log(`🔗 Method: ${req.method}`);
  console.log(`🌐 IP: ${req.ip || req.connection.remoteAddress}`);
  console.log(`📦 Request Body:`, req.body);
  return requestId;
};

module.exports = {
  getRedisClient,
  getAIModel,
  createHttpGetTool,
  createQdrantRAGTool,
  createRedisMemory,
  logRequest,
  agentExecutorCache,
  MAX_CACHE_SIZE
}; 