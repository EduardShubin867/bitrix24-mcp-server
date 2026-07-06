import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { executeToolCall } from '../build/tools/index.js';

function csvCell(value) {
  if (value === undefined || value === null) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(rows, columns) {
  return [
    columns.map(column => csvCell(column.header)).join(','),
    ...rows.map(row => columns.map(column => csvCell(row[column.key])).join(','))
  ].join('\n');
}

function flattenDepartments(departments) {
  return departments.map(department => ({
    id: department.id,
    name: department.name,
    parentId: department.parentId,
    headId: department.headId,
    headName: department.head?.fullName || '',
    usersCount: department.users.length,
    childrenCount: department.children.length
  }));
}

function flattenUsers(departments) {
  const rows = [];
  const seen = new Set();

  for (const department of departments) {
    for (const user of department.users) {
      const key = `${department.id}:${user.id}`;
      if (seen.has(key)) continue;
      seen.add(key);

      rows.push({
        id: user.id,
        fullName: user.fullName,
        email: user.email || '',
        workPosition: user.workPosition || '',
        active: user.active,
        departmentId: department.id,
        departmentName: department.name
      });
    }
  }

  return rows;
}

function simplifyNode(node) {
  return {
    id: node.id,
    name: node.name,
    parentId: node.parentId,
    headId: node.headId,
    head: node.head,
    users: node.users,
    children: node.children.map(simplifyNode)
  };
}

function collectStats(orgStructure) {
  const departmentsWithHead = orgStructure.departments.filter(department => department.head).length;
  const departmentsWithoutHead = orgStructure.departments.length - departmentsWithHead;
  const inactiveUsers = flattenUsers(orgStructure.departments).filter(user => user.active === false).length;

  return {
    ...orgStructure.summary,
    departmentsWithHead,
    departmentsWithoutHead,
    inactiveUsers,
    roots: orgStructure.roots.length
  };
}

function htmlEscape(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function scriptJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function createHtml({ generatedAt, stats, tree, reportingLines, files }) {
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Оргструктура Bitrix24</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8f5;
      --panel: #ffffff;
      --ink: #18201d;
      --muted: #6c746f;
      --line: #d8ddd3;
      --accent: #126c63;
      --accent-2: #b5522d;
      --accent-3: #355f93;
      --soft: #e8f1ee;
      --warn: #fff0d8;
      --shadow: 0 18px 55px rgba(24, 32, 29, 0.12);
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }

    button,
    input,
    select {
      font: inherit;
    }

    .app {
      display: grid;
      grid-template-columns: 340px minmax(0, 1fr);
      min-height: 100vh;
    }

    aside {
      position: sticky;
      top: 0;
      height: 100vh;
      padding: 22px;
      background: #20332f;
      color: #f6faf7;
      overflow: auto;
    }

    main {
      min-width: 0;
      padding: 22px;
    }

    h1 {
      margin: 0 0 10px;
      font-size: 28px;
      line-height: 1.08;
      font-weight: 760;
    }

    .meta {
      margin: 0 0 22px;
      color: #c7d5cf;
      font-size: 13px;
      line-height: 1.45;
    }

    .controls {
      display: grid;
      gap: 10px;
    }

    .search {
      width: 100%;
      height: 42px;
      border: 1px solid rgba(255, 255, 255, 0.18);
      border-radius: 8px;
      padding: 0 12px;
      color: #f6faf7;
      background: rgba(255, 255, 255, 0.08);
      outline: none;
    }

    .search::placeholder { color: #b9c8c2; }

    .toggle {
      display: flex;
      align-items: center;
      gap: 10px;
      min-height: 34px;
      color: #e9f0ed;
      font-size: 14px;
      cursor: pointer;
      user-select: none;
    }

    .toggle input {
      width: 18px;
      height: 18px;
      accent-color: #7bd3c2;
    }

    .actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin-top: 8px;
    }

    .action {
      height: 36px;
      border: 1px solid rgba(255, 255, 255, 0.2);
      border-radius: 8px;
      color: #f6faf7;
      background: rgba(255, 255, 255, 0.08);
      cursor: pointer;
    }

    .action:hover { background: rgba(255, 255, 255, 0.14); }

    .downloads {
      display: grid;
      gap: 6px;
      margin-top: 18px;
      padding-top: 18px;
      border-top: 1px solid rgba(255, 255, 255, 0.14);
    }

    .downloads a {
      color: #dcefe9;
      text-decoration: none;
      font-size: 13px;
    }

    .downloads a:hover { color: #ffffff; }

    .stats {
      display: grid;
      grid-template-columns: repeat(6, minmax(130px, 1fr));
      gap: 10px;
      margin-bottom: 16px;
    }

    .stat {
      min-height: 86px;
      padding: 14px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      box-shadow: 0 8px 26px rgba(24, 32, 29, 0.06);
    }

    .stat strong {
      display: block;
      font-size: 25px;
      line-height: 1;
      margin-bottom: 8px;
    }

    .stat span {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.25;
    }

    .content {
      display: grid;
      grid-template-columns: minmax(0, 1.35fr) minmax(420px, 0.9fr);
      gap: 16px;
      align-items: start;
    }

    .panel {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      box-shadow: var(--shadow);
      overflow: hidden;
    }

    .panel-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      min-height: 54px;
      padding: 14px 16px;
      border-bottom: 1px solid var(--line);
      background: #fbfcfa;
    }

    .panel-head h2 {
      margin: 0;
      font-size: 16px;
      line-height: 1.2;
    }

    .counter {
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
    }

    .tree {
      padding: 10px 12px 18px;
      max-height: calc(100vh - 160px);
      overflow: auto;
    }

    details {
      border-left: 1px solid var(--line);
      margin-left: 10px;
      padding-left: 12px;
    }

    details.root {
      margin-left: 0;
      border-left: 0;
      padding-left: 0;
    }

    summary {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 12px;
      align-items: center;
      min-height: 40px;
      padding: 6px 6px;
      border-radius: 8px;
      cursor: pointer;
      list-style: none;
    }

    summary::-webkit-details-marker { display: none; }
    summary:hover { background: #f0f5f2; }

    .dept-title {
      display: flex;
      align-items: center;
      min-width: 0;
      gap: 8px;
      font-size: 14px;
      font-weight: 680;
    }

    .caret {
      display: inline-grid;
      place-items: center;
      width: 18px;
      height: 18px;
      border-radius: 6px;
      color: var(--accent);
      background: var(--soft);
      flex: 0 0 auto;
    }

    details[open] > summary .caret { transform: rotate(90deg); }

    .dept-name {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .dept-meta {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    .tag {
      display: inline-flex;
      align-items: center;
      height: 22px;
      padding: 0 7px;
      border-radius: 7px;
      background: #edf2ee;
      color: #49514d;
      font-size: 11px;
      white-space: nowrap;
    }

    .tag.head { color: #0d5d55; background: #dff1ed; }
    .tag.empty { color: #7c4c1b; background: var(--warn); }

    .users {
      display: grid;
      gap: 5px;
      margin: 2px 0 8px 30px;
    }

    .user {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: center;
      min-height: 30px;
      padding: 5px 8px;
      border-radius: 7px;
      background: #f7faf8;
      color: #29322e;
      font-size: 12px;
    }

    .user-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .role {
      color: var(--muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 210px;
    }

    .table-wrap {
      max-height: calc(100vh - 160px);
      overflow: auto;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }

    th,
    td {
      padding: 9px 10px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
    }

    th {
      position: sticky;
      top: 0;
      z-index: 1;
      color: #40504a;
      background: #fbfcfa;
      font-size: 11px;
      text-transform: uppercase;
    }

    td {
      color: #27302c;
      line-height: 1.35;
    }

    .muted { color: var(--muted); }

    .hidden { display: none !important; }

    @media (max-width: 1180px) {
      .app { grid-template-columns: 300px minmax(0, 1fr); }
      .stats { grid-template-columns: repeat(3, minmax(130px, 1fr)); }
      .content { grid-template-columns: 1fr; }
      .tree,
      .table-wrap { max-height: none; }
    }

    @media (max-width: 760px) {
      .app { display: block; }
      aside {
        position: relative;
        height: auto;
      }
      main { padding: 14px; }
      .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .content { gap: 12px; }
      .panel-head { align-items: flex-start; flex-direction: column; }
      summary { grid-template-columns: 1fr; }
      .dept-meta { justify-content: flex-start; margin-left: 26px; }
      .users { margin-left: 12px; }
      .role { max-width: 130px; }
    }
  </style>
</head>
<body>
  <div class="app">
    <aside>
      <h1>Оргструктура Bitrix24</h1>
      <p class="meta">Выгрузка: ${htmlEscape(generatedAt)}<br>Источник: Bitrix24 REST department.get + user.get.</p>
      <div class="controls">
        <input id="search" class="search" type="search" placeholder="Поиск отдела, сотрудника, руководителя">
        <label class="toggle"><input id="showUsers" type="checkbox" checked> Показывать сотрудников</label>
        <label class="toggle"><input id="activeOnly" type="checkbox"> Только активные сотрудники</label>
        <label class="toggle"><input id="headsOnly" type="checkbox"> Только отделы с руководителем</label>
        <div class="actions">
          <button id="expandAll" class="action" type="button">Раскрыть</button>
          <button id="collapseAll" class="action" type="button">Свернуть</button>
        </div>
      </div>
      <div class="downloads">
        <a href="${htmlEscape(files.json)}">Полный JSON</a>
        <a href="${htmlEscape(files.departmentsCsv)}">Departments CSV</a>
        <a href="${htmlEscape(files.usersCsv)}">Users CSV</a>
        <a href="${htmlEscape(files.reportingCsv)}">Reporting lines CSV</a>
      </div>
    </aside>

    <main>
      <section class="stats" aria-label="Сводка">
        <div class="stat"><strong>${stats.departments}</strong><span>подразделений</span></div>
        <div class="stat"><strong>${stats.users}</strong><span>пользователей в выгрузке</span></div>
        <div class="stat"><strong>${stats.reportingLines}</strong><span>связей руководитель-сотрудник</span></div>
        <div class="stat"><strong>${stats.departmentsWithHead}</strong><span>отделов с руководителем</span></div>
        <div class="stat"><strong>${stats.departmentsWithoutHead}</strong><span>отделов без руководителя</span></div>
        <div class="stat"><strong>${stats.inactiveUsers}</strong><span>неактивных сотрудников</span></div>
      </section>

      <section class="content">
        <div class="panel">
          <div class="panel-head">
            <h2>Дерево подразделений</h2>
            <span id="treeCounter" class="counter"></span>
          </div>
          <div id="tree" class="tree"></div>
        </div>

        <div class="panel">
          <div class="panel-head">
            <h2>Кто над кем</h2>
            <span id="linesCounter" class="counter"></span>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Руководитель</th>
                  <th>Подчиненный</th>
                  <th>Отдел</th>
                  <th>Тип</th>
                </tr>
              </thead>
              <tbody id="lines"></tbody>
            </table>
          </div>
        </div>
      </section>
    </main>
  </div>

  <script id="org-data" type="application/json">${scriptJson({ tree, reportingLines })}</script>
  <script>
    const data = JSON.parse(document.getElementById('org-data').textContent);
    const treeEl = document.getElementById('tree');
    const linesEl = document.getElementById('lines');
    const searchEl = document.getElementById('search');
    const showUsersEl = document.getElementById('showUsers');
    const activeOnlyEl = document.getElementById('activeOnly');
    const headsOnlyEl = document.getElementById('headsOnly');
    const treeCounterEl = document.getElementById('treeCounter');
    const linesCounterEl = document.getElementById('linesCounter');

    function textMatch(value, query) {
      return String(value || '').toLowerCase().includes(query);
    }

    function nodeMatches(node, query, activeOnly, headsOnly) {
      if (headsOnly && !node.head) return false;

      const ownUsers = node.users.filter(user => !activeOnly || user.active !== false);
      const directMatch =
        !query ||
        textMatch(node.name, query) ||
        textMatch(node.head?.fullName, query) ||
        ownUsers.some(user =>
          textMatch(user.fullName, query) ||
          textMatch(user.email, query) ||
          textMatch(user.workPosition, query)
        );

      const childMatches = node.children.some(child => nodeMatches(child, query, activeOnly, headsOnly));
      return directMatch || childMatches;
    }

    function renderNode(node, level, state) {
      if (!nodeMatches(node, state.query, state.activeOnly, state.headsOnly)) {
        return null;
      }

      state.visibleDepartments += 1;
      const ownUsers = node.users.filter(user => !state.activeOnly || user.active !== false);
      const visibleUsers = state.showUsers
        ? ownUsers.filter(user =>
            !state.query ||
            textMatch(user.fullName, state.query) ||
            textMatch(user.email, state.query) ||
            textMatch(user.workPosition, state.query) ||
            textMatch(node.name, state.query) ||
            textMatch(node.head?.fullName, state.query)
          )
        : [];

      const details = document.createElement('details');
      details.className = level === 0 ? 'root' : '';
      details.open = state.query || level < 2;

      const summary = document.createElement('summary');
      const title = document.createElement('div');
      title.className = 'dept-title';
      title.innerHTML = '<span class="caret">›</span><span class="dept-name"></span>';
      title.querySelector('.dept-name').textContent = node.name;

      const meta = document.createElement('div');
      meta.className = 'dept-meta';
      meta.innerHTML = [
        node.head ? '<span class="tag head"></span>' : '<span class="tag empty">нет руководителя</span>',
        '<span class="tag"></span>',
        '<span class="tag"></span>'
      ].join('');
      if (node.head) meta.children[0].textContent = node.head.fullName;
      meta.children[node.head ? 1 : 1].textContent = ownUsers.length + ' чел.';
      meta.children[node.head ? 2 : 2].textContent = node.children.length + ' подотд.';

      summary.append(title, meta);
      details.append(summary);

      if (state.showUsers && visibleUsers.length) {
        const users = document.createElement('div');
        users.className = 'users';
        for (const user of visibleUsers) {
          state.visibleUsers += 1;
          const row = document.createElement('div');
          row.className = 'user';
          row.innerHTML = '<span class="user-name"></span><span class="role"></span>';
          row.querySelector('.user-name').textContent = user.fullName + (user.active === false ? ' · неактивен' : '');
          row.querySelector('.role').textContent = user.workPosition || user.email || '';
          users.append(row);
        }
        details.append(users);
      }

      for (const child of node.children) {
        const childEl = renderNode(child, level + 1, state);
        if (childEl) details.append(childEl);
      }

      return details;
    }

    function renderLines(state) {
      const filtered = data.reportingLines.filter(line => {
        if (!state.query) return true;
        return textMatch(line.managerName, state.query) ||
          textMatch(line.subordinateName, state.query) ||
          textMatch(line.departmentName, state.query) ||
          textMatch(line.relation, state.query);
      });

      linesCounterEl.textContent = filtered.length + ' строк';
      linesEl.textContent = '';

      for (const line of filtered.slice(0, 1200)) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td></td><td></td><td></td><td class="muted"></td>';
        tr.children[0].textContent = line.managerName;
        tr.children[1].textContent = line.subordinateName;
        tr.children[2].textContent = line.departmentName;
        tr.children[3].textContent = line.relation;
        linesEl.append(tr);
      }
    }

    function render() {
      const state = {
        query: searchEl.value.trim().toLowerCase(),
        showUsers: showUsersEl.checked,
        activeOnly: activeOnlyEl.checked,
        headsOnly: headsOnlyEl.checked,
        visibleDepartments: 0,
        visibleUsers: 0
      };

      treeEl.textContent = '';
      for (const root of data.tree) {
        const el = renderNode(root, 0, state);
        if (el) treeEl.append(el);
      }

      treeCounterEl.textContent = state.visibleDepartments + ' отделов' +
        (state.showUsers ? ' · ' + state.visibleUsers + ' сотрудников' : '');
      renderLines(state);
    }

    document.getElementById('expandAll').addEventListener('click', () => {
      treeEl.querySelectorAll('details').forEach(details => details.open = true);
    });

    document.getElementById('collapseAll').addEventListener('click', () => {
      treeEl.querySelectorAll('details').forEach((details, index) => details.open = index < 3);
    });

    [searchEl, showUsersEl, activeOnlyEl, headsOnlyEl].forEach(control => {
      control.addEventListener('input', render);
      control.addEventListener('change', render);
    });

    render();
  </script>
</body>
</html>
`;
}

const startedAt = new Date();
const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
const outDir = resolve(process.cwd(), 'exports', `org-structure-${stamp}`);
mkdirSync(outDir, { recursive: true });

const result = await executeToolCall('bitrix24_export_org_structure', {
  includeInactiveUsers: true
});

if (!result.success) {
  throw new Error(result.error || 'Org structure export failed');
}

const orgStructure = result.orgStructure;
const stats = collectStats(orgStructure);
const departments = flattenDepartments(orgStructure.departments);
const users = flattenUsers(orgStructure.departments);
const tree = orgStructure.roots.map(simplifyNode);

const fullJsonFile = 'org-structure-full.json';
const departmentsCsvFile = 'departments.csv';
const usersCsvFile = 'users.csv';
const reportingCsvFile = 'reporting-lines.csv';
const htmlFile = 'org-structure-visualization.html';

writeFileSync(resolve(outDir, fullJsonFile), JSON.stringify(orgStructure, null, 2));
writeFileSync(
  resolve(outDir, departmentsCsvFile),
  toCsv(departments, [
    { key: 'id', header: 'Department ID' },
    { key: 'name', header: 'Department Name' },
    { key: 'parentId', header: 'Parent Department ID' },
    { key: 'headId', header: 'Head User ID' },
    { key: 'headName', header: 'Head Name' },
    { key: 'usersCount', header: 'Users Count' },
    { key: 'childrenCount', header: 'Children Count' }
  ])
);
writeFileSync(
  resolve(outDir, usersCsvFile),
  toCsv(users, [
    { key: 'id', header: 'User ID' },
    { key: 'fullName', header: 'Full Name' },
    { key: 'email', header: 'Email' },
    { key: 'workPosition', header: 'Work Position' },
    { key: 'active', header: 'Active' },
    { key: 'departmentId', header: 'Department ID' },
    { key: 'departmentName', header: 'Department Name' }
  ])
);
writeFileSync(
  resolve(outDir, reportingCsvFile),
  toCsv(orgStructure.reportingLines, [
    { key: 'managerId', header: 'Manager ID' },
    { key: 'managerName', header: 'Manager Name' },
    { key: 'subordinateId', header: 'Subordinate ID' },
    { key: 'subordinateName', header: 'Subordinate Name' },
    { key: 'departmentId', header: 'Department ID' },
    { key: 'departmentName', header: 'Department Name' },
    { key: 'relation', header: 'Relation' }
  ])
);
writeFileSync(
  resolve(outDir, htmlFile),
  createHtml({
    generatedAt: orgStructure.generatedAt,
    stats,
    tree,
    reportingLines: orgStructure.reportingLines,
    files: {
      json: fullJsonFile,
      departmentsCsv: departmentsCsvFile,
      usersCsv: usersCsvFile,
      reportingCsv: reportingCsvFile
    }
  })
);

console.log(JSON.stringify({
  outDir,
  files: {
    fullJson: resolve(outDir, fullJsonFile),
    departmentsCsv: resolve(outDir, departmentsCsvFile),
    usersCsv: resolve(outDir, usersCsvFile),
    reportingCsv: resolve(outDir, reportingCsvFile),
    visualizationHtml: resolve(outDir, htmlFile)
  },
  summary: stats
}, null, 2));
