const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { createClient } = require('redis');
const axios = require('axios');
require('dotenv').config();

// LangChain imports
const { ChatOpenAI, OpenAIEmbeddings } = require('@langchain/openai');
const { RedisChatMessageHistory } = require('@langchain/community/stores/message/redis');
const { ConversationSummaryBufferMemory } = require('langchain/memory');
const { initializeAgentExecutorWithOptions } = require('langchain/agents');
const { DynamicTool } = require('@langchain/core/tools');
const { HumanMessage, AIMessage } = require('@langchain/core/messages');
const { QdrantVectorStore } = require('@langchain/qdrant');
const { QdrantClient } = require('@qdrant/js-client-rest');

const app = express();
const PORT = process.env.PORT || 3000;

// =============================================
// PERFORMANCE: GLOBAL CACHE OBJECTS
// =============================================
let globalAIModel = null;
let globalHttpGetTool = null;
let globalQdrantRAGTool = null;
let globalTools = null;
let agentExecutorCache = new Map(); // Cache agents by session to avoid recreation
const MAX_CACHE_SIZE = 100; // Limit cache size to prevent memory leaks

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// Initialize Redis client
const redisClient = createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379',
});

redisClient.on('error', (err) => console.log('Redis Client Error', err));

// AI Model Configuration - Easy to swap! (OPTIMIZED WITH CACHING)
const getAIModel = () => {
  if (!globalAIModel) {
    console.log(`🚀 Initializing cached AI model...`);
    // You can easily swap models here
    const modelName = process.env.AI_MODEL || 'gpt-4-1106-preview';
    
    switch (process.env.AI_PROVIDER || 'openai') {
      case 'openai':
        globalAIModel = new ChatOpenAI({
          openAIApiKey: process.env.OPENAI_API_KEY,
          modelName: modelName,
          temperature: parseFloat(process.env.AI_TEMPERATURE || '0.7'),
          maxTokens: parseInt(process.env.AI_MAX_TOKENS || '1000'),
          // Performance optimizations
          timeout: 30000, // 30 second timeout
          maxRetries: 2,   // Reduce retries for faster failure
          streaming: false, // Disable streaming for consistency
        });
        break;
      // Add other providers here in the future
      // case 'anthropic':
      //   return new ChatAnthropic({ ... });
      // case 'azure':
      //   return new AzureChatOpenAI({ ... });
      default:
        globalAIModel = new ChatOpenAI({
          openAIApiKey: process.env.OPENAI_API_KEY,
          modelName: modelName,
          temperature: 0.7,
          maxTokens: 1000,
          timeout: 30000,
          maxRetries: 2,
          streaming: false,
        });
    }
    console.log(`✅ AI model cached: ${modelName}`);
  }
  return globalAIModel;
};

