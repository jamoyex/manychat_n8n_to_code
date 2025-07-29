const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
require('dotenv').config();

// Import utilities and workflow registry
const { getRedisClient } = require('./utils/shared');
const { getWorkflowByPath, getWorkflowsInfo, listWorkflows } = require('./config/workflows');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// Initialize shared resources
let sharedResourcesInitialized = false;

async function initializeSharedResources() {
  if (sharedResourcesInitialized) return;
  
  try {
    console.log(`🚀 [${new Date().toISOString()}] Initializing shared resources...`);
    
    // Initialize Redis connection
    await getRedisClient();
    
    sharedResourcesInitialized = true;
    console.log(`✅ Shared resources initialized successfully`);
  } catch (error) {
    console.error(`❌ Failed to initialize shared resources:`, error);
    throw error;
  }
}



// Register all webhook routes dynamically  
const registerWorkflowRoutes = () => {
  console.log(`🔧 Registering workflow routes...`);

  // Test route first
  app.post('/test', (req, res) => {
    res.json({ message: 'Test route works!', body: req.body });
  });
  console.log(`   ✅ /test -> Test Route (for debugging)`);

  // Import workflow handlers
  const simpleWorkflow = require('./workflows/simpleWorkflow');
  const manychatWorkflow = require('./workflows/manychatWorkflow');
  
  // Register Simple Workflow routes
  app.post('/webhook', (req, res) => {
    console.log(`🔀 Simple webhook called with body:`, req.body);
    simpleWorkflow.handleSimpleWorkflow(req, res);
  });
  
  app.post('/webhook/b7194f70-67fd-4f46-8c39-27bc98a17838', (req, res) => {
    console.log(`🔀 N8N webhook called with body:`, req.body);
    simpleWorkflow.handleSimpleWorkflow(req, res);
  });
  
  console.log(`   ✅ /webhook -> Simple Workflow`);
  console.log(`   ✅ /webhook/b7194f70-67fd-4f46-8c39-27bc98a17838 -> Simple Workflow`);
  
  // Register ManyChat Workflow routes
  app.post('/webhook/manychat', (req, res) => {
    console.log(`🔀 ManyChat webhook called with body:`, req.body);
    manychatWorkflow.handleManyChatWorkflow(req, res);
  });
  
  app.post('/webhook/c45dd4e5-d3f5-46a7-9510-c23a09aa3c5f', (req, res) => {
    console.log(`🔀 N8N ManyChat webhook called with body:`, req.body);
    manychatWorkflow.handleManyChatWorkflow(req, res);
  });
  
  console.log(`   ✅ /webhook/manychat -> ManyChat Workflow`);
  console.log(`   ✅ /webhook/c45dd4e5-d3f5-46a7-9510-c23a09aa3c5f -> ManyChat Workflow`);
  
  console.log(`✅ 5 workflow routes registered (including test)`);
};

