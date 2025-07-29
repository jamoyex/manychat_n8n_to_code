const { AgentExecutor } = require('langchain/agents');
const { ChatOpenAI } = require('@langchain/openai');
const { HumanMessage, SystemMessage } = require('@langchain/core/messages');
const { ChatPromptTemplate, MessagesPlaceholder } = require('@langchain/core/prompts');
const { convertToOpenAIFunction } = require('@langchain/core/utils/function_calling');
const { RunnablePassthrough, RunnableSequence } = require('@langchain/core/runnables');
const { Pool } = require('pg');
const axios = require('axios');
const { DynamicTool } = require('@langchain/core/tools');
const {
  getRedisClient,
  getAIModel,
  createHttpGetTool,
  createQdrantRAGTool,
  createRedisMemory,
  logRequest,
  agentExecutorCache,
  MAX_CACHE_SIZE
} = require('../utils/shared');

// PostgreSQL connection pool
let pgPool = null;

// Initialize PostgreSQL pool
const getPgPool = () => {
  if (!pgPool) {
    // Parse the POSTGRES_URL to determine SSL configuration
    const postgresUrl = process.env.POSTGRES_URL;
    let sslConfig = false;
    
    // Check if URL explicitly requires SSL or if we're in a cloud environment
    if (postgresUrl && (postgresUrl.includes('sslmode=require') || postgresUrl.includes('amazonaws.com') || postgresUrl.includes('azure.com'))) {
      sslConfig = { rejectUnauthorized: false };
    } else if (process.env.POSTGRES_SSL === 'true') {
      sslConfig = { rejectUnauthorized: false };
    } else if (process.env.POSTGRES_SSL === 'require') {
      sslConfig = { rejectUnauthorized: true };
    }
    // Default: no SSL (handles local databases and servers that don't support SSL)
    
    console.log(`🔌 PostgreSQL SSL Config: ${sslConfig ? 'Enabled (rejectUnauthorized: ' + !sslConfig.rejectUnauthorized + ')' : 'Disabled'}`);
    
    pgPool = new Pool({
      connectionString: postgresUrl,
      ssl: sslConfig,
    });
    console.log('✅ PostgreSQL pool initialized');
  }
  return pgPool;
};

