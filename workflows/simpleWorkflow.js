const { initializeAgentExecutorWithOptions } = require('langchain/agents');
const { 
  getAIModel, 
  createHttpGetTool, 
  createQdrantRAGTool, 
  createRedisMemory, 
  logRequest,
  agentExecutorCache,
  MAX_CACHE_SIZE 
} = require('../utils/shared');

// Global tools cache for simple workflow
let globalTools = null;

// Simple Workflow Handler
const handleSimpleWorkflow = async (req, res) => {
  const requestStart = Date.now();
  const requestId = logRequest(req, 'Simple');

  try {
    const { message, session_id } = req.body;

    // Validate required fields
    console.log(`✅ Step 1: Validating request data...`);
    if (!message) {
      console.log(`❌ Validation failed: Message is required`);
      return res.status(400).json({ error: 'Message is required' });
    }

    const sessionId = session_id || 'default';
    console.log(`✅ Request validation passed`);
    console.log(`📝 Processing message for session ${sessionId}: "${message}"`);

    // Process the message through LangChain AI Agent
    console.log(`🔄 Step 2: Delegating to LangChain AI Agent...`);
    const response = await processSimpleMessage(message, sessionId);

    // Prepare response
    const responseData = {
      success: true,
      response: response,
      session_id: sessionId,
      timestamp: new Date().toISOString(),
      tools_available: ['http_get', 'knowledge_retrieval'],
      ai_model: process.env.AI_MODEL || 'gpt-4-1106-preview',
      rag_enabled: true,
      workflow: 'simple'
    };
    
    const requestTime = Date.now() - requestStart;
    console.log(`✅ Step 3: Preparing successful response...`);
    console.log(`📤 Response Data:`, responseData);
    console.log(`⚡ Total request time: ${requestTime}ms`);
    console.log(`🎉 ===== SIMPLE WORKFLOW REQUEST COMPLETE =====\n`);
    
    res.json(responseData);

  } catch (error) {
    const requestTime = Date.now() - requestStart;
    console.error(`❌ Simple workflow error after ${requestTime}ms:`, error);
    console.log(`💥 ===== SIMPLE WORKFLOW REQUEST FAILED =====\n`);
    
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString(),
      workflow: 'simple'
    });
  }
};

// Process message with LangChain Agent
async function processSimpleMessage(message, sessionId) {
  const startTime = Date.now();
  console.log(`\n🔄 [${new Date().toISOString()}] ===== PROCESSING SIMPLE MESSAGE WITH LANGCHAIN =====`);
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

    // Step 3: Create Memory
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
        maxIterations: 2,
        timeout: 25000,
      });
      
      // Cache management
      if (agentExecutorCache.size >= MAX_CACHE_SIZE) {
        const firstKey = agentExecutorCache.keys().next().value;
        agentExecutorCache.delete(firstKey);
        console.log(`   🧹 Removed old cached agent to prevent memory leak`);
      }
      
      agentExecutorCache.set(sessionId, executor);
      console.log(`   ✅ Agent cached for session: ${sessionId}`);
    } else {
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
    
    const processingTime = Date.now() - startTime;
    console.log(`⚡ Total processing time: ${processingTime}ms`);
    console.log(`🎉 ===== SIMPLE MESSAGE PROCESSING COMPLETE =====\n`);

    return response.output;

  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error(`❌ LangChain processing error after ${processingTime}ms:`, error);
    console.log(`💥 ===== SIMPLE MESSAGE PROCESSING FAILED =====\n`);
    throw error;
  }
}

module.exports = {
  handleSimpleWorkflow,
  path: '/webhook', // Default path
  originalPath: '/webhook/b7194f70-67fd-4f46-8c39-27bc98a17838' // Original N8N path
}; 