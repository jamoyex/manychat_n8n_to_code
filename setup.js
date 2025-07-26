const fs = require('fs');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Color codes
const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  yellow: '\x1b[33m',
  reset: '\x1b[0m'
};

console.log(`${colors.blue}🚀 N8N to Node.js Chatbot Setup${colors.reset}\n`);

async function askQuestion(question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer);
    });
  });
}

async function setup() {
  try {
    console.log(`${colors.yellow}This setup will help you create your .env file.${colors.reset}\n`);

    // Ask for OpenAI API Key
    const openaiKey = await askQuestion(`${colors.blue}Enter your OpenAI API Key: ${colors.reset}`);
    
    if (!openaiKey.trim()) {
      console.log(`${colors.red}❌ OpenAI API Key is required!${colors.reset}`);
      process.exit(1);
    }

    // Ask for Redis URL
    const redisUrl = await askQuestion(`${colors.blue}Enter Redis URL (press Enter for default 'redis://localhost:6379'): ${colors.reset}`);
    const finalRedisUrl = redisUrl.trim() || 'redis://localhost:6379';

    // Ask for Port
    const port = await askQuestion(`${colors.blue}Enter port number (press Enter for default '3000'): ${colors.reset}`);
    const finalPort = port.trim() || '3000';

    // Create .env file content
    const envContent = `# OpenAI Configuration
OPENAI_API_KEY=${openaiKey}

# Redis Configuration  
REDIS_URL=${finalRedisUrl}

# Server Configuration
PORT=${finalPort}
`;

    // Write .env file
    fs.writeFileSync('.env', envContent);
    
    console.log(`\n${colors.green}✅ .env file created successfully!${colors.reset}`);
    console.log(`\n${colors.yellow}📋 Configuration Summary:${colors.reset}`);
    console.log(`   OpenAI API Key: ${openaiKey.substring(0, 10)}...`);
    console.log(`   Redis URL: ${finalRedisUrl}`);
    console.log(`   Port: ${finalPort}`);

    console.log(`\n${colors.blue}🔄 Next Steps:${colors.reset}`);
    console.log(`   1. Make sure Redis is running`);
    console.log(`   2. Install dependencies: ${colors.yellow}npm install${colors.reset}`);
    console.log(`   3. Start the server: ${colors.yellow}npm start${colors.reset}`);
    console.log(`   4. Test the application: ${colors.yellow}npm test${colors.reset}`);

    console.log(`\n${colors.green}🎉 Setup complete!${colors.reset}`);

  } catch (error) {
    console.error(`${colors.red}❌ Setup error: ${error.message}${colors.reset}`);
  } finally {
    rl.close();
  }
}

setup(); 