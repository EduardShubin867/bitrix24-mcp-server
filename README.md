# Bitrix24 MCP Server

A comprehensive Model Context Protocol (MCP) server for Bitrix24 CRM integration, enabling AI agents to seamlessly interact with your Bitrix24 instance through a powerful set of tools.

## 🚀 Features

- **Complete CRM Management**: Create, read, update, and list contacts, deals, and tasks
- **Advanced Search**: Search across all CRM entities with flexible filtering
- **Rate Limiting**: Built-in rate limiting to respect Bitrix24 API limits
- **Type Safety**: Full TypeScript implementation with comprehensive type definitions
- **Error Handling**: Robust error handling and validation
- **Easy Integration**: Simple setup with Claude Desktop and other MCP-compatible clients

## 📋 Available Tools

### Contact Management
- `bitrix24_create_contact` - Create new contacts
- `bitrix24_get_contact` - Retrieve contact by ID
- `bitrix24_list_contacts` - List contacts with filtering
- `bitrix24_update_contact` - Update existing contacts

### Deal Management
- `bitrix24_create_deal` - Create new deals
- `bitrix24_get_deal` - Retrieve deal by ID
- `bitrix24_list_deals` - List deals with filtering
- `bitrix24_update_deal` - Update existing deals

### Task Management
- `bitrix24_create_task` - Create new tasks
- `bitrix24_get_task` - Retrieve task by ID
- `bitrix24_list_tasks` - List tasks with filtering
- `bitrix24_update_task` - Update existing tasks
- `bitrix24_list_my_tasks` - List tasks for the current webhook user using `user.current` + `tasks.task.list`
- `bitrix24_list_tasks_by_user` - List tasks for a specified user and role
- `bitrix24_get_task_full` - Get the full task card with CRM links, files, and chat ID
- `bitrix24_get_task_messages` - Read task chat messages using `im.dialog.messages.get`
- `bitrix24_get_task_file_info` - Get Bitrix24 Disk file metadata and download URL
- `bitrix24_get_my_task_counters` - Get task counters for the current user

### User Management
- `bitrix24_get_current_user` - Get current Bitrix24 user via `user.current`
- `bitrix24_search_users` - Search active employees by query, email, or name
- `bitrix24_get_user` - Get user information by ID
- `bitrix24_get_all_users` - Get all users in the system with names and details
- `bitrix24_resolve_user_names` - Resolve user IDs to user names
- `bitrix24_get_contacts_with_user_names` - Get contacts with user names resolved
- `bitrix24_get_deals_with_user_names` - Get deals with user names resolved
- `bitrix24_get_leads_with_user_names` - Get leads with user names resolved
- `bitrix24_get_companies_with_user_names` - Get companies with user names resolved

### Lead Management
- `bitrix24_create_lead` - Create new leads
- `bitrix24_get_lead` - Retrieve lead by ID
- `bitrix24_list_leads` - List leads with filtering
- `bitrix24_get_latest_leads` - Get most recent leads
- `bitrix24_get_leads_from_date_range` - Get leads from specific date range
- `bitrix24_update_lead` - Update existing leads

### Company Management
- `bitrix24_create_company` - Create new companies
- `bitrix24_get_company` - Retrieve company by ID
- `bitrix24_list_companies` - List companies with filtering
- `bitrix24_get_latest_companies` - Get most recent companies
- `bitrix24_get_companies_from_date_range` - Get companies from specific date range
- `bitrix24_update_company` - Update existing companies

### Enhanced Deal Filtering
- `bitrix24_get_deal_pipelines` - Get all deal pipelines/categories
- `bitrix24_get_deal_stages` - Get deal stages for pipelines
- `bitrix24_filter_deals_by_pipeline` - Filter deals by pipeline
- `bitrix24_filter_deals_by_budget` - Filter deals by budget range
- `bitrix24_filter_deals_by_status` - Filter deals by stage/status

### Utilities
- `bitrix24_search_crm` - Search across CRM entities
- `bitrix24_validate_webhook` - Validate webhook connection
- `bitrix24_diagnose_permissions` - Diagnose webhook permissions
- `bitrix24_check_crm_settings` - Check CRM settings and configuration
- `bitrix24_test_leads_api` - Test leads API endpoints