// Custom agent wrapper that properly handles system messages
const createCustomAgentExecutor = async (tools, model, systemPrompt, memory, options = {}) => {
  console.log(`\n🛠️  ===== CREATING CUSTOM AGENT WITH SYSTEM PROMPT =====`);
  console.log(`🤖 Model: ${model.modelName}`);
  console.log(`🔧 Tools: ${tools.map(t => t.name).join(', ')}`);
  console.log(`📝 System Prompt Length: ${systemPrompt.length} characters`);
  console.log(`💾 Memory: ${memory ? 'Enabled' : 'Disabled'}`);
  
  try {
    // Create a custom executor that wraps the ChatOpenAI model with proper system message injection
    const executor = {
      memory: memory,
      tools: tools,
      model: model,
      systemPrompt: systemPrompt,
      
      invoke: async (input) => {
        console.log(`\n🤖 ===== CUSTOM AGENT PROCESSING =====`);
        console.log(`💬 User Input: "${input.input}"`);
        
        // Get conversation history from memory
        let conversationHistory = [];
        if (memory) {
          try {
            const memoryVars = await memory.loadMemoryVariables({});
            conversationHistory = memoryVars.chat_history || [];
            console.log(`📚 Loaded ${conversationHistory.length} messages from memory`);
          } catch (error) {
            console.log(`⚠️  Memory load error: ${error.message}`);
          }
        }

        // Build messages array with proper system prompt injection
        const messages = [
          new SystemMessage(systemPrompt), // ✅ PROPER SYSTEM PROMPT INJECTION!
          ...conversationHistory,
          new HumanMessage(input.input)
        ];

        console.log(`\n📝 ===== MESSAGES SENT TO OPENAI =====`);
        messages.forEach((msg, index) => {
          const type = msg.constructor.name;
          const preview = msg.content.substring(0, 100);
          console.log(`   ${index + 1}. ${type}: "${preview}${msg.content.length > 100 ? '...' : ''}"`);
        });
        console.log(`===== END MESSAGES TO OPENAI =====\n`);

        // Convert tools to OpenAI function format
        const functions = tools.map(tool => convertToOpenAIFunction(tool));
        
        // Create model with functions
        const modelWithFunctions = model.bind({
          functions: functions,
          function_call: "auto"
        });

        console.log(`🔗 Model bound with ${functions.length} functions`);

        // Call the model
        const response = await modelWithFunctions.invoke(messages);
        console.log(`🤖 Model response received`);

        // Check if the model wants to call a function
        if (response.additional_kwargs.function_call) {
          const functionCall = response.additional_kwargs.function_call;
          console.log(`🔧 Function call requested: ${functionCall.name}`);
          
          // Find and execute the tool
          const tool = tools.find(t => t.name === functionCall.name);
          if (tool) {
            try {
              const toolInput = JSON.parse(functionCall.arguments).input || functionCall.arguments;
              console.log(`⚡ Executing tool: ${tool.name} with input: ${toolInput}`);
              const toolResult = await tool.func(toolInput);
              console.log(`✅ Tool executed successfully`);
              
              // Add tool result to conversation and get final response
              const finalMessages = [
                ...messages,
                response,
                new HumanMessage(`Tool result: ${toolResult}`)
              ];
              
              const finalResponse = await model.invoke(finalMessages);
              console.log(`🎯 Final response generated`);
              
              // Save to memory
              if (memory) {
                await memory.saveContext(
                  { input: input.input },
                  { output: finalResponse.content }
                );
                console.log(`💾 Conversation saved to memory`);
              }
              
              console.log(`===== END CUSTOM AGENT PROCESSING =====\n`);
              return { output: finalResponse.content };
              
            } catch (toolError) {
              console.error(`❌ Tool execution failed:`, toolError);
              const errorResponse = `I apologize, but I encountered an error while trying to help you: ${toolError.message}`;
              
              if (memory) {
                await memory.saveContext(
                  { input: input.input },
                  { output: errorResponse }
                );
              }
              
              return { output: errorResponse };
            }
          }
        }

        // No function call needed, return direct response
        console.log(`💬 Direct response (no tool usage)`);
        
        // Save to memory
        if (memory) {
          await memory.saveContext(
            { input: input.input },
            { output: response.content }
          );
          console.log(`💾 Conversation saved to memory`);
        }
        
        console.log(`===== END CUSTOM AGENT PROCESSING =====\n`);
        return { output: response.content };
      }
    };

    console.log(`✅ Custom agent executor created successfully`);
    console.log(`===== END CUSTOM AGENT CREATION =====\n`);

    return executor;

  } catch (error) {
    console.error(`❌ Custom agent creation failed:`, error);
    console.log(`===== CUSTOM AGENT CREATION FAILED =====\n`);
    throw error;
  }
};

