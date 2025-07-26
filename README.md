# N8N to Node.js Chatbot with LangChain & Tools

This Node.js application replicates your enhanced n8n workflow functionality, providing a chatbot API with LangChain integration, tool support, and Redis-based conversation memory.

## Features

- 🤖 **AI-Powered Chat**: Uses LangChain with OpenAI GPT-4 for intelligent responses
- 🔧 **Tool Support**: HTTP GET tool for web requests (easily extensible)
- 📚 **RAG Support**: Qdrant vector database integration for knowledge retrieval
- 💾 **Conversation Memory**: LangChain Redis memory for persistent chat history
- 🔄 **Easy Model Swapping**: Configuration-based AI model switching
- 🌐 **Webhook API**: RESTful endpoints for chat interactions
- 🔒 **Security**: Built-in CORS and security headers
- ⚡ **Fast & Scalable**: Express.js with LangChain framework

## Architecture

The application replicates your enhanced n8n workflow:

1. **Webhook** → Express.js POST endpoint
2. **AI Agent** → LangChain agent with tool support
3. **OpenAI Chat Model** → LangChain ChatOpenAI wrapper
4. **Redis Chat Memory** → LangChain Redis conversation memory
5. **HTTP GET Tool** → Custom tool for web requests
6. **Qdrant Vector Store** → Knowledge retrieval with RAG
7. **OpenAI Embeddings** → Text embeddings for vector search
8. **Respond to Webhook** → JSON response with tool usage info

## Prerequisites

- Node.js (v16 or higher)
- Redis server running
- OpenAI API key

## Installation

1. **Clone/Download** this project
2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Set up environment variables**:
   Copy the sample environment file and edit it:
   ```bash
   cp env.sample .env
   ```
   
   Then edit `.env` with your actual values:
   ```env
   # OpenAI Configuration
   OPENAI_API_KEY=your_openai_api_key_here
   
   # Redis Configuration  
   REDIS_URL=redis://localhost:6379
   
   # Server Configuration
   PORT=3000
   
   # AI Model Configuration (Easy to swap models!)
   AI_MODEL=gpt-4-1106-preview
   AI_PROVIDER=openai
   AI_TEMPERATURE=0.7
   AI_MAX_TOKENS=1000
   
   # Qdrant Vector Database Configuration (for RAG)
   QDRANT_URL=https://your-qdrant-url.com
   QDRANT_API_KEY=your_qdrant_api_key_here
   QDRANT_COLLECTION=knowledge_base
   EMBEDDING_MODEL=text-embedding-3-small
   RAG_TOP_K=5
   
   # LangChain Configuration
   LANGCHAIN_VERBOSE=false
   ```
   
   Or use the interactive setup:
   ```bash
   npm run setup
   ```

4. **Start Redis** (if not already running):
   ```bash
   # Using Docker
   docker run -d -p 6379:6379 redis:alpine
   
   # Or using Homebrew on macOS
   brew services start redis
   
   # Or using your system's package manager
   sudo systemctl start redis
   ```

## Usage

### Start the Server

```bash
# Development mode (with auto-restart)
npm run dev

# Production mode
npm start
```

The server will start on `http://localhost:3000` (or your specified PORT).

### API Endpoints

#### 1. Original N8N Webhook (Exact Path Match)
```http
POST http://localhost:3000/webhook/b7194f70-67fd-4f46-8c39-27bc98a17838
Content-Type: application/json

{
  "message": "Hello, how are you?",
  "session_id": "user123"
}
```

#### 2. Generic Webhook (For Testing)
```http
POST http://localhost:3000/webhook
Content-Type: application/json

{
  "message": "Hello, how are you?",
  "session_id": "user123"  // Optional, defaults to "default"
}
```

#### 3. Health Check
```http
GET http://localhost:3000/health
```

### Request Format

Both webhook endpoints expect:

```json
{
  "message": "Your message here",      // Required
  "session_id": "unique_session_id"   // Required for original endpoint, optional for generic
}
```

### Response Format

