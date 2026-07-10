import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { bitrix24Client, Bitrix24ClientError, BitrixAiEngineCategory, BitrixContact, BitrixDeal, BitrixTask, BitrixLead, BitrixCompany, BitrixDepartment } from '../bitrix24/client.js';
import { checklistTools, executeChecklistToolCall } from './tasks/checklist-tools.js';

type OrgUser = {
  id: string;
  fullName: string;
  email?: string;
  workPosition?: string;
  active?: boolean;
  departmentIds: string[];
};

type OrgDepartmentNode = {
  id: string;
  name: string;
  parentId: string | null;
  headId: string | null;
  head: OrgUser | null;
  users: OrgUser[];
  children: OrgDepartmentNode[];
  raw: BitrixDepartment;
};

function normalizeId(value: unknown): string | null {
  if (value === undefined || value === null || value === '' || value === 0 || value === '0') {
    return null;
  }

  return String(value);
}

function missingArgumentResponse(name: string) {
  return {
    success: false,
    error: `missing ${name}`,
    message: `Required argument "${name}" is missing`
  };
}

function formatToolError(error: unknown) {
  if (error instanceof Bitrix24ClientError) {
    return {
      success: false,
      error: error.code,
      message: error.message,
      method: error.method,
      status: error.status
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  const knownError = [
    'ACCESS_DENIED',
    'NO_AUTH_FOUND',
    'QUERY_LIMIT_EXCEEDED',
    'OPERATION_TIME_LIMIT',
    'MISSING_CHAT_ID'
  ].find((code) => message.includes(code));

  return {
    success: false,
    error: knownError || message,
    message
  };
}

function getFullUserName(user: Record<string, any>): string {
  const fullName = [user.LAST_NAME, user.NAME, user.SECOND_NAME]
    .filter(Boolean)
    .join(' ')
    .trim();

  return fullName || user.EMAIL || `User ${user.ID}`;
}

function normalizeOrgUser(user: Record<string, any>): OrgUser {
  const rawDepartments = Array.isArray(user.UF_DEPARTMENT) ? user.UF_DEPARTMENT : [];

  return {
    id: String(user.ID),
    fullName: getFullUserName(user),
    email: user.EMAIL,
    workPosition: user.WORK_POSITION || user.PERSONAL_PROFESSION || undefined,
    active: user.ACTIVE,
    departmentIds: rawDepartments.map(String)
  };
}

function buildOrgStructure(departments: BitrixDepartment[], users: Record<string, any>[]) {
  const normalizedUsers = users.map(normalizeOrgUser);
  const usersById = new Map(normalizedUsers.map(user => [user.id, user]));
  const usersByDepartment = new Map<string, OrgUser[]>();

  for (const user of normalizedUsers) {
    for (const departmentId of user.departmentIds) {
      const current = usersByDepartment.get(departmentId) || [];
      current.push(user);
      usersByDepartment.set(departmentId, current);
    }
  }

  const nodesById = new Map<string, OrgDepartmentNode>();

  for (const department of departments) {
    const id = normalizeId(department.ID);
    if (!id) continue;

    const headId = normalizeId(department.UF_HEAD);
    nodesById.set(id, {
      id,
      name: department.NAME || `Department ${id}`,
      parentId: normalizeId(department.PARENT),
      headId,
      head: headId ? usersById.get(headId) || null : null,
      users: usersByDepartment.get(id) || [],
      children: [],
      raw: department
    });
  }

  const roots: OrgDepartmentNode[] = [];

  for (const node of nodesById.values()) {
    if (node.parentId && nodesById.has(node.parentId)) {
      nodesById.get(node.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const reportingLines = [];

  for (const node of nodesById.values()) {
    if (!node.head) continue;

    for (const user of node.users) {
      if (user.id === node.head.id) continue;

      reportingLines.push({
        managerId: node.head.id,
        managerName: node.head.fullName,
        subordinateId: user.id,
        subordinateName: user.fullName,
        departmentId: node.id,
        departmentName: node.name,
        relation: 'department_head'
      });
    }

    for (const child of node.children) {
      if (!child.head || child.head.id === node.head.id) continue;

      reportingLines.push({
        managerId: node.head.id,
        managerName: node.head.fullName,
        subordinateId: child.head.id,
        subordinateName: child.head.fullName,
        departmentId: child.id,
        departmentName: child.name,
        relation: 'parent_department_head'
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      departments: nodesById.size,
      users: normalizedUsers.length,
      usersWithoutDepartment: normalizedUsers.filter(user => user.departmentIds.length === 0).length,
      reportingLines: reportingLines.length
    },
    departments: Array.from(nodesById.values()),
    roots,
    reportingLines
  };
}

const ASSISTANT_DEFAULTS = {
  currentUser: 'resolve via bitrix24_get_current_user',
  defaultTaskRole: 'responsible',
  defaultTaskOrderBy: 'DEADLINE',
  defaultTaskOrderDirection: 'ASC',
  includeCompletedByDefault: false,
  includeDeferredByDefault: false,
  maxDefaultLimit: 20,
  avoidGetAllUsers: true
};

const TASK_STATUS_LABELS: Record<string, string> = {
  '1': 'new',
  '2': 'pending',
  '3': 'in progress',
  '4': 'completed',
  '5': 'deferred',
  '6': 'deferred'
};

function getTaskValue(task: Record<string, any>, ...keys: string[]): any {
  for (const key of keys) {
    if (task[key] !== undefined && task[key] !== null) {
      return task[key];
    }
  }

  return undefined;
}

function stripHtml(value: unknown): string {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getTaskId(task: Record<string, any>): string | undefined {
  const id = getTaskValue(task, 'ID', 'id');
  return id === undefined ? undefined : String(id);
}

function getTaskStatus(task: Record<string, any>): string | undefined {
  const status = getTaskValue(task, 'REAL_STATUS', 'realStatus', 'real_status', 'STATUS', 'status');
  return status === undefined ? undefined : String(status);
}

function getTaskDeadline(task: Record<string, any>): string | undefined {
  const deadline = getTaskValue(task, 'DEADLINE', 'deadline');
  return deadline === undefined || deadline === null || deadline === '' ? undefined : String(deadline);
}

function summarizeTask(task: Record<string, any>) {
  const status = getTaskStatus(task);
  const description = stripHtml(getTaskValue(task, 'DESCRIPTION', 'description'));
  const parsedDescription = stripHtml(getTaskValue(task, 'parsedDescription', 'PARSED_DESCRIPTION'));

  return {
    id: getTaskId(task),
    title: getTaskValue(task, 'TITLE', 'title') || '',
    deadline: getTaskDeadline(task) || null,
    status,
    statusLabel: status ? TASK_STATUS_LABELS[status] || status : null,
    priority: getTaskValue(task, 'PRIORITY', 'priority') || null,
    group: getTaskValue(task, 'GROUP_NAME', 'groupName', 'group_name', 'GROUP_ID', 'groupId') || null,
    responsibleId: getTaskValue(task, 'RESPONSIBLE_ID', 'responsibleId', 'responsible_id') || null,
    shortDescription: (parsedDescription || description).slice(0, 240)
  };
}

function buildTaskUpdatePayload(args: Record<string, any>): Partial<BitrixTask> {
  const updateTask: Partial<BitrixTask> = {};

  if (args.title !== undefined) updateTask.TITLE = args.title;
  if (args.description !== undefined) updateTask.DESCRIPTION = args.description;
  if (args.responsibleId !== undefined) updateTask.RESPONSIBLE_ID = args.responsibleId;
  if (args.deadline !== undefined) updateTask.DEADLINE = args.deadline;
  if (args.priority !== undefined) updateTask.PRIORITY = args.priority;
  if (args.status !== undefined) updateTask.STATUS = args.status;
  if (args.crmLinks !== undefined) updateTask.UF_CRM_TASK = args.crmLinks;

  return updateTask;
}

function diffTaskFields(before: Record<string, any>, update: Partial<BitrixTask>) {
  const fieldMap: Record<string, string[]> = {
    TITLE: ['TITLE', 'title'],
    DESCRIPTION: ['DESCRIPTION', 'description'],
    RESPONSIBLE_ID: ['RESPONSIBLE_ID', 'responsibleId', 'responsible_id'],
    DEADLINE: ['DEADLINE', 'deadline'],
    PRIORITY: ['PRIORITY', 'priority'],
    STATUS: ['STATUS', 'status'],
    UF_CRM_TASK: ['UF_CRM_TASK', 'ufCrmTask', 'uf_crm_task']
  };

  return Object.fromEntries(
    Object.entries(update).map(([field, after]) => [
      field,
      {
        before: getTaskValue(before, ...(fieldMap[field] || [field])),
        after
      }
    ])
  );
}

function buildAssistantGuide() {
  return {
    purpose: 'Bitrix24 assistant guide for ChatGPT',
    defaults: ASSISTANT_DEFAULTS,
    workflows: {
      myTasks: {
        triggers: ['мои задачи', 'задачи на мне', 'что на мне висит'],
        tool: 'bitrix24_list_my_tasks',
        args: { role: 'responsible', includeCompleted: false, includeDeferred: false }
      },
      createTaskForMe: {
        triggers: ['создай задачу на меня', 'закинь мне задачу'],
        tool: 'bitrix24_create_task_for_current_user'
      },
      openTask: {
        triggers: ['открой задачу 123'],
        tool: 'bitrix24_get_task_full',
        args: { taskId: '<taskId>' }
      },
      taskChat: {
        triggers: ['чат задачи 123', 'комменты задачи 123'],
        tool: 'bitrix24_get_task_messages',
        args: { taskId: '<taskId>' }
      },
      updateTask: {
        rule: 'Use bitrix24_update_task_safe, or bitrix24_update_task only after explicit user instruction.'
      },
      userLookup: {
        preferred: 'bitrix24_search_users',
        avoid: 'bitrix24_get_all_users unless user explicitly asks for broad user export'
      }
    },
    safetyRules: [
      'Never create/update/delete tasks unless the user explicitly asks.',
      'For destructive or status-changing actions, return a preview/dryRun unless user clearly says "сделай", "обнови", "закрой", "создай".',
      'Do not expose unnecessary user emails or avatars in summaries.',
      'Summaries should show task ID, title, deadline, status, group, short description.'
    ],
    preferredTools: {
      currentUser: 'bitrix24_get_current_user',
      myTasks: 'bitrix24_list_my_tasks',
      createTaskForCurrentUser: 'bitrix24_create_task_for_current_user',
      safeTaskUpdate: 'bitrix24_update_task_safe',
      taskDetails: 'bitrix24_get_task_full',
      taskComments: 'bitrix24_get_task_messages',
      userLookup: 'bitrix24_search_users'
    },
    examples: [
      {
        user: 'Покажи мои задачи',
        call: { tool: 'bitrix24_list_my_tasks', args: { role: 'responsible', includeCompleted: false, includeDeferred: false, limit: 20 } }
      },
      {
        user: 'Создай задачу на меня: проверить договор',
        call: { tool: 'bitrix24_create_task_for_current_user', args: { title: 'Проверить договор' } }
      },
      {
        user: 'Что изменится, если закрыть задачу 123?',
        call: { tool: 'bitrix24_complete_task', args: { taskId: '123', dryRun: true } }
      }
    ]
  };
}

// Contact Management Tools
export const createContactTool: Tool = {
  name: 'bitrix24_create_contact',
  description: 'Create a new contact in Bitrix24 CRM',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'First name' },
      lastName: { type: 'string', description: 'Last name' },
      phone: { type: 'string', description: 'Phone number' },
      email: { type: 'string', description: 'Email address' },
      company: { type: 'string', description: 'Company name' },
      position: { type: 'string', description: 'Job position' },
      comments: { type: 'string', description: 'Additional comments' }
    },
    required: ['name', 'lastName']
  }
};

export const getContactTool: Tool = {
  name: 'bitrix24_get_contact',
  description: 'Retrieve contact information by ID',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Contact ID' }
    },
    required: ['id']
  }
};

export const listContactsTool: Tool = {
  name: 'bitrix24_list_contacts',
  description: 'List contacts with optional filtering',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Maximum number of contacts to return', default: 20 },
      filter: { type: 'object', description: 'Filter criteria (e.g., {"NAME": "John"})' }
    }
  }
};

export const getLatestContactsTool: Tool = {
  name: 'bitrix24_get_latest_contacts',
  description: 'Get the most recent contacts ordered by creation date',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Maximum number of contacts to return', default: 20 }
    }
  }
};

export const updateContactTool: Tool = {
  name: 'bitrix24_update_contact',
  description: 'Update an existing contact in Bitrix24 CRM',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Contact ID' },
      name: { type: 'string', description: 'First name' },
      lastName: { type: 'string', description: 'Last name' },
      phone: { type: 'string', description: 'Phone number' },
      email: { type: 'string', description: 'Email address' },
      company: { type: 'string', description: 'Company name' },
      position: { type: 'string', description: 'Job position' },
      comments: { type: 'string', description: 'Additional comments' }
    },
    required: ['id']
  }
};

