/**
 * Plain-language descriptions of each catalog node, for people who have never built an AI workflow.
 * `summary` says what the step does for the user; `keywords` widen palette search beyond technical names.
 * The catalog's own `label` and `description` stay authoritative for configuration.
 */
export interface NodeGuide {
  summary: string;
  keywords?: string[];
}

export const NODE_GUIDE: Record<string, NodeGuide> = {
  graphqlNode: { summary: 'Starts the workflow when your app sends a request to its API endpoint.', keywords: ['api', 'endpoint', 'request', 'rest', 'graphql', 'input'] },
  mailhookNode: { summary: 'Starts the workflow when an email arrives at its inbound address.', keywords: ['email', 'inbox', 'smtp', 'mail'] },
  webhookTriggerNode: { summary: 'Starts the workflow when another service posts data to its webhook URL.', keywords: ['webhook', 'incoming', 'event', 'post', 'callback'] },
  chatTriggerNode: { summary: 'Starts the workflow for each message someone sends in your chat window.', keywords: ['chat', 'chatbot', 'conversation', 'widget', 'assistant', 'message'] },
  searchTriggerNode: { summary: 'Starts the workflow for each query typed into your search box.', keywords: ['search', 'widget', 'query', 'find'] },
  askTriggerNode: { summary: 'Starts the workflow for each question asked in your Q&A widget.', keywords: ['ask', 'question', 'faq', 'widget'] },
  cronNode: { summary: 'Starts the workflow automatically on a schedule, such as every morning.', keywords: ['schedule', 'cron', 'timer', 'daily', 'hourly', 'automation', 'recurring'] },
  localFolderNode: { summary: 'Starts the workflow for each new or changed file in a folder on the runtime.', keywords: ['folder', 'files', 'sync', 'watch', 'directory'] },
  sourceTriggerNode: { summary: 'Checks an app or database on a schedule and passes new records to the workflow.', keywords: ['poll', 'schedule', 'source', 'database', 'sync'] },

  graphqlResponseNode: { summary: 'Sends the final result back to whoever called the API.', keywords: ['response', 'return', 'output', 'result', 'json', 'finish'] },
  chatResponseNode: { summary: 'Sends the reply, with optional sources, back to the chat window.', keywords: ['reply', 'answer', 'response', 'chat', 'finish'] },
  searchResponseNode: { summary: 'Shows the search results in your search box.', keywords: ['results', 'response', 'search', 'finish'] },
  askResponseNode: { summary: 'Shows the answer, with sources, in your Q&A widget.', keywords: ['answer', 'response', 'finish'] },

  conditionNode: { summary: 'Chooses which path to follow based on rules you set.', keywords: ['if', 'else', 'branch', 'rule', 'route', 'decision'] },
  codeNode: { summary: 'Runs a small JavaScript snippet to reshape or calculate data.', keywords: ['javascript', 'typescript', 'script', 'transform', 'function'] },
  apiNode: { summary: 'Calls another web service and passes its response along.', keywords: ['http', 'rest', 'fetch', 'request', 'url', 'integration'] },
  variablesNode: { summary: 'Gives values clear names so later steps can reuse them.', keywords: ['set', 'variable', 'map', 'rename'] },
  forLoopNode: { summary: 'Repeats the steps inside it once for each item in a list.', keywords: ['loop', 'each', 'iterate', 'repeat', 'for'] },
  forLoopEndNode: { summary: 'Collects the results from every pass through the loop.' },
  batchNode: { summary: 'Processes many items at once, a few at a time, to save time.', keywords: ['batch', 'parallel', 'bulk', 'each', 'many'] },
  batchEndNode: { summary: 'Collects the results from every batch.' },
  branchNode: { summary: 'Runs several paths at the same time.', keywords: ['parallel', 'fan out', 'split', 'concurrent'] },
  waitNode: { summary: 'Pauses for a set time before continuing.', keywords: ['delay', 'sleep', 'pause', 'wait'] },
  endNode: { summary: 'Stops this path of the workflow.', keywords: ['stop', 'end', 'finish'] },
  flowNode: { summary: 'Runs another deployed workflow and uses its result.', keywords: ['subflow', 'reuse', 'call', 'workflow'] },

  LLMNode: { summary: 'Uses your selected model to write a response from your instructions.', keywords: ['ai', 'model', 'generate', 'write', 'answer', 'llm', 'gpt', 'summarize', 'chat', 'response', 'prompt'] },
  multiModalLLMNode: { summary: 'Uses a vision-capable model to understand images alongside text.', keywords: ['vision', 'image', 'photo', 'picture', 'screenshot', 'multimodal'] },
  InstructorLLMNode: { summary: 'Uses your model to fill in a fixed set of fields, returned as validated JSON.', keywords: ['json', 'structured', 'extract', 'fields', 'schema', 'parse', 'form'] },
  agentClassifierNode: { summary: 'Uses your model to sort each input into one of your categories and route it.', keywords: ['classify', 'categorize', 'route', 'triage', 'label', 'sort', 'sentiment', 'intent'] },
  agentNode: { summary: 'Lets your model plan, delegate to specialist paths and combine their results.', keywords: ['agent', 'supervisor', 'planner', 'delegate', 'multi-agent'] },
  agentLoopEndNode: { summary: 'Collects specialist results for the supervising agent.' },
  RAGNode: { summary: 'Searches your documents for relevant passages, then answers with your model and cites them.', keywords: ['rag', 'knowledge', 'documents', 'pdf', 'retrieve', 'answer', 'cite', 'question', 'docs'] },
  ImageGenNode: { summary: 'Creates an image from a text description with an image model you host.', keywords: ['image', 'picture', 'art', 'draw', 'diffusion'] },
  chunkNode: { summary: 'Splits long text into smaller passages that search can work with.', keywords: ['split', 'chunk', 'passages', 'segment'] },
  vectorizeNode: { summary: 'Turns text into embeddings so it can be searched by meaning.', keywords: ['embed', 'embedding', 'vector'] },
  IndexNode: { summary: 'Saves passages and their embeddings into a knowledge collection.', keywords: ['index', 'store', 'save', 'knowledge', 'ingest', 'upload'] },
  vectorNode: { summary: 'Adds, lists or removes items in a knowledge collection.', keywords: ['vector', 'database', 'manage', 'delete'] },
  searchNode: { summary: 'Finds the passages in your documents that are closest in meaning to a query.', keywords: ['search', 'semantic', 'retrieve', 'knowledge', 'similar', 'documents'] },
  hybridSearchNode: { summary: 'Finds passages by both meaning and exact keywords.', keywords: ['search', 'hybrid', 'keyword', 'retrieve', 'knowledge'] },
  fullTextSearchNode: { summary: 'Finds passages that contain your keywords.', keywords: ['search', 'keyword', 'bm25', 'text'] },
  memoryNode: { summary: 'Remembers useful facts about a person for future conversations.', keywords: ['memory', 'remember', 'personal', 'facts', 'save'] },
  memoryRetrieveNode: { summary: 'Recalls what the workflow remembered about this person.', keywords: ['memory', 'recall', 'history', 'context'] },
  extractFromFileNode: { summary: 'Reads the text out of a PDF, Word, slide, spreadsheet or web file.', keywords: ['pdf', 'docx', 'file', 'read', 'parse', 'document', 'csv', 'excel', 'paper'] },
  scraperNode: { summary: 'Reads a web page and keeps its main text.', keywords: ['scrape', 'web', 'website', 'page', 'url', 'html', 'article'] },
  crawlerNode: { summary: 'Reads every page of a website, following its links.', keywords: ['crawl', 'website', 'site', 'spider'] },
  firecrawlNode: { summary: 'Reads one page, a list of pages, or a whole site.', keywords: ['scrape', 'crawl', 'website', 'map'] },
  webSearchNode: { summary: 'Searches the web through your own SearXNG server.', keywords: ['web search', 'google', 'internet', 'searxng'] },
  rssNode: { summary: 'Reads the latest items from a news feed or blog.', keywords: ['rss', 'atom', 'feed', 'news', 'blog', 'articles'] },
  slackNode: { summary: 'Posts a message to a Slack channel.', keywords: ['slack', 'message', 'notify', 'post', 'chat'] },
  teamsNode: { summary: 'Posts a message to a Microsoft Teams channel.', keywords: ['teams', 'microsoft', 'notify', 'message'] },
  discordNode: { summary: 'Posts a message to a Discord channel.', keywords: ['discord', 'notify', 'message'] },
  telegramNode: { summary: 'Sends a Telegram message from your bot.', keywords: ['telegram', 'message', 'notify', 'bot'] },
  smtpNode: { summary: 'Sends an email through your mail server.', keywords: ['email', 'mail', 'send', 'smtp', 'notify'] },
  notionNode: { summary: 'Creates, updates or searches pages in Notion.', keywords: ['notion', 'notes', 'pages', 'database'] },
  airtableNode: { summary: 'Reads or writes records in an Airtable base.', keywords: ['airtable', 'spreadsheet', 'records', 'table'] },
  githubNode: { summary: 'Creates or reads issues, comments and files on GitHub.', keywords: ['github', 'issues', 'repository', 'code'] },
  twilioNode: { summary: 'Sends an SMS or WhatsApp message through Twilio.', keywords: ['sms', 'text message', 'whatsapp', 'twilio', 'phone'] },
  n8nNode: { summary: 'Runs one of your n8n workflows and uses its reply.', keywords: ['n8n', 'automation', 'workflow'] },
  postgresNode: { summary: 'Runs a query against your PostgreSQL database.', keywords: ['postgres', 'sql', 'database', 'query'] },
  tablesNode: { summary: 'Reads or writes rows in a Jasmine data table.', keywords: ['table', 'rows', 'store', 'database', 'save', 'records'] },
  s3Node: { summary: 'Uploads, downloads or lists files in S3-compatible storage.', keywords: ['s3', 'storage', 'bucket', 'files', 'minio'] },
  mcpNode: { summary: 'Lets your model use the tools of an MCP server.', keywords: ['mcp', 'tools', 'agent', 'protocol'] },
  googleDriveNode: { summary: 'Reads or saves files in Google Drive.', keywords: ['google', 'drive', 'files', 'docs'] },
  googleSheetsNode: { summary: 'Reads or writes cells in Google Sheets.', keywords: ['google', 'sheets', 'spreadsheet', 'rows'] },
  gmailNode: { summary: 'Sends, searches or labels Gmail messages.', keywords: ['gmail', 'email', 'google', 'mail'] },
  webflowNode: { summary: 'Reads sites, pages and CMS items from Webflow.', keywords: ['webflow', 'cms', 'website'] },
  onedriveNode: { summary: 'Reads or saves files in OneDrive.', keywords: ['onedrive', 'microsoft', 'files'] },
  onedriveBusinessNode: { summary: 'Reads or saves files in OneDrive for Business.', keywords: ['onedrive', 'microsoft', 'files'] },
  sharepointNode: { summary: 'Reads or saves files in SharePoint.', keywords: ['sharepoint', 'microsoft', 'files'] },
  sharepointBusinessNode: { summary: 'Reads or saves files in SharePoint.', keywords: ['sharepoint', 'microsoft', 'files'] },
  mysqlNode: { summary: 'Runs a query against your MySQL database.', keywords: ['mysql', 'sql', 'database', 'query'] },
  mssqlNode: { summary: 'Runs a query against your SQL Server database.', keywords: ['sql server', 'mssql', 'database', 'query'] },
  documentHandlingNode: { summary: 'Merges, splits or edits PDF pages and metadata.', keywords: ['pdf', 'merge', 'split', 'pages', 'document'] },
  agenticDocExtractionNode: { summary: 'Reads scanned documents and images with offline OCR, optionally into JSON.', keywords: ['ocr', 'scan', 'image', 'pdf', 'extract', 'invoice', 'receipt'] },
};

/** Which catalog nodes need which workspace resources. Shared by the planner, templates and readiness checks. */
export const NEEDS_CHAT_MODEL = new Set(['LLMNode', 'multiModalLLMNode', 'InstructorLLMNode', 'agentClassifierNode', 'agentNode', 'RAGNode', 'mcpNode']);
export const NEEDS_EMBEDDINGS = new Set(['RAGNode', 'searchNode', 'hybridSearchNode', 'vectorizeNode', 'IndexNode', 'vectorNode', 'memoryNode', 'memoryRetrieveNode']);
export const READS_COLLECTION = new Set(['RAGNode', 'searchNode', 'hybridSearchNode', 'fullTextSearchNode']);
export const WRITES_COLLECTION = new Set(['IndexNode', 'vectorNode']);
export const SCHEDULED_TRIGGERS = new Set(['cronNode', 'localFolderNode', 'sourceTriggerNode']);
export const PUBLIC_WIDGET_TRIGGERS = new Set(['chatTriggerNode', 'searchTriggerNode', 'askTriggerNode']);