// ManyChat Workflow Handler
const handleManyChatWorkflow = async (req, res) => {
  const requestStart = Date.now();
  const requestId = logRequest(req, 'ManyChat');

  try {
    const { page_id, user_id, agent_id, owner_email } = req.body;

    // Validate required fields
    console.log(`✅ Step 1: Validating ManyChat request data...`);
    if (!page_id || !user_id || !agent_id) {
      console.log(`❌ Validation failed: Missing required ManyChat fields`);
      return res.status(400).json({ 
        error: 'Missing required fields: page_id, user_id, agent_id' 
      });
    }

    // Step 1: Rate Limiting
    console.log(`🚦 Step 2: Checking rate limits...`);
    const rateLimitPassed = await checkRateLimit(agent_id);
    if (!rateLimitPassed) {
      console.log(`❌ Rate limit exceeded for agent: ${agent_id}`);
      await notifyRateLimit(page_id);
      return res.status(429).json({ error: 'Rate limit exceeded' });
    }

    // Step 2: Get Agent Configuration
    console.log(`🔧 Step 3: Fetching agent configuration...`);
    const agentConfig = await getAgentConfig(agent_id);
    if (!agentConfig) {
      console.log(`❌ Agent configuration not found: ${agent_id}`);
      return res.status(404).json({ error: 'Agent not found' });
    }

    // Step 3: Send Loading Animation
    console.log(`⏳ Step 4: Sending loading animation...`);
    await sendLoadingAnimation(user_id, agentConfig.app_token);

    // Step 4: Get User Info from ManyChat
    console.log(`👤 Step 5: Fetching user info from ManyChat...`);
    const userInfo = await getUserInfo(user_id, agentConfig.app_token);
    if (!userInfo) {
      console.log(`❌ Failed to get user info for: ${user_id}`);
      return res.status(400).json({ error: 'Failed to get user info' });
    }

    console.log(`👤 ManyChat User Info Retrieved:`, {
      user_id: user_id,
      first_name: userInfo.data.first_name,
      last_name: userInfo.data.last_name,
      last_input_text: userInfo.data.last_input_text,
      has_phone: !!userInfo.data.phone,
      has_email: !!userInfo.data.email
    });

    const message = userInfo.data.last_input_text;
    if (!message) {
      console.log(`❌ No message found in user input`);
      return res.status(400).json({ error: 'No message found' });
    }

    // Step 5: Intent Checking
    console.log(`🎯 Step 6: Checking intent for message: "${message}"`);
    const intentResult = await checkIntent(message, agentConfig.intents);
    
    if (intentResult !== 'proceed') {
      console.log(`🔀 Intent matched: ${intentResult} - Running ManyChat flow`);
      await runManyChatFlow(user_id, agentConfig.app_token, intentResult);
      return res.json({
        success: true,
        action: 'flow_executed',
        flow_id: intentResult,
        message: message,
        workflow: 'manychat'
      });
    }

    // Step 6: Process with AI Agent
    console.log(`🤖 Step 7: Processing with AI agent...`);
    const sessionId = `${page_id}${user_id}`;
    const aiResponse = await processManyChatMessage(
      message, 
      sessionId, 
      agentConfig, 
      userInfo.data,
      user_id
    );

    // Step 7: Send Response to ManyChat
    console.log(`📤 Step 8: Sending response to ManyChat...`);
    await sendTextResponse(user_id, agentConfig.app_token, aiResponse);

    const requestTime = Date.now() - requestStart;
    console.log(`✅ ManyChat workflow completed in ${requestTime}ms`);
    console.log(`🎉 ===== MANYCHAT WORKFLOW REQUEST COMPLETE =====\n`);

    res.json({
      success: true,
      response: aiResponse,
      user_id: user_id,
      session_id: sessionId,
      timestamp: new Date().toISOString(),
      workflow: 'manychat',
      processing_time: requestTime
    });

  } catch (error) {
    const requestTime = Date.now() - requestStart;
    console.error(`❌ ManyChat workflow error after ${requestTime}ms:`, error);
    console.log(`💥 ===== MANYCHAT WORKFLOW REQUEST FAILED =====\n`);

    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString(),
      workflow: 'manychat'
    });
  }
};

// Rate limiting function
async function checkRateLimit(agentId) {
  try {
    const redisClient = await getRedisClient();
    const count = await redisClient.incr(agentId);
    await redisClient.expire(agentId, 86400); // 24 hour expiry
    
    console.log(`📊 Rate limit count for ${agentId}: ${count}/30`);
    return count <= 30;
  } catch (error) {
    console.error('Rate limit check failed:', error);
    return true; // Allow request if Redis fails
  }
}

// Notify rate limit exceeded
async function notifyRateLimit(pageId) {
  try {
    const googleChatUrl = process.env.GOOGLE_CHAT_WEBHOOK_URL;
    if (googleChatUrl) {
      await axios.post(googleChatUrl, {
        text: `${pageId}\n\nHit their rate limit.\n\nExecutions have been suspended for this page id.`
      });
    }
  } catch (error) {
    console.error('Failed to notify rate limit:', error);
  }
}