// Deal Management Tools
export const createDealTool: Tool = {
  name: 'bitrix24_create_deal',
  description: 'Create a new deal in Bitrix24 CRM',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Deal title' },
      amount: { type: 'string', description: 'Deal amount' },
      currency: { type: 'string', description: 'Currency code (e.g., EUR, USD)', default: 'EUR' },
      contactId: { type: 'string', description: 'Associated contact ID' },
      stageId: { type: 'string', description: 'Deal stage ID' },
      comments: { type: 'string', description: 'Deal comments' }
    },
    required: ['title']
  }
};

export const getDealTool: Tool = {
  name: 'bitrix24_get_deal',
  description: 'Retrieve deal information by ID',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Deal ID' }
    },
    required: ['id']
  }
};

export const listDealsTool: Tool = {
  name: 'bitrix24_list_deals',
  description: 'List deals with optional filtering and ordering',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Maximum number of deals to return', default: 20 },
      filter: { type: 'object', description: 'Filter criteria (e.g., {"TITLE": "Project"})' },
      orderBy: { 
        type: 'string', 
        enum: ['DATE_CREATE', 'DATE_MODIFY', 'ID', 'TITLE'],
        description: 'Field to order by',
        default: 'DATE_CREATE'
      },
      orderDirection: {
        type: 'string',
        enum: ['ASC', 'DESC'],
        description: 'Order direction',
        default: 'DESC'
      }
    }
  }
};

export const updateDealTool: Tool = {
  name: 'bitrix24_update_deal',
  description: 'Update an existing deal in Bitrix24 CRM',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Deal ID' },
      title: { type: 'string', description: 'Deal title' },
      amount: { type: 'string', description: 'Deal amount' },
      currency: { type: 'string', description: 'Currency code (e.g., EUR, USD)' },
      contactId: { type: 'string', description: 'Associated contact ID' },
      stageId: { type: 'string', description: 'Deal stage ID' },
      comments: { type: 'string', description: 'Deal comments' }
    },
    required: ['id']
  }
};

export const getLatestDealsTool: Tool = {
  name: 'bitrix24_get_latest_deals',
  description: 'Get the most recent deals ordered by creation date',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Maximum number of deals to return', default: 20 }
    }
  }
};

export const getDealsFromDateRangeTool: Tool = {
  name: 'bitrix24_get_deals_from_date_range',
  description: 'Get deals created within a specific date range',
  inputSchema: {
    type: 'object',
    properties: {
      startDate: { type: 'string', description: 'Start date in YYYY-MM-DD format' },
      endDate: { type: 'string', description: 'End date in YYYY-MM-DD format (optional)' },
      limit: { type: 'number', description: 'Maximum number of deals to return', default: 50 }
    },
    required: ['startDate']
  }
};

// Lead Management Tools
export const createLeadTool: Tool = {
  name: 'bitrix24_create_lead',
  description: 'Create a new lead in Bitrix24 CRM',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Lead title' },
      name: { type: 'string', description: 'First name' },
      lastName: { type: 'string', description: 'Last name' },
      company: { type: 'string', description: 'Company name' },
      phone: { type: 'string', description: 'Phone number' },
      email: { type: 'string', description: 'Email address' },
      sourceId: { type: 'string', description: 'Lead source ID (e.g., CALL, EMAIL, WEB)' },
      statusId: { type: 'string', description: 'Lead status ID' },
      opportunity: { type: 'string', description: 'Expected deal amount' },
      currency: { type: 'string', description: 'Currency code (e.g., EUR, USD)', default: 'EUR' },
      comments: { type: 'string', description: 'Additional comments' }
    },
    required: ['title']
  }
};

export const getLeadTool: Tool = {
  name: 'bitrix24_get_lead',
  description: 'Retrieve lead information by ID',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Lead ID' }
    },
    required: ['id']
  }
};

export const listLeadsTool: Tool = {
  name: 'bitrix24_list_leads',
  description: 'List leads with optional filtering and ordering',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Maximum number of leads to return', default: 20 },
      filter: { type: 'object', description: 'Filter criteria (e.g., {"STATUS_ID": "NEW"})' },
      orderBy: { 
        type: 'string', 
        enum: ['DATE_CREATE', 'DATE_MODIFY', 'ID', 'TITLE'],
        description: 'Field to order by',
        default: 'DATE_CREATE'
      },
      orderDirection: {
        type: 'string',
        enum: ['ASC', 'DESC'],
        description: 'Order direction',
        default: 'DESC'
      }
    }
  }
};

export const getLatestLeadsTool: Tool = {
  name: 'bitrix24_get_latest_leads',
  description: 'Get the most recent leads ordered by creation date',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Maximum number of leads to return', default: 20 }
    }
  }
};

export const getLeadsFromDateRangeTool: Tool = {
  name: 'bitrix24_get_leads_from_date_range',
  description: 'Get leads created within a specific date range',
  inputSchema: {
    type: 'object',
    properties: {
      startDate: { type: 'string', description: 'Start date in YYYY-MM-DD format' },
      endDate: { type: 'string', description: 'End date in YYYY-MM-DD format (optional)' },
      limit: { type: 'number', description: 'Maximum number of leads to return', default: 50 }
    },
    required: ['startDate']
  }
};

export const updateLeadTool: Tool = {
  name: 'bitrix24_update_lead',
  description: 'Update an existing lead in Bitrix24 CRM',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Lead ID' },
      title: { type: 'string', description: 'Lead title' },
      name: { type: 'string', description: 'First name' },
      lastName: { type: 'string', description: 'Last name' },
      company: { type: 'string', description: 'Company name' },
      phone: { type: 'string', description: 'Phone number' },
      email: { type: 'string', description: 'Email address' },
      sourceId: { type: 'string', description: 'Lead source ID' },
      statusId: { type: 'string', description: 'Lead status ID' },
      opportunity: { type: 'string', description: 'Expected deal amount' },
      currency: { type: 'string', description: 'Currency code' },
      comments: { type: 'string', description: 'Additional comments' }
    },
    required: ['id']
  }
};

// Company Management Tools
export const createCompanyTool: Tool = {
  name: 'bitrix24_create_company',
  description: 'Create a new company in Bitrix24 CRM',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Company name' },
      companyType: { type: 'string', description: 'Company type (e.g., CLIENT, SUPPLIER, PARTNER)' },
      industry: { type: 'string', description: 'Industry sector' },
      phone: { type: 'string', description: 'Company phone number' },
      email: { type: 'string', description: 'Company email address' },
      website: { type: 'string', description: 'Company website URL' },
      address: { type: 'string', description: 'Company address' },
      employees: { type: 'string', description: 'Number of employees' },
      revenue: { type: 'string', description: 'Annual revenue' },
      comments: { type: 'string', description: 'Additional comments' },
      assignedById: { type: 'string', description: 'Assigned user ID' }
    },
    required: ['title']
  }
};

export const getCompanyTool: Tool = {
  name: 'bitrix24_get_company',
  description: 'Retrieve company information by ID',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Company ID' }
    },
    required: ['id']
  }
};

export const listCompaniesTool: Tool = {
  name: 'bitrix24_list_companies',
  description: 'List companies with optional filtering and ordering',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Maximum number of companies to return', default: 20 },
      filter: { type: 'object', description: 'Filter criteria (e.g., {"TITLE": "Tech Corp"})' },
      orderBy: { 
        type: 'string', 
        enum: ['DATE_CREATE', 'DATE_MODIFY', 'ID', 'TITLE'],
        description: 'Field to order by',
        default: 'DATE_CREATE'
      },
      orderDirection: {
        type: 'string',
        enum: ['ASC', 'DESC'],
        description: 'Order direction',
        default: 'DESC'
      }
    }
  }
};

export const updateCompanyTool: Tool = {
  name: 'bitrix24_update_company',
  description: 'Update an existing company in Bitrix24 CRM',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Company ID' },
      title: { type: 'string', description: 'Company name' },
      companyType: { type: 'string', description: 'Company type' },
      industry: { type: 'string', description: 'Industry sector' },
      phone: { type: 'string', description: 'Company phone number' },
      email: { type: 'string', description: 'Company email address' },
      website: { type: 'string', description: 'Company website URL' },
      address: { type: 'string', description: 'Company address' },
      employees: { type: 'string', description: 'Number of employees' },
      revenue: { type: 'string', description: 'Annual revenue' },
      comments: { type: 'string', description: 'Additional comments' },
      assignedById: { type: 'string', description: 'Assigned user ID' }
    },
    required: ['id']
  }
};

export const getLatestCompaniesTool: Tool = {
  name: 'bitrix24_get_latest_companies',
  description: 'Get the most recent companies ordered by creation date',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Maximum number of companies to return', default: 20 }
    }
  }
};

export const getCompaniesFromDateRangeTool: Tool = {
  name: 'bitrix24_get_companies_from_date_range',
  description: 'Get companies created within a specific date range',
  inputSchema: {
    type: 'object',
    properties: {
      startDate: { type: 'string', description: 'Start date in YYYY-MM-DD format' },
      endDate: { type: 'string', description: 'End date in YYYY-MM-DD format (optional)' },
      limit: { type: 'number', description: 'Maximum number of companies to return', default: 50 }
    },
    required: ['startDate']
  }
};

// Task Management Tools
export const createTaskTool: Tool = {
  name: 'bitrix24_create_task',
  description: 'Create a new Bitrix24 task when the assignee is known. If the user says "создай задачу на меня", prefer bitrix24_create_task_for_current_user so responsibleId is resolved safely from user.current. Defaults priority to 1; status supports 1=new, 2=pending, 3=in progress, 4=completed, 5=deferred.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Task title' },
      description: { type: 'string', description: 'Task description' },
      responsibleId: { type: 'string', description: 'User ID responsible for the task' },
      deadline: { type: 'string', description: 'Task deadline in ISO 8601 or Bitrix-compatible date format' },
      priority: {
        type: 'string',
        enum: ['0', '1', '2'],
        description: 'Task priority: 0=low, 1=normal, 2=high',
        default: '1'
      },
      status: {
        type: 'string',
        enum: ['1', '2', '3', '4', '5'],
        description: 'Task status: 1=new, 2=pending, 3=in progress, 4=completed, 5=deferred'
      },
      crmLinks: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional CRM links for UF_CRM_TASK, for example ["D_123"], ["C_123"], ["CO_123"], or ["L_123"]'
      }
    },
    required: ['title', 'responsibleId']
  }
};

export const getTaskTool: Tool = {
  name: 'bitrix24_get_task',
  description: 'Retrieve task information by ID',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Task ID' }
    },
    required: ['id']
  }
};

export const listTasksTool: Tool = {
  name: 'bitrix24_list_tasks',
  description: 'List tasks with optional filtering and ordering',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Maximum number of tasks to return', default: 20 },
      filter: { type: 'object', description: 'Bitrix task filter criteria, for example {"RESPONSIBLE_ID":"1"}' },
      orderBy: {
        type: 'string',
        enum: ['ID', 'TITLE', 'CREATED_DATE', 'DEADLINE', 'STATUS', 'PRIORITY'],
        description: 'Field to order by',
        default: 'CREATED_DATE'
      },
      orderDirection: {
        type: 'string',
        enum: ['ASC', 'DESC'],
        description: 'Order direction',
        default: 'DESC'
      }
    }
  }
};

export const updateTaskTool: Tool = {
  name: 'bitrix24_update_task',
  description: 'Update an existing task directly after explicit user instruction. For previews, ambiguous requests, or safer edits, prefer bitrix24_update_task_safe with dryRun=true first. Status values: 1=new, 2=pending, 3=in progress, 4=completed, 5=deferred.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Task ID' },
      title: { type: 'string', description: 'Task title' },
      description: { type: 'string', description: 'Task description' },
      responsibleId: { type: 'string', description: 'User ID responsible for the task' },
      deadline: { type: 'string', description: 'Task deadline in ISO 8601 or Bitrix-compatible date format' },
      priority: {
        type: 'string',
        enum: ['0', '1', '2'],
        description: 'Task priority: 0=low, 1=normal, 2=high'
      },
      status: {
        type: 'string',
        enum: ['1', '2', '3', '4', '5'],
        description: 'Task status: 1=new, 2=pending, 3=in progress, 4=completed, 5=deferred'
      },
      crmLinks: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional CRM links for UF_CRM_TASK, for example ["D_123"], ["C_123"], ["CO_123"], or ["L_123"]'
      }
    },
    required: ['id']
  }
};

export const getCurrentUserTool: Tool = {
  name: 'bitrix24_get_current_user',
  description: 'Resolve the current Bitrix24 user via user.current. Use this instead of broad user export when interpreting "я", "мои задачи", or creating a task for the current user.',
  inputSchema: {
    type: 'object',
    properties: {}
  }
};

