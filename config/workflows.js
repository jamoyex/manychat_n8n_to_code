const simpleWorkflow = require('../workflows/simpleWorkflow');
const manychatWorkflow = require('../workflows/manychatWorkflow');

// Registry of all available workflows
const workflows = new Map();

// Register workflows with their paths
workflows.set('/webhook', simpleWorkflow);
workflows.set('/webhook/b7194f70-67fd-4f46-8c39-27bc98a17838', simpleWorkflow); // Original N8N path
workflows.set('/webhook/manychat', manychatWorkflow);
workflows.set('/webhook/c45dd4e5-d3f5-46a7-9510-c23a09aa3c5f', manychatWorkflow); // Original N8N path

// Function to get workflow by path
const getWorkflowByPath = (path) => {
  return workflows.get(path) || null;
};

// Function to register a new workflow
const registerWorkflow = (path, workflowModule) => {
  workflows.set(path, workflowModule);
  console.log(`✅ Registered workflow: ${path} -> ${workflowModule.constructor.name}`);
};

// Function to list all registered workflows
const listWorkflows = () => {
  const workflowList = [];
  workflows.forEach((workflow, path) => {
    workflowList.push({
      path: path,
      handler: workflow.handleSimpleWorkflow ? 'Simple' : 'ManyChat',
      originalPath: workflow.originalPath || null
    });
  });
  return workflowList;
};

// Function to get workflow info for health check
const getWorkflowsInfo = () => {
  return {
    total_workflows: workflows.size,
    registered_paths: Array.from(workflows.keys()),
    workflow_types: {
      simple: Array.from(workflows.values()).filter(w => w.handleSimpleWorkflow).length,
      manychat: Array.from(workflows.values()).filter(w => w.handleManyChatWorkflow).length
    }
  };
};

module.exports = {
  getWorkflowByPath,
  registerWorkflow,
  listWorkflows,
  getWorkflowsInfo,
  workflows
}; 