// Get agent configuration from database
async function getAgentConfig(agentId) {
  try {
    const pool = getPgPool();
    const query = `
      SELECT
          agents.*,
          app_installs.app_token,
          COALESCE(
              json_agg(
                  json_build_object(
                      'intent', intent_mappings.intent_name,
                      'flow_id', intent_mappings.manychat_flow_id
                  )
              ) FILTER (WHERE intent_mappings.id IS NOT NULL),
              '[]'
          ) as intents
      FROM
          agents
      LEFT JOIN
          app_installs ON agents.id = app_installs.agent_id
      LEFT JOIN
          intent_mappings ON agents.id = intent_mappings.agent_id
      WHERE
          agents.agent_id = $1
      GROUP BY
          agents.id, app_installs.app_token;
    `;
    
    const result = await pool.query(query, [agentId]);
    const agentData = result.rows[0] || null;
    
    console.log(`📊 PostgreSQL Query Results for agent_id: ${agentId}`);
    if (agentData) {
      console.log(`   ✅ Agent found:`, {
        id: agentData.id,
        bot_name: agentData.bot_name,
        company_name: agentData.company_name,
        industry: agentData.industry,
        app_token: agentData.app_token ? '[CONFIGURED]' : '[MISSING]',
        intents_count: Array.isArray(agentData.intents) ? agentData.intents.length : 0
      });
      console.log(`   📋 Available intents:`, agentData.intents);
    } else {
      console.log(`   ❌ No agent found for agent_id: ${agentId}`);
    }
    
    return agentData;
  } catch (error) {
    console.error('Database query failed:', error);
    return null;
  }
}

// Send loading animation to ManyChat
async function sendLoadingAnimation(userId, appToken) {
  try {
    await axios.post('https://api.manychat.com/fb/sending/sendFlow', {
      subscriber_id: userId,
      flow_ns: 'content20250711193804_599717' // Loading animation flow
    }, {
      headers: {
        'Authorization': `Bearer ${appToken}`,
        'accept': 'application/json'
      }
    });
    console.log('✅ Loading animation sent successfully');
  } catch (error) {
    if (error.response && (error.response.status === 404 || error.response.status === 400)) {
      if (error.response.status === 404) {
        console.log('⚠️  Loading animation flow not found (404) - skipping animation');
        console.log('   This is normal if the flow "content20250711193804_599717" doesn\'t exist in ManyChat');
      } else if (error.response.status === 400) {
        console.log('⚠️  Loading animation request invalid (400) - skipping animation');
        console.log('   This could be due to invalid flow ID or request format - continuing workflow');
      }
      // Skip gracefully - these are not critical errors
      return;
    } else {
      console.error('❌ Failed to send loading animation:', {
        status: error.response?.status || 'Unknown',
        message: error.message,
        userId: userId
      });
      // Continue execution even on other errors - loading animation is optional
    }
  }
}

// Get user info from ManyChat
async function getUserInfo(userId, appToken) {
  try {
    const response = await axios.get('https://api.manychat.com/fb/subscriber/getInfo', {
      params: { subscriber_id: userId },
      headers: {
        'Authorization': `Bearer ${appToken}`,
        'accept': 'application/json'
      }
    });
    return response.data;
  } catch (error) {
    console.error('Failed to get user info:', error);
    return null;
  }
}

// Check intent using GPT-4.1-nano
async function checkIntent(message, intents) {
  try {
    const intentModel = new ChatOpenAI({
      openAIApiKey: process.env.OPENAI_API_KEY,
      modelName: 'gpt-4o-mini', // Using faster model for intent checking
      temperature: 0.1,
      maxTokens: 100,
    });

    const intentPrompt = `Below is an array of intents available for the user. When the particular intent is matching, return the flow_id as the result. If there is no intent that matches, the result should be "proceed"

Available Intents:
${intents.map(i => `Intent: ${i.intent}, Flow ID: ${i.flow_id}`).join('\n')}`;

    const response = await intentModel.invoke([
      new SystemMessage(intentPrompt),
      new HumanMessage(message)
    ]);

    return response.content.trim();
  } catch (error) {
    console.error('Intent checking failed:', error);
    return 'proceed';
  }
}