export const searchUsersTool: Tool = {
  name: 'bitrix24_search_users',
  description: 'Search Bitrix24 users by query, email, or name',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Name, surname, or free-text search query' },
      email: { type: 'string', description: 'Email address to search first via user.get' },
      activeOnly: { type: 'boolean', description: 'Return only active users', default: true },
      limit: { type: 'number', description: 'Maximum users to return, capped at 200', default: 20 },
      start: { type: 'number', description: 'Bitrix24 pagination start cursor', default: 0 }
    }
  }
};

export const listMyTasksTool: Tool = {
  name: 'bitrix24_list_my_tasks',
  description: 'List current user tasks. Preferred for "мои задачи", "задачи на мне", "что на мне висит"; default role should be responsible, includeCompleted=false, includeDeferred=false, order by DEADLINE ASC. Do not use bitrix24_get_all_users for this.',
  inputSchema: {
    type: 'object',
    properties: {
      includeCompleted: { type: 'boolean', description: 'Include completed tasks with REAL_STATUS=5', default: false },
      includeDeferred: { type: 'boolean', description: 'Include deferred tasks with REAL_STATUS=6', default: false },
      role: {
        type: 'string',
        enum: ['responsible', 'accomplice', 'auditor', 'originator'],
        description: 'Task role filter for the current user',
        default: 'responsible'
      },
      limit: { type: 'number', description: 'Maximum tasks to return, capped at 200', default: 50 },
      start: { type: 'number', description: 'Bitrix24 pagination start cursor', default: 0 },
      orderBy: {
        type: 'string',
        enum: ['ID', 'CREATED_DATE', 'CHANGED_DATE', 'ACTIVITY_DATE', 'DEADLINE', 'PRIORITY'],
        description: 'Task order field',
        default: 'DEADLINE'
      },
      orderDirection: {
        type: 'string',
        enum: ['ASC', 'DESC'],
        description: 'Task order direction',
        default: 'ASC'
      }
    }
  }
};

export const listTasksByUserTool: Tool = {
  name: 'bitrix24_list_tasks_by_user',
  description: 'List tasks for a specified Bitrix24 user by role',
  inputSchema: {
    type: 'object',
    properties: {
      userId: { type: 'string', description: 'Bitrix24 user ID' },
      role: {
        type: 'string',
        enum: ['responsible', 'accomplice', 'auditor', 'originator'],
        description: 'Task role filter',
        default: 'responsible'
      },
      includeCompleted: { type: 'boolean', description: 'Include completed tasks with REAL_STATUS=5', default: false },
      includeDeferred: { type: 'boolean', description: 'Include deferred tasks with REAL_STATUS=6', default: false },
      limit: { type: 'number', description: 'Maximum tasks to return, capped at 200', default: 50 },
      start: { type: 'number', description: 'Bitrix24 pagination start cursor', default: 0 },
      orderBy: {
        type: 'string',
        enum: ['ID', 'CREATED_DATE', 'CHANGED_DATE', 'ACTIVITY_DATE', 'DEADLINE', 'PRIORITY'],
        description: 'Task order field',
        default: 'DEADLINE'
      },
      orderDirection: {
        type: 'string',
        enum: ['ASC', 'DESC'],
        description: 'Task order direction',
        default: 'ASC'
      }
    },
    required: ['userId']
  }
};

export const getTaskFullTool: Tool = {
  name: 'bitrix24_get_task_full',
  description: 'Open a task by ID with full details, CRM links, attachments, chat ID, optional messages, and optional files. Use when the user says "открой задачу 123" or needs task context before summarizing/updating.',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'Task ID' },
      includeChatMessages: { type: 'boolean', description: 'Include task chat messages via im.dialog.messages.get', default: false },
      includeFiles: { type: 'boolean', description: 'Include disk.file.get details for task attachments', default: false },
      chatLimit: { type: 'number', description: 'Maximum chat messages to return', default: 20 }
    },
    required: ['taskId']
  }
};

export const getTaskMessagesTool: Tool = {
  name: 'bitrix24_get_task_messages',
  description: 'Get messages/comments for task by taskId using task CHAT_ID and im.dialog.messages.get',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'Task ID' },
      limit: { type: 'number', description: 'Maximum messages to return', default: 20 },
      lastId: { type: 'number', description: 'Return messages older than this message ID' },
      firstId: { type: 'number', description: 'Return messages newer than this message ID' }
    },
    required: ['taskId']
  }
};

export const getTaskFileInfoTool: Tool = {
  name: 'bitrix24_get_task_file_info',
  description: 'Get disk file information by file ID from task attachments',
  inputSchema: {
    type: 'object',
    properties: {
      fileId: { type: 'string', description: 'Bitrix24 Disk file ID' }
    },
    required: ['fileId']
  }
};

export const getMyTaskCountersTool: Tool = {
  name: 'bitrix24_get_my_task_counters',
  description: 'Get task counters for current Bitrix24 user',
  inputSchema: {
    type: 'object',
    properties: {
      role: {
        type: 'string',
        enum: ['view_all', 'view_role_responsible', 'view_role_accomplice', 'view_role_auditor', 'view_role_originator'],
        description: 'Counter type',
        default: 'view_all'
      },
      groupId: { type: 'number', description: 'Bitrix24 group ID, 0 for all groups', default: 0 }
    }
  }
};

export const getAssistantGuideTool: Tool = {
  name: 'bitrix24_get_assistant_guide',
  description: 'Return compact operational guide for ChatGPT on how to use this Bitrix24 MCP server.',
  inputSchema: {
    type: 'object',
    properties: {}
  }
};

export const createTaskForCurrentUserTool: Tool = {
  name: 'bitrix24_create_task_for_current_user',
  description: 'Create a task assigned to the current Bitrix24 user. Preferred when user says "создай задачу на меня" or "закинь мне задачу"; resolves responsibleId via user.current and supports dryRun preview.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Task title' },
      description: { type: 'string', description: 'Task description' },
      deadline: { type: 'string', description: 'Task deadline in ISO 8601 or Bitrix-compatible date format' },
      priority: {
        type: 'string',
        enum: ['0', '1', '2'],
        description: 'Task priority: 0=low, 1=normal, 2=high',
        default: '1'
      },
      status: {
        type: 'string',
        enum: ['1', '2', '3', '4', '5'],
        description: 'Task status: 1=new, 2=pending, 3=in progress, 4=completed, 5=deferred',
        default: '2'
      },
      crmLinks: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional CRM links for UF_CRM_TASK, for example ["D_123"], ["C_123"], ["CO_123"], or ["L_123"]'
      },
      dryRun: { type: 'boolean', description: 'Return planned payload without creating the task', default: false }
    },
    required: ['title']
  }
};

export const updateTaskSafeTool: Tool = {
  name: 'bitrix24_update_task_safe',
  description: 'Safely update a Bitrix24 task with optional dryRun preview. Use for edits unless the user explicitly requested direct bitrix24_update_task.',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'Task ID' },
      title: { type: 'string', description: 'Task title' },
      description: { type: 'string', description: 'Task description' },
      responsibleId: { type: 'string', description: 'User ID responsible for the task' },
      deadline: { type: 'string', description: 'Task deadline in ISO 8601 or Bitrix-compatible date format' },
      priority: {
        type: 'string',
        enum: ['0', '1', '2'],
        description: 'Task priority: 0=low, 1=normal, 2=high'
      },
      status: {
        type: 'string',
        enum: ['1', '2', '3', '4', '5'],
        description: 'Task status: 1=new, 2=pending, 3=in progress, 4=completed, 5=deferred'
      },
      crmLinks: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional CRM links for UF_CRM_TASK, for example ["D_123"], ["C_123"], ["CO_123"], or ["L_123"]'
      },
      dryRun: { type: 'boolean', description: 'Return before/after diff without updating the task', default: false }
    },
    required: ['taskId']
  }
};

export const findMyTasksTool: Tool = {
  name: 'bitrix24_find_my_tasks',
  description: 'Search current user tasks by text in title, description, or parsedDescription. Uses bitrix24_list_my_tasks semantics and avoids broad user export.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Text to search in task title and description' },
      includeCompleted: { type: 'boolean', description: 'Include completed tasks', default: false },
      includeDeferred: { type: 'boolean', description: 'Include deferred tasks', default: false },
      role: {
        type: 'string',
        enum: ['responsible', 'accomplice', 'auditor', 'originator'],
        description: 'Task role filter for the current user',
        default: 'responsible'
      },
      limit: { type: 'number', description: 'Maximum matching tasks to return', default: 20 }
    },
    required: ['query']
  }
};

export const getMyWorkSummaryTool: Tool = {
  name: 'bitrix24_get_my_work_summary',
  description: 'Return compact summary of current user active tasks grouped by overdue, due today, due this week, no deadline, and in progress.',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Maximum tasks to fetch and summarize', default: 20 },
      includeOverdue: { type: 'boolean', description: 'Include overdue tasks group', default: true },
      includeUpcoming: { type: 'boolean', description: 'Include due today and due this week groups', default: true },
      includeNoDeadline: { type: 'boolean', description: 'Include tasks without deadline group', default: true }
    }
  }
};

export const completeTaskTool: Tool = {
  name: 'bitrix24_complete_task',
  description: 'Mark a task as completed using the current update wrapper status=4. Supports dryRun preview for status-changing actions.',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'Task ID' },
      dryRun: { type: 'boolean', description: 'Return planned completion update without changing the task', default: false }
    },
    required: ['taskId']
  }
};

export const addTaskCommentTool: Tool = {
  name: 'bitrix24_add_task_comment',
  description: 'Add a comment/message to a task via task.commentitem.add when available. Returns a clear error if the Bitrix portal or webhook does not support comment creation.',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'Task ID' },
      message: { type: 'string', description: 'Comment text to add to the task' },
      dryRun: { type: 'boolean', description: 'Return planned comment without adding it', default: false }
    },
    required: ['taskId', 'message']
  }
};

// AI Engine Tools
export const registerAiEngineTool: Tool = {
  name: 'bitrix24_register_ai_engine',
  description: 'Register a custom AI service in Bitrix24 CoPilot/AI engines',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Service name displayed in the Bitrix24 interface' },
      code: { type: 'string', description: 'Unique service code. Allowed characters: A-Z, a-z, 0-9, hyphen, underscore' },
      category: {
        type: 'string',
        enum: ['text', 'image', 'audio', 'call'],
        description: 'AI service category',
        default: 'text'
      },
      completionsUrl: {
        type: 'string',
        description: 'Public HTTPS endpoint URL that Bitrix24 calls for completions. It must return HTTP 200 during registration verification.'
      },
      settings: {
        type: 'object',
        description: 'Optional service settings, for example {"code_alias":"ChatGPT","model_context_type":"token","model_context_limit":15666}'
      }
    },
    required: ['name', 'code', 'category', 'completionsUrl']
  }
};

export const listAiEnginesTool: Tool = {
  name: 'bitrix24_list_ai_engines',
  description: 'List registered Bitrix24 AI services',
  inputSchema: {
    type: 'object',
    properties: {
      filter: {
        type: 'object',
        description: 'Filter criteria, for example {"=CATEGORY":"text"} or {"=CODE":"acme_gpt"}'
      },
      limit: { type: 'number', description: 'Maximum number of services to return' }
    }
  }
};

export const unregisterAiEngineTool: Tool = {
  name: 'bitrix24_unregister_ai_engine',
  description: 'Remove a registered Bitrix24 AI service by code',
  inputSchema: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'Character code of the service to remove' }
    },
    required: ['code']
  }
};

// Chat / IM Tools
export const getChatIdTool: Tool = {
  name: 'bitrix24_get_chat_id',
  description: 'Get a Bitrix24 chat/dialog identifier by linked entity type and entity ID, for example meeting or calendar event chats',
  inputSchema: {
    type: 'object',
    properties: {
      entityType: {
        type: 'string',
        description: 'Bitrix24 chat entity type, for example CALENDAR, CALL, CRM, LINES, TASKS, SONET_GROUP'
      },
      entityId: {
        type: 'string',
        description: 'Linked entity ID used by Bitrix24 for this chat'
      }
    },
    required: ['entityType', 'entityId']
  }
};

export const getDialogTool: Tool = {
  name: 'bitrix24_get_dialog',
  description: 'Get Bitrix24 dialog/chat metadata by DIALOG_ID, for example chat123',
  inputSchema: {
    type: 'object',
    properties: {
      dialogId: {
        type: 'string',
        description: 'Dialog ID, for example chat123 or a user ID for one-to-one dialogs'
      }
    },
    required: ['dialogId']
  }
};

export const listRecentDialogsTool: Tool = {
  name: 'bitrix24_list_recent_dialogs',
  description: 'List recent Bitrix24 dialogs/chats available to the webhook user',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Maximum dialogs to return', default: 20 },
      offset: { type: 'number', description: 'Offset for pagination', default: 0 },
      lastMessageDate: { type: 'string', description: 'Optional date cursor from Bitrix24 recent list' },
      unreadOnly: { type: 'boolean', description: 'Return only unread dialogs' },
      parseText: { type: 'boolean', description: 'Return parsed message text when supported' },
      getOriginalText: { type: 'boolean', description: 'Return original unparsed text when supported' },
      skipOpenLines: { type: 'boolean', description: 'Skip open line dialogs' },
      skipDialog: { type: 'boolean', description: 'Skip one-to-one dialogs' },
      skipChat: { type: 'boolean', description: 'Skip group chats' },
      onlyCopilot: { type: 'boolean', description: 'Return only CoPilot dialogs when supported' },
      onlyChannel: { type: 'boolean', description: 'Return only channels when supported' }
    }
  }
};