// Health check endpoint with workflow information
app.get('/health', async (req, res) => {
  try {
    const workflowsInfo = getWorkflowsInfo();
    const redisClient = await getRedisClient();
    
    res.json({
      status: 'OK',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      redis_connected: redisClient?.isReady || false,
      ai_model: process.env.AI_MODEL || 'gpt-4-1106-preview',
      ai_provider: process.env.AI_PROVIDER || 'openai',
      node_version: process.version,
      environment: process.env.NODE_ENV || 'development',
      
      // Workflow information
      workflows: workflowsInfo,
      
      // Feature flags
      features: {
        langchain_enabled: true,
        qdrant_configured: !!process.env.QDRANT_URL,
        postgres_configured: !!process.env.POSTGRES_URL,
        redis_configured: !!process.env.REDIS_URL,
        manychat_integration: true,
        performance_optimizations: true
      }
    });
  } catch (error) {
    res.status(500).json({
      status: 'ERROR',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Workflow management endpoints
app.get('/workflows', (req, res) => {
  try {
    const workflows = listWorkflows();
    res.json({
      success: true,
      total: workflows.length,
      workflows: workflows,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Root endpoint with API information
app.get('/', (req, res) => {
  const workflowsInfo = getWorkflowsInfo();
  
  res.json({
    message: 'N8N to Node.js Modular Workflow System',
    version: '2.0.0',
    description: 'Modular chatbot system with multiple workflow support',
    
    endpoints: {
      health: '/health',
      workflows: '/workflows',
      webhook_simple: '/webhook',
      webhook_manychat: '/webhook/manychat'
    },
    
    workflows: workflowsInfo,
    
    features: [
      'Modular Workflow Architecture',
      'LangChain AI Agents',
      'Redis Conversation Memory',
      'Qdrant RAG Integration',
      'ManyChat Integration',
      'PostgreSQL Database Support',
      'Performance Optimizations',
      'Rate Limiting',
      'Intent Recognition'
    ],
    
    documentation: 'See README.md for setup and usage instructions',
    timestamp: new Date().toISOString()
  });
});

// Global error handler
app.use((error, req, res, next) => {
  console.error(`🚨 Global error handler:`, error);
  
  if (!res.headersSent) {
    res.status(500).json({
      success: false,
      error: error.message,
      path: req.path,
      timestamp: new Date().toISOString()
    });
  }
});

// Start server function
async function startServer() {
  try {
    console.log(`\n🚀 [${new Date().toISOString()}] ===== STARTING MODULAR WORKFLOW SERVER =====`);
    console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🔧 Node.js Version: ${process.version}`);
    console.log(`🤖 AI Model: ${process.env.AI_MODEL || 'gpt-4-1106-preview'}`);
    console.log(`🔌 Redis URL: ${process.env.REDIS_URL ? 'Configured' : 'Not configured'}`);
    console.log(`🗄️  Qdrant URL: ${process.env.QDRANT_URL ? 'Configured' : 'Not configured'}`);
    console.log(`🐘 PostgreSQL: ${process.env.POSTGRES_URL ? 'Configured' : 'Not configured'}`);
    
    // Initialize shared resources
    await initializeSharedResources();
    
    // Register workflow routes
    registerWorkflowRoutes();
    
    // 404 handler for unregistered routes (MUST be after route registration)
    app.use('*', (req, res) => {
      const availablePaths = ['/webhook', '/webhook/b7194f70-67fd-4f46-8c39-27bc98a17838', '/webhook/manychat', '/webhook/c45dd4e5-d3f5-46a7-9510-c23a09aa3c5f'];
      
      res.status(404).json({
        error: 'Route not found',
        requested_path: req.path,
        method: req.method,
        available_webhook_paths: availablePaths,
        available_endpoints: ['/health', '/workflows', '/'],
        timestamp: new Date().toISOString()
      });
    });
    
    // Start the server
    const server = app.listen(PORT, '0.0.0.0', () => {
      const address = server.address();
      console.log(`\n✅ Server running successfully!`);
      console.log(`📍 Local: http://localhost:${address.port}`);
      
      // Show local network URL if available
      const networkInterfaces = require('os').networkInterfaces();
      const networkAddresses = [];
      Object.keys(networkInterfaces).forEach(interfaceName => {
        networkInterfaces[interfaceName].forEach(iface => {
          if (iface.family === 'IPv4' && !iface.internal) {
            networkAddresses.push(`http://${iface.address}:${address.port}`);
          }
        });
      });
      
      if (networkAddresses.length > 0) {
        console.log(`🌐 Network: ${networkAddresses.join(', ')}`);
        console.log(`📱 Mobile testing available at: ${networkAddresses[0]}`);
      }
      
      console.log(`\n📋 Available Workflows:`);
      listWorkflows().forEach(workflow => {
        console.log(`   ${workflow.path} -> ${workflow.handler} Workflow`);
      });
      
      console.log(`\n📝 Management Endpoints:`);
      console.log(`   GET  / -> API Information`);
      console.log(`   GET  /health -> Health Check`);
      console.log(`   GET  /workflows -> Workflow Registry`);
      
      console.log(`\n📝 Waiting for incoming requests...`);
    });

    // Graceful shutdown handling
    const gracefulShutdown = (signal) => {
      console.log(`\n🛑 [${new Date().toISOString()}] Received ${signal}. Starting graceful shutdown...`);
      
      server.close(async () => {
        console.log(`✅ HTTP server closed`);
        
        try {
          const redisClient = await getRedisClient();
          if (redisClient) {
            await redisClient.quit();
            console.log(`✅ Redis connection closed`);
          }
        } catch (error) {
          console.error(`❌ Error closing Redis connection:`, error);
        }
        
        console.log(`🎉 Graceful shutdown complete`);
        process.exit(0);
      });
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  } catch (error) {
    console.error(`❌ Failed to start server:`, error);
    process.exit(1);
  }
}

// Add new dependencies to package.json
const addNewDependencies = () => {
  const fs = require('fs');
  const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  
  const newDependencies = {
    "pg": "^8.11.3" // PostgreSQL client for ManyChat workflow
  };
  
  let needsUpdate = false;
  Object.keys(newDependencies).forEach(dep => {
    if (!packageJson.dependencies[dep]) {
      packageJson.dependencies[dep] = newDependencies[dep];
      needsUpdate = true;
    }
  });
  
  if (needsUpdate) {
    fs.writeFileSync('package.json', JSON.stringify(packageJson, null, 2));
    console.log(`✅ Added new dependencies to package.json`);
    console.log(`🔧 Run 'npm install' to install new dependencies`);
  }
};

// Start the server
if (require.main === module) {
  addNewDependencies();
  startServer();
}

module.exports = app; 