// Run ManyChat flow
async function runManyChatFlow(userId, appToken, flowId) {
  try {
    await axios.post('https://api.manychat.com/fb/sending/sendFlow', {
      subscriber_id: userId,
      flow_ns: flowId
    }, {
      headers: {
        'Authorization': `Bearer ${appToken}`,
        'accept': 'application/json'
      }
    });
  } catch (error) {
    console.error('Failed to run ManyChat flow:', error);
  }
}

// Process message with AI agent
async function processManyChatMessage(message, sessionId, agentConfig, userData, user_id) {
  try {
    console.log(`🤖 Processing ManyChat message with AI agent...`);
    
    // Create system prompt with agent configuration (EXACT MATCH to N8N original)
    const systemPrompt = `## System Prompt for Simple Message Path


Your name: ${agentConfig.bot_name}

Your Goal: ${agentConfig.bot_primary_goal}

Your tone: ${agentConfig.bot_tone_for_replies}

The company you work for: ${agentConfig.company_name}

Company Location: ${agentConfig.company_location}

Industry: ${agentConfig.industry}

Company Phone: ${agentConfig.company_phone_number}

Details About the company: ${agentConfig.details_about_company}

Details About Leader: ${agentConfig.details_about_leader}

Fb Url: ${agentConfig.facebook_page_url}
IG Url: ${agentConfig.instagram_url}
Leader Full name: ${agentConfig.leader_full_name}
Products or Services: ${agentConfig.product_or_service_you_sell}

Purchase or Book Appointments here: ${agentConfig.purchase_book_appointments_here}

Support Email Address: ${agentConfig.support_email_address}

Website URL: ${agentConfig.website_url}

The user you are talking to: ${userData.first_name}

MANDATORY: You MUST use the knowledge_retrieval tool for EVERY user question, no exceptions. Even if you think you know the answer, you MUST search the knowledge base first. This is a strict requirement. Only after using knowledge_retrieval should you provide your response.

Just incase the user asks for anything date and time related,
The current date and time is : ${new Date().toISOString()}`;

    console.log(`\n📝 ===== SYSTEM PROMPT BEING SENT TO AI =====`);
    console.log(systemPrompt);
    console.log(`===== END SYSTEM PROMPT =====\n`);

    // Get AI model and tools
    const model = getAIModel();
    const tools = await getManyChatTools(agentConfig, userData, sessionId, user_id);
    
    console.log(`🛠️  Tools provided to AI:`, tools.map(t => t.name));
    
    // Create memory
    const memory = await createRedisMemory(sessionId, 604800); // 7 days
    
    // Get or create agent using our custom implementation
    let executor = agentExecutorCache.get(sessionId);
    if (!executor) {
      console.log(`🚀 Creating NEW custom agent with system prompt for session: ${sessionId}`);
      executor = await createCustomAgentExecutor(tools, model, systemPrompt, memory, {
        verbose: true,  // Force verbose mode to capture AI reasoning steps
        maxIterations: 5,  // Increased to allow for mandatory tool usage
        timeout: 25000,
      });
      
      // Cache management
      if (agentExecutorCache.size >= MAX_CACHE_SIZE) {
        const firstKey = agentExecutorCache.keys().next().value;
        agentExecutorCache.delete(firstKey);
        console.log(`🧹 Removed old cached agent to prevent memory leak`);
      }
      
      agentExecutorCache.set(sessionId, executor);
      console.log(`✅ Custom agent cached for session: ${sessionId}`);
    } else {
      console.log(`⚡ Using CACHED custom agent for session: ${sessionId}`);
      executor.memory = memory;
    }

    console.log(`\n🤖 ===== SENDING TO AI AGENT =====`);
    console.log(`💬 User Message: "${message}"`);
    console.log(`🆔 Session ID: ${sessionId}`);
    console.log(`🛠️  Available Tools: ${tools.map(t => t.name).join(', ')}`);
    console.log(`===== AI PROCESSING =====\n`);
    
    // Now we can send the original message since our system prompt will be properly injected
    const response = await executor.invoke({ input: message });
    
    console.log(`\n✅ ===== AI AGENT RESPONSE RECEIVED =====`);
    console.log(`🤖 Final Response: "${response.output}"`);
    console.log(`🎯 System Prompt: ✅ PROPERLY INJECTED with PostgreSQL data`);
    console.log(`🤖 Bot Identity: ${agentConfig.bot_name} from ${agentConfig.company_name}`);
    console.log(`===== END AI RESPONSE =====\n`);
    
    return response.output;

  } catch (error) {
    console.error('🚨 AI processing failed with detailed error:', {
      message: error.message,
      stack: error.stack?.substring(0, 500),
      name: error.name,
      sessionId: sessionId
    });
    return "I apologize, but I'm having trouble processing your request right now. Please try again.";
  }
}