export const getDialogMessagesTool: Tool = {
  name: 'bitrix24_get_dialog_messages',
  description: 'Get messages from a Bitrix24 dialog/chat, useful for reading meeting chat messages and CoPilot/GPT meeting summaries',
  inputSchema: {
    type: 'object',
    properties: {
      dialogId: {
        type: 'string',
        description: 'Dialog ID, for example chat123'
      },
      limit: {
        type: 'number',
        description: 'Maximum messages to return. Bitrix24 limits this method to 50.',
        default: 20
      },
      lastId: {
        type: 'number',
        description: 'Return messages older than this message ID'
      },
      firstId: {
        type: 'number',
        description: 'Return messages newer than this message ID'
      }
    },
    required: ['dialogId']
  }
};

export const searchDialogMessagesTool: Tool = {
  name: 'bitrix24_search_dialog_messages',
  description: 'Search messages in a Bitrix24 chat by text, useful for finding CoPilot/GPT meeting transcriptions or summaries',
  inputSchema: {
    type: 'object',
    properties: {
      chatId: {
        type: ['string', 'number'],
        description: 'Numeric chat ID or dialog ID like chat123'
      },
      searchMessage: {
        type: 'string',
        description: 'Search text, for example "расшифровка", "итоги встречи", "CoPilot", or "GPT"'
      },
      limit: { type: 'number', description: 'Maximum messages to return', default: 50 },
      lastId: { type: 'number', description: 'Continue search from this message ID' },
      dateFrom: { type: 'string', description: 'Start date filter supported by Bitrix24' },
      dateTo: { type: 'string', description: 'End date filter supported by Bitrix24' },
      date: { type: 'string', description: 'Exact date filter supported by Bitrix24' },
      orderDirection: {
        type: 'string',
        enum: ['ASC', 'DESC'],
        description: 'Message ID sort direction',
        default: 'DESC'
      }
    },
    required: ['chatId', 'searchMessage']
  }
};

// Search and Utility Tools
export const searchCRMTool: Tool = {
  name: 'bitrix24_search_crm',
  description: 'Search across CRM entities (contacts, companies, deals, leads)',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query (email, phone, name)' },
      entityTypes: {
        type: 'array',
        items: { type: 'string', enum: ['contact', 'company', 'deal', 'lead'] },
        description: 'Entity types to search',
        default: ['contact', 'company', 'deal', 'lead']
      }
    },
    required: ['query']
  }
};


export const validateWebhookTool: Tool = {
  name: 'bitrix24_validate_webhook',
  description: 'Validate the Bitrix24 webhook connection',
  inputSchema: {
    type: 'object',
    properties: {}
  }
};

// Diagnostic Tools
export const diagnosePermissionsTool: Tool = {
  name: 'bitrix24_diagnose_permissions',
  description: 'Diagnose webhook permissions and access to different CRM entities',
  inputSchema: {
    type: 'object',
    properties: {}
  }
};

export const checkCRMSettingsTool: Tool = {
  name: 'bitrix24_check_crm_settings',
  description: 'Check CRM settings including lead fields, statuses, and mode',
  inputSchema: {
    type: 'object',
    properties: {}
  }
};

export const testLeadsAPITool: Tool = {
  name: 'bitrix24_test_leads_api',
  description: 'Test various leads API endpoints to identify specific issues',
  inputSchema: {
    type: 'object',
    properties: {}
  }
};

// Enhanced Deal Filtering Tools (Phase 1)
export const getDealPipelinesTool: Tool = {
  name: 'bitrix24_get_deal_pipelines',
  description: 'Get all available deal pipelines/categories with their IDs and names',
  inputSchema: {
    type: 'object',
    properties: {}
  }
};

export const getDealStagesTool: Tool = {
  name: 'bitrix24_get_deal_stages',
  description: 'Get all deal stages for a specific pipeline or all pipelines',
  inputSchema: {
    type: 'object',
    properties: {
      pipelineId: { 
        type: 'string', 
        description: 'Pipeline ID to get stages for (optional - if not provided, gets all stages)' 
      }
    }
  }
};

export const filterDealsByPipelineTool: Tool = {
  name: 'bitrix24_filter_deals_by_pipeline',
  description: 'Filter deals by specific pipeline/category ID',
  inputSchema: {
    type: 'object',
    properties: {
      pipelineId: { 
        type: 'string', 
        description: 'Pipeline/Category ID to filter by' 
      },
      limit: { 
        type: 'number', 
        description: 'Maximum number of deals to return', 
        default: 50 
      },
      orderBy: { 
        type: 'string', 
        enum: ['DATE_CREATE', 'DATE_MODIFY', 'ID', 'TITLE', 'OPPORTUNITY'],
        description: 'Field to order by',
        default: 'DATE_CREATE'
      },
      orderDirection: {
        type: 'string',
        enum: ['ASC', 'DESC'],
        description: 'Order direction',
        default: 'DESC'
      }
    },
    required: ['pipelineId']
  }
};

export const filterDealsByBudgetTool: Tool = {
  name: 'bitrix24_filter_deals_by_budget',
  description: 'Filter deals by budget/opportunity amount range',
  inputSchema: {
    type: 'object',
    properties: {
      minBudget: { 
        type: 'number', 
        description: 'Minimum budget amount' 
      },
      maxBudget: { 
        type: 'number', 
        description: 'Maximum budget amount (optional)' 
      },
      currency: { 
        type: 'string', 
        description: 'Currency code (e.g., EUR, USD)', 
        default: 'EUR' 
      },
      limit: { 
        type: 'number', 
        description: 'Maximum number of deals to return', 
        default: 50 
      },
      orderBy: { 
        type: 'string', 
        enum: ['DATE_CREATE', 'DATE_MODIFY', 'ID', 'TITLE', 'OPPORTUNITY'],
        description: 'Field to order by',
        default: 'OPPORTUNITY'
      },
      orderDirection: {
        type: 'string',
        enum: ['ASC', 'DESC'],
        description: 'Order direction',
        default: 'DESC'
      }
    },
    required: ['minBudget']
  }
};

export const filterDealsByStatusTool: Tool = {
  name: 'bitrix24_filter_deals_by_status',
  description: 'Filter deals by stage/status IDs',
  inputSchema: {
    type: 'object',
    properties: {
      stageIds: { 
        type: 'array',
        items: { type: 'string' },
        description: 'Array of stage IDs to filter by' 
      },
      pipelineId: { 
        type: 'string', 
        description: 'Pipeline ID to limit search to (optional)' 
      },
      limit: { 
        type: 'number', 
        description: 'Maximum number of deals to return', 
        default: 50 
      },
      orderBy: { 
        type: 'string', 
        enum: ['DATE_CREATE', 'DATE_MODIFY', 'ID', 'TITLE', 'OPPORTUNITY'],
        description: 'Field to order by',
        default: 'DATE_CREATE'
      },
      orderDirection: {
        type: 'string',
        enum: ['ASC', 'DESC'],
        description: 'Order direction',
        default: 'DESC'
      }
    },
    required: ['stageIds']
  }
};

// Sales Team Monitoring Tools
export const monitorUserActivitiesTool: Tool = {
  name: 'bitrix24_monitor_user_activities',
  description: 'Monitor user activities including calls, emails, timeline interactions, and response times',
  inputSchema: {
    type: 'object',
    properties: {
      userId: { type: 'string', description: 'User ID to monitor (optional - if not provided, monitors all users)' },
      startDate: { type: 'string', description: 'Start date in YYYY-MM-DD format' },
      endDate: { type: 'string', description: 'End date in YYYY-MM-DD format (optional - defaults to today)' },
      includeCallVolume: { type: 'boolean', description: 'Include call volume metrics', default: true },
      includeEmailActivity: { type: 'boolean', description: 'Include email activity metrics', default: true },
      includeTimelineActivity: { type: 'boolean', description: 'Include timeline interactions', default: true },
      includeResponseTimes: { type: 'boolean', description: 'Calculate response times', default: true }
    },
    required: ['startDate']
  }
};

export const getUserPerformanceSummaryTool: Tool = {
  name: 'bitrix24_get_user_performance_summary',
  description: 'Get comprehensive performance summary for users including deal metrics and conversion rates',
  inputSchema: {
    type: 'object',
    properties: {
      userId: { type: 'string', description: 'User ID to analyze (optional - if not provided, analyzes all users)' },
      startDate: { type: 'string', description: 'Start date in YYYY-MM-DD format' },
      endDate: { type: 'string', description: 'End date in YYYY-MM-DD format (optional - defaults to today)' },
      includeDealMetrics: { type: 'boolean', description: 'Include deal creation/conversion metrics', default: true },
      includeActivityRatios: { type: 'boolean', description: 'Include activity type ratios', default: true },
      includeConversionRates: { type: 'boolean', description: 'Calculate conversion rates', default: true }
    },
    required: ['startDate']
  }
};

export const analyzeAccountPerformanceTool: Tool = {
  name: 'bitrix24_analyze_account_performance',
  description: 'Analyze performance and activities for specific accounts (companies/contacts)',
  inputSchema: {
    type: 'object',
    properties: {
      accountId: { type: 'string', description: 'Account ID (company or contact ID)' },
      accountType: { type: 'string', enum: ['company', 'contact'], description: 'Type of account to analyze' },
      startDate: { type: 'string', description: 'Start date in YYYY-MM-DD format' },
      endDate: { type: 'string', description: 'End date in YYYY-MM-DD format (optional - defaults to today)' },
      includeAllInteractions: { type: 'boolean', description: 'Include all user interactions with this account', default: true },
      includeDealProgression: { type: 'boolean', description: 'Include deal progression analysis', default: true },
      includeTimelineHistory: { type: 'boolean', description: 'Include complete timeline history', default: true }
    },
    required: ['accountId', 'accountType', 'startDate']
  }
};

export const compareUserPerformanceTool: Tool = {
  name: 'bitrix24_compare_user_performance',
  description: 'Compare performance metrics between multiple users',
  inputSchema: {
    type: 'object',
    properties: {
      userIds: { type: 'array', items: { type: 'string' }, description: 'Array of user IDs to compare (optional - if not provided, compares all users)' },
      startDate: { type: 'string', description: 'Start date in YYYY-MM-DD format' },
      endDate: { type: 'string', description: 'End date in YYYY-MM-DD format (optional - defaults to today)' },
      metrics: { 
        type: 'array', 
        items: { type: 'string', enum: ['activities', 'deals', 'conversions', 'response_times', 'timeline_engagement'] },
        description: 'Specific metrics to compare',
        default: ['activities', 'deals', 'conversions']
      },
      includeRankings: { type: 'boolean', description: 'Include performance rankings', default: true },
      includeTrends: { type: 'boolean', description: 'Include trend analysis', default: true }
    },
    required: ['startDate']
  }
};

export const trackDealProgressionTool: Tool = {
  name: 'bitrix24_track_deal_progression',
  description: 'Track deal progression through pipeline stages with timing analysis',
  inputSchema: {
    type: 'object',
    properties: {
      dealId: { type: 'string', description: 'Specific deal ID to track (optional - if not provided, tracks all deals)' },
      userId: { type: 'string', description: 'User ID to filter deals (optional)' },
      pipelineId: { type: 'string', description: 'Pipeline ID to filter deals (optional)' },
      startDate: { type: 'string', description: 'Start date in YYYY-MM-DD format' },
      endDate: { type: 'string', description: 'End date in YYYY-MM-DD format (optional - defaults to today)' },
      includeStageDuration: { type: 'boolean', description: 'Calculate time spent in each stage', default: true },
      identifyStalled: { type: 'boolean', description: 'Identify stalled deals', default: true },
      calculateVelocity: { type: 'boolean', description: 'Calculate pipeline velocity', default: true }
    },
    required: ['startDate']
  }
};

export const monitorSalesActivitiesTool: Tool = {
  name: 'bitrix24_monitor_sales_activities',
  description: 'Monitor sales-related activities including tasks, follow-ups, and meetings',
  inputSchema: {
    type: 'object',
    properties: {
      userId: { type: 'string', description: 'User ID to monitor (optional - if not provided, monitors all users)' },
      startDate: { type: 'string', description: 'Start date in YYYY-MM-DD format' },
      endDate: { type: 'string', description: 'End date in YYYY-MM-DD format (optional - defaults to today)' },
      includeTaskCompletion: { type: 'boolean', description: 'Include task completion rates', default: true },
      includeFollowUpTracking: { type: 'boolean', description: 'Include follow-up tracking', default: true },
      includeMeetingTracking: { type: 'boolean', description: 'Include meeting tracking', default: true },
      includeQuoteActivity: { type: 'boolean', description: 'Include quote/proposal activity', default: true }
    },
    required: ['startDate']
  }
};