### Sales Team Monitoring
- `bitrix24_monitor_user_activities` - Monitor user activities (calls, emails, timeline interactions, response times)
- `bitrix24_get_user_performance_summary` - Get comprehensive performance summary with deal metrics and conversion rates
- `bitrix24_analyze_account_performance` - Analyze performance for specific accounts (companies/contacts)
- `bitrix24_compare_user_performance` - Compare performance metrics between multiple users
- `bitrix24_track_deal_progression` - Track deal progression through pipeline stages with timing analysis
- `bitrix24_monitor_sales_activities` - Monitor sales-related activities (tasks, follow-ups, meetings)
- `bitrix24_generate_sales_report` - Generate comprehensive sales reports with customizable metrics
- `bitrix24_get_team_dashboard` - Get real-time team performance dashboard
- `bitrix24_analyze_customer_engagement` - Analyze customer engagement patterns and relationship health
- `bitrix24_forecast_performance` - Generate performance forecasts and predictive analytics

## 🛠️ Installation

### Prerequisites
- Node.js 18+ 
- npm or yarn
- Bitrix24 webhook URL

### Setup

1. **Clone and install dependencies:**
```bash
git clone <repository-url>
cd bitrix24-mcp-server
npm install
```

2. **Configure environment:**
```bash
cp .env.example .env
# Edit .env with your Bitrix24 webhook URL
```

3. **Build the project:**
```bash
npm run build
```

4. **Test the connection:**
```bash
npm test
```

## ⚙️ Configuration

### Environment Variables

Create a `.env` file with the following variables:

```env
BITRIX24_WEBHOOK_URL=https://your-domain.bitrix24.com/rest/USER_ID/WEBHOOK_CODE/
NODE_ENV=development
LOG_LEVEL=info
```

### Bitrix24 Webhook Setup

1. Go to your Bitrix24 instance
2. Navigate to **Applications** → **Webhooks**
3. Create an **Incoming webhook**
4. Copy the webhook URL (format: `https://domain.bitrix24.com/rest/USER_ID/WEBHOOK_CODE/`)
5. Set appropriate permissions for CRM and Tasks

## 🔧 MCP Client Integration

Build the stdio MCP server first:

```bash
npm run build
```

### LM Studio

LM Studio supports MCP servers through `mcp.json` using the same `mcpServers` shape as Cursor. In LM Studio, open **Program** → **Install** → **Edit mcp.json**, then add:

```json
{
  "mcpServers": {
    "bitrix24": {
      "command": "node",
      "args": [
        "/Users/eduardshubin/mcp/bitrix24-mcp-server/build/index.js"
      ],
      "env": {
        "BITRIX24_WEBHOOK_URL": "https://your-domain.bitrix24.com/rest/USER_ID/WEBHOOK_CODE/"
      }
    }
  }
}
```

There is also a ready-to-edit template in `lmstudio_mcp.example.json`.

### Claude Desktop

Add the same server entry to your Claude Desktop configuration file:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "bitrix24": {
      "command": "node",
      "args": ["/path/to/your/bitrix24-mcp-server/build/index.js"],
      "env": {
        "BITRIX24_WEBHOOK_URL": "https://your-domain.bitrix24.com/rest/USER_ID/WEBHOOK_CODE/"
      }
    }
  }
}
```

### Docker

A `Dockerfile` and `docker-compose.yml` are included, wrapping the Streamable HTTP server. It listens on port **`47365`** by default (intentionally non-standard, to avoid clashing with 80/3000/8080 on a shared host).

```bash
cp .env.example .env
# edit .env: set BITRIX24_WEBHOOK_URL and MCP_AUTH_TOKEN

docker compose up -d --build
curl http://localhost:47365/health
```

To publish on a different host port, edit the `ports:` mapping in `docker-compose.yml` (`"HOST_PORT:47365"`) or run plain Docker:

```bash
docker build -t bitrix24-mcp-server .
docker run -d --name bitrix24-mcp --restart unless-stopped \
  --env-file .env \
  -p 51234:47365 \
  bitrix24-mcp-server