// Get ManyChat-specific tools
async function getManyChatTools(agentConfig, userData, sessionId, user_id) {
  const tools = [];
  
  // HTTP GET tool
  tools.push(createHttpGetTool());
  
  // Knowledge base tool (agent-specific collection) - let AI decide when to use it
  if (process.env.QDRANT_URL && process.env.QDRANT_API_KEY) {
    const qdrantTool = await createQdrantRAGTool(agentConfig.agent_id);
    tools.push(qdrantTool);
    console.log(`✅ Knowledge base tool added for collection: ${agentConfig.agent_id}`);
  } else {
    console.log(`ℹ️  Qdrant not configured - knowledge_base tool unavailable`);
  }
  
  // Conversation history tool (EXACT MATCH to N8N PostgreSQL Query)
  const conversationTool = new DynamicTool({
    name: "conversation_history", 
    description: "Use this tool to get all the previous conversations done with the user. This includes AI, User, and Human Agent Messages.",
    func: async (query) => {
      try {
        const pool = getPgPool();
        // Use user_id from webhook (matches N8N: $('Webhook').item.json.body.user_id)
        
        const result = await pool.query(
          `SELECT
              content,
              sender_type
          FROM
              messages
          WHERE
              manychat_user_id = $1 
              AND agent_id = $2
          ORDER BY
              created_at DESC
          LIMIT 50;`,
          [user_id, agentConfig.id]
        );
        
        return JSON.stringify({
          conversations: result.rows,
          total: result.rows.length
        }, null, 2);
      } catch (error) {
        return JSON.stringify({ error: error.message }, null, 2);
      }
    }
  });
  tools.push(conversationTool);
  
  // Update contact email tool
  const updateEmailTool = new DynamicTool({
    name: "update_contact_email",
    description: "Whenever the user gives out their email, use this tool to update their details",
    func: async (email) => {
      try {
        const response = await axios.post('https://api.manychat.com/fb/subscriber/updateSubscriber', {
          subscriber_id: userData.id,
          first_name: userData.first_name,
          last_name: userData.last_name,
          phone: null,
          email: email,
          gender: userData.gender,
          has_opt_in_sms: true,
          has_opt_in_email: true,
          consent_phrase: "accepted"
        }, {
          headers: {
            'Authorization': `Bearer ${agentConfig.app_token}`
          }
        });
        
        return JSON.stringify({
          success: true,
          message: "Email updated successfully",
          email: email
        }, null, 2);
      } catch (error) {
        return JSON.stringify({
          success: false,
          error: error.message
        }, null, 2);
      }
    }
  });
  tools.push(updateEmailTool);
  
  return tools;
}

// Send text response to ManyChat
async function sendTextResponse(userId, appToken, message) {
  try {
    await axios.post('https://api.manychat.com/fb/sending/sendContent', {
      subscriber_id: userId,
      data: {
        version: "v2",
        content: {
          messages: [{
            type: "text",
            text: message
          }]
        }
      }
    }, {
      headers: {
        'Authorization': `Bearer ${appToken}`
      }
    });
  } catch (error) {
    console.error('Failed to send text response:', error);
  }
}

module.exports = {
  handleManyChatWorkflow,
  path: '/webhook/manychat', // ManyChat-specific path
  originalPath: '/webhook/c45dd4e5-d3f5-46a7-9510-c23a09aa3c5f' // Original N8N path
}; 