// HTTP GET Tool - Replicates the n8n http_get node (CACHED)
const createHttpGetTool = () => {
  if (!globalHttpGetTool) {
    console.log(`🚀 Initializing cached HTTP GET tool...`);
    globalHttpGetTool = new DynamicTool({
    name: "http_get",
    description: "Use this tool to run an HTTP GET request to a URL. Provide the URL as input.",
    func: async (url) => {
      try {
        console.log(`🔧 [${new Date().toISOString()}] HTTP GET Tool called with URL: ${url}`);
        
        // Validate URL
        if (!url || typeof url !== 'string') {
          throw new Error('URL is required and must be a string');
        }
        
        // Basic URL validation
        try {
          new URL(url);
        } catch (urlError) {
          throw new Error(`Invalid URL format: ${url}`);
        }
        
        console.log(`🌐 Making HTTP GET request to: ${url}`);
        const startTime = Date.now();
        
        const response = await axios.get(url, {
          timeout: 10000, // 10 second timeout
          headers: {
            'User-Agent': 'N8N-to-NodeJS-Chatbot/1.0',
          },
          maxRedirects: 5,
        });
        
        const responseTime = Date.now() - startTime;
        console.log(`✅ HTTP GET successful (${response.status}) in ${responseTime}ms`);
        console.log(`📊 Response size: ${JSON.stringify(response.data).length} characters`);
        
        // Return structured response
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

// Qdrant RAG Tool - Replicates the n8n Qdrant Vector Store node (CACHED)
const createQdrantRAGTool = async () => {
  if (globalQdrantRAGTool) {
    return globalQdrantRAGTool;
  }
  
  try {
    console.log(`🔍 [${new Date().toISOString()}] Initializing Qdrant RAG Tool...`);
    
    // Initialize Qdrant client
    const qdrantUrl = process.env.QDRANT_URL || 'http://localhost:6333';
    
    // Parse URL to handle cloud instances properly
    let clientConfig;
    if (qdrantUrl.startsWith('https://')) {
      // For cloud/HTTPS instances, use host and port separately
      const url = new URL(qdrantUrl);
      clientConfig = {
        host: url.hostname,
        port: url.port || 443,
        https: true,
        apiKey: process.env.QDRANT_API_KEY,
        timeout: 30000,
      };
    } else {
      // For local/HTTP instances, use the full URL
      clientConfig = {
        url: qdrantUrl,
        apiKey: process.env.QDRANT_API_KEY,
        timeout: 30000,
      };
    }
    
    const qdrantClient = new QdrantClient(clientConfig);
    
    console.log(`📡 Qdrant client initialized with config:`, {
      url: qdrantUrl,
      host: clientConfig.host || 'N/A',
      port: clientConfig.port || 'N/A',
      https: clientConfig.https || false
    });
    
    // Test Qdrant connection
    console.log(`🔗 Testing Qdrant connection...`);
    try {
      const collections = await qdrantClient.getCollections();
      console.log(`✅ Qdrant connection successful! Found ${collections.collections?.length || 0} collections`);
      if (collections.collections) {
        console.log(`   Available collections: ${collections.collections.map(c => c.name).join(', ')}`);
      }
    } catch (testError) {
      console.error(`❌ Qdrant connection test failed:`, testError.message);
      throw new Error(`Qdrant connection failed: ${testError.message}`);
    }
    
    // Initialize OpenAI embeddings
    const embeddings = new OpenAIEmbeddings({
      openAIApiKey: process.env.OPENAI_API_KEY,
      modelName: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
    });
    
    console.log(`🧠 OpenAI embeddings initialized with model: ${process.env.EMBEDDING_MODEL || 'text-embedding-3-small'}`);
    
    // Initialize Qdrant vector store
    const collectionIdentifier = process.env.QDRANT_COLLECTION || 'knowledge_base';
    console.log(`🗃️  Connecting to vector store collection: ${collectionIdentifier}`);
    
    // Check if collection exists and get collection name
    const collections = await qdrantClient.getCollections();
    let collectionName;
    
    // Always treat collectionIdentifier as collection name (not array index)
    collectionName = collectionIdentifier;
    console.log(`🔍 Looking for collection with name: "${collectionName}"`);
    
    // Find collection by name
    const collection = collections.collections?.find(c => c.name === collectionName);
    
    if (!collection) {
      console.log(`❌ Collection "${collectionName}" not found. Available collections: ${collections.collections?.map(c => c.name).join(', ') || 'none'}`);
      throw new Error(`Collection '${collectionName}' does not exist in Qdrant. Please check your QDRANT_COLLECTION environment variable.`);
    }
    
    console.log(`✅ Found collection "${collectionName}"`);
    
    // Check if collection has documents
    const pointCount = collection.points_count || 0;
    console.log(`📊 Collection "${collectionName}" contains ${pointCount} documents`);
    
    if (pointCount === 0) {
      console.log(`⚠️  WARNING: Collection "${collectionName}" is empty! Knowledge retrieval will not work until you add documents.`);
    }
    
    const vectorStore = await QdrantVectorStore.fromExistingCollection(embeddings, {
      client: qdrantClient,
      collectionName: collectionName,
      collectionConfig: {
        vectors: {
          size: 1536, // text-embedding-3-small dimension
          distance: 'Cosine',
        },
      },
    });
    
    console.log(`✅ Vector store successfully connected to collection: ${collectionName}`);
    

    
    console.log(`✅ Qdrant RAG tool initialized and cached`);
    globalQdrantRAGTool = new DynamicTool({
      name: "knowledge_retrieval",
      description: "Use this tool to retrieve knowledge from the knowledge base if the user asks questions not in the system prompt. Provide your search query as input.",
      func: async (query) => {
        try {
          console.log(`🔍 [${new Date().toISOString()}] Knowledge Retrieval Tool called with query: "${query}"`);
          
          if (!query || typeof query !== 'string') {
            throw new Error('Search query is required and must be a string');
          }
          
          console.log(`🔎 Searching vector database for: "${query}"`);
          const startTime = Date.now();
          
          // Perform similarity search
          const results = await vectorStore.similaritySearch(query, parseInt(process.env.RAG_TOP_K || '5'));
          
          const searchTime = Date.now() - startTime;
          console.log(`✅ Knowledge retrieval completed in ${searchTime}ms`);
          console.log(`📚 Found ${results.length} relevant documents`);
          
          if (results.length === 0) {
            console.log(`ℹ️  No relevant knowledge found for query: "${query}"`);
            return JSON.stringify({
              query: query,
              results: [],
              message: "No relevant knowledge found in the knowledge base for this query. The knowledge base may be empty or your query doesn't match any stored documents.",
              searchTime: searchTime,
              suggestion: "Please ensure your Qdrant collection contains embedded documents before using the knowledge retrieval tool."
            }, null, 2);
          }
          
          // Format results
          const formattedResults = results.map((doc, index) => ({
            rank: index + 1,
            content: doc.pageContent,
            metadata: doc.metadata,
            relevanceScore: doc.score || 'N/A'
          }));
          
          console.log(`📋 Retrieved documents summary:`);
          formattedResults.forEach((result, index) => {
            console.log(`   ${index + 1}. ${result.content.substring(0, 100)}${result.content.length > 100 ? '...' : ''}`);
          });
          
          const response = {
            query: query,
            results: formattedResults,
            totalResults: results.length,
            searchTime: searchTime
          };
          
          return JSON.stringify(response, null, 2);
          
        } catch (error) {
          console.error(`❌ Knowledge Retrieval Tool error:`, error);
          const errorResult = {
            error: true,
            message: error.message,
            query: query,
            type: error.constructor.name
          };
          return JSON.stringify(errorResult, null, 2);
        }
      },
    });
    
    return globalQdrantRAGTool;
    
  } catch (error) {
    console.error(`❌ Failed to initialize Qdrant RAG Tool:`, error);
    console.error(`   This might be due to missing Qdrant configuration or connection issues`);
    
    // Return a dummy tool that explains the issue
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
};

// Create Redis Memory for conversations
const createRedisMemory = async (sessionId) => {
  try {
    const messageHistory = new RedisChatMessageHistory({
      sessionId: `chat_history:${sessionId}`,
      sessionTTL: 604800, // 7 days (7 × 24 × 60 × 60 seconds)
      client: redisClient,
    });

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

// Connect to Redis
async function connectRedis() {
  try {
    console.log(`🔌 [${new Date().toISOString()}] Attempting to connect to Redis...`);
    console.log(`📍 Redis URL: ${process.env.REDIS_URL || 'redis://localhost:6379'}`);
    
    await redisClient.connect();
    
    console.log(`✅ [${new Date().toISOString()}] Successfully connected to Redis`);
    console.log(`🔍 Testing Redis connection...`);
    
    // Test the connection
    await redisClient.set('connection_test', new Date().toISOString());
    const testValue = await redisClient.get('connection_test');
    await redisClient.del('connection_test');
    
    console.log(`✅ Redis connection test successful`);
    console.log(`📊 Redis is ready for LangChain conversation memory`);
    
  } catch (error) {
    console.error(`❌ [${new Date().toISOString()}] Failed to connect to Redis:`, error);
    console.error(`💥 Error Type: ${error.constructor.name}`);
    console.error(`💥 Error Message: ${error.message}`);
    console.error(`⚠️  The application will not work without Redis connection`);
  }
}

// AI Agent function with LangChain and Tools
async function processMessage(message, sessionId) {
  const startTime = Date.now();
  console.log(`\n🔄 [${new Date().toISOString()}] ===== PROCESSING MESSAGE WITH LANGCHAIN =====`);
  console.log(`📥 Session ID: ${sessionId}`);
  console.log(`💬 User Message: "${message}"`);
  
  try {
    // Step 1: Initialize AI Model
    console.log(`🤖 Step 1: Initializing AI model...`);
    const model = getAIModel();
    console.log(`   Model: ${model.modelName || 'gpt-4-1106-preview'}`);
    console.log(`   Provider: ${process.env.AI_PROVIDER || 'openai'}`);
    console.log(`   Temperature: ${model.temperature}`);
    console.log(`   Max Tokens: ${model.maxTokens}`);

    // Step 2: Get Cached Tools
    console.log(`🔧 Step 2: Getting cached tools...`);
    if (!globalTools) {
      console.log(`   🚀 Initializing tools for first time...`);
      const httpGetTool = createHttpGetTool();
      const qdrantRAGTool = await createQdrantRAGTool();
      globalTools = [httpGetTool, qdrantRAGTool];
      console.log(`   ✅ Tools cached: ${globalTools.map(t => t.name).join(', ')}`);
    } else {
      console.log(`   ⚡ Using cached tools: ${globalTools.map(t => t.name).join(', ')}`);
    }

    // Step 3: Create Memory (optimized)
    console.log(`💾 Step 3: Setting up Redis conversation memory...`);
    const memory = await createRedisMemory(sessionId);
    console.log(`   Memory ready for session: ${sessionId}`);

    // Step 4: Get Cached Agent or Create New
    console.log(`🎯 Step 4: Getting agent executor...`);
    let executor = agentExecutorCache.get(sessionId);
    
    if (!executor) {
      console.log(`   🚀 Creating new agent for session: ${sessionId}`);
      executor = await initializeAgentExecutorWithOptions(globalTools, model, {
        agentType: "openai-functions",
        verbose: process.env.LANGCHAIN_VERBOSE === 'true',
        memory: memory,
        maxIterations: 2, // Reduced for faster processing
        timeout: 25000,   // 25 second timeout
      });
      
      // Cache management - prevent memory leaks
      if (agentExecutorCache.size >= MAX_CACHE_SIZE) {
        const firstKey = agentExecutorCache.keys().next().value;
        agentExecutorCache.delete(firstKey);
        console.log(`   🧹 Removed old cached agent to prevent memory leak`);
      }
      
      agentExecutorCache.set(sessionId, executor);
      console.log(`   ✅ Agent cached for session: ${sessionId}`);
    } else {
      // Update memory for cached agent
      executor.memory = memory;
      console.log(`   ⚡ Using cached agent for session: ${sessionId}`);
    }

    // Step 5: Process Message
    console.log(`⚡ Step 5: Processing message through agent...`);
    const response = await executor.call({
      input: message,
    });

    console.log(`✅ Agent response received`);
    console.log(`🤖 AI Response: "${response.output}"`);
    
    // Log tool usage if any
    if (response.intermediateSteps && response.intermediateSteps.length > 0) {
      console.log(`🔧 Tools used during processing:`);
      response.intermediateSteps.forEach((step, index) => {
        console.log(`   ${index + 1}. ${step.action.tool}: ${step.action.toolInput}`);
      });
    }

    const processingTime = Date.now() - startTime;
    console.log(`⚡ Total processing time: ${processingTime}ms`);
    console.log(`🎉 ===== LANGCHAIN MESSAGE PROCESSING COMPLETE =====\n`);

    return response.output;

  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error(`❌ [${new Date().toISOString()}] LangChain processing error after ${processingTime}ms:`, error);
    console.error(`   Session: ${sessionId}`);
    console.error(`   Message: "${message}"`);
    console.error(`   Error Type: ${error.constructor.name}`);
    console.error(`   Error Message: ${error.message}`);
    if (error.response) {
      console.error(`   API Response Status: ${error.response.status}`);
      console.error(`   API Response Data:`, error.response.data);
    }
    console.log(`💥 ===== LANGCHAIN MESSAGE PROCESSING FAILED =====\n`);
    throw error;
  }
}

// Webhook endpoint - replicates the n8n webhook path
app.post('/webhook/b7194f70-67fd-4f46-8c39-27bc98a17838', async (req, res) => {
  const requestStart = Date.now();
  const requestId = Math.random().toString(36).substr(2, 9);
  
  console.log(`\n🌐 [${new Date().toISOString()}] ===== INCOMING WEBHOOK REQUEST =====`);
  console.log(`🆔 Request ID: ${requestId}`);
  console.log(`📍 Endpoint: /webhook/b7194f70-67fd-4f46-8c39-27bc98a17838 (Original N8N Path)`);
  console.log(`🔗 Method: ${req.method}`);
  console.log(`🌐 IP: ${req.ip || req.connection.remoteAddress}`);
  console.log(`📋 Headers:`, {
    'content-type': req.headers['content-type'],
    'user-agent': req.headers['user-agent'],
    'content-length': req.headers['content-length']
  });
  console.log(`📦 Request Body:`, req.body);
  
  try {
    const { message, session_id } = req.body;

    // Validate required fields
    console.log(`✅ Step 1: Validating request data...`);
    if (!message) {
      console.log(`❌ Validation failed: Message is required`);
      const errorResponse = { error: 'Message is required' };
      console.log(`📤 Sending error response:`, errorResponse);
      return res.status(400).json(errorResponse);
    }

    if (!session_id) {
      console.log(`❌ Validation failed: Session ID is required`);
      const errorResponse = { error: 'Session ID is required' };
      console.log(`📤 Sending error response:`, errorResponse);
      return res.status(400).json(errorResponse);
    }

    console.log(`✅ Request validation passed`);
    console.log(`📝 Processing message for session ${session_id}: "${message}"`);

    // Process the message through LangChain AI Agent
    console.log(`🔄 Step 2: Delegating to LangChain AI Agent...`);
    const response = await processMessage(message, session_id);

    // Respond to webhook (equivalent to "Respond to Webhook" node)
    const responseData = {
      success: true,
      response: response,
      session_id: session_id,
      timestamp: new Date().toISOString(),
      tools_available: ['http_get', 'knowledge_retrieval'],
      ai_model: process.env.AI_MODEL || 'gpt-4-1106-preview',
      rag_enabled: true
    };
    
    const requestTime = Date.now() - requestStart;
    console.log(`✅ Step 3: Preparing successful response...`);
    console.log(`📤 Response Data:`, responseData);
    console.log(`⚡ Total request time: ${requestTime}ms`);
    console.log(`🎉 ===== WEBHOOK REQUEST COMPLETE =====\n`);
    
    res.json(responseData);

  } catch (error) {
    const requestTime = Date.now() - requestStart;
    console.error(`❌ [${new Date().toISOString()}] Webhook error after ${requestTime}ms:`);
    console.error(`🆔 Request ID: ${requestId}`);
    console.error(`📍 Endpoint: /webhook/b7194f70-67fd-4f46-8c39-27bc98a17838`);
    console.error(`💥 Error Type: ${error.constructor.name}`);
    console.error(`💥 Error Message: ${error.message}`);
    console.error(`💥 Stack Trace:`, error.stack);
    
    const errorResponse = {
      success: false,
      error: 'Internal server error',
      message: error.message,
      request_id: requestId
    };
    
    console.log(`📤 Sending error response:`, errorResponse);
    console.log(`💥 ===== WEBHOOK REQUEST FAILED =====\n`);
    
    res.status(500).json(errorResponse);
  }
});

// Generic webhook endpoint for testing
app.post('/webhook', async (req, res) => {
  const requestStart = Date.now();
  const requestId = Math.random().toString(36).substr(2, 9);
  
  console.log(`\n🌐 [${new Date().toISOString()}] ===== INCOMING WEBHOOK REQUEST =====`);
  console.log(`🆔 Request ID: ${requestId}`);
  console.log(`📍 Endpoint: /webhook (Generic Testing Path)`);
  console.log(`🔗 Method: ${req.method}`);
  console.log(`🌐 IP: ${req.ip || req.connection.remoteAddress}`);
  console.log(`📋 Headers:`, {
    'content-type': req.headers['content-type'],
    'user-agent': req.headers['user-agent'],
    'content-length': req.headers['content-length']
  });
  console.log(`📦 Request Body:`, req.body);
  
  try {
    const { message, session_id } = req.body;

    console.log(`✅ Step 1: Validating request data...`);
    if (!message) {
      console.log(`❌ Validation failed: Message is required`);
      const errorResponse = { error: 'Message is required' };
      console.log(`📤 Sending error response:`, errorResponse);
      return res.status(400).json(errorResponse);
    }

    const sessionId = session_id || 'default';
    console.log(`✅ Request validation passed`);
    console.log(`📝 Session ID: ${sessionId} ${!session_id ? '(using default)' : ''}`);
    console.log(`📝 Processing message: "${message}"`);

    console.log(`🔄 Step 2: Delegating to LangChain AI Agent...`);
    const response = await processMessage(message, sessionId);

    const responseData = {
      success: true,
      response: response,
      session_id: sessionId,
      timestamp: new Date().toISOString(),
      tools_available: ['http_get', 'knowledge_retrieval'],
      ai_model: process.env.AI_MODEL || 'gpt-4-1106-preview',
      rag_enabled: true
    };
    
    const requestTime = Date.now() - requestStart;
    console.log(`✅ Step 3: Preparing successful response...`);
    console.log(`📤 Response Data:`, responseData);
    console.log(`⚡ Total request time: ${requestTime}ms`);
    console.log(`🎉 ===== WEBHOOK REQUEST COMPLETE =====\n`);
    
    res.json(responseData);

  } catch (error) {
    const requestTime = Date.now() - requestStart;
    console.error(`❌ [${new Date().toISOString()}] Webhook error after ${requestTime}ms:`);
    console.error(`🆔 Request ID: ${requestId}`);
    console.error(`📍 Endpoint: /webhook`);
    console.error(`💥 Error Type: ${error.constructor.name}`);
    console.error(`💥 Error Message: ${error.message}`);
    console.error(`💥 Stack Trace:`, error.stack);
    
    const errorResponse = {
      success: false,
      error: 'Internal server error',
      message: error.message,
      request_id: requestId
    };
    
    console.log(`📤 Sending error response:`, errorResponse);
    console.log(`💥 ===== WEBHOOK REQUEST FAILED =====\n`);
    
    res.status(500).json(errorResponse);
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  const healthData = { 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    redis_connected: redisClient.isReady,
    ai_model: process.env.AI_MODEL || 'gpt-4-1106-preview',
    ai_provider: process.env.AI_PROVIDER || 'openai',
    tools_enabled: ['http_get', 'knowledge_retrieval'],
    langchain_version: require('langchain/package.json').version,
    qdrant_configured: !!(process.env.QDRANT_URL && process.env.QDRANT_API_KEY),
    embedding_model: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
    rag_enabled: true
  };
  
  console.log(`❤️  [${new Date().toISOString()}] Health check requested`);
  console.log(`🌐 IP: ${req.ip || req.connection.remoteAddress}`);
  console.log(`📊 Health Status:`, healthData);
  
  res.json(healthData);
});

// Start server
async function startServer() {
  try {
    console.log(`\n🚀 [${new Date().toISOString()}] ===== STARTING N8N TO NODE.JS CHATBOT SERVER WITH LANGCHAIN =====`);
    console.log(`📋 Environment Configuration:`);
    console.log(`   🌍 Node.js Version: ${process.version}`);
    console.log(`   🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`   📍 Port: ${PORT}`);
    console.log(`   🤖 OpenAI API Key: ${process.env.OPENAI_API_KEY ? '✅ Configured' : '❌ Missing'}`);
    console.log(`   💾 Redis URL: ${process.env.REDIS_URL ? '✅ Configured' : '❌ Using default localhost'}`);
    console.log(`   🧠 AI Model: ${process.env.AI_MODEL || 'gpt-4-1106-preview'}`);
    console.log(`   🏭 AI Provider: ${process.env.AI_PROVIDER || 'openai'}`);
    console.log(`   🔧 Tools: http_get, knowledge_retrieval (RAG)`);
    console.log(`   🦜 LangChain: ${require('langchain/package.json').version}`);
    console.log(`   📊 Qdrant URL: ${process.env.QDRANT_URL ? '✅ Configured' : '❌ Not configured'}`);
    console.log(`   🧠 Embedding Model: ${process.env.EMBEDDING_MODEL || 'text-embedding-3-small'}`);
    console.log(`   📚 RAG Collection: ${process.env.QDRANT_COLLECTION || 'knowledge_base'}`);
    
    // Connect to Redis first
    console.log(`\n📋 Step 1: Initializing Redis connection...`);
    await connectRedis();
    
    console.log(`\n📋 Step 2: Starting Express server...`);
    app.listen(PORT, '0.0.0.0', () => {
      const localIP = '192.168.0.114'; // Your local network IP
      console.log(`\n✅ [${new Date().toISOString()}] Server successfully started!`);
      console.log(`🚀 Server running on port ${PORT} and accessible on local network`);
      console.log(`\n🌐 Local Network Endpoints (for phone testing):`);
      console.log(`   📝 Original N8N Webhook: http://${localIP}:${PORT}/webhook/b7194f70-67fd-4f46-8c39-27bc98a17838`);
      console.log(`   🧪 Generic Webhook: http://${localIP}:${PORT}/webhook`);
      console.log(`   ❤️  Health Check: http://${localIP}:${PORT}/health`);
      console.log(`\n💻 Local Computer Endpoints:`);
      console.log(`   📝 Original N8N Webhook: http://localhost:${PORT}/webhook/b7194f70-67fd-4f46-8c39-27bc98a17838`);
      console.log(`   🧪 Generic Webhook: http://localhost:${PORT}/webhook`);
      console.log(`   ❤️  Health Check: http://localhost:${PORT}/health`);
      console.log(`\n📊 System Status:`);
      console.log(`   ⚡ Ready to receive webhook requests`);
      console.log(`   🤖 LangChain AI integration active`);
      console.log(`   💾 Redis conversation memory active`);
      console.log(`   🔧 HTTP GET tool available`);
      console.log(`   📚 RAG knowledge retrieval tool available`);
      console.log(`   🔒 Security middleware enabled`);
      console.log(`\n🎉 ===== SERVER STARTUP COMPLETE =====`);
      console.log(`📝 Waiting for incoming requests...\n`);
    });
  } catch (error) {
    console.error(`❌ [${new Date().toISOString()}] Failed to start server:`, error);
    console.error(`💥 Error Type: ${error.constructor.name}`);
    console.error(`💥 Error Message: ${error.message}`);
    console.error(`💥 Stack Trace:`, error.stack);
    console.log(`💥 ===== SERVER STARTUP FAILED =====`);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log(`\n🛑 [${new Date().toISOString()}] ===== INITIATING GRACEFUL SHUTDOWN =====`);
  console.log(`📋 Received SIGINT signal (Ctrl+C)`);
  console.log(`⏱️  Server uptime: ${Math.floor(process.uptime())} seconds`);
  
  try {
    console.log(`🔌 Step 1: Closing Redis connection...`);
    await redisClient.quit();
    console.log('✅ Redis connection closed successfully');
  } catch (error) {
    console.error('❌ Error closing Redis connection:', error);
    console.error(`💥 Error Type: ${error.constructor.name}`);
    console.error(`💥 Error Message: ${error.message}`);
  }
  
  console.log(`🎉 ===== SHUTDOWN COMPLETE =====`);
  console.log(`👋 Goodbye! LangChain server stopped at ${new Date().toISOString()}`);
  process.exit(0);
});

startServer(); 