```

The container runs as a non-root user and has a built-in healthcheck hitting `/health`.

### Streamable HTTP (self-hosted, remote clients)

For remote access over plain HTTP requests (instead of a local stdio process), the server also exposes the [MCP Streamable HTTP transport](https://modelcontextprotocol.io/) at a single `/mcp` endpoint.

**Run it:**

```bash
npm run build
MCP_AUTH_TOKEN=your-long-random-secret npm run start:http
```

Environment variables (see `.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port to listen on |
| `HOST` | `0.0.0.0` | Interface to bind |
| `MCP_AUTH_TOKEN` | _(unset)_ | Bearer token required on every `/mcp` request. **Set this before exposing the server on the internet** — without it, anyone who can reach the port can call your Bitrix24 tools. |
| `MCP_ALLOWED_ORIGINS` | `*` | Comma-separated list of allowed CORS origins |

This is the same entry point used in production (`server.js` → `build/httpServer.js`), so it works as-is behind IIS/Azure (`web.config`) or any reverse proxy (nginx, Caddy, etc.) — just proxy `/mcp` and `/health` to the Node process's port.

**Endpoints:**
- `POST /mcp` — send JSON-RPC requests (the client sends an `initialize` request first with no `Mcp-Session-Id` header; the server returns one to reuse on subsequent requests)
- `GET /mcp` — opens the server-to-client SSE stream for an existing session (`Mcp-Session-Id` header required)
- `DELETE /mcp` — terminates a session
- `GET /health` — health check

**Connecting a client:** point any MCP client that supports Streamable HTTP at `https://your-server/mcp/<MCP_AUTH_TOKEN>`. The server also accepts the legacy `Authorization: Bearer <MCP_AUTH_TOKEN>` header on `/mcp`. Example with `mcp-remote` (for clients that only speak stdio, like older Claude Desktop configs):

```json
{
  "mcpServers": {
    "bitrix24": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://your-server/mcp/your-long-random-secret"]
    }
  }
}
```

Quick manual test with `curl`:

```bash
curl -i -X POST https://your-server/mcp/your-long-random-secret \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1.0.0"}}}'
```

## 📖 Usage Examples

### Creating a Contact
```
Create a new contact named John Smith with email john@example.com and phone +39 123 456 789
```

### Creating a Deal with Contact
```
Create a new contact for Maria Rossi with email maria@company.com, then create a deal titled "Website Development Project" for €5000 and link it to this contact
```

### Managing Tasks
```
Create a task titled "Follow up with client" with high priority, deadline tomorrow, and link it to contact ID 123
```

### Listing My Tasks
```json
{
  "tool": "bitrix24_list_my_tasks",
  "arguments": {
    "role": "responsible",
    "includeCompleted": false,
    "includeDeferred": false,
    "limit": 50,
    "orderBy": "DEADLINE",
    "orderDirection": "asc"
  }
}
```

### Finding a User and Listing Their Tasks
```json
{
  "tool": "bitrix24_search_users",
  "arguments": {
    "query": "Ivan",
    "activeOnly": true,
    "limit": 20
  }
}
```

```json
{
  "tool": "bitrix24_list_tasks_by_user",
  "arguments": {
    "userId": "123",
    "role": "responsible",
    "limit": 50
  }
}
```

### Opening a Full Task Card
```json
{
  "tool": "bitrix24_get_task_full",
  "arguments": {
    "taskId": "456",
    "includeChatMessages": true,
    "includeFiles": true,
    "chatLimit": 20
  }
}
```

### Reading Task Chat Messages
```json
{
  "tool": "bitrix24_get_task_messages",
  "arguments": {
    "taskId": "456",
    "limit": 20
  }
}
```

### Searching CRM
```
Search for all contacts and deals related to "example.com"
```

## 🏗️ Development

### Project Structure
```
bitrix24-mcp-server/
├── src/
│   ├── bitrix24/
│   │   └── client.ts          # Bitrix24 API client
│   ├── tools/
│   │   └── index.ts           # MCP tools definitions
│   ├── utils/
│   │   └── logger.ts          # Logging utilities
│   ├── config/
│   │   └── index.ts           # Configuration management
│   └── index.ts               # Main MCP server
├── test/
│   └── integration.test.js    # Integration tests
├── build/                     # Compiled JavaScript
├── package.json
├── tsconfig.json
└── README.md
```

### Development Commands
```bash
# Install dependencies
npm install

# Build the project
npm run build

# Watch mode for development
npm run dev

# Run tests
npm test

# Smoke-test task tools
npm run smoke:task-tools

# Print registered MCP tools and fail if required task tools are missing
npm run debug:tools

# Start the server
npm start
```