export const generateSalesReportTool: Tool = {
  name: 'bitrix24_generate_sales_report',
  description: 'Generate comprehensive sales report with customizable metrics and date ranges',
  inputSchema: {
    type: 'object',
    properties: {
      reportType: { 
        type: 'string', 
        enum: ['user_performance', 'account_analysis', 'team_summary', 'pipeline_analysis', 'activity_report'],
        description: 'Type of report to generate'
      },
      startDate: { type: 'string', description: 'Start date in YYYY-MM-DD format' },
      endDate: { type: 'string', description: 'End date in YYYY-MM-DD format (optional - defaults to today)' },
      userIds: { type: 'array', items: { type: 'string' }, description: 'Specific user IDs to include (optional)' },
      includeMetrics: { 
        type: 'array', 
        items: { type: 'string', enum: ['revenue', 'conversion_rates', 'activity_volumes', 'response_times', 'deal_progression'] },
        description: 'Specific metrics to include in report',
        default: ['revenue', 'conversion_rates', 'activity_volumes']
      },
      includeTrendAnalysis: { type: 'boolean', description: 'Include trend analysis', default: true },
      includeComparisons: { type: 'boolean', description: 'Include performance comparisons', default: true }
    },
    required: ['reportType', 'startDate']
  }
};

export const getTeamDashboardTool: Tool = {
  name: 'bitrix24_get_team_dashboard',
  description: 'Get real-time team performance dashboard with key metrics and alerts',
  inputSchema: {
    type: 'object',
    properties: {
      includeRealTimeMetrics: { type: 'boolean', description: 'Include real-time performance metrics', default: true },
      includeTopPerformers: { type: 'boolean', description: 'Include top performers identification', default: true },
      includeAttentionNeeded: { type: 'boolean', description: 'Include accounts/deals needing attention', default: true },
      includeWorkloadDistribution: { type: 'boolean', description: 'Include workload distribution analysis', default: true },
      timeframe: { 
        type: 'string', 
        enum: ['today', 'week', 'month', 'quarter'],
        description: 'Timeframe for dashboard metrics',
        default: 'today'
      }
    }
  }
};

export const analyzeCustomerEngagementTool: Tool = {
  name: 'bitrix24_analyze_customer_engagement',
  description: 'Analyze customer engagement patterns and relationship health',
  inputSchema: {
    type: 'object',
    properties: {
      accountId: { type: 'string', description: 'Account ID (company or contact ID) - optional' },
      accountType: { type: 'string', enum: ['company', 'contact'], description: 'Type of account' },
      userId: { type: 'string', description: 'User ID to filter analysis (optional)' },
      startDate: { type: 'string', description: 'Start date in YYYY-MM-DD format' },
      endDate: { type: 'string', description: 'End date in YYYY-MM-DD format (optional - defaults to today)' },
      includeCommunicationPatterns: { type: 'boolean', description: 'Include communication pattern analysis', default: true },
      includeResponseQuality: { type: 'boolean', description: 'Include response quality metrics', default: true },
      includeEngagementScores: { type: 'boolean', description: 'Calculate engagement scores', default: true },
      includeRelationshipHealth: { type: 'boolean', description: 'Assess relationship health', default: true }
    },
    required: ['startDate']
  }
};

export const forecastPerformanceTool: Tool = {
  name: 'bitrix24_forecast_performance',
  description: 'Generate performance forecasts and predictive analytics',
  inputSchema: {
    type: 'object',
    properties: {
      forecastType: { 
        type: 'string', 
        enum: ['pipeline_forecast', 'user_performance', 'revenue_prediction', 'goal_achievement'],
        description: 'Type of forecast to generate'
      },
      userId: { type: 'string', description: 'User ID to forecast (optional - if not provided, forecasts for all users)' },
      historicalPeriod: { 
        type: 'string', 
        enum: ['3_months', '6_months', '1_year'],
        description: 'Historical period to use for forecasting',
        default: '6_months'
      },
      forecastPeriod: { 
        type: 'string', 
        enum: ['1_month', '3_months', '6_months'],
        description: 'Period to forecast into the future',
        default: '1_month'
      },
      includePipelineAnalysis: { type: 'boolean', description: 'Include pipeline forecasting', default: true },
      includeRiskAssessment: { type: 'boolean', description: 'Include risk assessment', default: true },
      includeGoalTracking: { type: 'boolean', description: 'Include goal achievement tracking', default: true }
    },
    required: ['forecastType']
  }
};

// User Management Tools
export const getUserTool: Tool = {
  name: 'bitrix24_get_user',
  description: 'Get user information by ID',
  inputSchema: {
    type: 'object',
    properties: {
      userId: { type: 'string', description: 'User ID to retrieve' }
    },
    required: ['userId']
  }
};

export const getAllUsersTool: Tool = {
  name: 'bitrix24_get_all_users',
  description: 'Get all users in the system with their names and details',
  inputSchema: {
    type: 'object',
    properties: {
      includeInactive: { type: 'boolean', description: 'Include inactive users', default: false }
    }
  }
};

export const getDepartmentsTool: Tool = {
  name: 'bitrix24_get_departments',
  description: 'Get all Bitrix24 company departments with parent and department head fields',
  inputSchema: {
    type: 'object',
    properties: {}
  }
};

export const exportOrgStructureTool: Tool = {
  name: 'bitrix24_export_org_structure',
  description: 'Export company org structure with department hierarchy, heads, users, and reporting lines',
  inputSchema: {
    type: 'object',
    properties: {
      includeInactiveUsers: {
        type: 'boolean',
        description: 'Include inactive users in the org structure',
        default: false
      }
    }
  }
};

export const resolveUserNamesTool: Tool = {
  name: 'bitrix24_resolve_user_names',
  description: 'Resolve user IDs to user names',
  inputSchema: {
    type: 'object',
    properties: {
      userIds: { 
        type: 'array', 
        items: { type: 'string' },
        description: 'Array of user IDs to resolve to names' 
      }
    },
    required: ['userIds']
  }
};

export const getContactsWithUserNamesTool: Tool = {
  name: 'bitrix24_get_contacts_with_user_names',
  description: 'Get contacts with user names resolved (assigned, created, modified by)',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Maximum number of contacts to return', default: 20 },
      filter: { type: 'object', description: 'Filter criteria' }
    }
  }
};

export const getDealsWithUserNamesTool: Tool = {
  name: 'bitrix24_get_deals_with_user_names',
  description: 'Get deals with user names resolved (assigned, created, modified by)',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Maximum number of deals to return', default: 20 },
      filter: { type: 'object', description: 'Filter criteria' },
      orderBy: { 
        type: 'string', 
        enum: ['DATE_CREATE', 'DATE_MODIFY', 'ID', 'TITLE', 'OPPORTUNITY'],
        description: 'Field to order by',
        default: 'DATE_CREATE'
      },
      orderDirection: {
        type: 'string',
        enum: ['ASC', 'DESC'],
        description: 'Order direction',
        default: 'DESC'
      }
    }
  }
};

export const getLeadsWithUserNamesTool: Tool = {
  name: 'bitrix24_get_leads_with_user_names',
  description: 'Get leads with user names resolved (assigned, created, modified by)',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Maximum number of leads to return', default: 20 },
      filter: { type: 'object', description: 'Filter criteria' },
      orderBy: { 
        type: 'string', 
        enum: ['DATE_CREATE', 'DATE_MODIFY', 'ID', 'TITLE'],
        description: 'Field to order by',
        default: 'DATE_CREATE'
      },
      orderDirection: {
        type: 'string',
        enum: ['ASC', 'DESC'],
        description: 'Order direction',
        default: 'DESC'
      }
    }
  }
};

export const getCompaniesWithUserNamesTool: Tool = {
  name: 'bitrix24_get_companies_with_user_names',
  description: 'Get companies with user names resolved (assigned, created, modified by)',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Maximum number of companies to return', default: 20 },
      filter: { type: 'object', description: 'Filter criteria' },
      orderBy: { 
        type: 'string', 
        enum: ['DATE_CREATE', 'DATE_MODIFY', 'ID', 'TITLE'],
        description: 'Field to order by',
        default: 'DATE_CREATE'
      },
      orderDirection: {
        type: 'string',
        enum: ['ASC', 'DESC'],
        description: 'Order direction',
        default: 'DESC'
      }
    }
  }
};

// Export all tools
export const allTools = [
  createContactTool,
  getContactTool,
  listContactsTool,
  getLatestContactsTool,
  updateContactTool,
  createDealTool,
  getDealTool,
  listDealsTool,
  getLatestDealsTool,
  getDealsFromDateRangeTool,
  updateDealTool,
  createLeadTool,
  getLeadTool,
  listLeadsTool,
  getLatestLeadsTool,
  getLeadsFromDateRangeTool,
  updateLeadTool,
  createCompanyTool,
  getCompanyTool,
  listCompaniesTool,
  updateCompanyTool,
  getLatestCompaniesTool,
  getCompaniesFromDateRangeTool,
  createTaskTool,
  getTaskTool,
  listTasksTool,
  updateTaskTool,
  getCurrentUserTool,
  searchUsersTool,
  listMyTasksTool,
  listTasksByUserTool,
  getTaskFullTool,
  getTaskMessagesTool,
  getTaskFileInfoTool,
  getMyTaskCountersTool,
  getAssistantGuideTool,
  createTaskForCurrentUserTool,
  updateTaskSafeTool,
  findMyTasksTool,
  getMyWorkSummaryTool,
  completeTaskTool,
  addTaskCommentTool,
  // AI Engine Tools
  registerAiEngineTool,
  listAiEnginesTool,
  unregisterAiEngineTool,
  // Chat / IM Tools
  getChatIdTool,
  getDialogTool,
  listRecentDialogsTool,
  getDialogMessagesTool,
  searchDialogMessagesTool,
  searchCRMTool,
  validateWebhookTool,
  diagnosePermissionsTool,
  checkCRMSettingsTool,
  testLeadsAPITool,
  // Phase 1: Enhanced Deal Filtering Tools
  getDealPipelinesTool,
  getDealStagesTool,
  filterDealsByPipelineTool,
  filterDealsByBudgetTool,
  filterDealsByStatusTool,
  // Sales Team Monitoring Tools
  monitorUserActivitiesTool,
  getUserPerformanceSummaryTool,
  analyzeAccountPerformanceTool,
  compareUserPerformanceTool,
  trackDealProgressionTool,
  monitorSalesActivitiesTool,
  generateSalesReportTool,
  getTeamDashboardTool,
  analyzeCustomerEngagementTool,
  forecastPerformanceTool,
  // User Management Tools
  getUserTool,
  getAllUsersTool,
  getDepartmentsTool,
  exportOrgStructureTool,
  resolveUserNamesTool,
  getContactsWithUserNamesTool,
  getDealsWithUserNamesTool,
  getLeadsWithUserNamesTool,
  getCompaniesWithUserNamesTool,
  ...checklistTools
];