Successful responses:
```json
{
  "success": true,
  "response": "AI assistant's response here",
  "session_id": "user123",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

Error responses:
```json
{
  "success": false,
  "error": "Error description",
  "message": "Detailed error message"
}
```

## Testing with cURL

```bash
# Test the original n8n webhook path
curl -X POST http://localhost:3000/webhook/b7194f70-67fd-4f46-8c39-27bc98a17838 \
  -H "Content-Type: application/json" \
  -d '{
    "message": "What is the weather like today?",
    "session_id": "test-session-1"
  }'

# Test the generic webhook
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Hello there!",
    "session_id": "test-session-2"
  }'
```

## Tools & Capabilities

### HTTP GET Tool
The chatbot can make HTTP GET requests to any URL. Simply ask it to fetch data from a website:

**Examples:**
- "Can you get the content from https://api.github.com/users/octocat?"
- "Fetch data from https://jsonplaceholder.typicode.com/posts/1"
- "What's on the homepage of https://httpbin.org/get"

### Knowledge Retrieval (RAG)
The chatbot can search your Qdrant vector database to retrieve relevant knowledge and answer questions based on your stored documents:

**Examples:**
- "What does our company policy say about remote work?"
- "Can you find information about our product features?"
- "Search for documentation about API authentication"

**Configuration Required:**
- Qdrant vector database instance
- Pre-populated knowledge base collection
- OpenAI embeddings for vector search

### Tool Usage in Responses
When tools are used, the response includes information about which tools were executed:

```json
{
  "success": true,
  "response": "I fetched the data from the URL. Here's what I found...",
  "session_id": "user123",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "tools_available": ["http_get", "knowledge_retrieval"],
  "ai_model": "gpt-4-1106-preview",
  "rag_enabled": true
}
```

## Configuration

### Easy Model Swapping
Change AI models by updating your `.env` file:

```env
# Use different OpenAI models
AI_MODEL=gpt-4-1106-preview
# AI_MODEL=gpt-3.5-turbo
# AI_MODEL=gpt-4

# Adjust creativity/randomness
AI_TEMPERATURE=0.7  # 0.0 = deterministic, 1.0 = creative

# Control response length
AI_MAX_TOKENS=1000

# Enable verbose LangChain logging
LANGCHAIN_VERBOSE=true
```

### Future Model Support
The architecture is designed to easily support other AI providers:

```javascript
// In getAIModel() function - ready for expansion
switch (process.env.AI_PROVIDER) {
  case 'openai': return new ChatOpenAI({...});
  // case 'anthropic': return new ChatAnthropic({...});
  // case 'azure': return new AzureChatOpenAI({...});
}
```

### Redis Configuration
Conversation history is stored in Redis with:
- Key format: `chat_history:{session_id}`
- Expiration: 24 hours
- Data format: JSON array of message objects

### Memory Management
Each session maintains its conversation history separately. Messages are stored as:
```json
[
  {"role": "user", "content": "Hello"},
  {"role": "assistant", "content": "Hi there!"},
  {"role": "user", "content": "How are you?"},
  {"role": "assistant", "content": "I'm doing well, thanks!"}
]
```

## Production Deployment

### Environment Variables for Production
```env
OPENAI_API_KEY=your_production_openai_key
REDIS_URL=redis://your-redis-host:6379
PORT=3000
NODE_ENV=production
```

### Docker Support
You can containerize this application:

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
```

### Security Considerations
- Use HTTPS in production
- Implement rate limiting
- Add authentication/authorization if needed
- Monitor Redis memory usage
- Set up proper logging

## Troubleshooting

### Common Issues

1. **Redis Connection Error**
   - Ensure Redis is running
   - Check Redis URL in `.env`
   - Verify Redis is accessible

2. **OpenAI API Errors**
   - Verify API key is correct
   - Check API quotas and billing
   - Ensure model availability

3. **Port Already in Use**
   - Change PORT in `.env`
   - Or kill the process using the port

### Logs
The application logs important events:
- Server startup
- Redis connections
- Message processing
- Errors and warnings

## License

MIT

## Support

For issues or questions about this conversion from n8n to Node.js, please check the logs and ensure all prerequisites are properly configured. 