The Streamable HTTP server also exposes an authenticated debug endpoint:

```bash
curl http://localhost:47365/debug/tools
```

When `MCP_AUTH_TOKEN` is set, use `/debug/tools?token=<MCP_AUTH_TOKEN>` or `Authorization: Bearer <MCP_AUTH_TOKEN>`.

### Adding New Tools

1. Define the tool in `src/tools/index.ts`:
```typescript
export const newTool: Tool = {
  name: 'bitrix24_new_action',
  description: 'Description of the new action',
  inputSchema: {
    type: 'object',
    properties: {
      // Define parameters
    },
    required: ['requiredParam']
  }
};
```

2. Add the execution handler:
```typescript
case 'bitrix24_new_action':
  // Implementation
  return { success: true, result: 'Action completed' };
```

3. Add to `allTools` array and rebuild.

## 🔒 Security Considerations

- **Webhook Security**: Keep your webhook URL secret and rotate it regularly
- **Environment Variables**: Never commit `.env` files to version control
- **Rate Limiting**: The client includes built-in rate limiting (2 requests/second)
- **Error Handling**: Sensitive information is not exposed in error messages

## 🐛 Troubleshooting

### Common Issues

**"Webhook validation failed"**
- Verify your webhook URL is correct
- Check that the webhook has appropriate permissions
- Ensure your Bitrix24 instance is accessible

**"Cannot find module" errors**
- Run `npm install` to install dependencies
- Ensure you've built the project with `npm run build`

**Rate limiting errors**
- The client automatically handles rate limiting
- If you see persistent rate limit errors, consider reducing request frequency

### Debug Mode
Set `NODE_ENV=development` and `LOG_LEVEL=debug` in your `.env` file for detailed logging.

## 📝 API Reference

### Bitrix24Client Methods

#### Contacts
- `createContact(contact: BitrixContact): Promise<string>`
- `getContact(id: string): Promise<BitrixContact>`
- `updateContact(id: string, contact: Partial<BitrixContact>): Promise<boolean>`
- `listContacts(params?: ListParams): Promise<BitrixContact[]>`

#### Deals
- `createDeal(deal: BitrixDeal): Promise<string>`
- `getDeal(id: string): Promise<BitrixDeal>`
- `updateDeal(id: string, deal: Partial<BitrixDeal>): Promise<boolean>`
- `listDeals(params?: ListParams): Promise<BitrixDeal[]>`

#### Tasks
- `createTask(task: BitrixTask): Promise<string>`
- `getTask(id: string, select?: string[]): Promise<BitrixTask>`
- `updateTask(id: string, task: Partial<BitrixTask>): Promise<boolean>`
- `listTasks(params?: TaskListParams): Promise<BitrixTask[]>`
- `listMyTasks(options?: ListTasksByUserOptions): Promise<{ currentUser: any; tasks: BitrixTask[] }>`
- `listTasksByUser(userId: string, options?: ListTasksByUserOptions): Promise<BitrixTask[]>`
- `getTaskFull(taskId: string, options?: GetTaskFullOptions): Promise<{ task: any; messages: any; files: any[] }>`
- `getTaskMessages(taskId: string, options?: GetTaskMessagesOptions): Promise<any>`
- `getTaskFileInfo(fileId: string): Promise<any>`
- `getTaskCounters(options?: TaskCounterOptions): Promise<any>`

#### Users
- `getCurrentUser(): Promise<any>`
- `searchUsers(options?: SearchUsersOptions): Promise<any[]>`
- `getUser(userId: string): Promise<any>`
- `getAllUsers(): Promise<any[]>`
- `getUsersByIds(userIds: string[]): Promise<any[]>`
- `resolveUserNames(userIds: string[]): Promise<Record<string, string>>`
- `enhanceWithUserNames<T>(items: T[], userIdFields?: string[]): Promise<T[]>`

#### Utilities
- `searchCRM(query: string, entityTypes?: string[]): Promise<any>`
- `validateWebhook(): Promise<boolean>`

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## 📄 License

MIT License - see LICENSE file for details.

## 🆘 Support

For issues and questions:
1. Check the troubleshooting section
2. Review Bitrix24 API documentation
3. Open an issue on GitHub

---

**Built with ❤️ for the AI automation community**
