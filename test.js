const fetch = require('node-fetch');

// Configuration
const BASE_URL = 'http://localhost:3000';
const TEST_SESSION_ID = 'test-session-' + Date.now();

// Test messages
const testMessages = [
  "Hello, how are you?",
  "What's the weather like today?",
  "Can you remember what I just asked you?",
  "Thanks for the help!"
];

// Color codes for better output
const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  yellow: '\x1b[33m',
  reset: '\x1b[0m'
};

async function testWebhook(url, message, sessionId) {
  try {
    console.log(`${colors.blue}📤 Sending: "${message}"${colors.reset}`);
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: message,
        session_id: sessionId
      })
    });

    const data = await response.json();

    if (response.ok && data.success) {
      console.log(`${colors.green}✅ Response: "${data.response}"${colors.reset}`);
      return true;
    } else {
      console.log(`${colors.red}❌ Error: ${data.error || 'Unknown error'}${colors.reset}`);
      return false;
    }
  } catch (error) {
    console.log(`${colors.red}❌ Network Error: ${error.message}${colors.reset}`);
    return false;
  }
}

async function testHealthCheck() {
  try {
    console.log(`${colors.blue}🏥 Testing health check...${colors.reset}`);
    const response = await fetch(`${BASE_URL}/health`);
    const data = await response.json();
    
    if (response.ok) {
      console.log(`${colors.green}✅ Health check passed: ${data.status}${colors.reset}`);
      return true;
    } else {
      console.log(`${colors.red}❌ Health check failed${colors.reset}`);
      return false;
    }
  } catch (error) {
    console.log(`${colors.red}❌ Health check error: ${error.message}${colors.reset}`);
    return false;
  }
}

async function runTests() {
  console.log(`${colors.yellow}🧪 Starting N8N to Node.js Chatbot Tests${colors.reset}`);
  console.log(`${colors.yellow}Session ID: ${TEST_SESSION_ID}${colors.reset}\n`);

  // Test health check first
  const healthOk = await testHealthCheck();
  if (!healthOk) {
    console.log(`${colors.red}⚠️  Server might not be running. Please start it with: npm start${colors.reset}`);
    return;
  }

  console.log('');

  // Test original n8n webhook path
  console.log(`${colors.yellow}📝 Testing Original N8N Webhook Path${colors.reset}`);
  const originalWebhookUrl = `${BASE_URL}/webhook/b7194f70-67fd-4f46-8c39-27bc98a17838`;
  
  let successCount = 0;
  
  for (const message of testMessages) {
    const success = await testWebhook(originalWebhookUrl, message, TEST_SESSION_ID);
    if (success) successCount++;
    
    // Add delay between messages to see conversation flow
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.log('');

  // Test generic webhook
  console.log(`${colors.yellow}🔧 Testing Generic Webhook Path${colors.reset}`);
  const genericWebhookUrl = `${BASE_URL}/webhook`;
  const testSuccess = await testWebhook(genericWebhookUrl, "This is a test of the generic webhook", 'generic-test');

  console.log('');

  // Summary
  console.log(`${colors.yellow}📊 Test Summary${colors.reset}`);
  console.log(`Health Check: ${healthOk ? '✅' : '❌'}`);
  console.log(`Original Webhook: ${successCount}/${testMessages.length} messages successful`);
  console.log(`Generic Webhook: ${testSuccess ? '✅' : '❌'}`);

  if (healthOk && successCount === testMessages.length && testSuccess) {
    console.log(`${colors.green}🎉 All tests passed! Your chatbot is working correctly.${colors.reset}`);
  } else {
    console.log(`${colors.red}⚠️  Some tests failed. Check the server logs and configuration.${colors.reset}`);
  }
}

// Handle errors
process.on('unhandledRejection', (error) => {
  console.error(`${colors.red}❌ Unhandled error: ${error.message}${colors.reset}`);
});

// Run tests if this file is executed directly
if (require.main === module) {
  runTests().catch(error => {
    console.error(`${colors.red}❌ Test execution failed: ${error.message}${colors.reset}`);
    process.exit(1);
  });
}

module.exports = { testWebhook, testHealthCheck, runTests }; 