// Tool execution handlers
export async function executeToolCall(name: string, args: any): Promise<any> {
  try {
    const checklistResult = await executeChecklistToolCall(name, args, bitrix24Client);
    if (checklistResult !== undefined) {
      return checklistResult;
    }

    switch (name) {
      case 'bitrix24_create_contact':
        const contact: BitrixContact = {
          NAME: args.name,
          LAST_NAME: args.lastName,
          PHONE: args.phone ? [{ VALUE: args.phone, VALUE_TYPE: 'WORK' }] : undefined,
          EMAIL: args.email ? [{ VALUE: args.email, VALUE_TYPE: 'WORK' }] : undefined,
          COMPANY_TITLE: args.company,
          POST: args.position,
          COMMENTS: args.comments
        };
        const contactId = await bitrix24Client.createContact(contact);
        return { success: true, contactId, message: `Contact created with ID: ${contactId}` };

      case 'bitrix24_get_contact':
        const contactData = await bitrix24Client.getContact(args.id);
        return { success: true, contact: contactData };

      case 'bitrix24_list_contacts':
        const contacts = await bitrix24Client.listContacts({
          start: 0,
          filter: args.filter
        });
        return { success: true, contacts: contacts.slice(0, args.limit || 20) };

      case 'bitrix24_get_latest_contacts':
        const latestContacts = await bitrix24Client.getLatestContacts(args.limit || 20);
        return { success: true, contacts: latestContacts };

      case 'bitrix24_update_contact':
        const updateContact: Partial<BitrixContact> = {};
        if (args.name) updateContact.NAME = args.name;
        if (args.lastName) updateContact.LAST_NAME = args.lastName;
        if (args.phone) updateContact.PHONE = [{ VALUE: args.phone, VALUE_TYPE: 'WORK' }];
        if (args.email) updateContact.EMAIL = [{ VALUE: args.email, VALUE_TYPE: 'WORK' }];
        if (args.company) updateContact.COMPANY_TITLE = args.company;
        if (args.position) updateContact.POST = args.position;
        if (args.comments) updateContact.COMMENTS = args.comments;
        
        const contactUpdated = await bitrix24Client.updateContact(args.id, updateContact);
        return { success: true, updated: contactUpdated, message: `Contact ${args.id} updated successfully` };

      case 'bitrix24_create_deal':
        const deal: BitrixDeal = {
          TITLE: args.title,
          OPPORTUNITY: args.amount,
          CURRENCY_ID: args.currency || 'EUR',
          CONTACT_ID: args.contactId,
          STAGE_ID: args.stageId,
          COMMENTS: args.comments
        };
        const dealId = await bitrix24Client.createDeal(deal);
        return { success: true, dealId, message: `Deal created with ID: ${dealId}` };

      case 'bitrix24_get_deal':
        const dealData = await bitrix24Client.getDeal(args.id);
        return { success: true, deal: dealData };

      case 'bitrix24_list_deals':
        const dealOrder: Record<string, string> = {};
        dealOrder[args.orderBy || 'DATE_CREATE'] = args.orderDirection || 'DESC';
        
        const deals = await bitrix24Client.listDeals({
          start: 0,
          filter: args.filter,
          order: dealOrder,
          select: ['*']
        });
        return { success: true, deals: deals.slice(0, args.limit || 20) };

      case 'bitrix24_get_latest_deals':
        const latestDeals = await bitrix24Client.getLatestDeals(args.limit || 20);
        return { success: true, deals: latestDeals };

      case 'bitrix24_get_deals_from_date_range':
        const dateRangeDeals = await bitrix24Client.getDealsFromDateRange(
          args.startDate,
          args.endDate,
          args.limit || 50
        );
        return { success: true, deals: dateRangeDeals };

      case 'bitrix24_update_deal':
        const updateDeal: Partial<BitrixDeal> = {};
        if (args.title) updateDeal.TITLE = args.title;
        if (args.amount) updateDeal.OPPORTUNITY = args.amount;
        if (args.currency) updateDeal.CURRENCY_ID = args.currency;
        if (args.contactId) updateDeal.CONTACT_ID = args.contactId;
        if (args.stageId) updateDeal.STAGE_ID = args.stageId;
        if (args.comments) updateDeal.COMMENTS = args.comments;
        
        const dealUpdated = await bitrix24Client.updateDeal(args.id, updateDeal);
        return { success: true, updated: dealUpdated, message: `Deal ${args.id} updated successfully` };

      case 'bitrix24_create_lead':
        const lead: BitrixLead = {
          TITLE: args.title,
          NAME: args.name,
          LAST_NAME: args.lastName,
          COMPANY_TITLE: args.company,
          PHONE: args.phone ? [{ VALUE: args.phone, VALUE_TYPE: 'WORK' }] : undefined,
          EMAIL: args.email ? [{ VALUE: args.email, VALUE_TYPE: 'WORK' }] : undefined,
          SOURCE_ID: args.sourceId,
          STATUS_ID: args.statusId,
          OPPORTUNITY: args.opportunity,
          CURRENCY_ID: args.currency || 'EUR',
          COMMENTS: args.comments
        };
        const leadId = await bitrix24Client.createLead(lead);
        return { success: true, leadId, message: `Lead created with ID: ${leadId}` };

      case 'bitrix24_get_lead':
        const leadData = await bitrix24Client.getLead(args.id);
        return { success: true, lead: leadData };

      case 'bitrix24_list_leads':
        const leadOrder: Record<string, string> = {};
        leadOrder[args.orderBy || 'DATE_CREATE'] = args.orderDirection || 'DESC';
        
        const leads = await bitrix24Client.listLeads({
          start: 0,
          filter: args.filter,
          order: leadOrder,
          select: ['*']
        });
        return { success: true, leads: leads.slice(0, args.limit || 20) };

      case 'bitrix24_get_latest_leads':
        const latestLeads = await bitrix24Client.getLatestLeads(args.limit || 20);
        return { success: true, leads: latestLeads };

      case 'bitrix24_get_leads_from_date_range':
        const dateRangeLeads = await bitrix24Client.getLeadsFromDateRange(
          args.startDate,
          args.endDate,
          args.limit || 50
        );
        return { success: true, leads: dateRangeLeads };

      case 'bitrix24_update_lead':
        const updateLead: Partial<BitrixLead> = {};
        if (args.title) updateLead.TITLE = args.title;
        if (args.name) updateLead.NAME = args.name;
        if (args.lastName) updateLead.LAST_NAME = args.lastName;
        if (args.company) updateLead.COMPANY_TITLE = args.company;
        if (args.phone) updateLead.PHONE = [{ VALUE: args.phone, VALUE_TYPE: 'WORK' }];
        if (args.email) updateLead.EMAIL = [{ VALUE: args.email, VALUE_TYPE: 'WORK' }];
        if (args.sourceId) updateLead.SOURCE_ID = args.sourceId;
        if (args.statusId) updateLead.STATUS_ID = args.statusId;
        if (args.opportunity) updateLead.OPPORTUNITY = args.opportunity;
        if (args.currency) updateLead.CURRENCY_ID = args.currency;
        if (args.comments) updateLead.COMMENTS = args.comments;
        
        const leadUpdated = await bitrix24Client.updateLead(args.id, updateLead);
        return { success: true, updated: leadUpdated, message: `Lead ${args.id} updated successfully` };

      case 'bitrix24_create_company':
        const company: BitrixCompany = {
          TITLE: args.title,
          COMPANY_TYPE: args.companyType,
          INDUSTRY: args.industry,
          PHONE: args.phone ? [{ VALUE: args.phone, VALUE_TYPE: 'WORK' }] : undefined,
          EMAIL: args.email ? [{ VALUE: args.email, VALUE_TYPE: 'WORK' }] : undefined,
          WEB: args.website ? [{ VALUE: args.website, VALUE_TYPE: 'WORK' }] : undefined,
          ADDRESS: args.address,
          EMPLOYEES: args.employees,
          REVENUE: args.revenue,
          COMMENTS: args.comments,
          ASSIGNED_BY_ID: args.assignedById
        };
        const companyId = await bitrix24Client.createCompany(company);
        return { success: true, companyId, message: `Company created with ID: ${companyId}` };

      case 'bitrix24_get_company':
        const companyData = await bitrix24Client.getCompany(args.id);
        return { success: true, company: companyData };

      case 'bitrix24_list_companies':
        const companyOrder: Record<string, string> = {};
        companyOrder[args.orderBy || 'DATE_CREATE'] = args.orderDirection || 'DESC';
        
        const companies = await bitrix24Client.listCompanies({
          start: 0,
          filter: args.filter,
          order: companyOrder,
          select: ['*']
        });
        return { success: true, companies: companies.slice(0, args.limit || 20) };

      case 'bitrix24_update_company':
        const updateCompany: Partial<BitrixCompany> = {};
        if (args.title) updateCompany.TITLE = args.title;
        if (args.companyType) updateCompany.COMPANY_TYPE = args.companyType;
        if (args.industry) updateCompany.INDUSTRY = args.industry;
        if (args.phone) updateCompany.PHONE = [{ VALUE: args.phone, VALUE_TYPE: 'WORK' }];
        if (args.email) updateCompany.EMAIL = [{ VALUE: args.email, VALUE_TYPE: 'WORK' }];
        if (args.website) updateCompany.WEB = [{ VALUE: args.website, VALUE_TYPE: 'WORK' }];
        if (args.address) updateCompany.ADDRESS = args.address;
        if (args.employees) updateCompany.EMPLOYEES = args.employees;
        if (args.revenue) updateCompany.REVENUE = args.revenue;
        if (args.comments) updateCompany.COMMENTS = args.comments;
        if (args.assignedById) updateCompany.ASSIGNED_BY_ID = args.assignedById;
        
        const companyUpdated = await bitrix24Client.updateCompany(args.id, updateCompany);
        return { success: true, updated: companyUpdated, message: `Company ${args.id} updated successfully` };

      case 'bitrix24_get_latest_companies':
        const latestCompanies = await bitrix24Client.getLatestCompanies(args.limit || 20);
        return { success: true, companies: latestCompanies };

      case 'bitrix24_get_companies_from_date_range':
        const dateRangeCompanies = await bitrix24Client.getCompaniesFromDateRange(
          args.startDate,
          args.endDate,
          args.limit || 50
        );
        return { success: true, companies: dateRangeCompanies };

      case 'bitrix24_create_task':
        const task: BitrixTask = {
          TITLE: args.title,
          DESCRIPTION: args.description,
          RESPONSIBLE_ID: args.responsibleId,
          DEADLINE: args.deadline,
          PRIORITY: args.priority || '1',
          STATUS: args.status,
          UF_CRM_TASK: args.crmLinks
        };
        const taskId = await bitrix24Client.createTask(task);
        return { success: true, taskId, message: `Task created with ID: ${taskId}` };

      case 'bitrix24_get_task':
        const taskData = await bitrix24Client.getTask(args.id);
        return { success: true, task: taskData };

      case 'bitrix24_list_tasks':
        const taskOrder: Record<string, string> = {};
        taskOrder[args.orderBy || 'CREATED_DATE'] = args.orderDirection || 'DESC';

        const tasks = await bitrix24Client.listTasks({
          start: 0,
          filter: args.filter,
          order: taskOrder,
          select: ['*', 'UF_*']
        });
        return { success: true, tasks: tasks.slice(0, args.limit || 20) };

      case 'bitrix24_update_task':
        const updateTask: Partial<BitrixTask> = {};
        if (args.title) updateTask.TITLE = args.title;
        if (args.description) updateTask.DESCRIPTION = args.description;
        if (args.responsibleId) updateTask.RESPONSIBLE_ID = args.responsibleId;
        if (args.deadline) updateTask.DEADLINE = args.deadline;
        if (args.priority) updateTask.PRIORITY = args.priority;
        if (args.status) updateTask.STATUS = args.status;
        if (args.crmLinks) updateTask.UF_CRM_TASK = args.crmLinks;

        const taskUpdated = await bitrix24Client.updateTask(args.id, updateTask);
        return { success: true, updated: taskUpdated, message: `Task ${args.id} updated successfully` };

      case 'bitrix24_get_current_user':
        const currentUser = await bitrix24Client.getCurrentUser();
        return { success: true, data: currentUser, user: currentUser, message: 'Current Bitrix24 user retrieved' };

      case 'bitrix24_search_users':
        if (!args.query && !args.email) return missingArgumentResponse('query/email');
        const foundUsers = await bitrix24Client.searchUsers({
          query: args.query,
          email: args.email,
          activeOnly: args.activeOnly,
          limit: args.limit,
          start: args.start
        });
        return { success: true, data: foundUsers, users: foundUsers, message: `Found ${foundUsers.length} users` };

      case 'bitrix24_list_my_tasks':
        const myTasksResult = await bitrix24Client.listMyTasks({
          includeCompleted: args.includeCompleted,
          includeDeferred: args.includeDeferred,
          role: args.role,
          limit: args.limit,
          start: args.start,
          orderBy: args.orderBy,
          orderDirection: args.orderDirection
        });
        return {
          success: true,
          data: myTasksResult,
          currentUser: myTasksResult.currentUser,
          tasks: myTasksResult.tasks,
          message: `Found ${myTasksResult.tasks.length} tasks for current user`
        };

      case 'bitrix24_list_tasks_by_user':
        if (!args.userId) return missingArgumentResponse('userId');
        const userTasks = await bitrix24Client.listTasksByUser(String(args.userId), {
          includeCompleted: args.includeCompleted,
          includeDeferred: args.includeDeferred,
          role: args.role,
          limit: args.limit,
          start: args.start,
          orderBy: args.orderBy,
          orderDirection: args.orderDirection
        });
        return { success: true, data: userTasks, tasks: userTasks, message: `Found ${userTasks.length} tasks for user ${args.userId}` };

      case 'bitrix24_get_task_full':
        if (!args.taskId) return missingArgumentResponse('taskId');
        const fullTask = await bitrix24Client.getTaskFull(String(args.taskId), {
          includeChatMessages: args.includeChatMessages,
          includeFiles: args.includeFiles,
          chatLimit: args.chatLimit
        });
        return {
          success: true,
          data: fullTask,
          task: fullTask.task,
          messages: fullTask.messages,
          files: fullTask.files,
          message: `Task ${args.taskId} retrieved`
        };

      case 'bitrix24_get_task_messages':
        if (!args.taskId) return missingArgumentResponse('taskId');
        const taskMessages = await bitrix24Client.getTaskMessages(String(args.taskId), {
          limit: args.limit,
          lastId: args.lastId,
          firstId: args.firstId
        });
        return {
          success: true,
          data: taskMessages,
          task: taskMessages.task,
          messages: taskMessages.messages,
          users: taskMessages.users,
          files: taskMessages.files,
          message: `Messages retrieved for task ${args.taskId}`
        };

      case 'bitrix24_get_task_file_info':
        if (!args.fileId) return missingArgumentResponse('fileId');
        const taskFileInfo = await bitrix24Client.getTaskFileInfo(String(args.fileId));
        return { success: true, data: taskFileInfo, file: taskFileInfo, message: `File ${args.fileId} retrieved` };

      case 'bitrix24_get_my_task_counters':
        const counters = await bitrix24Client.getTaskCounters({
          role: args.role,
          groupId: args.groupId
        });
        return { success: true, data: counters, counters, message: 'Task counters retrieved for current user' };

      case 'bitrix24_get_assistant_guide':
        return {
          success: true,
          guide: buildAssistantGuide()
        };

      case 'bitrix24_create_task_for_current_user':
        if (!args.title) return missingArgumentResponse('title');
        const taskCurrentUser = await bitrix24Client.getCurrentUser();
        const taskCurrentUserId = taskCurrentUser.ID ?? taskCurrentUser.id;

        if (!taskCurrentUserId) {
          return {
            success: false,
            error: 'NO_AUTH_FOUND',
            message: 'Bitrix24 did not return current user ID'
          };
        }

        const currentUserTask: BitrixTask = {
          TITLE: args.title,
          DESCRIPTION: args.description,
          RESPONSIBLE_ID: String(taskCurrentUserId),
          DEADLINE: args.deadline,
          PRIORITY: args.priority || '1',
          STATUS: args.status || '2',
          UF_CRM_TASK: args.crmLinks
        };

        if (args.dryRun === true) {
          return {
            success: true,
            dryRun: true,
            plannedPayload: currentUserTask,
            currentUser: taskCurrentUser,
            summary: summarizeTask(currentUserTask as Record<string, any>),
            message: 'Dry run: task was not created'
          };
        }

        const currentUserTaskId = await bitrix24Client.createTask(currentUserTask);
        const createdCurrentUserTask = await bitrix24Client.getTask(currentUserTaskId, ['*', 'UF_CRM_TASK']);
        return {
          success: true,
          taskId: currentUserTaskId,
          currentUser: taskCurrentUser,
          task: createdCurrentUserTask,
          summary: summarizeTask(createdCurrentUserTask as Record<string, any>),
          message: `Task created for current user with ID: ${currentUserTaskId}`
        };

      case 'bitrix24_update_task_safe':
        if (!args.taskId) return missingArgumentResponse('taskId');
        const safeUpdatePayload = buildTaskUpdatePayload(args);

        if (Object.keys(safeUpdatePayload).length === 0) {
          return {
            success: false,
            error: 'missing update fields',
            message: 'At least one update field is required'
          };
        }

        const safeTaskBefore = await bitrix24Client.getTask(String(args.taskId), ['*', 'UF_CRM_TASK']);

        if (args.dryRun === true) {
          return {
            success: true,
            dryRun: true,
            taskId: String(args.taskId),
            before: summarizeTask(safeTaskBefore as Record<string, any>),
            diff: diffTaskFields(safeTaskBefore as Record<string, any>, safeUpdatePayload),
            plannedPayload: safeUpdatePayload,
            message: 'Dry run: task was not updated'
          };
        }

        const safeTaskUpdated = await bitrix24Client.updateTask(String(args.taskId), safeUpdatePayload);
        const safeTaskAfter = await bitrix24Client.getTask(String(args.taskId), ['*', 'UF_CRM_TASK']);
        return {
          success: true,
          updated: safeTaskUpdated,
          taskId: String(args.taskId),
          task: safeTaskAfter,
          summary: summarizeTask(safeTaskAfter as Record<string, any>),
          diff: diffTaskFields(safeTaskBefore as Record<string, any>, safeUpdatePayload),
          message: `Task ${args.taskId} updated successfully`
        };

      case 'bitrix24_find_my_tasks':
        if (!args.query) return missingArgumentResponse('query');
        const findLimit = Math.min(Math.max(Number(args.limit || 20), 1), 200);
        const findMyTasksResult = await bitrix24Client.listMyTasks({
          includeCompleted: args.includeCompleted,
          includeDeferred: args.includeDeferred,
          role: args.role || 'responsible',
          limit: Math.max(findLimit, 100),
          orderBy: 'DEADLINE',
          orderDirection: 'ASC'
        });
        const normalizedQuery = String(args.query).toLowerCase().trim();
        const matchingTasks = findMyTasksResult.tasks
          .filter((candidate) => {
            const record = candidate as Record<string, any>;
            const haystack = [
              getTaskValue(record, 'TITLE', 'title'),
              getTaskValue(record, 'DESCRIPTION', 'description'),
              getTaskValue(record, 'parsedDescription', 'PARSED_DESCRIPTION')
            ].map(stripHtml).join(' ').toLowerCase();

            return haystack.includes(normalizedQuery);
          })
          .slice(0, findLimit)
          .map((candidate) => summarizeTask(candidate as Record<string, any>));

        return {
          success: true,
          query: args.query,
          currentUser: findMyTasksResult.currentUser,
          matches: matchingTasks,
          count: matchingTasks.length,
          message: `Found ${matchingTasks.length} matching tasks for current user`
        };

      case 'bitrix24_get_my_work_summary':
        const summaryLimit = Math.min(Math.max(Number(args.limit || 20), 1), 200);
        const workTasksResult = await bitrix24Client.listMyTasks({
          includeCompleted: false,
          includeDeferred: false,
          role: 'responsible',
          limit: summaryLimit,
          orderBy: 'DEADLINE',
          orderDirection: 'ASC'
        });
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);
        const nextWeek = new Date(today);
        nextWeek.setDate(nextWeek.getDate() + 7);
        const compactTasks = workTasksResult.tasks.map((candidate) => summarizeTask(candidate as Record<string, any>));
        const taskGroups = {
          overdue: [] as ReturnType<typeof summarizeTask>[],
          dueToday: [] as ReturnType<typeof summarizeTask>[],
          dueThisWeek: [] as ReturnType<typeof summarizeTask>[],
          noDeadline: [] as ReturnType<typeof summarizeTask>[],
          inProgress: [] as ReturnType<typeof summarizeTask>[]
        };

        for (const compactTask of compactTasks) {
          const deadline = compactTask.deadline ? new Date(compactTask.deadline) : null;
          const hasValidDeadline = deadline instanceof Date && !Number.isNaN(deadline.getTime());

          if (compactTask.status === '3') {
            taskGroups.inProgress.push(compactTask);
          }

          if (!hasValidDeadline) {
            taskGroups.noDeadline.push(compactTask);
            continue;
          }

          if (deadline! < today) {
            taskGroups.overdue.push(compactTask);
          } else if (deadline! >= today && deadline! < tomorrow) {
            taskGroups.dueToday.push(compactTask);
          } else if (deadline! >= tomorrow && deadline! <= nextWeek) {
            taskGroups.dueThisWeek.push(compactTask);
          }
        }

        const includeOverdue = args.includeOverdue !== false;
        const includeUpcoming = args.includeUpcoming !== false;
        const includeNoDeadline = args.includeNoDeadline !== false;
        const includedGroups = {
          overdue: includeOverdue ? taskGroups.overdue : [],
          dueToday: includeUpcoming ? taskGroups.dueToday : [],
          dueThisWeek: includeUpcoming ? taskGroups.dueThisWeek : [],
          noDeadline: includeNoDeadline ? taskGroups.noDeadline : [],
          inProgress: taskGroups.inProgress
        };
        const workSummaryText = [
          `Active tasks: ${compactTasks.length}`,
          includeOverdue ? `overdue: ${includedGroups.overdue.length}` : null,
          includeUpcoming ? `due today: ${includedGroups.dueToday.length}` : null,
          includeUpcoming ? `due this week: ${includedGroups.dueThisWeek.length}` : null,
          includeNoDeadline ? `no deadline: ${includedGroups.noDeadline.length}` : null,
          `in progress: ${includedGroups.inProgress.length}`
        ].filter(Boolean).join('; ');

        return {
          success: true,
          currentUser: workTasksResult.currentUser,
          summary: {
            totalActive: compactTasks.length,
            generatedAt: new Date().toISOString(),
            groups: includedGroups
          },
          text: workSummaryText,
          message: 'Current user work summary generated'
        };

      case 'bitrix24_complete_task':
        if (!args.taskId) return missingArgumentResponse('taskId');
        const completePayload: Partial<BitrixTask> = { STATUS: '4' };
        const completeTaskBefore = await bitrix24Client.getTask(String(args.taskId), ['*', 'UF_CRM_TASK']);

        if (args.dryRun === true) {
          return {
            success: true,
            dryRun: true,
            taskId: String(args.taskId),
            before: summarizeTask(completeTaskBefore as Record<string, any>),
            diff: diffTaskFields(completeTaskBefore as Record<string, any>, completePayload),
            plannedPayload: completePayload,
            message: 'Dry run: task was not completed'
          };
        }

        const completeUpdated = await bitrix24Client.updateTask(String(args.taskId), completePayload);
        const completeTaskAfter = await bitrix24Client.getTask(String(args.taskId), ['*', 'UF_CRM_TASK']);
        return {
          success: true,
          updated: completeUpdated,
          taskId: String(args.taskId),
          task: completeTaskAfter,
          summary: summarizeTask(completeTaskAfter as Record<string, any>),
          diff: diffTaskFields(completeTaskBefore as Record<string, any>, completePayload),
          message: `Task ${args.taskId} marked as completed`
        };

      case 'bitrix24_add_task_comment':
        if (!args.taskId) return missingArgumentResponse('taskId');
        if (!args.message) return missingArgumentResponse('message');

        if (args.dryRun === true) {
          return {
            success: true,
            dryRun: true,
            taskId: String(args.taskId),
            plannedPayload: {
              TASKID: String(args.taskId),
              fields: {
                POST_MESSAGE: args.message
              }
            },
            message: 'Dry run: comment was not added'
          };
        }

        try {
          const addedComment = await bitrix24Client.addTaskComment(String(args.taskId), String(args.message));
          return {
            success: true,
            taskId: String(args.taskId),
            comment: addedComment,
            message: `Comment added to task ${args.taskId}`
          };
        } catch (commentError) {
          const formatted = formatToolError(commentError);
          return {
            ...formatted,
            message: `${formatted.message}. Task comment creation through task.commentitem.add is not available or not permitted for this Bitrix24 portal/webhook.`
          };
        }

      case 'bitrix24_register_ai_engine':
        const aiEngineId = await bitrix24Client.registerAiEngine({
          name: args.name,
          code: args.code,
          category: args.category as BitrixAiEngineCategory,
          completionsUrl: args.completionsUrl,
          settings: args.settings
        });
        return {
          success: true,
          engineId: aiEngineId,
          message: `AI engine registered with ID: ${aiEngineId}`
        };

      case 'bitrix24_list_ai_engines':
        const aiEngines = await bitrix24Client.listAiEngines({
          filter: args.filter,
          limit: args.limit
        });
        return { success: true, engines: aiEngines };

      case 'bitrix24_unregister_ai_engine':
        const aiEngineRemoved = await bitrix24Client.unregisterAiEngine(args.code);
        return {
          success: true,
          removed: aiEngineRemoved,
          message: `AI engine ${args.code} unregistered successfully`
        };

      case 'bitrix24_get_chat_id':
        const chatIdResult = await bitrix24Client.getChatId(args.entityType, args.entityId);
        return {
          success: true,
          chat: chatIdResult,
          message: `Chat lookup completed for ${args.entityType}:${args.entityId}`
        };

      case 'bitrix24_get_dialog':
        const dialog = await bitrix24Client.getDialog(args.dialogId);
        return {
          success: true,
          dialog,
          message: `Dialog ${args.dialogId} retrieved`
        };

      case 'bitrix24_list_recent_dialogs':
        const recentDialogs = await bitrix24Client.listRecentDialogs({
          limit: args.limit,
          offset: args.offset,
          lastMessageDate: args.lastMessageDate,
          unreadOnly: args.unreadOnly,
          parseText: args.parseText,
          getOriginalText: args.getOriginalText,
          skipOpenLines: args.skipOpenLines,
          skipDialog: args.skipDialog,
          skipChat: args.skipChat,
          onlyCopilot: args.onlyCopilot,
          onlyChannel: args.onlyChannel
        });
        return {
          success: true,
          dialogs: recentDialogs,
          message: `Recent dialogs retrieved`
        };

      case 'bitrix24_get_dialog_messages':
        const dialogMessages = await bitrix24Client.getDialogMessages(args.dialogId, {
          limit: args.limit,
          lastId: args.lastId,
          firstId: args.firstId
        });
        return {
          success: true,
          messages: dialogMessages,
          message: `Messages retrieved from dialog ${args.dialogId}`
        };

      case 'bitrix24_search_dialog_messages':
        const foundDialogMessages = await bitrix24Client.searchDialogMessages(args.chatId, args.searchMessage, {
          limit: args.limit,
          lastId: args.lastId,
          dateFrom: args.dateFrom,
          dateTo: args.dateTo,
          date: args.date,
          orderDirection: args.orderDirection
        });
        return {
          success: true,
          messages: foundDialogMessages,
          message: `Message search completed in chat ${args.chatId}`
        };

      case 'bitrix24_search_crm':
        const searchResults = await bitrix24Client.searchCRM(args.query, args.entityTypes);
        return { success: true, results: searchResults };

      case 'bitrix24_validate_webhook':
        const isValid = await bitrix24Client.validateWebhook();
        return { success: true, valid: isValid, message: isValid ? 'Webhook is valid' : 'Webhook validation failed' };

      case 'bitrix24_diagnose_permissions':
        const permissionResults = await bitrix24Client.diagnosePermissions();
        return { success: true, diagnosis: permissionResults };

      case 'bitrix24_check_crm_settings':
        const crmSettings = await bitrix24Client.checkCRMSettings();
        return { success: true, settings: crmSettings };

      case 'bitrix24_test_leads_api':
        const leadsTest = await bitrix24Client.testLeadsAPI();
        return { success: true, tests: leadsTest };

      // Phase 1: Enhanced Deal Filtering Tools
      case 'bitrix24_get_deal_pipelines':
        const pipelines = await bitrix24Client.getDealPipelines();
        return { success: true, pipelines, message: `Found ${pipelines.length} deal pipelines` };

      case 'bitrix24_get_deal_stages':
        const stages = await bitrix24Client.getDealStages(args.pipelineId);
        return { success: true, stages, message: `Found ${stages.length} deal stages` };

      case 'bitrix24_filter_deals_by_pipeline':
        const pipelineDeals = await bitrix24Client.filterDealsByPipeline(args.pipelineId, {
          limit: args.limit,
          orderBy: args.orderBy,
          orderDirection: args.orderDirection
        });
        return { 
          success: true, 
          deals: pipelineDeals, 
          count: pipelineDeals.length,
          message: `Found ${pipelineDeals.length} deals in pipeline ${args.pipelineId}` 
        };

      case 'bitrix24_filter_deals_by_budget':
        const budgetDeals = await bitrix24Client.filterDealsByBudget(
          args.minBudget, 
          args.maxBudget, 
          args.currency || 'EUR',
          {
            limit: args.limit,
            orderBy: args.orderBy,
            orderDirection: args.orderDirection
          }
        );
        const budgetMessage = args.maxBudget 
          ? `Found ${budgetDeals.length} deals with budget between ${args.minBudget} and ${args.maxBudget} ${args.currency || 'EUR'}`
          : `Found ${budgetDeals.length} deals with budget ≥ ${args.minBudget} ${args.currency || 'EUR'}`;
        return { 
          success: true, 
          deals: budgetDeals, 
          count: budgetDeals.length,
          message: budgetMessage
        };

      case 'bitrix24_filter_deals_by_status':
        const statusDeals = await bitrix24Client.filterDealsByStatus(
          args.stageIds, 
          args.pipelineId,
          {
            limit: args.limit,
            orderBy: args.orderBy,
            orderDirection: args.orderDirection
          }
        );
        const statusMessage = args.pipelineId
          ? `Found ${statusDeals.length} deals with stages [${args.stageIds.join(', ')}] in pipeline ${args.pipelineId}`
          : `Found ${statusDeals.length} deals with stages [${args.stageIds.join(', ')}]`;
        return { 
          success: true, 
          deals: statusDeals, 
          count: statusDeals.length,
          message: statusMessage
        };

      // Sales Team Monitoring Tools
      case 'bitrix24_monitor_user_activities':
        const userActivities = await bitrix24Client.monitorUserActivities(
          args.userId,
          args.startDate,
          args.endDate,
          {
            includeCallVolume: args.includeCallVolume,
            includeEmailActivity: args.includeEmailActivity,
            includeTimelineActivity: args.includeTimelineActivity,
            includeResponseTimes: args.includeResponseTimes
          }
        );
        return { 
          success: true, 
          activities: userActivities,
          message: `User activity monitoring completed for period ${args.startDate} to ${args.endDate || 'today'}`
        };

      case 'bitrix24_get_user_performance_summary':
        const performanceSummary = await bitrix24Client.getUserPerformanceSummary(
          args.userId,
          args.startDate,
          args.endDate,
          {
            includeDealMetrics: args.includeDealMetrics,
            includeActivityRatios: args.includeActivityRatios,
            includeConversionRates: args.includeConversionRates
          }
        );
        return { 
          success: true, 
          performance: performanceSummary,
          message: `Performance summary generated for period ${args.startDate} to ${args.endDate || 'today'}`
        };

      case 'bitrix24_analyze_account_performance':
        const accountPerformance = await bitrix24Client.analyzeAccountPerformance(
          args.accountId,
          args.accountType,
          args.startDate,
          args.endDate,
          {
            includeAllInteractions: args.includeAllInteractions,
            includeDealProgression: args.includeDealProgression,
            includeTimelineHistory: args.includeTimelineHistory
          }
        );
        return { 
          success: true, 
          accountAnalysis: accountPerformance,
          message: `Account performance analysis completed for ${args.accountType} ${args.accountId}`
        };

      case 'bitrix24_compare_user_performance':
        const userComparison = await bitrix24Client.compareUserPerformance(
          args.userIds,
          args.startDate,
          args.endDate,
          {
            metrics: args.metrics,
            includeRankings: args.includeRankings,
            includeTrends: args.includeTrends
          }
        );
        return { 
          success: true, 
          comparison: userComparison,
          message: `User performance comparison completed for ${args.userIds?.length || 'all'} users`
        };

      case 'bitrix24_track_deal_progression':
        const dealProgression = await bitrix24Client.trackDealProgression(
          args.dealId,
          args.userId,
          args.pipelineId,
          args.startDate,
          args.endDate,
          {
            includeStageDuration: args.includeStageDuration,
            identifyStalled: args.identifyStalled,
            calculateVelocity: args.calculateVelocity
          }
        );
        return { 
          success: true, 
          progression: dealProgression,
          message: `Deal progression tracking completed for period ${args.startDate} to ${args.endDate || 'today'}`
        };

      case 'bitrix24_monitor_sales_activities':
        const salesActivities = await bitrix24Client.monitorSalesActivities(
          args.userId,
          args.startDate,
          args.endDate,
          {
            includeTaskCompletion: args.includeTaskCompletion,
            includeFollowUpTracking: args.includeFollowUpTracking,
            includeMeetingTracking: args.includeMeetingTracking,
            includeQuoteActivity: args.includeQuoteActivity
          }
        );
        return { 
          success: true, 
          salesActivities: salesActivities,
          message: `Sales activities monitoring completed for period ${args.startDate} to ${args.endDate || 'today'}`
        };

      case 'bitrix24_generate_sales_report':
        const salesReport = await bitrix24Client.generateSalesReport(
          args.reportType,
          args.startDate,
          args.endDate,
          {
            userIds: args.userIds,
            includeMetrics: args.includeMetrics,
            includeTrendAnalysis: args.includeTrendAnalysis,
            includeComparisons: args.includeComparisons
          }
        );
        return { 
          success: true, 
          report: salesReport,
          message: `${args.reportType} report generated for period ${args.startDate} to ${args.endDate || 'today'}`
        };

      case 'bitrix24_get_team_dashboard':
        const teamDashboard = await bitrix24Client.getTeamDashboard({
          includeRealTimeMetrics: args.includeRealTimeMetrics,
          includeTopPerformers: args.includeTopPerformers,
          includeAttentionNeeded: args.includeAttentionNeeded,
          includeWorkloadDistribution: args.includeWorkloadDistribution,
          timeframe: args.timeframe
        });
        return { 
          success: true, 
          dashboard: teamDashboard,
          message: `Team dashboard generated for timeframe: ${args.timeframe || 'today'}`
        };

      case 'bitrix24_analyze_customer_engagement':
        const customerEngagement = await bitrix24Client.analyzeCustomerEngagement(
          args.accountId,
          args.accountType,
          args.userId,
          args.startDate,
          args.endDate,
          {
            includeCommunicationPatterns: args.includeCommunicationPatterns,
            includeResponseQuality: args.includeResponseQuality,
            includeEngagementScores: args.includeEngagementScores,
            includeRelationshipHealth: args.includeRelationshipHealth
          }
        );
        return { 
          success: true, 
          engagement: customerEngagement,
          message: `Customer engagement analysis completed for period ${args.startDate} to ${args.endDate || 'today'}`
        };

      case 'bitrix24_forecast_performance':
        const performanceForecast = await bitrix24Client.forecastPerformance(
          args.forecastType,
          args.userId,
          {
            historicalPeriod: args.historicalPeriod,
            forecastPeriod: args.forecastPeriod,
            includePipelineAnalysis: args.includePipelineAnalysis,
            includeRiskAssessment: args.includeRiskAssessment,
            includeGoalTracking: args.includeGoalTracking
          }
        );
        return { 
          success: true, 
          forecast: performanceForecast,
          message: `${args.forecastType} forecast generated using ${args.historicalPeriod || '6_months'} of historical data`
        };

      // User Management Tools
      case 'bitrix24_get_user':
        const userData = await bitrix24Client.getUser(args.userId);
        return { success: true, user: userData };

      case 'bitrix24_get_all_users':
        const allUsers = await bitrix24Client.getAllUsers();
        const filteredUsers = args.includeInactive
          ? allUsers
          : allUsers.filter((user: Record<string, any>) => user.ACTIVE === true || user.ACTIVE === 'Y');
        return { success: true, users: filteredUsers, message: `Found ${filteredUsers.length} users` };

      case 'bitrix24_get_departments':
        const departments = await bitrix24Client.getAllDepartments();
        return { success: true, departments, message: `Found ${departments.length} departments` };

      case 'bitrix24_export_org_structure':
        const orgDepartments = await bitrix24Client.getAllDepartments();
        const orgUsersRaw = await bitrix24Client.getAllUsers();
        const orgUsers = args.includeInactiveUsers
          ? orgUsersRaw
          : orgUsersRaw.filter((user: Record<string, any>) => user.ACTIVE === true || user.ACTIVE === 'Y');
        const orgStructure = buildOrgStructure(orgDepartments, orgUsers);
        return {
          success: true,
          orgStructure,
          message: `Exported ${orgStructure.summary.departments} departments, ${orgStructure.summary.users} users, and ${orgStructure.summary.reportingLines} reporting lines`
        };

      case 'bitrix24_resolve_user_names':
        const userNames = await bitrix24Client.resolveUserNames(args.userIds);
        return { success: true, userNames, message: `Resolved ${Object.keys(userNames).length} user names` };

      case 'bitrix24_get_contacts_with_user_names':
        const contactsRaw = await bitrix24Client.listContacts({
          start: 0,
          filter: args.filter
        });
        const contactsWithNames = await bitrix24Client.enhanceWithUserNames(contactsRaw.slice(0, args.limit || 20));
        return { success: true, contacts: contactsWithNames, message: `Retrieved ${contactsWithNames.length} contacts with user names resolved` };

      case 'bitrix24_get_deals_with_user_names':
        const dealOrderWithNames: Record<string, string> = {};
        dealOrderWithNames[args.orderBy || 'DATE_CREATE'] = args.orderDirection || 'DESC';
        
        const dealsRaw = await bitrix24Client.listDeals({
          start: 0,
          filter: args.filter,
          order: dealOrderWithNames,
          select: ['*']
        });
        const dealsWithNames = await bitrix24Client.enhanceWithUserNames(dealsRaw.slice(0, args.limit || 20));
        return { success: true, deals: dealsWithNames, message: `Retrieved ${dealsWithNames.length} deals with user names resolved` };

      case 'bitrix24_get_leads_with_user_names':
        const leadOrderWithNames: Record<string, string> = {};
        leadOrderWithNames[args.orderBy || 'DATE_CREATE'] = args.orderDirection || 'DESC';
        
        const leadsRaw = await bitrix24Client.listLeads({
          start: 0,
          filter: args.filter,
          order: leadOrderWithNames,
          select: ['*']
        });
        const leadsWithNames = await bitrix24Client.enhanceWithUserNames(leadsRaw.slice(0, args.limit || 20));
        return { success: true, leads: leadsWithNames, message: `Retrieved ${leadsWithNames.length} leads with user names resolved` };

      case 'bitrix24_get_companies_with_user_names':
        const companyOrderWithNames: Record<string, string> = {};
        companyOrderWithNames[args.orderBy || 'DATE_CREATE'] = args.orderDirection || 'DESC';
        
        const companiesRaw = await bitrix24Client.listCompanies({
          start: 0,
          filter: args.filter,
          order: companyOrderWithNames,
          select: ['*']
        });
        const companiesWithNames = await bitrix24Client.enhanceWithUserNames(companiesRaw.slice(0, args.limit || 20));
        return { success: true, companies: companiesWithNames, message: `Retrieved ${companiesWithNames.length} companies with user names resolved` };

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    console.error(`Tool execution error [${name}]:`, error);
    return formatToolError(error);
  }
}
